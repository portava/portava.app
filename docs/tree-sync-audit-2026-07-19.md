# Tree synchronization audit — 2026-07-19

> **CLOSED 2026-08-14.** This document is the authority for a two-tree world that no
> longer exists. `artifacts/travel-buddy` was archived at `bc1bef404`; `scripts/sync-standalone.sh`,
> its `STANDALONE_OWNED_FILES` ledger (the ~84 entries this audit inventories), the
> post-merge sync and the three drift checks were all deleted with it. Nothing here is
> actionable. It is kept because the ledger records WHY each file was allowed to diverge,
> which is the only surviving explanation for some shapes in `travel-buddy-standalone`.

**Decision: `artifacts/travel-buddy` is the single canonical mobile source tree.**
`travel-buddy-standalone` is a generated EAS build mirror — never edited directly.

## Why canonical = `artifacts/travel-buddy`

Every operational system already treated it as the source; only `replit.md` prose said otherwise (now fixed):

1. **Task merges land there first** — the platform merge pipeline targets the monorepo tree.
2. **The web app is served from it** — Replit preview + web deployments run the canonical tree's Expo web build directly. Web output therefore needs no sync step and is always current.
3. **Sync tooling direction** — `scripts/sync-standalone.sh` has always copied monorepo → standalone.
4. **Artifact registration** — canonical is a registered artifact; standalone's registration is retired (`.replit-artifact/artifact.toml.bak`).
5. **EAS constraint** — native builds need a hoisted, workspace-isolated tree; that is the mirror's *only* reason to exist. Per `docs/eas-runbook.md`, `eas build` runs from `travel-buddy-standalone` — always after sync checks pass, so the build input is canonical content.

## How updates propagate to both outputs (automatic)

| Output | Mechanism |
|---|---|
| **Web app** | None needed — preview/deploys serve canonical directly (Expo web). |
| **Native / EAS mirror** | `scripts/post-merge.sh` runs after every task merge: monorepo `pnpm install` → `sync-standalone.sh --apply-deps` → full sync (source + config) → mirror `pnpm install` → `--check-source` / `--check-deps` / `--check-lockfile`. Any unexpected drift exits non-zero and surfaces loudly. Timeout raised 20 s → 300 s (the old 20 s timeout caused post-merge failures). |
| **Device dev loop** | Edit canonical → `bash scripts/sync-standalone.sh --fix-source` (fast copy) → Metro (serving the mirror) hot-reloads. |

Drift gates also run in the pre-release checks (`--check-source` threshold 0, perspective guard, babel/metro/tsconfig structural diffs).

## Drift found and fixed at reconciliation (2026-07-19)

| Item | Resolution |
|---|---|
| `@expo/ngrok` `^4.1.0` (canonical) vs `^4.1.3` (mirror) | Canonical bumped to `^4.1.3` (newer wins), then propagated. |
| `jest`, `test-renderer` devDeps missing from mirror | Propagated via `--apply-deps`; mirror lockfile re-resolved. |
| `lint:bottom-padding` script in mirror `package.json` | Removed — it pointed at `scripts/check-hardcoded-bottom-padding.mjs`, which does not exist in either tree (stale entry). |
| Lockfile check false-failures (5 entries) | Check compared full pnpm resolution strings; peer-context suffixes (e.g. `2.20.1(@types/…)`) legitimately differ between a workspace and a standalone install and `pnpm install` can never converge them. Fixed to compare bare versions; peer-suffix-only diffs now log as informational `[peer-context]` notes. |
| Post-merge hook: warn-only, 20 s timeout (timed out) | Rewritten for full auto-propagation with loud failure; timeout 300 s. Verified end-to-end (`runPostMergeSetup` → success, ~20 s). |

**Verified after reconciliation:** source drift 0 across all synced dirs; `app.json` / `eas.json` / `expo-env.d.ts` / `scripts/android-dev.sh` identical in both trees; dependency + lockfile checks PASS; both typechecks (tsc + import-extension guard) green; calling/LiveKit stack present in canonical.

## Full inventory of divergence at reconciliation time

Everything below is **sanctioned** divergence. Anything not listed here is in byte-for-byte sync and enforced at drift 0. The `STANDALONE_OWNED_FILES` ledger in `scripts/sync-standalone.sh` (84 entries) is the authority; entries currently content-identical are omitted from the lists below.

### A. Diverged shared files — ledger entries, graduation backlog (17)

Both trees have a version; the mirror's copy holds unique standalone work that predates the canonical rule. **Resolution: keep sanctioned; semantically reconcile into canonical per feature area, then remove from the ledger.** Until graduated, changes to these files must be ported manually in both trees (the sync skips them).

```
app/(tabs)/discovery.tsx                                app/(tabs)/index.tsx
app/search.tsx                                          src/components/LivePulseRail.tsx
src/components/PulseCreate.machine.ts                   src/components/__tests__/ProfileEdit.doubletap.test.ts
src/components/__tests__/PulseCreate.categoryGate.test.ts
src/components/compass/CompassBuddyRow.tsx              src/components/compass/CompassPicksSection.tsx
src/components/compass/CompassTravelerRow.tsx           src/components/discovery/DiscoveryCategoryTab.tsx
src/components/discovery/DiscoveryMapView.tsx           src/components/discovery/ForYouTab.tsx
src/components/location/MapLocationPicker.machine.ts    src/hooks/useLivePulse.ts
src/lib/__tests__/invitePreviewMapper.test.ts           src/services/__tests__/fillHomeFromGps.test.ts
```

