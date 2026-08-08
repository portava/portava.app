# Test Gate Baseline

The reference numbers a full verification run must match. A run is green only
when every check below passes **and** its counts are equal to or greater than
the reference. A count that moves **down**, or any suite that becomes skipped,
is a regression — investigate before accepting.

Additive movement (new tests, newly-globbed suites) is fine, but update this
file in the same commit so the reference never drifts behind reality.

## Current reference — 2026-08-08

Recorded after the five media commits (`50bb012b5` … `db2dd781b`), updated
after filter centralisation and again after the bare-image guard and its
sweep. Full run, all green.

| Check | Command | Result | Reference |
|---|---|---|---|
| typecheck | `pnpm run typecheck` (travel-buddy-standalone) | PASS | — |
| rules-of-hooks | `npx eslint 'travel-buddy-standalone/{app,src}/**/*.{ts,tsx}'` | PASS | 0 violations |
| bare-image guard | `pnpm run lint:bare-image` (travel-buddy-standalone) | PASS | 0 bindings |
| component tests — native | `pnpm run test:component` | PASS | 1744/1744, 323 suites |
| component tests — web | `pnpm run test:component` (jest.web.config.js) | PASS | 4/4, 2 suites |
| standalone node tests | `pnpm run test` (travel-buddy-standalone) | PASS | 3734/3734, 499 suites |
| api-server tests | `pnpm run test` (artifacts/api-server) | PASS | 6135/6135, 1550 suites |

`fail 0`, `skipped 0`, `todo 0`, `cancelled 0` on every node run.

### Coverage note

`pnpm run check:all` covers **test**, **test:component**, **typecheck** and, as
of 2026-08-08, **lint:bare-image**. It does **not** run the api-server suite or
the hooks lint — those are separate commands and must be run explicitly to
complete the gate.

`artifacts/api-server`'s own `check:all` is a *different* set (frozen-dir,
async-handlers, live-DB column audits) and is not the 6135-test suite.

### Known non-blocking eslint errors

Two severity-2 eslint errors exist and pre-date this baseline. Neither is
`rules-of-hooks`, which is the gated rule:

- `src/components/events/GenerateHeaderSheet.tsx:249` — malformed
  `eslint-disable` comment (rule name has a trailing prose fragment, so the
  rule is "not found").
- `src/services/compass.ts:690` — `@typescript-eslint/no-empty-object-type`,
  interface declaring no members.

## Change log

### 2026-08-08 — node 3732 → 3734 (E2EE verification gate)

Additive, no new tests. Both come from `getSession.bypassGuard` picking up one
new source file (`lib/e2ee/verificationGate.ts`) at its two-assertions-per-file
rate.


### 2026-08-08 — node 3718 → 3732 (E2EE negotiation sequences)

Additive. One new file,
`src/lib/e2ee/__tests__/e2eeThread.sequences.test.ts`, contributing 12 tests;
the other +2 is `getSession.bypassGuard` picking up one new source file
(`lib/e2ee/e2eeThread.ts`) at its established two-assertions-per-file rate.

These test the ORDER rather than the decisions — Welcome before `is_e2ee`, and
what happens when each step fails. The assertion that matters most is that a
Welcome-delivery failure never leaves a thread flagged encrypted, because that
combination is unrecoverable: the server refuses a plaintext body on an E2EE
thread, so the Welcome can never be sent afterwards and nobody can ever read
the thread.


### 2026-08-08 — node 3696 → 3718 (E2EE send-path seam)

Additive. One new file, `src/lib/e2ee/__tests__/threadCrypto.test.ts`,
contributing 18 tests. The other +4 is the `getSession.bypassGuard`
enumeration, which asserts twice per source file and picked up the two new
files (`lib/e2ee/threadCrypto.ts`, `lib/e2ee/realPort.ts`). Verified by running
both suites in isolation — 18 and 1100 (was 1096) — rather than inferred from
the delta. Suites held at 499 because the new file uses bare `test()` with no
`describe`.

The suite is deliberately failure-path-first: it sweeps every way encryption
can fail and asserts none of them returns a plaintext body on an E2EE thread.


### 2026-08-08 — component 1737/322 → 1744/323 (action-row touch targets)

