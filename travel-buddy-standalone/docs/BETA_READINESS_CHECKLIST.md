# Travel Buddy — Beta Readiness Checklist

> **Status of this document:** Prepared offline from a static read of the uploaded
> source. **No code was executed, no typecheck was run, no device/EAS build was
> performed, and the Supabase backend was not inspected.** Items marked
> `UNKNOWN / NEEDS REPLIT CHECK` require running the app or the agent to confirm.
> Anything described as REAL/WIRED means the *client code path is wired* — it does
> **not** guarantee the backend returns real data.

## Legend
- **REAL / WIRED** — client path traced end-to-end to a real service/route
- **FIXTURE-BACKED** — renders from `src/__fixtures__` or `src/data`, not live data
- **STUB / COMING SOON** — intentionally inert (disabled button / alert only)
- **WEB-OK** — verifiable in the Replit web preview
- **DEVICE-ONLY** — requires a real phone / dev build to verify
- **BROKEN / BLOCKED** — known to fail
- **UNKNOWN** — needs a Replit run or agent check to classify

---

## Executive summary

Travel Buddy has a **real, well-structured client spine**: expo-router navigation,
core tabs, messaging, profiles, and trips invites are wired to real services. The
gaps to beta are **not "build the app"** — they are:

1. **The app has never run on its target surface.** All development has been in the
   Replit *web* preview. Every native-dependent feature (GPS, map, geofence, Safe
   Return, Trip Crew location, camera/media, push) is structurally present but
   **unexecuted on a device.** This is the #1 risk.
2. **Several user-facing screens are fixture-backed**, not live. They will demo well
   and fail for real beta users (e.g. trip detail shows mock stamps/plans).
3. **Store-build prerequisites are missing**: no bundle identifier, no Android
   package, no EAS link, no permission usage strings, no crash logging.

The native social map — the focus of much recent work — is the **most expensive and
least beta-blocking** item. A functional beta needs sign-up, navigation, trips,
messaging, and non-crashing native features. The Instagram-style map can ship in
the first update.

---

## Main checklist

| Area | State | Notes |
|---|---|---|
| Auth — login / signup | REAL / WIRED · UNKNOWN backend | Routes wired; Supabase connection unverified off web preview |
| Tab navigation (Pulse/Discover/Create/Trips/Passport) | REAL / WIRED · WEB-OK | Confirmed in audit |
| Discovery — list, filters, search | REAL / WIRED · WEB-OK | Toggle + filter state shared across views |
| Discovery — Map mode | DEVICE-ONLY · partial | Native only; venue pins only; hidden on web by design |
| Trips — list, create, open detail | REAL / WIRED | `/trip/new`, `/trip/[id]` wired |
| Trips — invite accept / decline | REAL / WIRED | Real `acceptTripInvite` / `declineTripInvite` |
| Trip detail — Plans/Circle/Stamps/Posts | FIXTURE-BACKED | Merges real fields onto `mockTripDetail`; sub-sections fixture |
| Telegraph — inbox, DM, group, send | REAL / WIRED · UNKNOWN backend | `useThreadMessages`, send, translate, RSVP, block/report all real |
| Passport — own profile | REAL / WIRED | `usePassport()` real |
| Passport — public profile `/passport/[username]` | REAL / WIRED | Real `getPublicProfile` / postcards / follow |
| Post detail `/post/[id]` | FIXTURE-BACKED | `postById()` from cebu fixture; comments is a labeled stub |
| Pulse / City Pulse feed | FIXTURE-BACKED (mixed) | Real `useGlobalFeed` mixed with `pulseFeed` fixture |
| Compass (AI) | REAL path · FIXTURE seed | `postCompassAsk` real; opening text is a seeded fixture |
| Create flow | UNKNOWN | Not fully traced; verify in Replit |
| GPS / location permission | DEVICE-ONLY | `location.ts` present; never executed on device |
| Background geofence | DEVICE-ONLY | `geofence.ts` + exit task present; device-only behavior |
| Safe Return | STUB / COMING SOON | Setup + Emergency Contacts are alert-only |
| Trip Crew location sharing | DEVICE-ONLY · privacy-gated | `useTripCrewMap`; private-by-default; device-only |
| Delayed-post geofence privacy | DEVICE-ONLY | Logic present; requires device to verify timing |
| Camera / media upload | DEVICE-ONLY | `expo-image-picker`, `expo-av` installed — need dev build |
| Push notifications | DEVICE-ONLY | `expo-notifications` installed — need dev build |
| Edit Trip | STUB / COMING SOON | Disabled, opacity 0.35, no onPress |
| Pulse card Report / Hide / Bookmark | STUB / COMING SOON | "Coming soon" alerts |
| Loading animations | REAL / WIRED (built) | 4 loaders created + typechecked by agent; not yet wired into screens |
| Crash logging (Sentry/etc.) | MISSING | None found — add before beta |
| App identifiers (bundle id / package) | MISSING / BLOCKED | Build cannot run until set |
| Permission usage strings | MISSING / BLOCKED | iOS rejects builds without these |
| EAS config / project link | MISSING | No eas.json, no Expo account link |
| Splash asset | PARTIAL | Reuses icon.png; needs a real splash for store |

