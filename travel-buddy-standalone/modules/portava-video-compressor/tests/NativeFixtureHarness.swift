import AVFoundation
import CryptoKit
import Foundation

struct HarnessFailure: Error, CustomStringConvertible {
  let description: String
}

final class CompressionObservation {
  private let lock = NSLock()
  private var storedResult: Result<VideoCompressionResult, Error>?
  private var started = false
  let completed = DispatchSemaphore(value: 0)

  func markStarted() {
    lock.lock()
    started = true
    lock.unlock()
  }

  func record(_ result: Result<VideoCompressionResult, Error>) {
    lock.lock()
    storedResult = result
    lock.unlock()
    completed.signal()
  }

  var result: Result<VideoCompressionResult, Error>? {
    lock.lock()
    defer { lock.unlock() }
    return storedResult
  }

  var operationStarted: Bool {
    lock.lock()
    defer { lock.unlock() }
    return started
  }

  var rejected: Bool {
    if case .failure? = result { return true }
    return false
  }
}

func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw HarnessFailure(description: message) }
}

func statusOK(_ status: OSStatus, _ message: String) throws {
  try expect(status == noErr, "\(message): \(status)")
}

func waitReady(_ input: AVAssetWriterInput, writer: AVAssetWriter) throws {
  let deadline = ProcessInfo.processInfo.systemUptime + 30
  while !input.isReadyForMoreMediaData {
    try expect(writer.status == .writing, "fixture writer failed: \(String(describing: writer.error))")
    try expect(ProcessInfo.processInfo.systemUptime < deadline, "fixture writer stalled")
    Thread.sleep(forTimeInterval: 0.002)
  }
}

func toneSample(frame: Int, channels: Int) throws -> CMSampleBuffer {
  let sampleCount = 2000
  var audioDescription = AudioStreamBasicDescription(
    mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
    mBytesPerPacket: UInt32(channels * 2), mFramesPerPacket: 1,
    mBytesPerFrame: UInt32(channels * 2), mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 16, mReserved: 0
  )
  var format: CMAudioFormatDescription?
  try statusOK(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &audioDescription,
    layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
    formatDescriptionOut: &format), "audio format")
  let samples: [Int16] = (0..<(sampleCount * channels)).map { index in
    Int16(sin(Double(frame * sampleCount + index / channels) * 2 * .pi * 440 / 48_000) * 10_000)
  }
  var block: CMBlockBuffer?
  try statusOK(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
    blockLength: samples.count * 2, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
    offsetToData: 0, dataLength: samples.count * 2, flags: 0, blockBufferOut: &block), "audio block")
  try samples.withUnsafeBytes { bytes in
    try statusOK(CMBlockBufferReplaceDataBytes(with: bytes.baseAddress!, blockBuffer: block!,
      offsetIntoDestination: 0, dataLength: bytes.count), "audio bytes")
  }
  var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000),
    presentationTimeStamp: CMTime(value: Int64(frame * sampleCount), timescale: 48_000), decodeTimeStamp: .invalid)
  var sampleSize = channels * 2
  var sample: CMSampleBuffer?
  try statusOK(CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block,
    formatDescription: format, sampleCount: sampleCount, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
    sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize, sampleBufferOut: &sample), "audio sample")
  return sample!
}

