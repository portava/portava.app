# API Specification — current state

*Derived from the repository, 2026-09-07. Authoritative for routing, envelope and guard
mechanics only where it cites a file.*

*Citation convention, as in `01`: unless a path starts with `docs/`, `lib/` or `.github/`, it is
relative to `artifacts/api-server/`, and a bare filename continues the directory it was last
named in — `src/lib/http.ts` on first mention, `http.ts:140` thereafter. All 72 citations below
were verified to resolve and be in range at this commit. They are **not** mechanically
re-verified: `artifacts/api-server/scripts/check-doc-citations.mjs` covers `docs/discovery/`,
`00_STATUS.md` and `01` only, and deliberately does not glob `docs/architecture/` (`:58-69`).*

There is **one HTTP surface**: a single Express app (`src/app.ts`) that mounts **one** aggregate
router (`src/routes/index.ts`) at exactly one prefix, plus three deliberate exceptions. Everything
below follows from that one fact, including both of the defect classes that keep recurring.

## The surface, counted

| | |
|---|---|
| Files in `src/routes/` | **143** |
| …that register at least one path | **140** (`index.ts`, `callsWebhook.ts`, `discoverySearchHelpers.ts` register none) |
| Routers mounted under `/api` | **139** (`routes/index.ts:144-306`) |
| Routers mounted at the site root | **1** — `wellKnownShare.ts` (`app.ts:144`) |
| Path registrations | **1382** — 583 POST, 559 GET, 110 PATCH, 106 DELETE, 24 PUT |
| Distinct top-level URL families | **71** |
| `router.use(<path>, …)` sub-mounts | **0** — the tree is exactly two levels deep |

Ten families carry two thirds of the surface: `/admin` (232), `/rent-a-buddy` (196), `/me` (153),
`/trips` (123), `/events` (92), `/users` (58), `/compass` (56), `/posts` (34), `/v1` (29),
`/media` (29). The four largest single files are `rentABuddy.ts` (116), `events.ts` (92),
`trips-expansion.ts` (52) and `admin.ts` (55).

`/admin` is a *family*, not a router: 232 registrations spread across 30 files
(`admin.ts`, `adminCompass.ts`, `adminStamps.ts`, `airport.ts`, `hiddenGems.ts`,
`stampCatalog.ts`, `rentABuddyRollout.ts`, …). No file owns a prefix, and no prefix owns a file.
That is the precondition for both traps below.

## Rule 1 — a router may only register RELATIVE paths

`app.use("/api", router)` (`app.ts:172`) is the single mount. Express strips `/api` before the
router sees the URL, so a registration inside any router file is **already relative to `/api`**.
An absolute `router.get("/api/…")` therefore resolves at `/api/api/…` and is **dead through the
domain** — while still passing any test that mounts the router directly, because such a test
never prepends the prefix.

This is a recurring defect class, not a one-off, and it has a guard:
`src/scripts/checkNoApiRoutePrefix.ts` fails the build on any `router.<method>("/api…")` in
`src/routes/` (`:17-18`, `:40-47`). **Verified clean at this commit: zero offenders.**

Two warnings about that guard:

- It runs in `.github/workflows/unwired-checks.yml:247-250`, **not** in
  `scripts/run-all-checks.sh` and not in `check:all`. `unwired-checks.yml` is the probation
  workflow for checks nothing else invokes (`:1-20`), and its verdict job is **not yet a required
  status check**. The rule is enforced by a job that can currently be skipped.
- It is text-level. A path built from a variable is invisible to it — `wellKnownShare.ts:712-713`
  registers ten entity share routes from a loop over `ENTITY_SPECS`, and no static scan sees
  them. (It is also why the mount comment at `app.ts:140-141` still says "the six entity share
  paths": four segments — `plan`, `gems`, `buddy`, `shared-moments` — were added to
  `ENTITY_SPECS` and nothing could notice the prose had gone stale.)

### The three legitimate exceptions

