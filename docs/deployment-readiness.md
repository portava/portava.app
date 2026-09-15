# Deployment readiness, flag enablement, and runtime verification

Written 2026-09-15 against `claude/deployment-runtime-prep`, branched from
`origin/claude/post-merge-census-redeclare` at `ec7fc8403`.

Every claim below is labelled **VERIFIED** (a file was read, or a command was
run in this worktree and its exit code recorded) or **ASSUMED** (inferred, not
executed — usually because executing it would require an access this
environment does not have, or a mutation this lane is not allowed to make).
Nothing here was run against a database, and no flag was changed.

Citations are written `path:line#needle`, where the needle is text that
appears on the cited line.

---

## 1. Deployment readiness

### 1.1 What the deployment target is

**VERIFIED.** Deployment is a Replit **autoscale** deployment, configured
entirely in `.replit`:

| Setting | Value | Evidence |
|---|---|---|
| `deploymentTarget` | `autoscale` | `.replit:5#deploymentTarget` |
| `build` | `bash scripts/build-production.sh` | `.replit:14#build` |
| `run` | `pnpm --filter @workspace/api-server run start` | `.replit:15#run` |
| production `ALLOWED_ORIGINS` | `https://portava.replit.app` | `.replit:159#ALLOWED_ORIGINS` |

**VERIFIED.** `.replit` itself says these are best-effort: lines 11-13 of that
file state that deployment settings configured in the Replit UI override the
file, and that the commands must be confirmed in the Replit Deployments UI
before being relied on. **Nothing in this repository can read or assert what
the Replit UI actually holds.** That is the first and largest gap in this
document: the build and run commands above are what the repo *asks for*, not
what the deployment *does*.

### 1.2 No GitHub workflow deploys this app

**VERIFIED**, re-established by reading all four workflow files at this HEAD
(read-only; none was modified):

- `.github/workflows/ci.yml` — jobs `preflight`, `api-server-static`,
  `api-server-tests`, `api-server-local-db`, `standalone-checks`,
  `ci-self-check`, `ci-verdict`. `permissions: contents: read`
  (`.github/workflows/ci.yml:47#permissions`), and its own header states no job
  writes, comments on, or publishes anything.
- `.github/workflows/live-db.yml` — jobs `preflight`, `live-db-slot`,
  `api-server-check-all`, `schema-drift`, `post-media-revocation-rehearsal`,
  `live-db-security-suites`, `live-db-verdict`. `contents: read` plus
  `actions: read` (`.github/workflows/live-db.yml:111#permissions`). It
  contains the phrase "the live_pulse deploy **gate**"
  (`.github/workflows/live-db.yml:507#deploy`) — that is a *check* named
  `check:rank-events-surfaces`, not a deployment step.
- `.github/workflows/clean-build-proof.yml` — jobs `preflight`,
  `live-unexplained`, `clean-build-proof`, `verdict`. "Clean build" here means
  rebuilding the **CI Supabase database**, not building or shipping the app.
- `.github/workflows/unwired-checks.yml` — jobs `preflight`, `root-workspace`,
  `standalone`, `unwired-verdict`.

**VERIFIED.** Every `uses:` across all four files resolves to a first-party
GitHub action — `actions/checkout@v4` (20), `actions/setup-node@v4` (17),
`actions/cache@v4` (11), `actions/upload-artifact@v4` (1), plus one `uses: it`
inside a prose comment. There is **no third-party action at all**, so in
particular no deploy action. No `environment:` key names anything but
`ci-nonprod-supabase`. **Conclusion: nothing merges-and-deploys. A deploy is a
human action in the Replit UI.**

### 1.3 Does the build succeed at this HEAD?

`scripts/build-production.sh` is two steps and `set -e`
(`scripts/build-production.sh:5#set`).

**Step [1/2] — `pnpm --filter @workspace/api-server run build`
(`scripts/build-production.sh:8#pnpm`): VERIFIED PASSING, exit 0.**

