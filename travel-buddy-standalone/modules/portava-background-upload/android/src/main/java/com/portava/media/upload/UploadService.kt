package com.portava.media.upload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper

internal object UploadRuntime {
  @Volatile var running = false
  var onUserCancel: (() -> Unit)? = null
  private var instance: UploadEngine? = null
  fun wasCancelled(context: Context, key: String): Boolean = context.getSharedPreferences("portava_upload_cancellations", Context.MODE_PRIVATE).contains(key)
  @Synchronized fun rememberCancellation(context: Context, key: String) {
    val prefs = context.getSharedPreferences("portava_upload_cancellations", Context.MODE_PRIVATE)
    val edit = prefs.edit()
    prefs.all.entries.sortedByDescending { (it.value as? Long) ?: 0L }.drop(99).forEach { edit.remove(it.key) }
    // Only opaque queue job IDs and timestamps; never URLs, tokens, filenames or account identifiers.
    edit.putLong(key, System.currentTimeMillis()).commit()
  }
  @Synchronized fun engine(context: Context): UploadEngine = instance ?: UploadEngine(listOf(context.cacheDir, context.filesDir)).also { instance = it }
}

/** Visible, bounded dataSync service; never restarts with an old account's signed URLs. */
class UploadService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val update = Runnable {
    val (count, _) = engine.snapshot()
    if (count == 0) stopSelf() else getSystemService(NotificationManager::class.java).notify(ID, notification())
  }
  private val engine get() = UploadRuntime.engine(this)
  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 26) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "Media uploads", NotificationManager.IMPORTANCE_LOW))
    }
    UploadRuntime.running = true
    engine.changed = { handler.removeCallbacks(update); handler.postDelayed(update, 200) }
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      if (Build.VERSION.SDK_INT >= 29) startForeground(ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      else startForeground(ID, notification())
    } catch (_: Exception) {
      engine.cancelAll(); stopSelf(); return START_NOT_STICKY
    }
    if (intent?.action == CANCEL) { engine.ownerKey()?.let { UploadRuntime.rememberCancellation(this, it) }; UploadRuntime.onUserCancel?.invoke(); engine.cancelAll(); stopSelf() }
    else engine.start()
    return START_NOT_STICKY
  }
  private fun notification(): Notification {
    val (count, progress) = engine.snapshot()
    val cancel = PendingIntent.getService(this, 1, Intent(this, UploadService::class.java).setAction(CANCEL), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    builder.setSmallIcon(android.R.drawable.stat_sys_upload).setContentTitle("Uploading media")
      .setContentText(if (count == 1) "1 transfer in progress" else "$count transfers in progress")
      .setOnlyAlertOnce(true).setOngoing(true).setProgress(100, progress, count == 0)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .addAction(Notification.Action.Builder(null, "Cancel", cancel).build())
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      builder.setContentIntent(PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }
    return builder.build()
  }
  override fun onTimeout(startId: Int, fgsType: Int) { engine.cancelAll(); stopSelf() }
  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    engine.changed = null
    engine.cancelAll()
    UploadRuntime.running = false
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }
  override fun onBind(intent: Intent?): IBinder? = null
  companion object {
    private const val CHANNEL = "portava_media_uploads"
    private const val ID = 20741
    const val CANCEL = "com.portava.media.upload.CANCEL"
  }
}
