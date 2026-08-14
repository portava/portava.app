# EAS Dev-Build & MapLibre — Manual Owner Steps

The project is scaffolded for EAS builds and MapLibre native maps. The following steps require the project owner to complete before triggering a real device build.

## Required tools

Install all of the following on any machine or CI runner before triggering a build or running the pre-release check script. The preflight block in `scripts/pre-release-check.sh` validates each one and prints the relevant install hint when any is missing.

| Tool | Min version | Why needed | Install |
|------|-------------|-----------|---------|
| **bash** | 4.0+ | Sub-shell calls in `pre-release-check.sh` and `sync-standalone.sh` | macOS: `brew install bash` · Linux: `apt-get install bash` |
| **git** | 2.x | Source-drift diff in `sync-standalone.sh --check-source` | https://git-scm.com/downloads or OS package manager |
| **node** | 24.x (LTS) | Runtime for pnpm and all build scripts | [nvm](https://github.com/nvm-sh/nvm): `nvm install 24` · CI: `actions/setup-node@v4` with `node-version: 24` |
| **pnpm** | 10.x | Workspace installs and all `pnpm run …` scripts | `corepack enable && corepack prepare pnpm@latest --activate` |
| **eas-cli** | latest | `eas build`, `eas submit`, `eas update` commands | `npm install -g eas-cli` (or `pnpm add -g eas-cli`) |
| **expo** (Expo CLI) | latest | `expo export`, `expo doctor`, and local dev server | `npm install -g expo-cli` (or `pnpm add -g expo-cli`) |

### CI runner quick-start (GitHub Actions example)

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24

- run: corepack enable && corepack prepare pnpm@latest --activate

- run: npm install -g eas-cli expo-cli

# Verify all tools before running the pre-release check
- run: bash scripts/pre-release-check.sh
  env:
    SUPABASE_PROJECT_TOKEN: ${{ secrets.SUPABASE_PROJECT_TOKEN }}
```

### Verifying locally

Run the preflight check in isolation to confirm your environment is ready:

```bash
# From the workspace root
bash scripts/pre-release-check.sh
```

The script exits immediately with a list of missing tools and their install commands if anything is absent.

## Applied EAS monorepo fixes (already in the repo)

Four fixes are applied so EAS cloud builds detect pnpm and use the correct node-linker for React Native native modules (MapLibre, etc.):

| Fix | File | What it does |
|-----|------|--------------|
| `packageManager` field | `package.json` | Forces EAS/corepack to detect `pnpm@10.26.1` instead of guessing npm (eas-cli #2978 workaround) |
| `eas-build-pre-install` hook | `travel-buddy-standalone/package.json` scripts (was `artifacts/travel-buddy/...`, archived at `bc1bef404`) | Runs `corepack enable` before install so pnpm is available on the EAS build server |
| `node-linker=hoisted` | `.npmrc` | Uses the hoisted linker so React Native native modules (MapLibre, etc.) resolve correctly; the isolated linker (pnpm default) breaks native module lookup |
| Metro config | `travel-buddy-standalone/metro.config.js` (was `artifacts/travel-buddy/...`, archived at `bc1bef404`) | Already uses `getDefaultConfig` from `expo/metro-config` with only a blocklist and web shims — safe for monorepo, no changes needed |

> **Note:** The hoisted linker takes effect on the next fresh `pnpm install`. The existing Replit dev environment continues to work as-is.

## iOS credentials setup for CI

**Do this once before you push your first `release-*` branch.** The `eas-build` CI job runs `eas build --non-interactive`, which cannot prompt for Apple credentials. If credentials have not been stored in EAS cloud ahead of time the job fails immediately. The steps below store them once and every subsequent CI run picks them up automatically.

### Prerequisites

- An **Apple Developer account** (individual or org) with a paid membership active.
- The **Expo account** that owns this EAS project (`eas login` confirmed).
- `eas-cli` installed globally: `npm install -g eas-cli`.

### Step 1 — Log in to Expo and link the project

```bash
eas login                          # sign in with the Expo account that owns the project
cd travel-buddy-standalone
eas whoami                         # confirm the correct account is active
```

### Step 2 — Store Apple credentials in EAS

EAS manages the Apple certificate and provisioning profile in its cloud keystore. Run the interactive flow once locally:

```bash
cd travel-buddy-standalone
eas credentials --platform ios
```

At the prompt, choose **"Expo Go / Managed workflow"** and then **"Build credentials"**. EAS will:

1. Ask you to sign in to your Apple Developer account (opens a browser or prompts for Apple ID + password).
2. Generate a Distribution Certificate (or reuse an existing one).
3. Generate a Provisioning Profile for the `com.passporttravelbuddy.app` bundle ID.
4. Upload both to EAS cloud storage — they are encrypted and tied to your Expo project.

You do **not** need to store any `.p12` or `.mobileprovision` files yourself; EAS holds them.

> **Bundle ID note:** `com.passporttravelbuddy.app` is the bundle ID in `travel-buddy-standalone/app.json → ios.bundleIdentifier`. Make sure this matches what is registered in App Store Connect before running `eas credentials`, otherwise Apple will reject the provisioning profile request.

### Step 3 — Create an EXPO_TOKEN for GitHub Actions

1. Go to **https://expo.dev/accounts/[your-username]/settings/access-tokens**.
2. Click **Create token** → give it a name like `github-ci` → copy the value.
3. In your GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret**.
4. Name: `EXPO_TOKEN` · Value: the token you just copied.
5. Save.

The CI workflow (`eas-build` job) reads `${{ secrets.EXPO_TOKEN }}` and passes it to every `eas build` call. A dedicated preflight step in the workflow will fail immediately with a clear error if this secret is missing — you will not burn EAS build credits on a misconfigured run.

### Step 4 — Verify with a test release branch push

```bash
git checkout -b release-v1.0.0-test
git push origin release-v1.0.0-test
```

Go to **GitHub → Actions → "EAS preview build (Android + iOS)"** and confirm both build steps appear. Then go to **https://expo.dev/accounts/[your-username]/projects/travel-buddy/builds** and confirm two new builds (Android + iOS) are queued or running.

Once verified, delete the test branch:

```bash
git push origin --delete release-v1.0.0-test
```

### Summary checklist

- [ ] `eas credentials --platform ios` completed successfully (no errors from Apple)
- [ ] `EXPO_TOKEN` secret added to GitHub → Settings → Secrets and variables → Actions
- [ ] Test push to a `release-*` branch shows both Android and iOS EAS builds in the dashboard

---

## Scheduled credential health check

A GitHub Actions workflow (`.github/workflows/credential-health.yml`) runs every **Monday at 09:00 UTC** and inspects all EAS credentials with a **60-day warning window** — twice the 30-day window used by the release build. This gives the team enough runway to rotate credentials without urgency.

### What it does

| Condition | Action |
|-----------|--------|
| All credentials healthy (> 60 days remaining) | No-op; closes any open `credential-health` issue automatically |
| Any credential missing, expired, or expiring within 60 days | Opens (or comments on) a GitHub issue labelled `credential-health` with details and rotation steps |

The issue title is always **`[credential-health] EAS credentials expiring soon`**. Only one issue is open at a time — subsequent runs comment on the existing issue rather than opening a duplicate. The issue closes itself once credentials are healthy again.

### Triggering a manual run

Go to **GitHub → Actions → "Credential health check" → Run workflow**. This is useful after rotating credentials to confirm the check now passes without waiting for the next Monday.

### Required setup

The workflow reads `EXPO_TOKEN` from GitHub Secrets — the same secret used by the `eas-build` CI job. No additional setup is needed beyond what is already described in "iOS credentials setup for CI" above.

---

## Rotating iOS credentials

The `eas-build` CI job runs a **credential pre-flight check** before every Android/iOS build step. It calls `eas credentials --platform ios --non-interactive --json`, parses the JSON response, and fails immediately with a `::error::` annotation if:

- No Distribution Certificate or Provisioning Profile is found in EAS cloud.
- The Distribution Certificate expires within **30 days**.
- The Provisioning Profile expires within **30 days**.

This prevents a cryptic mid-build failure from burning EAS build credits on a doomed run.

### When does a credential expire?

| Credential | Typical validity | Issued by |
|-----------|-----------------|-----------|
| Apple Distribution Certificate | 1 year from creation | Apple Developer portal |
| Provisioning Profile | 1 year from creation (or App ID expiry) | Apple Developer portal via EAS |

Apple does not renew these automatically. You must rotate them before (or shortly after) they expire.

### How to rotate

Run the interactive flow locally once. EAS will revoke the old credential and upload a fresh one to EAS cloud storage. Every subsequent CI run picks up the new credential automatically.

```bash
eas login                          # confirm you are signed in as the project owner
cd travel-buddy-standalone
eas credentials --platform ios     # follow the prompts to regenerate certificate / profile
```

At the menu, choose **"Build credentials"** → **"Update Distribution Certificate"** (or **"Update Provisioning Profile"**) for whichever credential is near-expiry. If both are expiring, rotate the certificate first — a new certificate invalidates any existing profiles, so EAS will regenerate the profile as part of the certificate rotation.

After the command completes, confirm the new expiry:

```bash
eas credentials --platform ios --non-interactive --json | node -e "
const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(JSON.stringify(data, null, 2));
"
```

Push a test `release-*` branch to confirm CI passes the credential check before triggering a full build.

### If the CI check fires unexpectedly

1. **"Could not retrieve iOS credentials"** — `EXPO_TOKEN` may have been revoked or the token does not have access to this EAS project. Regenerate the token at https://expo.dev/accounts/[your-username]/settings/access-tokens, update the `EXPO_TOKEN` GitHub secret, and re-run the workflow.
2. **"No iOS credentials found"** — `eas credentials --platform ios` has never been run for this project, or credentials were manually deleted. Follow Step 2 in "iOS credentials setup for CI" above.
3. **"EXPIRED"** — The certificate or profile has already lapsed. Rotate immediately using the steps above. You may also need to re-register the bundle ID in App Store Connect if the associated profile was revoked by Apple.

---

## Android credentials setup for CI

**Do this once before you push your first `release-*` branch targeting Android.** The `eas-build` CI job runs `eas build --non-interactive`, which cannot prompt for a keystore. If no keystore has been stored in EAS cloud the job fails immediately. The steps below create and store one so every subsequent CI run picks it up automatically.

### Prerequisites

- A **Google Play Console** account (required only for production submissions; a keystore can be generated without one).
- The **Expo account** that owns this EAS project (`eas login` confirmed).
- `eas-cli` installed globally: `npm install -g eas-cli`.

### Step 1 — Log in to Expo and link the project

```bash
eas login                          # sign in with the Expo account that owns the project
cd travel-buddy-standalone
eas whoami                         # confirm the correct account is active
```

### Step 2 — Store a keystore in EAS

EAS can generate a keystore for you and store it in its cloud (recommended), or you can upload an existing `.jks` / `.keystore` file.

```bash
cd travel-buddy-standalone
eas credentials --platform android
```

At the menu choose **"Keystore: Manage everything needed to build your project"**, then **"Set up a new keystore"**. EAS will:

1. Generate a fresh keystore with a random alias, password, and a long validity period (typically 25+ years for new keystores).
2. Upload it to EAS cloud storage — encrypted and tied to your Expo project.

You do **not** need to store the `.jks` file yourself; EAS holds it. If you already have a keystore from a prior Google Play submission, choose **"Upload an existing keystore"** instead — Google Play locks your app to its first uploaded signing certificate, so you **must** use the same key for every subsequent release of the same app.

> **⚠ Critical:** Once a version of your app has been uploaded to Google Play, the signing key can never be changed. Back up the EAS-stored keystore using `eas credentials --platform android` → **"Download existing keystore"** and store the `.jks` file and its passwords somewhere safe (a password manager or secure vault). Losing it means you cannot publish updates to your existing Play Store listing.

### Step 3 — Verify the credential check passes

```bash
eas credentials --platform android --non-interactive --json
```

The output should contain a `keystore` object (not an empty `{}`). The CI preflight step runs this same command and fails with a `::error::` annotation if the keystore is missing or near-expiry.

### Summary checklist

- [ ] `eas credentials --platform android` completed successfully
- [ ] Keystore backed up to a secure location (passwords included)
- [ ] Test push to a `release-*` branch shows the Android EAS build in the dashboard

---

## Rotating Android keystore

The `eas-build` CI job runs an **Android credential pre-flight check** before every Android build step. It calls `eas credentials --platform android --non-interactive --json`, parses the JSON response, and fails immediately with a `::error::` annotation if:

- No keystore is found in EAS cloud.
- The keystore's `validityNotAfter` (or equivalent expiry field) is within **30 days**.
- The keystore's expiry date has already passed.

This prevents a cryptic mid-build failure from burning EAS build credits on a doomed run.

### When does a keystore expire?

| Credential | Typical validity | Notes |
|-----------|-----------------|-------|
| Android Keystore | Set at creation time | EAS-generated keystores default to ~25 years; manually created keystores vary widely. Check with `keytool -list -v -keystore <file>`. |

Android keystores do not auto-renew. If you created the keystore with a short validity period (common with old `keytool` defaults of 90 days or 1 year), you must rotate it before expiry. **However:** Google Play locks your app's signing certificate at the first upload, so if the app is already live you cannot simply generate a new keystore — see the warning below.

> **⚠ Google Play signing lock:** If your app has been published to Google Play, you **cannot** replace the signing key with a new one through EAS. The only path is to enroll in **Google Play App Signing** (where Google holds the upload key separately from the app signing key). Contact Google Play support if you face an expired key on a live app — the self-service rotation path is unavailable.

### Rotating before the first Play Store submission (safe path)

If the app has **never** been submitted to Google Play, you can freely generate a new keystore:

```bash
eas login                              # confirm you are signed in as the project owner
cd travel-buddy-standalone
eas credentials --platform android     # choose "Set up a new keystore" at the menu
```

EAS revokes the old keystore in its cloud and stores the new one. Every subsequent CI run picks it up automatically.

After the command completes, confirm the new expiry:

```bash
eas credentials --platform android --non-interactive --json | node -e "
const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(JSON.stringify(data, null, 2));
"
```

Push a test `release-*` branch to confirm CI passes the Android credential check before triggering a full build.

### If the CI check fires unexpectedly

1. **"Could not retrieve Android credentials"** — `EXPO_TOKEN` may have been revoked or the token does not have access to this EAS project. Regenerate the token at https://expo.dev/accounts/[your-username]/settings/access-tokens, update the `EXPO_TOKEN` GitHub secret, and re-run the workflow.
2. **"No Android keystore found"** — `eas credentials --platform android` has never been run for this project, or the keystore was manually deleted. Follow "Android credentials setup for CI" above.
3. **"EXPIRED"** — The keystore has already lapsed. If the app has never been submitted to Google Play, rotate using the steps above. If it is live on Google Play, see the Google Play signing lock warning.

---

## DB triggers check in CI

The `db-triggers` pre-release check (`scripts/check-db-triggers.sh`) queries the Supabase Management API to confirm that the DB protection triggers from migrations 0071–0074 are present in the production database before any EAS build is allowed to proceed.

### Which token to use

| Context | Token | Notes |
|---------|-------|-------|
| **CI / GitHub Actions** | `SUPABASE_PROJECT_TOKEN` | Project-scoped. **Not read-only — see below.** Stored as a repo secret and not tied to any developer account, so it rotates independently of developer tokens. **Preferred for CI.** |
| **Local developer run** | `SUPABASE_ACCESS_TOKEN` | Personal access token from https://supabase.com/dashboard/account/tokens. Never commit or store this in CI. |

> **⚠️ Corrected 2026-08-11 — this token is NOT read-only.** Earlier revisions of
> this table described `SUPABASE_PROJECT_TOKEN` as "read-only"; that was wrong and
> is retracted. **What it actually is: a Supabase Management API token that can
> write.** Nothing about the credential restricts it to reads. Per
> `docs/ci/README.md:469-470` — *"it does not make the credential read-only. The
> Management API token in the environment can write; the mode constrains what the
> **process** does"* — the read-only property of these checks comes from two places,
> **neither of which is the credential**:
>
> 1. **What the process does** — the audit entry points issue `SELECT`s only, and
>    which files may do so is enforced by `check-guard-coverage.mjs`, not assumed.
> 2. **The target allowlist** — `.github/scripts/assert-nonprod-supabase.sh` pins
>    which project may be contacted at all.
>
> Treat the token as a write-capable credential when deciding where to store it,
> who may read it, and how fast to rotate it after exposure. (This correction is
> about the token's **capability** only. Whether it is genuinely project-scoped is a
> separate, still-open question — see `docs/ci/README.md` and do not read this note
> as settling it.)

The script checks `SUPABASE_PROJECT_TOKEN` first; if absent it falls back to `SUPABASE_ACCESS_TOKEN`. Both use the same Supabase Management API endpoint so no other config change is needed.

### Creating a project-scoped token (one-time setup)

1. Go to the [Supabase dashboard](https://supabase.com/dashboard) and open this project.
2. Navigate to **Project Settings → API → Project API tokens**.
3. Click **Generate new token**.
4. Give it a name (e.g. `github-ci-trigger-check`). Select the narrowest scope the dashboard offers. **Do not treat that scope as a safety property:** the credential this endpoint accepts can write (`docs/ci/README.md:469-470`), so the check's read-only behaviour comes from the check itself — it issues `SELECT`s only — and from the target allowlist, not from the token.
5. Copy the generated token value.

### Storing the token as a GitHub Actions secret

1. In your GitHub repository, go to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**.
3. Name: `SUPABASE_PROJECT_TOKEN` · Value: the token you copied above.
4. Save.

The `pre-release-check.sh` step in CI must then pass the secret as an environment variable:

```yaml
- name: Pre-release checks
  run: bash scripts/pre-release-check.sh
  env:
    SUPABASE_PROJECT_TOKEN: ${{ secrets.SUPABASE_PROJECT_TOKEN }}
```

### If the check fails in CI

| Error message / symptom | Likely cause | Fix |
|-------------------------|-------------|-----|
| Job skipped with `::warning::` annotation | Fork PR — repository secrets unavailable | Expected; check runs on merge to main where secrets are present. Add the secrets to your fork's Settings → Secrets and variables → Actions to enable locally. |
| `No Supabase token found` | Secret not set or not passed via `env:` | Add/verify `SUPABASE_PROJECT_TOKEN` in repository secrets and the `env:` block above |
| `Management API returned HTTP 401` | Token invalid or revoked | Regenerate the project token and update the secret |
| `Management API returned HTTP 403` | Token scope too narrow | Ensure the token was created with **Read** scope |
| One or more triggers missing | Migration not applied to production | Apply `0071_protect_default_collection.sql` – `0074_*` via the Supabase dashboard or `psql` |

### Local developer run

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...   # generate at https://supabase.com/dashboard/account/tokens
bash scripts/check-db-triggers.sh
```

---

## Engagement indexes check in CI

The `Check engagement indexes (migration 0106)` step in `.github/workflows/pre-release.yml` queries the Supabase production database to confirm the five pg_indexes added by migration 0106 are present before any push to `main` or a release branch proceeds.

Missing indexes cause the `GET /api/engagement/likes` endpoint to degrade to sequential scans on `posts_likes`, `post_reactions`, `comment_likes`, `highlight_likes`, and `memory_likes` under cursor-based pagination.

### Why it is a dedicated CI step (not just part of pre-release-check.sh)

`scripts/pre-release-check.sh` includes the engagement index check (step 9) but **soft-skips** it (exit 0) when no token is present, to avoid blocking local developers who haven't configured Supabase credentials. The dedicated CI step adds a **hard-fail on missing token**, so the check is truly required in CI rather than silently bypassed.

### Which token to use

| Context | Token | Notes |
|---------|-------|-------|
| **CI / GitHub Actions** | `SUPABASE_PROJECT_TOKEN` | Project-scoped. **Not read-only — the token can write** (`docs/ci/README.md:469-470`); see the corrected note under "DB triggers check in CI" above. Stored as a repo secret. **Preferred for CI.** |
| **Local developer run** | `SUPABASE_ACCESS_TOKEN` | Personal access token from https://supabase.com/dashboard/account/tokens. Never commit. |

The `check-engagement-indexes.sh` script checks `SUPABASE_PROJECT_TOKEN` first; if absent it falls back to `SUPABASE_ACCESS_TOKEN`. Both reach the same Supabase Management API endpoint.

### One-time setup — store the token as a GitHub Actions secret

1. Go to the [Supabase dashboard](https://supabase.com/dashboard) and open this project.
2. Navigate to **Project Settings → API → Project API tokens**.
3. Click **Generate new token**.
4. Give it a name (e.g. `github-ci-engagement-check`). Select the narrowest scope the dashboard offers. **Do not treat that scope as a safety property:** the credential this endpoint accepts can write (`docs/ci/README.md:469-470`); the check's read-only behaviour comes from the check and the target allowlist, not from the token.
5. Copy the generated token value.
6. In your GitHub repository, go to **Settings → Secrets and variables → Actions**.
7. Click **New repository secret**.
8. Name: `SUPABASE_PROJECT_TOKEN` · Value: the token you copied above.
9. Save. (If the `db-triggers` check was already using this secret, skip steps 6–9 — it is the same secret.)

### Workflow step (reference)

The step is already in `.github/workflows/pre-release.yml`:

```yaml
- name: Check engagement indexes (migration 0106)
  env:
    SUPABASE_PROJECT_TOKEN: ${{ secrets.SUPABASE_PROJECT_TOKEN }}
  run: |
    if [ -z "$SUPABASE_PROJECT_TOKEN" ]; then
      echo "::error::SUPABASE_PROJECT_TOKEN secret is not set. ..."
      exit 1
    fi
    bash scripts/check-engagement-indexes.sh
```

### If the check fails in CI

| Error message / symptom | Likely cause | Fix |
|-------------------------|-------------|-----|
| `SUPABASE_PROJECT_TOKEN secret is not set` | Secret not configured in repository secrets | Follow the one-time setup steps above |
| `Management API returned HTTP 401` | Token invalid or revoked | Regenerate the project token and update the secret |
| `Management API returned HTTP 403` | Token scope too narrow | Ensure the token was created with **Read** scope |
| `MISSING index: idx_posts_likes_post_created` (or similar) | Migration 0106 not applied to production | Apply `artifacts/api-server/src/migrations/0106_engagement_indexes.sql` via the Supabase SQL editor or `psql` |

### Local developer run

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...   # generate at https://supabase.com/dashboard/account/tokens
bash scripts/check-engagement-indexes.sh
# or via the full suite:
bash scripts/pre-release-check.sh
```

---

## TODO (owner must finalize)

| Item | What to do |
|------|-----------|
| **Apple / Google store setup** | Register `com.passporttravelbuddy.app` on App Store Connect and Google Play Console before a production build. |
| **`eas login`** | Run `eas login` with the Expo account that owns the project. |
| **`eas init`** | Run `eas init` in `travel-buddy-standalone/` to link this project to your EAS project ID and write `extra.eas.projectId` into `app.json`. |
| **MapTiler API key** | Create a free account at https://www.maptiler.com/, generate an API key, and set `EXPO_PUBLIC_MAPTILER_KEY` in `travel-buddy-standalone/.env` (dev) and as an EAS secret (CI builds). |
| **Apple credentials for CI** | See "iOS credentials setup for CI" section above. |

> **Bundle ID:** `com.passporttravelbuddy.app` is set in `app.json` for both iOS (`ios.bundleIdentifier`) and Android (`android.package`). The pre-release check (`bundle-id-placeholder`) will fail CI if the old placeholder `com.travelbuddy.app` is ever restored. If you need to change the bundle ID again, update `app.json` and re-run `eas credentials --platform ios` to re-provision.

> **Version / build numbers:** `version` is `1.0.1`, `buildNumber` is `2`, `versionCode` is `2`. Increment `buildNumber` (iOS) and `versionCode` (Android) for every binary uploaded to the stores; bump `version` for user-facing releases.

## Bumping version and build numbers before a release

Both Apple App Store and Google Play reject a binary whose build number is not strictly greater than the last accepted submission. The pre-release check (`version-bump`) blocks the release if either value equals `1` (the first-submission default).

### Which field controls what?

| Field | File key | Platform | Rule |
|-------|----------|----------|------|
| `expo.ios.buildNumber` | `travel-buddy-standalone/app.json` | iOS (Apple) | String; must increase with every binary uploaded to App Store Connect. Apple compares this lexicographically, so use plain integers (`"2"`, `"3"`, …). |
| `expo.android.versionCode` | `travel-buddy-standalone/app.json` | Android (Google) | Integer; must be strictly greater than the last version code accepted by Google Play. |
| `expo.version` | `travel-buddy-standalone/app.json` | Both (user-visible) | The human-readable version string shown in the store listing (e.g. `"1.0.2"`). Only bump this for user-facing releases — not for every build upload. |

### When to bump

- **Every EAS build you submit to a store** — increment `buildNumber` (iOS) and `versionCode` (Android) by at least 1.
- **User-facing releases only** — bump `version` (e.g. `1.0.1` → `1.0.2`) when shipping a new public version to reviewers or production. Internal/test builds on the same version are fine as long as the build number goes up.
- **Rejected builds still consume the number** — even if Apple or Google rejects a binary, that build number is consumed and cannot be reused. Always increment before your next submission attempt.

### How to bump

Edit `travel-buddy-standalone/app.json` directly:

```jsonc
// Before
"ios":     { "buildNumber": "2" },
"android": { "versionCode": 2 }

// After (next submission)
"ios":     { "buildNumber": "3" },
"android": { "versionCode": 3 }
```

Then re-run `bash scripts/pre-release-check.sh` to confirm the `version-bump` check passes before triggering an EAS build.

### Configuring the floor

The check defaults to floor `1`. If your app has already shipped multiple versions and the relevant baseline is higher, set `VERSION_BUMP_FLOOR` before running the check:

```bash
VERSION_BUMP_FLOOR=5 bash scripts/pre-release-check.sh
```

## EAS build commands (after completing the above)

```bash
# Development build — installs expo-dev-client, runs on a real device or simulator
eas build --profile development --platform ios
eas build --profile development --platform android

# Internal preview build
eas build --profile preview --platform all

# Production build (store submission)
eas build --profile production --platform all
```

## react-native-maps migration note

`react-native-maps` is still installed. It is used in:
- `src/components/itinerary/MapView.tsx`
- `src/components/discovery/DiscoveryMapView.tsx`
- `src/components/RouteMinimapView.tsx`
- `src/components/RouteFullMapModal.tsx`

TODO: Migrate all four components to `@maplibre/maplibre-react-native` as a follow-up task, then remove `react-native-maps`.