1. **Raw-body webhooks** are registered on the *app*, not the router, and therefore carry the
   `/api` prefix literally: `POST /api/calls/webhook` (`app.ts:122`) and
   `POST /api/verification/webhook` (`app.ts:126`). Both must precede `express.json()`
   (`app.ts:131`) because signature verification needs the unparsed body
   (`routes/verification.ts:238`, `:290`). `callsWebhook.ts` exports a handler and registers
   nothing, which is why it is not in the 140.
2. **The root share surface.** `wellKnownShare.ts` is mounted with no prefix (`app.ts:144`) and
   owns `/.well-known/apple-app-site-association` (`:97`), `/.well-known/assetlinks.json`
   (`:130`), `/u/:username`, `/passport/:username` (`:335-336`) and the ten `/<segment>/:id`
   entity share pages (`posts`, `trips`, `plan`, `event`, `place`, `memory`, `stamp`, `gems`,
   `buddy`, `shared-moments`). It must be mounted **before** `/api` and before anything
   auth-related so Apple/Google verifiers and link crawlers always reach it (`app.ts:138-144`).
3. **Static assets** at `/fallbacks` (`app.ts:150`) and `/api/static` (`app.ts:167`), both
   registered before the router so it never sees those paths.

### The alias rewrite is part of this rule

`specAliasRewrite` (`src/lib/specAliasRewrite.ts:7-39`) runs at `app.ts:158`, **before** routing,
and rewrites ten legacy URL families onto canonical `/api/rent-a-buddy/*` paths
(`/api/buddy-bookings/*`, `/api/me/buddy-profile`, `/api/admin/buddy-payouts/*`, …).

**Consequence:** a handler registered at an *alias* path is unreachable in production — the URL
is rewritten away before any router sees it — yet it still passes a test that mounts the router
without the middleware. Two parallel change-request/rebook implementations diverged exactly this
way; see `.agents/memory/spec-alias-rewrite.md`. Register only at canonical paths; mount
`specAliasRewrite` in the test app and hit the URLs the client actually calls.

Two traps inside the rewrite itself:

- It is an `else if` chain — at most **one** rewrite applies per request.
- `/api/buddies/…` (with a trailing segment) is rewritten; bare `/api/buddies` is **not**
  (`specAliasRewrite.ts:19-22`), because that is a real list endpoint served by
  `rentABuddy.ts:685`. The `/buddies` (1), `/rent-buddy` (3) and `/rent-a-buddy` (196) families
  are all live and all different.

## Rule 2 — registration order is authorization to serve

Express matches in registration order. A parameterised route registered *before* a literal one
captures it:

```
router.get("/stories/:id",     …)   // registered first
router.get("/stories/archive", …)   // never reached: id === "archive"
```

The failure is silent by construction. The second handler exists, typechecks, and unit-tests
green when called directly; it is simply never invoked, and the caller receives whatever the
parameterised handler does with a non-id — in this codebase, a tidy `invalid_payload`. **A new
endpoint that returns a plausible client error on every request, forever.**

**Current state: zero shadowed routes.** Independently re-scanned at this commit (same method or
`router.all`, equal segment count, literal-behind-parameter, wildcards skipped): **0 pairs across
all 140 files**. Open **PR #468** adds `src/scripts/checkRouteShadowing.ts` to make that a guard
rather than a property, wires it into `run-all-checks.sh`, and ships with **no baseline** because
there is nothing to grandfather.

The guard is per-file and text-level, so the residual risk is **cross-router** shadowing, which
`routes/index.ts` currently manages by hand-written mount order and comments:

- `stampShowcaseRouter` and `stampAdmireRouter` must precede `stampsRouter`, because
  `stamps.ts` registers `GET /stamps/:stampId` and answers `400` for a non-UUID **without
  calling `next()`** — so any literal `/stamps/*` in a later router is unreachable
  (`routes/index.ts:221-231`).
