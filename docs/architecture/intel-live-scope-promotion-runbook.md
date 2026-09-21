# Promoting a scope to Live — the operator workflow

**Measured on production (`ajrurzioarfkagpuxfnb`) 2026-09-07.** Lane D deliverable.
`intel_live_promoted_scopes` is the per-scope allowlist that
`lib/liveClaimRead.ts` consults before **any** live claim is served. It was
recorded by `scripts/checkWriterlessReads.ts` as a reader with no writer. It is
not a bug: promotion is a human decision by design, stated in four independent
places (`2179`'s header, `lib/intelLiveScope.ts`, `lib/intelCalibrationScheduler.ts`,
and `docs/architecture/intel-spine-liveness.md`). This document is the workflow
that decision goes through.

---

## Read this first: promotion is not currently the binding constraint

`2430`'s header says the live-claim path is "switched on and starved at this one
table". That is true and it is incomplete. Measured today in production:

| | rows |
|---|---|
| `geo_zones` | **0** |
| `intel_observations` | **0** |
| `intel_claims` | **0** |
| `intel_live_promoted_scopes` | **0** |

Flags `intel_limited_live`, `intel_live_label_crowd` and
`intel_claim_projection_crowd` are all **TRUE**.

So the spine is empty at *every* stage, not just at the allowlist. **Promoting a
scope today would change nothing**, because there are no claims for a promoted
scope to serve and no zones for a scope key to name. `readLiveClaims` returns
`[]` for two independent reasons, and removing one of them leaves the other.

Sequence that actually unblocks Live, in order:

1. `geo_zones` gets rows (the zone package — a scope key is `zone_id` + `claim_type`,
   so with no zones there is no well-formed scope to promote).
2. Observations flow, and claims are derived from them.
3. The density gate has something to assess.
4. **Then** a promotion decision is meaningful.

Treat everything below as the procedure for step 4, not as a way to skip 1–3.

---

## Prerequisite: `2430` is not applied to production

`2430_intel_live_scope_promotion_writer.sql` creates the three functions this
workflow calls, adds the provenance/expiry columns, and seeds
`intel_live_scope_promotion_enabled`. Measured: that flag row **does not exist**
in production, and `intel_live_promoted_scopes` carries only its original six
columns (`scope_key, zone_id, claim_type, promoted_at, promoted_by, note`).

Until `2430` is applied, the only promotion path is `2179`'s original one — a
hand-written `INSERT`, which carries no evidence, no review horizon and no way
to withdraw except `DELETE`, destroying the audit trail. See
`migration-disposition-ledger.md`; `2430` is `ready_for_manual_apply`.

The operator surface below (§"The operator surface") does **not** change this.
On a pre-`2430` database — production and portava-ci today, re-measured
2026-09-07 — every one of its routes answers `503 server_not_configured`
naming `2430`, never an empty success. That is deliberate: a surface that
showed rows without expiry/withdrawal, or wrote through a function that does
not exist, would be lying about what is live.

---

## Step 1 — assemble the evidence

```
cd artifacts/api-server && npm run report:intel-funnel
```

`scripts/reportIntelFunnel.ts` tallies the funnel and calls
`assessDensityGate(funnel, { qualifyingWeeklyObservations })`.

**Expect `certifiable: false`, and do not read that as "the gate said no".** It
is `false` *by construction* while two §26 inputs — `crowdCalibrationAccuracy`
and `expiryCorrectness` — are uninstrumented. The assessment is an honest upper
bound, not a verdict. A promoter is therefore always overriding a
non-certifiable assessment, and the honest question is not "did it certify" but
"is the density evidence strong enough that I will sign for this scope". Record
that reasoning in `evidence` at promotion time (step 3) so the answer to "why is
this scope live?" survives the person who decided it.

## Step 2 — decide, as a human

Nothing automates this and nothing should. `lib/intelCalibrationScheduler.ts`
states it in its own header: *"It writes nothing and promotes nothing —
promotion stays a human decision."* `lib/intelPromotionScheduler.ts` runs only
the **expiry** sweep; it never promotes.

## Step 3 — promote

Once `2430` is applied, the canonical write path is
`promoteLiveScope()` in `lib/intelLiveScopePromotion.ts`, which calls the
`SECURITY DEFINER`, service-role-only `system_promote_intel_live_scope`. It is
idempotent: re-promoting an existing scope renews it rather than duplicating it.

Supply, per promotion:

- `zone_id` + `claim_type` (together the scope key)
- `expires_at` — the **review horizon**. The read path treats an expired row as
  not promoted, so this is a real safety property, not metadata. Do not leave it
  NULL; NULL exists only so legacy hand-inserted rows stay valid.
- `evidence` — the density-gate assessment from step 1, plus the reasoning from
  step 2.

### The operator surface (added 2026-09-07)

Until this date `promoteLiveScope` and `withdrawLiveScope` had **no caller** —
no route, no CLI, no scheduler; only `runLiveScopeExpiryPass` was wired. The
caller now exists: four admin routes at the bottom of `routes/admin.ts`, all
going **through the library** (no route writes `intel_live_promoted_scopes`
itself; the fake in the test throws if one tries).

