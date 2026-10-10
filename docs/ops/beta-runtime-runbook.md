# Private beta — the owner's runbook (portava-beta)

*Written 2026-10-06 with the code that implements it (branch
`claude/beta-runtime-20261006`). It names keys, never values; the only values
written here are public URLs and project refs.*

The private, invite-only beta runs on its own Supabase project and its own
Replit deployment. Production is never reached by anything below.

| Thing | Value |
| --- | --- |
| Beta Supabase project | `portava-beta`, ref `emfpckykpzfturllshly`, `https://emfpckykpzfturllshly.supabase.co` |
| Production (never touched) | ref `ajrurzioarfkagpuxfnb` |
| Beta API / web origin | `https://portava-beta.replit.app` — the **expected** name of the Replit fork, not a measured URL. If Replit assigns a different one, see "If the beta URL is not portava-beta.replit.app" below. |
| App URL scheme | `travelbuddy://` |

## What the code guarantees

- **A beta deployment cannot reach production.** `PORTAVA_DEPLOYMENT_ENV=beta`
  makes the API refuse to start (exit 1, naming the variable) unless
  `SUPABASE_URL` is the beta project's URL and no environment variable names
  production: its Supabase ref, or its API origin `portava.replit.app`
  (`EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_WEB_ORIGIN`, `ALLOWED_ORIGINS`, …),
  checked case-insensitively in every variable
  (`artifacts/api-server/src/lib/deploymentEnvironment.ts`).
  `scripts/build-production.sh` refuses to build the same way, and also needs
  the beta `EXPO_PUBLIC_SUPABASE_URL`, because the web bundle inlines it
  (`scripts/deployment-env-guard.sh`). An unrecognised value (`Beta`,
  `beta `, `staging`) is refused, not ignored. The beta project's URL without
  the beta label is refused too. With the variable unset — production today —
  nothing changes.
- **The fork cannot run unlabelled, and beta holds no production or live
  credential** (added 2026-10-07):
  - a process whose `REPLIT_DOMAINS` (set by Replit) names
    `portava-beta.replit.app` is refused unless it is labelled beta, so a fork
    that kept `.replit`'s production values and was never labelled cannot
    serve production's data at the beta address;
  - **and it fails closed where that cannot be seen:** an UNLABELLED process in
    a Replit deployment (`REPLIT_DEPLOYMENT` present) with no `REPLIT_DOMAINS`
    is refused when the API SERVER STARTS. Replit's docs (Secrets page, read
    2026-10-07) list `REPLIT_DOMAINS` as a variable Replit sets but do not say
    a published deployment carries it, and that has not been observed here. An
    explicit label lifts the refusal. **Runtime only (lead ruling BETA-8):** the
    build step never applies this rule — which variables Replit sets while a
    deployment BUILDS is not verified, and a build refusal could stop
    production's build — so `scripts/deployment-env-guard.sh` does not carry
    it; a fork that slips through the build is still refused at start, before
    it serves anything. **Production pre-requisite (OWNER ACTION B15, lead
    rulings BETA-7/BETA-8): before the next production deploy that contains
    this rule, add the Secret `PORTAVA_DEPLOYMENT_ENV=production` to
    production** (harmless if `REPLIT_DOMAINS` turns out to be present at
    runtime; without either, that deploy builds but the server refuses to
    start). BETA-7 keeps the unlabelled-fork rule keyed to the exact host
    `portava-beta.replit.app` for now: a fork deployed under any other name
    (`portava-beta-2.replit.app`, a custom domain) is not caught by it. Once
    production carries its label, a follow-up can refuse EVERY unlabelled
    Replit deployment, which closes that gap without an outage risk;
  - production's publishable key (the one `.replit` commits) is refused in a
    beta environment like its ref and host;
  - a LIVE-mode provider credential anywhere (Stripe `sk_live_`/`rk_live_`/
    `pk_live_`, Persona `persona_production_`, a Sumsub `prd:` token) or
    `PAYMENTS_ALLOW_LIVE` set to anything but empty/`false` is refused;
  - a beta API refuses to start unless `NODE_ENV=production`: development and
    test modes admit the unsigned mock identity provider and the fake payment
    provider;
  - **beta never reports to production's Sentry project** (lead, 2026-10-07):
    `SENTRY_DSN` and `EXPO_PUBLIC_SENTRY_DSN` must be unset or a DSN on the
    beta allowlist (`BETA_SENTRY_DSNS`, empty until a beta Sentry project
    exists), or the API refuses to start and the web build refuses to build.
    The app does the same at runtime: a beta build initialises Sentry only with
    an allowlisted DSN, and both beta EAS profiles pin
    `EXPO_PUBLIC_SENTRY_DSN` to empty. Production's DSN is a Secret and is not
    in this repository, which is why the rule is an allowlist.

  `scripts/src/beta-deployment-guard.test.ts` parses the real `.replit` and
  proves every production value in it is refused by both rules. The five beta
  script suites run in `ci.yml`'s `beta-scripts` job (since 2026-10-07), which
  the CI verdict requires, so a change that breaks the beta path cannot merge
  green.
