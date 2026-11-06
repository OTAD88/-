import { MeshRouter, type LinkType, type MeshPacket } from "./router";

export type SimulationTopology = "chain" | "random";

export interface SimulationNode {
  id: string;
  online: boolean;
}

export interface SimulationLink {
  id: string;
  a: string;
  b: string;
  type: LinkType;
  enabled: boolean;
}

export interface SimulationEvent {
  id: string;
  at: number;
  kind: "packet" | "delivered" | "dropped" | "duplicate" | "route" | "system";
  message: string;
  path?: string[];
  packetId?: string;
}

export interface SimulationStats {
  devices: number;
  connections: number;
  packetsSent: number;
  packetsDelivered: number;
  packetsLost: number;
  duplicatesDropped: number;
  averageProcessingMs: number;
  longestPath: number;
  averageHops: number;
  deliveryRate: number;
  routeChanges: number;
}

export interface SimulationSnapshot {
  nodes: SimulationNode[];
  links: SimulationLink[];
  events: SimulationEvent[];
  stats: SimulationStats;
  lastPath: string[];
  sourceId: string;
  targetId: string;
}

type Transmission = { from: string; to: string; packet: MeshPacket };

function linkId(a: string, b: string) {
  return [a, b].sort().join("--");
}

function nodeId(index: number) {
  return `SIM-${String(index + 1).padStart(3, "0")}`;
}

export class MeshSimulation {
  private readonly routers = new Map<string, MeshRouter>();
  private readonly nodes = new Map<string, SimulationNode>();
  private readonly links = new Map<string, SimulationLink>();
  private readonly seenAtNode = new Set<string>();
  private readonly events: SimulationEvent[] = [];
  private sequence = 0;
  private packetSequence = 0;
  private sourceId = "SIM-001";
  private targetId = "SIM-003";
  private packetsSent = 0;
  private packetsDelivered = 0;
  private packetsLost = 0;
  private duplicatesDropped = 0;
  private processingTotalMs = 0;
  private longestPath = 0;
  private totalHops = 0;
  private routeChanges = 0;
  private lastPath: string[] = [];
  private readonly now: () => number;

  constructor(count = 3, topology: SimulationTopology = "chain", now: () => number = Date.now) {
    this.now = now;
    this.reset(count, topology);
  }

  reset(count: number, topology: SimulationTopology = "chain") {
    const safeCount = [2, 3, 10, 25, 50, 100].includes(count) ? count : 3;
    this.routers.clear();
    this.nodes.clear();
    this.links.clear();
    this.seenAtNode.clear();
    this.events.length = 0;
    this.packetsSent = 0;
    this.packetsDelivered = 0;
    this.packetsLost = 0;
    this.duplicatesDropped = 0;
    this.processingTotalMs = 0;
    this.longestPath = 0;
    this.totalHops = 0;
    this.routeChanges = 0;
    this.lastPath = [];
    this.sourceId = nodeId(0);
    this.targetId = nodeId(Math.min(2, safeCount - 1));

    for (let index = 0; index < safeCount; index += 1) {
      const id = nodeId(index);
      this.nodes.set(id, { id, online: true });
      this.routers.set(id, new MeshRouter(id, {
        now: this.now,
        packetId: () => `sim-packet-${++this.packetSequence}`,
      }));
    }

    if (topology === "chain") {
      for (let index = 0; index < safeCount - 1; index += 1) {
        this.addLink(nodeId(index), nodeId(index + 1), index % 2 === 0 ? "ble" : "wifi-direct");
      }
    } else {
      for (let index = 0; index < safeCount - 1; index += 1) {
        this.addLink(nodeId(index), nodeId(index + 1), index % 2 === 0 ? "ble" : "wifi-direct");
        if (index + 2 < safeCount && index % 3 === 0) {
          this.addLink(nodeId(index), nodeId(index + 2), index % 2 === 0 ? "wifi-direct" : "ble");
        }
      }
    }
    this.addEvent("system", `أُنشئت شبكة محاكاة من ${safeCount} أجهزة بنمط ${topology === "chain" ? "سلسلة" : "عشوائي"}`);
  }

