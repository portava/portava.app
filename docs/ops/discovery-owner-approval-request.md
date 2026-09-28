# Discovery — the owner approval request

*Consolidated 2026-09-28 by lane W11-P (`disc-w11-approvals`, at integration head `3fd11f858`). Census section: census-discovery §96. Register section: `## W11-P — the owner approval request, consolidated` in `docs/architecture/discovery-decision-register.md`. This page replaces lane W10-D's pack (census §83), which predated every lane after §83. §2 maps each earlier request id (`W10D-…`) and every later register entry to the actions below.*

**Nothing in this page has been done.** No migration of this programme is applied to `portava-ci` or to production. Nothing is deployed, and no Discovery flag has been turned on. Every verdict below rests on controlled evidence: unit suites and a local PostgreSQL 16 harness. None of it is production evidence.

**How to answer.** Each action gives the exact thing to approve. Reply per action number: "approve", "decline", or a value. The four kinds of decision the programme may not make itself are marked:
- **consent** — real user consent or a new use of someone's data;
- **financial** — rates, payouts, commercial terms or spend;
- **retention** — how long data is kept;
- **production activation** — applying to production, deploying, or turning a flag on there.

For those marked consent, financial or retention, this page asks a question and gives a recommended answer. It does not decide them.

---

## 1. Summary

**The census at `3fd11f858`, corrected at the integration head for §94.10** (DV-83 is held at W after independent verification and still needs code in lane W11-X2, so it is in neither bucket below). Counted with `CENSUS_INTEGRITY_DUMP=ALL pnpm run check:census-integrity`, and each row's latest statement read:

| | rows |
|---|---:|
| graded | 188 |
| **C** (implementation-level, on controlled evidence) | **100** |
| open (86 W + 2 N; DV-83 still needs code) | 88 |
| … of which wait **only on production**: activation steps below, then a production read or production evidence | **51** |
| … of which wait on an **owner policy answer** (consent, money, retention) | **36** |

How the 87 open rows split:
- **By marker.** 55 carry only `IMPLEMENTATION-COMPLETE; awaits:`. 19 carry both markers. 11 W and 2 N carry only `AWAITS OWNER APPROVAL:`.
- **The 32 with `AWAITS OWNER APPROVAL:`.** 24 wait on a consent, money or retention answer. 8 wait on a production-activation approval: B04, C32, DC-24, DC-27, DV-40, DV-52, DV-70 and DV-75.
- **The 55 with only the implementation marker.** 12 of them reach production only through a step this page gates on a policy answer:
  - the trend scheduler needs a retention answer: DC-06, DC-17, DC-21, DV-28, DV-29, DV-30, DV-31 and DV-33;
  - a data-use answer: DV-12 and DC-11;
  - a spend answer: A14;
  - the creator ledger: DV-74.
- **So 36 open rows need a policy answer, and 51 need only production.** Of those 51:
  - 14 can be graded `C` on a production read-back once their actions are done, with no user traffic needed;
  - 2 (C32 and DC-24) need one code commit after 14 days of production;
  - the other 35 need production rows produced by traffic.

§7 lists every open row with the actions it needs.

**The actions, in the order they must happen.** Step 0 is not a decision. Items marked *Q* are questions with a recommended answer.

| # | one line | category | rows it unblocks (count) |
|---|---|---|---|
| **0** | Give the next session `portava-ci` credentials; it applies the 73 pending files and certifies | none: already authorised | DC-26, DC-18, DC-27, DV-70 (4) |
| 1 | Require the three verdict checks on `main` (ruleset) | GitHub setting | DV-75, DC-27 (2) |
| 2 | Include 3376 + 3491 (per-request serve log) in the production batch | production activation | DV-06, DV-40, DC-01 (3) |
| 3 | Apply the Discovery schema to production: P0 + P1 at this tree (59 files), after a restore point | production activation | 59 |
| 4 | Deploy the API, then ship the client, and name the oldest supported build | production activation | 27 |
| 5 | Turn on the twelve non-ranking flags, one at a time | production activation | 16 |
| 6 | Arm the seven stop conditions | production activation | DC-27, DC-32, DV-82 (3) |
| 7 | Phase F gate 1: PDE in shadow | production activation | 5 |
| 8 | Phase F gate 2: PDE serves `for_you` and Cache A; live rank at step M4 | production activation | 12 |
| 9 | *Q* May ranking read other accounts' saves, ages and follows for anti-abuse? | consent | DV-12, DC-11 (2) |
| 10 | Turn on the ranker designs and pipeline stages, one flag at a time | production activation | 14 |
| 11 | *Q* Three retention values: `raw_recent` rows, trend snapshots, Trail stores | retention | 13 |
| 12 | *Q* May the trend API publish, under the k ≥ 15 floor and protected zones? | consent (disclosure) | DC-21, DV-29, DV-33 (3) |
| 13 | Turn on Trending v2, its stored post-after-visit leg and the Trail co-occurrence projection | production activation | 12 |
| 14 | Turn on the Trails ranking flags | production activation | 4 |
| 15 | *Q* Collect dwell time on the place sheet? | consent | DV-41, DV-78 (2) |
| 16 | *Q* People-derived data: (a) circle mates' Memories, (b) circles, crews and visits for trends, (c) itineraries | consent | DC-12, DV-34, DV-72 (3) |
| 17 | *Q* May a Trail serve non-public content? | consent | none (DC-20 does not wait on it) |
| 18 | *Q* Tagging definitions, "Nobody", and Invisible in name search | consent | none |
| 19 | A bounded debug-sampler window | production activation | DV-52 (1) |
| 20 | Retire the old `for_you` path (one commit) | production activation | C32, DC-24 (2) |
| 21 | 2893 in production: last, or never | production activation | DV-44 (1) |
| 22 | *Q* Money: C-11 erasure, B1–B11 creator rules, the Buddy payment leg, the Layover routing spend | financial (C-11 is retention too) | 19 |
| 23 | Activate Layover mode | production activation | A14 (1) |
| 24 | Apply the creator ledger (P2); attribution stays off until a rule is published | production activation | 15 |
| 25 | *Q* Does G57 cover ß, æ and œ? | product definition (not one of the four) | none (B01 stays C on "no") |

**Taking every recommendation, the reply is:**
- step 0 as described; 1–8 approve;
- 9 no; 10 approve without 2289; 11 your three values; 12 yes; 13–14 approve;
- 15 not yet; 16 (a) no, (b) no, (c) no; 17 no; 18 as recommended;
- 19–21 approve; 22 retain-anonymised with your period, and B1–B11 as recommended; 23 and 24 after 22; 25 no.

---

## 2. Where each earlier request went

| earlier id (register) | action here |
|---|---|
| W10D-A1 (P0 + P1) | 3 |
| W10D-A2 (3376); AR-W11X2-2 (3491) | 2 |
| W10D-A3 | 4 |
| W10D-A4 a / b / c | 5b / 5c / 5a |
| W10D-A4 d / e / f | 8 step 4 / 5l / 10.15 |
| W10D-A5 — Phase F gates 1 and 2 (E-2); D-W10R4-2 | 7, 8 |
| W10D-A6; D-W10-O-14 | 21 |
| W10D-A7 | superseded by D-W10-O-1 and D-W10-O-3 → 6 |
| W10D-B0 | 22(a), 24 |
| W10D-B1 … B11 | 22(b) |
| W10D-C1, C2; D-W10-O-9 | 15 (C2 is decided by D-W10-O-8) |
| W10D-C3 | 18(c) |
| W10D-C4 | 12 (the neighbourhood half is decided, D-W10-R1-10) |
| W10D-C5 | 16(c) |
| W10D-C6; D-W10T-12 | 17 |
| W10D-C7; D-W10-R1-12 | 11(b) |
| W10D-C8 | 11(a) |
| W10D-D1 | 1 |
| AR-W10-S1-1 | 3 (3366, 3460), 5a |
| D-W10-R1-17 | 3 (3435, 3475–3477), 13 |
| D-W10-R2-A1; D-W10-I-A1 | 3 (3450–3454), 9 (its step 4), 10 |
| D-W10-R3-4 | 16(a) |
| D-W10-R3-13 | 3 (3480–3484), 5j, 10 |
| D-W10R4-7 | 20 |
| D-W10S2-9; D-W10S2-11 | 18(a); 18(b) |
| D-W10S2-12 / 13 / 14 / 15 | 5e / 22(d) + 23 / 5f / 5g |
| D-W10S2-16 / 17 / 18 / 19 | 5k / 3 + 5h / 5i / 5l |
| D-W10-O-3 | 6 |
| D-W10-O-13 | 5b |
| D-W10-O-15 | 3 (3420), 4 |
| D-W10T-13; D-W10T-14 | 3 (3485–3488), 14; 11(c) |
| AR-W11A-1 / 2 / 3 | 22(c) / 16(b) / 19 |
| D-W11X3-A1 | 3 (3495–3497), 13 steps 4–5 |
| D-W11X1-A1 | 3 (3450, 3500), 10.11–10.12, 13 step 6 |
| AR-W11X2-1 | 3 (3490), 5d |
| census §66.9 Q4 (B01) | 25 |

