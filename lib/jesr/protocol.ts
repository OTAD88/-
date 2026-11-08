import { CryptoProvider } from "./crypto-provider";
import { fromBase64, fromUtf8, toBase64, utf8 } from "./bytes";
import { deriveJesrId } from "./identity";

export type EnvelopeType = "friend-request" | "friend-accept" | "friend-reject" | "msg" | "ack";

/**
 * What mesh relays can see: `to`, `id`, `type`, `ts`. Message bodies are
 * ciphertext. Friend/ack frames carry no secrets and are signed.
 */
export interface Envelope {
  v: 1;
  type: EnvelopeType;
  id: string;          // unique per envelope (random)
  from: string;        // sender Jesr ID
  fromPub: string;     // base64 sender identity public key
  fromName?: string;   // only on friend frames
  to: string;          // recipient Jesr ID
  ts: number;          // ms epoch
  ref?: string;        // ack: id of the message being acknowledged
  ct?: string;         // msg: base64 ciphertext
  sig: string;         // base64 Ed25519 over canonical bytes
}

const canonical = (e: Omit<Envelope, "sig">) =>
  utf8(JSON.stringify([e.v, e.type, e.id, e.from, e.fromPub, e.fromName ?? "", e.to, e.ts, e.ref ?? "", e.ct ?? ""]));
const aadOf = (id: string, from: string, to: string) => utf8(`jesr1|${id}|${from}|${to}`);

export async function newId(c: CryptoProvider) {
  return toBase64(await c.randomBytes(16)).replace(/[+/=]/g, "x");
}

export async function sealEnvelope(
  c: CryptoProvider, self: { jesrId: string; name: string },
  p: { type: EnvelopeType; to: string; ref?: string; plaintext?: string; peerPub?: Uint8Array; now: number },
): Promise<Envelope> {
  const id = await newId(c);
  const base: Omit<Envelope, "sig"> = {
    v: 1, type: p.type, id, from: self.jesrId, fromPub: toBase64(c.publicKey),
    to: p.to, ts: p.now,
    ...(p.type.startsWith("friend") ? { fromName: self.name } : {}),
    ...(p.ref ? { ref: p.ref } : {}),
  };
  if (p.type === "msg") {
    if (!p.peerPub || p.plaintext === undefined) throw new Error("msg needs peerPub and plaintext");
    base.ct = toBase64(await c.encrypt(p.peerPub, utf8(p.plaintext), aadOf(id, self.jesrId, p.to)));
  }
  return { ...base, sig: toBase64(await c.sign(canonical(base))) };
}

export type OpenResult =
  | { ok: true; env: Envelope; plaintext?: string }
  | { ok: false; reason: "bad-shape" | "not-for-me" | "id-key-mismatch" | "bad-signature" | "decrypt-failed" | "stale" };

export const MAX_SKEW_MS = 7 * 24 * 3600 * 1000;

/** Validate shape, identity binding, signature, then decrypt (msg only). */
export async function openEnvelope(c: CryptoProvider, selfId: string, env: Envelope, now: number): Promise<OpenResult> {
  const validTypes: readonly string[] = ["friend-request", "friend-accept", "friend-reject", "msg", "ack"];
  const validCore =
    typeof env?.id === "string" && env.id.length > 0 && env.id.length <= 128 &&
    typeof env.from === "string" && env.from.length > 0 && env.from.length <= 128 &&
    typeof env.to === "string" && env.to.length > 0 && env.to.length <= 128 &&
    Number.isSafeInteger(env.ts) && env.ts > 0;
  const validPayload =
    env?.type === "msg" ? typeof env.ct === "string" && env.ct.length > 0 :
    env?.type === "ack" ? typeof env.ref === "string" && env.ref.length > 0 :
    true;

  if (
    !env || env.v !== 1 || !validTypes.includes(env.type) ||
    typeof env.sig !== "string" || env.sig.length === 0 ||
    typeof env.fromPub !== "string" || env.fromPub.length === 0 ||
    !validCore || !validPayload ||
    (env.fromName !== undefined && typeof env.fromName !== "string")
  ) return { ok: false, reason: "bad-shape" };

  if (env.to !== selfId) return { ok: false, reason: "not-for-me" };
  if (Math.abs(now - env.ts) > MAX_SKEW_MS) return { ok: false, reason: "stale" };

  let pub: Uint8Array;
  let signature: Uint8Array;
  try {
    pub = fromBase64(env.fromPub);
    signature = fromBase64(env.sig);
  } catch {
    return { ok: false, reason: "bad-shape" };
  }
  if ((await deriveJesrId(c, pub)) !== env.from) return { ok: false, reason: "id-key-mismatch" };

  const { sig, ...rest } = env;
  let signatureValid = false;
  try { signatureValid = await c.verify(pub, canonical(rest), signature); } catch { signatureValid = false; }
  if (!signatureValid) return { ok: false, reason: "bad-signature" };

  if (env.type !== "msg") return { ok: true, env };
  try {
    const pt = await c.decrypt(pub, fromBase64(env.ct ?? ""), aadOf(env.id, env.from, env.to));
    return { ok: true, env, plaintext: fromUtf8(pt) };
  } catch { return { ok: false, reason: "decrypt-failed" }; }
}