- **How sign-up is closed.**
  - **The app's own path.** The app signs up through Supabase Auth (`supabase.auth.signUp`). There, Auth's
    `disable_signup` refuses every new account. The configuration step sets it (step 3), so it is the setting that
    closes the beta. Apple and Google sign-in for a new user are refused the same way.
  - **The advisory message.** The sign-up screen reads `GET /api/auth/signup-status` and says the beta is
    invite-only before anyone types. This read is advisory and fails open. It now also runs on phones: it used
    `AbortSignal.timeout`, which React Native lacks, so it had silently never run there.
  - **Direct API callers only.** `POST /api/auth/signup` answers `403 invite_required` (or `feature_disabled`) and
    creates nobody while `invite_only_beta` (or `disable_signups`) is on. The app does not use this route. It
    creates accounts with the service role, which bypasses Auth's `disable_signup`, so the flags are its only
    guard.
- **A build whose database and API disagree does not start.** The app compares
  the Supabase ref with the API host (beta↔beta, production↔production), and
  (since 2026-10-07) the inlined publishable key with both: a known key of the
  other deployment is refused; an unknown (rotated) key is not judged. A beta
  build (`EXPO_PUBLIC_DEPLOYMENT_ENV=beta`) must point every address at beta.
  On a mismatch the app shows "This build is misconfigured" instead of starting
  (`travel-buddy-standalone/src/lib/deploymentConsistency.ts`).
- **Flags follow one reviewed policy**, `scripts/src/beta-flag-policy.json`,
  applied and read back by `.github/workflows/beta-config.yml`.

## The owner's commands

| When | Command | Needs |
| --- | --- | --- |
| Any time | `pnpm -C scripts beta:status` | `gh auth login` (reads secret NAMES and run conclusions only). Read-only: prints every gate below as PASS / OPEN / UNKNOWN / MANUAL and the next command. |
| Step 1 | `gh secret set BETA_SUPABASE_PROJECT_TOKEN --env ci-nonprod-supabase --repo portava/portava.app` | the token, pasted at the prompt (never on the command line) |
| Steps 2 + 3 | `pnpm -C scripts beta:provision --confirm=PROVISION-BETA` | GitHub workflow-dispatch rights. Refuses while the step-1 secret is absent. Reads `beta-db.yml`'s runs back to the newest successful bootstrap (in steps of 30, 100, 300, 1000; an unreadable history dispatches nothing). If a bootstrap or RESET newer than that success failed, was cancelled or is still running, the schema is not counted as built (gate 2 OPEN, naming the run) and nothing is dispatched — until an applying `confirm=APPLY-PENDING-BETA apply=yes` run NEWER than it succeeds with its certify and audit steps both passing, which settles it (lead ruling BETA-9: the non-destructive way back once testers exist, when a reset is refused); a rebuild (`-f confirm=BOOTSTRAP-BETA -f reset=RESET-BETA`, destructive) is your decision, never this command's. If beta was never built and a bootstrap failed, it dispatches nothing either (a plain bootstrap could refuse a part-written schema) and names the rebuild WITH reset. Never built: dispatches `beta-db.yml` `confirm=BOOTSTRAP-BETA`. Already built: dispatches `confirm=APPLY-PENDING-BETA apply=yes`, which applies only the chain files beta lacks (never a reset; a no-op when nothing is pending; it refuses a beta with no migration ledger). Waits, stops on a red verdict; dispatches `beta-config.yml`, waits (it fails while the `profiles` boundary of 3740 and 3742 does not hold); reads back that Supabase Auth refuses new users. |
| Step 7 | `pnpm -C scripts beta:smoke --base https://portava-beta.replit.app` | nothing (public GETs) |

