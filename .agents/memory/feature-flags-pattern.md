---
name: feature_flags column bug + fail-open pattern
description: The feature_flags table uses 'flag' as the PK column, not 'key'; isFlagEnabled must fail-open when table is un-migrated
---

## Rule

Always query `feature_flags` with `.eq("flag", flagName)`, NOT `.eq("key", flagName)`.

**Why:** The table DDL (migration `0037_feature_flags.sql`) defines `flag text PRIMARY KEY`. The column is literally named `flag`. Queries using `key` silently return `null` (no row matched), making `isFlagEnabled` always return `false` and every gated endpoint respond with `feature_disabled`.

**Affected files when written:** `passportStamps.ts`, `airport.ts`, `hiddenGems.ts` — all had the wrong column name.

## Fail-open pattern for isFlagEnabled

When the feature_flags table hasn't been migrated yet (pending migration in dev), PostgREST returns an error like "Could not find the table 'public.feature_flags' in the schema cache". The handler must fail-open:

```typescript
async function isFlagEnabled(flag: string): Promise<boolean> {
  const sc = getServiceClient();
  if (!sc) return false;
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flag)   // ← correct column name
      .maybeSingle();
    if (error) return true;      // table missing → fail-open
    if (data == null) return true; // row missing → flag not explicitly disabled
    return Boolean((data as any).enabled);
  } catch {
    return true; // network error → fail-open
  }
}
```

**How to apply:** Any new route that gates on a feature flag should use this exact pattern. `if (!sc) return false` stays (no service client = truly disabled). All other cases fail-open.
