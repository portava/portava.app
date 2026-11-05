# Portava on-device speech

Owned Expo module for a foreground, user-initiated, bounded dictation session. The app's shared speech registry is the only bootstrap; no OS permission prompt or microphone access occurs at import. No paid/cloud provider, model downloader or audio-file storage is used.

## Bridge

- `capabilities(language)` → `{available, onDeviceOnly:true}`. No permission prompt. Android API 33+ requires the exact selected locale already installed. iOS requires that exact locale's recognizer to support on-device recognition.
- `start({requestId, language, expiresAtMs})` → permission and native capture; expiry must be within 60 seconds. Single current session; replacement cancels the old request.
- `stop({requestId})` → stop the matching microphone immediately; final result/end bounded to 1.5 seconds. A late stop cannot terminate another request.
- `onResult {requestId,text,isFinal,confidence?}` and `onEnd {requestId,error?}`. No audio or device identifiers in events. Text stays in the shared input workflow; this module does not log it.

The OS result is authoritative. An unavailable or low-confidence transcript remains unavailable/refused through the existing shared intake. No invented confidence, placeholder text or cloud fallback.

Native lifetime checks survive JS suspension. Background/destruction cancels, expiry uses monotonic and wall-clock guards, and delayed permission/result callbacks are fenced by a generation token. Releasing while a permission prompt is active cancels; permission completion does not restart capture. Hold again to start a new session.

## Local validation and release proof

Android policy tests: `android/src/test/java/com/portava/input/speech/SpeechLeaseTest.kt` (3). Swift policy fixtures: `tests/speech-policy-fixtures.swift` (3 groups). They cover exact installed locale decisions, malformed or excessive requests, and wall/monotonic expiry. Full native validation evidence is appended by the integration owner.

Before release, record real-device evidence for supported iOS locales and Android API 33+ installed/missing selected languages, airplane-mode operation, deny/grant permission, immediate release during permission/startup, switch/background/unmount, 60-second limit, error then retry, and microphone indicator clearing. API 31/32 and missing selected-language models must remain unavailable. Simulator or injected-event results are not physical microphone proof.

Contracts: [Apple on-device support](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition), [Apple requiresOnDeviceRecognition](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition), [Android SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer), [Android RecognitionSupport](https://developer.android.com/reference/android/speech/RecognitionSupport).

### Real iOS bridge validation (5 November)

`/tmp/portava-speech-ios-proof-3/evidence.json` records a successful whole-module object compilation of the frozen engine and bridge against the real, current-compiler ExpoModulesCore and Apple Speech/AVFoundation SDKs (iPhoneSimulator27.2, arm64 target with iOS 15.1 deployment floor). It also records 3 passing native policy groups and SHA-256 hashes for both engine source files and the fixture. `physicalDevice` is explicitly false; this is native compilation and executable policy proof, not recognized speech or microphone proof.

The checked-in `tests/run-ios-fixtures.py` reproduces that validation using an already-built Expo core. It installs no dependencies and requires a fresh output directory outside source:

```sh
python3 modules/portava-on-device-speech/tests/run-ios-fixtures.py \
  --output /tmp/portava-speech-ios-proof-next \
  --expo-products /tmp/portava-nearby-ios-validation/products/Debug-iphonesimulator/ExpoModulesCore \
  --clang-response-file /tmp/portava-nearby-ios-validation/intermediates/Pods.build/Debug-iphonesimulator/ExpoModulesCore.build/Objects-normal/arm64/82b82416624d2658e5098eb0a28c15c5-common-args.resp
```

Run from `travel-buddy-standalone`. Other machines must supply their own current ExpoModulesCore product directory and the matching Xcode clang response file; the runner uses their real header/module maps rather than an Expo shim. Its evidence JSON binds the result to the actual source hashes.

### Real Android bridge validation (5 November)

`/tmp/portava-speech-android-evidence.json` records successful compilation of the actual Expo module and 3 passing JVM tests with zero errors/failures. It binds the result to SHA-256 hashes of both Kotlin sources and `SpeechLeaseTest.kt`; `physicalDevice` is false. The JUnit XML is under `/tmp/portava-android-toolchain/validation-app/android/.validation-build/portava-on-device-speech/test-results/testDebugUnitTest`.

The integration validation app includes this local module and ran the Gradle targets `:portava-on-device-speech:compileDebugKotlin` and `:portava-on-device-speech:testDebugUnitTest` against the real Android SDK and Expo dependency. This is build/policy evidence only. Permission prompts, selected installed-model behavior, microphone termination and recognition accuracy still require the documented physical-device matrix.
