package com.jesr.network

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.NetworkInfo
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pManager
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest
import android.os.Build
import android.os.Looper
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

internal class WifiDirectMeshTransport(
  private val context: Context,
  private val localId: String,
  private val onCandidate: (String) -> Unit,
  private val onLink: (String) -> Unit,
  private val onLost: (String) -> Unit,
  private val onPacket: (String, String) -> Unit,
  private val onLog: (String, String) -> Unit
) {
  private val manager = context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
  private var channel: WifiP2pManager.Channel? = null
  private var receiverRegistered = false
  @Volatile private var active = false
  private var receiver: BroadcastReceiver? = null
  private var serviceRequest: WifiP2pDnsSdServiceRequest? = null
  private val devicesById = ConcurrentHashMap<String, WifiP2pDevice>()
  private val socketsById = ConcurrentHashMap<String, Socket>()
  private val inputById = ConcurrentHashMap<String, DataInputStream>()
  private val outputById = ConcurrentHashMap<String, DataOutputStream>()
  @Volatile private var serverSocket: ServerSocket? = null
  @Volatile private var serverRunning = false
  @Volatile private var clientConnectionStarted = false
  private val connectLock = Any()
  private val activeServerSessions = AtomicInteger(0)

  @SuppressLint("MissingPermission")
  fun start() {
    if (active) return
    val wifiManager = manager ?: throw IllegalStateException("Wi‑Fi Direct غير مدعوم على هذا الجهاز")
    active = true
    channel = wifiManager.initialize(context, Looper.getMainLooper()) {
      onLog("transport_error", "انقطعت قناة Wi‑Fi Direct؛ أعد البحث عن الأجهزة")
    } ?: throw IllegalStateException("تعذر تهيئة WifiP2pManager")
    try {
      registerReceiver()
    } catch (error: Exception) {
      active = false
      channel = null
      onLog("transport_error", "تعذر تسجيل مستمع Wi‑Fi Direct (${error.javaClass.simpleName})")
      throw error
    }
    installServiceAndDiscovery()
    onLog("transport", "تهيأ Wi‑Fi Direct، دون الانضمام إلى الإنترنت")
  }

  @SuppressLint("MissingPermission")
  fun discoverPeers() {
    if (!active) {
      onLog("discovery_unavailable", "شبكة Wi‑Fi Direct متوقفة؛ ابدأ الشبكة أولًا")
      return
    }
    try {
      val p2p = manager ?: run {
        onLog("discovery_error", "Wi‑Fi Direct غير مدعوم على هذا الجهاز")
        return
      }
      val p2pChannel = channel ?: run {
        onLog("discovery_error", "لم تتهيأ قناة Wi‑Fi Direct؛ أعد تشغيل الشبكة")
        return
      }
      startServiceDiscovery(p2p, p2pChannel)
    } catch (error: SecurityException) {
      onLog("permission_error", "لا توجد صلاحية بحث Wi‑Fi Direct")
    } catch (error: Exception) {
      onLog("discovery_error", "تعذر بدء بحث Wi‑Fi Direct (${error.javaClass.simpleName})")
    }
  }

  @SuppressLint("MissingPermission")
  fun connect(peerId: String) {
    val device = devicesById[peerId] ?: throw IllegalArgumentException("الجهاز لم يعد ظاهرًا؛ أعد البحث")
    val p2p = manager ?: throw IllegalStateException("Wi‑Fi Direct غير متاح")
    val p2pChannel = channel ?: throw IllegalStateException("لم تتهيأ قناة Wi‑Fi Direct")
    val config = WifiP2pConfig().apply { deviceAddress = device.deviceAddress }
    p2p.connect(p2pChannel, config, object : WifiP2pManager.ActionListener {
      override fun onSuccess() = onLog("transport", "بدأ التفاوض على وصلة Wi‑Fi Direct مع ${short(peerId)}")
      override fun onFailure(reason: Int) = onLog("transport_error", "تعذر الاتصال عبر Wi‑Fi Direct: ${reasonText(reason)}")
    })
  }

  fun send(peerId: String, payload: String): Boolean {
    if (payload.toByteArray(Charsets.UTF_8).size > MAX_FRAME_BYTES) return false
    val output = outputById[peerId] ?: return false
    return try {
      synchronized(output) {
        val bytes = payload.toByteArray(Charsets.UTF_8)
        output.writeInt(bytes.size)
        output.write(bytes)
        output.flush()
      }
      true
    } catch (_: Exception) {
      dropPeer(peerId)
      false
    }
  }

  @SuppressLint("MissingPermission")
  fun stop() {
    active = false
    if (receiverRegistered) {
      try { receiver?.let(context::unregisterReceiver) } catch (_: Exception) { }
    }
    receiverRegistered = false
    receiver = null
    try {
      val p2p = manager
      val p2pChannel = channel
      if (p2p != null && p2pChannel != null) {
        serviceRequest?.let { p2p.removeServiceRequest(p2pChannel, it, null) }
        p2p.clearLocalServices(p2pChannel, null)
        p2p.removeGroup(p2pChannel, null)
      }
    } catch (_: Exception) { }
    serviceRequest = null
    channel = null
    stopServer()
    socketsById.keys.toList().forEach { dropPeer(it) }
    synchronized(connectLock) { clientConnectionStarted = false }
    devicesById.clear()
  }

  @SuppressLint("MissingPermission")
  private fun installServiceAndDiscovery() {
    val p2p = manager ?: return
    val p2pChannel = channel ?: return
    val txt = mapOf("id" to localId, "v" to "1")
    val service = WifiP2pDnsSdServiceInfo.newInstance("jesr", "_jesr._tcp", txt)
    p2p.addLocalService(p2pChannel, service, actionListener("إعلان هوية جسر المحلية"))
    p2p.setDnsSdResponseListeners(
      p2pChannel,
      WifiP2pManager.DnsSdServiceResponseListener { instanceName, _, device ->
        val id = try { instanceName.removePrefix("jesr-").takeIf { it.matches(Regex("[0-9a-fA-F-]{16,64}")) } } catch (_: Exception) { null }
        if (id != null && id != localId) {
          devicesById[id] = device
          onCandidate(id)
        }
      },
      WifiP2pManager.DnsSdTxtRecordListener { _, record, device ->
        val id = record["id"]?.toString()?.takeIf { it.matches(Regex("[0-9a-fA-F-]{16,64}")) }
        if (id != null && id != localId) {
          devicesById[id] = device
          onCandidate(id)
        }
      }
    )
    val request = WifiP2pDnsSdServiceRequest.newInstance()
    serviceRequest = request
    p2p.addServiceRequest(p2pChannel, request, object : WifiP2pManager.ActionListener {
      override fun onSuccess() {
        onLog("transport", "تهيأ طلب اكتشاف خدمة جسر")
        startServiceDiscovery(p2p, p2pChannel)
      }
      override fun onFailure(reason: Int) {
        onLog("transport_error", "تعذر تهيئة طلب اكتشاف الخدمة: ${reasonText(reason)}")
      }
    })
  }

  @SuppressLint("MissingPermission")
  private fun startServiceDiscovery(p2p: WifiP2pManager, p2pChannel: WifiP2pManager.Channel) {
    try { p2p.discoverServices(p2pChannel, actionListener("اكتشاف خدمات جسر القريبة")) } catch (_: Exception) {
      onLog("transport_error", "تعذر بدء اكتشاف خدمات Wi‑Fi Direct")
    }
  }

  private fun registerReceiver() {
    val filter = IntentFilter().apply {
      addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
      addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
      addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
      addAction(WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION)
    }
    receiver = object : BroadcastReceiver() {
      @Suppress("DEPRECATION")
      override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
          WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> {
            val enabled = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1) == WifiP2pManager.WIFI_P2P_STATE_ENABLED
            onLog(if (enabled) "transport" else "transport_error", if (enabled) "Wi‑Fi P2P مفعّل" else "فعّل Wi‑Fi لاستخدام Wi‑Fi Direct")
          }
          WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> requestPeerList()
          WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> {
            val network = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(WifiP2pManager.EXTRA_NETWORK_INFO, NetworkInfo::class.java)
            else intent.getParcelableExtra(WifiP2pManager.EXTRA_NETWORK_INFO)
            if (network?.isConnected == true) requestConnectionInfo() else {
              socketsById.keys.toList().forEach { dropPeer(it) }
              stopServer()
              synchronized(connectLock) { clientConnectionStarted = false }
              onLog("transport", "انقطعت مجموعة Wi‑Fi Direct")
            }
          }
        }
      }
    }
    receiver?.let { activeReceiver ->
      if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(activeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
      else @Suppress("DEPRECATION") context.registerReceiver(activeReceiver, filter)
    }
    receiverRegistered = true
  }

  @SuppressLint("MissingPermission")
  private fun requestPeerList() {
    val p2p = manager ?: return
    val p2pChannel = channel ?: return
    p2p.requestPeers(p2pChannel) { peers ->
      for (device in peers.deviceList) {
        // Device name/MAC are not exposed to the UI. A node ID is learned from the local DNS-SD record.
        val known = devicesById.values.any { it.deviceAddress == device.deviceAddress }
        if (!known) onLog("peer_candidate", "ظهر جهاز Wi‑Fi P2P؛ ننتظر إعلان هوية جسر المحلية")
      }
    }
  }

  @SuppressLint("MissingPermission")
  private fun requestConnectionInfo() {
    val p2p = manager ?: return
    val p2pChannel = channel ?: return
    p2p.requestConnectionInfo(p2pChannel) { info ->
      if (!info.groupFormed) return@requestConnectionInfo
      if (info.isGroupOwner) startServer(info.groupOwnerAddress?.hostAddress)
      else {
        val address = info.groupOwnerAddress?.hostAddress ?: return@requestConnectionInfo
        connectToGroupOwner(address)
      }
    }
  }

  private fun startServer(groupAddress: String?) {
    if (serverRunning) return
    if (groupAddress.isNullOrBlank()) {
      onLog("transport_error", "تعذر تحديد عنوان مجموعة Wi‑Fi Direct المحلي")
      return
    }
    serverRunning = true
    thread(name = "JesrWifiP2pServer", isDaemon = true) {
      var listening: ServerSocket? = null
      try {
        val server = ServerSocket()
        listening = server
        server.reuseAddress = true
        server.bind(InetSocketAddress(groupAddress, P2P_PORT), MAX_ACTIVE_CLIENTS)
        serverSocket = server
        onLog("transport", "جسر Wi‑Fi Direct جاهز لقبول اتصالات المجموعة المحلية")
        while (active && serverRunning) {
          val socket = server.accept()
          if (activeServerSessions.incrementAndGet() > MAX_ACTIVE_CLIENTS) {
            activeServerSessions.decrementAndGet()
            socket.close()
            onLog("congestion_control", "بلغت مجموعة Wi‑Fi Direct حد جلسات النقل المحلية")
            continue
          }
          socket.soTimeout = CONNECT_TIMEOUT_MS
          socket.tcpNoDelay = true
          thread(name = "JesrWifiP2pPeer", isDaemon = true) {
            try { readPeer(socket, null) } finally { activeServerSessions.decrementAndGet() }
          }
        }
      } catch (error: Exception) {
        if (active && serverRunning) onLog("transport_error", "تعذر فتح مقبس Wi‑Fi Direct (${error.javaClass.simpleName})")
      } finally {
        try { listening?.close() } catch (_: Exception) { }
        if (serverSocket === listening) serverSocket = null
        serverRunning = false
      }
    }
  }

  private fun connectToGroupOwner(address: String) {
    synchronized(connectLock) {
      if (!active || clientConnectionStarted) return
      clientConnectionStarted = true
    }
    thread(name = "JesrWifiP2pConnect", isDaemon = true) {
      var connected = false
      try {
        val socket = Socket()
        socket.soTimeout = CONNECT_TIMEOUT_MS
        socket.connect(InetSocketAddress(address, P2P_PORT), CONNECT_TIMEOUT_MS)
        socket.tcpNoDelay = true
        val id = exchangeHello(socket)
        if (id.isBlank()) {
          socket.close()
          onLog("transport_error", "لم تصل هوية جسر عبر وصلة Wi‑Fi Direct")
          return@thread
        }
        if (!active) {
          socket.close()
          return@thread
        }
        socket.soTimeout = 0
        registerSocket(id, socket)
        onLink(id)
        connected = true
        thread(name = "JesrWifiP2pReader", isDaemon = true) { readPeer(socket, id) }
      } catch (error: Exception) {
        onLog("transport_error", "تعذر فتح اتصال المقابس المحلي (${error.javaClass.simpleName})")
      } finally {
        if (!connected) synchronized(connectLock) { clientConnectionStarted = false }
      }
    }
  }

  private fun readPeer(socket: Socket, initiallyKnownId: String?) {
    var id = initiallyKnownId
    try {
      val input = DataInputStream(socket.getInputStream())
      val output = DataOutputStream(socket.getOutputStream())
      if (id == null) {
        val hello = readFrame(input) ?: return
        id = JSONObject(hello).optString("nodeId")
        if (!id.matches(Regex("[0-9a-fA-F-]{16,64}")) || id == localId) return
        sendFrame(output, JSONObject().put("control", "hello").put("nodeId", localId).toString())
        if (!active) return
        socket.soTimeout = 0
        registerSocket(id, socket, input, output)
        onLink(id)
      } else {
        readFrame(input)?.let { first ->
          val parsed = JSONObject(first)
          if (parsed.optString("control") == "hello") {
            val remoteId = parsed.optString("nodeId")
            if (remoteId.matches(Regex("[0-9a-fA-F-]{16,64}"))) id = remoteId
          } else onPacket(id!!, first)
        }
      }
      while (active && !socket.isClosed) {
        val frame = readFrame(input) ?: break
        val parsed = try { JSONObject(frame) } catch (_: Exception) { continue }
        if (parsed.optString("control") == "hello") {
          val remoteId = parsed.optString("nodeId")
          if (remoteId.matches(Regex("[0-9a-fA-F-]{16,64}"))) id = remoteId
        } else if (id != null) onPacket(id!!, frame)
      }
    } catch (_: EOFException) {
      // Normal peer disconnect.
    } catch (error: Exception) {
      if (active) onLog("transport_error", "انتهى اتصال Wi‑Fi Direct (${error.javaClass.simpleName})")
    } finally {
      try { socket.close() } catch (_: Exception) { }
      id?.let { dropPeer(it, socket) }
    }
  }

  private fun exchangeHello(socket: Socket): String {
    val input = DataInputStream(socket.getInputStream())
    val output = DataOutputStream(socket.getOutputStream())
    sendFrame(output, JSONObject().put("control", "hello").put("nodeId", localId).toString())
    val reply = readFrame(input) ?: return ""
    val parsed = JSONObject(reply)
    return parsed.optString("nodeId")
  }

  private fun registerSocket(id: String, socket: Socket, input: DataInputStream? = null, output: DataOutputStream? = null) {
    socketsById.put(id, socket)?.let { old -> if (old !== socket) try { old.close() } catch (_: Exception) { } }
    if (input != null) inputById[id] = input
    else inputById[id] = DataInputStream(socket.getInputStream())
    if (output != null) outputById[id] = output
    else outputById[id] = DataOutputStream(socket.getOutputStream())
  }

  private fun dropPeer(id: String, session: Socket? = null) {
    if (session != null && socketsById[id] !== session) return
    socketsById.remove(id)?.let { try { it.close() } catch (_: Exception) { } }
    inputById.remove(id)
    outputById.remove(id)
    if (socketsById.isEmpty()) synchronized(connectLock) { clientConnectionStarted = false }
    onLost(id)
  }

  private fun stopServer() {
    serverRunning = false
    try { serverSocket?.close() } catch (_: Exception) { }
    serverSocket = null
  }

  private fun sendFrame(output: DataOutputStream, content: String) {
    val bytes = content.toByteArray(Charsets.UTF_8)
    require(bytes.size <= MAX_FRAME_BYTES)
    synchronized(output) {
      output.writeInt(bytes.size)
      output.write(bytes)
      output.flush()
    }
  }

  private fun readFrame(input: DataInputStream): String? {
    val length = try { input.readInt() } catch (_: EOFException) { return null }
    if (length !in 1..MAX_FRAME_BYTES) throw IllegalArgumentException("حجم إطار غير صالح")
    val bytes = ByteArray(length)
    input.readFully(bytes)
    return String(bytes, Charsets.UTF_8)
  }

  private fun actionListener(label: String) = object : WifiP2pManager.ActionListener {
    override fun onSuccess() { onLog("transport", "$label: نجح") }
    override fun onFailure(reason: Int) { onLog("transport_error", "$label: ${reasonText(reason)}") }
  }

  private fun reasonText(code: Int): String = when (code) {
    WifiP2pManager.BUSY -> "النظام مشغول"
    WifiP2pManager.ERROR -> "خطأ في نظام Wi‑Fi P2P"
    WifiP2pManager.P2P_UNSUPPORTED -> "ميزة Wi‑Fi Direct غير مدعومة"
    else -> "رمز الخطأ $code"
  }

  private fun short(id: String) = if (id.length > 8) id.take(5) + "…" + id.takeLast(2) else id

  companion object {
    private const val P2P_PORT = 41873
    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val MAX_FRAME_BYTES = 8 * 1024
    private const val MAX_ACTIVE_CLIENTS = 8
  }
}