**Measured 2026-10-07 (read-only):** the step-1 secret is absent (the
environment lists 4 secret names); `beta-db.yml`'s only run (37462712102)
failed with the 403 that secret fixes; `beta-config.yml` has never run;
portava-beta's Supabase Auth reports `disable_signup: false` (sign-up OPEN,
email provider on, Apple and Google off); `portava-beta.replit.app` answers
404 "This app isn't live yet"; the `beta` profile's publishable key is
accepted by portava-beta (200; no key or a wrong key gets 401); PostgREST
answers `404 PGRST205` for `profiles` (the schema is empty). Because that one
bootstrap FAILED and none succeeded, `beta:provision` now refuses with exit 2
and names the rebuild with reset (verifier BETA2c F5): once the step-1 secret
exists, dispatch it yourself once —
`gh workflow run beta-db.yml --repo portava/portava.app --ref main -f confirm=BOOTSTRAP-BETA -f reset=RESET-BETA`
(nothing to lose on an empty project; refused anyway if anyone has signed in) —
then run `beta:provision`.

**Optional, now, with no token:** in the portava-beta dashboard, Authentication
→ Sign In / Providers → turn off "Allow new users to sign up". Step 3 sets the
same `disable_signup` and reads it back; doing it now closes the window until
then.

## The steps, in order

Each step says which owner credential it needs. Nothing here can be done by
an agent: every step needs a credential only the owner holds.

### 1. Add `BETA_SUPABASE_PROJECT_TOKEN` — *Supabase account + GitHub repo admin*

Create a Supabase Management API access token that can reach `portava-beta`
(Supabase dashboard → Account → Access Tokens). In GitHub → Settings →
Environments → `ci-nonprod-supabase`, add it as the secret
`BETA_SUPABASE_PROJECT_TOKEN`. The CI token (`SUPABASE_PROJECT_TOKEN`) answers
403 on beta and must not be widened.

### 2. Dispatch `beta-db.yml` — *GitHub (workflow dispatch)*

```bash
gh workflow run beta-db.yml -f confirm=BOOTSTRAP-BETA
gh run watch
```

Builds the schema, imports the reference rows and applies the chain
(`docs/supabase-beta-runbook.md`). Every flag arrives OFF. Do not go on until
its verdict job is green.

### 3. Dispatch `beta-config.yml` — *GitHub (workflow dispatch); uses the step-1 token*

```bash
gh workflow run beta-config.yml -f confirm=CONFIGURE-BETA -f dry_run=yes   # optional: print the plan
gh workflow run beta-config.yml -f confirm=CONFIGURE-BETA
gh run watch
```

It sets Supabase Auth `disable_signup=true`, `site_url=https://portava-beta.replit.app`
and `uri_allow_list=travelbuddy://**,https://portava-beta.replit.app/**`, sets every
feature flag to the policy in one audited transaction, then reads both back.

It reads and plans the flags **before** writing anything. If a policy flag is
missing from the database, it exits 1 with nothing written: neither Auth nor
any flag. It also exits 1 if anything reads back differently. Re-dispatch it
whenever the policy changes.

