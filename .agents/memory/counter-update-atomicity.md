---
name: Counter updates must be atomic
description: Completion review rejects read-modify-write counters; use SQL RPC functions, and how to re-resolve the recurring package.json test-list rebase conflict
---

# Counter updates must be atomic

Denormalized counters (e.g. reliability counts on rent_buddy_profiles) must be updated via a single-statement DB operation, not select-then-update.

**Why:** the completion code review rejects read-modify-write increments as lossy under concurrency, and array-length recounts as wrong under PostgREST row limits.

**How to apply:** create SECURITY DEFINER SQL functions (column whitelist + `GREATEST(0, col + delta)`, or a DB-side recount) applied via the Supabase Management API, call them with `client.rpc(...)`, keep a read-modify-write fallback for fake test clients, and add a concurrency test (parallel calls land exactly N increments).

## Recurring rebase conflict: api-server package.json test list

With many parallel tasks each appending test files to the single-line `"test"` script, every rebase round conflicts there. Fast idempotent resolution:

```
sed -i '/^<<<<<<< HEAD$/d; /^=======$/,/^>>>>>>> /d' package.json   # keep incoming line
# then re-insert your own test files only if missing (grep -q before sed insert)
```

Note: root shell may lack `python3`/`node` on PATH; use `sed` or file tools for conflict edits.
