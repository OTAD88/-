package com.jesr.network

import org.json.JSONArray
import org.json.JSONObject
import java.util.LinkedHashMap
import java.util.UUID
import kotlin.math.max

internal enum class MeshTransportKind(val wireName: String) {
  BLE("ble"), WIFI_DIRECT("wifi-direct")
}

internal data class MeshLink(
  val peerId: String,
  val transport: MeshTransportKind,
  val quality: Int,
  val lossPercent: Int,
  val latencyMs: Int?,
  val stability: Double,
  val rssiDbm: Int?,
  val qualityMeasured: Boolean = false,
  val lossMeasured: Boolean = false,
  val stabilityMeasured: Boolean = false,
  val lastSeenAt: Long = System.currentTimeMillis()
)

internal data class MeshRoute(
  val destinationId: String,
  val nextHopId: String,
  val hops: Int,
  val quality: Int,
  val lossPercent: Int,
  val latencyMs: Int?,
  val stability: Double,
  val score: Double,
  val qualityMeasured: Boolean,
  val lossMeasured: Boolean,
  val stabilityMeasured: Boolean,
  val lastUpdatedAt: Long
)

/** App-level diagnostic router. It does not implement the Bluetooth Mesh standard. */
internal class MeshRouter(
  private val localId: String,
  private val transmitter: (String, MeshTransportKind, String) -> Boolean,
  private val eventSink: (Map<String, Any?>) -> Unit,
  /** Receives the opaque app envelope of a `data` packet addressed to one of [aliases]. */
  private val dataSink: (envelope: String, sourceNodeId: String) -> Unit = { _, _ -> }
) {
  /** Extra destination IDs (the Jesr ID) this node accepts `data` packets for. */
  @Volatile var aliases: Set<String> = emptySet()

  private data class PendingPing(
    val rootId: String,
    val targetId: String,
    val startedAt: Long,
    val expiresAt: Long,
    var attempts: Int = 0,
    var nextAttemptAt: Long = 0L,
    var finalAckDeadlineAt: Long = expiresAt
  )

  private data class QueuedFrame(
    val peerId: String,
    val transport: MeshTransportKind,
    val payload: String,
    val packetId: String
  )

  private val lock = Any()
  private val links = linkedMapOf<String, MeshLink>()
  private val routes = linkedMapOf<String, MeshRoute>()
  private val knownNodes = linkedMapOf<String, Long>()
  private val seenPackets = object : LinkedHashMap<String, Long>(128, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?): Boolean = size > MAX_SEEN
  }
  private val pendingPackets = ArrayDeque<JSONObject>()
  private val pendingPings = linkedMapOf<String, PendingPing>()
  private val pingRootByAttempt = linkedMapOf<String, String>()
  private val outgoingFrames = ArrayDeque<QueuedFrame>()
  private val log = ArrayDeque<Map<String, Any?>>()
  private var eventSequence = 0L
  private var rateWindowStartedAt = 0L
  private var framesSentInWindow = 0

  init {
    knownNodes[localId] = System.currentTimeMillis()
  }

  fun updateLink(link: MeshLink) {
    synchronized(lock) {
      val previous = links.put(link.peerId, link)
      knownNodes[link.peerId] = link.lastSeenAt
      routes[link.peerId] = makeRoute(link.peerId, link.peerId, 1, link)
      if (previous == null) emit("peer_discovered", "تم اكتشاف جار مباشر ${short(link.peerId)}", nodeId = link.peerId)
      flushQueueLocked()
      drainOutboxLocked(System.currentTimeMillis())
      publishStateLocked()
    }
  }

  fun removeLink(peerId: String) {
    synchronized(lock) {
      if (links.remove(peerId) == null) return
      routes.entries.removeAll { it.value.nextHopId == peerId }
      outgoingFrames.removeAll { it.peerId == peerId }
      emit("peer_lost", "انقطع الاتصال المباشر مع ${short(peerId)}", nodeId = peerId)
      publishStateLocked()
    }
  }

  fun clearLinks() {
    synchronized(lock) {
      links.clear()
      routes.clear()
      outgoingFrames.clear()
      pendingPackets.clear()
      pendingPings.clear()
      pingRootByAttempt.clear()
      knownNodes.entries.removeAll { it.key != localId }
      emit("network_stopped", "أُوقفت اتصالات الشبكة المحلية")
      publishStateLocked()
    }
  }

  fun ping(targetId: String): String {
    require(targetId.isNotBlank() && targetId != localId) { "الوجهة غير صالحة" }
    synchronized(lock) {
      pruneLocked(System.currentTimeMillis())
      if (pendingPings.size >= MAX_PENDING_PINGS) throw IllegalStateException("امتلأ حد اختبارات Ping المعلقة")
      val now = System.currentTimeMillis()
      val rootId = UUID.randomUUID().toString()
      val pending = PendingPing(rootId, targetId, now, now + PACKET_TTL_MS)
      pendingPings[rootId] = pending
      emit("ping_started", "أُرسل Test Ping إلى ${short(targetId)}", rootId, targetId)
      sendPingAttemptLocked(pending, now)
      publishStateLocked()
      return rootId
    }
  }

  /**
   * Sends an opaque Jesr envelope towards [targetJesrId]. Relays see only the packet header.
   * Returns true iff at least one live link accepted the frame (never means delivered);
   * when false nothing is queued here — the JS engine's persistent outbox retries.
   */
  fun sendData(targetJesrId: String, envelope: String): Boolean {
    require(targetJesrId.isNotBlank() && targetJesrId !in aliases) { "الوجهة غير صالحة" }
    require(envelope.length <= MAX_DATA_CHARS) { "الرسالة أكبر من الحد المسموح" }
    synchronized(lock) {
      val now = System.currentTimeMillis()
      pruneLocked(now)
      val id = UUID.randomUUID().toString()
      val expires = now + DATA_LIFETIME_MS
      val packet = JSONObject()
        .put("id", id)
        .put("kind", "data")
        .put("sourceId", localId)
        .put("targetId", targetJesrId)
        .put("createdAt", now)
        .put("expiresAt", expires)
        .put("ttl", MAX_HOPS)
        .put("hops", 0)
        .put("path", JSONArray().put(localId))
        .put("payload", JSONObject().put("envelope", envelope))
      seenPackets[id] = expires
      val sent = sendLocked(packet, null)
      publishStateLocked()
      return sent
    }
  }

  fun tick() {
    synchronized(lock) {
      val now = System.currentTimeMillis()
      pruneLocked(now)
      drainOutboxLocked(now)
      val finished = mutableListOf<String>()
      for (pending in pendingPings.values.toList()) {
        if (now >= pending.finalAckDeadlineAt) {
          finished += pending.rootId
          removeQueuedPingLocked(pending.rootId)
          emit("routing_failed", "انتهت مهلة Test Ping دون تأكيد بعد ${pending.attempts} محاولات", pending.rootId, pending.targetId)
          continue
        }
        if (pending.attempts < MAX_PING_ATTEMPTS && now >= pending.nextAttemptAt) {
          emit("ping_retry", "إعادة محاولة Test Ping (${pending.attempts + 1}/$MAX_PING_ATTEMPTS)", pending.rootId, pending.targetId)
          sendPingAttemptLocked(pending, now)
        }
      }
      finished.forEach { pendingPings.remove(it) }
      if (finished.isNotEmpty()) pingRootByAttempt.entries.removeAll { it.value in finished }
      publishStateLocked()
    }
  }

  fun receive(raw: String, ingressPeerId: String, transport: MeshTransportKind) {
    if (raw.length > MAX_PACKET_BYTES) {
      synchronized(lock) { emit("routing_failed", "حزمة أكبر من الحد المسموح", nodeId = ingressPeerId) }
      return
    }
    val packet = try { JSONObject(raw) } catch (_: Exception) {
      synchronized(lock) { emit("routing_failed", "تعذر تحليل حزمة التشخيص", nodeId = ingressPeerId) }
      return
    }
    synchronized(lock) {
      val now = System.currentTimeMillis()
      pruneLocked(now)
      val id = packet.optString("id")
      val source = packet.optString("sourceId")
      val target = packet.optString("targetId")
      val ttl = packet.optInt("ttl", -1)
      val expiry = packet.optLong("expiresAt", 0L)
      val path = packet.optJSONArray("path") ?: JSONArray()
      val validPath = path.length() in 1..MAX_HOPS && path.optString(0) == source &&
        (0 until path.length()).all { path.optString(it).isNotBlank() }
      val validKind = packet.optString("kind") in setOf("ping", "ack", "route", "data")
      val dataEnvelope = packet.optJSONObject("payload")?.optString("envelope").orEmpty()
      val validData = packet.optString("kind") != "data" || (dataEnvelope.isNotEmpty() && dataEnvelope.length <= MAX_DATA_CHARS)
      val reportedPingPath = packet.optJSONArray("pingPath")
      val validReplyTo = packet.optString("kind") != "ack" || packet.optString("replyTo").isNotBlank()
      val validPingPath = when {
        reportedPingPath == null -> true
        packet.optString("kind") != "ack" -> false
        else -> reportedPingPath.length() in 2..(MAX_HOPS + 1) &&
          reportedPingPath.optString(0) == target &&
          reportedPingPath.optString(reportedPingPath.length() - 1) == source &&
          (0 until reportedPingPath.length()).all { reportedPingPath.optString(it).isNotBlank() }
      }
      if (id.isBlank() || source.isBlank() || target.isBlank() || id.length > MAX_ID_LENGTH ||
        source.length > MAX_ID_LENGTH || target.length > MAX_ID_LENGTH || ttl !in 0..MAX_HOPS ||
        expiry <= now || expiry > now + MAX_PACKET_AGE_MS || !validPath || !validKind || !validData || !validReplyTo || !validPingPath) {
        emit("routing_failed", "رُفضت حزمة غير صالحة أو منتهية", packetId = id.takeIf { it.isNotBlank() })
        return
      }
      val currentIngress = links[ingressPeerId]
      if (currentIngress == null || currentIngress.transport != transport) {
        emit("routing_failed", "رُفضت حزمة من جار غير متصل عبر هذه القناة", packetId = id)
        return
      }
      if (path.optString(path.length() - 1) != ingressPeerId || (0 until path.length()).map { path.optString(it) }.toSet().size != path.length()) {
        emit("routing_failed", "رُفضت الحزمة لأن مسارها لا يطابق الجار أو يحتوي حلقة", packetId = id)
        return
      }
      val ingress = currentIngress.copy(lastSeenAt = now)
      links[ingressPeerId] = ingress
      knownNodes[ingressPeerId] = now
      routes[ingressPeerId] = makeRoute(ingressPeerId, ingressPeerId, 1, ingress, now)
      if (seenPackets.containsKey(id)) {
        publishStateLocked()
        return
      }
      if (contains(path, localId)) {
        publishStateLocked()
        return
      }
      seenPackets[id] = expiry
      if (packet.optString("kind") == "ack") removeQueuedPacketLocked(packet.optString("replyTo"))
      learnReverseRoutesLocked(path, ingress, now)
      flushQueueLocked()
      val arrivedPath = JSONArray(path.toString()).put(localId)
      val kind = packet.optString("kind")
      val forwarded = JSONObject(packet.toString())
        .put("ttl", ttl - 1)
        .put("hops", packet.optInt("hops", 0) + 1)
        .put("path", arrivedPath)

      if (kind == "data" && target in aliases) {
        emit("packet_delivered", "وصلت رسالة بيانات إلى هذا الجهاز", id, source, jsonPath(arrivedPath))
        publishStateLocked()
        // The sink only hands the opaque envelope to JS (Expo event); it must not call back into the router synchronously.
        try { dataSink(dataEnvelope, source) } catch (_: Exception) { }
        return
      }
      if (target == localId) {
        emit("packet_delivered", "وصلت ${if (kind == "ping") "حزمة Ping" else "استجابة"} إلى هذا الجهاز", id, source, jsonPath(arrivedPath))
        when (kind) {
          "ping" -> answerPingLocked(forwarded)
          "ack" -> {
            val repliedTo = packet.optString("replyTo")
            val rootId = pingRootByAttempt.remove(repliedTo)
            val pending = rootId?.let { pendingPings.remove(it) }
            val rtt = pending?.let { max(0L, now - it.startedAt) }
            if (pending != null) {
              removeQueuedPingLocked(pending.rootId)
              pingRootByAttempt.entries.removeAll { it.value == pending.rootId }
              emit("ping_ack", "وصل التأكيد خلال ${rtt} ms", pending.rootId, source, jsonPath(packet.optJSONArray("pingPath") ?: arrivedPath), rtt?.toInt())
            } else {
              emit("late_ack", "وصل ACK بعد انتهاء متابعة نتيجة Ping", repliedTo, source, jsonPath(packet.optJSONArray("pingPath") ?: arrivedPath))
            }
          }
        }
        publishStateLocked()
        return
      }
      if (ttl <= 1) {
        emit("routing_failed", "انتهى حد القفزات قبل الوصول", id, target)
        return
      }
      sendLocked(forwarded, ingressPeerId)
    }
  }

  fun snapshot(): Map<String, Any?> = synchronized(lock) {
    pruneLocked(System.currentTimeMillis())
    stateMapLocked()
  }

  private fun sendPingAttemptLocked(pending: PendingPing, now: Long) {
    if (pending.attempts >= MAX_PING_ATTEMPTS) return
    pending.attempts++
    val attemptId = UUID.randomUUID().toString()
    pingRootByAttempt[attemptId] = pending.rootId
    val packet = JSONObject()
      .put("id", attemptId)
      .put("kind", "ping")
      .put("sourceId", localId)
      .put("targetId", pending.targetId)
      .put("attemptRootId", pending.rootId)
      .put("createdAt", now)
      .put("expiresAt", pending.expiresAt)
      .put("ttl", MAX_HOPS)
      .put("hops", 0)
      .put("path", JSONArray().put(localId))
      .put("payload", JSONObject().put("label", "Jesr diagnostic ping"))
    seenPackets[attemptId] = pending.expiresAt
    pending.nextAttemptAt = now + RETRY_INTERVAL_MS * pending.attempts
    if (pending.attempts >= MAX_PING_ATTEMPTS) {
      pending.finalAckDeadlineAt = minOf(pending.expiresAt, now + PING_FINAL_ACK_GRACE_MS)
    }
    sendLocked(packet, null)
  }

  private fun answerPingLocked(ping: JSONObject) {
    val now = System.currentTimeMillis()
    val source = ping.optString("sourceId")
    val packetId = UUID.randomUUID().toString()
    val ack = JSONObject()
      .put("id", packetId)
      .put("kind", "ack")
      .put("sourceId", localId)
      .put("targetId", source)
      .put("replyTo", ping.optString("id"))
      .put("createdAt", now)
      .put("expiresAt", minOf(ping.optLong("expiresAt"), now + PACKET_TTL_MS))
      .put("ttl", MAX_HOPS)
      .put("hops", 0)
      .put("path", JSONArray().put(localId))
      .put("pingPath", JSONArray(ping.optJSONArray("path")?.toString() ?: "[]"))
    seenPackets[packetId] = ack.optLong("expiresAt")
    sendLocked(ack, null)
  }

  private fun sendLocked(packet: JSONObject, ingressPeerId: String?): Boolean {
    val target = packet.optString("targetId")
    val visited = packet.optJSONArray("path") ?: JSONArray()
    val route = routes[target]
    if (route != null && route.nextHopId != ingressPeerId && !contains(visited, route.nextHopId)) {
      val link = links[route.nextHopId]
      if (link != null && transmitLocked(link, packet.toString(), packet.optString("id"))) {
        emit("packet_forwarded", "وُجهت الحزمة إلى القفزة التالية", packet.optString("id"), target, jsonPath(visited))
        return true
      }
      routes.remove(target)
    }

    val eligible = links.values.filter { it.peerId != ingressPeerId && !contains(visited, it.peerId) }
    val fanout = eligible.take(MAX_FLOOD_FANOUT)
    var sent = 0
    for (link in fanout) {
      if (transmitLocked(link, packet.toString(), packet.optString("id"))) sent++
    }
    if (eligible.size > fanout.size) emit("congestion_control", "حُدّ انتشار الحزمة إلى $MAX_FLOOD_FANOUT جيران", packet.optString("id"), target)
    if (sent > 0) {
      if (packet.optString("kind") == "ping" && routes[target] == null) queuePacketLocked(packet)
      emit("packet_forwarded", "لا يوجد مسار مؤكد؛ نُشرت الحزمة ضمن حد القفزات", packet.optString("id"), target, jsonPath(visited))
      return true
    }
    // `data` is never queued here: the engine's persistent outbox owns store-and-forward and retries.
    if (packet.optString("kind") != "data") queuePacketLocked(packet)
    return false
  }

  private fun transmitLocked(link: MeshLink, payload: String, packetId: String): Boolean {
    val now = System.currentTimeMillis()
    if (now - rateWindowStartedAt >= RATE_WINDOW_MS) {
      rateWindowStartedAt = now
      framesSentInWindow = 0
    }
    if (framesSentInWindow < MAX_FRAMES_PER_WINDOW) {
      if (transmitter(link.peerId, link.transport, payload)) {
        framesSentInWindow++
        return true
      }
      return false
    }
    if (outgoingFrames.size >= MAX_OUTBOX) {
      emit("routing_failed", "امتلأ طابور إرسال الازدحام", packetId, link.peerId)
      return false
    }
    if (outgoingFrames.none { it.peerId == link.peerId && it.packetId == packetId }) {
      outgoingFrames.addLast(QueuedFrame(link.peerId, link.transport, payload, packetId))
    }
    emit("congestion_control", "أُدرج إطار في طابور إرسال محدود", packetId, link.peerId)
    return true
  }

  private fun drainOutboxLocked(now: Long) {
    if (now - rateWindowStartedAt >= RATE_WINDOW_MS) {
      rateWindowStartedAt = now
      framesSentInWindow = 0
    }
    while (outgoingFrames.isNotEmpty() && framesSentInWindow < MAX_FRAMES_PER_WINDOW) {
      val frame = outgoingFrames.removeFirst()
      val link = links[frame.peerId]
      if (link == null) continue
      if (transmitter(link.peerId, link.transport, frame.payload)) framesSentInWindow++
      else emit("routing_failed", "تعذر إرسال إطار محفوظ إلى الجار", frame.packetId, frame.peerId)
    }
  }

  private fun queuePacketLocked(packet: JSONObject) {
    if (packet.optLong("expiresAt") <= System.currentTimeMillis()) return
    val rootId = packet.optString("attemptRootId").ifBlank { packet.optString("id") }
    val iterator = pendingPackets.iterator()
    while (iterator.hasNext()) {
      val queued = iterator.next()
      if (queued.optString("attemptRootId").ifBlank { queued.optString("id") } == rootId) iterator.remove()
    }
    if (pendingPackets.size >= MAX_QUEUE) pendingPackets.removeFirst()
    pendingPackets.addLast(JSONObject(packet.toString()))
    emit("queue_stored", "حُفظت حزمة التشخيص مؤقتًا بانتظار وصلة، بعمر محدود", packet.optString("id"), packet.optString("targetId"))
  }

  private fun removeQueuedPingLocked(rootId: String) {
    removeQueuedPacketLocked(rootId)
    val attemptIds = pingRootByAttempt.filterValues { it == rootId }.keys
    outgoingFrames.removeAll { it.packetId in attemptIds }
  }

  private fun removeQueuedPacketLocked(packetId: String) {
    if (packetId.isBlank()) return
    val iterator = pendingPackets.iterator()
    while (iterator.hasNext()) {
      val packet = iterator.next()
      if (packet.optString("id") == packetId || packet.optString("attemptRootId") == packetId) iterator.remove()
    }
    outgoingFrames.removeAll { it.packetId == packetId }
  }

  private fun learnReverseRoutesLocked(path: JSONArray, ingress: MeshLink, now: Long) {
    for (index in 0 until path.length()) {
      val destination = path.optString(index)
      if (destination.isBlank() || destination == localId) continue
      val hops = path.length() - index
      val candidate = makeRoute(destination, ingress.peerId, hops, ingress, now)
      val previous = routes[destination]
      if (previous == null || candidate.score < previous.score || previous.nextHopId == ingress.peerId) {
        val changed = previous == null || previous.nextHopId != candidate.nextHopId || previous.hops != candidate.hops
        routes[destination] = candidate
        knownNodes[destination] = now
        if (changed) emit("route_changed", "تحديث المسار إلى ${short(destination)}: $hops قفزات", nodeId = destination)
      }
    }
  }

  private fun makeRoute(destination: String, nextHop: String, hops: Int, link: MeshLink, at: Long = System.currentTimeMillis()) = MeshRoute(
    destinationId = destination,
    nextHopId = nextHop,
    hops = hops,
    quality = link.quality,
    lossPercent = link.lossPercent,
    latencyMs = link.latencyMs,
    stability = link.stability,
    score = routeScore(hops, link),
    qualityMeasured = link.qualityMeasured,
    lossMeasured = link.lossMeasured,
    stabilityMeasured = link.stabilityMeasured,
    lastUpdatedAt = at
  )

  private fun routeScore(hops: Int, link: MeshLink): Double {
    val qualityPenalty = if (link.qualityMeasured) (100 - link.quality) * 1.5 else 0.0
    val lossPenalty = if (link.lossMeasured) link.lossPercent * 2.0 else 0.0
    val latencyPenalty = link.latencyMs?.coerceAtLeast(0)?.div(20.0) ?: 0.0
    val stabilityPenalty = if (link.stabilityMeasured) (1.0 - link.stability) * 30.0 else 0.0
    val rssiPenalty = link.rssiDbm?.let { ((-40 - it).coerceIn(0, 60)) * 0.5 } ?: 0.0
    return hops * 100.0 + qualityPenalty + lossPenalty + latencyPenalty + stabilityPenalty + rssiPenalty
  }

  private fun flushQueueLocked() {
    val now = System.currentTimeMillis()
    val count = pendingPackets.size
    repeat(count) {
      val item = pendingPackets.removeFirst()
      if (item.optLong("expiresAt") <= now) {
        emit("queue_expired", "انتهت صلاحية حزمة في الطابور", item.optString("id"))
      } else if (links.isEmpty()) {
        pendingPackets.addLast(item)
      } else {
        sendLocked(item, null)
      }
    }
  }

  private fun pruneLocked(now: Long) {
    val iterator = seenPackets.entries.iterator()
    while (iterator.hasNext()) if (iterator.next().value <= now) iterator.remove()
    val count = pendingPackets.size
    repeat(count) {
      val packet = pendingPackets.removeFirst()
      if (packet.optLong("expiresAt") <= now) emit("queue_expired", "انتهت صلاحية حزمة في الطابور", packet.optString("id"))
      else pendingPackets.addLast(packet)
    }
    knownNodes.entries.removeAll { it.key != localId && now - it.value > NODE_RETENTION_MS && !links.containsKey(it.key) }
  }

  private fun publishStateLocked() = eventSink(stateMapLocked())

  private fun stateMapLocked(): Map<String, Any?> = mapOf(
    "available" to true,
    "active" to true,
    "localId" to localId,
    "transportState" to if (links.isEmpty()) "searching" else "connected",
    "batteryMode" to "balanced",
    "peers" to links.values.map { link ->
      mapOf(
        "id" to link.peerId,
        "transport" to link.transport.wireName,
        "direct" to true,
        "quality" to link.quality,
        "qualityMeasured" to link.qualityMeasured,
        "lossPercent" to link.lossPercent,
        "lossMeasured" to link.lossMeasured,
        "latencyMs" to link.latencyMs,
        "stability" to link.stability,
        "stabilityMeasured" to link.stabilityMeasured,
        "rssiDbm" to link.rssiDbm,
        "lastSeenAt" to link.lastSeenAt,
        "connected" to true
      )
    },
    "routes" to routes.values.sortedWith(compareBy<MeshRoute> { it.hops }.thenBy { it.score }).map { route ->
      mapOf(
        "destinationId" to route.destinationId,
        "nextHopId" to route.nextHopId,
        "hops" to route.hops,
        "quality" to route.quality,
        "qualityMeasured" to route.qualityMeasured,
        "lossPercent" to route.lossPercent,
        "lossMeasured" to route.lossMeasured,
        "latencyMs" to route.latencyMs,
        "stability" to route.stability,
        "stabilityMeasured" to route.stabilityMeasured,
        "lastUpdatedAt" to route.lastUpdatedAt
      )
    },
    "pendingPackets" to pendingPackets.size + outgoingFrames.size,
    "events" to log.toList().asReversed()
  )

  private fun emit(kind: String, message: String, packetId: String? = null, nodeId: String? = null, path: List<String>? = null, rttMs: Int? = null) {
    eventSequence++
    val event = mutableMapOf<String, Any?>(
      "id" to "e-$eventSequence",
      "at" to System.currentTimeMillis(),
      "kind" to kind,
      "message" to message
    )
    if (packetId != null) event["packetId"] = packetId
    if (nodeId != null) event["nodeId"] = nodeId
    if (path != null) event["path"] = path
    if (rttMs != null) event["rttMs"] = rttMs
    log.addLast(event)
    while (log.size > MAX_LOG) log.removeFirst()
    eventSink(event)
  }

  private fun contains(array: JSONArray, value: String): Boolean = (0 until array.length()).any { array.optString(it) == value }
  private fun jsonPath(array: JSONArray): List<String> = (0 until array.length()).map { array.optString(it) }
  private fun short(id: String) = if (id.length > 8) id.take(5) + "…" + id.takeLast(2) else id

  companion object {
    const val MAX_HOPS = 8
    const val MAX_QUEUE = 128
    const val MAX_PENDING_PINGS = 64
    const val MAX_PACKET_BYTES = 8 * 1024
    const val MAX_DATA_CHARS = 4 * 1024
    const val DATA_LIFETIME_MS = 600_000L
    const val PACKET_TTL_MS = 120_000L
    const val MAX_PACKET_AGE_MS = 86_400_000L
    const val NODE_RETENTION_MS = 120_000L
    const val MAX_SEEN = 2_048
    const val MAX_PING_ATTEMPTS = 3
    const val RETRY_INTERVAL_MS = 2_000L
    const val PING_FINAL_ACK_GRACE_MS = 10_000L
    const val MAX_FLOOD_FANOUT = 8
    const val MAX_OUTBOX = 64
    const val MAX_FRAMES_PER_WINDOW = 12
    const val RATE_WINDOW_MS = 1_000L
    const val MAX_LOG = 100
    private const val MAX_ID_LENGTH = 128
  }
}
