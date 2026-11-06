package com.jesr.network

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

internal class BleMeshTransport(
  context: Context,
  private val localId: String,
  private val onPeerReady: (String, Int, Int?) -> Unit,
  private val onPeerLost: (String) -> Unit,
  private val onPacket: (String, String) -> Unit,
  private val onLog: (String, String) -> Unit
) {
  private data class Assembly(
    val sequence: Int,
    val total: Int,
    val parts: Array<ByteArray?>,
    var received: Int = 0,
    var bytes: Int = 0,
    val createdAt: Long = System.currentTimeMillis()
  )

  private val appContext = context.applicationContext
  private val bluetoothManager = appContext.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private val adapter get() = bluetoothManager.adapter
  private val handler = Handler(Looper.getMainLooper())
  private val gattByAddress = ConcurrentHashMap<String, BluetoothGatt>()
  private val deviceByAddress = ConcurrentHashMap<String, BluetoothDevice>()
  private val addressToNode = ConcurrentHashMap<String, String>()
  private val nodeToAddress = ConcurrentHashMap<String, String>()
  private val serverDeviceByNode = ConcurrentHashMap<String, BluetoothDevice>()
  private val lastSeen = ConcurrentHashMap<String, Long>()
  private val pendingRssi = ConcurrentHashMap<String, Int>()
  private val pendingQuality = ConcurrentHashMap<String, Int>()
  private val mtuByAddress = ConcurrentHashMap<String, Int>()
  private val notificationEnabled = ConcurrentHashMap.newKeySet<String>()
  private val assemblies = ConcurrentHashMap<String, Assembly>()
  private val clientQueues = ConcurrentHashMap<String, ArrayDeque<ByteArray>>()
  private val notificationQueues = ConcurrentHashMap<String, ArrayDeque<ByteArray>>()
  private val clientInFlight = ConcurrentHashMap.newKeySet<String>()
  private val notificationInFlight = ConcurrentHashMap.newKeySet<String>()
  private val frameSequence = AtomicInteger(1)
  private var server: BluetoothGattServer? = null
  private var advertiserCallback: AdvertiseCallback? = null
  private var scanCallback: ScanCallback? = null
  private var isScanning = false
  private var active = false
  private var scanIntervalMs = 30_000L
  private val serviceUuid = ParcelUuid(UUID.fromString("0000fef0-0000-1000-8000-00805f9b34fb"))
  private val dataUuid = ParcelUuid(UUID.fromString("0000fef1-0000-1000-8000-00805f9b34fb"))
  private val tagUuid = ParcelUuid(UUID.fromString("0000fef2-0000-1000-8000-00805f9b34fb"))
  private val cccdUuid = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

  @SuppressLint("MissingPermission")
  fun start(batteryMode: Boolean) {
    if (active) return
    val bluetooth = adapter ?: throw IllegalStateException("هذا الجهاز لا يتضمن Bluetooth")
    if (!bluetooth.isEnabled) throw IllegalStateException("فعّل Bluetooth من إعدادات Android")
    active = true
    scanIntervalMs = if (batteryMode) 60_000L else 30_000L
    server = bluetoothManager.openGattServer(appContext, gattServerCallback)
      ?: throw IllegalStateException("تعذر فتح خادم GATT")
    val characteristic = BluetoothGattCharacteristic(
      dataUuid.uuid,
      BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_WRITE
    )
    characteristic.addDescriptor(BluetoothGattDescriptor(
      cccdUuid,
      BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
    ))
    val service = BluetoothGattService(serviceUuid.uuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    service.addCharacteristic(characteristic)
    if (server?.addService(service) != true) throw IllegalStateException("تعذر تسجيل خدمة BLE المحلية")
    startAdvertising(bluetooth)
    startScanWindow()
    handler.postDelayed(scanCycle, scanIntervalMs)
    onLog("transport", "بدأ BLE Advertising وخادم GATT ثنائي الاتجاه")
  }

  @SuppressLint("MissingPermission")
  fun discoverNow() {
    if (!active) return
    try {
      val scanner = adapter?.bluetoothLeScanner
      if (scanner == null) {
        onLog("discovery_error", "ماسح Bluetooth غير متاح حاليًا")
        return
      }
      try { scanCallback?.let(scanner::stopScan) } catch (_: Exception) { }
      isScanning = false
      startScanWindow()
    } catch (error: SecurityException) {
      onLog("permission_error", "لا توجد صلاحية بحث Bluetooth")
    } catch (error: Exception) {
      onLog("discovery_error", "تعذر إعادة بدء بحث Bluetooth (${error.javaClass.simpleName})")
    }
  }

  @SuppressLint("MissingPermission")
  fun send(peerId: String, payload: String): Boolean {
    val data = payload.toByteArray(Charsets.UTF_8)
    if (data.isEmpty() || data.size > MAX_APPLICATION_BYTES) return false
    val address = nodeToAddress[peerId] ?: return false
    val client = gattByAddress[address]
    if (client != null) return enqueueClient(address, data, mtuByAddress[address] ?: DEFAULT_MTU)
    val remote = serverDeviceByNode[peerId] ?: return false
    if (!notificationEnabled.contains(remote.address)) return false
    return enqueueNotification(peerId, remote, data, mtuByAddress[remote.address] ?: DEFAULT_MTU)
  }

  @SuppressLint("MissingPermission")
  fun stop() {
    active = false
    handler.removeCallbacks(scanCycle)
    handler.removeCallbacks(scanWindowEnd)
    adapter?.bluetoothLeScanner?.let { scanner ->
      try { scanCallback?.let(scanner::stopScan) } catch (_: Exception) { }
    }
    scanCallback = null
    advertiserCallback?.let { callback ->
      try { adapter?.bluetoothLeAdvertiser?.stopAdvertising(callback) } catch (_: Exception) { }
    }
    advertiserCallback = null
    gattByAddress.values.forEach { try { it.disconnect(); it.close() } catch (_: Exception) { } }
    gattByAddress.clear()
    deviceByAddress.clear()
    nodeToAddress.clear()
    addressToNode.clear()
    serverDeviceByNode.clear()
    lastSeen.clear()
    pendingRssi.clear()
    pendingQuality.clear()
    mtuByAddress.clear()
    notificationEnabled.clear()
    assemblies.clear()
    clientQueues.clear()
    notificationQueues.clear()
    clientInFlight.clear()
    notificationInFlight.clear()
    try { server?.close() } catch (_: Exception) { }
    server = null
  }

  @SuppressLint("MissingPermission")
  private fun startAdvertising(bluetooth: android.bluetooth.BluetoothAdapter) {
    val advertiser = bluetooth.bluetoothLeAdvertiser ?: throw IllegalStateException("BLE Advertising غير مدعوم على هذا الجهاز")
    val callback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
        onLog("transport", "بدأ إعلان BLE للجهاز المحلي")
      }
      override fun onStartFailure(errorCode: Int) {
        onLog("transport_error", "تعذر بدء BLE Advertising: $errorCode")
      }
    }
    advertiserCallback = callback
    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .addServiceData(tagUuid, shortTag(localId))
      .build()
    advertiser.startAdvertising(
      AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_LOW)
        .setConnectable(true)
        .setTimeout(0)
        .build(),
      data,
      callback
    )
  }

  @SuppressLint("MissingPermission")
  private fun startScanWindow() {
    if (!active || isScanning) return
    val scanner = try { adapter?.bluetoothLeScanner } catch (error: Exception) {
      onLog("discovery_error", "تعذر الوصول إلى ماسح Bluetooth (${error.javaClass.simpleName})")
      return
    } ?: run {
      onLog("discovery_error", "ماسح Bluetooth غير مدعوم على هذا الجهاز")
      return
    }
    val callback = scanCallback ?: object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) = handleScanResult(result)
      override fun onBatchScanResults(results: MutableList<ScanResult>) = results.forEach(::handleScanResult)
      override fun onScanFailed(errorCode: Int) = onLog("transport_error", "فشل مسح BLE: $errorCode")
    }.also { scanCallback = it }
    try {
      scanner.startScan(
        listOf(ScanFilter.Builder().setServiceData(tagUuid, null, null).build()),
        ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_POWER).setReportDelay(0).build(),
        callback
      )
      isScanning = true
      handler.removeCallbacks(scanWindowEnd)
      handler.postDelayed(scanWindowEnd, if (scanIntervalMs < 40_000L) 8_000L else 5_000L)
    } catch (_: SecurityException) {
      onLog("permission_error", "لم يمنح المستخدم صلاحية مسح Bluetooth")
    } catch (error: Exception) {
      onLog("transport_error", "تعذر بدء مسح BLE (${error.javaClass.simpleName})")
    }
  }

  private val scanWindowEnd = Runnable {
    if (!isScanning) return@Runnable
    try { adapter?.bluetoothLeScanner?.let { scanner -> scanCallback?.let(scanner::stopScan) } } catch (_: Exception) { }
    isScanning = false
    prunePeers()
  }

  private val scanCycle: Runnable = object : Runnable {
    override fun run() {
      if (!active) return
      startScanWindow()
      handler.postDelayed(this, scanIntervalMs)
    }
  }

  @SuppressLint("MissingPermission")
  private fun handleScanResult(result: ScanResult) {
    val device = result.device ?: return
    val tag = result.scanRecord?.getServiceData(tagUuid) ?: return
    if (tag.contentEquals(shortTag(localId))) return
    val address = device.address ?: return
    lastSeen[address] = System.currentTimeMillis()
    pendingQuality[address] = ((result.rssi + 100) * 2).coerceIn(0, 100)
    pendingRssi[address] = result.rssi
    // The lexicographically smaller 64-bit random tag initiates one full-duplex GATT link.
    // The GATT notification characteristic provides the reverse direction on that same link.
    if (!shouldInitiate(tag)) return
    if (gattByAddress.containsKey(address)) return
    try {
      val gatt = if (Build.VERSION.SDK_INT >= 23) {
        device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
      } else device.connectGatt(appContext, false, gattCallback)
      if (gatt != null) gattByAddress[address] = gatt
    } catch (error: Exception) {
      onLog("transport_error", "تعذر فتح اتصال GATT (${error.javaClass.simpleName})")
    }
  }

  private val gattCallback = object : BluetoothGattCallback() {
    @SuppressLint("MissingPermission")
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
        val requested = if (Build.VERSION.SDK_INT >= 21) try { gatt.requestMtu(512) } catch (_: Exception) { false } else false
        if (!requested) try { gatt.discoverServices() } catch (_: Exception) { }
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        val address = gatt.device.address
        deviceByAddress.remove(address)
        val nodeId = addressToNode.remove(address)
        if (nodeId != null) {
          nodeToAddress.remove(nodeId, address)
          serverDeviceByNode.remove(nodeId)
          onPeerLost(nodeId)
        }
        mtuByAddress.remove(address)
        notificationEnabled.remove(address)
        clearAssemblies(address)
        clientQueues.remove(address)
        notificationQueues.remove(address)
        clientInFlight.remove(address)
        notificationInFlight.remove(address)
        gattByAddress.remove(address)
        try { gatt.close() } catch (_: Exception) { }
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      if (status == BluetoothGatt.GATT_SUCCESS) mtuByAddress[gatt.device.address] = mtu
      try { gatt.discoverServices() } catch (_: Exception) { }
    }

    @SuppressLint("MissingPermission")
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      if (status != BluetoothGatt.GATT_SUCCESS) return
      val characteristic = gatt.getService(serviceUuid.uuid)?.getCharacteristic(dataUuid.uuid) ?: return
      val descriptor = characteristic.getDescriptor(cccdUuid)
      if (descriptor == null || !gatt.setCharacteristicNotification(characteristic, true)) {
        onLog("transport_error", "تعذر إعداد قناة إشعار GATT ثنائية الاتجاه")
        return
      }
      descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
      try {
        if (!gatt.writeDescriptor(descriptor)) onLog("transport_error", "تعذر تفعيل إشعارات GATT")
      } catch (_: Exception) { onLog("transport_error", "تعذر تفعيل إشعارات GATT") }
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      if (descriptor.uuid != cccdUuid || status != BluetoothGatt.GATT_SUCCESS) {
        onLog("transport_error", "لم يكتمل التفاوض على قناة GATT ثنائية الاتجاه")
        return
      }
      enqueueClient(gatt.device.address, helloFrame().toByteArray(Charsets.UTF_8), mtuByAddress[gatt.device.address] ?: DEFAULT_MTU)
    }

    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      completeClientWrite(gatt.device.address, status == BluetoothGatt.GATT_SUCCESS)
    }

    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      characteristic.value?.let { acceptFragment(gatt.device.address, "notify", it) }
    }

    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      acceptFragment(gatt.device.address, "notify", value)
    }
  }

  private val gattServerCallback = object : BluetoothGattServerCallback() {
    @SuppressLint("MissingPermission")
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        deviceByAddress[device.address] = device
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        val address = device.address
        deviceByAddress.remove(address)
        val nodeId = addressToNode.remove(address)
        if (nodeId != null) {
          nodeToAddress.remove(nodeId, address)
          serverDeviceByNode.remove(nodeId)
          onPeerLost(nodeId)
        }
        mtuByAddress.remove(address)
        notificationEnabled.remove(address)
        clearAssemblies(address)
        notificationQueues.remove(address)
        notificationInFlight.remove(address)
      }
    }

    @SuppressLint("MissingPermission")
    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      mtuByAddress[device.address] = mtu
    }

    @SuppressLint("MissingPermission")
    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray
    ) {
      if (descriptor.uuid != cccdUuid || preparedWrite || offset != 0) {
        if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null)
        return
      }
      if (BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE.contentEquals(value)) notificationEnabled.add(device.address)
      else notificationEnabled.remove(device.address)
      if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
    }

    @SuppressLint("MissingPermission")
    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray
    ) {
      if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
      if (preparedWrite || offset != 0 || characteristic.uuid != dataUuid.uuid) return
      acceptFragment(device.address, "write", value)
    }

    @SuppressLint("MissingPermission")
    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      completeNotification(device.address, status == BluetoothGatt.GATT_SUCCESS)
    }
  }

  private fun acceptFragment(address: String, direction: String, value: ByteArray) {
    if (value.size < FRAME_HEADER_BYTES || value[0] != FRAME_MAGIC_1 || value[1] != FRAME_MAGIC_2) return
    val sequence = ((value[2].toInt() and 0xff) shl 8) or (value[3].toInt() and 0xff)
    val index = ((value[4].toInt() and 0xff) shl 8) or (value[5].toInt() and 0xff)
    val total = ((value[6].toInt() and 0xff) shl 8) or (value[7].toInt() and 0xff)
    if (total !in 1..MAX_FRAME_COUNT || index !in 0 until total) return
    val now = System.currentTimeMillis()
    assemblies.entries.removeAll { now - it.value.createdAt > FRAME_TIMEOUT_MS }
    val assemblyKey = "$address:$direction"
    var assembly = assemblies[assemblyKey]
    if (assembly == null || assembly.sequence != sequence || assembly.total != total) {
      assembly = Assembly(sequence, total, arrayOfNulls(total))
      assemblies[assemblyKey] = assembly
    }
    if (assembly.parts[index] != null) return
    val fragment = value.copyOfRange(FRAME_HEADER_BYTES, value.size)
    if (assembly.bytes + fragment.size > MAX_APPLICATION_BYTES) {
      assemblies.remove(assemblyKey)
      return
    }
    assembly.parts[index] = fragment
    assembly.received++
    assembly.bytes += fragment.size
    if (assembly.received != assembly.total) return
    val output = ByteArrayOutputStream(assembly.bytes)
    for (part in assembly.parts) if (part != null) output.write(part, 0, part.size)
    assemblies.remove(assemblyKey)
    val payload = try { String(output.toByteArray(), Charsets.UTF_8) } catch (_: Exception) { return }
    handlePayload(address, payload)
  }

  private fun clearAssemblies(address: String) {
    val prefix = "$address:"
    assemblies.keys.filter { it.startsWith(prefix) }.forEach(assemblies::remove)
  }

  private fun handlePayload(address: String, payload: String) {
    if (payload.startsWith(HELLO_PREFIX)) {
      val remoteId = payload.removePrefix(HELLO_PREFIX).take(64)
      if (!remoteId.matches(NODE_ID_PATTERN) || remoteId == localId) return
      val previous = addressToNode.put(address, remoteId)
      nodeToAddress[remoteId] = address
      val remoteDevice = deviceByAddress[address]
      val rssi = pendingRssi[address]
      val quality = pendingQuality[address] ?: 50
      if (previous != remoteId) onPeerReady(remoteId, quality, rssi)
      if (notificationEnabled.contains(address) && remoteDevice != null) {
        serverDeviceByNode[remoteId] = remoteDevice
        enqueueNotification(remoteId, remoteDevice, helloFrame().toByteArray(Charsets.UTF_8), mtuByAddress[address] ?: DEFAULT_MTU)
      }
      return
    }
    val peerId = addressToNode[address] ?: return
    onPacket(peerId, payload)
  }

  private fun shouldInitiate(remoteTag: ByteArray): Boolean {
    val localTag = shortTag(localId)
    val size = minOf(localTag.size, remoteTag.size)
    for (index in 0 until size) {
      val comparison = (localTag[index].toInt() and 0xff).compareTo(remoteTag[index].toInt() and 0xff)
      if (comparison != 0) return comparison < 0
    }
    return localTag.size < remoteTag.size
  }

  private fun shortTag(id: String): ByteArray {
    val compact = id.replace("-", "")
    return try { compact.take(16).chunked(2).map { it.toInt(16).toByte() }.toByteArray() } catch (_: Exception) {
      id.toByteArray().take(8).toByteArray()
    }
  }

  private fun fragment(payload: ByteArray, mtu: Int): List<ByteArray> {
    val chunkSize = mtu - 3 - FRAME_HEADER_BYTES
    if (chunkSize <= 0) return emptyList()
    val count = (payload.size + chunkSize - 1) / chunkSize
    if (count !in 1..MAX_FRAME_COUNT) return emptyList()
    val sequence = frameSequence.getAndUpdate { (it + 1) and 0xffff } and 0xffff
    return (0 until count).map { index ->
      val start = index * chunkSize
      val end = minOf(payload.size, start + chunkSize)
      ByteArray(FRAME_HEADER_BYTES + end - start).also { frame ->
        frame[0] = FRAME_MAGIC_1
        frame[1] = FRAME_MAGIC_2
        frame[2] = (sequence shr 8).toByte()
        frame[3] = sequence.toByte()
        frame[4] = (index shr 8).toByte()
        frame[5] = index.toByte()
        frame[6] = (count shr 8).toByte()
        frame[7] = count.toByte()
        payload.copyInto(frame, FRAME_HEADER_BYTES, start, end)
      }
    }
  }

  private fun enqueueClient(address: String, payload: ByteArray, mtu: Int): Boolean {
    val gatt = gattByAddress[address] ?: return false
    val chunks = fragment(payload, mtu)
    if (chunks.isEmpty()) return false
    val queue = clientQueues.computeIfAbsent(address) { ArrayDeque() }
    synchronized(queue) {
      if (queue.size + chunks.size > MAX_QUEUED_CHUNKS) return false
      chunks.forEach(queue::addLast)
    }
    pumpClient(address, gatt)
    return true
  }

  @SuppressLint("MissingPermission")
  private fun pumpClient(address: String, gatt: BluetoothGatt) {
    val queue = clientQueues[address] ?: return
    val chunk: ByteArray
    synchronized(queue) {
      if (!clientInFlight.add(address)) return
      val next = queue.peekFirst()
      if (next == null) { clientInFlight.remove(address); return }
      chunk = next
    }
    val characteristic = gatt.getService(serviceUuid.uuid)?.getCharacteristic(dataUuid.uuid)
    if (characteristic == null) { completeClientWrite(address, false); return }
    characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
    characteristic.value = chunk
    val started = try { gatt.writeCharacteristic(characteristic) } catch (_: Exception) { false }
    if (!started) completeClientWrite(address, false)
  }

  private fun completeClientWrite(address: String, success: Boolean) {
    val queue = clientQueues[address]
    if (queue != null) synchronized(queue) { if (queue.isNotEmpty()) queue.removeFirst() }
    clientInFlight.remove(address)
    if (!success) onLog("transport_error", "فشل إرسال جزء من إطار BLE")
    val gatt = gattByAddress[address] ?: return
    pumpClient(address, gatt)
  }

  private fun enqueueNotification(peerId: String, device: BluetoothDevice?, payload: ByteArray, mtu: Int): Boolean {
    if (device == null || !notificationEnabled.contains(device.address)) return false
    val chunks = fragment(payload, mtu)
    if (chunks.isEmpty()) return false
    val queue = notificationQueues.computeIfAbsent(device.address) { ArrayDeque() }
    synchronized(queue) {
      if (queue.size + chunks.size > MAX_QUEUED_CHUNKS) return false
      chunks.forEach(queue::addLast)
    }
    pumpNotification(device.address, device)
    return true
  }

  @SuppressLint("MissingPermission")
  private fun pumpNotification(address: String, device: BluetoothDevice) {
    val queue = notificationQueues[address] ?: return
    val chunk: ByteArray
    synchronized(queue) {
      if (!notificationInFlight.add(address)) return
      val next = queue.peekFirst()
      if (next == null) { notificationInFlight.remove(address); return }
      chunk = next
    }
    val gattServer = server
    val characteristic = gattServer?.getService(serviceUuid.uuid)?.getCharacteristic(dataUuid.uuid)
    if (gattServer == null || characteristic == null) { completeNotification(address, false); return }
    val started = try {
      if (Build.VERSION.SDK_INT >= 33) {
        gattServer.notifyCharacteristicChanged(device, characteristic, false, chunk) == BluetoothStatusCodes.SUCCESS
      } else {
        @Suppress("DEPRECATION")
        run { characteristic.value = chunk; gattServer.notifyCharacteristicChanged(device, characteristic, false) }
      }
    } catch (_: Exception) { false }
    if (!started) completeNotification(address, false)
  }

  private fun completeNotification(address: String, success: Boolean) {
    val queue = notificationQueues[address]
    if (queue != null) synchronized(queue) { if (queue.isNotEmpty()) queue.removeFirst() }
    notificationInFlight.remove(address)
    if (!success) onLog("transport_error", "فشل إرسال إشعار GATT")
    val nodeId = addressToNode[address] ?: return
    val device = serverDeviceByNode[nodeId] ?: return
    pumpNotification(address, device)
  }

  @SuppressLint("MissingPermission")
  private fun prunePeers() {
    val now = System.currentTimeMillis()
    val expired = lastSeen.filterValues { now - it > PEER_TIMEOUT_MS }.keys
    for (address in expired) {
      lastSeen.remove(address)
      val device = deviceByAddress.remove(address)
      val nodeId = addressToNode.remove(address)
      if (nodeId != null) {
        nodeToAddress.remove(nodeId, address)
        serverDeviceByNode.remove(nodeId)
        onPeerLost(nodeId)
      }
      if (device != null) try { server?.cancelConnection(device) } catch (_: Exception) { }
      try { gattByAddress.remove(address)?.disconnect() } catch (_: Exception) { }
      clearAssemblies(address)
    }
  }

  private fun helloFrame() = HELLO_PREFIX + localId

  private companion object {
    const val HELLO_PREFIX = "JESR_HELLO:"
    const val FRAME_MAGIC_1: Byte = 0x4a
    const val FRAME_MAGIC_2: Byte = 0x53
    const val FRAME_HEADER_BYTES = 8
    const val MAX_FRAME_COUNT = 1_024
    const val MAX_APPLICATION_BYTES = 8 * 1024
    const val MAX_QUEUED_CHUNKS = 2_048
    const val DEFAULT_MTU = 23
    const val PEER_TIMEOUT_MS = 90_000L
    const val FRAME_TIMEOUT_MS = 15_000L
    val NODE_ID_PATTERN = Regex("[0-9a-fA-F-]{16,64}")
  }
}
