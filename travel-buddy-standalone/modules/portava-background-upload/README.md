# Android upload execution

Local Expo module `PortavaBackgroundUpload` supplies the Android transport used by the durable postcard upload queue. It needs a native rebuild; Expo Go does not contain this service. The resumable upload flag remains **OFF** pending integrated app/device acceptance.

The non-exported Android `dataSync` foreground service streams private application files through three native workers and displays progress plus Cancel. Signed PUT destinations must use HTTPS, match the configured Storage origin exactly, and use the signed-upload path. Redirects are refused. Files, task count, staging memory/disk, concurrent workers and HTTP lifetimes are bounded. No bearer token enters this module. Transfer URLs and bytes are not written to a native journal.

Every JS job captures its initiating account/session before asynchronous work. Session replacement aborts native work and pauses the durable job; the new session cannot create, complete or delete the previous owner's shell. Explicit cancellation interrupts the active transport and cleans up under the original session. Notification cancellation stores at most 100 opaque job IDs/timestamps so cancellation still applies if the process exits before JavaScript observes it. These receipts contain no URLs, filenames or account identifiers. Module destruction cancels its captured native engine even when the React context has already gone away.

Android process death interrupts active PUTs; the service uses `START_NOT_STICKY` and does not invent a boot-time owner. On foreground relaunch, the existing persisted queue reopens the server upload session and sends missing parts. Server assembly/completion still requires the original signed-in session. This is recovery, not a claim that a killed process keeps uploading. iOS retains the existing Expo background URLSession path.

## Verification

`tests/run-android-fixtures.py` copies and hashes production core source into a new external directory. It requires an already installed SDK/JDK/Gradle and an explicit emulator serial; it does not install packages, accept licenses, alter production flags, or contact real users/storage.

```sh
python3 modules/portava-background-upload/tests/run-android-fixtures.py \
  --output /tmp/portava-android-toolchain/upload-proof-4 \
  --sdk /tmp/portava-android-toolchain/sdk \
  --java-home /tmp/portava-android-toolchain/jdk-21.0.13+9/Contents/Home \
  --gradle /tmp/portava-android-toolchain/validation-app/android/gradlew \
  --gradle-cache /tmp/portava-android-toolchain/gradle-cache \
  --serial emulator-5580 --adb-server-port 5040
```

Coverage: four JVM destination/file policy tests and five Android 36 instrumentation tests. A throttled 16 MiB synthetic TLS upload verifies bytes continue after Home, a foreground notification is posted and the server receives exact bytes. Other checks cover session replacement, notification cancellation receipts, redirect refusal, and bounded queued work. The test-only TLS certificate is injected into the core fixture; the production module always uses the system trust store. The Expo bridge is separately compiled against Expo 54 / Modules Core 3.0.30 / Android 36.

The JS suites cover staging, exact missing-part recovery, queue persistence/cancellation, session replacement during binding/token refresh, cancellation before restart, work enqueued during an active transfer, endpoint trust and request deadlines. None of these checks certify an installed production build, physical Android OEM scheduling, iOS background behavior, or a production upload.

Android service requirements: [dataSync foreground services](https://developer.android.com/develop/background-work/services/fgs/service-types#data-sync) and [foreground service timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout). `onTimeout` stops active work; starting a fresh service requires a foreground activity. The platform can still stop the process, and resumability is the recovery path.