- `mediaWorldRouter` and `mediaActionsRouter` must precede `mediaFeedRouter`, or
  `/media/world`, `/media/people`, `/media/me`, `/media/timeline`, `/media/map`,
  `/media/:id/actions` and `/media/:id/intent` are swallowed by `mediaFeed`'s `/media/:id`
  (`routes/index.ts:268-276`).

Those comments are the whole enforcement mechanism for cross-router order. Nothing tests it.

## Error semantics — the contract that matters most

### The envelope

`sendError` (`src/lib/http.ts:140-152`) is the canonical writer: `{ error: <code>, message }`,
with the HTTP status derived from a fixed table (`http.ts:79-107`) over a closed union of **27**
codes (`http.ts:50-77`). **4159** call sites across **134** route files use it; **407** hand-roll
`res.status(n).json({ error: … })` — same flat shape, but free to invent off-union codes
(`adminPlaceImages.ts:277` `already_rejected`).

Three properties of the envelope are load-bearing:

- **`db_error` is sanitized.** The caller's message is replaced with a generic string
  (`http.ts:132-138`) because ~750 sites pass the raw PostgREST message through, which leaks
  table, column and constraint names. Opt back in per call with `{ exposeDetail: true }` — for
  admin diagnostics only.
- **`degraded_unavailable` (503) is the "could not check" code** and is the only one marked
  `retryable: true` (`http.ts:109-117`). It means a permission check *was not performed*, not
  that it was performed and failed. It is the code this campaign's answers are supposed to reach
  for.
- **The global handler emits a DIFFERENT shape.** `app.ts:242-247` returns
  `{ error: { code, message } }` — a nested object where every route returns a flat string. A
  client that reads `body.error` as a code gets an object for any unhandled throw. This is an
  unreconciled inconsistency, not a documented tier.

### The defect class: supabase-js RESOLVES, it does not throw

A rejected PostgREST query returns `{ data: null, error }`. Therefore:

```
const { data } = await sc.from("blocks")…;
const rows = (data as any[]) ?? [];      // an OUTAGE, rendered as "nothing here"
```

…discards the error, **never enters the `try/catch` written to handle it**, logs nothing, and
hands the caller an empty list indistinguishable from a genuinely empty one. At this commit
`src/routes/` contains **146** single-line `const { data } = await` reads against **374** that
bind `error`.

The rule the codebase is converging on, stated once:

> **A failed read must never be reported as empty, clean, or done.**

Four corollaries, each with a live example:

1. **Never coerce a failed read into a default.** `?? []`, `?? 0`, `?? false`, `?? "normal"` and
   `?.field === false` all convert "unknown" into the permissive answer.
2. **Distinguish failure from emptiness in every list response.** An empty list with no failure
   marker must be a *positive statement* that the collection is empty.
3. **Never infer terminality from a read that did not happen.** `wall.ts:407-410` derives
   `followingReachedEnd` from `primary.length < CANDIDATE_FETCH`; a permission error satisfies
   `0 < 150`, so the response asserts `caughtUp: true` and the outage renders as
   *"You're all caught up."*
4. **Never write state computed from inputs that failed to load.** A stale row is a known-old
   measurement; a row built from unread inputs is a fabricated one.

### Fail-closed on privacy and blocks

`blocks` and privacy reads are the sharp end, and the codebase already has two correct helpers:

- `src/lib/blockGuard.ts:25-40` — `isBlockedBetween` returns **true** on error, and uses
  `.limit(1)` rather than `.maybeSingle()` because a **mutual** block is two rows, so
  `maybeSingle()` raised and the *strongest* block state read as "not blocked".
- `src/lib/blocks.ts:21-40` — `fetchBlockedSet` returns **`null`**, a sentinel distinct from an
  empty Set. Its contract (`:9-12`): callers **must** treat `null` as "show nobody", never as
  "no blocks".

