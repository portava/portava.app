package com.portava.media.compression

import androidx.media3.common.util.UnstableApi
import expo.modules.interfaces.filesystem.Permission
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class CompressionOptionsRecord : Record {
  @Field var maxBitrateBps: Int = 4_000_000
  @Field var maxLongEdgePx: Int = 1920
}

@UnstableApi
class PortavaVideoCompressorModule : Module() {
  private val engine = VideoCompressionEngine()

  override fun definition() = ModuleDefinition {
    Name("PortavaVideoCompressor")
    AsyncFunction("compressAsync") { uri: String, options: CompressionOptionsRecord, promise: Promise ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val permissions = appContext.filePermission
      engine.submit(context, uri, CompressionOptions(options.maxBitrateBps, options.maxLongEdgePx),
        allowed = { file -> permissions?.getPathPermissions(context, file.path)?.contains(Permission.READ) == true },
        completion = { result -> result.fold(onSuccess = { promise.resolve(it) },
          onFailure = { promise.reject("ERR_VIDEO_COMPRESSION", it.message, it) }) })
    }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { engine.suspend() }
    OnActivityEntersForeground { engine.resume() }
    OnActivityDestroys { engine.suspend() }
    OnDestroy { engine.close() }
  }
}