Run in this worktree. It is `checkSentryOtelDeps.ts && node ./build.mjs`; the
second is an esbuild bundle that writes only to `artifacts/api-server/dist`
(`artifacts/api-server/build.mjs:143#outdir`). It reads no network and no
database. Output: `dist/index.mjs` (10.2 MB), `dist/sentry-preload.mjs`, four
pino worker bundles, and source maps. Two warnings about
`expo/tsconfig.base` not resolving; both are non-fatal.

Note the runtime the `run` command needs is exactly what step 1 produces:
`node --import ./dist/sentry-preload.mjs ... ./dist/index.mjs`. Both files
exist after step 1. **VERIFIED.**

**Step [2/2] — `node travel-buddy-standalone/scripts/build.js`
(`scripts/build-production.sh:11#node`): NOT RUN. Deliberately.**

Two reasons, both read out of the script rather than guessed:

1. **It mutates state outside this worktree.** Its `main()` begins by running
   `pnpm install --frozen-lockfile` at the **workspace root**
   (`travel-buddy-standalone/scripts/build.js:518#spawnSync`). In this worktree
   `node_modules` is a **symlink into the coordinator's checkout at
   /home/user/portava.app**, so that install would rewrite the coordinator's
   dependency tree. It also `rmSync`s `node_modules/.cache/metro`
   (`travel-buddy-standalone/scripts/build.js:103#metro`), through the same
   symlink. Running it here would be an unrequested mutation of another
   agent's working tree.
2. **It cannot succeed here anyway.** `getDeploymentDomain()`
   (`travel-buddy-standalone/scripts/build.js:57#getDeploymentDomain`) requires
   one of `REPLIT_INTERNAL_APP_DOMAIN`, `REPLIT_DEV_DOMAIN` or
   `EXPO_PUBLIC_DOMAIN` and calls `process.exit(1)` otherwise
   (`travel-buddy-standalone/scripts/build.js:71#ERROR`). **VERIFIED**: none of
   the three is set in this environment.

**VERIFIED** by reading all 587 lines: step 2 deploys nothing, publishes
nothing and touches no database. Every network call it makes is to
`http://localhost:8081` — a Metro dev server it spawns itself
(`travel-buddy-standalone/scripts/build.js:149#metroProcess`) — and its only
output is `travel-buddy-standalone/static-build/`. So the reason it was not
run is the symlinked `node_modules` and the missing domain, **not** a risk of
shipping something.

**ASSUMED:** that step 2 would pass on Replit, where the domain variables and a
real (non-symlinked) `node_modules` exist. That assumption is untested by this
lane and is the largest untested part of the build.

**VERIFIED / caveat:** this environment runs Node **v22.22.2**, while `.replit`
declares `nodejs-24` (`.replit:1#modules`) and CI pins `NODE_VERSION: '24'`
(`.github/workflows/ci.yml:61#NODE_VERSION`). Step 1 passing on Node 22 is
evidence the bundle is not Node-24-dependent; it is **not** evidence about
Node 24 specifically.

### 1.4 What a deploy needs that the build does not provide

**VERIFIED by booting the built artifact.** `dist/index.mjs` was started in
this worktree with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
`SESSION_SECRET` unset. It logged
`env: required variables missing — set them in Replit Secrets and restart` and
**exited 1**. The manifest is `REQUIRED_KEYS`
(`artifacts/api-server/src/lib/envValidation.ts:9#REQUIRED_KEYS`), enforced by
`process.exit(1)`
(`artifacts/api-server/src/lib/envValidation.ts:89#process.exit`):

| Key | In `.replit` `[userenv]`? | Therefore |
|---|---|---|
| `PORT` | no — Replit injects it | supplied by the platform |
| `SUPABASE_URL` | **yes**, `.replit:151#SUPABASE_URL` | present |
| `SUPABASE_SERVICE_ROLE_KEY` | **no** | **must be a Replit Secret** |
| `SESSION_SECRET` | **no** | **must be a Replit Secret** |

**This is the deployment's hard requirement and it is invisible to CI.** Two of
the four required secrets exist only in the Replit Secrets UI. Neither this
repo nor any workflow can confirm they are set; the only way to find out is a
boot that either serves or exits 1.

