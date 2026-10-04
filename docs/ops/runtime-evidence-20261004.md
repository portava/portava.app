# Runtime evidence, 2026-10-04 — what is actually running, and whether prod and test are separated

Written 2026-10-04 against `main` at `f71cfb85f`. Read-only. **No flag was changed,
no migration was applied, nothing was deployed, and no database was written or
read** — the production project `ajrurzioarfkagpuxfnb` was not touched at all.

This document exists to discharge one instruction:

> "Update the deployment record only from **evidence of the actual running build**.
> **No flags, hosted migrations, or feature activation until the runtime and
> production/test separation are established.**"

The standard applied throughout: every deployment claim is either a quotation
from a committed artifact, or an HTTP response actually received, with its date.
Where the repo asserts something without evidence, this document says so. Where
the answer is not available, it says **unknown** and names what would settle it.

---

## §0 The four answers, up front

| Question | Answer | Basis |
|---|---|---|
| What build is running at the configured production origin? | **None. Nothing is serving there.** `https://portava.replit.app` answers `HTTP 404` with Replit's own `This app isn't live yet` page on `/`, `/healthz`, `/api/healthz` and `/manifest`, measured 2026-10-04T12:10:38Z–12:16:38Z | §1.1 |
| What was the last build positively identified as *running*? | **`a384e29fa`, 2026-08-15 ~12:13Z**, by a wire-string differential probe — not by any version endpoint. The same corpus then records a *newer, unnamed* build later that same day, a build still predating the memory system on 2026-08-29, a **failed publish on 2026-09-26**, and the process stopping on 2026-09-30 | §1.4 |
| Can the running build be identified *if* something were serving? | **Not as a commit, from the server itself.** There is no version endpoint, no build stamp and no commit sha anywhere in the server's surface. It is identifiable only as a build wall-clock time, or indirectly by a differential probe | §1.2, §1.3 |
| `census-sensing.md:4040` "Production runs main." vs `TRIPS-PRODUCTION-ACTIVATION.md` "The running API version is therefore unknown to me" | **The Trips document is right; `census-sensing.md:4040` is an unevidenced assertion, and the committed publish lineage points against it** | §2 |
| Is the hosted test app separate from production? | **No, on all four axes — same database, same flag table, same storage, same auth.** The flag table *structurally cannot* carry an environment distinction | §3 |

**The consequence that governs everything else:** because `feature_flags` has
`flag` as its sole primary key and both the reader and the audited writer address
exactly one global row per flag name, **no flag can be flipped for testing
without flipping it in production.** There is no separate testing flag state to
flip. This is a schema fact, not an inference (§3.2).

---

## §1 What is the running build?

### §1.1 The direct measurement — the egress block named as the standing blocker is gone, and the answer is "nothing is serving"

Three committed documents record that this question could not be reached from a
Claude Code session because egress was refused.

`docs/TRIPS-PRODUCTION-ACTIVATION.md:102-106`, written 2026-09-17:

> "`portava.replit.app:443` is refused at the egress gateway with a **policy
> denial** (`connect_rejected`, gateway answered 403 to CONNECT). This is not a
> TLS or transient failure and cannot be worked around from here. **The running
> API version is therefore unknown to me, and no Trips flag should be enabled
> until it is known.**"

`docs/architecture/census-compass.md:3393-3397`:

> "**The deployed API is unreachable from here.** `https://portava.replit.app` answers
> `curl (56) CONNECT tunnel failed, response 403` […] Consequence: the running build
> cannot be identified, so no flag whose behaviour depends on deployed code can be
> enabled with evidence."

`docs/architecture/census-layover.md:7206-7212` records the same `curl: (56)
CONNECT tunnel failed, response 403`.

**That blocker is no longer in force, and the question is now answerable.** One
unauthenticated request, no credentials sent, measured from this session:

| Request | Response | Measured at |
|---|---|---|
| `GET https://portava.replit.app/healthz` | `HTTP/2 404`, `content-type: text/html`, `via: 1.1 google`, body title `This app isn't live yet` | 2026-10-04T12:10:38Z |
| `GET https://portava.replit.app/` | `HTTP 404`, same `This app isn't live yet` page | 2026-10-04T12:10:38Z |
| `GET https://portava.replit.app/api/healthz` | `HTTP 404`, same page | 2026-10-04T12:11Z |
| `GET https://portava.replit.app/manifest` (`expo-platform: ios`) | `HTTP 404` | 2026-10-04T12:16:38Z |

`This app isn't live yet` is Replit's **deployment-level** placeholder, served by
Replit's edge for every path on a hostname that has no live deployment behind it.
It is not a route-level 404 from the application: a route-level miss would come
from Express, and the application's only health route is
`artifacts/api-server/src/routes/health.ts:36`, mounted under `/api`
(`artifacts/api-server/src/routes/index.ts:168`, `artifacts/api-server/src/app.ts:189`).

**So the answer to "what build is running at the configured production origin" is
that no build is running there.** This is stronger than an Autoscale cold-start
delay: `.replit:5` declares `deploymentTarget = "autoscale"`, and a suspended
Autoscale deployment wakes on a request and serves it. These four requests were
served by Replit's placeholder instead.

That `portava.replit.app` is the configured production origin is not in doubt —
it is the only live origin the repository names, in three independent places:

- `.replit:159` — `ALLOWED_ORIGINS = "https://portava.replit.app"`, under `[userenv.production]`, with `.replit:157-158` recording that the travel-buddy.io domains were "retired 2026-08-05 (Portava rebrand) — only the live origin remains"
- `artifacts/api-server/src/app.ts:38` — `"https://portava.replit.app"` in the CORS fallback list
- `travel-buddy-standalone/eas.json` — all three build profiles set `EXPO_PUBLIC_API_BASE_URL` to that host, which `docs/architecture/census-layover.md:7201-7202` calls "the base the shipped client is built against, so it is the deployed API by the client's own configuration"

### §1.1.1 A decoy that must be recorded, because it reads as healthy