---

## 3. Step 0 — the `portava-ci` apply (not a decision)

**It is already authorised** (owner, 2026-09-28: *"after checking dependencies, preserving existing data and flag values, and verifying recovery and postconditions. Do not modify the intentional 2481 ledger entry."*). It is blocked only because this session has no credentials for `portava-ci` (`hwokxgbmezheskbzskfr`).

**What you do (one of the two):**
1. **Preferred.** In the cloud environment's settings (the environment menu in the session's title bar, then Edit), add under API credentials, or as environment variables:
   - `SUPABASE_URL` = `https://hwokxgbmezheskbzskfr.supabase.co`;
   - `SUPABASE_PROJECT_TOKEN` = a Supabase Management API token that can reach `portava-ci` only. It must not reach production (`ajrurzioarfkagpuxfnb`).

   Then start a new session. Do not paste the token into a chat.
2. **Or** connect the Supabase connector at <https://claude.ai/customize/connectors>, scoped to `portava-ci`, and start a new session.
   - The connector can run the read-only pre-flight and post-apply SQL.
   - The applier itself needs the token of option 1. Without it, the session would have to send each file's `buildApplyStatement` output (the body plus its ledger row, one transaction, `applied_by='manual'`) through the connector, the way production is applied (rollout plan §1.1). That is the second choice.

**What the next session runs.** The full procedure, with expected outputs, is `docs/ops/discovery-portava-ci-apply-plan.md` §2. The current set is its §8.
1. **Re-plan.** The applier's own `planApply`, at the tree to be merged, must list the **73** files of apply plan §8.1 in that order, and nothing else. At this tree that is the 40 of §87's certified set, plus 33 added since: 3436, 3450–3456, 3460, 3465–3470, 3475–3477, 3480–3488, 3490–3491, 3495–3497 and 3500.
2. **Rehearse on the local harness first.** The 33 new files have run in the standard chain, but not through the applier from the modelled `portava-ci` baseline (apply plan §8.3).
3. **Pre-flight reads** (apply plan §2.1 plus §8.2): the 53 flags the set seeds (15 from the 40, 38 from the 33) absent or FALSE, the data preconditions, and the 2481 and 3350 ledger rows recorded verbatim.
4. **Dry run:** `pnpm --filter @workspace/scripts run db:apply-migrations:dry-run`, expected `Would apply 73`.
5. **Apply:** `pnpm --filter @workspace/scripts run db:apply-migrations`. Expected: 73 `applied + recorded` lines and 51 `postconditions verified` lines. Run it again: `NOTHING TO DO`.
6. **Certify and audit:** `cd artifacts/api-server && pnpm run certify:migrations -- --files <the 73>`, then `pnpm run audit:schema`.
7. **The live DB workflow.** Re-run `CI (live DB)` (`.github/workflows/live-db.yml`) on the PR head. `schema drift` and `live DB · verdict (cancelled or skipped is not a pass)` must both be green. That run is the rehearsal record (D-W10D-1).
8. **Merge the PR immediately after.** Until the merge, `main`'s own `schema drift` fails certify stage 1 on the 73 orphaned ledger rows (apply plan §5.4).

**The 2481 ledger entry is not touched.** The applier writes a ledger row only for the file it applies. The pre-flight and post-apply reads compare 2481's row byte for byte. `--apply-unproven` is never used.

- **Unblocks:**
  - DC-26 becomes `C`-gradable on the green `schema drift` run itself;
  - DC-18 still needs an operator read of production's checksums (after action 3);
  - DV-70 still needs the production apply and a live read;
  - DC-27 still needs its rollout record.
- **Stop:** any `REFUSED`, any drift line, any file failing its postcondition, or 2481's row changing. The applier stops at the failing file, and the files before it stay applied and recorded.
- **Recovery:** that file's rollback (apply plan §3 and §8.1), newest first. Since §97 (W11-S) 3440 and 3441 have rollback files too, their footers as files; run 3441's before 3415's (apply plan §8.5).

---

## 4. Production activation — actions 1–8, 10, 13, 14, 19–21, 23, 24

Every production step waits for the gates of `docs/ops/discovery-production-rollout.md` §0:
- a green `portava-ci` rehearsal (step 0);
- the PR merged;
- a confirmed production point-in-time restore point.

Every flag SQL below runs on production (`ajrurzioarfkagpuxfnb`). Flag reads are cached for 30 s, so a change takes effect within 30 s.

### Action 1 — require the three verdict checks on `main` · GitHub setting

- **Approve:** GitHub → Settings → Rules → Rulesets → New branch ruleset:
  - target `main`, enforcement active;
  - "Require status checks to pass", with exactly these three check names:
    - `CI · verdict (skipped or cancelled is not a pass)`
    - `live DB · verdict (cancelled or skipped is not a pass)`
    - `unwired · verdict (skipped or cancelled is not a pass)`
