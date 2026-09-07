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

### The gap, stated rather than worked around

**`promoteLiveScope` and `withdrawLiveScope` have no caller.** Grepped across
the tree: no route, no CLI script, and no scheduler invokes either. Only
`runLiveScopeExpiryPass` is wired (into `intelPromotionScheduler`). So after
`2430` is applied there is still no operator-facing surface, and a promotion
would have to be made by calling the SQL function directly with the service key.

That is a genuine missing piece and it is deliberately **not** invented here —
whether the surface should be an admin route, a CLI script, or a reviewed SQL
runbook entry is an ownership question, and `routes/admin.ts` belongs to another
lane. It is recorded so it is not mistaken for finished work.

## Step 4 — withdraw, when the scope should stop being live

`withdrawLiveScope()` → `system_withdraw_intel_live_scope`. It is idempotent and
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
- Expired and withdrawn rows are *not promoted* to the reader. A row's presence
  is not sufficient; its state is what counts.
