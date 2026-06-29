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

## TODO (owner must finalize)

| Item | What to do |
|------|-----------|
| **Bundle ID / package name** | `com.travelbuddy.app` is a placeholder in `app.json`. Replace with your actual Apple App Store / Google Play identifier. |
| **`version`, `buildNumber`, `versionCode`** | Currently `1.0.0` / `1` / `1`. Bump as needed for each release. |
| **Apple / Google store setup** | Register the app on App Store Connect and Google Play Console before a production build. |
| **`eas login`** | Run `eas login` with the Expo account that owns the project. |
| **`eas init`** | Run `eas init` in `artifacts/travel-buddy/` to link this project to your EAS project ID and write `extra.eas.projectId` into `app.json`. |
| **MapTiler API key** | Create a free account at https://www.maptiler.com/, generate an API key, and set `EXPO_PUBLIC_MAPTILER_KEY` in `artifacts/travel-buddy/.env` (dev) and as an EAS secret (CI builds). |
| **iOS permission copy** | Review all `infoPlist` usage description strings in `app.json` and replace placeholder copy with your final wording before App Store submission. |

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
