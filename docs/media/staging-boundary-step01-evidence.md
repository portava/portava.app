# Step 01 gate — evidence

Captured 2026-08-12 by `npm run audit:staging-boundary-grant` in
`artifacts/api-server`, read-only against production `ajrurzioarfkagpuxfnb`
through `ciProdReadOnlyAuditGuard`. Reproduce with:

```
PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production' \
KNOWN_PROD_PROJECT_REF='ajrurzioarfkagpuxfnb' \
npm run audit:staging-boundary-grant
```

**Gate result: ✅ satisfied.**

## Why this file exists

The two policies Step 01 drops are declared by **no migration** and appear
**nowhere in git history** — verified by `git log --all -S` on both names, which
returns only prose documents. They were applied out of band.
`docs/fact-layer-20260810/PROMOTION.md` records their command and role but not
their `qual` / `with_check`.

So the live catalog was the only surviving copy of what these policies say.
Dropping them without capturing the body first would mean the rollback does not
exist — discovered at the moment someone needs it. This is that capture.

## Precondition — the prefixes are unused

| Measure | Value |
|---|---|
| `post-media` objects under `memories/` | **0** |
| `post-media` objects under `stories/` | **0** |
| `stories` rows | 0 |
| `post-media` objects, total | 35 |

Measured, not trusted. The packet's figures were re-derived rather than carried
forward, because the bucket is not static.

## The two policy bodies, verbatim

### `post_media_storage_memories_stories_insert`

- cmd `INSERT` · permissive `PERMISSIVE` · roles `{authenticated}`
- `qual` — null
- `with_check`:

```
((bucket_id = 'post-media'::text)
 AND ((storage.foldername(name))[1] = ANY (ARRAY['memories'::text, 'stories'::text]))
 AND ((storage.foldername(name))[2] = (auth.uid())::text)
 AND (lower(storage.extension(name)) = ANY (ARRAY['jpg'::text, 'jpeg'::text,
      'png'::text, 'webp'::text, 'heic'::text, 'mp4'::text, 'mov'::text,
      'webm'::text, '3gp'::text])))
```

This is the armed grant. It confirms the packet's prose exactly: any
authenticated caller may write into the durable bucket under
`memories/{their-uid}/…` or `stories/{their-uid}/…`, for **nine** extensions.

Two things the prose did not say, now visible:

- **The extension list includes `mp4`, `mov`, `webm`, `3gp`.** The grant admits
  video, and video is never stripped on any path (V5). D6b rules that promotion
  strips container metadata — this grant is a way to put video into the durable
  bucket without ever passing through promotion.
- **It includes `heic`.** D6a rules that the decoder gets added; this grant is a
  path that bypasses the decoder question entirely by writing the original.

### `post_media_memories_stories_delete`

- cmd `DELETE` · permissive `PERMISSIVE` · roles `{authenticated}`
- `qual`:

```
((bucket_id = 'post-media'::text)
 AND ((storage.foldername(name))[1] = ANY (ARRAY['memories'::text, 'stories'::text]))
 AND ((storage.foldername(name))[2] = (auth.uid())::text))
```

- `with_check` — null

## The rollback

Verbatim re-CREATE, to be carried in the Step 01 migration's down section:

```sql
CREATE POLICY "post_media_storage_memories_stories_insert" ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (((bucket_id = 'post-media'::text) AND ((storage.foldername(name))[1] = ANY (ARRAY['memories'::text, 'stories'::text])) AND ((storage.foldername(name))[2] = (auth.uid())::text) AND (lower(storage.extension(name)) = ANY (ARRAY['jpg'::text, 'jpeg'::text, 'png'::text, 'webp'::text, 'heic'::text, 'mp4'::text, 'mov'::text, 'webm'::text, '3gp'::text]))));

CREATE POLICY "post_media_memories_stories_delete" ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (((bucket_id = 'post-media'::text) AND ((storage.foldername(name))[1] = ANY (ARRAY['memories'::text, 'stories'::text])) AND ((storage.foldername(name))[2] = (auth.uid())::text)));
```

## Operator runbook — the proof, and applying the drop

Ruling 2026-08-12: the red-proof is the **before/after production run**, and the
rollback DDL is validated **once**, as an operator one-shot against the CI
project. Neither becomes standing test machinery. The reasoning: options that
bake this into a suite would grant tests Management API DDL power **forever**,
to prove a one-time drift removal — durable machinery for a one-shot event.

All four steps are operator-executed through the sanctioned path.

### Step A — prove the grant is present (before)

```
cd artifacts/api-server
PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production' \
KNOWN_PROD_PROJECT_REF='ajrurzioarfkagpuxfnb' \
npm run audit:staging-boundary-grant
```