func makeFixture(
  at url: URL, width: Int, height: Int, transform: CGAffineTransform = .identity,
  codec: AVVideoCodecType = .h264, channels: Int = 2, bitrate: Int = 24_000_000,
  noise: Bool = true, noiseBlockSize: Int = 8, keyFrameInterval: Int = 1
) throws {
  let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
  let location = AVMutableMetadataItem()
  location.identifier = .quickTimeMetadataLocationISO6709
  location.value = "+12.3456+045.6789/" as NSString
  location.dataType = kCMMetadataBaseDataType_UTF8 as String
  writer.metadata = [location]
  let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: codec, AVVideoWidthKey: width, AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bitrate, AVVideoAllowFrameReorderingKey: false,
      AVVideoMaxKeyFrameIntervalKey: keyFrameInterval]
  ])
  video.transform = transform
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
    kCVPixelBufferIOSurfacePropertiesKey as String: [:]
  ])
  writer.add(video)
  var audio: AVAssetWriterInput?
  if channels > 0 {
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
      AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
      AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: channels == 1 ? 64_000 : 128_000
    ])
    writer.add(input)
    audio = input
  }
  try expect(writer.startWriting(), "fixture start: \(String(describing: writer.error))")
  writer.startSession(atSourceTime: .zero)
  for frame in 0..<24 {
    try autoreleasepool {
      try waitReady(video, writer: writer)
      var pixel: CVPixelBuffer?
      try statusOK(CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, adaptor.pixelBufferPool!, &pixel), "pixel allocation")
      CVPixelBufferLockBaseAddress(pixel!, [])
      let base = CVPixelBufferGetBaseAddress(pixel!)!.assumingMemoryBound(to: UInt8.self)
      let stride = CVPixelBufferGetBytesPerRow(pixel!)
      for row in 0..<height {
        for column in 0..<width {
          let offset = row * stride + column * 4
          let corner = (row < height / 4 || row >= height * 3 / 4)
            && (column < width / 4 || column >= width * 3 / 4)
          if corner || !noise {
            base[offset] = row < height / 2 ? 15 : 230
            base[offset + 1] = column < width / 2 ? 15 : 230
            base[offset + 2] = row < height / 2 ? 230 : 15
          } else {
            let temporalOffset = noiseBlockSize == 1 ? frame * width * height : 0
            var random = UInt32(temporalOffset + (row / noiseBlockSize) * width + (column + frame * 4) / noiseBlockSize)
            random = (random ^ (random >> 16)) &* 0x45d9f3b
            random = (random ^ (random >> 16)) &* 0x45d9f3b
            random ^= random >> 16
            base[offset] = UInt8(truncatingIfNeeded: random)
            base[offset + 1] = UInt8(truncatingIfNeeded: random >> 8)
            base[offset + 2] = UInt8(truncatingIfNeeded: random >> 16)
          }
          base[offset + 3] = 255
        }
      }
      CVPixelBufferUnlockBaseAddress(pixel!, [])
      try expect(adaptor.append(pixel!, withPresentationTime: CMTime(value: Int64(frame), timescale: 24)),
        "fixture frame: \(String(describing: writer.error))")
      if let audio {
        try waitReady(audio, writer: writer)
        try expect(audio.append(try toneSample(frame: frame, channels: channels)), "fixture tone")
      }
    }
  }
  video.markAsFinished()
  audio?.markAsFinished()
  writer.endSession(atSourceTime: CMTime(value: 1, timescale: 1))
  let done = DispatchSemaphore(value: 0)
  writer.finishWriting { done.signal() }
  try expect(done.wait(timeout: .now() + 30) == .success, "fixture finish timeout")
  try expect(writer.status == .completed, "fixture finish: \(String(describing: writer.error))")
}

func cornerPixels(_ url: URL) throws -> [UInt8] {
  let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
  generator.appliesPreferredTrackTransform = true
  let image = try generator.copyCGImage(at: CMTime(value: 1, timescale: 2), actualTime: nil)
  var bytes = [UInt8](repeating: 0, count: 64 * 64 * 4)
  bytes.withUnsafeMutableBytes { buffer in
    let context = CGContext(data: buffer.baseAddress, width: 64, height: 64, bitsPerComponent: 8,
      bytesPerRow: 64 * 4, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: 64, height: 64))
  }
  return [(8, 8), (55, 8), (8, 55), (55, 55)].flatMap { point in
    let offset = (point.1 * 64 + point.0) * 4
    return Array(bytes[offset..<(offset + 3)])
  }
}

