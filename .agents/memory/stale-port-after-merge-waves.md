---
name: Stale ports after merge waves
description: Workflow restarts during big task-merge waves can orphan old server processes that keep holding ports, breaking the next start.
---

# Stale ports after merge waves

**Rule:** When a workflow fails right after a batch of task merges, check for orphaned processes holding its port before touching any code.

**Why:** After a large merge wave, the API server workflow died with `EADDRINUSE 0.0.0.0:8080` — an old `dist/index.mjs` process from a previous run was still listening. The Expo workflow was worse: it showed status RUNNING but was actually **stuck on an interactive "Use port 20683 instead? (Y/n)" prompt** because the old Metro instance still held its port. A hung interactive prompt looks like a healthy workflow in status checks.

**How to apply:**
1. `lsof -i :<port> -P -n` to find the holder; `ps` to confirm it's a stale run (old start time / different pts).
2. `kill -9` the stale pid tree (parent `sh -c` + node child), verify the port is free, then `WorkflowsRestart`.
3. Treat an Expo workflow sitting at a port prompt as failed even though its status says RUNNING — it never serves until restarted on a free port.
