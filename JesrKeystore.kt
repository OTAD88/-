package com.jesr.network

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM key that lives inside Android Keystore (non-extractable, never in JavaScript).
 * Everything Jesr persists (identity key seeds, chat state) is wrapped with it.
 */
internal class JesrKeystore(private val context: Context) {
  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build()
    )
    return gen.generateKey()
  }

  /** iv(12) || ciphertext+tag. `aad` binds the blob to its purpose/name. */
  fun wrap(plain: ByteArray, aad: String): ByteArray {
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, key())
    c.updateAAD(aad.toByteArray(Charsets.UTF_8))
    return c.iv + c.doFinal(plain)
  }

  fun unwrap(blob: ByteArray, aad: String): ByteArray {
    require(blob.size >= 12 + 16) { "corrupt blob" }
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob, 0, 12))
    c.updateAAD(aad.toByteArray(Charsets.UTF_8))
    return c.doFinal(blob, 12, blob.size - 12)
  }

  /** Atomic encrypted file write (tmp + rename) so a crash never leaves half a state file. */
  fun writeFile(name: String, plain: ByteArray) {
    require(NAME.matches(name)) { "invalid name" }
    val dir = File(context.filesDir, "jesr").apply { mkdirs() }
    val tmp = File(dir, "$name.tmp")
    tmp.writeBytes(wrap(plain, "file:$name"))
    if (!tmp.renameTo(File(dir, "$name.bin"))) {
      File(dir, "$name.bin").delete()
      check(tmp.renameTo(File(dir, "$name.bin"))) { "rename failed" }
    }
  }

  fun readFile(name: String): ByteArray? {
    require(NAME.matches(name)) { "invalid name" }
    val f = File(File(context.filesDir, "jesr"), "$name.bin")
    if (!f.exists()) return null
    return unwrap(f.readBytes(), "file:$name")
  }

  companion object {
    private const val ALIAS = "jesr_master_aes"
    private val NAME = Regex("^[a-z0-9_]{1,40}$")
    fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)
    fun unb64(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)
  }
}
