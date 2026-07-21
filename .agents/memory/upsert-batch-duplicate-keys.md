---
name: Upsert batch duplicate ON CONFLICT keys
description: A single duplicate key inside one upsert batch silently kills the whole batch (Postgres 21000); supabase-js does not throw
---

# Upsert batches must dedupe the ON CONFLICT key

If any two rows in one `.upsert(rows, { onConflict: ... })` batch share the same conflict-key value, Postgres rejects the ENTIRE batch with code 21000 ("ON CONFLICT DO UPDATE command cannot affect row a second time"). supabase-js returns this as `{ error }` and never throws, so unchecked upserts fail totally and silently — zero rows written.

**Why:** the Compass feed registers HMAC-signed recommendation tokens per served item. Tokens are deterministic (user/item/section/key), so the same item served twice in a page produced duplicates, the whole registration upsert failed silently, and `/compass/why` returned "not found" for every token.

**How to apply:**
- Before any batched upsert with deterministic/derived keys, dedupe rows on the conflict column.
- Always check `error` on supabase-js writes that matter; log it — silent `void sc.from(...).upsert(...)` hides total failures.