func verifyDecodedAudio(_ asset: AVAsset, channels: Int) throws {
  let tracks = asset.tracks(withMediaType: .audio)
  try expect(tracks.count == (channels > 0 ? 1 : 0), "audio track presence")
  guard let track = tracks.first else { return }
  let format = (track.formatDescriptions as! [CMFormatDescription])[0]
  try expect(CMFormatDescriptionGetMediaSubType(format) == kAudioFormatMPEG4AAC, "AAC codec")
  let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)!.pointee
  try expect(description.mChannelsPerFrame == channels, "audio channels retained")
  let reader = try AVAssetReader(asset: asset)
  let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false, AVLinearPCMIsNonInterleaved: false
  ])
  reader.add(output)
  try expect(reader.startReading(), "audio decode starts")
  var frameCount = 0
  var energy = 0.0
  var crossings = 0
  var previous: Int16 = 0
  while let sample = output.copyNextSampleBuffer() {
    guard let data = CMSampleBufferGetDataBuffer(sample) else { throw HarnessFailure(description: "audio bytes missing") }
    var bytes = [Int16](repeating: 0, count: CMBlockBufferGetDataLength(data) / 2)
    try bytes.withUnsafeMutableBytes { buffer in
      try statusOK(CMBlockBufferCopyDataBytes(data, atOffset: 0, dataLength: buffer.count,
        destination: buffer.baseAddress!), "decode audio bytes")
    }
    for index in stride(from: 0, to: bytes.count, by: channels) {
      let value = bytes[index]
      energy += pow(Double(value) / 32_768, 2)
      if previous < 0 && value >= 0 { crossings += 1 }
      previous = value
      frameCount += 1
    }
  }
  try expect(reader.status == .completed, "audio decode completes")
  try expect(frameCount >= 46_000 && frameCount <= 50_500, "audio duration preserved: \(frameCount)")
  try expect(sqrt(energy / Double(frameCount)) > 0.1, "audio was not silenced")
  try expect((420...465).contains(crossings), "440Hz tone retained: \(crossings)")
}

func verifyResult(_ result: VideoCompressionResult, source: URL, channels: Int, policy: VideoCompressionOptions) throws {
  let output = URL(string: result.uri)!
  let bytes = try Data(contentsOf: output)
  try expect(output != source, "distinct output")
  try expect(bytes.count == result.sizeBytes && bytes.count > 0, "measured output bytes")
  try expect(String(data: bytes[4..<8], encoding: .ascii) == "ftyp", "MP4 container")
  try expect(String(data: bytes[8..<12], encoding: .ascii) == "mp42", "actual MPEG-4 container brand")
  try expect(!bytes.contains(Data("+12.3456+045.6789/".utf8)), "location value removed from actual bytes")
  let asset = AVURLAsset(url: output)
  let video = asset.tracks(withMediaType: .video)[0]
  let format = (video.formatDescriptions as! [CMFormatDescription])[0]
  try expect(CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_H264, "H.264 output")
  let display = CGRect(origin: .zero, size: video.naturalSize).applying(video.preferredTransform)
  try expect(Int(display.width.rounded()) == result.width && Int(display.height.rounded()) == result.height,
    "reported displayed geometry")
  try expect(max(result.width, result.height) <= policy.maxLongEdgePx, "display ceiling")
  try expect(abs(asset.duration.seconds - 1) <= 0.05, "duration retained: \(asset.duration.seconds)")
  try expect(Double(bytes.count) * 8 / asset.duration.seconds <= Double(policy.maxBitrateBps), "total bitrate ceiling")
  let before = try cornerPixels(source)
  let after = try cornerPixels(output)
  try expect(zip(before, after).allSatisfy { abs(Int($0) - Int($1)) < 38 }, "decoded orientation/color corners retained")
  try verifyDecodedAudio(asset, channels: channels)
  let reader = try AVAssetReader(asset: asset)
  let frames = AVAssetReaderTrackOutput(track: video, outputSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
  ])
  reader.add(frames)
  try expect(reader.startReading(), "video decode starts")
  var count = 0
  while frames.copyNextSampleBuffer() != nil { count += 1 }
  try expect(reader.status == .completed && count == 24, "all 24 frames decode: \(count)")
  let permissions = try FileManager.default.attributesOfItem(atPath: output.path)[.posixPermissions] as! NSNumber
  let directoryPermissions = try FileManager.default.attributesOfItem(atPath: output.deletingLastPathComponent().path)[.posixPermissions] as! NSNumber
  try expect(permissions.intValue == 0o600 && directoryPermissions.intValue == 0o700, "private output permissions")
  let metadata = asset.availableMetadataFormats.flatMap { asset.metadata(forFormat: $0) }
  try expect(!metadata.contains { $0.identifier == .quickTimeMetadataLocationISO6709 }, "location metadata stripped")
  print("MEASURE \(source.lastPathComponent) output=\(result.sizeBytes) pixels=\(result.width)x\(result.height) duration=\(asset.duration.seconds) bps=\(Double(bytes.count) * 8 / asset.duration.seconds)")
}

