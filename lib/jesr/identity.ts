import { CryptoProvider } from "./crypto-provider";
import { equalBytes, fromBase64, toBase64 } from "./bytes";

/** Crockford base32 (no I, L, O, U): easy to copy/dictate. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32(bytes: Uint8Array): string {
  let out = "", buf = 0, bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += ALPHABET[(buf >> bits) & 31]; }
  }
  if (bits > 0) out += ALPHABET[(buf << (5 - bits)) & 31];
  return out;
}

/**
 * Jesr ID = "JESR-" + base32(first 15 bytes of SHA-256(identity public key)),
 * grouped in fours. It is derived from the key, so knowing an ID gives no
 * ability to impersonate it, and a different key can never claim the same ID.
 * It is unrelated to the mesh nodeId.
 */
export async function deriveJesrId(crypto: Pick<CryptoProvider, "sha256">, publicKey: Uint8Array): Promise<string> {
  const h = await crypto.sha256(publicKey);
  const s = base32(h.slice(0, 15));
  return "JESR-" + s.match(/.{1,4}/g)!.join("-");
}

export function normalizeJesrId(input: string): string | null {
  const s = input.trim().toUpperCase().replace(/[\s_]/g, "").replace(/^JESR-?/, "").replace(/-/g, "");
  if (!/^[0-9A-HJKMNP-TV-Z]{24}$/.test(s)) return null;
  return "JESR-" + s.match(/.{1,4}/g)!.join("-");
}

export async function verifyIdMatchesKey(crypto: Pick<CryptoProvider, "sha256">, jesrId: string, publicKey: Uint8Array) {
  return (await deriveJesrId(crypto, publicKey)) === jesrId;
}

export interface Profile { jesrId: string; name: string; avatarUri?: string; publicKeyB64: string }

export async function createProfile(crypto: CryptoProvider, name: string): Promise<Profile> {
  return { jesrId: await deriveJesrId(crypto, crypto.publicKey), name, publicKeyB64: toBase64(crypto.publicKey) };
}
export const publicKeyOf = (p: { publicKeyB64: string }) => fromBase64(p.publicKeyB64);
export { equalBytes };
