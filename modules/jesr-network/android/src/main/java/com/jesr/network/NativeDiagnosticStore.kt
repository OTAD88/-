package com.jesr.network

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

internal class NativeDiagnosticStore(context: Context) {
  private val file = File(context.applicationContext.filesDir, "jesr-native-diagnostic.txt")
  private val lock = Any()

  fun record(stage: String, detail: String? = null, error: Throwable? = null) {
    val safeStage = stage.replace(Regex("[^A-Za-z0-9_.-]"), "_").take(100)
    val safeDetail = detail?.replace(Regex("[\\r\\n]"), " ")?.take(240)
    val stack = error?.let {
      StringWriter().also { writer -> it.printStackTrace(PrintWriter(writer)) }.toString().take(4_000)
    }
    val line = buildString {
      append(SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date()))
      append(" | ").append(safeStage)
      if (!safeDetail.isNullOrBlank()) append(" | ").append(safeDetail)
      if (!stack.isNullOrBlank()) append("\nSTACK: ").append(stack)
      append("\n")
    }
    synchronized(lock) {
      try {
        file.appendText(line)
        if (file.length() > MAX_BYTES) {
          val text = file.readText()
          file.writeText(text.takeLast((MAX_BYTES / 2).toInt()))
        }
      } catch (_: Exception) {
        // Diagnostics must never interfere with the network process.
      }
    }
  }

  fun read(): String = synchronized(lock) {
    try { if (file.exists()) file.readText().takeLast(MAX_BYTES.toInt()) else "" } catch (_: Exception) { "" }
  }

  companion object { private const val MAX_BYTES = 96 * 1024L }
}
