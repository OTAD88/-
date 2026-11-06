/**
 * Cryptography Layer boundary.
 *
 * Jesr never implements cryptographic primitives itself. A production
 * provider must wrap a vetted library (Matrix Rust Crypto / Olm+Megolm, or
 * libsodium) and keep private keys in Android Keystore, never in JavaScript.
 * Android implementation: lib/jesr/native-crypto.ts -> JesrCrypto.kt (libsodium) + JesrKeystore.kt.
 */
export interface CryptoProvider {
  /** Raw Ed25519 public key of this device identity. */
  readonly publicKey: Uint8Array;
  sign(data: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, data: Uint8Array, sig: Uint8Array): Promise<boolean>;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  randomBytes(n: number): Promise<Uint8Array>;
  /** Encrypt for a peer identified by public key. `aad` is authenticated. */
  encrypt(peerPublicKey: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  decrypt(peerPublicKey: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}
