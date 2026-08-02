---
name: Standalone validation isolation
description: How to interpret the standalone combined test workflow when its node:test phase stops producing output.
---

The standalone combined validation command can remain running after its node:test child has stopped producing output, often while waiting on a test process with open handles. When this happens, isolate the suspected node:test file with a timeout and run the component suite separately before treating the workflow as failed.

**Why:** The combined command has no useful progress signal for a hung child, while isolated runs distinguish a real assertion failure from a runner/open-handle stall.

**How to apply:** Preserve current uncommitted work, stop the stale combined workflow, run the suspected test directly with a bounded timeout, then run `test:component` independently and record each result.