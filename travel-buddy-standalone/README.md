# Travel Buddy — Standalone EAS Build Target

This folder (`travel-buddy-standalone/`) is a self-contained copy of the Travel Buddy Expo app, **fully decoupled from the pnpm monorepo**. Its purpose is a clean EAS cloud-build target with its own lockfile, `.npmrc`, and `eas.json` — no workspace plumbing, no catalog refs, no dependency on parent `lib/*` packages or root configs.

---

## Paths

| Location | Purpose |
|---|---|
| `artifacts/travel-buddy/` | Original monorepo app — stays **untouched as backup** |
| `travel-buddy-standalone/` | EAS build target — this folder |

---

## Commands

### From inside `travel-buddy-standalone/` (standalone, EAS builds)

```bash
cd ~/workspace/travel-buddy-standalone

# Install dependencies (first time or after package changes)
pnpm install

# Start Expo dev server
pnpm start

# Typecheck
pnpm typecheck

# First Android dev build (see owner steps below first)
eas build --profile development --platform android

# First iOS dev build
eas build --profile development --platform ios

# Internal preview build
eas build --profile preview --platform all

# Production store build
eas build --profile production --platform all
```

### From the monorepo root (`~/workspace/`)

```bash
# Run the Expo dev server for the monorepo app (normal dev workflow)
pnpm --filter @workspace/travel-buddy run dev

# Full monorepo typecheck
pnpm run typecheck
```

> **Note:** The standalone folder has its own `pnpm-workspace.yaml` (empty packages list) to prevent pnpm from traversing up to the monorepo root. This is what keeps the lockfile and `node_modules` isolated.

---

## What was changed vs the monorepo version

| File | Change |
|---|---|
| `package.json` | Name changed from `@workspace/travel-buddy` → `travel-buddy-standalone`; monorepo `dev` script removed; standard Expo `start`/`android`/`ios`/`web` scripts added |
| `tsconfig.json` | Removed `references` to `../../lib/api-client-react` (unused in the app — no `@workspace/` imports anywhere in source) |
| `.npmrc` | Added (`node-linker=hoisted`) — required for React Native native modules |
| `eas.json` | Preserved from original — `development`, `preview`, `production` profiles |
| `.env.example` | Preserved from original — documents all required env vars |
| `pnpm-workspace.yaml` | Added (empty `packages: []`) — makes this folder a self-contained pnpm workspace root |
| All source, assets, app/, config files | Copied verbatim from `artifacts/travel-buddy/` |

---

## Remaining owner steps before triggering a real EAS build

These steps require the project owner to complete manually:

| Step | What to do |
|---|---|
| **Bundle ID / package name** | `com.travelbuddy.app` is a placeholder in `app.json`. Replace with your actual Apple App Store / Google Play identifier. |
| **EAS login** | Run `eas login` with the Expo account that owns the project. |
| **EAS init** | Run `eas init` in this folder to link to your EAS project ID and write `extra.eas.projectId` into `app.json`. |
| **MapTiler API key** | Create a free account at https://www.maptiler.com/, generate an API key, and set `EXPO_PUBLIC_MAPTILER_KEY` in `.env` (copy `.env.example` → `.env`) and as an EAS secret for CI builds. |
| **Supabase credentials** | Copy `.env.example` → `.env` and fill in `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, and `EXPO_PUBLIC_API_BASE_URL`. |
| **iOS permission strings** | Review all `infoPlist` usage description strings in `app.json` and replace placeholder copy with your final wording before App Store submission. |
| **Apple / Google store setup** | Register the app on App Store Connect and Google Play Console before a production build. |
| **`version`, `buildNumber`, `versionCode`** | Currently `1.0.0` / `1` / `1`. Bump as needed for each release. |

---

## Validation status (at time of creation)

| Check | Result |
|---|---|
| `pnpm -r list` (workspace root) includes standalone | ❌ Not included — correct |
| `pnpm-lock.yaml` present in standalone folder | ✅ Pass |
| `node_modules` present in standalone folder | ✅ Pass |
| `npx tsc --noEmit` | ✅ Pass |
| `npx expo-doctor` | ⚠️ 2 checks failed (pre-existing version mismatches — same in `artifacts/travel-buddy`) |
| Conflict-marker scan | ✅ No real conflict markers |

### expo-doctor version mismatches (pre-existing)

These mismatches also exist in the original `artifacts/travel-buddy/package.json` and are not introduced by this standalone conversion. Run `npx expo install --check` to upgrade them when ready:

- `@react-native-community/datetimepicker` (expected 8.4.4, installed 9.1.0)
- `expo-calendar`, `expo-clipboard`, `expo-dev-client`, `expo-image-manipulator`, `expo-notifications`, `expo-sharing`, `expo-task-manager` (expected `~15.x` / `~6.x`, installed `~56.x`)
- `react-native-view-shot` (expected 4.0.3, installed 5.1.1)

---

## First Android dev build (after completing owner steps above)

```bash
cd ~/workspace/travel-buddy-standalone
eas build --profile development --platform android
```