Additive only. One new file,
`src/components/__tests__/ActionRowTouchTargets.a11y.component.test.tsx`,
contributing 7 tests in 1 suite. Node, api-server and typecheck all held
exactly.

It gates the 44pt floor on the three action rows that build their controls by
hand instead of through `PostActionGroup`: ActionBar (was 36pt), cards/PostCard
(was 36pt) and HighlightViewer's viewers button (was 20pt with no hitSlop at
all). All three now use `POST_ACTION_TOUCH_PAD`, exported from PostActionRow so
there is one number.

**Do not "simplify" this suite by enumerating controls via `hitSlop`.** The
first draft did, and it was vacuous against the very bug it was written for:
the HighlightViewer control had *no* hitSlop, so a hitSlop-keyed walk skipped
it and the suite passed by not looking. It enumerates Pressables via
`onStartShouldSetResponder` instead, and filters to leaf controls holding an
action-row icon — which keeps flex-sized tap zones and PostCard's whole-card
Pressable out of a floor meant for icon buttons. Confirmed by mutation:
reverting each of the three fixes fails 2, 2 and 1 test respectively.

The suite deliberately asserts the floor **and** that `POST_ACTION_ICON_SIZE`
is still `icon.action`. Either alone is insufficient — "icon + 2*slop >= 44"
can also be satisfied by growing the icon, which would undo the one-visible-size
normalisation in `ui/ActionRowIcon.tsx`. Keep both assertions.

Height is measured across each control's whole subtree, because the sizing is
not always on the node carrying the hitSlop — StampButton puts `minHeight: 44`
on the Animated.View inside its Pressable.

### 2026-08-08 — bare-image guard added and swept to zero; node 3695 → 3696

A new gated check, `pnpm run lint:bare-image` (`scripts/check-bare-image.mjs`),
now part of `check:all`. It fails on a raw image element bound to a
private-bucket media URL — the blank-media bug class fixed in `50bb012b5`…
`db2dd781b`, which had been quietly reappearing one screen at a time.

**Reference for this check is 0 bindings.** It was committed BEFORE any fixing,
so the record of what it caught is honest: **102 bindings across 73 files**. An
earlier manual scan estimated 55 files — it looked only five lines past each
`<Image` and missed multi-line JSX plus whole surfaces (the admin queues,
GemsItemOverlay, DestinationsTab.web, PrivateEventCard, invite/[token], saved,
memory/[id]). Do not hand-count this; run the rule.

The check has a documented blind spot: it reads the opening tag only, so a
media URL reaching `<Image>` through a `.map()` callback, a generic `uri` prop,
or a plural `mediaUrls[0]` is invisible to it. Five such sites were found by
reading the flagged files and fixed alongside. If this rule passes clean on a
surface you know renders blank, look for that shape first.

`ALLOWED_BINDINGS` is keyed by file AND expression rather than line number, so
it survives edits and cannot exempt a second binding in the same file by
accident — MemoriesTab's local picker `previewUri` is exempt while
`memory.photoUrl` in the same file is not. Every entry carries a NOTE.

**node 3695 → 3696.** Additive, and not a new test file: the
`getSession.bypassGuard` suite enumerates source files, and the one new source
file — `src/components/calls/CallAvatar.tsx` — adds exactly one case. Same
mechanism as `ActionRowIcon.tsx` below. Component, api-server and typecheck all
held exactly.

Two shared components gained props during the sweep, each to prevent a
regression rather than for convenience:
- `ui/Avatar` takes `style` — layout only; sizing stays with `size` so the
  image and fallback branches cannot drift apart in shape.
- `CachedImage` takes `fallbackLabel` (pass `''` under ~64pt, where
  "Image unavailable" is clipped) and `accessibilityLabel` (a call site
  swapping in from a bare `<Image>` must not silently drop the label it had —
  typecheck caught exactly that on CompassPicksSection).

