import { CryptoProvider } from "./crypto-provider";
import { KeyValueStore } from "./storage";
import { Envelope, EnvelopeType, openEnvelope, sealEnvelope } from "./protocol";
import { createProfile, normalizeJesrId, Profile } from "./identity";
import { fromBase64 } from "./bytes";

export type FriendState = "outgoing" | "incoming" | "friends" | "rejected";
export interface Friend { jesrId: string; name: string; publicKeyB64: string; state: FriendState; since: number }
/** Sending → Sent (handed to mesh transport) → Delivered (signed app ACK after decrypt+save). */
export type MsgStatus = "sending" | "sent" | "delivered" | "failed";
export interface ChatMessage { id: string; peer: string; dir: "in" | "out"; text: string; ts: number; status: MsgStatus }
interface OutboxItem { env: Envelope; attempts: number; next: number; expires: number }
interface State { profile: Profile | null; friends: Record<string, Friend>; messages: ChatMessage[]; outbox: OutboxItem[]; seen: string[]; readAt?: Record<string, number> }

/** Transport Layer boundary: resolves true iff the frame was accepted by a mesh link. Never means delivered. */
export interface Transport { send(env: Envelope): Promise<boolean> }

export const MAX_TEXT_CHARS = 1000;
export const OUTBOX_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_SEEN = 5000;
const backoff = (n: number) => Math.min(5 * 60_000, 2_000 * 2 ** n);

export class JesrEngine {
  private s: State = { profile: null, friends: {}, messages: [], outbox: [], seen: [] };
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  constructor(private c: CryptoProvider, private store: KeyValueStore, private transport: Transport, private clock: () => number = Date.now) {}

