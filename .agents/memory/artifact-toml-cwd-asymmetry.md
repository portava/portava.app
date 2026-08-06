---
name: artifact.toml dev vs production cwd asymmetry
description: services.development.run and services.production.build/run.args resolve relative paths from different working directories
---

# Rule

In an artifact's `artifact.toml`:
- `services.development.run` executes with cwd = **the artifact's own directory** (e.g. `artifacts/<name>/`), not the repo root. A bare `cd some-sibling-dir` only works if `some-sibling-dir` is reachable relative to the artifact directory (e.g. `../../some-sibling-dir` from two levels down).
- `services.production.build.args` / `services.production.run.args` resolve relative paths from the **repo root** instead — the original convention in this repo used root-relative paths like `artifacts/<name>/scripts/build.js`.

**Why:** discovered while re-pointing a mobile artifact's `services` at a sibling standalone tree outside the artifact's own directory. Copying the production-style root-relative path into `services.development.run` produced `cd: <dir>: No such file or directory`, even though the directory existed at the repo root.

**How to apply:** when editing `artifact.toml` to point a service at a directory outside the artifact's own folder, write dev commands relative to the artifact directory and production build/run args relative to the repo root — don't assume they share one convention. Also: a service invoking a non-workspace-member directory's own scripts should go through that directory's own `pnpm run <script>` (not a bare `bash scripts/....sh`) so the local `node_modules/.bin` (e.g. `expo`) ends up on `PATH` — a bare `exec` from a `cd`'d shell does not get pnpm's PATH injection.
