import Foundation

final class VideoCompressionScheduler {
  private let queue = DispatchQueue(label: "com.portava.video-compressor", qos: .userInitiated)
  private let lock = NSLock()
  private var generation: UInt64 = 0
  private var suspended = false
  private var destroyed = false

  func submit(
    operation: @escaping (@escaping () -> Bool) throws -> VideoCompressionResult,
    completion: @escaping (Result<VideoCompressionResult, Error>) -> Void
  ) {
    lock.lock()
    let token = generation
    let admitted = !suspended && !destroyed
    lock.unlock()
    guard admitted else {
      completion(.failure(VideoCompressionError.refused("request not admitted")))
      return
    }
    queue.async {
      let isCancelled = { self.isCancelled(token: token) }
      guard !isCancelled() else {
        completion(.failure(VideoCompressionError.refused("queued request cancelled")))
        return
      }
      do { completion(.success(try operation(isCancelled))) }
      catch { completion(.failure(error)) }
    }
  }

  func suspend() {
    lock.lock()
    generation &+= 1
    suspended = true
    lock.unlock()
  }

  func resume() {
    lock.lock()
    if !destroyed { suspended = false }
    lock.unlock()
  }

  func invalidate() {
    lock.lock()
    generation &+= 1
    destroyed = true
    suspended = true
    lock.unlock()
  }

  private func isCancelled(token: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return suspended || destroyed || generation != token
  }
}
