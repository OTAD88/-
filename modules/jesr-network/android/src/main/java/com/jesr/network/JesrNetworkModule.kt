package com.jesr.network

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class JesrNetworkModule : Module() {
  private var router: MeshRouter? = null
  private var ble: BleMeshTransport? = null
  private var wifi: WifiDirectMeshTransport? = null
  private var active = false
  private var jesrAliases: Set<String> = emptySet()
  private val crypto by lazy { JesrCrypto(requireContext()) }
  private var batteryMode = false
  private val diagnostics by lazy { NativeDiagnosticStore(requireContext()) }
  private var previousUncaughtHandler: Thread.UncaughtExceptionHandler? = null
  private val candidates = ConcurrentHashMap<String, MutableMap<String, Any?>>()
  private val linkRegistry = ConcurrentHashMap<String, MeshLink>()
  private val maintenanceHandler = Handler(Looper.getMainLooper())
  private val maintenance = object : Runnable {
    override fun run() {
      if (!active) return
      router?.tick()
      maintenanceHandler.postDelayed(this, 1_000L)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("JesrNetwork")
    Events("onMeshState", "onMeshLog", "onPeerDiscovered", "onPingResult", "onJesrData")

    OnCreate {
      ensureIdentity()
      diagnostics.record("module_created")
      previousUncaughtHandler = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, error ->
        diagnostics.record("native_uncaught_exception", thread.name, error)
        previousUncaughtHandler?.uncaughtException(thread, error)
      }
    }

    OnDestroy {
      stopInternal()
    }

    AsyncFunction("getSnapshot") {
      currentSnapshot()
    }

    AsyncFunction("getNativeDiagnosticReport") {
      diagnostics.read()
    }

    AsyncFunction("startNetwork") { mode: String ->
      diagnostics.record("start_network_entered", "mode=${mode.take(20)}")
      val context = requireContext()
      requireRuntimePermissions(context)
      if (active) return@AsyncFunction currentSnapshot()
      batteryMode = mode == "battery"
      val id = ensureIdentity()
      router = MeshRouter(
        id,
        transmitter = { peerId, transport, payload ->
          when (transport) {
            MeshTransportKind.BLE -> ble?.send(peerId, payload) == true
            MeshTransportKind.WIFI_DIRECT -> wifi?.send(peerId, payload) == true
          }
        },
        eventSink = { event -> publishRouterEvent(event) },
        dataSink = { envelope, _ -> sendEvent("onJesrData", mapOf("envelope" to envelope)) }
      ).also { it.aliases = jesrAliases }
      maintenanceHandler.removeCallbacks(maintenance)
      maintenanceHandler.postDelayed(maintenance, 1_000L)
      active = true
      var started = false

      try {
        diagnostics.record("start_network_ble_begin")
        val bleTransport = BleMeshTransport(
          context = context,
          localId = id,
          onPeerReady = { peerId, quality, rssi ->
            candidates.remove(peerId)
            putLink(MeshLink(peerId, MeshTransportKind.BLE, quality, 0, null, 0.0, rssi, qualityMeasured = false))
            publishState()
          },
          onPeerLost = { peerId -> removeLink(peerId, MeshTransportKind.BLE); publishState() },
          onPacket = { peerId, packet -> router?.receive(packet, peerId, MeshTransportKind.BLE) },
          onLog = { kind, message -> publishLog(kind, message) }
        )
        ble = bleTransport
        bleTransport.start(batteryMode)
        diagnostics.record("start_network_ble_returned")
        started = true
      } catch (error: Exception) {
        diagnostics.record("start_network_ble_failed", error.javaClass.simpleName, error)
        Log.e(TAG, "BLE initialization failed", error)
        publishLog("ble_unavailable", "تعذر بدء BLE (${error.javaClass.simpleName})")
      }

      try {
        diagnostics.record("start_network_wifi_begin")
        val wifiTransport = WifiDirectMeshTransport(
          context = context,
          localId = id,
          onCandidate = { peerId ->
            if (!linkRegistry.values.any { it.peerId == peerId }) {
              candidates[peerId] = peerCandidate(peerId, "wifi-direct")
              candidates[peerId]?.let { sendEvent("onPeerDiscovered", it) }
              publishState()
            }
          },
          onLink = { peerId ->
            candidates.remove(peerId)
            // Wi‑Fi P2P has no RSSI measurement here; leave signal strength unavailable.
            putLink(MeshLink(peerId, MeshTransportKind.WIFI_DIRECT, 0, 0, null, 0.0, null))
            publishState()
          },
          onLost = { peerId -> removeLink(peerId, MeshTransportKind.WIFI_DIRECT); publishState() },
          onPacket = { peerId, packet -> router?.receive(packet, peerId, MeshTransportKind.WIFI_DIRECT) },
          onLog = { kind, message -> publishLog(kind, message) }
        )
        wifi = wifiTransport
        wifiTransport.start()
        diagnostics.record("start_network_wifi_returned")
        started = true
      } catch (error: Exception) {
        diagnostics.record("start_network_wifi_failed", error.javaClass.simpleName, error)
        Log.e(TAG, "Wi-Fi Direct initialization failed", error)
        publishLog("wifi_direct_unavailable", "تعذر بدء Wi‑Fi Direct (${error.javaClass.simpleName})")
      }

      if (!started) {
        stopInternal()
        throw IllegalStateException("لم يبدأ BLE أو Wi‑Fi Direct. افحص دعم الجهاز والصلاحيات وحالة Bluetooth وWi‑Fi.")
      }
      try {
        diagnostics.record("start_network_foreground_begin")
        val serviceIntent = Intent(context, MeshForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(serviceIntent)
        else context.startService(serviceIntent)
        diagnostics.record("start_network_foreground_requested")
      } catch (error: Exception) {
        diagnostics.record("start_network_foreground_failed", error.javaClass.simpleName, error)
        Log.e(TAG, "Foreground service could not start; keeping local transport active", error)
        publishLog("foreground_service_error", "تعذر تشغيل خدمة الخلفية؛ ستعمل الشبكة ما دام التطبيق مفتوحًا (${error.javaClass.simpleName})")
      }
      publishState()
      currentSnapshot()
    }

    AsyncFunction("stopNetwork") {
      stopInternal()
      currentSnapshot()
    }

    AsyncFunction("discoverPeers") {
      diagnostics.record("discover_nearby_entered")
      if (!active) {
        publishLog("discovery_unavailable", "ابدأ الشبكة أولًا قبل البحث عن الأجهزة القريبة")
        return@AsyncFunction currentSnapshot()
      }
      var requested = false
      try {
        diagnostics.record("discover_nearby_ble_begin")
        ble?.discoverNow()
        diagnostics.record("discover_nearby_ble_returned")
        requested = ble != null || requested
      } catch (error: Exception) {
        diagnostics.record("discover_nearby_ble_failed", error.javaClass.simpleName, error)
        Log.e(TAG, "Bluetooth discovery failed", error)
        publishLog("discovery_error", "تعذر بدء بحث Bluetooth: ${error.javaClass.simpleName}")
      }
      try {
        diagnostics.record("discover_nearby_wifi_begin")
        wifi?.discoverPeers()
        diagnostics.record("discover_nearby_wifi_returned")
        requested = wifi != null || requested
      } catch (error: Exception) {
        diagnostics.record("discover_nearby_wifi_failed", error.javaClass.simpleName, error)
        Log.e(TAG, "Wi-Fi Direct discovery failed", error)
        publishLog("discovery_error", "تعذر بدء بحث Wi‑Fi Direct: ${error.javaClass.simpleName}")
      }
      if (requested) publishLog("discovery", "بدأ البحث المحلي عن الأجهزة القريبة")
      else publishLog("discovery_unavailable", "لا توجد وحدة اتصال متاحة للبحث حاليًا")
    }

    AsyncFunction("connectPeer") { peerId: String ->
      if (!active) throw IllegalStateException("الشبكة متوقفة")
      val candidate = candidates[peerId]
      if (candidate?.get("transport") == "wifi-direct") wifi?.connect(peerId)
      else throw IllegalArgumentException("اتصال BLE يبدأ تلقائيًا عند اكتشاف إعلان الجهاز")
    }

    // ---- Jesr app layer: opaque envelopes over the mesh ----
    AsyncFunction("setJesrId") { jesrId: String ->
      jesrAliases = if (jesrId.isBlank()) emptySet() else setOf(jesrId)
      router?.aliases = jesrAliases
    }

    AsyncFunction("sendData") { targetJesrId: String, envelope: String ->
      if (!active) return@AsyncFunction false
      router?.sendData(targetJesrId, envelope) ?: false
    }

    // ---- Cryptography (libsodium) and encrypted storage; keys never leave native code ----
    AsyncFunction("cryptoPublicKey") { JesrKeystore.b64(crypto.publicKey) }
    AsyncFunction("cryptoSign") { data: String -> JesrKeystore.b64(crypto.sign(JesrKeystore.unb64(data))) }
    AsyncFunction("cryptoVerify") { pub: String, data: String, sig: String ->
      crypto.verify(JesrKeystore.unb64(pub), JesrKeystore.unb64(data), JesrKeystore.unb64(sig))
    }
    AsyncFunction("cryptoSha256") { data: String -> JesrKeystore.b64(crypto.sha256(JesrKeystore.unb64(data))) }
    AsyncFunction("cryptoRandom") { n: Int -> JesrKeystore.b64(crypto.randomBytes(n)) }
    AsyncFunction("cryptoEncrypt") { peerPub: String, plain: String, aad: String ->
      JesrKeystore.b64(crypto.encrypt(JesrKeystore.unb64(peerPub), JesrKeystore.unb64(plain), JesrKeystore.unb64(aad)))
    }
    AsyncFunction("cryptoDecrypt") { blob: String, aad: String ->
      JesrKeystore.b64(crypto.decrypt(JesrKeystore.unb64(blob), JesrKeystore.unb64(aad)))
    }
    AsyncFunction("secureGet") { name: String -> crypto.secureGet(name) }
    AsyncFunction("secureSet") { name: String, value: String -> crypto.secureSet(name, value) }

    AsyncFunction("sendPing") { peerId: String ->
      if (!active) throw IllegalStateException("الشبكة متوقفة")
      router?.ping(peerId) ?: throw IllegalStateException("محرك الشبكة غير جاهز")
    }
  }

  private fun requireContext(): Context = requireNotNull(appContext.reactContext) { "سياق Android غير متاح" }

  private fun ensureIdentity(): String {
    val context = requireContext()
    val preferences = context.getSharedPreferences("jesr_local_identity", Context.MODE_PRIVATE)
    val current = preferences.getString("node_id", null)
    if (!current.isNullOrBlank()) return current
    // UUID محلي عشوائي يُحفظ في SharedPreferences؛ لا يعتمد على MAC أو IMEI ولا يتغير أثناء استخدام التطبيق.
    val created = UUID.randomUUID().toString()
    preferences.edit().putString("node_id", created).apply()
    return created
  }

  private fun requireRuntimePermissions(context: Context) {
    val required = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= 31) {
      required += Manifest.permission.BLUETOOTH_SCAN
      required += Manifest.permission.BLUETOOTH_ADVERTISE
      required += Manifest.permission.BLUETOOTH_CONNECT
    } else {
      required += Manifest.permission.ACCESS_FINE_LOCATION
    }
    if (Build.VERSION.SDK_INT >= 33) required += Manifest.permission.NEARBY_WIFI_DEVICES
    else required += Manifest.permission.ACCESS_FINE_LOCATION
    val missing = required.distinct().filter { context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    if (missing.isNotEmpty()) throw SecurityException("تحتاج الشبكة إلى موافقات Android التالية قبل التشغيل: ${missing.joinToString()}")
  }

  private fun stopInternal() {
    active = false
    maintenanceHandler.removeCallbacks(maintenance)
    linkRegistry.clear()
    try { ble?.stop() } catch (_: Exception) { }
    try { wifi?.stop() } catch (_: Exception) { }
    router?.clearLinks()
    ble = null
    wifi = null
    candidates.clear()
    val context = appContext.reactContext
    if (context != null) {
      try { context.stopService(Intent(context, MeshForegroundService::class.java)) } catch (_: Exception) { }
    }
    publishState()
  }

  private fun currentSnapshot(): Map<String, Any?> {
    val context = appContext.reactContext
    val id = if (context != null) ensureIdentity() else "غير متاح"
    val routerState = router?.snapshot()
    val peers = (routerState?.get("peers") as? List<*>)?.toMutableList() ?: mutableListOf()
    peers.addAll(candidates.values)
    return mapOf(
      "available" to true,
      "active" to active,
      "localId" to id,
      "transportState" to if (!active) "stopped" else if (peers.any { (it as? Map<*, *>)?.get("connected") == true }) "connected" else "searching",
      "batteryMode" to if (batteryMode) "battery" else "balanced",
      "peers" to peers,
      "routes" to (routerState?.get("routes") ?: emptyList<Map<String, Any?>>()),
      "pendingPackets" to (routerState?.get("pendingPackets") ?: 0),
      "events" to (routerState?.get("events") ?: emptyList<Map<String, Any?>>())
    )
  }

  private fun peerCandidate(peerId: String, transport: String): MutableMap<String, Any?> = mutableMapOf(
    "id" to peerId,
    "transport" to transport,
    "direct" to false,
    "quality" to 0,
    "qualityMeasured" to false,
    "lossPercent" to 0,
    "lossMeasured" to false,
    "latencyMs" to null,
    "stability" to 0.0,
    "stabilityMeasured" to false,
    "lastSeenAt" to System.currentTimeMillis(),
    "connected" to false
  )

  private fun linkKey(peerId: String, transport: MeshTransportKind) = "$peerId|${transport.wireName}"

  private fun putLink(link: MeshLink) {
    if (!active) return
    linkRegistry[linkKey(link.peerId, link.transport)] = link
    val preferred = linkRegistry.values
      .filter { it.peerId == link.peerId }
      .maxByOrNull { if (it.transport == MeshTransportKind.WIFI_DIRECT) 2 else 1 }
    preferred?.let { router?.updateLink(it) }
  }

  private fun removeLink(peerId: String, transport: MeshTransportKind) {
    linkRegistry.remove(linkKey(peerId, transport))
    if (!active) return
    val fallback = linkRegistry.values
      .filter { it.peerId == peerId }
      .maxByOrNull { if (it.transport == MeshTransportKind.WIFI_DIRECT) 2 else 1 }
    if (fallback == null) router?.removeLink(peerId) else router?.updateLink(fallback)
  }

  private fun publishRouterEvent(event: Map<String, Any?>) {
    sendEvent("onMeshLog", event)
    if (event["kind"] == "ping_ack" || event["kind"] == "routing_failed") {
      val result = event.toMutableMap()
      result["success"] = event["kind"] == "ping_ack"
      sendEvent("onPingResult", result)
    }
    publishState()
  }

  private fun publishLog(kind: String, message: String) {
    sendEvent("onMeshLog", mapOf("id" to UUID.randomUUID().toString(), "at" to System.currentTimeMillis(), "kind" to kind, "message" to message))
  }

  private fun publishState() {
    sendEvent("onMeshState", currentSnapshot())
  }

  private companion object {
    const val TAG = "JesrNetwork"
  }
}