Expect **exit 0**, both bodies printed, both prefixes reporting 0 objects.
If it exits 1, stop — either a prefix is no longer empty, or a policy is
already gone. Do not apply.

### Step B — validate the rollback DDL, once, against the CI project

One-shot. Not a test, not repeated. Against the **CI** project, never
production.

1. Apply the captured re-CREATE (both statements from "The rollback" above) to
   the CI project.
2. Read back pg's own deparsed form:

```sql
select policyname, cmd, permissive, roles::text, qual, with_check
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
   and policyname in ('post_media_storage_memories_stories_insert',
                      'post_media_memories_stories_delete')
 order by policyname;
```

3. Diff `qual` and `with_check` against the production bodies recorded above.
   **They must match character for character.** A mismatch means the rollback
   would restore something subtly different from what was there — which is the
   whole failure this step exists to catch.
4. Drop both policies from the CI project again, leaving it as found:

```sql
DROP POLICY IF EXISTS "post_media_storage_memories_stories_insert" ON storage.objects;
DROP POLICY IF EXISTS "post_media_memories_stories_delete" ON storage.objects;
```

### Step C — apply the migration to production

Apply `src/migrations/20260815_close_memories_stories_grant.sql` through the
normal production migration path (`docs/production-migration-runbook.md`).

### Step D — prove the grant is gone (after)

Re-run the Step A command. Expect **exit 1**, reporting:

```
❌ policy post_media_storage_memories_stories_insert is NOT present live.
❌ policy post_media_memories_stories_delete is NOT present live.
```

That inversion — exit 0 with bodies before, exit 1 with both absent after — is
the red-proof. Its positive control is Step A itself: the same instrument, same
run, demonstrably able to see the policies when they exist. An absence assertion
that never showed it could detect presence is the vacuity the packet warns
about, and Step A is what rules it out.

Record both outputs against this document when done.

## Execution record — before-state plus rollback-proven

Operator-executed 2026-08-12 through the sanctioned path. **Step C (the
production DROP) is HELD and has not run.**

### Step A — before (read-only, production `ajrurzioarfkagpuxfnb`) — exit 0

| Measure | Value |
|---|---|
| `post-media` under `memories/` | **0** |
| `post-media` under `stories/` | **0** |
| `stories` rows | 0 |
| `post-media` objects, total | 35 |

Both policy bodies captured. **Gate satisfied.**

### Step B — rollback validation — PROVEN

Applied the captured re-CREATE to the CI project, deparsed, diffed against
production live: **identical, character-for-character on `qual` and `with_check`
for both policies.** CI copies dropped again; CI left clean.

Two findings from the run:

1. **The premise is confirmed.** No forward migration creates the grant. The
   only migration referencing either name is the DROP itself
   (`20260815_close_memories_stories_grant.sql`, which embeds the re-CREATE as
   its rollback). The grant is genuine undeclared production drift.

2. **Correction — the CI project was not clean.** It already held both policies
   from a prior proof-run, so a naive apply errored `already exists`. That is
   leftover state, **not a declaration**. It is also why a plain CI red-proof
   *looked* feasible earlier: the policies were present in CI for a reason
   unrelated to any migration.

   This corrects a statement made when the migration was written — that CI "has
   never had them." That was wrong as a factual claim about the project's state.
   The reasoning it supported is unaffected and still holds: because **no
   migration declares these policies**, a CI-based red-proof asserts nothing
   about production drift, and its result would depend on whatever residue a
   previous run left behind. Which is precisely what was found. The dirty CI
   state makes the argument for the before/after production proof *stronger*,
   not weaker.

### Step C — HELD

> **Superseded 2026-08-13:** the owner authorised the release and Step C was
> applied. See "Execution record — Step 01 executed end to end (2026-08-13)"
> below. The text that follows is the state as of 2026-08-12, kept as written.

The production DROP has **not** been applied. It is a live security-policy
removal that will begin rejecting direct video/HEIC inserts into the durable
bucket — an outward-facing behaviour change — and production writes are the
user's own explicit release. Awaiting their authorisation.

### Step D — pending

> **Superseded 2026-08-13:** executed, exit 1 as expected. Verbatim output in
> the 2026-08-13 execution record below.

Runs immediately after C. Expect **exit 1** naming both policies absent.

## What this evidence does not establish

- **Whether the DELETE policy backs a live user-facing delete.** The packet's
  D3B depends on that trace and it has not been done. Step 01 drops the DELETE
  alongside the INSERT because both are scoped to the same two unused prefixes
  and zero objects exist under them — so no live delete can be operating there.
  That reasoning does **not** extend to the owner-prefix policies, which D3B
  covers and Step 01 leaves alone.
