---
name: pnpm firewall blocks
description: Replit package firewall behavior — blocks tarballs even for packages in pnpm-lock.yaml if content store is missing them
---

# Replit pnpm firewall behavior

## Observation
`pnpm install --prefer-offline` and `pnpm install --offline` both fail with:
```
ERR_PNPM_FETCH_403  GET http://package-firewall.replit.local/npm/<pkg>/-/<pkg>-<ver>.tgz: Forbidden - 403
No authorization header was set for the request.
```

This happens even when:
- The package IS in `pnpm-lock.yaml` (resolved version)
- The pnpm virtual store (`node_modules/.pnpm/`) shows the package's DIRECTORY
- The pnpm content store (`.local/share/pnpm/store/v10/`) has `files` and `index` dirs

## Why
The content-addressable store has the metadata INDEX for the package but is missing the actual FILE chunks. The virtual store directory contains the package's DEPENDENCIES (extracted) but not the package itself. pnpm tries to fetch the missing tarball → firewall blocks it.

## Workaround
If the package itself IS fully extracted in the virtual store (files present in `.pnpm/<pkg>@<ver>/node_modules/<pkg>/`), use `ln -sf` to symlink it directly into the consuming package's `node_modules/`. Node.js resolves symlinks and uses the real path for relative imports — so the package's own dependencies (in its inner `node_modules/`) are found correctly.

If the package is NOT fully extracted (like vitest — only deps were extracted, not the package itself), build a local shim.

**Why:** Replit firewall at `package-firewall.replit.local` requires auth headers that pnpm doesn't send for standard npm packages. Some packages pass; others (vitest at least) return 403.
