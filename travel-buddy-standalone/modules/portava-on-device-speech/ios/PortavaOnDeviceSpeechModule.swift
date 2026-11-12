import ExpoModulesCore
import AVFoundation
import Speech
import UIKit

struct SpeechOptionsRecord: Record {
  @Field var requestId: String = ""
  @Field var language: String = ""
  @Field var expiresAtMs: Double = 0
}
struct SpeechStopRecord: Record { @Field var requestId: String = "" }

public final class PortavaOnDeviceSpeechModule: Module {
  private var foreground = true
  private var generation = 0
  private var lease: SpeechLease?
  private var pending: Promise?
  private var engine: AVAudioEngine?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var activeRecognizer: SFSpeechRecognizer?
  private var tapped = false
  private var sessionActive = false
  private var releasing = false
  private var timer: DispatchSourceTimer?
  private func recognizer(_ language: String) -> SFSpeechRecognizer? {
    guard SpeechLease.validLanguage(language), let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)),
      recognizer.locale.identifier.replacingOccurrences(of: "_", with: "-").lowercased() == language.lowercased(),
      recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else { return nil }
    return recognizer
  }
  private func stopMicrophone() {
    engine?.stop()
    if tapped { engine?.inputNode.removeTap(onBus: 0); tapped = false }
    engine = nil
    request?.endAudio()
    if sessionActive { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation); sessionActive = false }
  }
  private func finish(_ error: String? = nil) {
    guard let old = lease else { return }
    generation += 1; lease = nil; releasing = false
    timer?.cancel(); timer = nil
    stopMicrophone()
    let oldTask = task; task = nil; request = nil; oldTask?.cancel(); activeRecognizer = nil
    pending?.reject("ERR_SPEECH_STOPPED", error ?? "Speech input stopped"); pending = nil
    var event: [String: Any] = ["requestId": old.requestId]
    if let error { event["error"] = error }
    sendEvent("onEnd", event)
  }
  private func release() {
    guard lease != nil, !releasing else { return }
    guard engine != nil else { finish(); return }
    releasing = true
    stopMicrophone()
    let version = generation
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      guard let self, self.generation == version else { return }
      self.finish()
    }
  }
  private func current(_ version: Int) -> Bool {
    generation == version && foreground && UIApplication.shared.applicationState == .active && lease?.live() == true && !releasing
  }
  private func launch(_ version: Int) {
    guard current(version), let currentLease = lease else { if generation == version { finish() }; return }
    guard SFSpeechRecognizer.authorizationStatus() == .authorized,
      AVAudioSession.sharedInstance().recordPermission == .granted else { finish("permission_denied"); return }
    guard let recognizer = recognizer(currentLease.language) else { finish("on_device_unavailable"); return }
    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(.record, mode: .measurement, options: [])
      try audioSession.setActive(true); sessionActive = true
      let audioEngine = AVAudioEngine()
      let speechRequest = SFSpeechAudioBufferRecognitionRequest()
      speechRequest.requiresOnDeviceRecognition = true
      speechRequest.shouldReportPartialResults = true
      speechRequest.taskHint = .dictation
      engine = audioEngine; request = speechRequest; activeRecognizer = recognizer
      let format = audioEngine.inputNode.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else { finish("capture_failed"); return }
      audioEngine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak speechRequest] buffer, _ in
        // In-memory OS request only: no recorder, file, analytics payload or network service.
        speechRequest?.append(buffer)
      }
      tapped = true
      task = recognizer.recognitionTask(with: speechRequest) { [weak self] result, error in
        DispatchQueue.main.async {
          guard let self, self.generation == version, self.lease != nil else { return }
          if let result {
            let text = String(result.bestTranscription.formattedString.prefix(8000))
            let segments = result.bestTranscription.segments
            var event: [String: Any] = ["requestId": currentLease.requestId, "text": text, "isFinal": result.isFinal]
            if !segments.isEmpty { event["confidence"] = segments.reduce(0.0) { $0 + Double($1.confidence) } / Double(segments.count) }
            self.sendEvent("onResult", event)
            if result.isFinal { self.finish(); return }
          }
          if error != nil { self.finish("provider_error") }
        }
      }
      audioEngine.prepare(); try audioEngine.start()
      pending?.resolve(nil); pending = nil
    } catch { finish("capture_failed") }
  }
  private func microphonePermission(_ version: Int) {
    guard current(version) else { if generation == version { finish() }; return }
    switch AVAudioSession.sharedInstance().recordPermission {
    case .granted: launch(version)
    case .undetermined:
      AVAudioSession.sharedInstance().requestRecordPermission { [weak self] _ in
        DispatchQueue.main.async { [weak self] in self?.launch(version) }
      }
    default: finish("permission_denied")
    }
  }
  private func permission(_ version: Int) {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: microphonePermission(version)
    case .notDetermined:
      SFSpeechRecognizer.requestAuthorization { [weak self] status in
        DispatchQueue.main.async {
          guard let self, self.current(version) else { return }
          if status == .authorized { self.microphonePermission(version) }
          else { self.finish("permission_denied") }
        }
      }
    default: finish("permission_denied")
    }
  }
  public func definition() -> ModuleDefinition {
    Name("PortavaOnDeviceSpeech")
    Events("onResult", "onEnd")
    AsyncFunction("capabilities") { (language: String) -> [String: Any] in
      return ["available": self.recognizer(language) != nil, "onDeviceOnly": true]
    }.runOnQueue(.main)
    AsyncFunction("start") { (options: SpeechOptionsRecord, promise: Promise) in
      self.finish("replaced")
      guard self.foreground, UIApplication.shared.applicationState == .active, self.recognizer(options.language) != nil else {
        promise.reject("ERR_SPEECH_UNAVAILABLE", "On-device speech is unavailable for this language"); return
      }
      do {
        self.lease = try SpeechLease(requestId: options.requestId, language: options.language, expiresAtMs: options.expiresAtMs)
        self.pending = promise
        let version = self.generation
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
        timer.setEventHandler { [weak self] in
          guard let self, self.generation == version else { return }
          if self.lease?.live() != true { self.release() }
        }
        self.timer = timer; timer.resume()
        // Exact monotonic cap in addition to the wall-clock jump watchdog.
        let remaining = max(0, (self.lease?.monotonicEnd ?? 0) - ProcessInfo.processInfo.systemUptime)
        DispatchQueue.main.asyncAfter(deadline: .now() + remaining) { [weak self] in
          guard let self, self.generation == version else { return }
          self.release()
        }
        self.permission(version)
      } catch { promise.reject("ERR_SPEECH_OPTIONS", "Speech request is invalid or expired") }
    }.runOnQueue(.main)
    AsyncFunction("stop") { (options: SpeechStopRecord) in if self.lease?.requestId == options.requestId { self.release() } }.runOnQueue(.main)
    OnAppEntersBackground { self.foreground = false; self.finish("background") }
    OnAppEntersForeground { self.foreground = true }
    OnDestroy { DispatchQueue.main.async { self.foreground = false; self.finish("destroyed") } }
    OnAppContextDestroys { DispatchQueue.main.async { self.foreground = false; self.finish("destroyed") } }
  }
}
