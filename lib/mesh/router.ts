export type LinkType = "ble" | "wifi-direct";
export type PacketKind = "ping" | "ack" | "route" | "data";

export interface LinkMetrics {
  peerId: string;
  type: LinkType;
  quality: number;
  lossPercent: number;
  latencyMs: number | null;
  stability: number;
  qualityMeasured?: boolean;
  lossMeasured?: boolean;
  stabilityMeasured?: boolean;
  rssiDbm?: number;
  lastSeenAt: number;
}

export interface MeshPacket {
  id: string;
  kind: PacketKind;
  sourceId: string;
  targetId: string;
  replyTo?: string;
  createdAt: number;
  expiresAt: number;
  ttl: number;
  hops: number;
  path: string[];
  pingPath?: string[];
  payload?: { label?: string; envelope?: string };
}

export interface MeshRoute {
  destinationId: string;
  nextHopId: string;
  hops: number;
  score: number;
  quality: number;
  qualityMeasured: boolean;
  lossPercent: number;
  lossMeasured: boolean;
  latencyMs: number | null;
  stability: number;
  stabilityMeasured: boolean;
  lastUpdatedAt: number;
}

export interface MeshEvent {
  id: string;
  at: number;
  kind:
    | "peer_discovered"
    | "peer_lost"
    | "route_changed"
    | "packet_forwarded"
    | "packet_delivered"
    | "ping_ack"
    | "routing_failed"
    | "queue_stored"
    | "queue_expired";
  message: string;
  packetId?: string;
  nodeId?: string;
  path?: string[];
}

export interface Transmission {
  peerId: string;
  packet: MeshPacket;
}

export interface RouterOptions {
  now?: () => number;
  packetId?: () => string;
  ttl?: number;
  maxQueueItems?: number;
  packetLifetimeMs?: number;
  maxEvents?: number;
}

