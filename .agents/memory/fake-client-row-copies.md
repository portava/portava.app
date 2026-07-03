---
name: Fake-client must return row copies not references
description: The fake Supabase client's select path must return shallow copies of DB rows, not direct references. Returning references causes mutations applied after the select (e.g. an update to the same row) to silently change values the handler already captured.
---

The bug: a PATCH handler reads a trip row into `t`, then updates it in-place via `Object.assign`. Because the fake client returned `db.trips[0]` directly (same object reference), `t.status` changed to "completed" along with the updated row — making the condition `t.status !== "completed"` false and silently skipping the entire stamp award block.

**Why:** Supabase (real client) serializes rows through JSON, so each response is a fresh object. A fake client that returns array element references doesn't match this contract.

**How to apply:** In every fake/in-memory Supabase client's `then()` select path, map results through a shallow copy before returning:

```ts
let results = applyFilters(arr).map((r) => ({ ...r }));
```

This applies to both the array return path and the single/maybeSingle paths (those already destructure from the copied array). Do not apply copying to the update return path — that intentionally returns the mutated row as the "new state".
