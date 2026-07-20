# Calling system — Phase 7 release-readiness report

Audited 2026-07-19 against the calling spec's §43 definition-of-done. Every
check below was re-verified live from this workspace on that date; nothing is
carried forward on trust from earlier phase notes.

**Verdict: NOT yet claimable as production-ready.** The implementation,
schema, tests, and typechecks all pass, but three release gates remain open
(see “Blocking gaps”). No code gaps were found — the open items are
deploy/registration/device-verification steps.

---

## 1. Native build configuration (vs `travel-buddy/docs/eas-calling-build.md`)

| Item | Status | Evidence |
| --- | --- | --- |
| `@livekit/react-native` ^2.11.1 | PASS | package.json dependency matches doc |
| `@livekit/react-native-webrtc` ^144.1.1 | PASS | package.json |
| `@livekit/react-native-expo-plugin` ^1.0.2 | PASS | package.json + registered in `app.json` `plugins` |
| `livekit-client` | PASS | pinned ^2.20.1 (doc's peer-pin note satisfied) |
| iOS `NSMicrophoneUsageDescription` | PASS | mentions voice/video calls |
| iOS `NSCameraUsageDescription` | PASS | mentions video calls |
| Android `RECORD_AUDIO`, `CAMERA`, `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH`, `BLUETOOTH_CONNECT` | PASS | all present in `app.json` `android.permissions` |
| `eas.json` development/production profiles | PASS | unchanged, matches doc ("no changes required") |
| CNG prebuild (no committed ios/android dirs) | PASS | no native dirs in tree; plugin runs at EAS prebuild |

Note: the doc's new-arch fallback (`newArchEnabled: false`) has not been
needed; `app.json` still has `newArchEnabled: true`. Confirm on the next EAS
build.

## 2. Production environment

| Item | Status | Evidence |
| --- | --- | --- |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in production env | PASS | presence-only check via secrets manager (values never read) |
| LiveKit credentials valid | PASS | read-only `listRooms()` probe succeeded (0 open rooms) |
| Expo push (server side) | PASS | Expo Push HTTP API needs no server credential; `EXPO_TOKEN` present for EAS; push send path parses per-token errors (`lib/push.ts`); `call.incoming` push carries `priority:"high"` so FCM wakes backgrounded Android devices and APNs delivers at priority 10 — verified by `pushDelivery.test.ts` §14 |
| APNs/FCM push credentials on the EAS project | MANUAL | managed in EAS credentials store; `eas credentials` requires interactive TTY + EAS project owner login and cannot be driven from this workspace — see verification steps below |
| Client never receives LiveKit secrets | PASS | no `LIVEKIT*`/`EXPO_PUBLIC_LIVEKIT*` reference in the mobile tree; client gets only `livekitUrl` + short-TTL token from the grant response |

### §2 APNs/FCM manual verification steps

The `eas credentials` command requires an interactive terminal session authenticated as
the EAS project owner (`travel-buddy1`, project id `b4147876-b8f9-4ea2-94f4-dd9f4e9cb65b`).
It cannot be driven from this workspace. A human with EAS access must run:

```bash
# from artifacts/travel-buddy
eas credentials -p ios
# Navigate: production build profile → iOS Distribution Certificate + Push Notification Key.
# Both must show "Configured". If missing, run: eas credentials --platform ios
# and follow the prompts to generate/upload an APNs key (Auth Key recommended over cert).

eas credentials -p android
# Navigate: production build profile → FCM V1 Service Account Key (or legacy FCM API key).
# Must show "Configured". If missing, run: eas credentials --platform android
# and upload the Google Services JSON or FCM V1 service-account key.
```

Once both show "Configured", update the APNs/FCM row status above from **MANUAL** → **PASS**
and record the date and EAS build number here.

## 3. Webhook endpoint & registration

| Item | Status | Evidence |
| --- | --- | --- |
| Endpoint code path (`POST /api/calls/webhook`, raw-body, signature-verified) | PASS | mounted before `express.json()`; unsigned → 401 verified against the dev server |
| Signed round-trip | PASS (dev) | self-signed `room_finished` webhook (correct `sha256` claim) → 200 `{ok:true}`; tampered body → 401 |
| **Production round-trip** | **PASS** | Republished 2026-07-20. `GET /api/calls/active` → 401; self-signed `room_finished` webhook (base64 sha256 claim) → 200 `{ok:true}`; tampered body → 401; no auth → 401. Re-runnable: `node artifacts/api-server/scripts/verify-prod-webhook.mjs`. |
| LiveKit Cloud webhook registration | **PASS** | Registered 2026-07-20. Webhook URL `https://portava.replit.app/api/calls/webhook` confirmed in LiveKit Cloud dashboard. See `docs/livekit-webhook-registration.md` for re-registration steps. |

## 4. Migration state (live Supabase, verified via Management API)

| Item | Status | Evidence |
| --- | --- | --- |
| `call_sessions` (13 cols), `call_participants` (9 cols incl. `hand_raised_at`), `call_preferences`, `call_moderation_actions` | PASS | `information_schema` matches 0155 + 0156 |
| All CHECK/FK/UNIQUE constraints | PASS | 20 constraints enumerated, incl. `room_name` UNIQUE and status/role/type CHECKs |
| Indexes | PASS | all 0155 indexes + `uniq_open_group_room_per_context` + moderation index present |
| RLS enabled + 5 policies (participant-scoped reads, own-prefs writes) | PASS | `pg_policies` matches 0155 exactly |
| `call_moderation_actions` RLS | **FIXED during this audit** | live table had `relrowsecurity=false` (0156 omitted it) — enabled live 2026-07-19 with zero policies (service-role-only audit log); 0156 file + `docs/migrations.md` updated. No other drift found. |

## 5. Observability & analytics

- **Lifecycle logging** — structured (`logger.info/warn/error`) at start/answer/
  decline/end, webhook reconciliation failures, sweep transitions, push
  per-token errors. No tokens, room secrets, or message content in any log
  call inspected.
- **Analytics** — `emitCallAnalytics(type, session)` fires on started /
  answered / declined / missed / ended / failed with `callId`, `callType`,
  `contextType` only (spec §21-safe; no content, no participant names).
  Outcome = the analytics type; duration is derivable from
  `connected_at`/`ended_at` on the session row rather than duplicated in the
  event — acceptable, noted as a nice-to-have to add `durationMs` on `ended`.
- **Failure observability** — webhook handler logs and 200s on processing
  bugs (sweep self-heals); push failures surface per-token error codes;
  sweep transitions are CAS-safe and logged.

## 6. Honest-scope check

- Settings → Calling copy states in-app ringing while open, push notification
  when backgrounded, and explicitly "Calls can't wake the phone like the
  built-in dialer." — no CallKit/VoIP/ConnectionService claims anywhere in
  the client copy. PASS
- EAS doc explicitly lists CallKit/PushKit/ConnectionService as out of scope. PASS
- No phone-number fields exist anywhere in the calling code (UUID + opaque
  room identities only). PASS

## 7. Definition-of-done walk (spec §43)

| Gate | Verdict | Evidence |
| --- | --- | --- |
| Telegraph voice + video calls | PASS (code+tests) / DEVICE-GATE OPEN | routes+engine+UI shipped; `callSystem`/`callRoutes` suites |
| Rent a Buddy voice + video | PASS (code+tests) | booking-status eligibility matrix in `callSystem.test.ts`; buddy-profile→user id resolution covered |
| Trip Crew group voice | PASS (code+tests) | no-ring group semantics, concurrent-start dedupe (per-process lock + live partial unique index) |
| Event Voice Rooms | PASS (code+tests) | 0156 surfaces, raise-hand, moderation audit |
| Incoming calls / push | PASS (code+tests) / device confirmation pending | realtime + push signaling, `incoming_call_notifications` honored |
| Permissions server-side | PASS | engine denies before any token mint; voice-only grants can't publish camera even from a hacked client (token-level `TrackSource` restriction) |
| Blocks enforced + block force-ends rooms | PASS | `forceEndDirectCallsBetween` terminates LiveKit room server-side; `callHardening.test.ts` |
| User calling settings enforced | PASS | `who_can_call`/`allow_video_calls`/`allow_rent_a_buddy_calls` checked server-side (absent row = defaults) |
| Trust rules + age/event eligibility | PASS | messaging verdict `allowed===true` floor; event ineligibility paths tested |
| Call history in context | PASS | thread system lines (voice/missed/crew-call) written by store adapter |
| Missed calls | PASS | ring-expiry sweep → missed + push + thread line |
| Minimized calls | PASS (code+tests) / device confirmation pending | pill surface + timer continuity tests |
| Reconnection | PASS (code+tests) / device confirmation pending | resilience component tests; expired tokens re-join via full re-auth |
| Ghost calls self-heal | PASS | fail-closed probe (`roomExists` must positively say gone), 2-min grace, 4h backstop |
| LiveKit webhooks verified | PASS (code) / **prod registration open** | signature required, 401 otherwise; see §3 |
| Rooms terminate server-side | PASS | end/decline/block/cap all call `deleteRoom` (idempotent) |
| 4-hour cap | PASS | sweep force-ends over-cap sessions even with both clients gone |
| Abuse protections | PASS | 30 starts/hr (memory + DB-authoritative), 60s redial cooldown, double-tap dedupe, opaque `pcall_` room names |
| Group moderation | PASS | mute/remove/promote/demote + immutable audit table (now RLS-locked) |
| Unauthorized users cannot mint/join | PASS | all grants behind engine; unknown rooms/no-op webhooks; RLS read-scoping |
| LiveKit secret never reaches client | PASS | see §2 |
| **Device-test gate** | **OPEN — blocking** | `device-test-gate-phase2.md` remains "READY FOR VERIFICATION" with all boxes unchecked; requires two physical devices with the EAS dev build |
| Tests pass | PASS | 2026-07-19 runs — api-server: 3734 pass / 0 fail; travel-buddy: 2559 pass / 0 fail; standalone fork: 3229 pass / 0 fail; cross-tree + frozen-dir guards green |
| Typecheck passes | PASS | api-server `tsc` clean; travel-buddy `tsc` + import-extension guard clean |
| No Telegraph / RAB / Trip / Event regressions | PASS (automated) | full suites above cover these surfaces; no regressions observed |
| Native build config documented + verified | PASS | §1 |

## Blocking gaps (must close before claiming production-ready)

1. ~~**Republish the API server.**~~ **RESOLVED 2026-07-20** — all `/api/calls/*`
   routes live; production round-trip verified (see §3). Re-runnable:
   `node artifacts/api-server/scripts/verify-prod-webhook.mjs`.
2. ~~**Register + round-trip the LiveKit Cloud webhook.**~~ **RESOLVED 2026-07-20**
   — webhook registered in LiveKit Cloud dashboard; signed/tampered/unsigned
   probe all pass against production (see §3 and `docs/livekit-webhook-registration.md`).
3. **Pass the device-test gate** (`travel-buddy/docs/device-test-gate-phase2.md`)
   on physical hardware with the EAS development build, including the
   background-push and reconnection sections. One-time manual: confirm
   APNs/FCM credentials in EAS while doing so.

Non-blocking notes: add `durationMs` to the `ended` analytics event
(currently derivable from session timestamps); re-confirm `newArchEnabled`
on the next EAS build.
