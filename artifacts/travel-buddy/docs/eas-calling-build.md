# EAS development build — calling (LiveKit) requirements

Phase 1 wired the calling backbone into the app. The LiveKit native module is
**not** present in Expo Go or on web — `createLiveKitBridge()` returns `null`
there and CallContext fails gracefully. A custom development build is required
to exercise real calls on device. Everything below is already committed; this
doc is the checklist for producing the build.

## Packages (already in package.json)

| Package | Version | Purpose |
| --- | --- | --- |
| `@livekit/react-native` | ^2.11.1 (installed 2026-07-19) | LiveKit RN SDK (`registerGlobals`, `AudioSession`) |
| `@livekit/react-native-webrtc` | ^144.1.1 | Native WebRTC module |
| `@livekit/react-native-expo-plugin` | ^1.0.2 | Expo config plugin (adds native project changes at prebuild) |
| `livekit-client` | transitive | `Room` / events used by `src/services/livekitBridge.ts` |

> pnpm noted optional peers `@react-native/jest-preset` and a pinned
> `livekit-client >=2.20.1` — only needed if Jest tests import the SDK
> directly (they don't; the bridge lazy-`require()`s it).

## app.json (already applied)

- `plugins`: added `"@livekit/react-native-expo-plugin"`.
- iOS `infoPlist`:
  - `NSMicrophoneUsageDescription` — mentions voice/video calls.
  - `NSCameraUsageDescription` — mentions video calls.
- Android `permissions` added:
  - `android.permission.MODIFY_AUDIO_SETTINGS` (speakerphone/earpiece toggle)
  - `android.permission.BLUETOOTH` (legacy, ≤ API 30 headsets)
  - `android.permission.BLUETOOTH_CONNECT` (API 31+ headset routing)
  - (`RECORD_AUDIO` and `CAMERA` were already present.)

## eas.json

No changes required — the existing `development` profile
(`developmentClient: true`, internal distribution) is sufficient. The LiveKit
plugin runs during prebuild on EAS servers.

## Prebuild considerations

- This project uses CNG (no committed `ios/`/`android/` dirs), so EAS runs
  `expo prebuild` automatically; the LiveKit plugin then:
  - iOS: adds `audio` background mode is NOT added automatically — calls
    continue only while foregrounded until Phase CallKit work; acceptable for
    Phase 1/2.
  - Android: merges WebRTC ProGuard rules and Java 11 desugaring settings.
- New architecture: `@livekit/react-native` ≥2.7 supports RN 0.76+/new-arch.
  If the build fails on new-arch, set `"newArchEnabled": false` in app.json as
  a fallback.
- Expo SDK: verify plugin compatibility if the SDK is upgraded.

## Build commands

```bash
# from artifacts/travel-buddy
npx eas build --profile development --platform ios
npx eas build --profile development --platform android
```

(Owner `travel-buddy1`, project id `b4147876-b8f9-4ea2-94f4-dd9f4e9cb65b` are
already configured in app.json.)

## Runtime env

The client needs no LiveKit secret: tokens and the `livekitUrl` come from the
API (`POST /api/calls` → grant). Server env: `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (already set). LiveKit Cloud must be
configured to send webhooks to `https://<prod-domain>/api/calls/webhook` with
the same API key/secret pair.

## Out of scope (later phases)

iOS CallKit + PushKit VoIP push, Android ConnectionService/foreground call
service, group-room UI.
