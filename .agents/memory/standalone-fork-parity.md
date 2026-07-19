---
name: Standalone tree = generated mirror
description: Canonical-tree rule between artifacts/travel-buddy and travel-buddy-standalone, sanctioned divergence ledger, and how propagation works
---

# Standalone tree = generated EAS mirror (rule settled July 2026)

**`artifacts/travel-buddy` is the single canonical source tree. `travel-buddy-standalone` is a generated mirror — never edit it directly.**

**Why:** task merges land in the monorepo tree, preview/web deploys serve it directly, sync tooling always flowed monorepo → standalone, and the mirror exists only because EAS native builds need a hoisted workspace-isolated tree. Full evidence + inventory: `docs/tree-sync-audit-2026-07-19.md`.

**How to apply:**
- Make ALL edits in `artifacts/travel-buddy`. Propagation to the mirror is automatic after task merges (`scripts/post-merge.sh`: apply-deps → full sync → mirror install → drift checks, loud failure on unexpected drift). Manual loop: `bash scripts/sync-standalone.sh --fix-source`.
- **Exception — the `STANDALONE_OWNED_FILES` ledger** (~84 entries in `scripts/sync-standalone.sh`): diverged screens (e.g. `app/(tabs)/index.tsx`, `discovery.tsx`, `app/search.tsx`), standalone-only Compass/LivePulse/settings source, and standalone-only tests. The sync SKIPS these. Editing one of them means porting the change manually into BOTH trees (respecting each tree's perspective paths). Check the ledger before assuming a file syncs.
- Never add ledger entries for shared code; the ledger is a graduation backlog, not an editing license. Web-only splits use `.web.tsx` siblings in canonical.
- Preserved-by-design mirror files (never synced): package.json, tsconfig.json, lockfile, `.npmrc`, `pnpm-workspace.yaml` (`packages: []`), jest.config.js (flat vs pnpm-nested transformIgnorePatterns), `.env*`, README, `e2e/`.
- Lockfile drift check compares BARE versions; pnpm peer-context suffixes legitimately differ between workspace and standalone installs (`[peer-context]` notes are non-actionable).
- Run the mirror's own `pnpm run typecheck` after porting ledger-file changes; EAS builds run from the mirror only after sync checks pass.