- **Whether any of the 35 objects carries GPS.** Still unmeasured;
  `auditStorageExif` refuses production by design.

## Execution record — Step 01 executed end to end (2026-08-13)

Operator: the orchestrating session, through the sanctioned Management API
path, 2026-08-13 ~04:30Z, following the owner's authorisation of the
production release that the 2026-08-12 record was holding for. Steps A–D ran
tonight as one sequence. This section is the record the runbook above asks
for ("Record both outputs against this document when done").

### Step A — before-proof — exit 0

The runbook command, read-only against production `ajrurzioarfkagpuxfnb`
through `ciProdReadOnlyAuditGuard`. Result: **exit 0**, both policy bodies
present and printed, both prefixes reporting **0 objects**.

Recorded honestly: the raw capture (`/tmp/stepA.txt`) was lost to a workspace
container restart before this record could be committed. The result above is
the orchestrating session's report of the run, consistent with the
2026-08-12 capture earlier in this document (same instrument, same
parameters, same bodies). The Step D output below is the surviving raw
capture of the before/after pair — and Step A's positive-control role is
unaffected, because the 2026-08-12 exit-0 capture already demonstrates the
instrument detecting the policies when present.

### Step B — rollback validation — PROVEN, fresh apply

The captured re-CREATE (both statements from "The rollback" above) applied
fresh to the CI project `hwokxgbmezheskbzskfr` — clean this time, as the
2026-08-12 run left it. `pg_policies` deparse read back and diffed against
the production live bodies: **character-identical on `qual` and
`with_check` for both policies.** Both copies then dropped from CI, leaving
it clean.

### Step C — production DROP applied

`20260815_close_memories_stories_grant.sql` applied to production
`ajrurzioarfkagpuxfnb` through the sanctioned path. The apply returned `[]`
— no rows, no errors.

### Step D — after-proof — exit 1

The Step A command re-run immediately after C. **Exit 1.** Both policies
reported NOT present live, and a direct `pg_policies` count for the two
names returned **0**. Verbatim output (preserved from `/tmp/stepD.txt`):

```

> @workspace/api-server@0.0.0 audit:staging-boundary-grant
> node --env-file-if-exists=.env --import tsx/esm src/scripts/auditStagingBoundaryGrant.ts

.env not found. Continuing without it.
══════════════════════════════════════════════════════════════════════════
[ciProdReadOnlyAuditGuard] READ-ONLY AUDIT OF PRODUCTION — PERMITTED
══════════════════════════════════════════════════════════════════════════
  requested by  : PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production'
  resolved ref  : ajrurzioarfkagpuxfnb   (from SUPABASE_URL)
  declared prod : ajrurzioarfkagpuxfnb   (KNOWN_PROD_PROJECT_REF)
  CI markers    : none present — this mode is refused in CI

  This process is about to read PRODUCTION data. It is one of the
  audits permitted to do so, and it issues SELECTs only: no INSERT, no
  UPDATE, no DELETE, no auth user is created or deleted, no row is
  written. That is a property of these files, verified by reading
  them, and enforced by scripts/check-guard-coverage.mjs, which fails if
  any other file imports this front door.
  It is NOT a property of the credential: the Management API token in
  this environment can write. The mode constrains what this process
  does, not what the token could do.
══════════════════════════════════════════════════════════════════════════
══════════════════════════════════════════════════════════════════════════
STEP 01 — LIVE POLICY BODIES (the rollback)
══════════════════════════════════════════════════════════════════════════
❌ policy post_media_storage_memories_stories_insert is NOT present live. Either it was already dropped, or the name is wrong. Do not proceed until this is explained — a rollback cannot be written for a policy whose body was never captured.
❌ policy post_media_memories_stories_delete is NOT present live. Either it was already dropped, or the name is wrong. Do not proceed until this is explained — a rollback cannot be written for a policy whose body was never captured.

══════════════════════════════════════════════════════════════════════════
STEP 01 — PRECONDITION: the prefixes must be unused
══════════════════════════════════════════════════════════════════════════
  ✅ post-media 'memories/*' — 0 objects
  ✅ post-media 'stories/*' — 0 objects

  context: stories rows = 0
  context: post-media objects total = 35

══════════════════════════════════════════════════════════════════════════
STEP 01 GATE: ❌ NOT SATISFIED — do not apply the migration.
```

The inversion the runbook demands — exit 0 with both bodies before, exit 1
with both absent after — is complete. **Step 01 is closed**: the undeclared
grant is gone from production, and the rollback carried in
`20260815_close_memories_stories_grant.sql` is proven to restore it
character-for-character if ever needed.
