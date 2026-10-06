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
  `SUPABASE_URL` is the beta project's URL and no environment variable carries
  production's ref (`artifacts/api-server/src/lib/deploymentEnvironment.ts`).
  `scripts/build-production.sh` refuses to build the same way, and also needs
  the beta `EXPO_PUBLIC_SUPABASE_URL`, because the web bundle inlines it
  (`scripts/deployment-env-guard.sh`). An unrecognised value (`Beta`,
  `beta `, `staging`) is refused, not ignored. The beta project's URL without
  the beta label is refused too. With the variable unset — production today —
  nothing changes.
- **Sign-up is closed three ways.** Supabase Auth `disable_signup` (set by the
  configuration step), the `disable_signups` stop, and `invite_only_beta`:
  `POST /api/auth/signup` answers `403 invite_required` and creates nobody, and
  the app's sign-up screen says the beta is invite-only before anyone types.
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
feature flag to the policy in one audited transaction, then reads both back. It
exits 1 if anything reads back differently, and writes nothing if a policy flag
is missing from the database. Re-dispatch it whenever the policy changes.

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
Routes key only with the quotas and hard budget of OD-TRUST-6). **Do not add an identity-provider key for
bookings.** The owner's instruction of 2026-10-05 is "No tester bypass or
sandbox verification key" for Rent-a-Buddy. The policy keeps every booking
stop engaged. A test-mode verification never satisfies a booking. Leave
`IDENTITY_PROVIDER` unset: in a deployment the mock provider is refused, so
readiness reports identity as not operational.

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
- Rent-a-Buddy `launch-status` is `enabled:false`.

Two things print `NOT CHECKED`, because the API has no unauthenticated read
for them:

- **Identity readiness.** In the deployment logs, the
  `startup: payments/identity provider mode` line must not report identity as
  operational.
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

1. Put beta's publishable key in the EAS `preview` environment.
2. Run `eas build --profile beta`.
3. Distribute the internal build.

In the first build's log, confirm that `EXPO_PUBLIC_SUPABASE_URL` is the beta
URL. Expo documents that a profile's `env` outranks the EAS environment for
Workflows build jobs, but not for a plain `eas build`.

## If the beta URL is not `portava-beta.replit.app`

Three places name the expected origin:

- `travel-buddy-standalone/eas.json` (`beta` profile);
- `scripts/src/beta-config-core.ts` (`BETA_WEB_ORIGIN`: the Auth `site_url`
  and redirect list);
- `ALLOWED_ORIGINS` in step 5.

Change all three in one PR, then re-run steps 3 and 9.

## What is still open

- **Trail creation is not flag-gated on `main`.** `POST /v1/discovery/trails`
  has no flag (census-discovery DC-03/DV-20), so lead ruling D-66 ("review
  before visible") is not enforceable by the flag policy until its build lands.
  When that build seeds its flag, the policy test turns red until the flag is
  listed OFF.
- **No tester-facing feature is turned ON yet.** OD-PAY-11 approves tester
  features only after migrations and deployment are verified. The policy
  marks the flags production runs ON as `PROMOTION CANDIDATE`. Promoting one
  is a reviewed change to `scripts/src/beta-flag-policy.json`, followed by
  re-dispatching step 3.
