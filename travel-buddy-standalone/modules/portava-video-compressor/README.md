# Portava video compressor (iOS and Android)

Local Expo module for the existing `PortavaVideoCompressor.compressAsync(uri, options)` contract. iOS uses existing ExpoModulesCore plus Apple AVFoundation/CoreMedia/CoreVideo/VideoToolbox. Android uses ExpoModulesCore, platform codecs and AndroidX Media3 1.11.1. The app's existing JavaScript switch remains OFF. This module needs a rebuilt native app; it is not usable in Expo Go or by a JavaScript-only update.

## Contract and failure behavior

- Accept only an absolute local `file:///` URI for a regular, self-contained MP4/MOV with an `ftyp` header. AVFoundation external media references are forbidden. No fetching, Photos-library lookup, permission prompt, provider or upload is implemented.
- Decode and re-encode one video track to H.264 MP4. Retain its timing and right-angle displayed rotation. iOS also preserves mirroring; Android rejects mirrored/scaled track matrices and HDR instead of silently changing their appearance. Scale to even pixel dimensions, never upscale, and report displayed dimensions. Reject unsupported transforms or dimensions above 8192px instead of guessing.
- Re-encode an optional mono/stereo track to AAC, preserving sample rate and timing. Refuse multiple video/audio tracks or unsupported audio layouts instead of silently discarding them. No audio track is invented for silent video.
- Options must stay within 256,000–4,000,000 bits/second and 2–1920 pixels. Smaller requested ceilings are honored. The encoder gets a conservative video target, a one-second VideoToolbox data-rate limit on iOS, and CBR on Android; output verification additionally rejects files whose **whole-file average bitrate**, including audio/container bytes, exceeds the requested ceiling. Hardware settings alone are not proof: short, pathological noise can exceed them and is refused. Instantaneous or sub-second peak bitrate is not certified. Android does not reserve a fast-start MP4 padding box for these complete local upload copies; streaming renditions are a separate server operation.
- Never overwrite the source. Allocate a unique private temporary directory (0700), mark it complete-protection on iOS, and return a separate 0600 `.mp4` only after verifying codecs, tracks, duration (80ms maximum tolerance), displayed dimensions, measured size, bitrate and absence of location keys. Copy no source metadata or metadata tracks. Refuse a changed source or a copy not strictly smaller than the actual source file.
- Failed, cancelled, timed-out, oversized or non-smaller outputs are removed. If deletion itself fails, reject with a cleanup error rather than reporting success or pretending the artifact vanished; the remaining directory is still private. A successfully returned temporary copy belongs to the caller/OS temporary-file lifecycle. No crash/force-kill orphan sweeper is added.
- The Expo entry point performs only lightweight admission on the main queue, then sends file access and encoding to a dedicated serial queue. Admission captures the cancellation generation **before** the encoding backlog. Background invalidates running and already-admitted queued requests; foreground admits new work without renewing old tokens. Module/context destruction permanently closes the scheduler. Cancellation and the five-minute deadline are checked between native operations and while finishing; they cannot interrupt a blocking SDK call. No background-processing entitlement or service is added.

## iOS native validation

From any directory on a Mac with Xcode installed:

```sh
bash tests/run-native-fixtures.sh /absolute/path/to/a-new-external-output-directory
```

Run the script from this module directory (or use its absolute path). It compiles the **actual core** against the macOS SDK, generates only synthetic MOV fixtures, encodes/decodes with AVFoundation, and checks resulting bytes, displayed corner pixels, frame counts, tone energy/frequency, source hashes, metadata and filesystem cleanup. It then compiles the same core into real iPhoneOS and iPhoneSimulator SDK objects targeting iOS 15.1. Outputs, caches and generated media go to the supplied external directory. Apple media services may require running this synthetic harness outside a restrictive process sandbox.

These are real Apple-SDK core/runtime tests, **not** an Expo bridge compile, integrated app build, iOS runtime/device witness, upload/playback acceptance, HDR color certification or activation approval. The core uses synchronous AVFoundation reading/writing APIs supported by the iOS 15.1 floor; newer SDKs emit deprecation warnings. No SDK types are replaced by stubs.

## Android native validation

`tests/run-android-fixtures.py --help` lists the required explicit paths: a new external output directory, an already licensed Android36 SDK, JDK21, Gradle8.14.3 executable, FFmpeg with libx264 and an explicitly selected running emulator. This harness never installs SDK packages or accepts licenses. It copies the actual Kotlin core and tests, records source hashes, builds with AGP8.11.0/Kotlin2.1.20 and the module's real Media3 dependencies, and runs five JVM policy tests plus three Android instrumentation tests. Generated media and build artifacts stay outside the repository. It refuses physical-device serials.

The instrumentation tests encode/decode synthetic portrait video and a 440Hz audio track, compare displayed pixels, verify decoded audio energy/frequency, prove GPS removal from a tagged source, preserve source hashes, check dimensions and measured bitrate, keep silent input silent, and exercise denied access plus retired queued-request cleanup. All eight tests passed on an Android36 ARM64 emulator. The separate isolated Expo project also compiles the actual bridge against installed Expo54/ExpoModulesCore3.0.30; autolinking discovers its registered class. These checks do not certify a complete app binary, a physical device, OEM codec behavior, uploads or feature activation. Unsupported codec configurations safely reject the copy, preserving the original.

## Integration boundary

Installed Expo autolinking discovers local modules under `modules/`; `expo-module.config.json` registers both native implementations. The iOS podspec references existing ExpoModulesCore and platform frameworks; Android declares its dependencies in the module-local Gradle file. No root JavaScript manifest or dependency lockfile change is required. A clean integrated native build, device verification and eventual flag approval remain separate. Do not run prebuild or dependency installation against shared `node_modules` as part of these harnesses. Android foreground upload execution is a separate unfinished feature; this module cancels compression when backgrounded.

References reviewed: [Expo local modules](https://docs.expo.dev/modules/get-started/), [Expo module API](https://docs.expo.dev/modules/module-api/), [Expo module configuration](https://docs.expo.dev/modules/module-config/), and installed Apple SDK headers for AVAssetReader/Writer, AVVideoSettings and VTCompressionProperties.