Optional-but-feature-disabling keys, same source
(`artifacts/api-server/src/lib/envValidation.ts:17#OPTIONAL_KEYS`):
`AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`,
`INTERNAL_API_SECRET`, `MAPBOX_TOKEN`, `SENSING_CONTRIBUTOR_PEPPER`.

**VERIFIED.** `scripts/build-production.sh` applies **no migrations**; neither
does any workflow. `docs/migrations.md:49#Nothing` states it outright:
"Nothing in the merge path applies migrations". So a deploy of this HEAD ships
code whose migrations may not be on the production database, and the repo's own
answer to that is `pnpm run check:migration-ledger`
(`artifacts/api-server/package.json:217#check:migration-ledger`), which needs
database credentials this environment does not have.

### 1.5 Deployment readiness checklist

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | API bundle builds | **VERIFIED PASS** (exit 0) | ran step 1 in this worktree |
| 2 | Built bundle boots and serves | **VERIFIED PASS** | see §3.1 |
| 3 | Frontend static build | **ASSUMED** — not run | `travel-buddy-standalone/scripts/build.js:518#spawnSync` |
| 3a | ⚠ 2970 applied to production BEFORE the next deploy of `main` | **REQUIRED — NOT DONE.** `buildStats` already selects `evidences_presence`; the column is on neither database | §1.7 |
| 4 | `SUPABASE_SERVICE_ROLE_KEY` set | **UNKNOWN — human must confirm in Replit Secrets** | `artifacts/api-server/src/lib/envValidation.ts:9#REQUIRED_KEYS` |
| 5 | `SESSION_SECRET` set | **UNKNOWN — human must confirm in Replit Secrets** | same |
| 6 | Replit UI build/run commands match `.replit` | **UNKNOWN — human must confirm in the Deployments UI** | `.replit:11#Best-effort` |
| 7 | Migrations on production match this branch | **MEASURED — NO. 156 of 549 migration files have no production ledger row** | §1.6, read from `public.schema_migration_ledger` on `ajrurzioarfkagpuxfnb` |
| 8 | Repo typecheck / census checks | **VERIFIED PASS** | §4 |

Items 4, 5 and 6 cannot be closed from this environment by any means. They are
not "probably fine"; they are unmeasured, and each needs a human in the Replit
UI. **Item 7 is now measured — see §1.6 — and the answer is no.**

### 1.6 Production migration gap, MEASURED

**VERIFIED 2026-09-15, read directly from `public.schema_migration_ledger` on the
production project `ajrurzioarfkagpuxfnb`.** This closes checklist item 7, which
this document previously recorded as UNKNOWN for want of credentials. It is a
READ; nothing was applied.

| | |
|---|---|
| migration files in `artifacts/api-server/src/migrations` | **549** |
| distinct filenames with a production ledger row | **393** |
| **files with NO production ledger row** | **156** |
| rows with `applied_by='backfill'` | 382 (`0010_trip_plan.sql` … `2254_schema_migration_ledger.sql`) |
| rows with `applied_by='manual'` | 11 (`2338_memory_location_precision.sql` … `2730_memory_derivative_registry.sql`) |
| rows at or above `2890` | **zero** |

**WHAT THE 393 DOES AND DOES NOT PROVE.** 382 of those rows carry
`applied_by='backfill'` with the literal string `backfill` as their checksum.
That is a row asserting parity, not evidence of an apply — the same distinction
migration 2298 made concrete, where a ledger row existed and the migration's
effects were provably absent. So 393 is an UPPER bound on what production has
actually run, and 156 is a LOWER bound on the gap. The honest statement is:
**at least 156 migrations in this branch have never been recorded against
production, and an unknown further number have a row that proves nothing.**

**THE WHOLE 2890-2971 BAND IS ABSENT.** Production carries zero ledger rows at
or above 2890. Every migration this session has worked on — 2890 through 2971,
including 2910, 2920, 2921, 2970 and 2971 — is unapplied to production. Nothing
in this session changed that, and nothing in this session was authorised to.

