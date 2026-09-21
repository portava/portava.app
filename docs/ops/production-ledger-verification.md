# Production migration ledger — verification of the 382 backfilled entries

**Measured 2026-09-15 against production `ajrurzioarfkagpuxfnb`, read-only.**

`public.schema_migration_ledger` was created in production on 2026-09-15 by applying
the long-merged `2254_schema_migration_ledger.sql`. Before that, production had no
ledger at all: `apply-migrations.ts` exited 2 there ("no ledger table"), the sanctioned
applier had never been able to run, and nothing in the tree could answer *"which
migrations are applied to production?"*.

Creating the ledger does not answer that question either. This document is the
verification of what its 382 rows do and do not establish.

---

## 1. The structural safety property, checked first

**An inaccurate ledger cannot cause a required migration to be SKIPPED.** This was
verified in the applier's source rather than assumed:

```ts
export function isProofOfApply(row: LedgerRow): boolean {
  if (row.applied_by !== "ci" && row.applied_by !== "manual") return false;
  return SHA256_HEX_RE.test(row.checksum);
}
```

Every one of the 382 rows is `applied_by = 'backfill'` with the literal string
`'backfill'` where a sha256 would go, so `isProofOfApply` is false for all of them. In
the plan builder, a row that is not proof goes to `unproven`, **never to `skipped`**:

```ts
if (!isProofOfApply(row)) {
  if (forced.has(filename)) pending.push(filename);
  else unproven.push(filename);
  continue;
}
```

`unproven` files are not applied and not skipped; the applier reports them and requires
`--apply-unproven` to name one deliberately. So the failure mode this verification was
asked to rule out — a backfilled row causing the applier to believe a migration had run
and pass over it — **is unreachable by construction**, not merely unobserved.

---

## 2. What the 382 rows claim, and what they do not

A `backfill` row asserts **only** that the filename existed in `src/migrations/` when
2254 was authored. It is not evidence that the file ran against this database, and
nothing verified that it did. That is 2254's own stated contract, and it is the reason
the checksum is the literal `'backfill'` rather than a real hash — a 64-hex value in
that column would be read as "this is what ran".

---

## 3. Independent evidence: declared objects vs the live catalog

Since the ledger cannot say what ran, the question was put to the database instead.
Every migration's declared `CREATE TABLE` and `CREATE FUNCTION` objects were extracted
from the tree (comment lines stripped, so prose in headers is not mined) and checked
against production's `information_schema.tables` and `pg_proc` in `public` + `authz`.

Of the 382 backfilled files:

| class | n | what it means |
|---|---:|---|
| **ALL_PRESENT** | **167** | every object the file declares exists in production. **Consistent with having been applied — NOT proof of it.** |
| **NO_MARKER** | **205** | the file declares no table and no function (grants, policies, RLS, `ADD COLUMN`, data). Object presence **cannot judge these at all**. |
| **NONE_PRESENT** | **10** | not one declared object exists. Strong evidence the file never ran. One is a false positive — see §4. |

**The 205 are the honest headline.** More than half the backfilled set cannot be
assessed by this method even in principle, so this audit is a lower bound on
non-application, not an inventory of it.

### Why ALL_PRESENT is not proof

2254's own header states the reason and it still holds: a file whose objects exist may
have been applied, **or** the objects may have come from the baseline dump, a later
file, or a hand-run statement. Production predates any ledger, so there is no
provenance to appeal to. 167 is "nothing contradicts it", not "it ran".

---

## 4. The nine migrations that demonstrably never ran

`NONE_PRESENT`, minus one false positive:

| migration | missing object(s) | corroboration |
|---|---|---|
| `2121_source_registry.sql` | `sources` | also on `check:production-drift`'s ratchet |
| `2141_post_tombstones.sql` | `tombstone_post()` | — |
| `2202_map_telemetry.sql` | `map_telemetry_events`, `map_telemetry_drops`, `map_telemetry_payload_is_clean()` | also on the drift ratchet |
| `2205_memory_new_to_me_batch.sql` | `memory_are_new_to_user()` | — |
| `2213_memory_passport_controls.sql` | `memory_remembers_for_user()` | — |
| `2214_memory_recaps.sql` | `memory_recaps_for_user()` | — |
| `2217_protected_locations.sql` | `protected_zones` | drift ratchet; runbook names it as a prerequisite for any `map_projection_enabled` flip |
| `2220_canonical_locations_search_key.sql` | `input_normalize_city_key()` (and `canonical_locations.search_key`) | runbook **B01**; census-discovery **B01** grades a row on it |
| `2224_route_hop_signal.sql` | `route_flow_contribution_consent` | drift ratchet; runbook's grant-boundary chain `2224 → 2333` |

Every one of the nine is independently corroborated by at least one instrument that did
not use this method — the drift ratchet, the manual runbook, or a census row. None rests
on this audit alone.

### The false positive, kept rather than quietly dropped

`0050_rent_a_buddy.sql` scored 0 of 9 and is **NOT** evidence of non-application. It
declares `buddy_profiles`, `buddy_packages`, `buddy_addons`, `buddy_availability`,
`buddy_bookings`, `buddy_reviews`, `buddy_applications`, `buddy_saved`,
`buddy_waitlist` — and production carries the **`rent_buddy_*`** rebuild of all of them.
`auditMigrationsVsLive.ts` skips this file for exactly this reason:
`"0050_rent_a_buddy.sql", // superseded by 0134_rent_buddy_schema_rebuild.sql`.

This is the whole weakness of name-keyed object matching: **a rename reads as an
absence.** The method was checked against the repo's own auditor precisely because a
confident "never applied" about nine tables that plainly exist would have been a worse
error than not measuring at all.

---

## 5. What this does NOT establish

1. **Nothing about the 205 NO_MARKER files.** A grant migration, an `ADD COLUMN`, a
   REVOKE or a policy rewrite leaves no object this method can look for. Column-level
   drift has its own instrument (`check:missing-live-columns`) and it too sees only CI.
2. **Nothing about whether the 167 ran.** Only that nothing contradicts it.
3. **Nothing about postconditions.** Several migrations carry `DO $$ … RAISE EXCEPTION`
   postcondition blocks asserting grants, RLS and trigger state. Object presence does not
   run them. A migration can have created its table and still have left the write
   boundary wrong.
4. **Renames beyond the one found.** `0050` was caught because its subject was
   conspicuous. A quieter rename would still read as an absence here.

---

## 6. Consequence for further migrations

The nine in §4 are pre-2254 files that never ran. They are **not** in the 68-table
production gap `check:production-drift` reports, because that ratchet is keyed on tables
declared in the tree and several of these nine declare only functions. They are
therefore a **separate, previously uncounted** class of production drift, and any
production migration plan has to decide about them explicitly rather than inherit them.

Ordering note: `2224` is the head of the runbook's grant-boundary chain
`2224 → 2333`, and `2333` REVOKEs on `route_flow_contribution_consent`. A REVOKE against
an absent relation is an ERROR, so applying `2333` without `2224` aborts and lands
nothing. That dependency is real and is recorded in the runbook already.
