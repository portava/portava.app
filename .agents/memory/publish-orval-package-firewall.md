---
name: Publishing blocked by Orval package firewall
description: Replit publishing can fail during pnpm install before the app build when the package firewall rejects the locked Orval tarball.
---

Publishing may fail before any project build runs if the deployment installer receives `ERR_PNPM_FETCH_403` for the locked Orval package tarball. This is a package-fetch/infrastructure blocker, not evidence of an application compile or startup failure.

**Why:** The deployment builder installs every workspace dependency and can reject a public package request with no authorization header; local missing-module errors may be secondary symptoms.

**How to apply:** Inspect the failed publishing build logs first. If the same Orval fetch is rejected repeatedly, retry once and then treat it as a package-firewall/platform issue unless deliberately changing the dependency graph.