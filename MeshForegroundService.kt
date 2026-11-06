package com.jesr.network

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

internal class MeshForegroundService : Service() {
  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      val notification = buildNotification()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (error: Exception) {
      Log.e(TAG, "Unable to enter foreground mode; stopping service without crashing app", error)
      stopSelfResult(startId)
    }
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "شبكة جسر المحلية",
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "إشعار ظاهر أثناء تشغيل اكتشاف وتمرير حزم شبكة جسر المحلية"
      setShowBadge(false)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun buildNotification(): Notification {
    val launcher = packageManager.getLaunchIntentForPackage(packageName)
    val pendingIntent = launcher?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID)
    else @Suppress("DEPRECATION") Notification.Builder(this)
    return builder
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("شبكة جسر قيد التشغيل")
      .setContentText("اكتشاف محلي وتمرير تشخيصي عبر Bluetooth وWi‑Fi Direct")
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setContentIntent(pendingIntent)
      .build()
  }

  companion object {
    private const val TAG = "JesrForegroundService"
    private const val CHANNEL_ID = "jesr_mesh_active"
    private const val NOTIFICATION_ID = 4187
  }
}
