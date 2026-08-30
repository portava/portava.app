# Handoff — 2026-08-30

Written for the next Claude session. Everything below was verified by running something,
not inferred. Where I could not verify a claim, it says so.

---

## 0. Read this first — the two rules that earned their place

**A green run proves nothing until you have seen it go red.** Every fix in this session was
proved by mutation: revert the fix, watch the test fail, restore, watch it pass. Three of the
"bugs" found were tests that could not fail. Do the same.

**A grep that matches nothing looks exactly like an absence.** I produced four confidently
wrong conclusions this way and caught them only with a positive control:
- `strings` on a 40 KB launcher instead of the real 60 MB `Portava.debug.dylib` → "OpenMLS is
  not in the build" (it was)
- `grep "# pass"` against node:test's `ℹ pass` → "the e2ee tests do not run" (they did)
- `command -v cargo` with `~/.cargo/bin` off PATH → "no Rust toolchain" (cargo 1.98.0 is
  installed)
- `grep … | head` used as a truth test → `head`'s exit status is always 0

Always include a control that MUST produce a hit, and report it.

---

## 1. Environment

| Thing | State |
|---|---|
| Main checkout | `~/portava-sandbox/portava.app` — **shared**, another session commits here |
| Worktrees | `wt-h6` (PR #218), `wt-msgrls` (unrelated, not mine) |
| Simulator | iPhone 17 Pro Max `CEAEE95B-46D6-4C69-9938-14090B2672E1`, iOS 26.5 |
| Metro | serve from `portava.app/travel-buddy-standalone` — a worktree with symlinked `node_modules` does NOT work (Metro cannot resolve the entry through the symlink) |
| git | prefix `DEVELOPER_DIR=/Library/Developer/CommandLineTools` — but **never** export it for native builds, it makes clang link the macOS SDK into an iOS target |
| cargo | `~/.cargo/bin/cargo` 1.98.0, iOS targets installed. Not on PATH. |
| CocoaPods | `/opt/homebrew/bin/pod` |
| Signing | **0 identities.** The installed app is ad-hoc signed with an EMPTY entitlements blob. |

### Standing grants
- Branch → PR → merge on green CI. Force-push and main-push are hard-blocked by a hook.
- Production Supabase migration press is delegated (CI + sandbox gated). Prod deploys are NOT.

---

## 2. Merged this session (#209–#216)

All green, all proved by mutation.

| PR | What |
|---|---|
| #209 | SecureStore adapter must not throw into GoTrue's 30s refresh timer |
| #210 | Repaired `secureStore.e0` — a test that ran in NEITHER runner — + `check:orphan-tests` guard |
| #211 | OpenMLS iOS build: nothing generated the UniFFI bindings |
| #212 | Un-orphaned 4 E2EE suites, 34 cases that had never executed |
| #213 | expo-openmls TS wrapper signatures realigned with the UDL |
| #214 | `useCityPulse` timezone-dependent tests + pinned the product defect |
| #215 | Three safety/security paths that silently succeeded + `check:route-auth-gate` |
| #216 | Keychain failure no longer re-opens LogBox forever |

---

## 3. OPEN — pick up here

### PR #217 — mobile layout + error-reporting (CLEAN, ready to merge)
Four fixes: passport owner-menu sheet, city picker, Pulse Wall error classification, Gems.

### PR #218 — intel route shadowing (CI running)
`:approve` parsed as a route PARAM under path-to-regexp 8, so the admin-gated approve
endpoint was served by the user-gated propose handler. Flag is ON in prod.

---

## 4. THE DEFECT CLASS — highest-value next work

Three confirmed instances, ~17 unverified candidates. **RNTL cannot catch any of them**,
because it does not run Yoga layout — every one of these has passing tests.

```
parent: { maxHeight: '85%' }   ← no DEFINITE height
child:  { flex: 1 }            ← flex:1 in a content-sized parent resolves to ZERO
```

Confirmed and fixed: `PassportOwnerMenuSheet`, `GlobalPlacePicker`.

**`maxHeight` is not enough** — Yoga needs a definite height to resolve a flex child against.
Use `height: 'N%'`. That distinction is the whole bug: with `maxHeight` the list renders but
will not scroll (content overflows and is clipped by `overflow:hidden`); with zero height it
does not render at all.

Candidates (grep found `maxHeight` + a `flex:1` scroll child; **not** verified):
`TripMembersSheet`, `ReportPostSheet`, `TripInviteSheet`, `SaveToCollectionSheet`,
`AddToPlanSheet`, `TripPlanSettingsSheet`, `EventComposerSheet`, `HostDashboardPanel`,
`MeetupCreationSheet`, `ReportSheet`, `CompassTelegraphTray`, `DiscoveryShareSheet`,
`StampPickerSheet`, `HighlightComposer`, `PlaceReportSheet`, `AvailabilityGrid`,
`StampDetailModal`, `StampShowcaseCurationSheet`, `PlaceDetailSheet`, `TrustScoreInfoSheet`.

Open each on the simulator. Do not trust the tests.

---

## 5. Audit backlog — 30 confirmed findings, adversarially verified

Full brief: `/private/tmp/claude-501/-Users-areyouok/13219406-4eb9-4e79-b303-7cd3a08418c5/tasks/w56t68zv8.output`
(tmp — **copy it somewhere durable before it is swept**).

### HIGH still open

**H1 — GDPR erasure aborts mid-loop.** `AccountDeletionService.ts:261` calls
`tombstone_post()`, which exists in CI but **not prod** (migration 2141 unapplied). The RPC
throws, `step()` swallows it, the loop aborts — posts not yet reached are neither blanked nor
deleted. Execution continues: profile anonymised, auth user deleted, request marked
`completed` with `user_id=NULL` → never retried. Survivors are permanent (prod `profiles` has
**0 FKs**, so CASCADE never fires). Two halves: apply 2141 (owner press), and harden the loop
to collect failures and throw once at the end.

**H5 — verification vocabulary mismatch.** `toVerificationLevel()` returns
`'id_verified'`/`'id_selfie_verified'`; the live CHECK constraint permits neither. Proved on
CI: `basic_verified` UPDATE succeeds, `id_verified` → **23514**. Error discarded, handler
returns 200. Not reachable in prod today (providers are stubs) — a guaranteed failure the day
a real provider ships.

**H7 — `events.ts:654` accepts and silently ignores** `nearLat/nearLng/nearRadiusKm/free/
verifiedHostOnly/capacityAvailable`. Proved: Da Nang + 50 km returned a **Reykjavik** event.
The events tab already ships the matching UI chips. **Owner decision**: implement, or delete
the params *and* the chips.

**H8 + M8 + M9 — local-date helper.** `circle.tsx:118` truncates to local midnight then
`toISOString()`, so at any positive offset the first column is yesterday and the 14th bookable
day disappears. Same root in message dividers and `meetups/index.tsx`. One shared
`localDateKey()`; prove with a TZ sweep including a UTC control.

### Two systemic guards worth more than any single fix
1. `check:unchecked-supabase-writes` — supabase-js **resolves** on a rejected write, so every
   `catch{}` around a PostgREST call in this repo is dead code. Would have caught H2, H4, H5b,
   M1, M2, L1 in one pass.
2. `R9` in `check-flag-polarity.mjs` — enforce read→seeded. 7 flags are read by live code and
   seeded nowhere.

---

## 6. Simulator: what works, what is blocked

**Working:** Discovery (15 places for Cebu, real Foursquare photos), Live Pulse plans,
Rent a Buddy, Passport, Trips, Edit & Settings, all scrolling.

**The one blocker:** `EXPO_PUBLIC_SUPABASE_ANON_KEY` is **empty** in
`travel-buddy-standalone/.env` (gitignored).

The owner directed: use **portava-ci** `hwokxgbmezheskbzskfr`, keep production
`ajrurzioarfkagpuxfnb` isolated, commit no keys. The URL is already wired. The key is only in
GitHub Actions (write-only) or the Supabase dashboard → portava-ci → Settings → API.
**Every local `.env` that has a Supabase URL points at PRODUCTION — do not harvest from those.**

Blocked until it lands: Pulse Wall (`/api/pulse` 401), Gems, personalised Discovery,
translation (`GET /api/content/:type/:id/translation` 401), video calls.

Note `docs/ci/BOOTSTRAP.md` says portava-ci is **"currently EMPTY"** — expect authenticated
surfaces to render *empty*, not populated. That is still the right outcome to verify; an
authenticated session with no rows is a completely different state from no session at all.

**Video calling cannot be tested on a simulator at all** — no camera hardware. Needs a
physical device, which needs signing.

**Keychain cannot work on this build** — ad-hoc signed, empty entitlements, so every call
returns `errSecMissingEntitlement`. Fix is Xcode → Settings → Accounts → add an Apple ID (a
free personal team is enough for Simulator), then rebuild.

---

## 7. Loose ends and honest gaps

- **A third endpoint leaks internals.** `/api/content/.../translation`, `/api/media/gems-feed`
  and `/api/pulse` all return `message: "Missing or malformed Authorization header"`, and
  `gems-feed` with a bad token returns a full JWT parse error. #217 fixes the two client
  screens; the pattern deserves central handling.
- **`freshToken()` has no timeout** — awaits `getSession()`/`refreshSession()` unbounded. With
  a misconfigured Supabase it never settles and the feed hangs forever. Reproduced as a
  permanent spinner. Worth a bounded race.
- **Server destination matching is inconsistent**: `?destination=cebu` → 27 places,
  `Cebu City` → 0, `da-nang` → 0, `Da Nang` → 60. The client sends `place.city` verbatim.
- **`check-guard-coverage` over-counts.** It classifies "can reach Supabase" by matching the
  bare text `SUPABASE_`, which also matches error-message strings. One exemption rested
  entirely on a string literal. Other exemptions may too. Narrowing it would SHRINK the
  guarded set, so it needs its own review.
- **31 orphaned tests remain** in `ORPHANED_TESTS_ALLOWLIST.json` (the list may shrink, never
  grow). The 4 E2EE ones are fixed; 3 are `.test.tsx` invisible even to `KNOWN_BROKEN`.
- **Unresolved user report: "scroll isn't working."** I could not reproduce it on any surface.
  The only candidate is Discovery's `zIndex:20` floating chrome, where content passing under
  the "Featured by Portava" banner is intended sticky-header behaviour. **Ask before changing
  it** — I deliberately did not, rather than rewrite a design decision on a guess.

---

## 8. Shared-checkout hazard

`portava.app` has no owner. Another session committed onto my branch mid-session, and PR #210
silently grew to include their work. **Use a worktree** (`git worktree add`), and remember
Metro cannot serve from one with symlinked `node_modules` — for simulator work, commit to a
branch and let Metro serve the main checkout.