`https://portava.app` — the domain referenced at
`artifacts/api-server/src/routes/mediaFile.ts:37` — **is not the Portava API.**

| Request | Response | Measured at |
|---|---|---|
| `GET https://portava.app/healthz` | `HTTP/2 200`, `server: Squarespace`, `content-length: 0` | 2026-10-04T12:13:10Z |
| `GET https://portava.app/this-path-does-not-exist-9f3a2b` | `HTTP 200`, `server: Squarespace` | 2026-10-04T12:14Z |
| `GET https://portava.app/api/trips/zzz` | `HTTP 200`, `server: Squarespace` | 2026-10-04T12:14Z |
| `GET https://portava.app/` | `HTTP 200`, page title `Yakında` | 2026-10-04T12:14Z |

It is a Squarespace "coming soon" placeholder that answers `200` to **every**
path with an empty body. **Any health check that asserts only on the status code
would report this host green while reaching no API at all.** Nothing may treat a
`200` from `portava.app` as evidence that anything is deployed.

### §1.2 Every available way to establish the running build, and what each says

| # | Channel | Reachable from here? | What it says |
|---|---|---|---|
| 1 | `GET /healthz` on the deployed host | **Yes** (egress open as of today) | Nothing is serving — `404 This app isn't live yet`. And even on a live host it could not identify a build: see row 2 |
| 2 | A version field in the health response | n/a — **does not exist** | `artifacts/api-server/src/routes/health.ts:36` returns `HealthCheckResponse.parse({ status: "ok" })`. The schema at `lib/api-zod/src/generated/api.ts:15` declares exactly one field, `status`, and `zod.object` strips unknown keys — so a build field added to the handler would be dropped before it reached the wire |
| 3 | A dedicated `/version`, `/__version`, `/build`, `/readyz` or `/status` route | n/a — **no such route exists** | The only health-family routes in the repository are the four in `artifacts/api-server/src/routes/health.ts` (`/healthz`, `/healthz/cleanup`, `/healthz/delayed-publish`, `/healthz/schedulers`); none carries a build identifier |
| 4 | A response header carrying a version | n/a — **none** | The only version headers in the server are per-row data versions (`X-Trip-Version` at `artifacts/api-server/src/domain/trips/commands/tripKernel.ts:564`; an `ETag` of a row version at `artifacts/api-server/src/routes/tripReservations.ts:484`). `artifacts/api-server/src/app.ts:28` applies `helmet()`, which removes even `X-Powered-By` |
| 5 | A commit sha in the build or environment | n/a — **never injected** | No `GIT_SHA`/`COMMIT_SHA`/`BUILD_ID`/`SOURCE_VERSION`/`SENTRY_RELEASE` is read anywhere. `artifacts/api-server/build.mjs` passes no esbuild `define`. `artifacts/api-server/src/sentry-preload.ts:21-36` sets `environment` and `serverName` but no `release`. `scripts/build-production.sh` writes no stamp |
| 6 | `package.json` version | n/a — **static** | `artifacts/api-server/package.json:3` is `"version": "0.0.0"`, and `git log -L` on that line returns one commit, `Initial commit`, across 5537 commits. It is also never read at runtime |
| 7 | A startup log line | **No** — requires Replit log access | No startup line prints a build identifier. The closest are `artifacts/api-server/src/index.ts:113` (`"Server listening"`, port only) and `artifacts/api-server/src/app.ts:218` (frontend catch-all registered, a boolean). Reading them needs the Replit Deployments log pane: **owner only** |
| 8 | The Expo OTA manifest — the **only** build-identifying surface that exists | **Yes, attempted** | `travel-buddy-standalone/server/serve.js:404-408` serves `static-build/<platform>/manifest.json`, which `travel-buddy-standalone/scripts/build.js:473-477` stamps with `createdAt` and `launchAsset.key = bundle-<epochMs>-<pid>`. Probed 2026-10-04T12:16:38Z: `HTTP 404`. **Would yield a build *time*, never a commit sha** |
| 9 | `GET /api/telegraph/diagnostics` | **No** — admin auth required, and we must not authenticate | `artifacts/api-server/src/routes/telegraphDiagnostics.ts:95-104` returns `processUptimeMs`. That dates the *process incarnation*, not the build |
| 10 | A committed capture of production | **Yes** — 11 of them | `artifacts/api-server/src/lib/capability/snapshots/*-production-schema.json`, newest `20260922-production-schema.json` (`projectRef: ajrurzioarfkagpuxfnb`, `capturedAt: 2026-09-22T16:07:23Z`). Its top-level keys are `$comment, capturedAt, checksums, enums, flags, functions, method, productionMigrationWatermark, projectName, projectRef, tables`. **No commit, no build, no deployed version** — it captures schema and 201 flag values. `productionMigrationWatermark: 20260922155706` is a migration timestamp, i.e. schema state, not code |
| 11 | A GitHub deployment record | **Yes, queried** | `repos/portava/portava.app/deployments`: of the 100 most recent, **100 are environment `ci-nonprod-supabase` with `production_environment: false`, and zero have `production_environment: true`**. The repo's only configured environment is `ci-nonprod-supabase`. GitHub is not the deploy channel for the app |
| 12 | The Replit publish lineage in git history | **Yes** — see §1.4 | 46 commits by `Replit Agent <agent@replit.com>` titled `Published your App`. This is the one substantive deploy log that exists in-tree, and its most recent entries are not in `main`'s ancestry |
| 13 | A scheduled workflow that calls the deployed app | **Yes, queried — but it never reaches the network** | See §1.5 |
| 14 | **Replit's publish status** (`get_publish_status`, via the Replit tool channel) | **Not from this session** — it was reached on 2026-09-26 and the result is committed | `docs/architecture/census-sensing.md:4972-4973`: "**The most recent publish of `https://portava.replit.app` is `failed`.** Read from Replit's publish status (`deploymentId 86067815-…`)". **This is the most important single artifact in the corpus for this question**, and today's 404 is consistent with it |
| 15 | **A differential wire-string probe** — the technique that actually worked | **Yes in principle, moot today** (nothing serves) | `docs/discovery/ROADMAP.md:785-789` sets out the method: "The useful discriminator was not a version endpoint — `/api/healthz` returns `{"status":"ok"}` and nothing else. It was **a wire string that only one of the two candidate trees can produce.** Pick a response value the other tree is structurally incapable of emitting". This is how `a384e29fa` was identified (§1.4) and is the only technique that has ever positively identified a running Portava build |
| 16 | `artifacts/api-server/scripts/verify-prod-webhook.mjs` — the only executable committed artifact that can distinguish a stale deployment from a current one | **Yes in principle, moot today** | `verify-prod-webhook.mjs:63`: `if (r.status === 404) throw new Error('Got 404 — deployment is still stale, republish first');`. A 401-not-404 route-existence discriminator against `PROD_URL` (`:17`) |
| 17 | `GET /api/feature-flags` | n/a — **must never be used for this** | `docs/ops/memory-projection-post-deploy-certification.md:68-69` warns: "Do not use the flag list as evidence. `/api/feature-flags` serves `memory_projection` already, because it reads flags from the **database**. It says nothing about the deployed code." Recorded here because it is the most tempting wrong answer |
| 18 | The Replit Deployments UI (build command, run command, env panel, deploy history, logs) | **No — owner only** | `.replit:11-13` warns: "deployment settings configured in the Replit UI override this file, so CONFIRM these commands in the Replit Deployments UI before relying on them." `docs/deployment-readiness.md:34-37` adds: "**Nothing in this repository can read or assert what the Replit UI actually holds.**" This is the single surface that would settle most of §5 |

