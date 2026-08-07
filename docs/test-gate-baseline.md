# Test Gate Baseline

The reference numbers a full verification run must match. A run is green only
when every check below passes **and** its counts are equal to or greater than
the reference. A count that moves **down**, or any suite that becomes skipped,
is a regression — investigate before accepting.

Additive movement (new tests, newly-globbed suites) is fine, but update this
file in the same commit so the reference never drifts behind reality.

## Current reference — 2026-08-07

Recorded after the five media commits (`50bb012b5` … `db2dd781b`) and updated
after filter centralisation. Full run, all green.

| Check | Command | Result | Reference |
|---|---|---|---|
| typecheck | `pnpm run typecheck` (travel-buddy-standalone) | PASS | — |
| rules-of-hooks | `npx eslint 'travel-buddy-standalone/{app,src}/**/*.{ts,tsx}'` | PASS | 0 violations |
| component tests — native | `pnpm run test:component` | PASS | 1729/1729, 321 suites |
| component tests — web | `pnpm run test:component` (jest.web.config.js) | PASS | 4/4, 2 suites |
| standalone node tests | `pnpm run test` (travel-buddy-standalone) | PASS | 3694/3694, 499 suites |
| api-server tests | `pnpm run test` (artifacts/api-server) | PASS | 6135/6135, 1550 suites |

`fail 0`, `skipped 0`, `todo 0`, `cancelled 0` on every node run.

### Coverage note

`pnpm run check:all` covers only **test**, **test:component** and **typecheck**.
It does **not** run the api-server suite or the hooks lint — those are separate
commands and must be run explicitly to complete the gate.

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
