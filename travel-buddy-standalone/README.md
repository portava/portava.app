# Travel Buddy — Standalone EAS Build Target

This folder (`travel-buddy-standalone/`) is a self-contained copy of the Travel Buddy Expo app, **fully decoupled from the pnpm monorepo**. Its purpose is a clean EAS cloud-build target with its own lockfile, `.npmrc`, and `eas.json` — no workspace plumbing, no catalog refs, no dependency on parent `lib/*` packages or root configs.

---

## Paths

| Location | Purpose |
|---|---|
| `artifacts/travel-buddy/` | Former monorepo app — **ARCHIVED 2026-08-14**, no longer on disk. Last state at commit `bc1bef404`. The artifacts→standalone sync retired with it. |
| `travel-buddy-standalone/` | **Canonical app tree** (as of 2026-08-04) and EAS build target — this folder |

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
pnpm --dir travel-buddy-standalone run dev

# Full monorepo typecheck
pnpm run typecheck
```

> **Note:** The standalone folder has its own `pnpm-workspace.yaml` (empty packages list) to prevent pnpm from traversing up to the monorepo root. This is what keeps the lockfile and `node_modules` isolated.

---

## Keeping the standalone in sync with the monorepo app

**Sync runs automatically** after every task merge via `scripts/post-merge.sh` — no manual step required for routine feature additions.

To run it manually from the **workspace root** (the sync itself is retired — `artifacts/travel-buddy` was archived at `bc1bef404`; this section is kept for historical reference only):

```bash
# Preview what would change (no files written)
bash scripts/sync-standalone.sh --dry-run

# Apply the sync
bash scripts/sync-standalone.sh
```

### What the script syncs

| Item | Action |
|---|---|
| `app/`, `src/`, `assets/`, `components/`, `constants/`, `hooks/` | Replaced in full from monorepo source |
| `docs/`, `migrations/`, `scripts/`, `server/` | Replaced in full from monorepo source |
| `babel.config.js`, `metro.config.js`, `app.json`, `eas.json`, `expo-env.d.ts` | Copied file-by-file |

### What the script deliberately leaves untouched

| File | Why preserved |
|---|---|
| `package.json` | Different `name` + standalone-specific scripts (no monorepo `dev` script) |
| `tsconfig.json` | `references` array removed (no `../../lib/api-client-react`) |
| `pnpm-lock.yaml` | Standalone lockfile — regenerate with `pnpm install` after dep changes |
| `pnpm-workspace.yaml` | Empty `packages: []` — keeps this folder isolated from the monorepo root |
| `.npmrc` | `node-linker=hoisted` required for React Native native modules |
| `README.md` | This file |
| `.env`, `.env.example`, `.gitignore` | Standalone environment / VCS config |
| `.replit-artifact/` | Replit artifact metadata |

### After syncing — manual steps required

1. **New dependencies**: historical — this diffed `artifacts/travel-buddy/package.json` vs `travel-buddy-standalone/package.json`. The former is archived at `bc1bef404`; there is one manifest now.
   Add any new `dependencies` or `devDependencies` to the standalone `package.json`,
   then run `pnpm install` inside `travel-buddy-standalone/`.
2. **`tsconfig.json` changes**: apply the same change to the standalone copy, keeping
   the `references` array absent.
3. **Verify**: `cd travel-buddy-standalone && pnpm typecheck`

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
| All source, assets, app/, config files | Originally copied verbatim from `artifacts/travel-buddy/` (archived at `bc1bef404`); authored directly here since |

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
| `npx expo-doctor` | ⚠️ 2 checks failed (pre-existing version mismatches — were identical in `artifacts/travel-buddy`, archived at `bc1bef404`) |
| Conflict-marker scan | ✅ No real conflict markers |

### expo-doctor version mismatches (pre-existing)

These mismatches also existed in the original `artifacts/travel-buddy/package.json` (archived at `bc1bef404`) and were not introduced by this standalone conversion. Run `npx expo install --check` to upgrade them when ready:

- `@react-native-community/datetimepicker` (expected 8.4.4, installed 9.1.0)
- `expo-calendar`, `expo-clipboard`, `expo-dev-client`, `expo-image-manipulator`, `expo-notifications`, `expo-sharing`, `expo-task-manager` (expected `~15.x` / `~6.x`, installed `~56.x`)
- `react-native-view-shot` (expected 4.0.3, installed 5.1.1)

---

## First Android dev build (after completing owner steps above)

```bash
cd ~/workspace/travel-buddy-standalone
eas build --profile development --platform android
```