**THIS IS A TEST-DATABASE-VS-PRODUCTION DISTINCTION, NOT PROGRESS.** Migration
work certified against `portava-ci` (`hwokxgbmezheskbzskfr`) says nothing about
production. The two databases are measured separately and reported separately
throughout this document.

### 1.7 ⚠ ORDERING HAZARD: a reader is merged ahead of its column

**VERIFIED 2026-09-15 by reading the code on `main` and querying both databases.
This is a DEPLOY-ORDER constraint, not a defect in either half.**

`services/passport/PassportMapService.ts:444#buildStats` — on `main` since
#482 — issues:

```
.select("country, city, visibility, is_revoked, stamp_definitions(category, slug, evidences_presence)")
```

`stamp_definitions.evidences_presence` is added by
`2970_stamp_definitions_evidences_presence.sql`, which is applied to **neither**
database: the column is absent on production `ajrurzioarfkagpuxfnb` and absent on
`portava-ci` `hwokxgbmezheskbzskfr` (both queried directly).

PostgREST rejects a select naming a column that does not exist, so `buildStats`
takes its documented failure branch and returns
`countries: 0, cities: 0, neighborhoods: 0, planStamps: 0, hostStamps: 0,
hiddenGemStamps: 0, safeReturnStamps: 0, totalStamps: 0` with `readFailed: true`
(`PassportMapService.ts:452`).

**THE FLAG IS HONEST AND THE SCREEN IS NOT.** `routes/passportStamps.ts:557`
spreads `stats` into the response, so `readFailed` does reach the client — and
`readFailed` appears **zero** times anywhere in `travel-buddy-standalone/src`.
Nothing reads it. A traveller with a full Passport is therefore shown
**0 countries, 0 cities, 0 stamps**, with no indication that the server could not
look.

That is the exact defect 2970 was written to remove, inverted: 2970 stops the
Passport over-claiming ("you have been to 5 countries" for trips only planned),
and this ordering makes it under-claim everything instead. Under-claiming is the
safer of the two — it asserts nothing untrue *about where someone has been* — but
"0 countries" shown to someone who has travelled is still a false number on a
screen, and it is total rather than partial.

**WHAT IS NOT KNOWN FROM HERE:** whether production is *currently* serving this.
It depends on whether the deployment has been rebuilt from `main` since #482
landed, and `https://portava.replit.app` is unreachable from this environment
(§3.4) while the Replit Deployments UI cannot be read. **If the deployment
predates #482 the Passport is fine today; if it has been rebuilt since, it is
returning zeros now.** A human with the Replit dashboard can settle it in one
look at the deployment's commit.

**THE CONSTRAINT THIS PLACES ON THE NEXT DEPLOY, and it is not optional:**
`2970_stamp_definitions_evidences_presence.sql` must be applied to production
**before or with** the next deploy of `main`. Deploying the code first reproduces
the zeros; applying the migration first is harmless to the running build, because
the old code does not select the column. **Migration first, then deploy — never
the other way round.** 2970's own header states the coupled form of this rule
from the reverse direction: "Revert both, or neither."


---

## 2. Feature flags

### 2.1 How flags are stored and read

**VERIFIED.** One table, `public.feature_flags`, keyed on a `flag` text column
(not `key`), with a boolean `enabled` and a `metadata` jsonb. Three readers, all
in one file:

- `isFlagEnabled` — capability gate, **fail-closed**: error, exception or absent
  row all return `false`
  (`artifacts/api-server/src/lib/featureFlags.ts:14#isFlagEnabled`).
- `isKillSwitchEngaged` — emergency stop, **fails engaged** on error but *not*
  on a missing row
  (`artifacts/api-server/src/lib/featureFlags.ts:55#isKillSwitchEngaged`).
- `isLivePlacesCapabilityEnabled` — conjunction over a declared parent chain
  (`artifacts/api-server/src/lib/featureFlags.ts:119#isLivePlacesCapabilityEnabled`).

