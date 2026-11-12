package com.portava.input.speech

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class SpeechOptions : Record {
  @Field var requestId: String = ""
  @Field var language: String = ""
  @Field var expiresAtMs: Double = 0.0
}
class SpeechStopOptions : Record { @Field var requestId: String = "" }

class PortavaOnDeviceSpeechModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var foreground = true
  private var generation = 0L
  private var lease: SpeechLease? = null
  private var recognizer: SpeechRecognizer? = null
  private var listening = false
  private var releasing = false
  private var pending: Promise? = null
  private val probes = mutableSetOf<() -> Unit>()
  private fun intent(language: String) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
    putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
  }
  private fun available(context: Context?): Boolean = Build.VERSION.SDK_INT >= 33 && context != null && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
  // API 31/32 cannot certify the selected installed model. Never instantiate the default cloud-capable recognizer.
  private fun probe(context: Context, language: String, done: (Boolean) -> Unit) {
    if (!available(context) || !SpeechLease.validLanguage(language) || probes.size >= 4) { done(false); return }
    if (Build.VERSION.SDK_INT < 33) { done(false); return }
    var local: SpeechRecognizer? = null
    var finished = false
    lateinit var cancel: () -> Unit
    val finish: (Boolean) -> Unit = { value ->
      if (!finished) { finished = true; probes.remove(cancel); local?.destroy(); local = null; done(value) }
    }
    cancel = { finish(false) }
    probes.add(cancel)
    main.postDelayed({ finish(false) }, 3000)
    try {
      local = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
      local!!.checkRecognitionSupport(intent(language), context.mainExecutor, object : RecognitionSupportCallback {
        override fun onSupportResult(support: RecognitionSupport) { finish(SpeechLease.installed(language, support.installedOnDeviceLanguages)) }
        override fun onError(error: Int) { finish(false) }
      })
    } catch (_: Exception) { finish(false) }
  }
  private fun finish(error: String? = null) {
    val old = lease ?: return
    generation += 1; lease = null; listening = false; releasing = false
    val active = recognizer; recognizer = null
    try { active?.cancel(); active?.destroy() } catch (_: Exception) { }
    pending?.reject("ERR_SPEECH_STOPPED", error ?: "Speech input stopped", null); pending = null
    val event = mutableMapOf<String, Any>("requestId" to old.requestId)
    if (error != null) event["error"] = error
    sendEvent("onEnd", event)
  }
  private fun release() {
    if (lease == null || releasing) return
    if (!listening) { finish(); return }
    releasing = true; listening = false
    try { recognizer?.stopListening() } catch (_: Exception) { finish("capture_failed"); return }
    main.postDelayed({ finish() }, 1500)
  }
  private fun scheduleLifetime(version: Long) {
    main.postDelayed({
      val current = lease
      if (generation == version && current != null && !releasing) {
        if (!foreground || !current.live(System.currentTimeMillis(), SystemClock.elapsedRealtime())) release()
        else scheduleLifetime(version)
      }
    }, ((lease?.monotonicEnd ?: SystemClock.elapsedRealtime()) - SystemClock.elapsedRealtime()).coerceIn(1, 250))
  }
  private fun launch(context: Context, version: Long) {
    val current = lease ?: return
    if (generation != version || !foreground || !current.live(System.currentTimeMillis(), SystemClock.elapsedRealtime())) { if (generation == version) finish(); return }
    if (appContext.permissions?.hasGrantedPermissions(Manifest.permission.RECORD_AUDIO) != true) { finish("permission_denied"); return }
    if (Build.VERSION.SDK_INT < 33) { finish("on_device_unavailable"); return }
    // Recheck the exact selected language after permission; a pending prompt may have outlived a model change.
    probe(context, current.language) { supported ->
      if (generation == version && lease != null) {
        if (!supported || !foreground || !current.live(System.currentTimeMillis(), SystemClock.elapsedRealtime())) finish("on_device_unavailable")
        else try {
          val engine = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
          recognizer = engine
          engine.setRecognitionListener(object : RecognitionListener {
            private fun result(values: Bundle?, final: Boolean) {
              if (generation != version || lease == null) return
              val text = values?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.take(8000) ?: ""
              val confidence = values?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)?.firstOrNull()
              val event = mutableMapOf<String, Any>("requestId" to current.requestId, "text" to text, "isFinal" to final)
              if (confidence != null && confidence.isFinite() && confidence >= 0 && confidence <= 1) event["confidence"] = confidence
              sendEvent("onResult", event)
              if (final) finish()
            }
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {} // Never retain or relay raw buffers.
            override fun onEndOfSpeech() { if (generation == version) release() }
            override fun onError(error: Int) { if (generation == version) finish(if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) "permission_denied" else "provider_error") }
            override fun onResults(results: Bundle?) = result(results, true)
            override fun onPartialResults(partialResults: Bundle?) = result(partialResults, false)
            override fun onEvent(eventType: Int, params: Bundle?) {}
          })
          engine.startListening(intent(current.language)); listening = true
          pending?.resolve(null); pending = null
        } catch (_: Exception) { finish("capture_failed") }
      }
    }
  }
  override fun definition() = ModuleDefinition {
    Name("PortavaOnDeviceSpeech")
    Events("onResult", "onEnd")
    AsyncFunction("capabilities") { language: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null || !foreground) promise.resolve(mapOf("available" to false, "onDeviceOnly" to true))
      else probe(context, language) { value -> promise.resolve(mapOf("available" to value, "onDeviceOnly" to true)) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("start") { options: SpeechOptions, promise: Promise ->
      finish("replaced")
      val context = appContext.reactContext
      val activity = appContext.currentActivity
      if (!foreground || context == null || activity == null || !activity.hasWindowFocus() || activity.isFinishing || activity.isDestroyed || !available(context)) {
        promise.reject("ERR_SPEECH_UNAVAILABLE", "On-device speech is unavailable", null)
      } else try {
        lease = SpeechLease.parse(options.requestId, options.language, options.expiresAtMs, System.currentTimeMillis(), SystemClock.elapsedRealtime())
        val version = generation
        pending = promise
        scheduleLifetime(version)
        val permissions = appContext.permissions
        if (permissions == null) finish("permission_denied")
        else if (permissions.hasGrantedPermissions(Manifest.permission.RECORD_AUDIO)) launch(context, version)
        else permissions.askForPermissions({ main.post { launch(context, version) } }, Manifest.permission.RECORD_AUDIO)
      } catch (_: Exception) {
        if (pending === promise) finish("capture_failed")
        else promise.reject("ERR_SPEECH_OPTIONS", "Speech request is invalid or expired", null)
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { options: SpeechStopOptions -> if (options.requestId == lease?.requestId) release() }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { foreground = false; finish("background"); probes.toList().forEach { it() } }
    OnActivityEntersForeground { foreground = true }
    OnActivityDestroys { foreground = false; finish("destroyed"); probes.toList().forEach { it() } }
    OnDestroy { main.post { foreground = false; finish("destroyed"); probes.toList().forEach { it() } } }
  }
}
