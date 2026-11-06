package com.jesr.network

import android.content.Context
import com.goterl.lazysodium.SodiumAndroid

/**
 * Cryptography layer backed by libsodium. Wire-compatible with the JS CryptoProvider contract:
 *  - publicKey = Ed25519 pk (32) || X25519 pk (32)
 *  - encrypt   = ephPk(32) || nonce(24) || XChaCha20-Poly1305(ct||tag), key = BLAKE2b(ECDH || ephPk || peerPk), AAD authenticated
 * Private seeds are generated natively, stored only as Keystore-wrapped blobs, and never cross to JavaScript.
 */
internal class JesrCrypto(context: Context) {
  private val sodium = SodiumAndroid()
  private val keystore = JesrKeystore(context)
  private val edPk = ByteArray(32)
  private val edSk = ByteArray(64)
  private val xPk = ByteArray(32)
  private val xSk = ByteArray(32)

  val publicKey: ByteArray get() = edPk + xPk

  init {
    check(sodium.sodium_init() >= 0) { "libsodium init failed" }
    var seeds = keystore.readFile("identity")
    if (seeds == null || seeds.size != 64) {
      seeds = ByteArray(64).also { sodium.randombytes_buf(it, 64) }
      keystore.writeFile("identity", seeds)
    }
    check(sodium.crypto_sign_seed_keypair(edPk, edSk, seeds.copyOfRange(0, 32)) == 0) { "ed25519 keygen" }
    check(sodium.crypto_box_seed_keypair(xPk, xSk, seeds.copyOfRange(32, 64)) == 0) { "x25519 keygen" }
    seeds.fill(0)
  }

  fun sign(data: ByteArray): ByteArray {
    val sig = ByteArray(64)
    check(sodium.crypto_sign_detached(sig, null, data, data.size.toLong(), edSk) == 0) { "sign failed" }
    return sig
  }

  fun verify(publicKey: ByteArray, data: ByteArray, sig: ByteArray): Boolean {
    if (publicKey.size != 64 || sig.size != 64) return false
    return sodium.crypto_sign_verify_detached(sig, data, data.size.toLong(), publicKey.copyOfRange(0, 32)) == 0
  }

  fun sha256(data: ByteArray): ByteArray {
    val out = ByteArray(32)
    check(sodium.crypto_hash_sha256(out, data, data.size.toLong()) == 0) { "sha256 failed" }
    return out
  }

  fun randomBytes(n: Int): ByteArray {
    require(n in 1..1024) { "bad length" }
    return ByteArray(n).also { sodium.randombytes_buf(it, n) }
  }

  private fun sessionKey(shared: ByteArray, ephPk: ByteArray, recipientPk: ByteArray): ByteArray {
    val input = shared + ephPk + recipientPk
    val key = ByteArray(32)
    check(sodium.crypto_generichash(key, 32, input, input.size.toLong(), null, 0) == 0) { "kdf failed" }
    return key
  }

  fun encrypt(peerPublicKey: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray {
    require(peerPublicKey.size == 64) { "bad peer key" }
    val peerX = peerPublicKey.copyOfRange(32, 64)
    val ephPk = ByteArray(32)
    val ephSk = ByteArray(32)
    check(sodium.crypto_box_keypair(ephPk, ephSk) == 0) { "eph keygen" }
    val shared = ByteArray(32)
    check(sodium.crypto_scalarmult(shared, ephSk, peerX) == 0) { "ecdh failed" }
    val key = sessionKey(shared, ephPk, peerX)
    val nonce = ByteArray(24).also { sodium.randombytes_buf(it, 24) }
    val ct = ByteArray(plaintext.size + 16)
    val ctLen = LongArray(1)
    check(
      sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ct, ctLen, plaintext, plaintext.size.toLong(), aad, aad.size.toLong(), null, nonce, key) == 0
    ) { "encrypt failed" }
    ephSk.fill(0); shared.fill(0); key.fill(0)
    return ephPk + nonce + ct.copyOf(ctLen[0].toInt())
  }

  fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray {
    require(blob.size >= 32 + 24 + 16) { "short ciphertext" }
    val ephPk = blob.copyOfRange(0, 32)
    val nonce = blob.copyOfRange(32, 56)
    val ct = blob.copyOfRange(56, blob.size)
    val shared = ByteArray(32)
    check(sodium.crypto_scalarmult(shared, xSk, ephPk) == 0) { "ecdh failed" }
    val key = sessionKey(shared, ephPk, xPk)
    val pt = ByteArray(ct.size - 16)
    val ptLen = LongArray(1)
    val rc = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(pt, ptLen, null, ct, ct.size.toLong(), aad, aad.size.toLong(), nonce, key)
    shared.fill(0); key.fill(0)
    check(rc == 0) { "decrypt failed" }
    return pt.copyOf(ptLen[0].toInt())
  }

  /** Encrypted-at-rest key/value used by the engine (state JSON); wrapped by the Keystore AES key. */
  fun secureGet(name: String): String? = keystore.readFile(name)?.toString(Charsets.UTF_8)
  fun secureSet(name: String, value: String) = keystore.writeFile(name, value.toByteArray(Charsets.UTF_8))
}