The guard `npm run check:flag-polarity`
(`artifacts/api-server/scripts/check-flag-polarity.mjs:3#check-flag-polarity`)
requires every flag name to carry a recorded classification (STOP / CAPABILITY
/ CONFIG) and to be read through the matching reader, and reconciles the seeded
population against the read population in both directions. Its own header is
explicit that it **cannot** verify a classification is *right* or that a seeded
value is the one anyone intended.

**VERIFIED.** A mechanical sweep of `artifacts/api-server/src/migrations/*.sql`
for the shape `INSERT INTO public.feature_flags (...) VALUES ('name', bool`
found **74** distinct flags, **72 of them seeded `false`**. The two exceptions
are `passport_contribution_events_enabled` (2084) and `push_notifications_enabled`
(0062). That sweep matches one INSERT shape only; older migrations that seed in
a different layout — `0037`, `0043`, `0117`, `0127` — hold a further set, several
of them `TRUE` (e.g. `airport_mode_enabled`,
`artifacts/api-server/src/migrations/0127_layover_system.sql:225#airport_mode_enabled`).
So 74 is a floor on the population, not a total. **VERIFIED**: no migration in
`src/migrations/` ever `UPDATE`s `enabled` for any flag named in §2.2 — the
only executable `UPDATE feature_flags SET enabled` statements are in `2077` and
`0119`'s function body, and neither touches these.

### 2.2 Flags gating the work in flight

Every value below is the **seeded** value from a migration file. **ASSUMED**
that the live rows still hold the seeded value: this lane ran no SQL, and the
live database is authoritative over every migration file
(`docs/migrations.md:23#live`).

#### Discovery

| Flag | Seeded | Seeded by | What enabling changes |
|---|---|---|---|
| `discovery_live_rank_enabled` | `false` | `artifacts/api-server/src/migrations/2850_discovery_live_rank_flag.sql:39#discovery_live_rank_enabled` | Re-orders the **head window** of an already-ranked `GET /discovery` feed on live claims, by a bounded delta. A Live-qualified `unsafe_density` demotes and can never promote. Off, the serve path returns the same array reference and reads no claim. **It changes the order a real user is served.** |
| `discovery_candidate_projection_enabled` | `false` | `2361_discovery_candidate_projection_flag.sql` | Adds the candidate projection to served rows. |
| `discovery_ranking_modifiers_enabled` | `false` | `2289_discovery_ranking_modifiers_flag.sql` | Applies ranking modifiers. |
| `discovery_trip_projection_enabled` | `false` | `2550_discovery_trip_projection_consumer_flag.sql` | Trip-projection consumer in Discovery. |
| `discovery_serve_log_enabled` | `false` | `2090_discovery_serve_log_flag.sql` | Writes serve-log rows. |
| `discovery_buddy_launch_gate_enabled` | `false` | `2360_discovery_buddy_launch_gate_flag.sql` | Buddy launch gate on discovery search. |
| `disable_discovery_pde` | `false` | `2091_discovery_engine_mode_flags.sql` | **STOP flag** — `true` disengages the PDE. Read through the kill-switch reader. |

**VERIFIED:** Discovery Trails (`2910_discovery_trails.sql`) seeds **no flag**
and `TrailService` reads none — that lane is ungated.

#### Layover / Airport

| Flag | Seeded | Seeded by | What enabling changes |
|---|---|---|---|
| `airport_mode_enabled` | **`TRUE`** | `artifacts/api-server/src/migrations/0127_layover_system.sql:225#airport_mode_enabled` | Master gate; every `/api/airport/*` route checks it first. Seeded on. |
| `layover_live_intersection_enabled` | `false` | `artifacts/api-server/src/migrations/2851_layover_live_intersection_flag.sql:42#layover_live_intersection_enabled` | Adds a Live-qualified queue wait to a card's activity time before the safety engine rates it; **drops** cards with a Live `unsafe_density` or refused walk-in; re-orders survivors. **It can remove a card a traveller would otherwise have been offered and it changes a safety rating.** |
| `layover_safe_return_status_enabled` | `false` | `2741_layover_session_returning_status.sql` | Lets `POST /airport/sessions/:id/return-now` write the `returning` status. Gated on the flag **AND** a build constant. |
| `layover_presence_ladder_enabled` | `false` | `2740_layover_presence_ladder_flag.sql` | Presence ladder on session presence/buddies reads (`artifacts/api-server/src/routes/airport.ts:2153#ladderEnabled`). |
| `layover_stable_recommendation_ids_enabled` | `false` | `2410_layover_recommendation_identity.sql` | Stable recommendation identity. |
| `hidden_gems_layover_enabled` | `TRUE` (0xxx band) | `artifacts/api-server/src/migrations/0043_hidden_gems.sql:234#hidden_gems_layover_enabled` | Layover-mode gem filtering. |