---

## Priority plan

### P0 — Blocks any device beta (do first)
1. **Android dev build on a real phone.** Surfaces every native unknown above. Start
   Android (no paid account) before iOS.
2. **App identifiers** — set iOS `bundleIdentifier` + Android `package`.
3. **Permission usage strings** — location (when-in-use + always), camera, photos,
   notifications, mic. iOS review *requires* these.
4. **Verify backend on device** — auth, Supabase URL/keys in env, deep links working
   off the web preview.

### P1 — Beta would embarrass without these
5. **Resolve fixture screens** — for each FIXTURE-BACKED row, decide *wire now* vs
   *label "coming soon."* Trip detail showing fake stamps to real users is worse than
   honestly hiding it. (See `FIXTURE_STUB_EXPOSURE_PLAN.md`.)
6. **Crash logging** — add Sentry or equivalent, or beta feedback is unactionable.
7. **Honest web fallbacks** — ensure no native-only feature crashes the web preview
   (web map fallback copy fix is prepared; see below).

### P2 — Strongly wanted, not blocking
8. Wire the 4 loaders into real loading states (audit already mapped where).
9. Splash asset, app icon polish.
10. Finish the Compass opening to use real context instead of a seed.

### P3 — Post-beta / v1.1
11. **The native MapLibre/Mapbox social map.** Highest effort, lowest beta-blocking
    value. Ship once real users are in. (See `NATIVE_MAP_PROVIDER_PLAN.md`.)
12. Build out the "coming soon" stubs (Edit Trip, post-card actions, Safe Return).

---

## Cut / hide / label recommendations for beta

- **Trip detail sub-sections (Plans/Circle/Stamps/Posts):** label fixture sections
  "Preview" or hide until wired. Do not present mock data as the user's real trip.
- **Post detail comments:** label "Comments coming soon" (already a stub — keep honest).
- **Pulse feed:** if the fixture mix is visible, either filter to real items or label
  the seeded ones. Don't blend fake and real silently.
- **Safe Return / Emergency Contacts:** keep as "coming soon" — do **not** ship as if
  functional. A safety feature that looks live but isn't is a trust/liability problem.
- **Edit Trip / Report / Hide / Bookmark:** fine as visible "coming soon."

---

## Next 5 Replit tasks (when cooldown ends)
1. Run `pnpm --dir travel-buddy-standalone run typecheck` and paste results — establish a clean baseline.
2. Dispatch the **EAS dev-build setup** command (identifiers, eas.json, permission strings).
3. Owner: `eas login` → `eas init` → `eas build --profile development --platform android`.
4. Apply the **fixture/stub exposure plan** decisions (wire or label each).
5. Add crash logging (Sentry Expo SDK).

> After P0–P1, "beta-ready" is a defensible claim. Until the app runs on a phone,
> it is not — regardless of how complete the code looks.