Nine hand-rolled avatar components were deleted in favour of `ui/Avatar`. One
was added: `components/calls/CallAvatar.tsx`, because the call screens are a
genuinely different palette (#1F2937 / #9CA3AF on near-black) rather than drift.

### 2026-08-08 — component 1729/321 → 1737/322, node 3694 → 3695 (action-row icon sizing)

Additive only. One new file,
`src/components/ui/__tests__/ActionRowIcon.component.test.tsx`, contributing 8
tests in 1 suite: viewBox guards for both custom icon families, the letterbox
mechanism, token identity, rendered ink parity across families, a guard that
the custom icons are scaled *up* rather than set equal to the token, layout
containment, and the 44pt touch minimum.

The node +1 is not a new test file. `src/services/__tests__/getSession.bypassGuard.test.ts`
enumerates source files and asserts each one does not wrap `getSession()`
locally; the new `src/components/ui/ActionRowIcon.tsx` adds exactly one case to
that enumeration. Any new file under the scanned tree will do the same — expect
this counter to track file count, not test intent. api-server and typecheck
held exactly.

Note for anyone asserting on icon sizes: the global lucide mock
(`src/__mocks__/lucide-react-native.tsx`) renders every icon as a bare `<View>`
and used to drop all props, so no test could observe a lucide icon's size at
all. It now forwards `size`. `View`'s prop types reject unknown props, hence the
`ProbeView` cast — the test renderer records the prop regardless.

### 2026-08-07 — 3666/494 → 3694/499 (filter value verification)

Additive only. One new file,
`src/lib/media/__tests__/filterValues.test.ts`, contributing 28 tests across 5
suites: value-domain bounds, identity at intensity 0 for every preset, exact
reproduction at 100, monotonic non-overshooting interpolation, Original as a
true no-op, and no duplicate or degenerate catalogue entries. Component,
api-server and typecheck all held exactly.

These tests verify the filter numbers; they do not tune them. The
Wanderlust/Vivid perceptual-overlap question is explicitly parked for the
device pass — see the note above `mediaFilters` in `lib/media/filters.ts`.

### 2026-08-07 — component 1716/320 → 1729/321 (filter editor a11y)

Additive only. One new file,
`src/components/__tests__/MediaFilterEditor.a11y.component.test.tsx`,
contributing 13 tests in 1 suite: accessible names, screen-reader selection
state, 44pt touch targets, and announced disabled state. Node, api-server and
typecheck all held exactly.

Note for anyone writing component tests here: RNTL v14's `render` is **async**
(it awaits `act` internally). Calling it synchronously returns a Promise with
no query methods and leaves the `screen` singleton unbound, which surfaces as
the misleading "`render` function has not been called". `await render(...)`,
and wrap `fireEvent.press` in `await act(async () => …)` when asserting on the
resulting state.

### 2026-08-07 — 3614/491 → 3666/494 (filter centralisation)

Additive only. One new file, `src/lib/media/__tests__/filterStyle.test.ts`,
contributing 52 tests across 3 suites. It pins the identity-fallback invariant
for media filters: a missing, unknown or malformed filter must render the image
unfiltered rather than blank. Component, api-server and typecheck all held
exactly.

### 2026-08-07 — 3612 → 3614 and 1715/319 → 1716/320

Both deltas additive; zero failures, zero regressions, nothing deleted,
disabled or skipped. api-server held exactly at 6135/6135.

**standalone node +2** — the sign-path tests were rewritten in `50bb012b5`.
Each file dropped its obsolete `flag OFF` case and added two real ones, net +1
apiece:

- `src/lib/__tests__/batchSignMedia.test.ts` — adds *sends the bearer token*
  and *no session*.
- `src/services/__tests__/mediaUrl.service.test.ts` — adds *bare post-media ref
  is signed* and *no session → null*.

**component +1 test, +1 suite** — `deb8c9a86` renamed
`app/post/__tests__/PostDetailCard.playback.test.tsx` to
`.component.test.tsx`. `test:component` filters on `\.component\.test\.`, so
the file had never run; it contains exactly one test. It had been failing
silently on an RNTL API removed in v12 (`getByAccessibilityLabel`), with no
gate to catch it.

Three more files sit in the same blind spot and currently pass — they are
named `.test.tsx` under `app/` and so are never run by `test:component`:
`livekitBridge.activeSpeakers`, `MapEntityActionRow`, `MapCarousel.cardHeight`.
Renaming them would raise these counts again.