**`layover_safe_return_status_enabled` has a prerequisite no flag can express.**
The route computes `statusEnabled = flagOn && LAYOVER_RETURNING_READERS_WIDENED`
(`artifacts/api-server/src/routes/airport.ts:1295#layover_safe_return_status_enabled`),
where the constant is a property of the deployed **build**
(`artifacts/api-server/src/services/airport/LayoverSessionService.ts:69#LAYOVER_RETURNING_READERS_WIDENED`).
It is `true` at this HEAD — **VERIFIED**. A third prerequisite is that
migration `2741` is applied, because the ledger insert uses an `event_type` the
`layover_events` CHECK rejects without it. So enabling this flag on a
deployment running older code, or on a database without 2741, is the documented
failure it was written to prevent.

#### `creator_attribution`

**The name in the task brief is wrong, and the migration says so.** There is no
flag called `creator_attribution`. Migration 2922 seeds
**`creator_attribution_enabled`** at `false`
(`artifacts/api-server/src/migrations/2922_creator_attribution_flag.sql:59#creator_attribution_enabled`),
and its postcondition **raises** if a row named `creator_attribution` exists,
on the grounds that no code reads that name so it would be a gate nothing can
reach
(`artifacts/api-server/src/migrations/2922_creator_attribution_flag.sql:83#POSTCONDITION`).
The rename to `*_enabled` was deliberate: it is the CAPABILITY convention
`check:flag-polarity` requires.

Enabling it would permit: recording a `creator_attributions` row, booking a
balanced `creator_earning_entries` pair, placing a fraud hold, and recomputing a
historical total under an older rule version. **With it off every one of those
refuses with `disabled` and writes nothing.**

**VERIFIED: enabling it changes nothing observable today.** A grep across
`src/routes/`, `src/lib/` and `src/server/` finds **no caller** of
`CreatorAttributionService` — only a doc comment reference in
`artifacts/api-server/src/lib/creatorTypeAttribution.ts:43#CreatorAttributionService`.
There is no route and no scheduler that reaches it, which is exactly what 2922's
own header claims
(`artifacts/api-server/src/migrations/2922_creator_attribution_flag.sql:36#WHY`).

### 2.3 The supported path to enable a flag

**VERIFIED.** Two paths exist and the repo's runbook names both
(`docs/feature-flags.md:10#PATCH`).

**Path A — the admin API (preferred; audited).**

```
GET   /api/admin/feature-flags
PATCH /api/admin/feature-flags/<flag>      Body: { "enabled": true }
```

- `artifacts/api-server/src/routes/admin.ts:707#router.get` and
  `artifacts/api-server/src/routes/admin.ts:766#router.patch`.
- Requires a bearer token for a profile whose `role` is `admin`
  (`artifacts/api-server/src/lib/requireAdmin.ts:74#DEFAULT_ROLES`); fail-closed
  on query error, absent profile and unmatched role.
- The PATCH goes through the `toggle_feature_flag_with_audit` RPC, so the
  update and the `feature_flag_audit_log` insert share one transaction — a
  committed toggle always has an audit row. If migration `0119` is missing the
  route answers **503 `server_not_configured`** naming that migration.
- Flags in `HIDDEN_INERT_FLAGS`
  (`artifacts/api-server/src/routes/admin.ts:662#HIDDEN_INERT_FLAGS`) are
  refused with **400 `not_operational`**. None of the flags in §2.2 is in that
  set — **VERIFIED**.