- **Prerequisite:** set it after the PR merges. `main`'s live-DB verdict is red between a pre-merge `portava-ci` apply and the merge (apply plan §5.4).
- **Unblocks:** DV-75 (`C`-gradable on a read of `main`'s rulesets); DC-27's "verdict checks" row of the rollout record.
- **Monitoring and stop:** none needed. If a red verdict blocks a legitimate merge, read the verdict. Do not disable the rule to merge.
- **Recovery:** disable the ruleset.
- **If approved:** no merge to `main` while any verdict is red, skipped or cancelled.
- **If declined:** the verdicts stay advisory, and DV-75 stays W.
- **Recommendation:** approve, after the merge.

### Action 2 — the per-request serve log: 3376 and 3491 in the batch · production activation

- **Approve:** apply `3376_discovery_recommendations_per_request.sql` and, after it in byte order, `3491_discovery_recommendations_output_kinds_serve_point.sql`, both inside action 3's batch. Keep `discovery_serve_log_enabled` TRUE, as it already is (snapshot 2026-09-22).
- **What that means:** from the API deploy (action 4) on, every served Discovery request writes one `recommendations` row, anonymous serves included.
  - A row holds item ids, counts, the serve point and a hash of coarse context. It holds no coordinates, IP, user agent or query text.
  - Rows are labelled `raw_recent`. Nothing sweeps them until question 11(a) is answered.
- **Prerequisite:** action 3's gates. 3491 needs 3376 (register AR-W11X2-2).
- **Unblocks:** DV-40; DV-06, whose retention leg also needs 11(a); and DC-01, with action 10's `discovery_output_kinds_enabled`. All three then need production rows.
- **Monitoring:** `SELECT serve_point, viewer_class, count(*), sum(served_count) FROM public.recommendations WHERE served_at >= now() - interval '1 hour' GROUP BY 1, 2;`. The stop condition `recommendation_logging_gap` measures the writer.
- **Stop:** a logging gap above 0.10 (action 6's value), or any client-role read of the table.
- **Recovery:**
  - the rollbacks `db/rollback/2026-09-28-3491-discovery-recommendations-output-kinds-serve-point-rollback.sql`, then `db/rollback/2026-09-27-3376-discovery-recommendations-per-request-rollback.sql`;
  - both refuse once rows exist (3491's on any serve-point-13 row), because those rows are the only record of anonymous serves. Deleting them is question 11(a);
  - to stop writing without dropping anything: `UPDATE public.feature_flags SET enabled = false WHERE flag = 'discovery_serve_log_enabled';`. That also stops the existing `rank_events` serve log, so it is a last resort.
- **If approved:** the per-request denominator exists, and anonymous serves are counted for the first time.
- **If declined:** both files are withheld from the batch. The new API's writer fails closed and logs, and DV-06, DV-40 and DC-01 stay W.
- **Recommendation:** approve (W10D-A2, AR-W11X2-2).

### Action 3 — apply the Discovery schema to production · production activation

- **Approve:** take a point-in-time restore point, record its timestamp, then apply these files in this order.
  - Each file goes through the applier's own functions: `classifyMigration`, `checksumOf`, and `buildApplyStatement` with `appliedBy: 'manual'`.
  - It is sent as one transaction together with its ledger row, with its PRE and POST reads (rollout plan §1.1).
- **P0** (rollout plan §1.3): `2289`, `2297`*, `2360`, `2850`, `2892`, `2894`*, `2995`*. The files marked * are applied only if the first ledger read shows them unapplied.
- **P1 at this tree** (rollout plan §1.4 and §9), in byte order:
  - `3366`, `3375`, `3376`†, `3380`, `3381`, `3390`, `3391`, `3395`, `3400`, `3410`;
  - `3415`, `3416`, `3417`, `3420`, `3421`, `3422`, `3435`, `3436`, `3440`, `3441`;
  - `3450`, `3451`, `3452`, `3453`, `3454`, `3455`, `3456`, `3460`;
  - `3465`, `3466`, `3467`, `3468`, `3469`, `3470`, `3475`, `3476`, `3477`;
  - `3480`, `3481`, `3482`, `3483`, `3484`, `3485`, `3486`, `3487`, `3488`;
  - `3490`, `3491`†, `3495`, `3496`, `3497`, `3500`.

  † only if action 2 is approved. That is 52 files in P1 and 7 in P0: 59 with both marked sets.
- **Not in this batch:**
  - the media files 3338–3365 (`docs/ops/sensing-production-approval-request.md` §2 H);
  - the creator ledger P2: 2901, 2920–2922, 2930, 3385–3387 (action 24);
  - 2893 (action 21).
- **Dependency order, checked at this tree.** Byte order satisfies every dependency:
  - 3390 after 2892 and 3376; 3410, 3417, 3435, 3476, 3477 and 3497 on 2892; 3441 on 3415; 3486 on 3381; 3491 on 3376; 3497 on 3477;
  - skipping P2's three files breaks nothing, and none of the new files reads a creator table;
  - every object the new files require was present in the 2026-09-22 production snapshot: `trail_health_snapshots`, `discovery_places`, `compass_city_confidence`, `trails`, `content_trails`, `memories`, `profiles`, `tags`.
- **What changes for users:** nothing. Every flag lands FALSE, because each seed's postcondition refuses TRUE, and the deployed API does not read the new objects. The only data rewrites:
  - 3440 recomputes `canonical_locations.search_key` on every row under ACCESS EXCLUSIVE. There were 31 rows on 2026-09-27; re-size with census §73.9's SQL (rollout plan §1.4) immediately before;
  - 3375 validates every `rank_events` row once (234,224 on 2026-09-27);
  - 3441 recomputes `trails.slug` where it differs from the canonical slug.
- **Prerequisites:** step 0 green; the PR merged; the restore point; §73.9 re-sized.
- **Unblocks:** it is a precondition of 59 open rows. None of them moves on the apply alone. DC-20 and DV-76 are `C`-gradable on the ledger read-back; every other row needs later actions (§7).
- **Monitoring:**
  - each file's POST read;
  - the ledger row: `applied_by='manual'`, and a 64-hex checksum equal to the file's sha256 at the deployed commit;
  - `SELECT flag, enabled FROM public.feature_flags WHERE flag IN (…);` over the flags of rollout plan §3 and §9.2: every new row FALSE, and `discovery_serve_log_enabled` still TRUE;
  - `check:production-drift` against a refreshed snapshot.
- **Stop:** any file failing its transaction, which rolls itself back. Stop the batch there. The files before it stay applied and recorded.
- **Recovery:**
  - each file's rollback in `db/rollback/`, newest first. Every P1 file has one; 3440's and 3441's were added by §97 (W11-S) and are their footers as files (apply plan §8.5);
  - P0: since §97 (W11-S) each file has a `db/rollback/` file (2289, 2297, 2892, 2894, 2995), guarded: 2297 and 2894 refuse while a `dismiss` or `trip_add` row exists instead of deleting it, and 2892 refuses while `place_momentum` holds a row or a later file builds on it (apply plan §8.5);
  - the worst case is the restore point.
- **If approved:** production gains the schema the branch's code needs.
- **If declined:** action 4 cannot ship the branch's API, because its writes would name objects that do not exist. Every production row stays W.
- **Recommendation:** approve (W10D-A1, extended to this tree).

### Action 4 — deploy the API, then ship the client · production activation

- **Approve:**
  1. Deploy the API built from the merged `main` (rollout plan §2 step D2).
  2. Ship the travel-buddy client build from the same commit (D3).
  3. Name the oldest supported client build. That is a release fact the product owns (census §60.8 Q2). Four changes wait for that floor to carry their client side:
     - the canonical byline (AR-W11X2-1);
     - the keyed outcome (D-W10-O-15);
     - the Telegraph Save (D-W10S2-15);
     - "Ask me first" (D-W10S2-17).
- **Prerequisite:** action 3 complete and verified.
- **Unblocks** the production evidence of 27 rows. Among them:
  - DV-02 and DV-47: the client sends the viewer's token, ending the period in which every production Discovery request was anonymous (census §47.1);
  - DV-37: keyed outcomes land once on their receipt (3420), and keyless outcomes from older builds land once within 10 minutes (D-W10-O-15);
  - DV-80: the ecosystem report can be run read-only against production.
- **Monitoring** (rollout plan §4):
  - `SELECT count(*), max(served_at) FROM public.recommendations;`;
  - `SELECT count(*) FROM public.rank_events WHERE schema_version <> 1;`, expected 0;
  - signed-in Discovery exposures in `rank_events` within the hour;
  - `pnpm run report:discovery-serve-points`.
- **Stop:** health-check failures, or a rise in `rank_events` insert rejections (the event-rejection stop value is 0.05).
- **Recovery:** redeploy the previous API build. Action 3's objects are inert to it. The previous client build stays in the stores.
- **If approved:** the branch's fixes reach users, with every new behaviour still behind a FALSE flag.
- **If declined:** nothing reaches users.
- **Recommendation:** approve (W10D-A3).

### Action 5 — the twelve non-ranking flags · production activation

None of these changes the ranked order of the Discovery feed. Turn them on one at a time, in this order. Each waits until the one before has run for at least one day with no new error class in the server log.

| # | exact SQL | register | prerequisite | rows | recovery |
|---|---|---|---|---|---|
| 5a | `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_search_protected_zones_enabled';` | AR-W10-S1-1 | 3366 + 3460; §80's build | B04; DC-32 (with 6) | flag FALSE, which restores byte-identical bodies. The 3366 and 3460 rollbacks refuse while it is TRUE |
| 5b | `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_candidate_projection_enabled';` | D-W10-O-13, W10D-A4a; Sensing pack §2 F1 | 2361, already applied in production at FALSE | DC-22, A03, A07, A25, DV-18 | flag FALSE |
| 5c | `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_buddy_launch_gate_enabled';` | W10D-A4b, AR-W11A-1 step 2 | 2360 | B03 (the launch leg only) | flag FALSE |
| 5d | `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_community_byline_canonical_enabled';` | AR-W11X2-1 | 3490; the oldest supported build carries `features/discovery/communityByline.ts` | C19 | flag FALSE |
| 5e | `UPDATE public.feature_flags SET enabled = true WHERE flag = 'layover_snapshot_consumers_enabled';` | D-W10S2-12 | 3465 | A13 | flag FALSE |
| 5f | `UPDATE public.feature_flags SET enabled = true WHERE flag IN ('discovery_trip_projection_enabled', 'discovery_trip_viewer_projections_enabled');` | D-W10S2-14 | 2550 (applied); 3467; Trips' 2420 in the production ledger (after 2334 → 2337) | A10 | flags FALSE |
| 5g | `UPDATE public.feature_flags SET enabled = true WHERE flag = 'telegraph_discovery_actions_enabled';` | D-W10S2-15 | 3467; the client floor | A21 | flag FALSE; commands answer `feature_disabled` |
| 5h | `UPDATE public.feature_flags SET enabled = true WHERE flag = 'tag_permission_approval_required_enabled';` | D-W10S2-17 | 3422 + 3468; a client floor with the "Ask me first" option | none: DV-76 needs only 3422. The flag adds the user's option | flag FALSE. The 3468 rollback refuses while a profile holds `approval_required` |
| 5i | `UPDATE public.feature_flags SET enabled = true WHERE flag = 'compass_graph_decay_enabled';` | D-W10S2-18 | 3469. First run `SELECT edge_type, count(*), min(last_seen) FROM public.compass_graph_edges GROUP BY edge_type;` | DV-51 | flag FALSE. Retired edges return only with new support |
| 5j | `UPDATE public.feature_flags SET enabled = true WHERE flag = 'compass_city_confidence_windowed_reads_enabled';` | D-W10-R3-13 step 2 | 3484. After one daily rebuild, compare each city's `depth_score` and `tier` with the day before. Expect movement only above 20,000 edges or after a failed read | DC-17 (one leg) | flag FALSE. The 3484 rollback refuses while it is TRUE |
| 5k | `UPDATE public.feature_flags SET enabled = true WHERE flag = 'media_pending_upload_sweep_enabled';` | D-W10S2-16 | 3400 + 3467. First run `SELECT count(*), min(created_at) FROM public.post_media WHERE processing_status = 'pending' AND greatest(created_at, updated_at) < now() - interval '150 minutes';` | DV-77 | flag FALSE. **Deleted uploads are not recoverable.** They were never completed and never visible, but this is the one step here that deletes user data |
| 5l | `UPDATE public.feature_flags SET enabled = true WHERE flag = 'trip_operational_projections_enabled';` | D-W10S2-19, W10D-A4e | 2778 (applied at FALSE); Trips' 2760–2785 in the production ledger | A11 | flag FALSE |

- **The Trips migrations are not planned here.** The 2026-09-22 snapshot already shows `trip_events` (2420) and `trip_stages` (2760), but no ledger read was taken for them. 5f and 5l start only after the operator reads `SELECT filename, applied_by FROM public.schema_migration_ledger WHERE filename ~ '^(2334|2337|2420|27[6-8]\d)_' ORDER BY 1;` and finds every one present.
- **Monitoring:**
  - 5a: the §80 log line "discovery search: §24 protection pass changed what was served", and its `policy: "unreadable"` rate;
  - 5b: a signed-in page carrying `discoveryCandidate.reasons` with text;
  - 5e–5g: the Layover, Trip and Telegraph routes' error rates;
  - 5j: the changes to `compass_city_confidence`;
  - 5k: the sweep's deleted count per pass.
- **Stop:** any error class new since the previous flag. For 5k, a deleted count far above the pre-read.
- **If approved:** of the 16 rows these flags touch, seven then need only a read-back: A10, A13, A21, B04, DC-32 (with action 6), DV-51 and DV-77. B03 still needs its payment leg (question 22(c)). The other eight need production rows.
- **If declined (any line):** that row stays W, and nothing else changes.
- **Recommendation:** approve all twelve. 5k deletes user uploads. If you read that as a retention question, answer it with question 11.

### Action 6 — arm the seven stop conditions · production activation

- **Approve** (D-W10-O-3, which supersedes W10D-A7):
  1. After action 3 (3390, 3391 and 3470 applied), read the baselines once: the HHI of Discovery exposures, and the (dismiss + report) share over the last 7 days (census §82.8 has the SQL). If either is already above its value (0.25 or 0.05), arming would hold PDE on legacy from the first minute. Decide that before step 2.
  2. `UPDATE public.feature_flags SET enabled = true, metadata = jsonb_build_object('values_version', 'stop-values-2026-09-28.1') WHERE flag = 'discovery_stop_enforcement_enabled';`
- **The values armed** are D-W10-O-1's. `STOP_ENFORCEMENT_VALUES_VERSION` = `stop-values-2026-09-28.1` in `lib/discoveryStopConditions.ts`. One window for all seven: `STOP_WINDOW_MS`, 10 minutes.

  | condition | halts when | minimum evidence |
  |---|---|---|
  | event rejection | > 0.05 of serve-log inserts | 20 attempts |
  | logging gap | > 0.10 of served items | 20 attempts |
  | creator concentration | HHI > 0.25 | 100 resolved exposures |
  | reports/hides | > 0.05 of exposures | 100 exposures |
  | cache bypass | any bypass | 1 owed rank |
  | RLS leak | any deviation from 3390's posture | 1 read |
  | attribution double count | any | 1 attribution |

  When armed, an unreadable measurement also halts (D-W10-O-2).
- **Prerequisite:** actions 3 and 4. It must be armed before action 7.
- **Unblocks:**
  - DC-32, with 5a: `C`-gradable on a read-back;
  - DV-82: a production stop evaluation reading all seven, under a non-legacy mode;
  - DC-27's "stop values in force" row.
- **Monitoring:** the log line `discoveryEngineMode: a 12 stop condition has tripped — serving legacy`, and `SELECT public.discovery_stop_measurements(now() - interval '10 minutes', now());`.
- **Stop:** this *is* the stop. In legacy mode, which is production today, nothing is evaluated.
- **Recovery:** `UPDATE public.feature_flags SET enabled = false WHERE flag = 'discovery_stop_enforcement_enabled';`. Only `db/rollback/2026-09-28-3470-discovery-stop-enforcement-flag-rollback.sql` removes the row, and it refuses while the flag is TRUE.
- **If approved:** all seven halt the rollout.
- **If declined:** two unratified values stay enforced, and five are reported only. DV-82 stays W.
- **Recommendation:** approve.

### Action 7 — Phase F gate 1: PDE in shadow · production activation

- **Approve** (D-W10R4-2 step 2; rollout plan M1–M2):
  1. `UPDATE public.feature_flags SET enabled = true, metadata = '{"mode":"shadow","cohort":{"kind":"users","userIds":["<internal account ids>"]}}' WHERE flag = 'DISCOVERY_ENGINE_MODE';`
  2. After 7 days with no stop tripped: `UPDATE public.feature_flags SET metadata = '{"mode":"shadow","cohort":{"kind":"percent","percent":5}}' WHERE flag = 'DISCOVERY_ENGINE_MODE';`
  3. Optionally `"mode":"compare"`, which serves legacy and records the comparison.
- **What changes for users:** nothing. Users still get the legacy order. PDE ranks the same candidates after the response and writes `discovery_shadow_serves`.
- **Prerequisite:** action 6 armed.
- **Unblocks:**
  - DC-14: shadow rows over a window, serve points 1, 4 and 5;
  - DC-11's `pde_stages` record, with 9 and 10;
  - DV-82's non-legacy evaluation;
  - DV-19's arm;
  - the "shadow" row of DC-27's record.
- **Monitoring:** `pnpm run report:discovery-divergence`, and `SELECT engine_mode, count(*) FROM public.discovery_shadow_serves WHERE observed_at >= now() - interval '1 hour' GROUP BY 1;`.
- **Stop:** any tripped stop (automatic, within 30 s), or the log line `metadata.cohort is unusable`.
- **Recovery:** `UPDATE public.feature_flags SET enabled = false WHERE flag = 'DISCOVERY_ENGINE_MODE';`, and `disable_discovery_pde` TRUE if needed.
- **If approved:** shadow rows accumulate for 14 days before gate 2 is read.
- **If declined:** production stays legacy, and every PDE-dependent row stays W.
- **Recommendation:** approve.

### Action 8 — Phase F gate 2: PDE serves · production activation

- **Approve** (D-W10R4-2 step 3; rollout plan M3–M5; W10D-A4d and W10D-A5), after 14 days of shadow rows and your reading of them:
  1. `UPDATE public.feature_flags SET enabled = true WHERE flag IN ('discovery_for_you_pde_enabled', 'discovery_cache_a_ranked_enabled');`
  2. Leave `DISCOVERY_ENGINE_MODE` in `shadow`, so that stop conditions stay evaluated. With both flags on, the shadow skips pages PDE already served.
  3. For the other categories, stage the cohort: `metadata = '{"mode":"partial","cohort":{"kind":"percent","percent":5}}'`, then 25, then 50, then `'{"mode":"pde","cohort":{"kind":"all"}}'`.
     - Each step holds for a full observation window with no stop tripped.
     - The step to `kind: all` is yours explicitly (`lib/discoveryCohort.ts`).
  4. At the 5 % partial step (M4): `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_live_rank_enabled';`
- **Prerequisite:** actions 6 and 7, and 14 days of shadow rows.
- **Unblocks:**
  - DV-03, A01, A03, A05, A07, DV-42 and DV-19;
  - DV-54 and DV-55, with action 10;
  - C32 and DC-24, whose last step is action 20;
  - DC-27's cohort, observe and expand rows.
- **Monitoring:**
  - `pnpm run report:discovery-outcomes`, by arm (an insufficient sample is never reported as 0 %);
  - `report:discovery-trace-coverage` and `report:discovery-ecosystem`;
  - the stop measurements.
- **Stop conditions (gap closed by §97, W11-S).** A tripped stop, or `disable_discovery_pde` TRUE, resolves the engine mode to legacy **and reads 3455, 3456, §78's and §85's flags OFF** at their readers (`lib/discoveryStopGate.ts`, register D-W11S-1), so both pages return to their flag-off order within the flag caches' 30 s, with no flag flipped. The 3455/3456 readers also refresh the database stop measurements in `legacy` mode. `discovery_live_rank_enabled` is not gated (a safety demotion); flip it with the SQL below if the stop calls for it: `UPDATE public.feature_flags SET enabled = false WHERE flag IN ('discovery_for_you_pde_enabled', 'discovery_cache_a_ranked_enabled', 'discovery_live_rank_enabled');`, then the steps of rollout plan §6.
- **Recovery:** the SQL above, with `disable_discovery_pde` TRUE and `DISCOVERY_ENGINE_MODE.enabled = false`. The old behaviour returns within 30 s. Impression rows already written are measurements. Removing them is a retention question (11), not a rollback.
- **If approved:**
  - every signed-in viewer's `for_you` page and Cache A hits are ordered by the PDE pipeline;
  - the other categories follow in stages;
  - `rank_events` gains a real impression row per served item on serve points 1, 2 and 3.
- **If declined:** production keeps Compass's `for_you` order and unranked Cache A hits.
- **Recommendation:** approve, in the stated order.

### Action 10 — the ranker designs and pipeline stages · production activation

- **Approve:** turn these on one at a time, in this order (D-W10-R2-A1 step 3, D-W10-R3-13 steps 3–8, D-W10-I-A1, D-W11X1-A1).
  - Each waits until the previous one has served for at least one week in `pde` cohorts with no stop tripped.
  - Each line is `UPDATE public.feature_flags SET enabled = true WHERE flag = '<flag>';`.

  | order | flag (migration) | gate |
  |---|---|---|
  | 10.1 | `discovery_candidate_sources_enabled` (3480) | — |
  | 10.2 | `discovery_exploration_inventory_enabled` (3481) | — |
  | 10.3 | `discovery_cold_start_enabled` (3482) | — |
  | 10.4 | `discovery_outcome_learning_enabled` (3483) | — |
  | 10.5 | `discovery_feature_families_enabled` (3452) | — |
  | 10.6 | `discovery_trip_match_enabled` (3453) | 5b on, for the labels |
  | 10.7 | `discovery_diversity_axes_enabled` (3454) | metadata as seeded: placePenalty 0.35, geoPenalty 0.15, trailPenalty 0.25, historyPenalty 0.15, historyMaxServes 3, historyWindowDays 7 |
  | 10.8 | `discovery_engagement_integrity_enabled` (3451) | **only if question 9 is answered yes** |
  | 10.9 | `discovery_integrity_stage_enabled` (3483) | after 10.8 (D-W10-I-A1) |
  | 10.10 | `discovery_intent_term_enabled` (3453) | — |
  | 10.11 | `discovery_surface_objectives_enabled` (3450) | metadata as seeded: every surface null |
  | 10.12 | `discovery_trip_planning_objective_rank_enabled`, then `discovery_trail_objective_rank_enabled`, then `discovery_trending_objective_rank_enabled` (3500) | one at a time. The third also needs action 13's `discovery_trending_api_enabled` and `discovery_trend_lists_enabled` |
  | 10.13 | `discovery_output_kinds_enabled` (3483) | 3376 + 3491 applied (action 2) |
  | 10.14 | `discovery_platform_graph_provenance_enabled` (3490) | — |
  | 10.15 | `discovery_ranking_modifiers_enabled` (2289) | **recommended: not yet.** It turns on every §63 modifier at once. Ask for it separately once 10.1–10.14 are measured |

- **Prerequisite:** action 8.
- **Unblocks** 14 rows, each of which then needs production rows (§7): DC-12, DV-49, DV-53, DV-55, DC-11, DC-13, DV-18, DV-54, DV-12, A18, DV-09, DC-01, DC-17 and DV-31. DC-17 and DV-31 also need 10.15.
- **Monitoring:**
  - `rank_events.features` gains keys such as `candidateSources`, `explorationReserve`, `graphReadingProvenance` and `intentMatch`;
  - `report:discovery-outcomes` by arm;
  - the stop measurements.
- **Stop:**
  - a tripped stop. Then set the flag turned on last to FALSE by hand, because these flags do not read the stop state;
  - or `report:discovery-outcomes` showing the arm worse on a sample it calls sufficient.
- **Recovery:**
  - any flag FALSE, effective at the next read. The flag-off ranking is golden-pinned bit-identical;
  - to remove the rows: the rollbacks `db/rollback/2026-09-28-345{0,1,2,3,4}-…`, `…-348{0,1,2,3,4}-…`, `…-3490-…` and `…-3500-…`. Each refuses while its flag reads TRUE.
- **If approved:** Discovery's served order changes for PDE-ranked requests. Nothing here has production evidence yet; measurement begins.
- **If declined:** the order stays as action 8 left it, and these rows stay W.
- **Recommendation:** approve 10.1–10.14; defer 10.15.

### Action 13 — Trending v2, the stored post-after-visit leg, and co-occurrence · production activation

- **Approve** (D-W10-R1-17, D-W11X3-A1), in this order:
  1. **Only with question 11(b) answered**, both together:
     - `UPDATE public.feature_flags SET enabled = true, metadata = '{"keep_days": 30}' WHERE flag = 'discovery_trend_snapshot_retention_enabled';` (30, or your 11(b) value);
     - `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_trend_rebuild_scheduler_enabled';`
  2. `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_trend_normalised_enabled';`
  3. After one production day of v2 runs, **and only with question 12 answered yes**: `UPDATE public.feature_flags SET enabled = true WHERE flag IN ('discovery_trending_api_enabled', 'discovery_trend_lists_enabled');`
  4. `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_trend_post_convergence_enabled';` It reads public, published Memories only, with at least 2 distinct authors.
  5. `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_place_cooccurrence_enabled';` It reads Trail membership only.
  6. `discovery_trend_rediscovery_retest_enabled`, only together with 10.15.
- **Verify:**
  - `SELECT model_version, feature_version, count(*) FROM public.place_momentum WHERE computed_at = (SELECT max(computed_at) FROM public.place_momentum) GROUP BY 1, 2;` Expect `discovery-trend-state-v2` and, after step 4, `discovery-exposure-activity-v3+post-after-visit-v1`;
  - `SELECT count(*), max(computed_at) FROM public.place_cooccurrence;` after the next hour boundary.
- **Prerequisite:** actions 3 and 4; questions 11(b) and 12.
- **Unblocks:**
  - DV-32, `C`-gradable on a read-back;
  - with production rows: DC-06, DC-07, DV-28, DV-29, DV-30, DV-33, DC-21, DC-17 and DV-31;
  - DV-34 (and 16(b) for its other legs) and DV-72 (and 16(c)).
- **Monitoring:** the scheduler's 5-minute runs, the retention deletions per tick, and the store size.
- **Stop:** a run failing twice in a row, or the store growing past the `keep_days` bound.
- **Recovery:**
  - each flag FALSE, effective at the next tick;
  - the rollbacks `db/rollback/2026-09-28-347{5,6,7}-…`, `…-3495-…`, `…-3496-…` and `…-3497-…`. 3476's refuses while 3477's v2 rebuild exists, and 3497's while its flag is TRUE;
  - dropping `area_momentum` (3476) is itself a retention act. The snapshots are derived and can be rebuilt from `rank_events`.
- **If approved:** stored trend states become v2, and the trend API serves driver-led reasons and four lists.
- **If declined:** every deployment stays byte-identical to today.
- **Recommendation:** approve, gated as written.

### Action 14 — the Trails ranking flags · production activation

- **Approve** (D-W10T-13). 3485–3488 are in action 3's batch.
  1. Keep both flags FALSE until a Trail exists in production. Then: `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_trail_exploration_enabled';`
  2. After one week of `trail_member_exposures` rows shows the rotation reaching the backlog: `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_trail_health_order_enabled';`
- **Prerequisite:** action 3, and a Trail in production.
- **Unblocks:**
  - DC-05, `C`-gradable on a read-back;
  - DC-04, DV-21 and DV-22, which need production rows;
  - DV-24 (on 3486) needs one accepted declared relation. That is an admin act, not a flag.
- **Monitoring:** `SELECT count(*), max(day) FROM public.trail_member_exposures;`, and the Trail page error rate.
- **Stop:** a Trail page error class new since the flag.
- **Recovery:** the flags FALSE, and the rollbacks `db/rollback/2026-09-28-348{5,6,7,8}-…`:
  - 3486's refuses while audit rows exist;
  - 3487's refuses while `discovery_trail_exploration_enabled` is TRUE;
  - 3488's refuses while suggestions are pending.
- **If approved:** Trail pages are served from `11` §7's states.
- **If declined:** the admin Trail actions still work (3486); the flagged ordering does not.
- **Recommendation:** approve.

### Action 19 — a bounded debug-sampler window · production activation

- **Approve** (AR-W11A-3):
  1. Read `SELECT flag, enabled FROM public.feature_flags WHERE flag IN ('RANKING_EXPERIMENT_ENABLED','discovery_ranking_modifiers_enabled');`.
  2. `UPDATE public.feature_flags SET enabled = true WHERE flag = 'RANKING_EXPERIMENT_ENABLED';`
  3. Wait until one `ranking_debug_samples` row has `surface = 'discovery'` and a non-null `content_type`.
  4. `UPDATE public.feature_flags SET enabled = false WHERE flag = 'RANKING_EXPERIMENT_ENABLED';`
- **Prerequisite:** 3421 (action 3) and action 4.
- **Retention:** samples carry `viewer_id`. `purge_old_ranking_debug_samples()` (0203) deletes them after 7 days. Whether it is scheduled in production was not read. If it is not, the samples wait for 11(a).
- **Unblocks:** DV-52, on that one production row.
- **Stop:** the window is the stop. Every DRS surface samples while the flag is on, so keep it short.
- **Recovery:** step 4. Sample rows can be deleted by id, and no served order depends on them.
- **If approved:** DV-52 gets its evidence.
- **If declined:** DV-52 waits for 10.15's own request.
- **Recommendation:** approve.

### Action 20 — retire the old `for_you` path · production activation (a code commit)

- **Approve** (D-W10R4-7). After `discovery_for_you_pde_enabled` has been TRUE for 14 days with no stop tripped, merge one commit that:
  - deletes the Compass-order branch of `routes/discovery.ts`;
  - makes the consolidated path unconditional;
  - restates `discoveryVerifyAudit2.test.ts` R1 and R2 and `discoveryOnePipeline.test.ts` P4;
  - adds a migration deleting the `discovery_for_you_pde_enabled` row.
- **Unblocks:** C32 and DC-24, which become `C`-gradable on runnable evidence: one pipeline in the tree.
- **Recovery:** `git revert` of the commit, and re-seed the flag row by re-running 3455.
- **If approved:** one ordering pipeline remains.
- **If declined:** two orderings stay behind a flag, and C32 and DC-24 stay W.
- **Recommendation:** approve, after the 14 days.

### Action 21 — 2893 in production: last, or never · production activation

- **Approve** (D-W10-O-14, W10D-A6):
  1. Pre-read `SELECT surface, count(*) FROM public.rank_events GROUP BY 1 ORDER BY 1;`. Expect 0 rows on the seven labels it retires.
  2. Apply `2893_rank_events_retire_writerless_surfaces.sql` as written, with its ledger row, after everything else.
- **Unblocks:** DV-44, `C`-gradable on a read-back.
- **Stop:** the file aborts by itself if any row carries a retired label.
- **Recovery:** `db/rollback/2026-09-28-2893-rank-events-retire-writerless-surfaces-rollback.sql` (§97, W11-S): its header's reversal as a guarded file. It restores the fifteen labels; writes refused in between are lost.
- **If approved:** a write on a retired label is refused with 23514.
- **If declined:** the seven labels stay admitted and writerless.
- **Recommendation:** approve, last.

### Action 23 — activate Layover mode · production activation

- **Approve** (D-W10S2-13), only after question 22(d):
  1. Curate `layover_place_dwell` rows through the admin route.
  2. Set the environment variables `LAYOVER_ROUTED_CORRIDOR_ENABLED` (an environment variable, not a flag) and `GOOGLE_MAPS_API_KEY`.
  3. `UPDATE public.feature_flags SET enabled = true WHERE flag IN ('layover_discovery_mode_enabled', 'layover_place_dwell_enabled');`
- **Unblocks:** A14, `C`-gradable on a read-back once rows are curated.
- **Recovery:** either flag FALSE. The 3466 rollback drops the curated rows.
- **Recommendation:** approve, if 22(d) is answered yes.

### Action 24 — the creator ledger (P2) · production activation

- **Approve**, only after question 22(a):
  1. The C-11 fix migration your answer selects. **It does not exist yet (a gap).** It is written after the answer (rollout plan §1.5).
  2. Then P2, in order: `2901` (with the fix), `2920`, `2921`, `2922`, `2930`, `3385`, `3386`, `3387`.
  3. `creator_attribution_enabled` stays FALSE until 22(b) publishes a rule (B1) and a producer exists (B7).
- **Unblocks:** it is a precondition of 15 rows: DC-23, DV-26, DV-56–DV-60, DV-63–DV-68, DV-70 and DV-74. None moves on the apply alone; most then need a producer or a published rule (§7).
- **Recovery:**
  - `db/rollback/2026-09-27-338{5,6,7}-…`, newest first. 3387's refuses while its audit table holds rows, and 3386's while 3387 is applied;
  - 2901, 2921 and 2930 have rollback files since §97 (W11-S). **2901's and 2921's refuse while their ledgers hold any row** (a true rollback would destroy financial records: question C-11), and 2930's while 3385 is applied or `creator_attribution_enabled` is TRUE. 2920 and 2922 carry manual REVERSAL notes;
  - every table ships empty.
- **Recommendation:** approve, once 22(a) is answered.

---

## 5. The questions — consent, money, retention (9, 11, 12, 15–18, 22, 25)

This page does not answer these. Each gives a recommended answer and what follows from each answer.

### Question 9 — engagement-integrity data use · consent

- **Question** (D-W10-R2-A1 step 4): *May Discovery's anti-abuse ranking read other accounts' save timestamps, account ages, follow edges and open `gaming_suspected` reviews, within the existing data-use terms?*
- **Recommended answer: no, not yet.** It uses other people's activity for a purpose they were not told about.
- **If yes:** 10.8 and 10.9 may be turned on. DV-12 and DC-11 then need production rows.
- **If no:** those two flags stay FALSE, and the integrity stage records `detector_off`.

### Question 11 — three retention values · retention

| part | what is kept | recommended answer | if answered | if not |
|---|---|---|---|---|
| (a) W10D-C8 | `raw_recent` behavioural rows: `recommendations` (3376, 3491), `rank_events` dwell rows, `ranking_debug_samples` | **No spec value.** `04` §11: *"Exact retention must be decided with privacy/legal review"*. Choose it with legal. The one number already in the code is the debug-sample purge's 7 days (0203); keeping that for debug samples is recommended | a sweep is built and scheduled to that horizon | rows accumulate, labelled and unswept. Do not turn on dwell (question 15) without it |
| (b) D-W10-R1-12, W10D-C7 | `place_momentum` and `area_momentum` runs | **30 days**, the trend model's longest window. An older run describes a window nothing reads again | 13.1 may run, and each tick deletes older runs | the scheduler must stay off (13.1). DC-06, DC-07, DC-17, DC-21, DV-28–DV-31, DV-33 and DV-34 stay W |
| (c) D-W10T-14 | `trail_member_exposures`, `discovery_admin_audit_events`, `trail_content_suggestions` | prune exposures after **31 days** (30 are read); keep the audit rows, for accountability as with C-11; delete decided suggestions **90 days** after `decided_at` | a prune job is built | rows accumulate; nothing served changes |

### Question 12 — may the trend API publish? · consent (disclosure)

- **Question** (§58.12 Q1, the first half of W10D-C4): *Must a published trend meet `PRIVACY_THRESHOLD_V1` (at least 15 distinct travellers per window), and be withheld inside protected zones?*
- The neighbourhood-naming half is decided as routine (D-W10-R1-10): named neighbourhoods only, with at least 15 travellers in both windows.
- **Recommended answer: yes to both floors.** The lists already apply both.
- **If yes:** 13.3 may run. DC-21, DV-29 and DV-33 then need production rows.
- **If no:** `discovery_trending_api_enabled` stays FALSE.

### Question 15 — collect dwell time? · consent

- **Question** (D-W10-O-9, W10D-C1): *For a signed-in viewer, on the Discovery place detail sheet only, may Portava record active, passive and idle milliseconds as `rank_events` rows linked to the account?*
  - The 10-second active window, and "passive dwell is never an interest signal", are decided (D-W10-O-8).
  - Nothing is collected while signed out, on the card, or from location.
- **Recommended answer: not yet.** First:
  - publish this wording in the privacy notice and the app: *"When you open a place from Discovery, Portava records how long the place stays open on your screen and whether you were interacting with it, so that recommendations can learn what you actually read. This is linked to your account. It is not collected when you are signed out, and it is never used to infer interest when your phone is idle."*;
  - answer 11(a);
  - if your consent model needs opt-in, build the opt-in.
- **If yes:** `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_dwell_telemetry_enabled';`, recovered by setting the flag FALSE.
  - DV-41 then needs one production `place_dwell` row.
  - DV-78 also needs the Trail-open event, which is not built.
- **If no:** nothing is collected, and the route answers 404 `feature_disabled`.

### Question 16 — people-derived data · consent (three parts)

| part | question | recommended answer | if yes | if no |
|---|---|---|---|---|
| (a) D-W10-R3-4 | May circle mates' public, published Memories generate Discovery candidates for a viewer (at least 2 distinct mates, no names, no count shown)? | **No.** A candidate list from "your circle" tells a small, identified group who went where | after 10.1, and once `circle_member_visibility_overrides` is honoured in `retrieveCircleContext`: `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_circle_candidates_enabled';`. DC-12 gets its eleventh source | DC-12 stays at 10 of 11 sources, and stays W |
| (b) AR-W11A-2 | May circle and crew membership, and visit records (`passport_stamps`, `circle_checkins`, `plan_checkins`), count as independent convergence for a public trend? | **No, for now.** Circles and crews are small identified groups, and visits are location history | a lane builds aggregated counts (at least 2 circles or travellers) behind a new FALSE flag | DV-34 stays W on those legs |
| (c) W10D-C5 | May `traveler_affinities`, itinerary-based `place_cooccurrence` or `circle_momentum` be built from people's data? | **No.** The Trail-only form (3495) needs no personal data, and it is built | the projections are built under the consent basis you name | DV-72 stays W |

### Question 17 — non-public content in a Trail · consent

- **Question** (D-W10T-12, W10D-C6): *May a Trail serve friends-only, invite-only, circle, trip, draft or cancelled content, or another traveller's route plan, to viewers who could see it elsewhere?*
- **Recommended answer: no**, which is today's fail-closed rule. If widening is wanted later, use an author opt-in that defaults to off, never a per-viewer resolution.
- No row waits on it: DC-20 needs only 3488.

### Question 18 — tagging and name search · consent

- **(a)** (D-W10S2-9) Adopt the settings copy as the definition:
  - `interacted` = the tagged user follows the tagger, or they share a direct message thread;
  - `friends_only` = a mutual follow, or a shared circle;
  - amend the copy to "…followed, messaged, or share a circle with".

  **Recommended: yes.** Turn on `tag_permission_consent_copy_enabled` (3468) only once the two arms the server cannot yet observe are built.
- **(b)** (D-W10S2-11) Should switching to "Nobody" hide existing tags? **Recommended: yes, by hiding at render, never by deleting**, with the copy "Nobody can tag you; existing tags of you are hidden". It is not built yet; the render path is `lib/enrichSpans.ts`.
- **(c)** (W10D-C3) Should Invisible keep hiding a person from Discovery name search? **Recommended: yes**, which is today's behaviour.
- No row waits on any of the three: DV-76 needs only 3422.

### Question 22 — money · financial

- **(a) C-11** (W10D-B0; also retention). On account erasure, are a creator's earning records deleted, or retained anonymised for a statutory period?
  - **Recommended: retain, anonymised, for the period your legal advice sets** (`09` §6, §11; `04` §11). The period has no spec value.
  - The answer selects the fix migration of action 24. Either answer can be changed at no cost before any creator row exists.
- **(b) B1–B11.** These are W10D-B1 … W10D-B11, verbatim from census §52.8, with their spec grounds. Recommended defaults:
  - B1: no percentage (the spec gives none), and publishing restricted to you;
  - B2: no multi-party split yet;
  - B3: click-through only, with the window yours to choose;
  - B4: verified only on captured payment;
  - B5: `07` §4's progression, with the thresholds yours to choose;
  - B6: provider `none`;
  - B7: ingest Rent-a-Buddy booking-completed and refund events, keyed by (booking id, event type);
  - B8: no sponsored placements at launch;
  - B9: marketplace fees tied to a verified booking;
  - B10: require post-visit confirmation;
  - B11: floor both figures, and book the remainder as an explicit platform leg.
- **(c) The Buddy payment leg** (AR-W11A-1). Approve that B03's payment leg reads a per-buddy payout-readiness state, written by the processor you choose under B6. **Recommended: yes.** Nothing is built until a processor exists.
- **(d) Layover routing spend** (E-6, D-W10S2-13). Approve Google Maps Routes spend (`GOOGLE_MAPS_API_KEY`), so that a place nobody planned is admitted only with a measured journey. **Recommended: your call on cost.** There is no spec value.
- **Rows:**
  - DC-23, DV-26, DV-56–DV-69 and DV-74;
  - B03, with 5c;
  - A14, through action 23;
  - DV-61 and DV-62 (N) are graded on B9 and B8 themselves.

### Question 25 — does G57 cover ß, æ and œ? · product definition

- **Question** (census §66.9 Q4, carried by §73–§77): *Does "diacritic-insensitive matching" cover ß, æ and œ?*
- It is not one of the four reserved decisions. The recorded reading (§77) is that they are letters, not letters carrying a mark, and that folding them is transliteration (G61).
- **Recommended answer: no.** B01 then stays C.
- **If yes:** `searchKey` and a new migration after 3440 must fold them, and B01 returns to W until that lands.

---

## 6. Gaps this page found and did not fix

None of these is a new decision.
1. A tripped stop does not turn off 3455 or 3456 (action 8), or any flag of action 10. Their recovery is a manual flag flip.
2. Closed by §97 (W11-S): 3440, 3441, 2289, 2297, 2892, 2894, 2995 and 2893 each have a guarded `db/rollback/` file, rehearsed (apply plan §8.5).
3. Closed by §97 (W11-S): 2901, 2921 and 2930 have rollback files; 2901's and 2921's refuse while any ledger row exists (apply plan §8.5).
4. The C-11 fix migration will not exist until question 22(a) is answered.
5. The 33 files added since §87 have not been through the applier from the modelled `portava-ci` baseline (apply plan §8.3).

---

## 7. Every open row, and what it needs

What "after them" means, once the listed actions are done:
- **R:** `C`-gradable on a production read-back of the applied state. No traffic is needed.
- **E:** still needs the production evidence named.
- **K:** one code commit, then `C` on runnable evidence.
- **X:** still needs code or a producer after the answer.
- **G:** graded on the answer itself.

A lane re-grades each row against its own criterion. This column predicts what is owed, not the verdict.

| row | actions | after them | still owed |
|---|---|---|---|
| A01 | 3, 4, 8 | E | a production `GET /discovery` whose `meta.liveRank` is present and readable |
| A03 | 3, 4, 5, 8 | E | a signed-in production page whose items carry `discoveryCandidate.truthClass` and, on a live-graded row, `whyNow` |
| A05 | 3, 4, 8 | E | a production `for_you` serve whose `meta.liveRank.mode` is the mode the client sent |
| A07 | 3, 4, 5, 8 | E | a production serve of a Live `unsafe_density` reading, demoted; also Sensing's producer (census-sensing S66), outside this page |
| A10 | 3, 5 | R | Trips' 2420 confirmed in the production ledger |
| A11 | 5 | E | a trip-scoped Discovery search placed against freedom windows; Trips' 2760–2785 confirmed in the ledger |
| A13 | 3, 5 | R | — |
| A14 | 3, 22, 23 | R | curated `layover_place_dwell` rows |
| A18 | 3, 4, 10 | E | a `rank_events` row whose features carry `intentMatch` |
| A21 | 3, 4, 5 | R | the oldest supported client build carrying the Telegraph Save |
| A25 | 4, 5 | E | a signed-in `GET /map/projection` with `refusal: null`; the Map's own `map_projection_enabled`, outside this page |
| B03 | 5, 22 | X | the payment leg, built once a processor writes a readiness state |
| B04 | 3, 4, 5 | R | — |
| C19 | 3, 4, 5 | E | a `GET /discovery/community` response with no `submittedBy.name` starting with `@` |
| C32 | 3, 4, 8, 20 | K | — |
| DC-01 | 2, 3, 4, 10 | E | a 200 for each of the three kinds, each with its serve point 13 `recommendations` row |
| DC-04 | 3, 14 | E | a `content_trails` row moved by the writer |
| DC-05 | 3, 14 | R | — |
| DC-06 | 3, 11, 13 | E | a row whose `time_of_day_factor` and `peer_factor` are non-null |
| DC-07 | 3, 11, 13 | E | a `place_momentum` run written by the scheduler |
| DC-11 | 3, 7, 9, 10 | E | a `discovery_shadow_serves.pde_stages` record with `integrity` and `outcomeLearning` measured |
| DC-12 | 3, 10, 16 | E | a `rank_events` row whose `candidateSources` names a source; the eleventh only if 16(a) is yes |
| DC-13 | 3, 10 | E | a ranked request whose features carry `negativeFeedback` |
| DC-14 | 4, 7 | E | `discovery_shadow_serves` rows over a window, serve points 1, 4 and 5 |
| DC-17 | 3, 4, 5, 10, 11, 13 | E | a `rank_events` row with `graphProvenance.status = 'recorded'` on each producer path; needs 10.15 |
| DC-18 | 0, 3 | E | an operator read of production's applied-body checksums |
| DC-20 | 3 | R | — |
| DC-21 | 3, 11, 12, 13 | E | a production v2 run |
| DC-22 | 4, 5 | E | a `GET /api/discovery` page whose items carry `discoveryCandidate.reasons` with text |
| DC-23 | 22, 24 | E | P2 applied and the eligibility read served |
| DC-24 | 3, 4, 8, 20 | K | — |
| DC-26 | 0 | R | the green `schema drift` run on `portava-ci` |
| DC-27 | 0, 1, 3, 4, 6, 7, 8 | E | the filled rollout record through expand (rollout plan §8) |
| DC-32 | 3, 5, 6 | R | — |
| DV-02 | 4 | E | `rank_events` rows with `surface='discovery'` from a `GET /discovery` serve point |
| DV-03 | 3, 4, 8 | E | a `rank_events` row at serve point 1, 2 or 3 with `rankedInRequest` true |
| DV-06 | 2, 3, 4, 11 | E | an anonymous `recommendations` row, and one with `served_count = 0` |
| DV-09 | 3, 4, 10 | E | a serve per surface ranked on its objective |
| DV-12 | 3, 9, 10 | E | a ranked request whose decorations were measured |
| DV-18 | 3, 5, 10 | E | a served row whose reasons include `trip_match` |
| DV-19 | 4, 7, 8 | E | `report:discovery-outcomes` with both arms at 1 000 exposures judging `improves`, which cannot be promised |
| DV-21 | 3, 14 | E | a Trail serving its modules |
| DV-22 | 3, 14 | E | `trail_member_exposures` rows |
| DV-24 | 3 | E | one accepted declared Trail relation |
| DV-26 | 22, 24 | X | a Trail value-event producer |
| DV-28 | 3, 11, 13 | E | a row with non-null `lifecycle_state` |
| DV-29 | 3, 11, 12, 13 | E | an `area_momentum` row |
| DV-30 | 3, 11, 13 | E | a `place_momentum` row with `model_version = 'discovery-trend-state-v2'` |
| DV-31 | 3, 10, 11, 13 | E | a served row whose features carry `rediscoveryRetest`; needs 10.15 |
| DV-32 | 3, 13 | R | — |
| DV-33 | 3, 11, 12, 13 | E | an explanation carrying a driver code |
| DV-34 | 3, 11, 13, 16 | E | a `place_momentum` row with the post-after-visit feature version; the circles, crews and visits legs only if 16(b) is yes |
| DV-37 | 3, 4 | E | one `rank_event_outcome_receipts` row, with the keyed client the oldest supported build |
| DV-40 | 2, 3, 4 | E | an anonymous `recommendations` row whose `item_ids` are a served page |
| DV-41 | 3, 11, 15 | E | one `place_dwell` row |
| DV-42 | 3, 4, 8 | E | a request carrying `intentMode` whose response echoes it |
| DV-44 | 21 | R | — |
| DV-47 | 4 | E | a `rank_events` row with `surface='discovery'` and `rankedInRequest = true` |
| DV-49 | 3, 10 | E | a row whose `candidateSources` includes `graph_related` |
| DV-51 | 3, 5 | R | — |
| DV-52 | 3, 4, 19 | E | one `ranking_debug_samples` row with `surface = 'discovery'` and a non-null `content_type` |
| DV-53 | 3, 10 | E | a row carrying `features.explorationReserve` |
| DV-54 | 3, 8, 10 | E | a ranked request carrying `trailIds` or `servedCount` |
| DV-55 | 3, 8, 10 | E | a `pde_stages` record with `coldStart.applied = true` |
| DV-56 | 22, 24 | X | a Local Expert value event and its producer |
| DV-57 | 22, 24 | X | a producer of `creator_earning_entries` |
| DV-58 | 22, 24 | E | one published `creator_rule_versions` version in force |
| DV-59 | 22, 24 | E | one hold with its audit row |
| DV-60 | 22, 24 | X | an earnings producer, and a recomputation under a second version |
| DV-61 (N) | 22 | G | — |
| DV-62 (N) | 22 | G | — |
| DV-63 | 22, 24 | E | one attribution with its audit events |
| DV-64 | 22, 24 | X | an earnings producer |
| DV-65 | 22, 24 | X | an earnings producer |
| DV-66 | 22, 24 | X | an earnings producer |
| DV-67 | 22, 24 | E | one attribution carrying a bound `recommendation_id` |
| DV-68 | 22, 24 | X | an earnings producer |
| DV-69 | 22 | X | a payout path, itself a financial obligation |
| DV-70 | 0, 3, 24 | E | an operator's live read of columns, functions and policies |
| DV-72 | 3, 13, 16 | E | one `place_cooccurrence` run; the personal forms only if 16(c) is yes |
| DV-74 | 3, 22, 24 | E | one audit row for each of `11` §8's six actions |
| DV-75 | 1 | R | a read of `main`'s rulesets |
| DV-76 | 3 | R | — |
| DV-77 | 3, 5 | R | — |
| DV-78 | 11, 15 | X | the Trail-open event, which is not built (D-1 Q2 is decided; the code is owed) |
| DV-80 | 3, 4 | E | `report:discovery-ecosystem` run read-only against production |
| DV-82 | 3, 6, 7 | E | one stop evaluation reading all seven ruled, under a non-legacy mode |
