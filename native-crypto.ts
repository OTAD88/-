import { nativeBridge } from "@/modules/jesr-network";
import { CryptoProvider } from "./crypto-provider";
import { fromBase64, toBase64 } from "./bytes";
import { KeyValueStore } from "./storage";

/**
 * CryptoProvider backed by the native libsodium bridge (Android).
 * Private keys are created and kept in Kotlin, wrapped by Android Keystore; JavaScript only ever
 * sees public keys, signatures and ciphertext.
 */
export async function createNativeCrypto(): Promise<CryptoProvider> {
  const n = nativeBridge();
  const publicKey = fromBase64(await n.cryptoPublicKey());
  return {
    publicKey,
    async sign(d) { return fromBase64(await n.cryptoSign(toBase64(d))); },
    async verify(pub, d, sig) { try { return await n.cryptoVerify(toBase64(pub), toBase64(d), toBase64(sig)); } catch { return false; } },
    async sha256(d) { return fromBase64(await n.cryptoSha256(toBase64(d))); },
    async randomBytes(len) { return fromBase64(await n.cryptoRandom(len)); },
    async encrypt(peer, pt, aad) { return fromBase64(await n.cryptoEncrypt(toBase64(peer), toBase64(pt), toBase64(aad))); },
    async decrypt(_peer, ct, aad) { return fromBase64(await n.cryptoDecrypt(toBase64(ct), toBase64(aad))); },
  };
}

/** Encrypted-at-rest KeyValueStore (AES-256-GCM, key in Android Keystore). Names must be [a-z0-9_]. */
export function createNativeStore(): KeyValueStore {
  const n = nativeBridge();
  const name = (k: string) => k.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  return {
    get: (k) => n.secureGet(name(k)),
    set: (k, v) => n.secureSet(name(k), v),
  };
}