**Path B — direct SQL** (`UPDATE feature_flags SET enabled = true ...`). The
runbook lists it, but it **bypasses the audit log**. Prefer Path A.

**Not done here, and out of this lane's scope:** no flag was enabled, no SQL was
run, and no database was contacted. Every flag above is an **owner decision**;
2850 and 2851 both say so in their own headers, and both carry a postcondition
that refuses to commit the migration if the row already reads `TRUE`.

**Ordering constraint, VERIFIED:** `LIVE_PLACES_REQUIREMENTS`
(`artifacts/api-server/src/lib/featureFlags.ts:98#LIVE_PLACES_REQUIREMENTS`)
declares parent chains for eight `live_places` flags. Enabling a child without
its parents resolves to `false`, so those must be enabled outermost-first.

**Stale doc, VERIFIED:** `docs/feature-flags.md` documents only the `0037`,
`0041`, `0042` generation of flags. None of the 2xxx flags in §2.2 appears in
it. Its API instructions are still correct; its inventory is not.

---

## 3. Runtime verification plan

### 3.1 What was actually verified locally

**VERIFIED.** The built `dist/index.mjs` was started in this worktree on
`127.0.0.1:8791` with `SUPABASE_URL=http://127.0.0.1:9` (deliberately
unreachable), a dummy service key and a dummy `SESSION_SECRET` — **no real
database was contacted.** Results:

| Request | Result |
|---|---|
| `GET /api/healthz` | **200** `{"status":"ok"}` |
| `GET /api/healthz/schedulers` | **200**, `jobCount: 10` |
| `GET /api/admin/feature-flags` (no auth) | **401** `unauthenticated` |
| `GET /api/discovery` (no params) | **400** `invalid_payload`, "destination is required" |

This proves the bundle boots, mounts its routers, enforces admin auth, and
validates payloads. It proves **nothing** about production.

### 3.2 Post-deploy checks that need **no** credentials

Base URL `https://portava.replit.app`. All unauthenticated.

1. **The deploy is live and is this build.**
   `GET /api/healthz` → **200** `{"status":"ok"}`.
   (`artifacts/api-server/src/routes/health.ts:30#healthz`.) A non-200, or an
   HTML error page, means the process is not serving — most likely the
   `process.exit(1)` from §1.4.
2. **Background jobs are not failing.**
   `GET /api/healthz/schedulers` → **200** when healthy, **503** when any job is
   failing, **503** with `"no scheduler reported"` if the report list is empty
   (`artifacts/api-server/src/routes/health.ts:350#schedulers`). The body names
   each job and its status, so this one request distinguishes "deployed but
   idle" from "deployed and working".
3. **Cleanup and delayed-publish are alive.**
   `GET /api/healthz/cleanup` and `GET /api/healthz/delayed-publish`
   (`artifacts/api-server/src/routes/health.ts:35#cleanup`,
   `artifacts/api-server/src/routes/health.ts:67#delayed-publish`). These are
   DB-backed, so a 200 here is also evidence the service client has real
   credentials — which `/api/healthz` alone does **not** prove.
4. **Admin surface is closed to the public.**
   `GET /api/admin/feature-flags` with no `Authorization` → **401**. Anything
   else is a finding.
5. **CORS allowlist is the configured one.** An `OPTIONS` preflight from
   `Origin: https://portava.replit.app` should be allowed; from an unrelated
   origin, refused. The fallback list logged at boot when `ALLOWED_ORIGINS` is
   unset still contains two retired `travel-buddy.io` domains, so seeing those
   accepted means `.replit:159#ALLOWED_ORIGINS` did not reach the deployment.

### 3.3 Checks that prove a flag actually took effect

**`discovery_live_rank_enabled` — response-visible. This is the strongest
runtime proof available for any flag in §2.2.** `GET /discovery` emits a
`meta.liveRank` object **only** when the pass applied
(`artifacts/api-server/src/routes/discovery.ts:1899#liveRank`, and the cold path
at `artifacts/api-server/src/routes/discovery.ts:2332#liveRank`), carrying
`mode`, `readable`, `windowSize` and `demoted`.

