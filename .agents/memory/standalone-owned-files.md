---
name: Standalone-owned test files
description: Test files created only in travel-buddy-standalone must be listed in STANDALONE_OWNED_FILES in scripts/sync-standalone.sh to survive --fix-source.
---

## Rule

`bash scripts/sync-standalone.sh --fix-source` syncs `artifacts/travel-buddy` → `travel-buddy-standalone` for directories listed in `SOURCE_DRIFT_DIRS` (which includes `src/`, `app/`, etc.). Any file in `travel-buddy-standalone` that does NOT exist in `artifacts/travel-buddy` will be **deleted** by `--fix-source`.

To preserve a standalone-only file, add its relative path to `STANDALONE_OWNED_FILES` in `scripts/sync-standalone.sh` (around line 120).

**Why:** The sync script is authoritative for shared source; standalone-only test files exist to support the EAS/Jest environment that doesn't exist in the monorepo artifact. These test files should not be replicated in `artifacts/travel-buddy`.

**How to apply:** When creating a new test file only in `travel-buddy-standalone/src/`, add an entry like:
```bash
STANDALONE_OWNED_FILES=(
  ...
  "src/hooks/__tests__/useMyHook.component.test.ts"
  "src/components/__tests__/MyComponent.component.test.tsx"
)
```

**Affected paths:** `src/services/__tests__/`, `src/components/__tests__/`, `src/hooks/__tests__/` when the file doesn't exist in `artifacts/travel-buddy/`.