Last, it reads (never writes) the client grants on `public.profiles` and
exits 1 while `anon` or `authenticated` hold a TABLE-level SELECT or UPDATE
there, SELECT on a personal column (`date_of_birth`, `full_name`,
`expo_push_token`, `phone_e164`, …), or UPDATE on any of the nineteen
**authority columns** migration **3742** (PR #653) makes server-write-only
(`verified`, `verified_at`, `trust_score`, `trust_label`,
`verification_method`, `featured_count`, `created_at`, `account_status`,
`role`, `is_official` and the nine verification columns 2163 guards), or while
3742's trigger `trg_profiles_authority_privileged` is missing, disabled,
conditional (a `WHEN` clause — `WHEN (false)` never fires), limited to a column
list (`UPDATE OF username` never fires for an UPDATE of `verified`; this one is
stricter than 3742's own postcondition until #653 adds it) or not the BEFORE
INSERT OR UPDATE row trigger running `enforce_profile_authority_privileged()`,
while that function no longer compares a guarded column or no longer refuses
(`42501`, through the predicate) before its first `RETURN`, or while the
predicate every profiles guard trusts, `caller_may_write_profile_role()`
(2078), is missing or no longer reads the role setting and `session_user`.
These are the textual checks of 3742's own postcondition, with its regexes;
its executed probe (calling the predicate as `anon` and `authenticated`) is not
repeated, because this step stays one read-only query. A tester who can write
those columns can give themselves the verified badge, a trust tier, an older
account date or a role. The SQL was executed on PostgreSQL (PGlite 18.3) by
the verifier and by this lane: seven grant shapes for 3740, and 30 scenarios
around PR #653's HEAD 3742 file (`9b7d0af29b`; unchanged at `f04b2ba81`)
with 2078's real predicate — before it, after it, re-granted columns, a PUBLIC
or role-membership grant, the trigger disabled, conditional, column-listed,
re-shaped, re-pointed or dropped, the function emptied, cut short or no longer
refusing, the predicate replaced or dropped — each also checked against 3742's
own postcondition, which fails in exactly the same cases except two: a
predicate that still reads both and admits a client anyway, which only 3742's
executed probe sees; and the column-listed trigger, which this step refuses
and 3742's postcondition does not yet (#653 is adding it). A baseline replay onto a Supabase project
inherits exactly that grant (Supabase's default ACL; `scripts/src/beta-db-core.ts`
sets it before a rebuild), and it lets the public anon key read those columns
of every non-private profile. Migration **3740** (PR #647) removes it. Sign-up
is already closed and the flags set when this check fails; the red run means:
**create no tester account** (step 8).

### 4. Fork the Repl as `portava-beta` — *Replit account*

Fork the production Repl and name the fork `portava-beta`, so its deployment
URL is expected to be `https://portava-beta.replit.app`. The fork inherits
`.replit`, whose `[userenv.shared]` holds **production** values. Step 5
replaces them.

### 5. Replace every production value — *Replit account; beta project's API keys*

Set these as **Secrets** in the fork, starting with the first one. The API
refuses to start, naming the variable, if any value names production, carries
production's publishable key, holds a live-mode provider key, sets
`PAYMENTS_ALLOW_LIVE`, or if `NODE_ENV` is not `production`.
`PORTAVA_DEPLOYMENT_ENV` must be a Secret, not a `.replit` entry. A later pull
of the tracked `.replit` would erase a `.replit` entry and switch the guard
off. As a Secret it survives the pull, and the API then refuses the production
values the pull restores.

| Key | Value |
| --- | --- |
| `PORTAVA_DEPLOYMENT_ENV` | `beta` (exactly) |
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | `https://emfpckykpzfturllshly.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_URL` | `https://emfpckykpzfturllshly.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | beta project → Settings → API → secret / service-role key |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | beta project → Settings → API → publishable / anon key |
| `EXPO_PUBLIC_API_BASE_URL` | `https://portava-beta.replit.app` — the web bundle sends every `/api/*` call here; production's value is a Replit Secret, not in `.replit`, so check the fork's Secrets |
| `EXPO_PUBLIC_WEB_ORIGIN` | `https://portava-beta.replit.app` (same reason) |
| `SUPABASE_ANON_KEY` | the same beta publishable key, if set at all |
| `SESSION_SECRET` | **freshly generated** for beta (e.g. `openssl rand -hex 32`). Never production's. |
| `INTERNAL_API_SECRET` | **freshly generated** for beta. Never production's. |
| `ALLOWED_ORIGINS` | `https://portava-beta.replit.app` |
| `SENSING_CONTRIBUTOR_PEPPER`, `INTEL_EVIDENCE_REFERENCE_KEY` | freshly generated if set; the features they serve are OFF in the policy |
| `SENTRY_DSN`, `EXPO_PUBLIC_SENTRY_DSN` | **unset** (delete any inherited value). Beta has no Sentry project yet; a DSN not on `BETA_SENTRY_DSNS` is refused. To get beta crash reports: create a separate Sentry project for beta (owner), then one reviewed PR adds its DSN to the three `BETA_SENTRY_DSNS` lists (`artifacts/api-server/src/lib/deploymentEnvironment.ts`, `scripts/deployment-env-guard.sh`, `travel-buddy-standalone/src/lib/deploymentConsistency.ts`) and to both beta profiles in `eas.json` |

Then, in the fork's `.replit`, delete or replace the production entries in
`[userenv.shared]`: `SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_URL`, and
`EXPO_PUBLIC_SUPABASE_ANON_KEY`. Also delete or replace `ALLOWED_ORIGINS` in
`[userenv.production]`. If any production value survives anywhere, the build
or the API refuses and names the variable.

Provider keys: use test or sandbox mode only (payment test keys; a Google
Routes key only with the quotas and hard budget of OD-TRUST-6).

#### Keys the mirrored features need

The flag policy mirrors production, so these features are ON. Each one does
something only when its provider key is in the beta Secrets. Use beta-only
keys, with quotas and spend caps; never production's.

| Key | What uses it | Without it |
| --- | --- | --- |
| `FSQ_API_KEY_PROD` | The Foursquare places provider: place search, external place records (`external_places_enabled` → `live_places_enabled` → `place_days_enabled` → Shared Moments), and live "open now". The beta reads `FSQ_API_KEY_PROD` because `NODE_ENV=production` (`lib/foursquareApiKey.ts`); the legacy fallback is `FOURSQUARE_API_KEY`. | It degrades honestly: `/api/places/live-status` answers `available: false` with a data note, and Foursquare-backed results are empty. **Warning:** with the key, open unsafe path **N-7** becomes reachable on beta. "Open right now" takes Foursquare's top name match with no identity check (`lib/liveIntelligence.ts`; D-67's identity rule is not on `main`). Hold this key until D-67's build lands, unless the lead accepts N-7 on test data. |
| `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_OPENAI_BASE_URL` | Compass's AI paths (`/compass/ask`), natural-language trip drafts (`nl_trip_creation_enabled`), AI visuals (the `ai_*` headers and covers), stamp artwork (`STAMP_IMAGE_MODEL`), and translation when `TRANSLATION_PROVIDER=openai` | Compass answers its honest fallback ("Compass AI assistant is temporarily unavailable…", census-compass CR-02). Trip drafts answer `degraded_unavailable` (`routes/tripDraft.ts`). The visual and stamp workers are expected to idle; not verified per worker. |
| `GOOGLE_MAPS_API_KEY` | Google Routes travel time for layover, with OD-TRUST-6's quotas and hard budget; discovery place photos | The provider refusal path (`lib/providers/providerRefusal.ts`); not verified per surface. |
| `TICKETMASTER_API_KEY` | Ticketmaster events near a trip's destination during its dates (`lib/eventsCache.ts`) | Skipped silently (that file's own contract): a trip shows no external events. |
| `MAPBOX_TOKEN` | Server-side geocoding (`services/geocodingService.ts`) | Falls back to Nominatim (OSM; free and rate-limited), then to coordinates without a city name. |
| Expo push credentials | `push_notifications_enabled`, which is OFF on beta until they exist | No pushes. |

#### Identity verification: a SANDBOX key on beta, never a live one

Two owner instructions govern identity on beta, and both hold:

- The 2026-10-06 authorization covers "test-mode payment and identity
  integrations" and asks for identity-provider sandbox setup. **So a sandbox
  identity key may be configured on beta**, and testers can exercise the
  verification flow.
- The 2026-10-05 instruction ("No tester bypass or sandbox verification key")
  is about Rent-a-Buddy **bookings**. **So a test-mode verification never
  satisfies a booking.** Three things enforce that:
  - lane B's `3930_identity_verifications_provider_mode.sql` rule (on lane B's
    branch, not yet on `main`);
  - every Rent-a-Buddy stop the flag policy engages;
  - the readiness gate described below.

