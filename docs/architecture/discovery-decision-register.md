# Discovery decision register

Owner authorisation, 2026-09-28. These instructions come from the owner:

- The 2026-08-15 ranker implementation hold is lifted. The held designs may be built and tested behind flags seeded FALSE.
- Routine architecture and product decisions are to be made from the specifications, recorded here, and implemented.
- Four kinds of decision are NOT delegated:
  - real user consent;
  - financial obligations (rates, payouts, commercial terms);
  - data-retention policy;
  - production activation (production migrations, deploys, flags turned on in production).

  For each of those this register carries an exact recommended action and a specific approval request. Nothing is chosen silently.

Each lane appends its own `## <lane> — <topic>` section and never edits another lane's section. An entry has:

- **Decision id:** `D-<lane>-<n>`.
- **The question:** quoted from the census section or spec that raised it, with a citation.
- **Options considered:** each with its consequence.
- **Decision and rationale:** with spec citations.
- **Reversibility:** how to undo it, and whether anything is lost.
- **Where it is implemented:** file references, plus the tests that pin it.

An entry that needs owner approval is marked **APPROVAL REQUIRED**. It gives the recommended action with exact values, the consequence of approving, the consequence of declining, and the recovery path.

## W10-D — rollout, portava-ci apply and the owner approval pack

*Lane W10-D, 2026-09-28, branch `disc-w10-d-rollout` from `debd5ad4f`. Census section §83. The documents: `docs/ops/discovery-portava-ci-apply-plan.md`, `docs/ops/discovery-production-rollout.md`, `docs/ops/discovery-owner-approval-request.md`.*

### D-W10D-1 — Q66-3: a pre-merge `portava-ci` apply plus a green `schema drift` run is the CI rehearsal

- **The question:** census §66.9 Q66-3, whether the owner requires the `portava-ci` rehearsal before merge, and what counts as it. `12` names the class *"CI rehearsal"* (`docs/specs/discovery-v1/12_Claude_Code_Implementation.md:189#- CI rehearsal`); `10` §7 says *"rehearse on `portava-ci`"* and *"production rollout only after CI rehearsal"* (`docs/specs/discovery-v1/10_Database_Architecture.md:98#- production rollout only after CI rehearsal.`).
- **Options considered:**
  - (a) Only `main`'s `schema-drift` apply-and-certify counts. DC-26 then cannot move before merge.
  - (b) A pre-merge apply by the repository's applier, followed by the PR's `schema drift` job green on `portava-ci` for the same tree, counts.
  - (c) The local harness rehearsal counts. Rejected: `10` §7 names `portava-ci`, and §54.2 already said the harness is not it.
- **Decision and rationale:** (b). The workflow's `schema-drift` job on `portava-ci` IS the rehearsal:
  - it plans against the real ledger (`db:apply-migrations:dry-run`);
  - it audits every claim against the live catalogue (`audit:schema`);
  - on `main`, it applies and certifies with the same applier.
  A pre-merge apply by that applier (owner-authorised 2026-09-28), followed by the job green on the PR head, exercises the same code against the same database. The rehearsal record is the apply's output plus that run's id.
- **Reversibility:** a documentation-level ruling. Reverting it returns DC-26 to (a); nothing is lost.
- **Where it is implemented:** apply plan §6; census §83.2. No code.

### D-W10D-2 — a TRUE flag found by a seed file stops the apply; it is never overwritten

- **The question:** how the owner's "preserving existing data and flag values" applies to the 14 flag-seed files in the pending set.
- **Options considered:**
  - (a) Proceed and let the seed's postcondition refuse: the apply stops at that file, with the TRUE value kept.
  - (b) Pre-emptively set the flag FALSE: rejected, because that changes a value.
  - (c) Skip the file: rejected, because the applier has no skip, and a skip would leave the ledger short of the tree.
- **Decision and rationale:** (a), plus the pre-flight read (apply plan §2.1 (b)) so that it is known before the apply. Rehearsed on the harness: the negative control stopped at 3351 with the TRUE value intact and no ledger row (apply plan §4.2).
- **Reversibility:** the operator decides per flag with the owner. Nothing is lost.
- **Where it is implemented:** apply plan §2.1, §3 (the flag rule), §4.2.

