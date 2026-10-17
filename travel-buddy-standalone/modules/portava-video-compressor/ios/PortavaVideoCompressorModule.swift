import ExpoModulesCore
import Foundation

struct CompressionOptionsRecord: Record {
  @Field var maxBitrateBps: Int = 4_000_000
  @Field var maxLongEdgePx: Int = 1920
}

public final class PortavaVideoCompressorModule: Module {
  private let scheduler = VideoCompressionScheduler()

  public func definition() -> ModuleDefinition {
    Name("PortavaVideoCompressor")

    AsyncFunction("compressAsync") { (uri: String, options: CompressionOptionsRecord, promise: Promise) in
      self.scheduler.submit(operation: { isCancelled in
        guard let requestedSource = URL(string: uri), requestedSource.isFileURL,
          FileSystemUtilities.permissions(self.appContext, for: requestedSource).contains(.read) else {
          throw VideoCompressionError.refused("source permission")
        }
        let source = try VideoCompressionCore.localSource(uri)
        guard FileSystemUtilities.permissions(self.appContext, for: source).contains(.read) else {
          throw VideoCompressionError.refused("source permission")
        }
        return try VideoCompressionCore.compress(
          uri: source.absoluteString,
          options: VideoCompressionOptions(maxBitrateBps: options.maxBitrateBps, maxLongEdgePx: options.maxLongEdgePx),
          isCancelled: isCancelled
        )
      }, completion: { result in
        switch result {
        case .success(let output): promise.resolve(output.dictionary)
        case .failure(let error): promise.reject(error)
        }
      })
    }.runOnQueue(.main)

    OnAppEntersBackground { self.scheduler.suspend() }
    OnDestroy { self.scheduler.invalidate() }
    OnAppContextDestroys { self.scheduler.invalidate() }
    OnAppEntersForeground { self.scheduler.resume() }
  }
}
