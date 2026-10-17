import AVFoundation
import Foundation
import VideoToolbox

enum VideoCompressionError: Error, LocalizedError {
  case refused(String)

  var errorDescription: String? {
    switch self {
    case .refused(let reason): return "Video compression refused: \(reason)"
    }
  }
}

struct VideoCompressionOptions {
  let maxBitrateBps: Int
  let maxLongEdgePx: Int

  func validate() throws {
    guard (256_000...4_000_000).contains(maxBitrateBps),
      (2...1920).contains(maxLongEdgePx) else {
      throw VideoCompressionError.refused("invalid policy")
    }
  }
}

struct VideoCompressionResult {
  let uri: String
  let sizeBytes: Int
  let width: Int
  let height: Int

  var dictionary: [String: Any] {
    ["uri": uri, "sizeBytes": sizeBytes, "width": width, "height": height]
  }
}

enum VideoCompressionCore {
  static func compress(
    uri: String,
    options: VideoCompressionOptions,
    temporaryRoot: URL = FileManager.default.temporaryDirectory,
    timeLimit: TimeInterval = 300,
    isCancelled: () -> Bool = { false }
  ) throws -> VideoCompressionResult {
    try options.validate()
    let deadline = ProcessInfo.processInfo.systemUptime + timeLimit
    func checkOperation() throws {
      guard !isCancelled(), ProcessInfo.processInfo.systemUptime < deadline else {
        throw VideoCompressionError.refused("cancelled or timed out")
      }
    }
    try checkOperation()
    let source = try localSource(uri)
    let sourceAttributes = try FileManager.default.attributesOfItem(atPath: source.path)
    guard let sourceSize = sourceAttributes[.size] as? NSNumber, sourceSize.intValue > 0 else {
      throw VideoCompressionError.refused("empty source")
    }
    let asset = localAsset(source)
    let videoTracks = asset.tracks(withMediaType: .video)
    let audioTracks = asset.tracks(withMediaType: .audio)
    let duration = asset.duration
    guard !asset.hasProtectedContent, videoTracks.count == 1, audioTracks.count <= 1,
      duration.isNumeric, duration.seconds.isFinite, duration.seconds > 0 else {
      throw VideoCompressionError.refused("unsupported tracks or duration")
    }
    let videoTrack = videoTracks[0]
    let geometry = try outputGeometry(track: videoTrack, longEdge: options.maxLongEdgePx)
    let reader = try AVAssetReader(asset: asset)
    let videoOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ])
    videoOutput.alwaysCopiesSampleData = false
    guard reader.canAdd(videoOutput) else { throw VideoCompressionError.refused("video reader") }
    reader.add(videoOutput)

    var audioOutput: AVAssetReaderTrackOutput?
    var audioSettings: [String: Any]?
    var audioBitrate = 0
    if let audioTrack = audioTracks.first {
      guard let format = (audioTrack.formatDescriptions as! [CMFormatDescription]).first,
        let stream = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
        (1...2).contains(stream.mChannelsPerFrame), stream.mSampleRate.isFinite,
        (8_000...96_000).contains(stream.mSampleRate) else {
        throw VideoCompressionError.refused("unsupported audio layout")
      }
      audioBitrate = stream.mChannelsPerFrame == 1 ? 64_000 : 128_000
      audioSettings = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: stream.mSampleRate,
        AVNumberOfChannelsKey: stream.mChannelsPerFrame,
        AVEncoderBitRateKey: audioBitrate
      ]
      let output = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false
      ])
      output.alwaysCopiesSampleData = false
      guard reader.canAdd(output) else { throw VideoCompressionError.refused("audio reader") }
      reader.add(output)
      audioOutput = output
    }

    try checkOperation()
    let directory = temporaryRoot.appendingPathComponent("PortavaVideo-\(UUID().uuidString)", isDirectory: true)
    var directoryAttributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
    #if os(iOS)
    directoryAttributes[.protectionKey] = FileProtectionType.complete
    #endif
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: directoryAttributes)
    let outputURL = directory.appendingPathComponent("compressed.mp4")
    var writer: AVAssetWriter?
    do {
      let encoder = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
      writer = encoder
      encoder.metadata = []
      encoder.shouldOptimizeForNetworkUse = true
      let videoBudget = options.maxBitrateBps - audioBitrate - 64_000
      let videoSettings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: geometry.encodedWidth,
        AVVideoHeightKey: geometry.encodedHeight,
        AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
        AVVideoCompressionPropertiesKey: [
          AVVideoAverageBitRateKey: Int(Double(videoBudget) * 0.8),
          kVTCompressionPropertyKey_DataRateLimits as String: [videoBudget / 8, 1],
          AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
          AVVideoAllowFrameReorderingKey: false,
          AVVideoExpectedSourceFrameRateKey: max(1, videoTrack.nominalFrameRate)
        ]
      ]
      guard encoder.canApply(outputSettings: videoSettings, forMediaType: .video) else {
        throw VideoCompressionError.refused("H.264 encoder unavailable")
      }
      let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
      videoInput.transform = geometry.transform
      videoInput.metadata = []
      videoInput.expectsMediaDataInRealTime = false
      guard encoder.canAdd(videoInput) else { throw VideoCompressionError.refused("video writer") }
      encoder.add(videoInput)
      var streams: [(output: AVAssetReaderTrackOutput, input: AVAssetWriterInput)] = [(videoOutput, videoInput)]
      if let audioOutput, let audioSettings {
        guard encoder.canApply(outputSettings: audioSettings, forMediaType: .audio) else {
          throw VideoCompressionError.refused("AAC encoder unavailable")
        }
        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        audioInput.metadata = []
        audioInput.expectsMediaDataInRealTime = false
        guard encoder.canAdd(audioInput) else { throw VideoCompressionError.refused("audio writer") }
        encoder.add(audioInput)
        streams.append((audioOutput, audioInput))
      }
      guard encoder.startWriting(), reader.startReading() else {
        throw VideoCompressionError.refused("cannot start encoding")
      }
      encoder.startSession(atSourceTime: .zero)
      var finished = Set<Int>()
      var sampleCounts = Array(repeating: 0, count: streams.count)
      while finished.count < streams.count {
        try checkOperation()
        guard reader.status != .failed, encoder.status == .writing else {
          throw VideoCompressionError.refused("encoding failed")
        }
        var progressed = false
        for index in streams.indices where !finished.contains(index) {
          let stream = streams[index]
          if stream.input.isReadyForMoreMediaData {
            try autoreleasepool {
              if let sample = stream.output.copyNextSampleBuffer() {
                guard stream.input.append(sample) else { throw VideoCompressionError.refused("sample rejected") }
                sampleCounts[index] += 1
              } else {
                stream.input.markAsFinished()
                finished.insert(index)
              }
            }
            progressed = true
          }
        }
        if !progressed { Thread.sleep(forTimeInterval: 0.002) }
      }
      guard reader.status == .completed, sampleCounts.allSatisfy({ $0 > 0 }) else {
        throw VideoCompressionError.refused("incomplete decode")
      }
      encoder.endSession(atSourceTime: duration)
      let completion = DispatchSemaphore(value: 0)
      encoder.finishWriting { completion.signal() }
      while completion.wait(timeout: .now() + 0.05) == .timedOut { try checkOperation() }
      try checkOperation()
      guard encoder.status == .completed else { throw VideoCompressionError.refused("incomplete encode") }
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outputURL.path)
      let finalSourceAttributes = try FileManager.default.attributesOfItem(atPath: source.path)
      guard sourceAttributes[.size] as? NSNumber == finalSourceAttributes[.size] as? NSNumber,
        sourceAttributes[.modificationDate] as? Date == finalSourceAttributes[.modificationDate] as? Date,
        sourceAttributes[.systemFileNumber] as? NSNumber == finalSourceAttributes[.systemFileNumber] as? NSNumber else {
        throw VideoCompressionError.refused("source changed")
      }
      let result = try verifyOutput(outputURL, source: asset, geometry: geometry, options: options)
      guard result.sizeBytes < sourceSize.intValue else { throw VideoCompressionError.refused("not smaller") }
      try checkOperation()
      return result
    } catch {
      reader.cancelReading()
      writer?.cancelWriting()
      do { try FileManager.default.removeItem(at: directory) }
      catch { throw VideoCompressionError.refused("failed to remove rejected output") }
      throw error
    }
  }

  static func localSource(_ uri: String) throws -> URL {
    guard uri.hasPrefix("file:///"), let url = URL(string: uri), url.isFileURL,
      url.host == nil || url.host == "", url.query == nil, url.fragment == nil else {
      throw VideoCompressionError.refused("local file required")
    }
    let resolved = url.resolvingSymlinksInPath().standardizedFileURL
    let values = try resolved.resourceValues(forKeys: [.isRegularFileKey])
    guard values.isRegularFile == true else { throw VideoCompressionError.refused("regular file required") }
    let handle = try FileHandle(forReadingFrom: resolved)
    defer { try? handle.close() }
    let header = try handle.read(upToCount: 12) ?? Data()
    guard header.count == 12, String(data: header[4..<8], encoding: .ascii) == "ftyp" else {
      throw VideoCompressionError.refused("self-contained MP4 or MOV required")
    }
    return resolved
  }

  static func localAsset(_ url: URL) -> AVURLAsset {
    AVURLAsset(url: url, options: [
      AVURLAssetPreferPreciseDurationAndTimingKey: true,
      AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue
    ])
  }

  struct Geometry {
    let encodedWidth: Int
    let encodedHeight: Int
    let width: Int
    let height: Int
    let transform: CGAffineTransform
  }

  static func outputGeometry(track: AVAssetTrack, longEdge: Int) throws -> Geometry {
    let size = track.naturalSize
    let transform = track.preferredTransform
    guard size.width.isFinite, size.height.isFinite, min(size.width, size.height) >= 2,
      max(size.width, size.height) <= 8192,
      [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].allSatisfy({ $0.isFinite }),
      abs(abs(transform.a * transform.d - transform.b * transform.c) - 1) < 0.001,
      [transform.a, transform.b, transform.c, transform.d].allSatisfy({ abs($0 - $0.rounded()) < 0.001 && abs($0) <= 1 }),
      abs(transform.a * transform.c + transform.b * transform.d) < 0.001 else {
      throw VideoCompressionError.refused("unsupported video geometry")
    }
    let scale = min(1, Double(longEdge) / max(size.width, size.height))
    let width = Int(floor(size.width * scale / 2)) * 2
    let height = Int(floor(size.height * scale / 2)) * 2
    guard min(width, height) >= 2 else { throw VideoCompressionError.refused("empty output geometry") }
    let linear = CGAffineTransform(a: transform.a, b: transform.b, c: transform.c, d: transform.d, tx: 0, ty: 0)
    let bounds = CGRect(x: 0, y: 0, width: width, height: height).applying(linear)
    return Geometry(
      encodedWidth: width, encodedHeight: height,
      width: Int(bounds.width.rounded()), height: Int(bounds.height.rounded()),
      transform: linear.concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
    )
  }

  static func verifyOutput(
    _ url: URL, source: AVAsset, geometry: Geometry, options: VideoCompressionOptions
  ) throws -> VideoCompressionResult {
    let asset = localAsset(url)
    let videos = asset.tracks(withMediaType: .video)
    let audios = asset.tracks(withMediaType: .audio)
    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard videos.count == 1, audios.count == source.tracks(withMediaType: .audio).count else {
      throw VideoCompressionError.refused("output track count")
    }
    guard asset.duration.isNumeric, abs(asset.duration.seconds - source.duration.seconds) <= 0.08 else {
      throw VideoCompressionError.refused("output duration")
    }
    guard size > 0, Double(size) * 8 / asset.duration.seconds <= Double(options.maxBitrateBps) else {
      throw VideoCompressionError.refused("output bitrate: \(Double(size) * 8 / asset.duration.seconds)")
    }
    guard let format = (videos[0].formatDescriptions as! [CMFormatDescription]).first,
      CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_H264 else {
      throw VideoCompressionError.refused("output video codec")
    }
    let display = CGRect(origin: .zero, size: videos[0].naturalSize).applying(videos[0].preferredTransform)
    guard abs(display.width - Double(geometry.width)) < 1, abs(display.height - Double(geometry.height)) < 1,
      max(display.width, display.height) <= Double(options.maxLongEdgePx) else {
      throw VideoCompressionError.refused("output dimensions")
    }
    for audio in audios {
      guard let format = (audio.formatDescriptions as! [CMFormatDescription]).first,
        CMFormatDescriptionGetMediaSubType(format) == kAudioFormatMPEG4AAC else {
        throw VideoCompressionError.refused("output audio codec")
      }
    }
    let metadata = asset.availableMetadataFormats.flatMap { asset.metadata(forFormat: $0) }
      + asset.tracks.flatMap { track in track.availableMetadataFormats.flatMap { track.metadata(forFormat: $0) } }
    guard !metadata.contains(where: { item in
      let key = "\(item.identifier?.rawValue ?? "") \(item.key ?? "" as NSString)".lowercased()
      return key.contains("location") || key.contains("iso6709") || key.contains("gps")
    }) else { throw VideoCompressionError.refused("location metadata") }
    return VideoCompressionResult(uri: url.absoluteString, sizeBytes: size, width: geometry.width, height: geometry.height)
  }
}
