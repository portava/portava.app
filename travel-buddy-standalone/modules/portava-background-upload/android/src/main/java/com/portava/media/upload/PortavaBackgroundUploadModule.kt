package com.portava.media.upload

import android.content.Intent
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PortavaBackgroundUploadModule : Module() {
  private var foreground = true
  private var boundOwner: String? = null
  private var boundEngine: UploadEngine? = null
  override fun definition() = ModuleDefinition {
    Name("PortavaBackgroundUpload")
    Events("onUploadProgress", "onUploadCancelled")
    OnCreate { UploadRuntime.onUserCancel = { boundOwner?.let { sendEvent("onUploadCancelled", mapOf("owner" to it)) } } }
    AsyncFunction("bindAsync") { owner: String, origin: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val engine = UploadRuntime.engine(context)
      engine.bind(owner, origin)
      boundEngine = engine
      boundOwner = owner
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("wasCancelledAsync") { owner: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      UploadRuntime.wasCancelled(context, owner)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancelOwnerAsync") { owner: String ->
      appContext.reactContext?.let { context ->
        UploadRuntime.rememberCancellation(context, owner)
        UploadRuntime.engine(context).clear(owner)
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("clearAsync") { owner: String ->
      appContext.reactContext?.let { UploadRuntime.engine(it).clear(owner) }
      if (boundOwner == owner) boundOwner = null
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancelAsync") { id: String, owner: String ->
      appContext.reactContext?.let { UploadRuntime.engine(it).cancel(id, owner) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("uploadAsync") { id: String, owner: String, url: String, uri: String, mime: String, promise: Promise ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val engine = UploadRuntime.engine(context)
      // Android disallows a fresh dataSync service from a background-only context.
      if ((!foreground || appContext.currentActivity == null) && !UploadRuntime.running) {
        promise.reject("ERR_UPLOAD_FOREGROUND_REQUIRED", "Open the app to resume this upload", null)
      } else {
        var enqueued = false
        try {
          engine.enqueue(id, owner, url, uri, mime,
            { p -> sendEvent("onUploadProgress", mapOf("id" to p.id, "totalBytesSent" to p.sent, "totalBytesExpectedToSend" to p.total)) },
            { result -> result.fold({ promise.resolve(mapOf("status" to it.status, "headers" to mapOf("retry-after" to it.retryAfter))) },
              { promise.reject("ERR_UPLOAD_INTERRUPTED", "Upload interrupted or cancelled", null) }) })
          enqueued = true
          val intent = Intent(context, UploadService::class.java)
          if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        } catch (_: Exception) {
          engine.cancel(id, owner)
          if (!enqueued) promise.reject("ERR_UPLOAD_START", "Upload could not start", null)
        }
      }
    }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { foreground = false }
    OnActivityEntersForeground { foreground = true }
    OnDestroy {
      boundOwner?.let { boundEngine?.clear(it) }
      boundOwner = null
      boundEngine = null
      UploadRuntime.onUserCancel = null
    }
  }
}
