---
name: Mockup sandbox stale generated-file shadowing
description: Extensionless imports of a plugin-generated module can silently resolve to a leftover file with a different extension from a prior tooling generation, breaking every consumer with no build error.
---

## The failure mode
`artifacts/mockup-sandbox/src/App.tsx` imports the auto-generated component
registry with an extensionless specifier: `from "./.generated/mockup-components"`.
Vite's default module resolution tries `.js`/`.mjs` before `.ts`. If a stale
`.js` file from an older generation of the same plugin is ever left on disk
next to the current `.ts` output (e.g. surviving a migration from CommonJS to
ESM codegen), the extensionless import silently resolves to the stale `.js`
instead of the live `.ts` — even though the `.ts` file is correct and being
actively regenerated.

**Symptom:** every `/preview/*` route rendered blank, with a browser console
error `Failed to load module script ... MIME type text/html` (the browser's
generic message when a non-ESM/CommonJS script is served as `type="module"`).
Every individual network request resolved 200 with the *correct* MIME type
when checked in isolation (curl, or after the fact) — the bug was purely in
*which file* got resolved, not in how any single file was served. This made
it look like a server-side MIME/routing bug when it was actually a stale
build artifact winning a resolver tie-break.

## Why it's easy to miss
- `noEmit: true` in tsconfig makes it look like nothing could emit a `.js` sibling — the actual `.js` was a leftover from a different, now-removed code path (an older plugin version generated CommonJS `.js` before a refactor moved it to ESM `.ts`), not a fresh build output.
- Server-side curl checks of every reachable resource pass individually; the bug only manifests when the *browser's own resolver* picks the wrong file for an extensionless import — checking files one by one never surfaces it.

## Fix applied
`mockupPreviewPlugin.ts`'s `refresh()` now deletes any other-extension sibling
next to the canonical generated `.ts` file on every regeneration, so a stale
artifact from a prior plugin generation can never again shadow the current one.

**How to apply elsewhere:** any dev-server plugin that writes a generated
module to a fixed path and is imported without an extension is vulnerable to
this if the plugin's own output format/extension ever changes across
versions. Either keep the extension in the import specifier, or have the
generator prune stale extension siblings on every write.
