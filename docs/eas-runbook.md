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
| `eas-build-pre-install` hook | `artifacts/travel-buddy/package.json` scripts | Runs `corepack enable` before install so pnpm is available on the EAS build server |
| `node-linker=hoisted` | `.npmrc` | Uses the hoisted linker so React Native native modules (MapLibre, etc.) resolve correctly; the isolated linker (pnpm default) breaks native module lookup |
| Metro config | `artifacts/travel-buddy/metro.config.js` | Already uses `getDefaultConfig` from `expo/metro-config` with only a blocklist and web shims — safe for monorepo, no changes needed |

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
