---
name: path.resolve for CLI args
description: Why CLI scripts must use path.resolve() not path.join(cwd, arg) for positional path arguments
---

## Rule

Always use `path.resolve(arg)` (not `path.join(process.cwd(), arg)`) when converting a CLI positional argument to an absolute path.

**Why:** `path.join('/cwd', '/abs/path')` returns `/cwd/abs/path` — it does NOT discard the base when the second segment is absolute. `path.resolve('/abs/path')` correctly returns `/abs/path` for absolute args and `join(cwd, relArg)` for relative ones.

**How to apply:** In any script that accepts a path via `process.argv[N]`:
```typescript
const appDir = appDirArg
  ? resolve(appDirArg)   // handles both absolute and relative
  : defaultFallback;
```
This bit the Expo Router duplicate-guard script: `join(cwd, '/tmp/xxx')` produced a non-existent path, `readdir` silently returned empty, and the guard reported "0 files scanned" even when conflicts existed.
