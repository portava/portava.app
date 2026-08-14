# SDK 54 Package Downgrade — Smoke Test Record

Ten packages were downgraded to match Expo SDK 54 peer requirements. This
document records the verification performed for the five packages with the
most impactful version changes, and provides a checklist for the
device-level flows that cannot be verified in a Node.js test environment.

## Packages downgraded

| Package | Previous | SDK 54 target | Major change? |
|---|---|---|---|
| `expo-notifications` | >0.32 | `~0.32.17` | Yes (0.32 → was higher) |
| `expo-dev-client` | >6 | `~6.0.21` | Yes (6.x) |
| `react-native-view-shot` | >4.0 | `4.0.3` | Yes (same major, older patch) |
| `expo-calendar` | >15 | `~15.0.8` | Minor |
| `expo-clipboard` | >8 | `~8.0.8` | Minor |

---

## Automated verification (runs in CI / `pnpm test`)

Executed via `node --import tsx/esm --test src/services/sdk54-downgrade-compat.test.ts`.

### Package version pins (6 tests)
- [x] `expo-notifications` pinned to `~0.32.x`
- [x] `expo-dev-client` pinned to `~6.x`
- [x] `react-native-view-shot` pinned to `4.0.x`
- [x] `expo-calendar` pinned to `~15.x`
- [x] `expo-clipboard` pinned to `~8.x`
- [x] Versions are in sync between `artifacts/travel-buddy` and `travel-buddy-standalone`

### Calendar date-calculation logic (4 tests)
Pure JavaScript date arithmetic inside `addMeetupToCalendar` — independent of
the native `expo-calendar` binding.
- [x] `startsAt` is used as `startDate` when provided
- [x] `null` `startsAt` returns `null` startDate (caller returns an error result)
- [x] `endsAt` is used as `endDate` when provided
- [x] `endDate` defaults to `startDate + 1 hour` when `endsAt` is null

### react-native-view-shot web shim (1 test)
- [x] `captureRef()` rejects with "not supported" on web/Node (graceful fallback confirmed)

### API surface — downgraded packages (5 tests)
Recorded alongside the zero-error TypeScript typecheck result
(`pnpm --dir travel-buddy-standalone run typecheck`).

| Package | Version | Call site | APIs verified compatible |
|---|---|---|---|
| `expo-notifications` | `~0.32.17` | `src/hooks/usePushToken.ts` | `getPermissionsAsync`, `requestPermissionsAsync`, `getExpoPushTokenAsync` |
| `react-native-view-shot` | `4.0.3` | `src/hooks/usePassportShare.ts` | `captureRef({ format, quality, result })` |
| `expo-calendar` | `~15.0.8` | `src/services/calendar.ts` | `requestCalendarPermissionsAsync`, `getCalendarsAsync`, `EntityTypes.EVENT`, `createEventAsync` |
| `expo-clipboard` | `~8.0.8` | `src/components/GroupChatScreen.tsx` | `setStringAsync` |
| `expo-dev-client` | `~6.0.21` | (no direct imports) | n/a — infrastructure only |

**TypeScript typecheck result:** zero errors across all 16 tests.

---

## Device checklist (requires a real device or simulator)

These flows depend on native module bindings that cannot be exercised in a
Node.js test. They must be verified manually on a dev build before the next
production release. Mark the platform column when verified.

### Push notifications (`expo-notifications ~0.32.17`)

| Step | iOS | Android |
|---|---|---|
| App requests permission on first launch | | |
| Permission granted: Expo push token logged / saved to API | | |
| Token appears in Supabase `notification_devices` table | | |
| Server triggers a push (e.g. trip invite accepted) | | |
| Notification delivered and tapped — deep-links correctly | | |

**Call sites:** `src/hooks/usePushToken.ts`

### Passport card share / view-shot (`react-native-view-shot 4.0.3`)

Automated coverage added in `src/services/passportShare.test.ts` (19 tests).
The items marked **[auto]** are verified in CI; the remainder require a device.

| Step | iOS | Android |
|---|---|---|
| **[auto]** captureRef bare `/tmp/...` path → `file://` URI sent to NativeShare | ✓ | ✓ |
| **[auto]** captureRef `file:///tmp/...` path → no double `file://` prefix | ✓ | ✓ |
| **[auto]** captureRef `/data/...` bare path → `file://` URI sent to NativeShare | n/a | ✓ |
| **[auto]** captureRef throws → text-only fallback, no error shown | ✓ | ✓ |
| **[auto]** cardRef not yet attached → text-only fallback | ✓ | ✓ |
| **[auto]** NativeShare image-open throws → text-only fallback | ✓ | ✓ |
| **[auto]** "User did not share" cancel → no error, no fallback | ✓ | ✓ |
| **[auto]** "cancelled" cancel → no error, no fallback | ✓ | ✓ |
| **[auto]** Text-only NativeShare throws → error state set | ✓ | ✓ |
| **[device]** Tapping Share on the Passport card captures a JPEG | | |
| **[device]** Share sheet shows the image preview (not text-only) | | |
| **[device]** Cancelled share does not crash or show an error | | |
| **[device]** On web: text-only fallback share opens correctly | | |

**Call sites:** `src/hooks/usePassportShare.ts`

### Calendar export (`expo-calendar ~15.0.8`)

| Step | iOS | Android |
|---|---|---|
| Calendar permission prompt appears on first use | | |
| Permission denied: `CalendarResult { ok: false, reason: 'denied' }` returned | | |
| Permission granted: meetup event created in default calendar | | |
| Event title, start time, end time, and location match the meetup | | |
| Event with no `endsAt` defaults to `startDate + 1 hour` | | |

**Call sites:** `src/services/calendar.ts`

### Clipboard copy (`expo-clipboard ~8.0.8`)

| Step | iOS | Android |
|---|---|---|
| Long-pressing a chat message shows the Copy action | | |
| Tapping Copy: message text is on the clipboard | | |
| Paste elsewhere confirms the correct text | | |

**Call sites:** `src/components/GroupChatScreen.tsx` line 118

---

## Notes

- `expo-dev-client ~6.0.21` has no user-facing API surface; it is only used
  by the Expo dev client runtime. No runtime verification is needed beyond
  confirming the dev build launches without errors.
- The TypeScript typecheck (`pnpm typecheck`) should be re-run after any
  future package upgrade to catch API surface regressions early.