### §1.3 The structural finding: even a live deployment could not be identified by commit

Rows 2–6 above are not an accident of this outage. **The API server carries no
build identifier of any kind.** There is no endpoint, header, log line,
environment variable, build-time constant or package version from which the git
sha of a running instance could be recovered. The only identifying surface in the
whole system is the Expo manifest's `createdAt` timestamp (row 8), which dates
the frontend build step of `scripts/build-production.sh` — and therefore the
deploy — but never names a commit.

This is itself a precondition item (§4), because it means the verification that
`TRIPS-PRODUCTION-ACTIVATION.md:108-115` asks Replit to perform — "**Identify the
running build.** Confirm the deployed commit" — **cannot be performed by anyone
from the deployment's own surface.** It can only be answered from the Replit
Deployments UI's deploy history.

### §1.4 The publish lineage — the strongest committed evidence, and it does not point at `main`

Replit's publish action commits with the autogenerated message `Published your
App`. The repository contains **46** such commits, authored by `Replit Agent
<agent@replit.com>` (one, `b92cba04f`, 2026-08-10, by the owner's Replit
account). They form the only deploy log that exists in-tree.

Mapped against `main`'s ancestry at `f71cfb85f`:

| Period | Publish commits | In `main`'s ancestry? |
|---|---|---|
| 2026-06-28 → 2026-08-18 | 40 | Mixed; the **last one that is** an ancestor of `main` is `b05630118`, **2026-08-18T08:32:48Z** |
| 2026-09-04 → 2026-09-16 | **6** (`c731a0f29`, `46f95893b`, `4a09ba5c2`, `cac3d2d8c`, `8bc3d77be`, `12ebea111`) | **No — none of them.** All six live only on `origin/replit/media-map-sensing` |

The branch holding the six most recent publishes, measured at `f71cfb85f`:

- tip `3c5a76fd2`, 2026-09-16T13:10:09Z, "Document blocked Map and sensing device certification protocol"
- **19 commits ahead** of `origin/main`
- **1463 commits behind** `origin/main`
- diverged from `main` at `d70fbc58c`, 2026-09-03

**What this evidences and what it does not.** It evidences that the Replit
workspace performed six publish actions between 2026-09-04 and 2026-09-16 from a
tree that is not in `main`'s ancestry and is 1463 commits behind it, and that no
publish action has been recorded in the repository since 2026-09-16. It does
**not** prove which hostname those publishes served, nor that any of them
succeeded — a `Published your App` commit records the tree at publish time, not
the deployment target and not the outcome. Indeed the one committed reading of
the *outcome* says the most recent publish **failed** (§1.4.2). Those residuals
are named in §5.

**A publish is weaker evidence than a running-build probe, and the two must be
kept apart.** The distinction is drawn by `docs/discovery/ROADMAP.md:776-777`:

> "Git proves which commit was *published*. It cannot prove which build the
> autoscale instances are *running*. Both were checked, and they agree."

### §1.4.1 The one commit ever positively identified as *running* — `a384e29fa`, 2026-08-15

Under the header `docs/discovery/ROADMAP.md:755` — "`### DEPLOY VERIFIED CLEAN,
2026-08-15 12:13Z`" — the running build was established by a differential probe,
not by any version surface. `docs/discovery/ROADMAP.md:782`:

> "| **Live, decisive** | `GET /api/places/photo` on production returns a
> **`places.googleapis.com/v1/places/{id}/photos/{ref}/media`** URL. That
> construction exists **only** in the clean tree […] The drift's `/places/photo`
> calls `places-api.foursquare.com` and **cannot emit that shape** under any
> input. |"

corroborated at `:783` by `/api/places/fsq-photo` returning the wire string
`foursquare_quota_exhausted`, and recorded with its Replit build-id at
`docs/discovery/ROADMAP.md:769`:

> "| 11:55:17 | **Publish `a384e29fa`** — build-id
> `58536e52-de91-4ce1-b1d9-1a91fc2e7813`, tree `2014ada7` […] |"

**The inherited record is therefore correct on this point, and this document's
earlier framing of it should be read narrowly:** `a384e29fa` (2026-08-15) is the
last commit positively identified as *running*. `b05630118` (2026-08-18) and the
six off-`main` publishes through 2026-09-16 are *publish* events, which is a
weaker class of evidence and does not displace it.

### §1.4.2 What happened after, in dated order — every row a committed quotation

| Date | Artifact | What it records | Class |
|---|---|---|---|
| 2026-08-15 ~12:13Z | `docs/discovery/ROADMAP.md:782-783` | `a384e29fa` confirmed **running** by wire-string differential | **running build, named** |
| 2026-08-15, later | `docs/places/google-legacy-places-api-returns-nothing.md:24-34` | the migrated Google autocomplete route is live and returning populated `places` — behaviour the `a384e29fa` tree could not produce, while `:59` still says "**Production still runs `a384e29fa`.**" | **running build, NEWER and unnamed** — an internal contradiction in the corpus |
| 2026-08-29 | `docs/ops/memory-projection-post-deploy-certification.md:65-66` | "**404 on a memory route means the build predates the memory system. STOP — do not enable.** This is exactly the state on 2026-08-29." | running build is old, unnamed |
| 2026-09-26 | `docs/architecture/census-sensing.md:4972-4978` | "**The most recent publish of `https://portava.replit.app` is `failed`.**" […] "**This is a new fact and it bears on every 'deployed' claim in this corpus, not only on S17.**" | **publish FAILED** |
| 2026-09-30T15:30:36Z | `.github/workflows/story-retention.yml:12-18` | every `job_health` row froze; "Zero requests reached the database in the two days that followed" | **running process STOPPED** |
| 2026-10-04T12:10:38Z | this document, §1.1 | `404 This app isn't live yet` on every path | **nothing is serving** |