| | route | body / query |
|---|---|---|
| list | `GET  /admin/intel/live-scopes` | active by default; `?all=1` adds withdrawn and expired rows with their `state` |
| inspect | `GET  /admin/intel/live-scopes/:scopeKey` | `scopeKey` = `zone_id\|claim_type`, bar encoded as `%7C`; returns every column incl. `evidence`, `promoted_by`, `withdrawn_*` |
| promote | `POST /admin/intel/live-scopes/promote` | `{ zoneId: string\|null, claimType, expiresAt: ISO-8601, evidence: { assessment: object, reasoning: string }, note? }` |
| withdraw | `POST /admin/intel/live-scopes/withdraw` | `{ zoneId, claimType, reason }` |

What the surface enforces, in the order it checks them (every step is
fail-closed and every step is pinned by `src/test/intelLiveScopeOps.test.ts`):

1. **Admin only** — `requireAdmin`, the same guard as every other route in
   the file. A non-admin is 403 before any flag is read.
2. **`intel_live_scope_admin_surface_enabled`** (seeded FALSE by `2570`) must
   read TRUE through `isFlagEnabled`. Absent, false or unreadable → 404
   `feature_disabled`, nothing else read. This is a second flag, not `2430`'s,
   because `2430` is unapplied where the seed must apply, and because closing
   the HTTP surface must not stop the expiry sweep (and vice versa); `2570`'s
   header states the reasoning in full.
3. **Writes only: `intel_live_scope_promotion_enabled`** (`2430`'s writer
   flag) must read TRUE. A **missing row** — production today — is 503
   naming `2430`; a FALSE row is 404 naming the flag. A write needs both
   flags ON, in series.
4. **Provenance is required by the request schema.** `expiresAt` and
   `evidence.assessment` + `evidence.reasoning` are not optional; a body
   without them is 400 before the library is called. `zoneId` must be said,
   even as `null`. The row's `promoted_by` / `withdrawn_by` is the admin's id;
   `evidence` and `reason` are stored verbatim. The row is the audit trail
   (there is no admin-action table that fits a scope, and none was invented).
5. **Idempotent at the route level**, because `2430`'s functions are:
   re-promote → `already_active` (one row, no write); later horizon →
   `renewed`; withdraw twice → `withdrawn` then `already_withdrawn`, row kept;
   withdraw then promote → `repromoted` in place. A scope never promoted is
   404 on withdraw.
6. **Honest on a pre-`2430` database.** Function missing (42883 / PGRST202)
   or columns missing (42703) → 503 naming `2430`. Any other resolved
   database error → 500. There is no path that reports an empty success.

What the surface does **not** do: decide. `certifiable` is `false` by
construction (step 1), so every promoter is overriding a non-certifiable
assessment; the surface records that override — who, on what, why, until
when — and never makes it. Nothing here runs without an admin's request.

To use it on production, in order: apply `2430`; apply `2570`; enable
`intel_live_scope_admin_surface_enabled`; enable
`intel_live_scope_promotion_enabled`; then step 1 → 2 → 3. And re-read the
top of this document first: with `geo_zones`, `intel_observations` and
`intel_claims` all at 0 rows, a promotion made through this surface would
still change nothing a user sees.

## Step 4 — withdraw, when the scope should stop being live

`withdrawLiveScope()` → `system_withdraw_intel_live_scope`, reached through
`POST /admin/intel/live-scopes/withdraw` with a `reason`. It is idempotent and
it **keeps the row**, setting `withdrawn_at` / `withdrawn_by` /
`withdrawn_reason`. The read path treats a withdrawn row as not promoted.

Do not `DELETE` a promoted row. The allowlist is also the audit trail of what
was ever live; a delete erases the record that a scope was served.

## Step 5 — expiry runs itself

`runLiveScopeExpiryPass` is called by `lib/intelPromotionScheduler.ts` on its
own tick and marks rows past `expires_at` as withdrawn. It never promotes and
never renews. A scope that matters past its horizon must be **re-promoted** by a
human going through steps 1–3 again — which is the point of having a horizon.

---

## Fail-closed properties worth not breaking

- Every function is `SECURITY DEFINER` with a pinned `search_path`, `EXECUTE`
  revoked from `PUBLIC`/`anon`/`authenticated` and granted to `service_role`
  only — the posture `2174` set for `system_promote_admissible_intel_claims`.
- The whole TS path is gated on `intel_live_scope_promotion_enabled`, checked
  fail-closed. An unreadable flag means no promotion, not a default promotion.
- The HTTP surface is gated again on `intel_live_scope_admin_surface_enabled`
  (`2570`), and refuses a write unless both flags are ON. `2570`'s
  postcondition refuses to leave that flag TRUE on a database without `2430`
  (rehearsed on portava-ci 2026-09-07 inside a rolled-back transaction: the
  RAISE fired).
- Expired and withdrawn rows are *not promoted* to the reader. A row's presence
  is not sufficient; its state is what counts.