  /** Serialises all mutations so concurrent mesh callbacks can't corrupt state. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }
  private async persist() { await this.store.set("jesr.state", JSON.stringify(this.s)); this.notify(); }
  private notify() { for (const l of [...this.listeners]) { try { l(); } catch { /* UI listener errors must not break the engine */ } } }
  /** UI subscription: called after every persisted state change. Returns an unsubscribe function. */
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  async init(defaultName: string) {
    return this.run(async () => {
      const raw = await this.store.get("jesr.state");
      if (raw) this.s = JSON.parse(raw);
      if (!this.s.profile) { this.s.profile = await createProfile(this.c, defaultName); await this.persist(); }
      return this.s.profile;
    });
  }
  get profile() { return this.s.profile!; }
  friends() { return Object.values(this.s.friends).filter((f) => f.state === "friends"); }
  requests() { return Object.values(this.s.friends).filter((f) => f.state === "incoming" || f.state === "outgoing"); }
  history(peer: string) { return this.s.messages.filter((m) => m.peer === peer).sort((a, b) => a.ts - b.ts); }
  pendingCount() { return this.s.outbox.length; }
  friendOf(id: string) { return this.s.friends[id] ?? null; }
  lastMessage(peer: string) { let last: ChatMessage | undefined; for (const m of this.s.messages) if (m.peer === peer && (!last || m.ts >= last.ts)) last = m; return last; }
  unread(peer: string) { const t = this.s.readAt?.[peer] ?? 0; return this.s.messages.filter((m) => m.peer === peer && m.dir === "in" && m.ts > t).length; }
  markRead(peer: string) { return this.run(async () => { (this.s.readAt ??= {})[peer] = this.clock(); await this.persist(); }); }

  setName(name: string) { return this.run(async () => { this.s.profile!.name = name; await this.persist(); }); }

  // ---- friends ----
  async sendFriendRequest(rawId: string) {
    const id = normalizeJesrId(rawId);
    if (!id) return { ok: false as const, reason: "invalid-id" };
    return this.run(async () => {
      if (id === this.s.profile!.jesrId) return { ok: false as const, reason: "self" };
      const ex = this.s.friends[id];
      if (ex && (ex.state === "friends" || ex.state === "outgoing")) return { ok: false as const, reason: "duplicate" };
      if (ex?.state === "incoming") { await this.acceptLocked(id); return { ok: true as const }; }
      this.s.friends[id] = { jesrId: id, name: id, publicKeyB64: "", state: "outgoing", since: this.clock() };
      await this.enqueue(await sealEnvelope(this.c, this.s.profile!, { type: "friend-request", to: id, now: this.clock() }));
      return { ok: true as const };
    });
  }
  accept(id: string) { return this.run(() => this.acceptLocked(id)); }
  private async acceptLocked(id: string) {
    const f = this.s.friends[id];
    if (!f || f.state !== "incoming") return false;
    f.state = "friends";
    await this.enqueue(await sealEnvelope(this.c, this.s.profile!, { type: "friend-accept", to: id, now: this.clock() }));
    return true;
  }
  reject(id: string) {
    return this.run(async () => {
      const f = this.s.friends[id];
      if (!f || f.state !== "incoming") return false;
      f.state = "rejected";
      await this.enqueue(await sealEnvelope(this.c, this.s.profile!, { type: "friend-reject", to: id, now: this.clock() }));
      return true;
    });
  }

  // ---- messaging ----
  sendText(peer: string, text: string) {
    return this.run(async () => {
      const f = this.s.friends[peer];
      if (!f || f.state !== "friends" || !f.publicKeyB64) throw new Error("not-a-friend");
      if (!text.trim()) throw new Error("empty-message");
      if (text.length > MAX_TEXT_CHARS) throw new Error("message-too-long");
      const env = await sealEnvelope(this.c, this.s.profile!, { type: "msg", to: peer, plaintext: text, peerPub: fromBase64(f.publicKeyB64), now: this.clock() });
      this.s.messages.push({ id: env.id, peer, dir: "out", text, ts: env.ts, status: "sending" });
      await this.enqueue(env);
      return env.id;
    });
  }

  private async enqueue(env: Envelope) {
    this.s.outbox.push({ env, attempts: 0, next: 0, expires: this.clock() + OUTBOX_TTL_MS });
    await this.persist();
    await this.flushLocked();
  }
  /** Call when a link appears or periodically. */
  flush() { return this.run(() => this.flushLocked()); }
  private async flushLocked() {
    const now = this.clock();
    for (const it of [...this.s.outbox]) {
      if (now >= it.expires) { this.drop(it.env.id); this.mark(it.env.id, "failed"); continue; }
      if (now < it.next) continue;
      let ok = false;
      try { ok = await this.transport.send(it.env); } catch { ok = false; }
      it.attempts++;
      it.next = now + backoff(it.attempts);
      if (ok) this.mark(it.env.id, "sent");
    }
    await this.persist();
  }
  private drop(id: string) { this.s.outbox = this.s.outbox.filter((o) => o.env.id !== id); }
  private mark(id: string, st: MsgStatus) {
    const m = this.s.messages.find((x) => x.id === id && x.dir === "out");
    if (!m) return;
    if (m.status === "delivered") return;            // never downgrade
    m.status = st;
  }

  // ---- inbound from mesh (already de-duplicated per-hop by router, re-checked here) ----
  onEnvelope(env: Envelope) {
    return this.run(async () => {
      const r = await openEnvelope(this.c, this.s.profile!.jesrId, env, this.clock());
      if (!r.ok) return { accepted: false as const, reason: r.reason };
      const e = r.env;

      if (e.type === "ack") return this.handleAck(e);

      const dup = this.s.seen.includes(e.id);
      if (!dup) { this.s.seen.push(e.id); if (this.s.seen.length > MAX_SEEN) this.s.seen.shift(); }
      let ackable = true;

      if (!dup) {
        const f = this.s.friends[e.from];
        if (e.type === "friend-request") {
          if (f?.state === "rejected") ackable = false;
          else if (f?.state === "outgoing") {           // crossed requests → mutual
            Object.assign(f, { state: "friends", name: e.fromName || f.name, publicKeyB64: e.fromPub });
            await this.enqueue(await sealEnvelope(this.c, this.s.profile!, { type: "friend-accept", to: e.from, now: this.clock() }));
          } else if (!f) this.s.friends[e.from] = { jesrId: e.from, name: e.fromName || e.from, publicKeyB64: e.fromPub, state: "incoming", since: this.clock() };
        } else if (e.type === "friend-accept") {
          if (f?.state === "outgoing") Object.assign(f, { state: "friends", name: e.fromName || f.name, publicKeyB64: e.fromPub });
          else ackable = false;
        } else if (e.type === "friend-reject") {
          if (f?.state === "outgoing") f.state = "rejected";
        } else if (e.type === "msg") {
          if (f?.state !== "friends") ackable = false;   // strangers can't message
          else this.s.messages.push({ id: e.id, peer: e.from, dir: "in", text: r.plaintext!, ts: e.ts, status: "delivered" });
        }
        if (ackable) await this.persist();               // persist BEFORE acknowledging
      }
      if (ackable) {
        // ACKs are best-effort and not queued: if lost, the sender retransmits and we re-ACK the duplicate.
        const ack = await sealEnvelope(this.c, this.s.profile!, { type: "ack", to: e.from, ref: e.id, now: this.clock() });
        try { await this.transport.send(ack); } catch { /* sender will retry */ }
      }
      return { accepted: ackable, duplicate: dup };
    });
  }

  private async handleAck(e: Envelope) {
    if (this.s.seen.includes(e.id)) return { accepted: false as const, reason: "replay" };
    this.s.seen.push(e.id);
    const it = this.s.outbox.find((o) => o.env.id === e.ref);
    // ACK must come from the exact peer the message was addressed to, and only for a still-pending item.
    if (!it || it.env.to !== e.from) { await this.persist(); return { accepted: false as const, reason: "unmatched-ack" }; }
    this.drop(it.env.id);
    this.mark(it.env.id, "delivered");
    await this.persist();
    return { accepted: true as const };
  }
}