These six rows are consistent and form a single chain: a build was running in
August, it aged, the most recent attempt to replace it failed on 2026-09-26, the
process stopped on 2026-09-30, and nothing serves today.

**This document also answers the open question that `census-sensing` §23.3 put to
the owner.** `docs/architecture/census-sensing.md:4989-4990`:

> "**Owner question, the single one this pass raises:** is
> `https://portava.replit.app` currently serving, and if so from which
> deployment?"

**Answer, measured 2026-10-04T12:10:38Z: it is not serving.** The second half —
from which deployment — remains unknown (§5.2).

### §1.4.3 Two corrections to the inherited record, measured at `f71cfb85f`

1. `0fa752ece` is **150 commits** behind `f71cfb85f` (10 by first-parent), not 42.
   It is also not described anywhere in the repository as a "staged deploy
   target": every reference to it — `docs/architecture/census-sensing.md:6228`,
   `census-layover.md:8441`, `census-media.md:16072`, `census-trust.md:3318`,
   `artifacts/api-server/src/test/guardReachability.test.ts:444` — uses it as a
   **census measurement baseline** ("cut from `main` at `0fa752ece`", "MEASURED
   on main at `0fa752ece`"). The "staged deploy target" framing is not supported
   by any committed artifact.
2. There are **two committed run commands and they disagree.** `.replit:15` says
   `run = ["pnpm", "--filter", "@workspace/api-server", "run", "start"]`;
   `artifacts/api-server/.replit-artifact/artifact.toml:30` says
   `args = ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]`.
   The `pnpm start` script (`artifacts/api-server/package.json:9`) includes
   `--import ./dist/sentry-preload.mjs`, which the `artifact.toml` form **omits**
   — so under one of the two commands the deployed process reports no errors to
   Sentry. Which one the hosted deploy uses is established nowhere in the
   repository (§5.4).

### §1.5 An independent liveness channel that turns out to say something different

`.github/workflows/story-retention.yml` POSTs hourly to the deployed app and, by
design, fails loudly when the host does not answer —
`.github/workflows/story-retention.yml:126`:

> "`::error::the app did not answer at all (timeout, DNS, or the deployment is not serving). The purge did not run.`"

Its run history is seven consecutive scheduled **failures**, 2026-10-03T05:28:29Z
through 2026-10-04T09:52:48Z. But the log of the most recent run (id 37193558462,
2026-10-04T10:01:05Z) shows it **never reached the network**:

> `##[error]repository variable PORTAVA_APP_BASE_URL is not set (e.g. https://portava.replit.app)`
> `##[error]repository secret CLEANUP_ADMIN_SECRET is not set; it must match the value in the Replit deployment`

Confirmed against the repository's variables, which are exactly
`API_TEST_MAX_SKIPPED`, `API_TEST_MIN_PASS`, `CI_SUPABASE_PROJECT_REF`,
`STANDALONE_MAX_SKIPPED` — **`PORTAVA_APP_BASE_URL` is absent.**

So this channel yields **no** evidence about the deployed host, and instead
yields a separate finding: **the story-retention purge has never run since the
workflow was added.** Its fail-closed configuration gate (lines 74-89) worked
exactly as designed.

This matters for §2 and §4 because of what the same file records about production
runtime — `.github/workflows/story-retention.yml:12-18`:

> "On production it stopped firing entirely. Every `public.job_health` row froze
> at 2026-09-30T15:30:36Z: the last health upsert before that returned HTTP 200,
> every other loop in the process stopped in the same two minutes, and Supabase
> Realtime terminated the tenant at 15:40:14 for having no connected clients.
> Zero requests reached the database in the two days that followed."

The same timestamp is carried at `artifacts/api-server/src/lib/storyRetentionScheduler.ts:42`
and `:174`, `artifacts/api-server/src/routes/health.ts:192`, and
`artifacts/api-server/src/test/healthSchedulers.test.ts:271`. **This is a dated,
committed, measured observation that a production process was alive and serving
until 2026-09-30T15:30:36Z and stopped at that moment.** It is consistent with
today's measurement that nothing is serving at the configured origin, and it is
the last moment at which production is evidenced to have been running anything
at all.

### §1.6 Verdict on §1

**No build is running at `https://portava.replit.app` as of
2026-10-04T12:16:38Z.** The chain of committed evidence and today's measurement
agree (§1.4.2): `a384e29fa` was confirmed running 2026-08-15; a newer unnamed
build was running later that same day; the build still predated the memory
system on 2026-08-29; the most recent publish **failed** on 2026-09-26; the
process stopped on 2026-09-30T15:30:36Z; nothing serves today.

**Which commit was running when it stopped is UNKNOWN.** It cannot be recovered
from the deployment's own surface at all, because no build identifier exists
anywhere in the server (§1.3), and the one technique that has ever worked — a
differential wire-string probe — needs a live host to probe. It is recoverable
only from the Replit Deployments UI deploy history, which only the owner can
read.

**The honest summary is that the runtime is largely unknown, and §5 says exactly
why and what would fix it.** What is *not* unknown, and is the operative fact, is
that there is nothing deployed to flip a flag for.

---

## §2 Reconciling `census-sensing.md:4040` against `TRIPS-PRODUCTION-ACTIVATION.md`

### The two claims

`docs/architecture/census-sensing.md:4040` ends a paragraph with three words:

> "two. Production runs main."

`docs/TRIPS-PRODUCTION-ACTIVATION.md:104-106`:

> "**The running API version is therefore unknown to me, and no Trips flag should
> be enabled until it is known.**"

### Which is supported

**The Trips document is supported. `census-sensing.md:4040` is an unevidenced
assertion, and the committed evidence points against it.**

The structure of the `census-sensing` paragraph makes the distinction visible
without needing any outside fact. Lines 4033-4040 read:

> "**The constraint in the other direction, which is the one that was missed.**
> 3002 installs a BEFORE INSERT trigger that replaces the submitted account id
> with a contributor token. The only code that has to know about that swap is
> `IntelCaptureService`'s idempotent-replay lookup, which reads a row back by
> contributor identity — and the version written for BOTH schemas is **on this
> branch and not on `origin/main`**, measured: `origin/main`'s copy of that file
> contains ZERO references to `intel_contributor_token`, this branch's contains
> two. Production runs main."

The word **"measured"** governs the clause before it — a comparison of two files
in the repository, which is a repo fact and is properly evidenced. "Production
runs main." is a separate three-word sentence appended after it, carrying no
citation, no measurement, no date, and no mechanism. It is the **bridging
premise** that converts a repo fact into a production claim, and it is the one
part of the paragraph that is asserted rather than measured.

The same census is explicit elsewhere that this class of claim is not available
to it. `docs/architecture/census-compass.md:3396-3397` states the opposite
conclusion as a consequence of the egress block:

> "Consequence: the running build cannot be identified, so no flag whose
> behaviour depends on deployed code can be enabled with evidence."

### Is there a committed artifact that settles it?

**Yes — three, and all three settle it against `census-sensing.md:4040`.**

**First, a committed artifact contradicts the premise directly and in general
terms.** `docs/ops/memory-projection-post-deploy-certification.md:49-50`:

> "The Replit workspace must be synced to that commit or later. **The deploy
> source is the Replit workspace, not GitHub** — a green GitHub main proves
> nothing about what is running."

That is the exact inference `census-sensing.md:4040` makes, named and rejected in
the repository's own operational guidance. The deploy source is a workspace whose
git state is an independent variable; `main` is not the deploy source.

**Second, the publish lineage shows the workspace was in fact not on `main`.**
The six most recent `Published your App` commits, 2026-09-04 through 2026-09-16,
are **not in `main`'s ancestry**; they are on `origin/replit/media-map-sensing`,
a branch 1463 commits behind `main` (§1.4). The last publish commit that *is* an
ancestor of `main` is `b05630118`, 2026-08-18. So for the whole of the period in
which `census-sensing` §14.8 was written, the published tree was not `main`.

**Third, the publish that would have mattered failed.**
`docs/architecture/census-sensing.md:4972` — in the *same census file*, 2186
lines after line 4040 — records: "**The most recent publish of
`https://portava.replit.app` is `failed`.**" The same census therefore contains
both the assertion and its refutation, and §23.3 says so itself at `:4976-4978`:
"**This is a new fact and it bears on every 'deployed' claim in this corpus, not
only on S17.**"

One honest limit, and one sharpening:

- A `Published your App` commit evidences a publish action on that tree, not the
  hostname it served. A publish from the workspace to a *different* target would
  produce the same commit.
- Today's measurement (§1.1) is that **nothing is serving** at the configured
  origin, which makes "Production runs main" not merely unevidenced but
  **currently vacuous**: there is no running production to run anything.

### The same unevidenced bridge appears in exactly one other place, with the identical shape

A repository-wide search for this assumption returns two hits and only two:

1. `docs/architecture/census-sensing.md:4040` — "two. Production runs main."
2. `docs/ops/telegraph-history-bound-deployment.md:45` — "`origin/main`**, which
   is what production deploys. Measured: each of those four files contains zero
   references to `groupChatHistoryBound` / `visibleFromOf` on `origin/main`, and
   three each on this branch."

**Both have the same structure, and it is worth naming as a pattern:** a
genuinely measured comparison of two trees in the repository, with a short
unmeasured clause about production welded onto it, in the same sentence, so that
the word "measured" appears to cover both. It does not. The measurement is a repo
fact; the production claim is an assumption. Any future reader of either line
should treat the clause after the comma as uncited.

### Verdict

`census-sensing.md:4040` should be treated as **an assertion that the evidence
contradicts**, not as a fact. `TRIPS-PRODUCTION-ACTIVATION.md`'s position —
"unknown, and no flag should be enabled until it is known" — is the one the
evidence supports, and today's measurement sharpens it from "unknown" to "nothing
is deployed, and the identity of the last deployed build is unknown."

The two statements were never reconciled in the repository, and the gap is
load-bearing: `census-sensing.md:4040` is the premise of §14.8's conclusion that
"3002 and this branch's application code are a single cutover". That conclusion
may still hold for other reasons, but **it currently rests on a premise the
evidence does not support**, and the coupling argument should be re-derived
before 3002 is applied.

---

## §3 Production/test separation

**Verdict: the hosted test app is not separate from production on any axis.**
There is no committed artifact of any kind describing a separate test or staging
Supabase project, a second Replit deployment, or an environment-scoped flag.

The repository's own project roster has exactly two roles and no test row —
`docs/architecture/10_Database_Architecture.md:20-21`:

> `| **Production** | ajrurzioarfkagpuxfnb | travel-buddy | the app; .replit:151; pinned as the denylist value at .github/workflows/live-db.yml:183 |`
> `| **CI** | hwokxgbmezheskbzskfr | portava-ci | every CI job that touches a database (scripts/src/apply-migrations.ts:8) |`

Production is "Reached by: **the app**". CI's project is reached by CI jobs — a
rehearsal target, not an application target.

### §3.1 Database — SHARED

`.replit:143-159` is the whole of the workspace's environment configuration:

```
143  [userenv]
144
145  [userenv.shared]
...
148  EXPO_PUBLIC_SUPABASE_URL = "https://ajrurzioarfkagpuxfnb.supabase.co"
...
151  SUPABASE_URL = "https://ajrurzioarfkagpuxfnb.supabase.co"
152  QA_ACCOUNT_EMAIL = "arxaitrading@gmail.com"
153
154  [userenv.development]
155
156  [userenv.production]
...
159  ALLOWED_ORIGINS = "https://portava.replit.app"
```

Both the server's `SUPABASE_URL` and the client's `EXPO_PUBLIC_SUPABASE_URL` are
set in **`[userenv.shared]`** — the block that applies to every environment — to
the **production** ref. `[userenv.development]` is **empty** (line 154).
`[userenv.production]` overrides only `ALLOWED_ORIGINS`. **Nothing in this file
distinguishes a test environment's database from production's, because there is
one value and it is in the shared block.**

These are the only concrete `SUPABASE_URL` literals committed anywhere. Every
other occurrence is empty in an `.env.example`, or `${{ secrets.SUPABASE_URL }}`
in a workflow — the CI ref is never a committed literal at all, existing only as
a GitHub secret and as the repository variable `CI_SUPABASE_PROJECT_REF =
hwokxgbmezheskbzskfr` (read 2026-10-04).

Two independent guard modules state the Replit runtime points at production.
`docs/ci/README.md:403-407`:

> "in the Replit workspace, whose `SUPABASE_URL` is the production project
> (`.replit:148`), `check:all` failed on every run for a reason that had nothing
> to do with the code under test."

And `docs/ci/README.md:388-390` records that the guard was deliberately kept out
of the application's client factory because the running server is *supposed* to
reach production:

> "putting the guard there would refuse to let the production API server boot — a
> process that is *supposed* to talk to production."

The config loader has no environment branching at all:
`artifacts/api-server/src/lib/supabase.ts` reads one `SUPABASE_URL` and one
service key with no `APP_ENV`/`NODE_ENV` switch.

### §3.2 Feature flag table — SHARED, and scoping is structurally unrepresentable

This is the single most consequential fact in this document.

`artifacts/api-server/src/migrations/0037_feature_flags.sql:4-9`:

```sql
CREATE TABLE IF NOT EXISTS feature_flags (
  flag        text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT false,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

**`flag` is the sole PRIMARY KEY.** There is exactly one row per flag name in the
database. An `environment` column could not be added without changing the primary
key, so environment scoping is not merely absent — it is **structurally
unrepresentable in the current schema.**

The only column ever added is `metadata`
(`artifacts/api-server/src/migrations/0065_phase7_safety.sql:36`); the other two
`ALTER TABLE feature_flags` statements enable RLS only. All eleven committed
production captures agree on the live shape: in every
`artifacts/api-server/src/lib/capability/snapshots/*-production-schema.json` from
`20260907` to `20260922`, `tables.feature_flags` is exactly
`["flag", "enabled", "description", "updated_at", "metadata"]` — **no
`environment`, `env`, `scope` or `tenant`.** The newest carries 201 flag
name→boolean pairs: one value per flag, not one per flag per environment.

The reader has no environment predicate —
`artifacts/api-server/src/lib/featureFlags.ts:16-20`:

```ts
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flag)
      .maybeSingle();
```

`.eq("flag", flag)` and nothing else; `maybeSingle()` would in fact error if more
than one row matched, so the code is written on the assumption of exactly one
global row per flag.

The audited writer takes no environment argument either —
`artifacts/api-server/src/routes/admin.ts:797-801` calls
`toggle_feature_flag_with_audit` with `p_flag`, `p_new_enabled`,
`p_changed_by_id`, and that function's update is
`artifacts/api-server/src/migrations/0119_toggle_flag_atomic.sql:38-40`:

```sql
  UPDATE feature_flags
  SET enabled = p_new_enabled, updated_at = v_now
  WHERE feature_flags.flag = p_flag;
```

**Therefore: flipping a flag "for testing" flips it for production — necessarily
and immediately.** There is no second row to flip, no predicate that could
distinguish readers, and no column that could carry the distinction. This holds
regardless of what the Replit UI contains; §3.1 is what establishes that the two
apps are in fact the same database.

### §3.3 Storage — SHARED

Storage is the same project's storage **by construction**, because its origin is
derived from the same single `SUPABASE_URL` —
`artifacts/api-server/src/lib/mediaAccess.ts:68-72`:

```ts
export function publicUrlFor(bucket: string, path: string): string | null {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  return `${new URL(base).origin}/storage/v1/object/public/${bucket}/${path}`;
}
```

Buckets are a hardcoded pair — `artifacts/api-server/src/lib/mediaUrl.ts:11`:
`const ALLOWED_BUCKETS = new Set(["post-media", "profile-media"]);` — with no
environment-suffixed bucket name anywhere in committed config. It cannot be
separated without separating the database.

### §3.4 Auth — SHARED

Bearer tokens are verified against the Auth of the **same** project, using the
same client factory as the database —
`artifacts/api-server/src/lib/http.ts:293-294`:

```ts
  const client = (_testClient ?? getServiceClient()!) as SupabaseClient;
  const { data, error } = await client.auth.getUser(token);
```

`getServiceClient()` is the single-`SUPABASE_URL` factory of §3.1, so **auth
project == database project, by construction.** The mobile client uses the other
half of the same `[userenv.shared]` pair: `.replit:147-148` supplies one anon key
and one URL for development and production alike. One user pool.

### §3.5 What the testing-mode documentation actually says

`docs/ops/testing-mode-flows.md:3-4`:

> "Portava is in testing mode: the hosted testing app (the Replit deployment on the
> Supabase project `travel-buddy`, not publicly launched) must carry every intended
> feature end to end."

One deployment, one project, named `travel-buddy` — which
`docs/architecture/10_Database_Architecture.md:20` identifies as the display name
of `ajrurzioarfkagpuxfnb`, **production**.

**A caveat the repo raises against itself, and it must be carried forward.** That
document identifies the project by *display name*, and the repo's own guard says
a name is not a sufficient identifier —
`.github/scripts/assert-nonprod-supabase.sh:39-49`:

> "Enumerating GET https://api.supabase.com/v1/projects with the CI credential
> on 2026-08-11 returned THREE projects, all reachable by that one token:
> `zheztcvfhkwbouspesew travel-buddy` / `hwokxgbmezheskbzskfr portava-ci` /
> `ajrurzioarfkagpuxfnb travel-buddy` […] Two of the three carry the SAME display
> name. So […] A NAME-BASED ALLOWLIST COULD NOT HAVE WORKED AT ALL. […] Only a
> ref discriminates."

So `testing-mode-flows.md:4` is on its own ambiguous between
`ajrurzioarfkagpuxfnb` and `zheztcvfhkwbouspesew`. It is disambiguated by the
ref-level pin at `.replit:151` and by `supabase/README.md:71`, which records
`zheztcvfhkwbouspesew` as **paused**. Neither candidate is the CI project.

**No committed doc asserts in words that the test app shares production's flag
table.** The claim is an inference from configuration and schema — §3.1 plus
§3.2 — not a quoted statement, and that is how it should be cited. What the
testing-mode document does do is use the vocabulary of a distinct environment
("the testing DB" at `:220`, "the testing app" at `:565`, "the testing target" at
`:24`) while the only database those phrases can resolve to is production. **A
reader of that document alone would reasonably but incorrectly infer environment
separation.** That inference is the likely origin of any belief that a flag can
be flipped for test only.

One corroboration, offered as corroboration and not proof:
`docs/architecture/census-highlights-memories.md:6503-6505` records a read of
"the hosted testing database" on 2026-10-03 and labels it, in its own words,
"**this is production evidence, not controlled evidence**"; the ten flag values
it reports match the committed `ajrurzioarfkagpuxfnb` snapshot
`20260922-production-schema.json` 10 for 10.

### §3.6 A gap worth recording

`flows.json` — cited at `docs/ops/testing-mode-flows.md:10` and `:551` as the
authority for every "testing target" flag state in that document — **is not
committed.** `git ls-files` matches zero files. Any claim of the form "flag X
should be TRUE in test" is currently uncheckable from the repository.

---

## §4 Preconditions — what must be true before anyone may flip a flag, apply a hosted migration, or activate a feature

Derived from the evidence above, not from preference. Each item names the finding
it comes from.

### Blocking for *any* flag flip

1. **A deployment must exist and serve.** Today it does not: `404 This app isn't
   live yet` on every path (§1.1). A flag flip against a host that serves nothing
   changes production state with no deployed code to consume it. **Who:** the
   owner, in the Replit Deployments UI.
2. **The reason the deployment is not live must be established.** From outside,
   "deployment deleted", "never published / unpublished", "suspended for
   billing", and "domain unlinked" all produce the identical Replit placeholder.
   Only the Replit Deployments UI distinguishes them (§5.1).
3. **The deployed commit must be identified from the Replit deploy history** — not
   from the application, which carries no build identifier of any kind (§1.3). The
   instruction at `TRIPS-PRODUCTION-ACTIVATION.md:108-115` to "Confirm the
   deployed commit" is **not dischargeable from the deployment's surface** and
   must be re-pointed at the deploy history.
4. **It must be accepted that the flip lands in production.** The flag table has
   no environment scoping and cannot carry any (§3.2). There is no test-only flag
   state. Every flip is a production flip, including every flip made "for
   testing".
5. **The deployed build must be confirmed to implement the behaviour behind the
   flag.** `TRIPS-PRODUCTION-ACTIVATION.md:171-173` states the principle: "A flag
   whose code is not deployed is inert, not dangerous." That is true of inertness
   but is not a licence — it is only knowable *after* item 3.
6. **A successful publish must be on record.** The last publish outcome actually
   read is `failed`, 2026-09-26
   (`docs/architecture/census-sensing.md:4972-4973`), and
   `docs/ops/sensing-production-approval-request.md:127` already carries this as
   a gate: "Republish `https://portava.replit.app` successfully (the last publish
   reads `failed`) | the publish status reads success".
7. **The verification must not be done with `GET /api/feature-flags`.**
   `docs/ops/memory-projection-post-deploy-certification.md:68-69`: "Do not use
   the flag list as evidence. `/api/feature-flags` serves `memory_projection`
   already, because it reads flags from the **database**. It says nothing about
   the deployed code." Use a route-existence probe
   (`memory-projection-post-deploy-certification.md:62-63`, 401-not-404) or a
   wire-string differential (`docs/discovery/ROADMAP.md:785-789`).
8. **Which of the two conflicting run commands the deploy uses must be
   established** (§1.4.3 item 2). Under
   `artifacts/api-server/.replit-artifact/artifact.toml:30` the Sentry preload is
   omitted, so a deploy started that way reports no errors — which would make a
   post-flip failure silent. This should be settled *before* a flip, not after.

### Additional, for a hosted migration

9. **`census-sensing.md:4040` must not be relied on.** Its "Production runs main."
   is an assertion the evidence contradicts (§2), and it is the premise of
   §14.8's conclusion that 3002 and its application code are a single
   inseparable cutover. **Re-derive that coupling against the build the deploy
   history actually names** before applying 3002.
10. **The apply target must be pinned by project *ref*, never by display name.**
   Two distinct projects share the display name `travel-buddy`
   (`.github/scripts/assert-nonprod-supabase.sh:39-44`), and one of them is
   production.
11. **The schema watermark must be re-read.** The newest committed production
   capture is `capturedAt: 2026-09-22T16:07:23Z` with
   `productionMigrationWatermark: 20260922155706` (§1.2 row 10). It is 12 days
   old at the time of writing and records no build.

### Additional, for feature activation generally

12. **A build identifier should be added before the next deploy.** The absence
    documented in §1.3 is why this whole question is unanswerable; it is a
    one-line fix at the health route plus a response-schema field
    (`lib/api-zod/src/generated/api.ts:15` currently strips unknown keys, so the
    schema must change too). Until then, every future "which build is running"
    question will need the owner and the Replit UI.
13. **`PORTAVA_APP_BASE_URL` and `CLEANUP_ADMIN_SECRET` must be set, or the
    story-retention purge continues not to run.** Seven consecutive scheduled
    runs failed at the configuration gate without making a request (§1.5). Note
    the ordering dependency: setting them while nothing is deployed converts a
    config failure into a `404` failure, not into a working purge.
14. **`flows.json` must be committed** before any claim about intended test flag
    states can be checked (§3.6).

### Not a precondition, and should stop being treated as one

15. **"Egress to the deployment is blocked" is no longer true.** Three documents
    name it as the standing blocker
    (`TRIPS-PRODUCTION-ACTIVATION.md:102-106`, `census-compass.md:3393-3397`,
    `census-layover.md:7206-7212`), and
    `docs/ops/deployment-backlog-20261004.md:1110` on branch
    `claude/deployment-backlog-map-20261004` repeats it as of 2026-10-04. The
    request succeeds now (§1.1). The blocker is not access — it is that there is
    nothing to access.

---

## §5 The unknowns register — every item marked unknown, and what would settle it

| # | Unknown | What would settle it | Who can do it |
|---|---|---|---|
| 5.1 | **Why** `portava.replit.app` serves nothing — deleted, unpublished, suspended, or domain unlinked. All four produce the identical placeholder from outside | The Replit Deployments UI: deployment status and history | Owner |
| 5.2 | **Which commit was last deployed to production.** Not recoverable from the application at all (§1.3) | The Replit Deployments UI deploy history, which records the commit per deploy | Owner |
| 5.3 | Whether the six publish commits of 2026-09-04→2026-09-16 (§1.4) targeted the production deployment or another target | The Replit Deployments UI deploy history, cross-referenced against those six shas | Owner |
| 5.4 | What the Replit Deployments UI actually holds for build and run commands — and in particular **which of the two conflicting committed run commands applies** (`.replit:15` vs `artifacts/api-server/.replit-artifact/artifact.toml:30`, which omits the Sentry preload). `.replit:11-13` says the UI overrides the file; `docs/deployment-readiness.md:34-37` says nothing in the repo can read it | The Replit Deployments UI settings pane | Owner |
| 5.5 | What `SUPABASE_URL` the live deployment's environment panel holds. Every committed artifact says production (§3.1), but the runtime value is an unread surface | The Replit Deployments environment-variable panel; or, on a live host, any media payload, since `mediaAccess.ts:68-72` builds storage URLs from the live `SUPABASE_URL` origin | Owner |
| 5.6 | Whether `SUPABASE_SERVICE_ROLE_KEY` and `SESSION_SECRET` are set in Replit Secrets. `docs/deployment-readiness.md:143-149` records that both exist only there and that "the only way to find out is a boot that either serves or exits 1" | A boot, observed in the Replit Deployments log pane | Owner |
| 5.7 | The current live flag state. The newest committed capture is 2026-09-22 (§1.2 row 10); it is not re-read here because reading `ajrurzioarfkagpuxfnb` was out of scope | A read-only `SELECT flag, enabled FROM feature_flags` on the production ref | Owner, or a session authorised to read production |
| 5.8 | Whether anything was deployed between 2026-09-16 (last recorded publish) and 2026-09-30T15:30:36Z (last evidenced production liveness, §1.5) | The Replit Deployments UI deploy history | Owner |
| 5.9 | What intended test flag states are, since `flows.json` is uncommitted (§3.6) | Committing `flows.json` | Any contributor |
| 5.10 | **Which build was running later on 2026-08-15**, after `a384e29fa`. `docs/places/google-legacy-places-api-returns-nothing.md:24-34` records the migrated Google autocomplete route live and populated, which the `a384e29fa` tree could not produce, while `:59` of the same file still says "**Production still runs `a384e29fa`.**" No committed artifact names that newer build. This is an unresolved contradiction *inside* the corpus, not merely a gap | The Replit Deployments UI deploy history for 2026-08-15 | Owner |
| 5.11 | Why the 2026-09-26 publish failed (`census-sensing.md:4972-4973`, `deploymentId 86067815-…`) — a build failure, a missing secret, a quota, or a platform fault. Each implies a different fix | The Replit Deployments UI build log for that deployment id | Owner |
| 5.12 | Whether the egress policy change that makes `portava.replit.app` reachable from this session (§1.1) is permanent or incidental. It matters because three documents and one open branch still name the old refusal as the standing blocker | Re-probing on a later date; or the egress policy itself | Any session |

---

## §6 Method, and what this document did not do

**Measured here:** four unauthenticated `GET`s to `portava.replit.app` and four
to `portava.app`, no credentials sent, no retry past any refusal; the git publish
lineage and branch divergence at `f71cfb85f`; the GitHub deployments API, repo
variables and environment list; the committed capture files; and the committed
configuration and source cited above.

**Deliberately not done:** no database was read or written — the production
project `ajrurzioarfkagpuxfnb` was not contacted at all, and the CI project was
not contacted either. No flag was flipped. No migration was applied or staged.
Nothing was deployed. No authentication was attempted against any host. No
assertion, ratchet or baseline was changed. Phase 6 was out of scope and is not
discussed.

**Citation note.** `docs/ops/` is not in the `COVERED` registry of
`artifacts/api-server/scripts/check-doc-citations.mjs:118-180`, so this file's
citations are not machine-enforced. Adding the directory would sweep in roughly
twenty unvetted files, which that script's own header warns against. Every
`file:line` above was instead verified by reading the cited line at `f71cfb85f`.