Twenty modules use them (PR #469's own count; 15 more bypassed them). The current
failure-vs-emptiness gap is what callers then do with
`null`: most answer `200` with an empty collection —
`rentABuddyMarketplace.ts:414,519,632,666,1139,1963`, `sharedMoments.ts:287`, `placeDays.ts:94`,
`discoverySearch.ts:458,595,699,768,869,955,1070,1152,1252,1319,1417,1599`. That is **privacy-safe
and diagnostically silent**: the viewer, the client and the operator all see "nothing here".

Two sites already model the answer this campaign wants. `sharedMoments.ts:122,146` refuse with
`forbidden` rather than serving an empty success. `places.ts:495` returns
`{ places: [], powered_by: "google", reason: "rate_limited" }` — an empty list carrying a
**named refusal**, so a client reading only `places` is unaffected while a client that looks can
tell why.

### Authorization guards fail closed; the shared user/trip helpers do not

Fail-closed and audited: `requireAdmin` / `isAdmin` (`src/lib/requireAdmin.ts:113-121`, `:152`)
— explicit `error` check, absent profile, unmatched role, all 403. Consolidated from **30**
hand-rolled copies, of which two genuine divergences were preserved deliberately, not folded
away (`requireAdmin.ts:22-31`).

Four shared functions in `src/lib/http.ts` still carry the defect, and they are cited here
because every route inherits them:

- `requireUser` **fails open on the ban gate** (`http.ts:213-222`): the `account_status` read
  discards `error` and defaults to `"active"`, by documented choice ("a DB outage doesn't lock
  out all users"). Banning writes `profiles.account_status` and nothing else — there is no
  session revocation anywhere — so this is the only ban enforcement point there is.
- `requireTripMember` returns `null` on `error` (`http.ts:263`), making "the membership read
  failed" indistinguishable from "not a member". Safe, silent.
- `tripExists` returns `false` on `error` (`http.ts:315`) → a 404 for a trip that exists;
  `canEditPlan` (`http.ts:342-348`) does not bind `error` at all → an unreadable `trips` row
  reads as "trip not found".

### The in-flight campaign (all OPEN at this commit)

None of the following is merged. This section is the contract being *established*, and the
current tree is the "before".

| PR | Surface | Contract it establishes |
|---|---|---|
| #458 | Trust engine | Unreadable scorer inputs throw `TrustInputUnavailableError` instead of yielding nine neutral 50s that get **UPSERT into `trust_profiles`** with a fresh `last_recalculated_at`. Reversals return rows that actually changed (`incomplete`), not the count they intended. `getActiveCapsResult` → `{ caps, failed }`. |
| #459 | Wall | New optional `WallResponse.degraded?: WallLane[]` names lanes whose canonical read failed, **omitted when everything answered** — so `items: []` with no `degraded` is a positive claim of emptiness. `followGraphFailed` / `spineFailed` record failure as a fact; `followingReachedEnd` is no longer inferred from an unread fetch. §34 preserved: still 200, still a safe feed. |
| #460 | Message media | Signed-URL grant filters on `deleted_at IS NULL` — an unsent message stops authorizing its own bytes. |
| #462 | Map | `travelers`, `gems`, `events` drop **out of `sources`** on failure, as circle/buddies/trips/places already did. `MapTravelerReadResult` names `blocks_unknown` / `candidate_read_failed` / `privacy_read_failed`; a failed read is **never cached**. `GET /map/travelers` answers `db_error` rather than `200 {travelers: []}`. No privacy gate moves. |
| #465 | Safety, moderation, admin | *Safety fails closed; moderation and admin fail loud.* Three-valued caution (`cautionUnknown`); deletion treats unreadable `moderation_reports` as "interest present" instead of hard-deleting evidence; admin sections become `{ status, rows }` with `rows: null` (never `[]`/`0`) plus `degraded` / `unavailableSections`; abuse detectors return `DetectorOutcome` and a scan reports `incomplete`. |
| #466 | Privacy | Fail **closed** at six sites that failed open. `excludePrivateAuthorPosts` withholds every non-viewer row on an unreadable `profiles` (`lib/privacyFilter.ts:8-11` currently documents fail-open — and could not even reach that path). Passport visibility becomes three-state: absent ≠ unreadable. `profileTabs` answers a retryable 503. `PGRST204` (missing **column**) dropped from `isTableMissingError`. |
| #469 | Blocks (15 sites) | Every bypass of `blockGuard`/`blocks` converted. P0: an unreadable `blocks` table let a `rent_buddy_bookings` row be **INSERTed** — a physical meeting — through service-role clients with no RLS backstop. |
| #471 | Client normalisation | Unknown guide stats are `null`, never a fabricated `0`; a real zero still survives. The mobile half of the same rule. |
| #473 | Guard | `check:silent-supabase-reads` — four shapes (S1 unreferenced `error` binding · S2 dead catch · S3 `.then` consuming only `data` · S4 `?? []/0/false` on a **`CONSEQUENTIAL_TABLES`** read), **301 pre-existing sites across 92 files** baselined shrink-only. Waiver token `// resolves-not-throws-ok: <why>`, reason **required**. |
| #474 | Guard tier | Moves `check:silent-supabase-writes` enforcement out of the credential-dependent live-DB job into a tier that cannot be starved, and pins both baseline totals so a scanner that loses part of the tree fails instead of reporting a clean repo. |

The write half already ships: `check:silent-supabase-writes` runs in `run-all-checks.sh:143`
against `scripts/SILENT_SUPABASE_WRITES_BASELINE.json` — **29 file entries, 39 sites**, shrink-only.
The fix policy it encodes is in `.agents/memory/discarded-write-audits.md`: primary
state-transition write → `sendError`; secondary cascade after the primary commits → log and
continue; audit/system-message inserts → always best-effort.

`src/test/silentSchemaErrorCatches.test.ts:77-89` is the narrower, already-green gate: seven
`GATE_TABLES` (`blocks`, `user_mutes`, `post_hides`, `close_friends`,
`profile_privacy_settings`, `user_account_states`, `message_thread_members`) plus a privacy
predicate over `profiles` columns (`is_private`, `passport_visibility`, `account_status`,
`profile_visibility`, `show_real_name`). Several of the PRs above **move** its pinned markers to
the new fail-closed wording, so a revert to the fail-open text trips it.

## Response shape conventions

**camelCase, produced by hand-written formatters.** There is no serializer layer and no mapping
table; each router formats its own rows. `formatEvent` (`routes/events.ts:3750-3795`) is the
reference: `startsAt`, `goingCount`, `maxAttendees` — **not** `start_time`, `attendee_count`,
`max_capacity`. Guessing the snake_case form cost a shipped bug: the mobile mapper read
`start_time`, got `new Date('').getTime()` → `NaN` on every event, and the Pulse header rendered
"Nothing live right now" against a database full of live events
(`.agents/memory/events-api-field-names.md`). **Read the formatter before adding a client
field**, and accept both forms as a fallback.

Formatters are also where **field-level authorization** lives: `formatEvent` redacts
`locationLat`/`locationLng` unless the viewer is the host or has a going RSVP, `priceUrl` to
participants, `safetyNotes` to the host (`events.ts:3753-3787`). A new response path that reads
the row directly instead of calling the formatter silently drops those redactions.

Four files leak snake_case: `adminRankingConfig.ts:220,316` (`old_value`, `old_enabled`),
`compass.ts:1995,2048,2860` and `places.ts:460,495` (`powered_by`) — the compass ones because a
DB row is spread into the response as a fallback.

**There is no uniform list envelope.** Each router names its own collection key — `places`,
`items`, `events`, `stamps`, `trips`, `buddies`, `gems`, `recommendations`, `suggestions`. The
one near-universal convention is `{ ok: true }` as a mutation acknowledgement (**280** sites).
Adding a shared envelope now would be a breaking change across every client screen; the
practical rule is that a *new* list endpoint should use `{ items, nextCursor }` and,
per #459, a failure marker that is **omitted** on success.

## Auth and authorization posture

Bearer-token only. `requireUser` (`http.ts:185-233`) verifies the token through
`auth.getUser` on the **service-role** client — the token's user is the only source of identity,
and a `user_id` in a request body is never trusted (`http.ts:182-183`). `optionalUser`
(`http.ts:159-172`) returns `null` without writing a 401, for public endpoints that enrich for a
signed-in caller.

**The structural rule is enforced: if a handler writes, it authenticates through `requireUser`.**
`scripts/check-route-auth-gate.mjs` fails the build when any POST/PUT/PATCH/DELETE handler calls
`auth.getUser` itself, and it runs in `run-all-checks.sh:114`. The rule exists because
`requireUser` is the *only* place the ban/suspend gate is applied and banning does not revoke
sessions: six mutating routes in `trips.ts` verified their own JWT, so a banned account could
keep calling `POST /trips/:id/invite` — inserting a `trip_members` row and firing a push at the
target. Nothing failed; every test authenticated as a non-banned user. GET handlers and the
optional-viewer helpers (`getViewerId`, `getOptionalViewerId`, `resolveCallerId`) are
deliberately exempt.

Admin: one guard, `requireAdmin` (`lib/requireAdmin.ts:88-132`), default role set `['admin']`,
widened to `['admin','owner']` only by `rentABuddyRollout.ts`. The role is read through the
*caller's own* client, not the service client (`requireAdmin.ts:103-111`).

Machine callers: two `/internal/*` endpoints (`profile.ts:1627`,
`rentABuddy.ts:6302`) plus the two webhooks, authenticated by shared secret through
`safeSecretEquals` (`http.ts:14-19`), which hashes both sides before `timingSafeEqual` so neither
content nor length leaks through response timing.

Ambient posture: `helmet()` first (`app.ts:25`), CORS from `ALLOWED_ORIGINS` with a **warned**
hardcoded fallback and an origin-less allowance for mobile/curl (`app.ts:31-86`), body limit
256 kb (`app.ts:131`). Rate limiting is `src/lib/rateLimit.ts` — fixed-window, synchronous
decision, Redis-backed when `REDIS_URL` is set and **fail-open to per-process buckets** when it
is not, so with N instances a client gets N× the budget. Any exact cross-instance ceiling must be
enforced against the DB; the call-start limit is the worked example. `Retry-After` is set on
some 429s (`circle.ts:725`, `discoverySearch.ts:1778`) but is not a global property of the code.
Rate-limit buckets are module-global and bleed across test files — call `_resetRateLimit()` per
suite (`.agents/memory/api-server-testing.md`).

Every async handler must be wrapped in `asyncHandler` (`src/lib/asyncHandler.ts:22-26`) so
rejections reach the global handler; `check:async-handlers` enforces it against a frozen legacy
allowlist (`run-all-checks.sh:129`).

## Pagination

Two regimes, and the split is not by design.

**Keyset (correct, 4 sites).** The sort key is a *tuple* — `created_at DESC, id DESC` — so the
cursor must carry **both** the emitted row's timestamp and its UUID. A UUID-only cursor skips or
repeats rows whenever timestamps differ or UUID order is non-monotonic. The predicate is

```
created_at.lt.<ts>, and(created_at.eq.<ts>, id.lt.<id>)
```

`src/lib/mediaCursor.ts:13-65` is the canonical implementation: base64url-encoded
`{created_at, id}`, opaque to the client, `null` on any malformation. Its validation is
**security-relevant, not hygiene**: both fields are interpolated **raw** into a PostgREST
`.or()` filter, so `id` must match a UUID regex and `created_at` must carry none of the `( ) ,`
metacharacters that could terminate the group (`mediaCursor.ts:34-41`). The other three sites
hand-roll the same tuple: `mediaFeed.ts:942`, `placeDays.ts:107`, `sharedMoments.ts:298-300`
(with its own `cursorSchema`, `sharedMoments.ts:25-34`).

Two rules from `.agents/memory/shared-moments-pagination-approval.md`, both visible in
`sharedMoments.ts:280-332`: **validate the cursor before the membership check**, and **page the
source query separately from visibility filtering** — a blocked/private/unpublished row must not
consume the only over-read slot, or an underfilled page terminates before older visible rows are
reached.

**Offset / `.range()` (everything else, ~105 sites).** Cheap, and wrong under concurrent
insert: rows shift between pages. Nothing prevents a new endpoint from choosing it.

## Versioning

There is effectively none. **29** registrations sit under `/api/v1/*` — the intel family
(`intel.ts`, `intelApi.ts`, `intelCoverage.ts`, `intelObservability.ts`, `intelOutcomes.ts`,
`intelReadModels.ts`), `trails.ts` and `mediaViewRequest.ts`. The other **1353** are unversioned.
`/api/v1/internal/intel/*` is both versioned *and* internal; `intel.ts:302` registers
`…/claims:action`, a colon-suffixed custom method that appears nowhere else. Treat `/v1` as an
island one unit adopted, not a scheme.

`intelReadModels.ts:63-71,175-177` is the only conditional-request implementation in the tree:
weak `ETag` from a state-version token, `304` on a matching `If-None-Match`.

## What is NOT built, and why

- **There is no API specification artifact for this API.** `lib/api-spec/openapi.yaml` exists
  (305 lines) and describes exactly **three** paths — `/healthz`, `/healthz/cleanup`,
  `/discovery/search` — out of 1382 registrations. `orval` generates `@workspace/api-zod` from
  it (`lib/api-zod/src/generated/api.ts`, 10 schemas), and precisely **two** route files import
  the result (`health.ts`, `discoverySearch.ts`). It is a working pipeline with 0.2 % coverage,
  not a contract. **This document is a description of the surface; it is not that artifact and
  cannot be generated from one.**
- **Request validation is per-route.** 89 route files import `zod` directly and hand-roll their
  schemas; there is no shared request-schema registry and no middleware that applies one.
- **No idempotency keys on mutating endpoints.** The token appears only in intel/stamp service
  internals, never as a client-supplied request header.
- **No uniform list envelope, no cursor standard, no pagination middleware** — see above. Each
  is a per-router decision, which is why the tuple-cursor rule keeps having to be rediscovered.
- **No enforced cross-router mount-order guard.** PR #468's checker is per-file by design and
  says so; mount order between routers stays a comment in `routes/index.ts`.
- **The read-side silence guard is not merged.** `check:silent-supabase-reads` (#473) ships the
  scanner and a 301-site baseline and **fixes nothing**; the eight remediation PRs above are
  independent and equally unmerged. Until they land, "empty" from this API means either
  *empty* or *broken*, and the response does not say which.

## Cross-references

- `.agents/memory/spec-alias-rewrite.md` — the routing rule and the alias dead-route trap.
- `.agents/memory/events-api-field-names.md` — the camelCase formatter contract.
- `.agents/memory/shared-moments-pagination-approval.md` — tuple cursors, approval as a state
  transition.
- `.agents/memory/discarded-write-audits.md` — how to find discarded writes; the fatal vs
  best-effort fix policy.
- `.agents/memory/api-server-testing.md` — `node:test`, manual test registration, and why a
  green suite says nothing about database behaviour.
- `.agents/memory/fake-client-builder-drift.md` — why a route change that adds a builder call
  turns hand-written test fakes into 500s or silent fallbacks.
- `docs/architecture/01_Portava_Discovery_Engine.md` — the `/discovery`, `/discovery/feed`,
  `/discovery/search`, `/discovery/suggest`, `/discovery/community` serve points.
- `docs/architecture/00_STATUS.md` — which of these documents describe the running system.
