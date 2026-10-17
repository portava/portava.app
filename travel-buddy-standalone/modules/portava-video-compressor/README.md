# Portava video compressor (iOS only)

Local Expo module for the existing `PortavaVideoCompressor.compressAsync(uri, options)` contract. It uses existing ExpoModulesCore plus Apple AVFoundation/CoreMedia/CoreVideo/VideoToolbox; no new third-party dependency. The app's existing JavaScript switch remains OFF. This module needs a rebuilt native app; it is not usable in Expo Go or by a JavaScript-only update.

## Contract and failure behavior

- Accept only an absolute local `file:///` URI for a regular, self-contained MP4/MOV with an `ftyp` header. AVFoundation external media references are forbidden. No fetching, Photos-library lookup, permission prompt, provider or upload is implemented.
- Decode and re-encode one video track to H.264 MP4. Retain its sample timestamps and right-angle rotation/mirroring. Scale to even pixel dimensions, never upscale, and report displayed dimensions. Reject unsupported transforms or dimensions above 8192px instead of guessing.
- Re-encode an optional mono/stereo track to AAC, preserving sample rate and timing. Refuse multiple video/audio tracks or unsupported audio layouts instead of silently discarding them. No audio track is invented for silent video.
- Options must stay within 256,000–4,000,000 bits/second and 2–1920 pixels. Smaller requested ceilings are honored. The encoder gets a conservative video target and one-second VideoToolbox data-rate limit; output verification additionally rejects files whose **whole-file average bitrate**, including audio/container bytes, exceeds the requested ceiling. Hardware settings alone are not proof: short, pathological noise can exceed them and is refused. Instantaneous or sub-second peak bitrate is not certified.
- Never overwrite the source. Allocate a unique private temporary directory (0700), mark it complete-protection on iOS, and return a separate 0600 `.mp4` only after verifying codecs, tracks, duration (80ms maximum tolerance), displayed dimensions, measured size, bitrate and absence of location keys. Copy no source metadata or metadata tracks. Refuse a changed source or a copy not strictly smaller than the actual source file.
- Failed, cancelled, timed-out, oversized or non-smaller outputs are removed. If deletion itself fails, reject with a cleanup error rather than reporting success or pretending the artifact vanished; the remaining directory is still private. A successfully returned temporary copy belongs to the caller/OS temporary-file lifecycle. No crash/force-kill orphan sweeper is added.
- The Expo entry point performs only lightweight admission on the main queue, then sends file access and encoding to a dedicated serial queue. Admission captures the cancellation generation **before** the encoding backlog. Background invalidates running and already-admitted queued requests; foreground admits new work without renewing old tokens. Module/context destruction permanently closes the scheduler. Cancellation and the five-minute deadline are checked between native operations and while finishing; they cannot interrupt a blocking SDK call. No background-processing entitlement or service is added.

## Native validation

From any directory on a Mac with Xcode installed:

```sh
bash tests/run-native-fixtures.sh /absolute/path/to/a-new-external-output-directory
```

Run the script from this module directory (or use its absolute path). It compiles the **actual core** against the macOS SDK, generates only synthetic MOV fixtures, encodes/decodes with AVFoundation, and checks resulting bytes, displayed corner pixels, frame counts, tone energy/frequency, source hashes, metadata and filesystem cleanup. It then compiles the same core into real iPhoneOS and iPhoneSimulator SDK objects targeting iOS 15.1. Outputs, caches and generated media go to the supplied external directory. Apple media services may require running this synthetic harness outside a restrictive process sandbox.

These are real Apple-SDK core/runtime tests, **not** an Expo bridge compile, integrated app build, iOS runtime/device witness, upload/playback acceptance, HDR color certification or activation approval. The core uses synchronous AVFoundation reading/writing APIs supported by the iOS 15.1 floor; newer SDKs emit deprecation warnings. No SDK types are replaced by stubs.

## Integration boundary

Installed Expo autolinking discovers local modules under `modules/`; `expo-module.config.json` registers `PortavaVideoCompressorModule` for iOS only. The module-local podspec references the existing ExpoModulesCore and platform frameworks. No root manifest or dependency lockfile change is required by this source addition. Parent must coordinate a clean native build/link with real ExpoModulesCore, device verification and any eventual flag approval separately. Do not run prebuild or dependency installation against shared `node_modules` as part of this harness.

References reviewed: [Expo local modules](https://docs.expo.dev/modules/get-started/), [Expo module API](https://docs.expo.dev/modules/module-api/), [Expo module configuration](https://docs.expo.dev/modules/module-config/), and installed Apple SDK headers for AVAssetReader/Writer, AVVideoSettings and VTCompressionProperties.