### B. Standalone-only source & tests — ledger entries, unique valid work preserved (50)

Exist only in the mirror. **Resolution: keep sanctioned; graduate into canonical opportunistically** (tests need perspective-path adjustment + registration in the canonical test list; source files port directly).

Source (12):
```
app/compass-settings.tsx                 app/profile/change-password.tsx
app/settings/index.tsx                   app/settings/settings.machine.ts
src/components/LivePulseCard.tsx         src/components/LivePulseRail.machine.ts
src/components/discovery/filterStripNearest.ts
src/components/discovery/filterStripSort.ts
src/hooks/compass/useCompassSettings.ts  src/lib/compassIntent.ts
src/services/livePulse.ts                src/services/locationPrefsLogic.ts
```
(12 files — `filterStrip*` pair counted individually.)

Tests (38):
```
src/components/__tests__/ChangePassword.doubletap.test.ts
src/components/__tests__/CreateMemory.doubletap.test.ts
src/components/__tests__/LivePulseRail.test.ts
src/components/__tests__/PulseCreate.backdrop.test.ts
src/components/__tests__/PulseCreate.filter.test.ts
src/components/__tests__/PulseCreate.submit.test.ts
src/components/__tests__/PulseFeed.save.pagination.test.ts
src/components/__tests__/PulseFilterSheet.backdrop.test.ts
src/components/__tests__/ReviewComposer.prefill.component.test.tsx
src/components/__tests__/ReviewsSection.delete.component.test.tsx
src/components/__tests__/ReviewsSection.place.component.test.tsx
src/components/__tests__/SafeReturn.doubletap.test.ts
src/components/__tests__/SafeReturnActiveCard.doubletap.test.ts
src/components/__tests__/SafeReturnSetupSheet.contactLoad.test.ts
src/components/__tests__/SafeReturnSetupSheet.integration.test.ts
src/components/__tests__/SafeReturnSetupSheet.openEffect.test.ts
src/components/__tests__/SettingsScreens.doubletap.test.ts
src/components/compass/__tests__/CompassBuddyRow.hide.test.ts
src/components/compass/__tests__/CompassTravelerRow.followState.test.ts
src/components/discovery/__tests__/CompassPicksSection.test.ts
src/components/discovery/__tests__/DiscoveryCategoryTab.nearest.test.ts
src/components/discovery/__tests__/FilterStrip.nearest.test.ts
src/components/discovery/__tests__/FilterStrip.sort.test.ts
src/hooks/__tests__/TripSavedPlacesSection.component.test.tsx
src/hooks/__tests__/useGemCheckin.component.test.ts
src/hooks/__tests__/useTripSavedPlaces.component.test.tsx
src/lib/__tests__/compassIntent.test.ts
src/lib/__tests__/eventRoleActions.test.ts
src/lib/__tests__/inviteCardGoneHandler.test.ts
src/lib/__tests__/inviteRetryGuard.test.ts
src/lib/__tests__/waitlistState.test.ts
src/screens/admin/__tests__/featureFlags.machine.test.ts
src/screens/admin/__tests__/flagHistory.machine.test.ts
src/services/__tests__/location.gps.component.test.ts
src/services/__tests__/locationPrefs.load.test.ts
src/services/__tests__/mapLocationPicker.component.test.ts
src/services/__tests__/media.upload.test.ts
src/services/__tests__/stampArtwork.test.ts
```

### C. Preserved infrastructure — target-specific by design, never synced (permanent)

| File (mirror) | Why it must differ |
|---|---|
| `package.json` | Mirror name/scripts; hoisted-install config; standalone-only `test:invite-gone` (targets a ledger test). |
| `tsconfig.json` | No workspace project references (mirror is workspace-isolated). |
| `pnpm-lock.yaml` + `pnpm-workspace.yaml` (`packages: []`) + `.npmrc` | Own workspace root with hoisted node linker — the EAS build requirement that justifies the mirror's existence. |
| `jest.config.js` | Canonical needs pnpm-nested `transformIgnorePatterns`; mirror uses flat hoisted layout. |
| `.env` / `.env.local` | Tree-specific `EXPO_PUBLIC_API_BASE_URL` etc. |
| `README.md`, `e2e/` | Mirror-specific docs and device e2e harness. |
| `.replit-artifact/artifact.toml.bak` | Retired artifact registration (mirror is not a preview artifact). Canonical-only counterpart: `.replit-artifact/artifact.toml` (active registration). |

## Policy going forward

1. **All shared code lands in `artifacts/travel-buddy`.** The sync propagates it; the post-merge hook enforces it.
2. **No new `STANDALONE_OWNED_FILES` entries for shared cross-platform code.** New entries are justified only for genuinely target-specific files (native-only / web-only splits use `.web.tsx` siblings inside canonical instead wherever possible).
3. **Ledger = graduation backlog.** Sections A and B shrink over time; when a file is reconciled into canonical, delete its ledger entry so the sync takes over.
4. **CI note:** no `.github/workflows/` exists in this workspace; CI (pre-release checks incl. drift gates) lives on the GitHub remote per `docs/eas-runbook.md`.
