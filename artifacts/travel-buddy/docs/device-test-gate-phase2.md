# Phase 2 — Device Test Gate (1:1 Telegraph Calling)

**Status: DEVICE TEST GATE — BLOCKED (requires physical hardware)**

> **Not yet executed.** This gate requires two physical devices running an EAS
> development build. Expo Go and web cannot load `@livekit/react-native`. The
> gate must be passed before claiming production readiness for calling.
>
> **Pre-requisite:** Republish the API server first — every `/api/calls/*` route
> currently 404s in production (predates the calling system). See
> `artifacts/api-server/docs/calling-release-readiness.md` §3.

Phases 3–5 (Rent a Buddy entry points, group calls) must NOT start until every
item below is verified on a **real physical device** running the new EAS
development build (Expo Go cannot load `@livekit/react-native`).

## Setup

1. Build & install an EAS development build on two physical devices (or one
   device + one secondary account on a second device):
   ```bash
   # from artifacts/travel-buddy
   npx eas build --profile development --platform ios
   npx eas build --profile development --platform android
   ```
   Owner: `travel-buddy1`, project id: `b4147876-b8f9-4ea2-94f4-dd9f4e9cb65b`
   (already in `app.json`). See `docs/eas-calling-build.md` for full details.

2. While doing the build, confirm APNs/FCM push credentials are present in EAS:
   ```bash
   eas credentials
   ```

3. Sign in with two accounts that share an eligible Telegraph DM conversation.

4. Confirm phone/video icons appear in that DM's header — and do NOT appear in
   trip/circle threads or DMs where calling is not permitted.

## Checklist

Record device model + OS version next to each item when checked.

### Voice basics
- [ ] Outgoing voice call: Calling → Ringing → Connected; Cancel works while ringing
- [ ] Incoming voice call rings full-screen with caller photo, name, @handle, call type
- [ ] Accept connects both sides with two-way audio
- [ ] Decline ends the ring immediately; caller sees "Call declined"
- [ ] Unanswered call resolves to missed (~45s); "Missed voice call" appears in the thread; Call back shows for the callee
- [ ] End call from either side; the other side's UI clears and the duration line ("Voice call · N min") appears in the thread
- [ ] Mute/unmute is audible to the other side
- [ ] Audio routing: earpiece ↔ speaker toggle behaves; wired/BT headset takes over when connected

### Video
- [ ] Outgoing video call connects with two-way video
- [ ] Camera on/off toggle updates the remote side
- [ ] Camera flip (front/back) works
- [ ] Incoming video call offers Decline / Accept Voice / Accept Video
- [ ] Accept-video-as-voice: your camera never turns on
- [ ] Camera permission denied → voice-only calling still works

### Permissions
- [ ] Mic permission denied → explanatory alert with Open Settings; no broken call state

### Minimize / navigation
- [ ] Minimize shows the pill ("Call with … · MM:SS"); audio continues while navigating anywhere in the app
- [ ] Pill tap returns to the full call screen (same call — timer continuous)
- [ ] Pill mute + end work
- [ ] Starting a second call while in one shows "You're already in a call." with Return / Leave-and-join options

### Background & push
- [ ] App backgrounded mid-call → return to foreground: call still connected, correct state
- [ ] Incoming call while app is backgrounded → push notification received; tapping it opens the ringing UI
- [ ] Callee offline/backgrounded past the ring window → missed-call push + thread message

### Reconnection & state sync
- [ ] Toggle airplane mode ~5s mid-call → "Reconnecting…" shown, then call resumes
- [ ] Extended network loss → call ends locally; server state (thread history, /calls/active) agrees after reconnect
- [ ] Kill the app mid-call, relaunch → active call is restored to the pill (or cleanly ended if the other side hung up)

### Settings
- [ ] Settings → Calling loads and saves; "Nobody" hides the other user's call buttons for you and the server rejects their attempts
- [ ] "Allow video calls" off → video attempts to you are refused; voice still works

## Completing the gate

When every box is checked on hardware:
1. Update this file's **Status** line to `PASSED — <date> — iOS <version> / Android <version>`.
2. Update `artifacts/api-server/docs/calling-release-readiness.md` §7 "Device-test gate" row to PASS and remove it from the Blocking gaps list.
3. Phase 3 (Rent a Buddy calling entry points) may begin.

If any item fails, update **Status** to `FAILED` and list the blocking items here before filing bug reports.
