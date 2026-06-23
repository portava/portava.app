---
name: Stray compiled .js shadowing .ts in api-server / mockup-sandbox
description: Why the api-server and mockup-sandbox workflows can suddenly crash with "exports is not defined in ES module scope" and how to fix
---

# Stray compiled `.js` files shadow `.ts` source

**Symptom:** api-server crashes at start with `ReferenceError: exports is not defined in ES module scope` (e.g. pointing at `src/lib/*.js`), and esbuild emits dozens of `Import "X" will always be undefined because the file "src/lib/Y.js" has no exports` warnings. mockup-sandbox fails to load `vite.config.js` with a require()/top-level-await module-format error.

**Root cause:** Some package (api-server, mockup-sandbox) is `"type": "module"`. If a `.js` file gets emitted next to a `.ts` file (e.g. someone ran `tsc` without `--noEmit`, or compiled output got committed), the stale CommonJS `.js` (`exports.x = ...`) breaks under ESM. Worse, TS imports use NodeNext `.js` specifiers (`import { x } from "./http.js"`), so esbuild/vite resolve the literal stale `.js` instead of `http.ts`, silently swapping in empty/old modules.

**Fix:** Delete every `.js` in the package's `src/` that has a matching `.ts` sibling (compiled output), plus compiled config files like `vite.config.js` / `mockupPreviewPlugin.js`. Use plain `rm`, then restart the workflow. Verify with `curl localhost:80/api/healthz` (expect 200).

**Why:** These packages must be checked with `tsc --noEmit` (build is via esbuild `build.mjs` for api-server, vite for mockup-sandbox). No `.ts`-derived `.js` should ever live in `src/`. The `.mjs` build scripts are legit and must NOT be deleted.

**How to apply:** If either workflow fails after a task merge with the above symptoms, run `find <pkg>/src -name '*.js' -type f -delete` (only safe because every `.js` there has a `.ts` twin — verify first), remove stray compiled configs, and restart.