@main
struct NativeFixtureHarness {
  static func main() {
    setbuf(stdout, nil)
    do { try run() }
    catch {
      fputs("NATIVE CORE FAILURE: \(error)\n", stderr)
      exit(1)
    }
  }

  static func run() throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let outputs = root.appendingPathComponent("outputs", isDirectory: true)
    try FileManager.default.createDirectory(at: outputs, withIntermediateDirectories: true)
    let policy = VideoCompressionOptions(maxBitrateBps: 4_000_000, maxLongEdgePx: 1920)
    var passed = 0
    func test(_ name: String, _ body: () throws -> Void) throws {
      do {
        try autoreleasepool { try body() }
        passed += 1
        print("PASS \(name)")
      } catch {
        print("FAIL \(name): \(error)")
        throw error
      }
    }
    let fixtures: [(String, Int, Int, CGAffineTransform, AVVideoCodecType, Int)] = [
      ("landscape-h264", 1920, 1080, .identity, .h264, 2),
      ("portrait-90-hevc-4k", 3840, 2160, CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 2160, ty: 0), .hevc, 2),
      ("rotated-180-mono", 960, 540, CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: 960, ty: 540), .h264, 1),
      ("portrait-270-silent", 1280, 720, CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: 1280), .h264, 0),
      ("mirrored-silent", 960, 540, CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: 960, ty: 0), .h264, 0)
    ]
    for (name, width, height, transform, codec, channels) in fixtures {
      try test(name) {
        let source = root.appendingPathComponent(name + ".mov")
        try makeFixture(at: source, width: width, height: height, transform: transform, codec: codec, channels: channels)
        let sourceBytes = try Data(contentsOf: source)
        try expect(sourceBytes.contains(Data("+12.3456+045.6789/".utf8)), "fixture genuinely contains location")
        let sourceHash = SHA256.hash(data: sourceBytes)
        let result = try VideoCompressionCore.compress(uri: source.absoluteString, options: policy, temporaryRoot: outputs)
        try verifyResult(result, source: source, channels: channels, policy: policy)
        try expect(result.sizeBytes < sourceBytes.count, "copy is smaller")
        try expect(SHA256.hash(data: try Data(contentsOf: source)) == sourceHash, "source bytes untouched")
        try FileManager.default.removeItem(at: URL(string: result.uri)!.deletingLastPathComponent())
      }
    }
    let source = root.appendingPathComponent("landscape-h264.mov")
    try test("queued admission remains cancelled after background and foreground") {
      let sourceHash = SHA256.hash(data: try Data(contentsOf: source))
      let scheduler = VideoCompressionScheduler()
      let first = CompressionObservation()
      let second = CompressionObservation()
      let fresh = CompressionObservation()
      let paused = DispatchSemaphore(value: 0)
      let release = DispatchSemaphore(value: 0)
      defer { release.signal() }
      scheduler.submit(operation: { isCancelled in
        first.markStarted()
        var checks = 0
        return try VideoCompressionCore.compress(uri: source.absoluteString, options: policy, temporaryRoot: outputs,
          isCancelled: {
            checks += 1
            if checks == 8 {
              paused.signal()
              if release.wait(timeout: .now() + 30) != .success { return true }
            }
            return isCancelled()
          })
      }, completion: first.record)
      try expect(paused.wait(timeout: .now() + 30) == .success, "first encoder reached deterministic barrier")
      try expect(try !FileManager.default.contentsOfDirectory(atPath: outputs.path).isEmpty,
        "first encode has an actual partial output")
      scheduler.submit(operation: { isCancelled in
        second.markStarted()
        return try VideoCompressionCore.compress(uri: source.absoluteString, options: policy,
          temporaryRoot: outputs, isCancelled: isCancelled)
      }, completion: second.record)
      scheduler.suspend()
      scheduler.resume()
      release.signal()
      try expect(first.completed.wait(timeout: .now() + 30) == .success, "first request settled")
      try expect(second.completed.wait(timeout: .now() + 30) == .success, "queued request settled")
      try expect(first.rejected && second.rejected, "both pre-background requests must reject")
      try expect(first.operationStarted && !second.operationStarted, "queued request never starts decode or allocation")
      try expect(try FileManager.default.contentsOfDirectory(atPath: outputs.path).isEmpty, "partial output removed")
      try expect(SHA256.hash(data: try Data(contentsOf: source)) == sourceHash, "cancelled originals unchanged")
      scheduler.submit(operation: { isCancelled in
        fresh.markStarted()
        return try VideoCompressionCore.compress(uri: source.absoluteString, options: policy,
          temporaryRoot: outputs, isCancelled: isCancelled)
      }, completion: fresh.record)
      try expect(fresh.completed.wait(timeout: .now() + 30) == .success, "fresh foreground request settled")
      guard case .success(let output)? = fresh.result else {
        throw HarnessFailure(description: "fresh foreground request must encode")
      }
      try verifyResult(output, source: source, channels: 2, policy: policy)
      try FileManager.default.removeItem(at: URL(string: output.uri)!.deletingLastPathComponent())
    }
    try test("background admission and destroyed scheduler remain closed") {
      let scheduler = VideoCompressionScheduler()
      let background = CompressionObservation()
      let destroyed = CompressionObservation()
      scheduler.suspend()
      scheduler.submit(operation: { isCancelled in
        background.markStarted()
        return try VideoCompressionCore.compress(uri: source.absoluteString, options: policy,
          temporaryRoot: outputs, isCancelled: isCancelled)
      }, completion: background.record)
      scheduler.resume()
      scheduler.invalidate()
      scheduler.resume()
      scheduler.submit(operation: { isCancelled in
        destroyed.markStarted()
        return try VideoCompressionCore.compress(uri: source.absoluteString, options: policy,
          temporaryRoot: outputs, isCancelled: isCancelled)
      }, completion: destroyed.record)
      try expect(background.completed.wait(timeout: .now() + 30) == .success, "background request settled")
      try expect(destroyed.completed.wait(timeout: .now() + 30) == .success, "destroyed request settled")
      try expect(background.rejected && destroyed.rejected, "closed admissions reject")
      try expect(!background.operationStarted && !destroyed.operationStarted, "closed admissions perform no work")
      try expect(try FileManager.default.contentsOfDirectory(atPath: outputs.path).isEmpty, "closed admissions leave no output")
    }
    func expectRefusal(_ name: String, _ action: () throws -> Void) throws {
      try test(name) {
        var refused = false
        do { try action() } catch is VideoCompressionError { refused = true } catch is CocoaError { refused = true }
        try expect(refused, "operation must refuse")
        try expect(try FileManager.default.contentsOfDirectory(atPath: outputs.path).isEmpty, "rejected output cleaned")
      }
    }
    try test("lower requested ceilings") {
      let smallerPolicy = VideoCompressionOptions(maxBitrateBps: 1_000_000, maxLongEdgePx: 640)
      let result = try VideoCompressionCore.compress(uri: source.absoluteString, options: smallerPolicy, temporaryRoot: outputs)
      try verifyResult(result, source: source, channels: 2, policy: smallerPolicy)
      try FileManager.default.removeItem(at: URL(string: result.uri)!.deletingLastPathComponent())
    }
    for uri in ["https://example.invalid/video.mp4", "file://host/video.mp4", "file:relative.mp4", source.absoluteString + "?token=x"] {
      try expectRefusal("nonlocal or ambiguous URI \(uri)") {
        _ = try VideoCompressionCore.compress(uri: uri, options: policy, temporaryRoot: outputs)
      }
    }
    for invalidPolicy in [VideoCompressionOptions(maxBitrateBps: 4_000_001, maxLongEdgePx: 1920),
      VideoCompressionOptions(maxBitrateBps: 4_000_000, maxLongEdgePx: 1921),
      VideoCompressionOptions(maxBitrateBps: 0, maxLongEdgePx: 0)] {
      try expectRefusal("invalid policy") {
        _ = try VideoCompressionCore.compress(uri: source.absoluteString, options: invalidPolicy, temporaryRoot: outputs)
      }
    }
    let corrupt = root.appendingPathComponent("corrupt.mp4")
    try Data("not an MP4".utf8).write(to: corrupt)
    try expectRefusal("corrupt source") {
      _ = try VideoCompressionCore.compress(uri: corrupt.absoluteString, options: policy, temporaryRoot: outputs)
    }
    try expectRefusal("missing source") {
      _ = try VideoCompressionCore.compress(uri: root.appendingPathComponent("missing.mp4").absoluteString,
        options: policy, temporaryRoot: outputs)
    }
    try expectRefusal("unwritable output root") {
      _ = try VideoCompressionCore.compress(uri: source.absoluteString, options: policy, temporaryRoot: corrupt)
    }
    try expectRefusal("timeout") {
      _ = try VideoCompressionCore.compress(uri: source.absoluteString, options: policy, temporaryRoot: outputs, timeLimit: 0)
    }
    try expectRefusal("cancellation after encoding begins") {
      var checks = 0
      var sawPartialOutput = false
      do {
        _ = try VideoCompressionCore.compress(uri: source.absoluteString, options: policy, temporaryRoot: outputs,
          isCancelled: {
            checks += 1
            sawPartialOutput = sawPartialOutput || ((try? FileManager.default.contentsOfDirectory(atPath: outputs.path).isEmpty) == false)
            return checks > 10
          })
      } catch {
        try expect(sawPartialOutput, "cancel actually reached native output allocation")
        throw error
      }
    }
    try test("cleanup denial is surfaced without returning an output") {
      defer {
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: outputs.path)
        if let remaining = try? FileManager.default.contentsOfDirectory(at: outputs, includingPropertiesForKeys: nil) {
          for entry in remaining { try? FileManager.default.removeItem(at: entry) }
        }
      }
      var checks = 0
      var denied = false
      var reported = false
      do {
        _ = try VideoCompressionCore.compress(uri: source.absoluteString, options: policy, temporaryRoot: outputs,
          isCancelled: {
            checks += 1
            if checks > 10 {
              do {
                try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: outputs.path)
                denied = true
              } catch { return true }
              return true
            }
            return false
          })
      } catch VideoCompressionError.refused(let reason) {
        reported = reason == "failed to remove rejected output"
      }
      try expect(denied && reported, "real filesystem cleanup failure must be reported")
      try expect(try !FileManager.default.contentsOfDirectory(atPath: outputs.path).isEmpty,
        "failed cleanup is not falsely reported as removed")
    }
    let efficient = root.appendingPathComponent("already-small.mov")
    try makeFixture(at: efficient, width: 320, height: 180, codec: .hevc, channels: 0,
      bitrate: 50_000, noise: false, keyFrameInterval: 240)
    try test("non-smaller output is deleted") {
      var currentSource = efficient
      var refused = false
      for generation in 0..<6 {
        let beforeSize = try Data(contentsOf: currentSource).count
        do {
          let result = try VideoCompressionCore.compress(uri: currentSource.absoluteString, options: policy, temporaryRoot: outputs)
          try expect(result.sizeBytes < beforeSize, "never return a non-smaller output")
          let nextSource = root.appendingPathComponent("efficient-\(generation).mp4")
          try FileManager.default.copyItem(at: URL(string: result.uri)!, to: nextSource)
          try FileManager.default.removeItem(at: URL(string: result.uri)!.deletingLastPathComponent())
          currentSource = nextSource
        } catch VideoCompressionError.refused(let reason) where reason == "not smaller" {
          refused = true
          break
        }
      }
      try expect(refused, "equivalent efficient encode must be refused")
      try expect(try FileManager.default.contentsOfDirectory(atPath: outputs.path).isEmpty, "non-smaller output cleaned")
    }
    try test("pathological entropy never escapes bitrate ceiling") {
      let noisy = root.appendingPathComponent("pixel-noise.mov")
      try makeFixture(at: noisy, width: 1920, height: 1080, channels: 2, noiseBlockSize: 1)
      do {
        let result = try VideoCompressionCore.compress(uri: noisy.absoluteString, options: policy, temporaryRoot: outputs)
        try verifyResult(result, source: noisy, channels: 2, policy: policy)
        try FileManager.default.removeItem(at: URL(string: result.uri)!.deletingLastPathComponent())
      } catch let error as VideoCompressionError {
        print("SAFE REFUSAL \(error)")
      }
      try expect(try FileManager.default.contentsOfDirectory(atPath: outputs.path).isEmpty, "pathological output cleaned")
    }
    print("NATIVE CORE RESULT: \(passed) passed; actual AVFoundation fixtures, no Expo stubs")
  }
}
