---
name: Standalone tree = generated mirror (SUPERSEDED 2026-08-06; CLOSED 2026-08-14)
description: Canonical-tree rule between artifacts/travel-buddy and travel-buddy-standalone, sanctioned divergence ledger, and how propagation works
---

# ⚠ CLOSED 2026-08-14 — the second tree no longer exists

`artifacts/travel-buddy` was archived on 2026-08-14; its last state is at commit
`%s`. `scripts/sync-standalone.sh`, `scripts/post-merge.sh`, the
`PORTAVA_ENABLE_LEGACY_SYNC` gate and the `STANDALONE_OWNED_FILES` ledger were
deleted with it. Nothing below is actionable — not the old direction, not the
flipped one. There is one tree, `travel-buddy-standalone`, and no propagation
step of any kind. Kept for porting forensics only.

# ⚠ SUPERSEDED 2026-08-06 — direction flipped

As of 2026-08-06, `travel-buddy-standalone/` is the canonical source tree and
`artifacts/travel-buddy` is the legacy-frozen one (see `replit.md`'s SOURCE OF
TRUTH banner and `scripts/post-merge.sh`, which hard-disables the
legacy-sync-to-standalone direction by default via `PORTAVA_ENABLE_LEGACY_SYNC`).
The mobile artifact's `artifact.toml` dev/build/run commands were re-pointed to
run directly out of `travel-buddy-standalone/` (not `pnpm --filter
@workspace/travel-buddy`), and both dev preview and production deploy now
serve from the standalone tree. **Everything below this line describes the
OLD (pre-2026-08-06) direction and is kept only for historical/porting-forensics
context — do not follow it for new work.** Before trusting any claim below,
verify against the current `replit.md` banner, since the direction is a policy
flag that can change again.

# Standalone tree = generated EAS mirror (rule settled July 2026, reversed Aug 2026)

**`artifacts/travel-buddy` is the single canonical source tree. `travel-buddy-standalone` is a generated mirror — never edit it directly.**

**Why:** task merges land in the monorepo tree, preview/web deploys serve it directly, sync tooling always flowed monorepo → standalone, and the mirror exists only because EAS native builds need a hoisted workspace-isolated tree. Full evidence + inventory: `docs/tree-sync-audit-2026-07-19.md`.

**How to apply:**
- Make ALL edits in `artifacts/travel-buddy`. Propagation to the mirror is automatic after task merges (`scripts/post-merge.sh`: apply-deps → full sync → mirror install → drift checks, loud failure on unexpected drift). Manual loop: `bash scripts/sync-standalone.sh --fix-source`.
- **Exception — the `STANDALONE_OWNED_FILES` ledger** (~84 entries in `scripts/sync-standalone.sh`): diverged screens (e.g. `app/(tabs)/index.tsx`, `discovery.tsx`, `app/search.tsx`), standalone-only Compass/LivePulse/settings source, and standalone-only tests. The sync SKIPS these. Editing one of them means porting the change manually into BOTH trees (respecting each tree's perspective paths). Check the ledger before assuming a file syncs.
- Never add ledger entries for shared code; the ledger is a graduation backlog, not an editing license. Web-only splits use `.web.tsx` siblings in canonical.
- Preserved-by-design mirror files (never synced): package.json, tsconfig.json, lockfile, `.npmrc`, `pnpm-workspace.yaml` (`packages: []`), jest.config.js (flat vs pnpm-nested transformIgnorePatterns), `.env*`, README, `e2e/`.
- Lockfile drift check compares BARE versions; pnpm peer-context suffixes legitimately differ between workspace and standalone installs (`[peer-context]` notes are non-actionable).
- Run the mirror's own `pnpm run typecheck` after porting ledger-file changes; EAS builds run from the mirror only after sync checks pass.

**Porting mechanics for ledger (diverged) files:**
- Port edits anchored on the standalone file's own text, never blind-copy; for big diffs, `git diff` the main-tree change and `git apply -p3` / `patch -p3` onto the fork — hunks outside divergent regions apply cleanly.
- Twin component tests may assert MOBILE-ONLY features never ported to the fork's diverged screens (e.g. dimmed-chip city picker, /map shortcut, Pulse tap→rank wiring). Rewrite the twin to the standalone screen's actual behavior — or delete it if the feature is wholly absent — never port mobile assertions blind.
- **Fork-tailored twin tests MUST be in the `STANDALONE_OWNED_FILES` ledger, or they get clobbered.** A "test refactor" pass once overwrote the fork-tailored twins (screens: discovery/pulse/search + a maplibre-mock passport suite) with monorepo-architecture versions → 15 standalone suites red. Recovery: restore the twins from the last-green commit (`git log` the twin's path; the commit whose message claims both trees green), delete twins for features the fork lacks, then ledger-list every one — deleted twins too, since the sync re-creates unlisted files as "new". Diagnostic signature: standalone suite asserts `resolvedLocation`/`useLocationContext` while the fork's screen reads `useActiveLocation`, or a twin lost its "DIVERGENT FORK" comment block.
- Known fork difference: standalone enables `experiments.typedRoutes` (main does not), so dynamic `router.push(\`/x/\${id}\`)` template literals fail its tsc — cast per the fork's existing convention (`as any` at the call site).
- Install gotcha: the mirror has its own package.json/node_modules; after merges add new deps there too — "Cannot find module" from its tsc usually means the dep was never installed in `travel-buddy-standalone/` (e.g. `@livekit/react-native`, July 2026).
- Delegating a port to a subagent works well when the task spells out: diff-first rule, which files replace wholesale vs append, and "run standalone tsc; fix only ported files."

**Sync-drift contract:** standalone screens intentionally diverge; they have fork-tailored TEST TWINS (ledger-protected) asserting standalone behavior. When synced monorepo tests fail in standalone, the fix is restoring/adapting fork twin tests — NOT porting canonical screen behavior into the fork. Porting creates code/test contradictions with the protected twins.
