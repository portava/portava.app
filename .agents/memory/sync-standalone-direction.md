---
name: Sync-standalone direction
description: sync-standalone.sh copies FROM artifacts/travel-buddy (SRC) TO travel-buddy-standalone (DST) — not the reverse; mobile edits must target SRC
---

`scripts/sync-standalone.sh` hard-codes:
```
SRC="$REPO_ROOT/artifacts/travel-buddy"
DST="$REPO_ROOT/travel-buddy-standalone"
```

All sync modes (full, `--fix-source`, `--check-source`) use this direction: artifacts/travel-buddy → travel-buddy-standalone.

**Why:** The monorepo app (`artifacts/travel-buddy`) is the canonical source; standalone is the EAS build target derived from it.

**How to apply:** When editing mobile files, edit `artifacts/travel-buddy/src/...` (the SRC), then run `--fix-source` to propagate to standalone. Do NOT edit standalone directly for files shared with artifacts — the next sync run will overwrite them.

Exception: files listed in `STANDALONE_OWNED_FILES` in the script (test-only files) are protected and never overwritten by the sync.

replit.md says "don't run" artifacts/travel-buddy (i.e., don't start the Expo dev server from there) but editing its source files is fine and required for shared mobile code changes.