- Before enabling: `meta.liveRank` **absent**.
- After enabling: `meta.liveRank` **present**. `readable: false` means the live
  gates refused the read — a different fact from "no place was live", and the
  distinction is the point of the field.
- Requires a caller token (Discovery is behind `requireUser`) and a
  `destination` parameter — the 400 in §3.1 is the proof of that.

**`layover_live_intersection_enabled` — NOT response-visible. Be honest about
this.** The only in-process signal is the log line
`"layover live intersection applied"`
(`artifacts/api-server/src/services/airport/LayoverRecommendationService.ts:637#layover`),
emitted with `readable`, `dropped` and `frictionAdjusted`. Nothing is added to
the HTTP response. Verifying it at runtime therefore requires **either** the
Replit deployment logs **or** a before/after comparison of
`GET /airport/sessions/:id/recommendations`
(`artifacts/api-server/src/routes/airport.ts:936#recommendations`) for the same
session, looking for dropped or reordered cards — and a reorder can legitimately
be empty when no candidate has live evidence, so an unchanged response does
**not** falsify the flag. **This check cannot be made conclusive from outside
the process.**

**`layover_safe_return_status_enabled`** — `POST /airport/sessions/:id/return-now`
returns an `effects` object reporting every effect that ran
(`artifacts/api-server/src/routes/airport.ts:1262#return-now`). With the flag
off the stops are still cancelled and the ledger is still written; only the
status write is gated. So the proof is the session's `status` becoming
`returning`, not the 200 itself. This is destructive to a real session and
should be done against a throwaway one.

**`creator_attribution_enabled`** — **there is no runtime verification.** No
route reaches the service (§2.2), so no request can distinguish on from off.
The only honest check is `GET /api/admin/feature-flags` showing the row flipped.

### 3.4 What cannot be verified from this environment, precisely

1. **`https://portava.replit.app` is unreachable. VERIFIED, re-tested today.**
   `curl https://portava.replit.app/` fails with
   `curl: (56) CONNECT tunnel failed, response 403`. The agent proxy's own
   status endpoint records the reason:
   `{"kind":"connect_rejected","detail":"gateway answered 403 to CONNECT (policy denial or upstream failure)","host":"portava.replit.app:443"}`.
   Per `/root/.ccr/README.md`, a 403 on CONNECT is an **organization egress
   policy denial**, which must be reported and not retried or routed around.
   **Missing access: `portava.replit.app:443` on the session's egress
   allowlist.** No check in §3.2 or §3.3 can be executed from here until that
   changes. TLS verification was not disabled and `HTTPS_PROXY` was not unset.
2. **No admin credential.** Both flag paths need either an `admin`-role bearer
   token or Supabase SQL access. This lane has neither, and acquiring one is
   outside its remit.
3. **No database access.** So the live value of every flag in §2.2 is **ASSUMED
   from its migration file**, not read. Likewise `check:migration-ledger`,
   `check:missing-live-columns` and `audit:schema` cannot run.
4. **No Replit UI access.** Items 4, 5 and 6 of §1.5 — the two secrets and the
   UI-override question — are settings in a console no agent in this session can
   open.

**The honest summary: every runtime check in §3.2 and §3.3 is written to be
runnable, and none of them can be run from here. They need a human with the
Replit UI, or an egress allowlist entry for `portava.replit.app:443`, or both.**

---

## 4. Repo checks at this HEAD

Run from `artifacts/api-server` in this worktree, exit codes verbatim.

| Command | Exit |
|---|---|
| `npm run check:doc-citations` | **0** (`RESULT clean`; UNANCHORED 6433, ceiling 6434) |
| `npm run check:census-freshness` | **0** (`check:census-freshness PASSED`) |
| `npm run check:census-integrity` | **0** (`check:census-integrity PASSED`) |
| `npx tsc --noEmit -p .` | **0** (no output) |

This document adds no bare `path:line` citation: every citation above carries a
`#needle` anchor.