### D-W10D-3 — flag-seed recovery never deletes a pre-existing row

- **The question:** each flag-seed rollback deletes its FALSE row. Measured on the harness: 3351's rollback deleted a row that existed before 3351 ran (apply plan §4.4).
- **Decision:** for any seed whose row the pre-flight read found pre-existing, recovery deletes the ledger row only. The rollback file is not run for it.
- **Reversibility:** procedural. **Where:** apply plan §3.

### D-W10D-4 — certify is run with `--files`

- **The question:** `certify:migrations` scopes itself by the run id in the ledger notes, and a terminal apply has none, so it would certify nothing.
- **Decision:** the operator passes the 40 filenames with `--files` (apply plan step 6).
- **Reversibility:** procedural.

### D-W10D-5 — production order: migrations → API → client → flags; the creator ledger waits on C-11; 2893 last or never

- **The question:** the deployment order for Discovery in production.
- **Decision:**
  - D1 migrations (P0, P1; P2 only after C-11; P3 only if E-4 is approved), then D2 API, D3 client, D4 flags in the order of the rollout plan §3.1.
  - The rationale per step is in the rollout plan §2. The old API does not exercise any object D1 creates, and the new API names them.
- **Reversibility:** each step's recovery is the rollout plan §7. **Where:** `docs/ops/discovery-production-rollout.md`.

### APPROVAL REQUIRED — W10D-A (production activation), W10D-B (creator economy), W10D-C (consent and retention), W10D-D (GitHub setting)

Each request is stated in full in `docs/ops/discovery-owner-approval-request.md`: the exact action and values, the consequence of approving and of declining, the rows it unblocks, and the recovery. In brief:

- **W10D-A1:** apply batches P0 and P1 to production after the §0 gates.
  - Approve: the schema lands; no response changes until A3.
  - Decline: DEPLOY rows stay.
  - Recovery: per-file rollbacks, or the restore point.
- **W10D-A2 (A-2):** an explicit yes to 3376 while `discovery_serve_log_enabled` stays TRUE.
  - Approve: per-request rows, including anonymous serves, from the API deploy on.
  - Decline: 3376 is withheld; DV-06 and DV-40 stay W.
  - Recovery: its rollback, which refuses once rows exist.
- **W10D-A3:** deploy the API, then ship the client.
  - Recovery: redeploy the previous build.
- **W10D-A4:** flags. Recommended TRUE after A3: `discovery_candidate_projection_enabled`, `discovery_buddy_launch_gate_enabled`, `discovery_search_protected_zones_enabled`. `discovery_live_rank_enabled` at rollout step A4. Every held-design flag stays FALSE.
  - Recovery: set the flag FALSE.
- **W10D-A5 (E-2):** Phase F gates 1 and 2, as the `DISCOVERY_ENGINE_MODE` sequence shadow 5 % → compare → partial 5/25/50 % → pde all.
  - Recovery: `disable_discovery_pde` TRUE and `enabled=false`.
- **W10D-A6 (E-4):** 2893 last, or never.
  - Recovery: its REVERSAL block, which is not free.
- **W10D-A7 (A-5):** ratify that the stop values in `STOP_CONDITION_RULINGS` at the deployed commit are the ones in force.
- **W10D-B0 (C-11):** erasure retention.
  - Recommended: retain, anonymised, for a statutory period set with legal (`09` §6, §11; `04` §11).
  - Either answer is buildable before any creator row exists.
- **W10D-B1–B11 (C-1 … C-10, C-12):** each with its spec-grounded default where one exists, and "no spec value; you choose" where none does.
- **W10D-C1–C8 (B-1 … B-5, and retention):**
  - dwell (recommended: decline for now);
  - Invisible and name search (keep hiding);
  - trend disclosure (≥ 15 travellers, no neighbourhood names);
  - personal projections (decline the personal forms);
  - Trails and non-public content (no);
  - snapshot and `raw_recent` retention (no spec value; you choose).
- **W10D-D1 (A-4):** require the three verdict checks on `main` through a ruleset.
  - Recovery: disable the ruleset.
