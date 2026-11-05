package com.portava.media.compression

import android.content.Context
import android.media.MediaCodecInfo
import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.system.Os
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.AudioEncoderSettings
import androidx.media3.transformer.Codec
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.InAppMp4Muxer
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import java.io.File
import java.util.ArrayDeque
import java.util.UUID

/** One encoder on its own Looper. Backgrounding retires running AND queued work. */
@UnstableApi
internal class VideoCompressionEngine {
  private val lifetime = CompressionLifetime()
  private val thread = HandlerThread("PortavaVideoCompressor").apply { start() }
  private val handler = Handler(thread.looper)
  private val waiting = ArrayDeque<Job>()
  private var active: Job? = null
  private var shuttingDown = false

  private class Job(val context: Context, val uri: String, val options: CompressionOptions, val generation: Long,
    val allowed: (File) -> Boolean, val completion: (Result<Map<String, Any>>) -> Unit) {
    val deadline = SystemClock.elapsedRealtime() + 300_000
    var transformer: Transformer? = null
    var directory: File? = null
    var timeout: Runnable? = null
  }

  fun submit(context: Context, uri: String, options: CompressionOptions, allowed: (File) -> Boolean,
    completion: (Result<Map<String, Any>>) -> Unit) {
    val token = lifetime.capture()
    if (token == null) { completion(Result.failure(IllegalStateException("compression unavailable in background"))); return }
    val job = Job(context.applicationContext, uri, options, token, allowed, completion)
    if (!handler.post {
      if (!lifetime.isCurrent(job.generation) || waiting.size >= 8) {
        job.completion(Result.failure(IllegalStateException("compression request retired or queue full")))
      } else { waiting.add(job); next() }
    }) completion(Result.failure(IllegalStateException("compressor closed")))
  }

  fun suspend() {
    lifetime.suspend()
    handler.post {
      active?.takeUnless { lifetime.isCurrent(it.generation) }?.let { finish(it, Result.failure(IllegalStateException("compression cancelled"))) }
      next()
    }
  }
  fun resume() { lifetime.resume() }
  fun close() {
    lifetime.close()
    handler.post {
      shuttingDown = true
      active?.let { finish(it, Result.failure(IllegalStateException("compressor closed"))) }
      next()
    }
  }

  private fun check(job: Job) {
    check(lifetime.isCurrent(job.generation)) { "compression request retired" }
    check(SystemClock.elapsedRealtime() < job.deadline) { "compression deadline exceeded" }
  }

  private fun next() {
    if (active != null) return
    while (waiting.isNotEmpty()) {
      val job = waiting.removeFirst()
      if (!lifetime.isCurrent(job.generation)) {
        job.completion(Result.failure(IllegalStateException("compression request retired")))
        continue
      }
      active = job
      try { start(job) } catch (error: Exception) { finish(job, Result.failure(error)) }
      return
    }
    if (shuttingDown) thread.quitSafely()
  }

  private fun start(job: Job) {
    check(job)
    job.options.validate()
    val source = compressionSource(job.uri)
    require(job.allowed(source)) { "source permission denied" }
    val stamp = SourceStamp.read(source)
    validateSelfContainedMovie(source)
    val media = probeCompressionMedia(source)
    val dimensions = job.options.dimensions(media.width, media.height)
    check(job)
    val directory = File(job.context.cacheDir, "portava-video-${UUID.randomUUID()}")
    require(directory.mkdir()) { "private output directory unavailable" }
    job.directory = directory
    Os.chmod(directory.path, 448) // 0700
    val output = File(directory, "compressed.mp4")
    require(output.createNewFile()) { "output already exists" }
    Os.chmod(output.path, 384) // 0600

    val baseEncoder = DefaultEncoderFactory.Builder(job.context)
      .setEnableFallback(false)
      .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder()
        .setBitrate(job.options.videoBitrate(media.audioMime != null))
        .setBitrateMode(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR).build())
      .setRequestedAudioEncoderSettings(AudioEncoderSettings.Builder().setBitrate(96_000).build())
      .build()
    val encoder = object : Codec.EncoderFactory by baseEncoder {
      override fun videoNeedsEncoding() = true
      override fun audioNeedsEncoding() = true
    }
    val edited = EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(source)))
      .setEffects(Effects(emptyList(), listOf(Presentation.createForWidthAndHeight(dimensions.first, dimensions.second, Presentation.LAYOUT_SCALE_TO_FIT))))
      .build()
    val transformer = Transformer.Builder(job.context).setLooper(handler.looper)
      .setVideoMimeType(MimeTypes.VIDEO_H264).setAudioMimeType(MimeTypes.AUDIO_AAC)
      .setEncoderFactory(encoder)
      // Track rotation is written by the muxer itself. No source metadata,
      // location, creation tags or custom metadata entries are carried across.
      // This is a complete local upload copy. Fast-start's reserved free box
      // adds hundreds of KiB to short clips, exceeding whole-file rate limits.
      // Streaming renditions are produced by the server after upload.
      .setMuxerFactory(InAppMp4Muxer.Factory { entries -> entries.clear() }
        .setAttemptStreamableOutputEnabled(false))
      .setUsePlatformDiagnostics(false)
      .addListener(object : Transformer.Listener {
        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
          if (active !== job) return
          try {
            check(job)
            val measured = probeCompressionMedia(output, output = true)
            verifyCompressedCopy(media, measured, output, stamp.size, job.options, dimensions)
            check(SourceStamp.read(source) == stamp) { "source changed during compression" }
            check(job)
            finish(job, Result.success(mapOf("uri" to Uri.fromFile(output).toString(), "sizeBytes" to output.length(),
              "width" to measured.width, "height" to measured.height)))
          } catch (error: Exception) { finish(job, Result.failure(error)) }
        }
        override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
          finish(job, Result.failure(exportException))
        }
      }).build()
    job.transformer = transformer
    val timeout = Runnable { finish(job, Result.failure(IllegalStateException("compression deadline exceeded"))) }
    job.timeout = timeout
    check(job)
    handler.postDelayed(timeout, (job.deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1))
    transformer.start(edited, output.path)
  }

  private fun finish(job: Job, answer: Result<Map<String, Any>>) {
    if (active !== job) return
    active = null
    job.timeout?.let { handler.removeCallbacks(it) }
    var result = answer
    if (result.isFailure) {
      try { job.transformer?.cancel() } catch (error: Exception) { result = Result.failure(IllegalStateException("encoder cancellation failed", error)) }
      val directory = job.directory
      if (directory != null && !directory.deleteRecursively()) result = Result.failure(IllegalStateException("private output cleanup failed"))
    }
    job.completion(result)
    next()
  }
}