const DEFAULT_TTL = 8;
const DEFAULT_QUEUE = 128;
const DEFAULT_LIFETIME_MS = 120_000;
const DEFAULT_MAX_EVENTS = 100;
const MAX_DEDUPE_IDS = 2_048;
const LINK_TIMEOUT_MS = 30_000;
const MAX_DATA_BYTES = 4 * 1024;
const DATA_LIFETIME_MS = 600_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function randomId(): string {
  const bytes = Array.from({ length: 12 }, () => Math.floor(Math.random() * 256));
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function routeCost(hops: number, metrics: LinkMetrics): number {
  const qualityPenalty = metrics.qualityMeasured ? (100 - metrics.quality) * 1.5 : 0;
  const lossPenalty = metrics.lossMeasured ? metrics.lossPercent * 2 : 0;
  const latencyPenalty = metrics.latencyMs === null ? 0 : Math.max(0, metrics.latencyMs) / 20;
  const stabilityPenalty = metrics.stabilityMeasured ? (1 - metrics.stability) * 30 : 0;
  const rssiPenalty = metrics.rssiDbm === undefined ? 0 : Math.min(60, Math.max(0, -40 - metrics.rssiDbm)) * 0.5;
  return hops * 100 + qualityPenalty + lossPenalty + latencyPenalty + stabilityPenalty + rssiPenalty;
}

/** Deterministic hop-by-hop mesh model used by the native protocol contract and tests. */
export class MeshRouter {
  readonly localId: string;
  private readonly now: () => number;
  private readonly packetId: () => string;
  private readonly ttl: number;
  private readonly maxQueueItems: number;
  private readonly packetLifetimeMs: number;
  private readonly maxEvents: number;
  private readonly links = new Map<string, LinkMetrics>();
  private readonly routes = new Map<string, MeshRoute>();
  private readonly knownNodes = new Map<string, number>();
  private readonly dedupe = new Map<string, number>();
  private readonly pending: Array<{ packet: MeshPacket; queuedAt: number }> = [];
  private readonly events: MeshEvent[] = [];
  private readonly pingStarted = new Map<string, number>();
  private readonly aliases = new Set<string>();
  private readonly deliveries: Array<{ packet: MeshPacket; ingressPeerId: string }> = [];
  private eventCounter = 0;

  constructor(localId: string, options: RouterOptions = {}) {
    if (!localId.trim()) throw new Error("localId is required");
    this.localId = localId;
    this.now = options.now ?? Date.now;
    this.packetId = options.packetId ?? randomId;
    this.ttl = clamp(options.ttl ?? DEFAULT_TTL, 1, 32);
    this.maxQueueItems = clamp(options.maxQueueItems ?? DEFAULT_QUEUE, 1, 1_024);
    this.packetLifetimeMs = clamp(options.packetLifetimeMs ?? DEFAULT_LIFETIME_MS, 1_000, 86_400_000);
    this.maxEvents = clamp(options.maxEvents ?? DEFAULT_MAX_EVENTS, 10, 1_000);
    this.knownNodes.set(localId, this.now());
  }

  observeLink(metrics: LinkMetrics): Transmission[] {
    const normalized: LinkMetrics = {
      ...metrics,
      quality: clamp(metrics.quality, 0, 100),
      lossPercent: clamp(metrics.lossPercent, 0, 100),
      stability: clamp(metrics.stability, 0, 1),
      qualityMeasured: metrics.qualityMeasured ?? false,
      lossMeasured: metrics.lossMeasured ?? false,
      stabilityMeasured: metrics.stabilityMeasured ?? false,
      latencyMs: metrics.latencyMs === null ? null : Math.max(0, metrics.latencyMs),
    };
    const wasKnown = this.links.has(metrics.peerId);
    this.links.set(metrics.peerId, normalized);
    this.knownNodes.set(metrics.peerId, normalized.lastSeenAt);
    this.setRoute({
      destinationId: metrics.peerId,
      nextHopId: metrics.peerId,
      hops: 1,
      score: routeCost(1, normalized),
      quality: normalized.quality,
      qualityMeasured: normalized.qualityMeasured ?? false,
      lossPercent: normalized.lossPercent,
      lossMeasured: normalized.lossMeasured ?? false,
      latencyMs: normalized.latencyMs,
      stability: normalized.stability,
      stabilityMeasured: normalized.stabilityMeasured ?? false,
      lastUpdatedAt: normalized.lastSeenAt,
    });
    if (!wasKnown) this.addEvent("peer_discovered", `تم اكتشاف جار مباشر ${metrics.peerId}`, { nodeId: metrics.peerId });
    return this.flushQueue();
  }

  removeLink(peerId: string): void {
    if (!this.links.delete(peerId)) return;
    this.knownNodes.delete(peerId);
    for (const [destinationId, route] of this.routes) {
      if (route.nextHopId === peerId) this.routes.delete(destinationId);
    }
    this.addEvent("peer_lost", `انقطع الاتصال المباشر مع ${peerId}`, { nodeId: peerId });
  }

  /** Extra destination IDs (e.g. the Jesr ID) that this node accepts `data` packets for. */
  setAliases(ids: string[]): void {
    this.aliases.clear();
    for (const id of ids) if (id) this.aliases.add(id);
  }

  /** Hand-off of `data` packets addressed to this node; the app layer (JesrEngine) consumes them. */
  takeDeliveries(): Array<{ packet: MeshPacket; ingressPeerId: string }> {
    return this.deliveries.splice(0);
  }

  /**
   * Sends an opaque app envelope towards `targetId` (a Jesr ID). Relays only see the
   * packet header; with no known route it is limited-flooded and stored until it expires.
   */
  sendData(targetId: string, envelope: string, lifetimeMs = DATA_LIFETIME_MS): Transmission[] {
    if (!targetId || this.aliases.has(targetId) || targetId === this.localId) throw new Error("target must be another node");
    if (envelope.length > MAX_DATA_BYTES) throw new Error("payload too large");
    const now = this.now();
    const packet: MeshPacket = {
      id: this.packetId(), kind: "data", sourceId: this.localId, targetId,
      createdAt: now, expiresAt: now + clamp(lifetimeMs, 1_000, 86_400_000 - 1_000),
      ttl: this.ttl, hops: 0, path: [this.localId], payload: { envelope },
    };
    this.rememberPacket(packet.id, packet.expiresAt);
    return this.forward(packet, undefined);
  }

  sendPing(targetId: string): Transmission[] {
    const now = this.now();
    if (!targetId || targetId === this.localId) throw new Error("target must be another node");
    const packet: MeshPacket = {
      id: this.packetId(),
      kind: "ping",
      sourceId: this.localId,
      targetId,
      createdAt: now,
      expiresAt: now + this.packetLifetimeMs,
      ttl: this.ttl,
      hops: 0,
      path: [this.localId],
      payload: { label: "Jesr diagnostic ping" },
    };
    this.pingStarted.set(packet.id, now);
    this.rememberPacket(packet.id, packet.expiresAt);
    return this.forward(packet, undefined);
  }

  receive(packet: MeshPacket, ingressPeerId: string): Transmission[] {
    const now = this.now();
    this.prune(now);
    if (!this.isValidPacket(packet, now)) {
      this.addEvent("routing_failed", "رُفضت حزمة غير صالحة أو منتهية الصلاحية", { packetId: packet.id });
      return [];
    }
    if (this.dedupe.has(packet.id) || packet.path.includes(this.localId)) return [];
    const ingress = this.links.get(ingressPeerId);
    if (!ingress) {
      this.addEvent("routing_failed", "رُفضت الحزمة من جار غير نشط", { packetId: packet.id });
      return [];
    }
    if (packet.path.at(-1) !== ingressPeerId || new Set(packet.path).size !== packet.path.length) {
      this.addEvent("routing_failed", "رُفضت الحزمة لأن مسارها لا يطابق الجار أو يحتوي حلقة", { packetId: packet.id });
      return [];
    }
    this.rememberPacket(packet.id, packet.expiresAt);
    this.learnReverseRoutes(packet.path, ingress, now);

    const arrived: MeshPacket = {
      ...packet,
      ttl: packet.ttl - 1,
      hops: packet.hops + 1,
      path: [...packet.path, this.localId],
    };
    if (packet.kind === "data" && this.aliases.has(packet.targetId)) {
      this.deliveries.push({ packet: arrived, ingressPeerId });
      this.addEvent("packet_delivered", "وصلت رسالة بيانات إلى هذا الجهاز", { packetId: packet.id, nodeId: packet.sourceId, path: arrived.path });
      return [];
    }
    if (packet.targetId === this.localId) {
      this.addEvent("packet_delivered", `وصلت ${packet.kind === "ping" ? "حزمة Ping" : "تأكيد الحزمة"} إلى هذا الجهاز`, {
        packetId: packet.id,
        nodeId: packet.sourceId,
        path: arrived.path,
      });
      if (packet.kind === "ping") return this.answerPing(arrived);
      if (packet.kind === "ack" && packet.replyTo) {
        const startedAt = this.pingStarted.get(packet.replyTo);
        const rtt = startedAt === undefined ? null : Math.max(0, now - startedAt);
        if (startedAt !== undefined) this.pingStarted.delete(packet.replyTo);
        this.addEvent("ping_ack", rtt === null ? "وصل تأكيد Ping" : `وصل التأكيد خلال ${rtt} ms`, {
          packetId: packet.replyTo,
          path: packet.pingPath ?? arrived.path,
        });
      }
      return [];
    }
    if (arrived.ttl <= 0) {
      this.addEvent("routing_failed", "انتهى حد القفزات قبل الوصول إلى الوجهة", { packetId: packet.id });
      return [];
    }
    return this.forward(arrived, ingressPeerId);
  }

  getSnapshot() {
    this.prune(this.now());
    return {
      localId: this.localId,
      neighbors: [...this.links.values()].sort((a, b) => b.quality - a.quality),
      routes: [...this.routes.values()].sort((a, b) => a.score - b.score),
      knownNodes: [...this.knownNodes.entries()].map(([id, lastSeenAt]) => ({ id, lastSeenAt })),
      pendingPackets: this.pending.length,
      events: [...this.events].reverse(),
    };
  }

  private answerPing(received: MeshPacket): Transmission[] {
    const now = this.now();
    const ack: MeshPacket = {
      id: this.packetId(),
      kind: "ack",
      sourceId: this.localId,
      targetId: received.sourceId,
      replyTo: received.id,
      createdAt: now,
      expiresAt: Math.min(received.expiresAt, now + this.packetLifetimeMs),
      ttl: this.ttl,
      hops: 0,
      path: [this.localId],
      pingPath: received.path,
    };
    this.rememberPacket(ack.id, ack.expiresAt);
    return this.forward(ack, undefined);
  }

  private forward(packet: MeshPacket, ingressPeerId: string | undefined): Transmission[] {
    const now = this.now();
    const route = this.routes.get(packet.targetId);
    if (route && route.nextHopId !== ingressPeerId && !packet.path.includes(route.nextHopId)) {
      const link = this.links.get(route.nextHopId);
      if (link) {
        this.addEvent("packet_forwarded", `تم توجيه الحزمة إلى ${route.nextHopId}`, {
          packetId: packet.id,
          nodeId: route.nextHopId,
          path: packet.path,
        });
        return [{ peerId: route.nextHopId, packet }];
      }
    }
    const transmissions = [...this.links.values()]
      .filter((link) => link.peerId !== ingressPeerId && !packet.path.includes(link.peerId))
      .map((link) => ({ peerId: link.peerId, packet }));
    if (transmissions.length) {
      this.addEvent("packet_forwarded", "لا يوجد مسار مؤكد؛ أُرسلت الحزمة بطريقة flooding محدودة", {
        packetId: packet.id,
        path: packet.path,
      });
      return transmissions;
    }
    if (packet.expiresAt > now) {
      if (this.pending.length >= this.maxQueueItems) this.pending.shift();
      this.pending.push({ packet, queuedAt: now });
      this.addEvent("queue_stored", "حُفظت الحزمة مؤقتًا بانتظار عودة اتصال", { packetId: packet.id });
    }
    return [];
  }

  private flushQueue(): Transmission[] {
    const now = this.now();
    const queued = this.pending.splice(0);
    const output: Transmission[] = [];
    for (const item of queued) {
      if (item.packet.expiresAt <= now) {
        this.addEvent("queue_expired", "انتهت صلاحية حزمة في الطابور", { packetId: item.packet.id });
        continue;
      }
      output.push(...this.forward(item.packet, undefined));
    }
    return output;
  }

  private learnReverseRoutes(path: string[], ingress: LinkMetrics, now: number): void {
    for (let index = 0; index < path.length; index += 1) {
      const destinationId = path[index];
      if (!destinationId || destinationId === this.localId) continue;
      const hops = path.length - index;
      const candidate: MeshRoute = {
        destinationId,
        nextHopId: ingress.peerId,
        hops,
        score: routeCost(hops, ingress),
        quality: ingress.quality,
        qualityMeasured: ingress.qualityMeasured ?? false,
        lossPercent: ingress.lossPercent,
        lossMeasured: ingress.lossMeasured ?? false,
        latencyMs: ingress.latencyMs,
        stability: ingress.stability,
        stabilityMeasured: ingress.stabilityMeasured ?? false,
        lastUpdatedAt: now,
      };
      this.setRoute(candidate);
      this.knownNodes.set(destinationId, now);
    }
  }

  private setRoute(candidate: MeshRoute): void {
    const current = this.routes.get(candidate.destinationId);
    if (!current || candidate.score + 0.01 < current.score || candidate.nextHopId === current.nextHopId) {
      const changed = !current || current.nextHopId !== candidate.nextHopId || current.hops !== candidate.hops;
      this.routes.set(candidate.destinationId, candidate);
      if (changed && candidate.destinationId !== this.localId) {
        this.addEvent("route_changed", `المسار إلى ${candidate.destinationId}: ${candidate.hops} قفزة`, {
          nodeId: candidate.destinationId,
        });
      }
    }
  }

  private isValidPacket(packet: MeshPacket, now: number): boolean {
    return Boolean(
      packet &&
        typeof packet.id === "string" &&
        packet.id.length > 0 &&
        packet.id.length <= 128 &&
        ["ping", "ack", "route", "data"].includes(packet.kind) &&
        (packet.kind !== "data" || (typeof packet.payload?.envelope === "string" && packet.payload.envelope.length <= MAX_DATA_BYTES)) &&
        typeof packet.sourceId === "string" &&
        typeof packet.targetId === "string" &&
        Number.isInteger(packet.ttl) &&
        packet.ttl >= 0 &&
        packet.ttl <= 32 &&
        Array.isArray(packet.path) &&
        packet.path.length <= 32 &&
        packet.path.every((id) => typeof id === "string" && id.length <= 128) &&
        (packet.pingPath === undefined ||
          (packet.kind === "ack" && Array.isArray(packet.pingPath) && packet.pingPath.length >= 2 &&
            packet.pingPath.length <= 33 && packet.pingPath[0] === packet.targetId &&
            packet.pingPath[packet.pingPath.length - 1] === packet.sourceId &&
            packet.pingPath.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128))) &&
        Number.isFinite(packet.expiresAt) &&
        packet.expiresAt > now &&
        packet.expiresAt <= now + 86_400_000,
    );
  }

  private rememberPacket(id: string, expiresAt: number): void {
    this.dedupe.delete(id);
    this.dedupe.set(id, expiresAt);
    while (this.dedupe.size > MAX_DEDUPE_IDS) {
      const oldest = this.dedupe.keys().next().value as string | undefined;
      if (!oldest) break;
      this.dedupe.delete(oldest);
    }
  }

  private prune(now: number): void {
    for (const [id, expiry] of this.dedupe) if (expiry <= now) this.dedupe.delete(id);
    for (const [id, time] of this.knownNodes) if (id !== this.localId && now - time > LINK_TIMEOUT_MS && !this.links.has(id)) this.knownNodes.delete(id);
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index]!.packet.expiresAt <= now) {
        const [expired] = this.pending.splice(index, 1);
        if (expired) this.addEvent("queue_expired", "انتهت صلاحية حزمة في الطابور", { packetId: expired.packet.id });
      }
    }
  }

  private addEvent(kind: MeshEvent["kind"], message: string, extra: Partial<MeshEvent> = {}): void {
    this.eventCounter += 1;
    this.events.push({ id: `evt-${this.eventCounter}`, at: this.now(), kind, message, ...extra });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }
}
