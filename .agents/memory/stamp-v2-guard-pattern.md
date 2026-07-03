---
name: Stamp System v2 guard pattern
description: stamps.ts uses fail-closed middleware guard; isFlagEnabled is fail-open and wrong for tables from pending migrations
---

## Rule
`stamps.ts` has a router-level `router.use()` middleware that checks `stamp_system_v2_enabled` with **fail-closed** semantics (`data?.enabled !== true`). If the flag row is absent, it returns 503 instead of querying the underlying tables (which may not exist).

## Why
`isFlagEnabled` in `lib/featureFlags.ts` is **fail-open**: if the flag row is missing, it returns `true` (treat as enabled). This is correct for mature features whose flag was seeded in an early migration. But `stamp_system_v2_enabled` is seeded by migration 0081 itself — if 0081 hasn't been applied yet, the flag row doesn't exist, `isFlagEnabled` returns `true`, and the route crashes with "relation stamp_definitions does not exist" (500).

## How to apply
Any route file whose underlying tables come from a migration that also seeds the feature flag needs a **fail-closed** check (`data?.enabled === true`) rather than the shared `isFlagEnabled` helper. Place it as a `router.use()` middleware before all route handlers in the file so no handler can bypass it.

Pattern:
```ts
router.use(async (req, res, next) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  try {
    const { data } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "my_flag")
      .maybeSingle();
    if (data?.enabled !== true) {         // ← explicit true: fail-closed
      res.status(503).json({ error: "feature_not_available" });
      return;
    }
  } catch {
    res.status(503).json({ error: "feature_not_available" });
    return;
  }
  next();
});
```