  addLink(a: string, b: string, type: LinkType = "wifi-direct") {
    if (a === b || !this.nodes.has(a) || !this.nodes.has(b)) return false;
    const id = linkId(a, b);
    if (this.links.has(id)) return false;
    this.links.set(id, { id, a, b, type, enabled: true });
    this.observeLink(a, b, type);
    this.addEvent("system", `أُضيف اتصال ${type === "ble" ? "Bluetooth" : "Wi-Fi Direct"}: ${a} ↔ ${b}`);
    return true;
  }

  toggleLink(id: string, enabled: boolean) {
    const link = this.links.get(id);
    if (!link || link.enabled === enabled) return;
    link.enabled = enabled;
    if (enabled) this.observeLink(link.a, link.b, link.type);
    else {
      this.routers.get(link.a)?.removeLink(link.b);
      this.routers.get(link.b)?.removeLink(link.a);
    }
    this.addEvent("system", `${enabled ? "أُعيد" : "قُطع"} الاتصال ${link.a} ↔ ${link.b}`);
  }

  setNodeOnline(id: string, online: boolean) {
    const node = this.nodes.get(id);
    if (!node || node.online === online) return;
    node.online = online;
    for (const link of this.links.values()) {
      if (link.a !== id && link.b !== id) continue;
      const peer = link.a === id ? link.b : link.a;
      if (online && link.enabled && this.nodes.get(peer)?.online) this.observeLink(id, peer, link.type);
      else {
        this.routers.get(id)?.removeLink(peer);
        this.routers.get(peer)?.removeLink(id);
      }
    }
    this.addEvent("system", `${online ? "عاد" : "انقطع"} الجهاز ${id}`);
  }

  send(sourceId = this.sourceId, targetId = this.targetId) {
    const started = this.now();
    this.sourceId = sourceId;
    this.targetId = targetId;
    const source = this.nodes.get(sourceId);
    const target = this.nodes.get(targetId);
    if (!source?.online || !target?.online || sourceId === targetId) {
      this.packetsLost += 1;
      this.addEvent("dropped", "تعذر الإرسال: تحقق من المصدر والوجهة وحالتهما", undefined, []);
      return;
    }

    this.packetsSent += 1;
    const outgoing = this.routers.get(sourceId)?.sendPing(targetId) ?? [];
    const queue: Transmission[] = outgoing.map((packet) => ({ from: sourceId, to: packet.peerId, packet: packet.packet }));
    const packetIds = new Set<string>();
    let delivered = false;
    let lastPath: string[] = [];
    let steps = 0;

    while (queue.length > 0 && steps < 2_000) {
      const frame = queue.shift()!;
      steps += 1;
      const link = this.findLink(frame.from, frame.to);
      const destination = this.nodes.get(frame.to);
      if (!link?.enabled || !destination?.online || !this.nodes.get(frame.from)?.online) {
        this.packetsLost += 1;
        this.addEvent("dropped", `سقطت الحزمة عند ${frame.from} → ${frame.to}`, frame.packet.id, frame.packet.path);
        continue;
      }
      const nodePacketKey = `${frame.to}:${frame.packet.id}`;
      if (this.seenAtNode.has(nodePacketKey)) {
        this.duplicatesDropped += 1;
        this.addEvent("duplicate", `أُسقط تكرار الحزمة عند ${frame.to}`, frame.packet.id, frame.packet.path);
        continue;
      }
      this.seenAtNode.add(nodePacketKey);
      packetIds.add(frame.packet.id);
      this.addEvent("packet", `${frame.from} → ${frame.to} عبر ${link.type === "ble" ? "Bluetooth" : "Wi-Fi Direct"}`, frame.packet.id, [...frame.packet.path, frame.to]);
      const transmissions = this.routers.get(frame.to)?.receive(frame.packet, frame.from) ?? [];
      const snapshot = this.routers.get(frame.to)?.getSnapshot();
      const deliveredEvent = snapshot?.events.find((event) => event.kind === "packet_delivered" && event.packetId === frame.packet.id);
      if (deliveredEvent && frame.packet.kind === "ping") {
        delivered = true;
        lastPath = deliveredEvent.path ?? [...frame.packet.path, frame.to];
      }
      for (const routeEvent of snapshot?.events ?? []) {
        if (routeEvent.kind === "route_changed") this.routeChanges += 1;
      }
      queue.push(...transmissions.map((packet) => ({ from: frame.to, to: packet.peerId, packet: packet.packet })));
    }

    if (steps >= 2_000) {
      this.packetsLost += 1;
      this.addEvent("dropped", "أُوقفت المحاكاة لحماية المختبر من حلقة غير منتهية");
    }
    if (delivered) {
      this.packetsDelivered += 1;
      const hops = Math.max(0, lastPath.length - 1);
      this.lastPath = lastPath;
      this.longestPath = Math.max(this.longestPath, hops);
      this.totalHops += hops;
      this.addEvent("delivered", `وصلت الحزمة إلى ${targetId} خلال ${hops} قفزات`, [...packetIds][0], lastPath);
    } else {
      this.packetsLost += 1;
      this.addEvent("dropped", `لم تصل الحزمة إلى ${targetId} قبل انتهاء المحاكاة`);
    }
    this.processingTotalMs += Math.max(0, this.now() - started);
  }

