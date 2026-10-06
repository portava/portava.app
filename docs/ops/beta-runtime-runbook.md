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
- **Sign-up is closed three ways, on the app's own path.**
  - Supabase Auth `disable_signup` is set by the configuration step.
  - The `disable_signups` stop and `invite_only_beta` are enforced by
    `POST /api/auth/signup`. That route answers `403 invite_required` and
    creates nobody. The app's `signUp` now creates accounts only through this
    route, then signs in.
  - The sign-up screen says the beta is invite-only before anyone types.
- **A build whose database and API disagree does not start.** The app compares
  the Supabase ref with the API host (beta↔beta, production↔production). A beta
  build (`EXPO_PUBLIC_DEPLOYMENT_ENV=beta`) must point every address at beta.
  On a mismatch the app shows "This build is misconfigured" instead of starting
  (`travel-buddy-standalone/src/lib/deploymentConsistency.ts`).
- **Flags follow one reviewed policy**, `scripts/src/beta-flag-policy.json`,
  applied and read back by `.github/workflows/beta-config.yml`.

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

### 4. Fork the Repl as `portava-beta` — *Replit account*

Fork the production Repl and name the fork `portava-beta`, so its deployment
URL is expected to be `https://portava-beta.replit.app`. The fork inherits
`.replit`, whose `[userenv.shared]` holds **production** values. Step 5
replaces them.

### 5. Replace every production value — *Replit account; beta project's API keys*

Set these as **Secrets** in the fork, starting with the first one.
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

Expect four `PASS` lines:

- health;
- `signup-status` is exactly `{signupsEnabled:false, inviteOnly:true}`;
- `401` without a token;
- the Rent-a-Buddy booking stops are engaged: `GET /api/feature-flags` shows
  `disable_rent_buddy_booking`, `disable_rab_bookings` and
  `RENT_BUDDY_ADMIN_ONLY_MODE` all true and `rent_buddy_enabled` false.

Two things print `NOT CHECKED`, because the API has no unauthenticated read
for them:

- **Identity readiness.** In the deployment logs, the
  `startup: payments/identity provider mode` line must not report identity as
  operational. That is true today (mock refused), and it stays true after #612
  with a sandbox key (Sumsub is uncertified). It must never show
  `keyMode: "live"`.
- **`NODE_ENV=production`.** Confirm it in the Secrets.

### 8. Create tester accounts — *beta Supabase project dashboard*

Sign-up is closed, so testers are created by you. In the beta project, open
Authentication → Users → Add user → Create new user. Enter the tester's email
and a temporary password, and tick **Auto Confirm User**. Testers sign in in the
app with that email and password, and the app creates their profile on first
sign-in.

Email invitations ("Send invitation") need **custom SMTP**, which is an owner
credential (an SMTP provider account). Supabase's built-in SMTP sends only to
the project team's own addresses.

Apple and Google sign-in have not been exercised on beta. With `disable_signup`
on, Supabase Auth refuses to create a new user through them.

### 9. Build and distribute the app — *Expo account; Apple Developer / Google Play*

See `docs/eas-runbook.md` § "Private beta build". In short:

1. Run `eas build --profile beta`.
2. Distribute the internal build.

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

Four places name the expected origin:

- `travel-buddy-standalone/eas.json` (`beta` profile);
- `travel-buddy-standalone/src/lib/deploymentConsistency.ts` (the beta API host
  the app's startup check expects);
- `scripts/src/beta-config-core.ts` (`BETA_WEB_ORIGIN`: the Auth `site_url`
  and redirect list);
- `ALLOWED_ORIGINS`, `EXPO_PUBLIC_API_BASE_URL` and `EXPO_PUBLIC_WEB_ORIGIN` in step 5.

Change all four in one PR, then re-run steps 3 and 9.

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