**Today there is nothing to configure.** `main`'s `IMPLEMENTED_PROVIDERS`
(`services/identityVerification/readiness.ts`) holds only `mock`, and the mock
provider is refused in any Replit deployment. Leave `IDENTITY_PROVIDER` unset;
readiness reports identity as not operational.

**After PR #612 lands** (Sumsub behind the provider interface; lane P is
reconciling it), add the Sumsub SANDBOX credentials to the beta Secrets. The
names below were read from `origin/claude/sumsub-identity-provider-20261004`
at `9d1e0fb88`; re-read them on the merged commit.

| Key | Value |
| --- | --- |
| `IDENTITY_PROVIDER` | `sumsub` |
| `SUMSUB_APP_TOKEN` | the Sumsub **sandbox** app token. It starts with `sbx:`. A `prd:` token is classified live and refused (`lib/paymentsMode.ts` on #612). |
| `SUMSUB_SECRET_KEY` | the sandbox app's secret key |
| `SUMSUB_LEVEL_NAME_ID`, `SUMSUB_LEVEL_NAME_ID_SELFIE` | the sandbox verification-level names configured in the Sumsub dashboard |
| `IDENTITY_WEBHOOK_SECRET` | the sandbox webhook secret, which the Sumsub adapter uses to verify webhook digests |

Expected outcome. This is read from #612's code; I have not run it.

- The `startup: payments/identity provider mode` line reports
  `identityProvider: "sumsub"`, `keyMode: "test"`, `keyRefused: false`.
- A tester should be able to open a Sumsub sandbox session
  (`POST /api/verification/session`). On #612, `getIdentityProvider()` returns
  the Sumsub adapter.
- Readiness (`identityProviderStatus()`) still reports **not operational**:
  "IDENTITY_PROVIDER=sumsub but that adapter has not been certified against the
  vendor…". #612 deliberately leaves `sumsub` out of `IMPLEMENTED_PROVIDERS`;
  adding it is a separate change, made after a sandbox transcript.
- So the Rent-a-Buddy booking gate stays closed on readiness alone, as well as
  by the engaged stops and 3930.

### 6. Deploy — *Replit account*

Deployments → Autoscale. Confirm that the build command is
`bash scripts/build-production.sh` and the run command is
`pnpm --filter @workspace/api-server run start`. Settings made in the Replit UI
override `.replit`. The build's first line is the deployment-environment guard.

### 7. Smoke the deployed beta — *none (public GETs)*

```bash
pnpm -C scripts beta:smoke --base https://portava-beta.replit.app
```

Expect seven `PASS` lines:

- health;
- `signup-status` is exactly `{signupsEnabled:false, inviteOnly:true}`;
- `401` without a token;
- the Rent-a-Buddy booking stops are engaged: `GET /api/feature-flags` shows
  `disable_rent_buddy_booking`, `disable_rab_bookings` and
  `RENT_BUDDY_ADMIN_ONLY_MODE` all true and `rent_buddy_enabled` false;
- the same response equals `scripts/src/beta-flag-policy.json` at the commit
  you run it from (every policy-ON flag served true, every known flag at its
  policy value): this proves step 3 applied THIS policy to the database the
  API reads. After any policy edit, re-run step 3 or this check fails;
- portava-beta's public Auth settings report `disable_signup: true` (read with
  the `beta` profile's publishable key): this is what closes the app's own
  sign-up path, which the API cannot see;
- every personal `profiles` column (`date_of_birth`, `full_name`,
  `expo_push_token`, `phone_e164`, …) is refused to the anon key: each is
  probed through PostgREST with `limit=0`, so no row is ever returned. A `200`
  means migration 3740 is not applied and no tester account may be created.
  (UPDATE on the authority columns, `role` among them, and 3742's trigger are
  checked by step 3's SQL only: probing them through PostgREST would mean
  sending an UPDATE, and the smoke never writes. `beta:status` gate 3c
  requires both.)

Two things print `NOT CHECKED`:

- **Identity readiness.** The API has no unauthenticated read of it. In the
  deployment logs, the `startup: payments/identity provider mode` line must not
  report identity as operational. That is true today (mock refused), and it
  stays true after #612 with a sandbox key (Sumsub is uncertified). It cannot
  show `keyMode: "live"`: the deployment guard refuses a live key on beta.
- **`NODE_ENV=production`.** Not observable from outside, but enforced: a beta
  API refuses to start without it, and only a beta-labelled process may use the
  beta database, which checks 2 and 5 show this API reads.

### 8. Create tester accounts — *beta Supabase project dashboard*

**Not before** `beta:status` gate 3c passes. It has two halves:

- **3740 (PR #647), live:** smoke check 7 — the anon key is refused on every
  personal `profiles` column. Until then a tester's date of birth, full name,
  phone and push token would be readable with the public key.
- **3742 (PR #653), from step 3's SQL:** no client role can UPDATE any
  authority column, and 3742's trigger, its refusal and the predicate it
  trusts are in place. The evidence is the NEWEST `beta-config.yml` run: it
  must have succeeded, have applied (a dry run only warns), carry
  `profiles boundary 3740+3742 v3` in its title (a run of older code checked
  less), and have been created after the newest `beta-db.yml` run that wrote
  or may have written the schema, whatever that run's outcome: a failed,
  cancelled or still-running bootstrap or apply-pending run after the check
  re-opens the gate (the applier applies file by file, so a failed run applied
  some), and only an apply-pending dry run does not. After any apply-pending
  run, `beta:provision` re-runs that check.

Sign-up is closed, so testers are created by you. In the beta project, open
Authentication → Users → Add user → Create new user. Enter the tester's email
and a temporary password, and tick **Auto Confirm User**. Testers sign in in the
app with that email and password, and the app creates their profile on first
sign-in.

Email invitations ("Send invitation") need **custom SMTP**, which is an owner
credential (an SMTP provider account). Supabase's built-in SMTP sends only to
the project team's own addresses.

Apple and Google sign-in are **off** on beta (its public Auth settings,
2026-10-07: `apple: false`, `google: false`; only email is on). Testers sign in
with email and password. Turning them on needs the owner's Apple Services ID /
Google OAuth client configured in the beta project; with `disable_signup` on,
Supabase Auth would still refuse to create a new user through them.

### 9. Build and distribute the app — *Expo account; Apple Developer / Google Play*

See `docs/eas-runbook.md` § "Private beta build". In short:

1. Run `eas build --profile beta` (internal: iOS ad hoc to registered
   devices, Android APK), or `eas build --profile beta-store` for TestFlight
   internal testing / the Google Play internal track.
2. Distribute the internal build's install links, or
   `eas submit --profile beta-store --platform ios|android` for the store
   build. Never promote a `beta-store` build to an App Store or Play
   production release: it talks to the beta.

**Do not `eas env:set` or `eas env:create` anything for beta.** The `beta`
profile in `eas.json` carries every value the app inlines:
- both Supabase settings: the URL and beta's **publishable** key, which is
  public by design;
- both origins;
- `EXPO_PUBLIC_DEPLOYMENT_ENV=beta`.

The `preview` EAS environment stays as it is for the `preview` profile.

The beta build still loads the `preview` environment: a profile without
`environment` and with internal distribution loads `preview`
(https://docs.expo.dev/eas/environment-variables/usage/, read 2026-10-06).
Expo does not document whether that environment or the profile's `env` wins for
a plain `eas build`. **So isolation cannot be made deterministic from the file
alone.** The app closes the gap at startup: if the inlined database and API do
not both name beta, it shows "This build is misconfigured" and does not start.
In the first build's log, confirm that the `EXPO_PUBLIC_*` values are the beta
ones.

## If the beta URL is not `portava-beta.replit.app`

These places name the expected origin:

- `artifacts/api-server/src/lib/deploymentEnvironment.ts` (`BETA_API_HOST`)
  and `scripts/deployment-env-guard.sh` (the `REPLIT_DOMAINS` rule): the
  unlabelled-fork guard;

- `travel-buddy-standalone/eas.json` (`beta` profile);
- `travel-buddy-standalone/src/lib/deploymentConsistency.ts` (the beta API host
  the app's startup check expects);
- `scripts/src/beta-config-core.ts` (`BETA_WEB_ORIGIN`: the Auth `site_url`
  and redirect list);
- `ALLOWED_ORIGINS`, `EXPO_PUBLIC_API_BASE_URL` and `EXPO_PUBLIC_WEB_ORIGIN` in step 5.

Change all of them in one PR, then re-run steps 3 and 9.

## What is still open

- **Trail creation is not flag-gated on `main`.** `POST /v1/discovery/trails`
  has no flag (census-discovery DC-03/DV-20), so lead ruling D-66 ("review
  before visible") is not enforceable by the flag policy until its build lands.
  When that build seeds its flag, the policy test turns red until the flag is
  listed OFF.
- **Flag policy (lead decision 2026-10-06: mirror production fully).** 108 flags are ON:
  - the 6 beta safety controls (sign-up closed, Rent-a-Buddy booking stops, the D-67 live-label stop);
  - every flag the 2026-09-22 production snapshot records TRUE (101);
  - `layover_crowd_reports_enabled`, which is seeded TRUE by a migration newer than the snapshot.

  These stay OFF although production runs them:
  - the four Rent-a-Buddy capabilities;
  - `push_notifications_enabled` (no Expo push credentials yet);
  - `COMPASS_ACTIVE_REWARDS_ENABLED` (N-6's surface; inert).

  `COMPASS_FALLBACK_MODE_ENABLED` is OFF, as in production. Changing any value is a reviewed edit to
  `scripts/src/beta-flag-policy.json`, then re-dispatch step 3.
- **Identity.** No real provider exists on `main` until #612. See step 5.
- **New flags from open lanes (measured 2026-10-07 against their branches).**
  Each merge turns `betaFlagPolicyCompleteness.test.ts` (api-server suite) and
  `test:beta-configure` red until the policy lists the change. Run
  `pnpm -C scripts beta:flag-policy-sync --write` on the merged tree: it adds
  every new FALSE-seeded flag OFF and removes retired ones, and refuses (writes
  nothing) if a migration turns a flag ON. Expected:
  - lane B (#640): add `payment_ledger_reads_enabled` OFF (3823); remove
    `rent_buddy_allow_bookings_without_kyc` (retired by 3932). DONE: #640
    committed both by hand, and `beta:flag-policy-sync --write` on main
    470ac92cf writes nothing (measured 2026-10-08);
  - lane C wave 5: add `trip_private_anchor_sharing_enabled` (3970),
    `trip_routes_api_enabled` (3971) and `trail_creation_enabled` (3977), all
    OFF. `trail_creation_enabled` OFF also keeps lead ruling D-66 safe on beta
    until a reviewed edit turns it on;
  - lane L wave 6: add `sensing_consent_split_enabled` OFF (3703).
  Then re-dispatch step 3 (`beta:provision` skips the bootstrap).
- **3740 must be on beta before any tester exists (lead, 2026-10-07, from lane G / PR #647).**
  A beta built from `main` without 3740 carries table-level SELECT/UPDATE for
  `anon` and `authenticated` on `profiles` (the baseline replay inherits
  Supabase's default ACL), so the public anon key reads `date_of_birth`,
  `phone_e164`, `expo_push_token` and `full_name`. Enforced three ways:
  `beta-config.yml` fails its last step, `beta:smoke` check 7 fails, and
  `beta:status` gate 3c stays OPEN. `scripts/src/beta-db-core.ts`'s ACL step
  is unchanged; 3740 in the chain is the fix.
- **3742 too (lead, 2026-10-07, BETA-6 extended; rulings G3-1/G3-2, ORDER-3742; PR #653).**
  Without it a signed-in tester can `PATCH` their own `profiles` row and set
  `verified`, `trust_score`, `created_at`, `featured_count` and the other
  authority columns the server trusts. Enforced twice: `beta-config.yml`'s
  last step fails while any of the nineteen is client-updatable or 3742's
  trigger is absent, and `beta:status` gate 3c stays OPEN until the newest
  applying configuration run, made after the newest schema write, has passed
  that step. The smoke cannot see it without writing. 3742 always travels with
  3740 (ORDER-3742): merge #647, then #653, then `beta:provision`.
- **The beta schema follows `main` through the apply-pending mode (built 2026-10-07).**
  `beta-db.yml` `confirm=APPLY-PENDING-BETA` applies only the chain files a
  built beta lacks, with the unchanged applier, in the overridden order, with
  the bootstrap's refusals; it never resets, and it is a dry run unless
  `apply=yes`. It refuses an UNBUILT beta (no migration ledger) in its dry run
  and again right before its first write: the applier itself would not — on a
  project without a ledger it creates one (2254) and applies the chain onto the
  empty schema — so both steps fail on its `BOOTSTRAP REQUIRED` report; build
  beta with `confirm=BOOTSTRAP-BETA`:
  ```bash
  gh workflow run beta-db.yml -f confirm=APPLY-PENDING-BETA              # dry run: what beta lacks
  gh workflow run beta-db.yml -f confirm=APPLY-PENDING-BETA -f apply=yes # apply it
  ```
  `beta:status` gate 2b counts the migrations merged since the last run that
  wrote; `beta:provision` applies them and then re-runs the config step. Not
  exercised against beta yet (no token): its contract is tested on the
  workflow file (preflight and verdict bash executed for every input
  combination; the job's shape asserted; the dry-run and apply steps' bash
  executed against the real applier with a stubbed Management API: no ledger
  → both refuse and not one statement is sent).
