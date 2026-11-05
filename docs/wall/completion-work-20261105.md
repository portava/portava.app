# Wall completion work — 5 November 2026

Scope: the user's request to finish all agent-buildable Wall work. Changes remain in the shared local checkout. No production writes, release build, flag activation, paid provider or earnings activation occurred. This note supersedes the implementation gap in census-wall §25; it does not substitute for real-device acceptance or change the census percentages.

## On-device speech producer

`travel-buddy-standalone/modules/portava-on-device-speech` is an owned Expo module, bootstrapped by `app/_layout.tsx` through `src/platform/input-assistance/voice/installOnDeviceSpeech.ts`. It implements the existing shared recognizer port; Wall continues to use the same intake/typo engine as typed text. A final transcript fills the steer field for review and does not submit an action automatically.

The optional module registration itself requests no permissions and captures no audio. Absent modules, unsupported devices, missing models and permission denial remain explicit unavailable/error outcomes. Existing feature flags are unchanged. No cloud recognizer, network transcription provider, model download API, audio file writer or raw-audio telemetry path exists in this module.

- iOS builds an `SFSpeechRecognizer` for the exact selected locale, verifies `supportsOnDeviceRecognition` and `isAvailable`, and sets `requiresOnDeviceRecognition` on every audio-buffer request. Speech and microphone permission prompts occur only after an explicit capture request. The usage strings describe this purpose.
- Android requires API 33 or newer, uses only `createOnDeviceSpeechRecognizer`, and checks the exact selected locale against `RecognitionSupport.installedOnDeviceLanguages`. Supported-but-not-installed models do not qualify. API 31/32 stay unavailable because this implementation cannot establish selected-language installation there. It never falls back to `createSpeechRecognizer` or downloads a model.
- Both engines validate bounded request IDs, BCP-47 locale shape and a maximum 60-second lease. Wall-clock and monotonic deadlines independently bound the session. Release stops capture and allows at most 1.5 seconds for the OS final result. Background/destruction cancel immediately. Generation checks prevent deferred permission or recognizer callbacks restarting an ended capture. Every terminal path sends an end event and cleans up native resources.
- The JS adapter serializes captures per native module, bounds capability and terminal waits, filters events by request ID, ignores late sessions, handles release while permission is pending and cleans listeners. Missing confidence remains low confidence; it never invents certainty to bypass shared intake rules.

Local JS proof: `/tmp/portava-speech-client-tests-final.log` — 26/26 across the new native-adapter suite and mounted Wall push-to-talk suite. The mounted bridge test uses the real adapter → shared resolver → Wall control → hook → intake → text field path. The OS is the injected boundary, so this does not claim microphone or offline-device proof. API and native source typechecks pass (`/tmp/portava-wall-api-types.log`, `/tmp/portava-speech-client-types-final.log`); mock lint passes. The test typecheck has no new diagnostics; a separate uploadUrl fix lowered the shared baseline from 151/58 to 150/57 and the integration owner controls re-recording it.

Native compilation and runnable policy proof are recorded in the module README after the real Expo/SDK validations finish. Both platform autolink resolvers include the module, and Expo public configuration contains the intended speech and microphone usage strings (`/tmp/portava-speech-autolink-ios.json`, `/tmp/portava-speech-autolink-android.json`, `/tmp/portava-speech-expo-config.json`). The module also contains three Android JVM policy tests and three Swift policy fixture groups for locale/session validation and independent clock expiry.

## Current Wall author policy

`WallProjectionService.projectObjects` now checks current canonical account restrictions and private-author audience before exposing any post-like actor, text or media metadata. It uses the shared batched `filterCurrentPostAuthors` guard in parallel with place and block checks. A public post's old visibility and a cached follow graph cannot override a newly private author. A current approved follow restores access; a canonical ban or suspension removes it even when `profiles.account_status` is still `active`. Separately authorized non-post objects retain their existing consent/membership policy.

The same guard runs for normal feeds and `/wall/revalidate`. An unreadable author-policy query throws into the existing projection degradation path; it does not become a healthy empty social feed. Cache revalidation fails closed. Tests exercise stale follow metadata, approved follow restoration, banned/suspended/expired author state, own-author restriction, malformed state and read failure.

Initial targeted API proof: `/tmp/portava-wall-current-author-tests.log` — 63/63, including real loopback HTTP revalidation and degraded-feed responses. Broader feed-mode integration: `/tmp/portava-wall-integration-final.log` — 190/190 across 18 suites, zero skips, covering both feeds, candidate loaders, discovery insertions, publish gates, read completeness, quick media, Moments, intent steering, cursors and engagement. No schema migration was needed for this correction.

## Evidence that still needs the release/operator environment

W71/G163 require actual offline speech, selected locales, permission denial/release/background transitions and OS microphone-indicator checks on the supported iOS and Android device matrix. Native compilation, policy tests and injected bridge events cannot establish those facts. Do not enable cloud fallback to make unsupported-device tests appear successful.

The remaining Wall census requirements are W146 production first-page p50/p95, W149 frames on a named device, W159/W167 dated design judgment, and W168 comprehension with 5–8 unfamiliar users. Existing measurement procedures live under `docs/wall/measurement`. These are measurement/review requirements, not unimplemented Wall features; no synthetic acceptance or percentage increase is recorded here.

Platform contracts consulted: [Apple selected recognizer capability](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition), [Apple local-only request](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition), [Android SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer), and [Android installed-language support](https://developer.android.com/reference/android/speech/RecognitionSupport).

### Native iOS validation completed

`/tmp/portava-speech-ios-proof-3/evidence.json`: the frozen Swift module and Expo bridge compiled as a whole-module object against real ExpoModulesCore and the iPhoneSimulator27.2 Apple Speech/AVFoundation frameworks, with an iOS 15.1 deployment target. All 3 executable Swift policy groups passed. The evidence includes hashes for `PortavaOnDeviceSpeechModule.swift`, `SpeechLease.swift` and the fixture and explicitly records `physicalDevice:false`. The reproducible runner is `travel-buddy-standalone/modules/portava-on-device-speech/tests/run-ios-fixtures.py`; invocation and environment prerequisites are in the module README. This does not establish actual speech recognition or physical microphone behavior. Android proof is recorded below.

### Native Android validation completed

`/tmp/portava-speech-android-evidence.json`: the actual Android Expo bridge compiled against the real SDK, and all 3 JVM tests passed with zero errors/failures. Evidence contains hashes of the frozen module, lease and test sources plus the JUnit result directory. The speech compile/test tasks passed independently of unrelated OpenMLS dependency work in the shared validation app. `physicalDevice:false` remains explicit: this result establishes native compilation and policy execution, not recognition, permission UI or microphone behavior. All agent-buildable implementation and local verification in this Wall lane is complete.

## Local visual decisions and screenshot fixes

The 2026-11-05 AI/local visual review inspected 50 actual-renderer Wall fixtures across five widths and both typical/ceiling density, using real icons and local repository media. It found and fixed low-contrast place text and actions on Video cards. W159 spacing/distinction and W167's existing three-chip/one-thread ceiling are accepted for the reviewed browser proxy; no census or percentage was promoted. The full answers, source hashes, screenshot reconciliation, and native/human evidence boundaries are in [the dated review](measurement/20261105-local-visual-review.md). The regenerated certification digest is `c910833f6aa8570d`.