  snapshot(): SimulationSnapshot {
    const devices = this.nodes.size;
    const connections = [...this.links.values()].filter((link) => link.enabled && this.nodes.get(link.a)?.online && this.nodes.get(link.b)?.online).length;
    return {
      nodes: [...this.nodes.values()],
      links: [...this.links.values()],
      events: [...this.events].reverse(),
      stats: {
        devices,
        connections,
        packetsSent: this.packetsSent,
        packetsDelivered: this.packetsDelivered,
        packetsLost: this.packetsLost,
        duplicatesDropped: this.duplicatesDropped,
        averageProcessingMs: this.packetsSent ? Math.round(this.processingTotalMs / this.packetsSent) : 0,
        longestPath: this.longestPath,
        averageHops: this.packetsDelivered ? Number((this.totalHops / this.packetsDelivered).toFixed(1)) : 0,
        deliveryRate: this.packetsSent ? Math.round((this.packetsDelivered / this.packetsSent) * 100) : 0,
        routeChanges: this.routeChanges,
      },
      lastPath: this.lastPath,
      sourceId: this.sourceId,
      targetId: this.targetId,
    };
  }

  private observeLink(a: string, b: string, type: LinkType) {
    if (!this.nodes.get(a)?.online || !this.nodes.get(b)?.online) return;
    this.routers.get(a)?.observeLink(this.metrics(b, type));
    this.routers.get(b)?.observeLink(this.metrics(a, type));
  }

  private metrics(peerId: string, type: LinkType) {
    return {
      peerId,
      type,
      quality: 90,
      lossPercent: 0,
      latencyMs: type === "ble" ? 25 : 15,
      stability: 0.95,
      qualityMeasured: true,
      lossMeasured: true,
      stabilityMeasured: true,
      lastSeenAt: this.now(),
    };
  }

  private findLink(a: string, b: string) {
    return this.links.get(linkId(a, b));
  }

  private addEvent(kind: SimulationEvent["kind"], message: string, packetId?: string, path?: string[]) {
    this.sequence += 1;
    this.events.push({ id: `sim-${this.sequence}`, at: this.now(), kind, message, packetId, path });
    if (this.events.length > 160) this.events.splice(0, this.events.length - 160);
  }
}
