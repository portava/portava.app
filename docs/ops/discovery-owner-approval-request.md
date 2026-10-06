# Discovery — the owner approval request

*Consolidated 2026-09-28 by lane W11-P (`disc-w11-approvals`, at integration head `3fd11f858`). Census section: census-discovery §96. Register section: `## W11-P — the owner approval request, consolidated` in `docs/architecture/discovery-decision-register.md`. This page replaces lane W10-D's pack (census §83), which predated every lane after §83. §2 maps each earlier request id (`W10D-…`) and every later register entry to the actions below.*

**Nothing in this page has been done.** No migration of this programme is applied to `portava-ci` or to production. Nothing is deployed, and no Discovery flag has been turned on. Every verdict below rests on controlled evidence: unit suites and a local PostgreSQL 16 harness. None of it is production evidence.

**FOUR OF THE QUESTIONS ARE ANSWERED — 11(a), 12, 15 and 16, by the owner on 2026-10-04.** The answers are recorded verbatim in **§8**, and each of those questions in §5 carries an `ANSWERED` line pointing there. The paragraph above still holds: an answer is not a thing done, and no migration, deploy, flag flip or collection follows from one on its own. **Two of the four are conditional and must not be read as clearances** — 11(a)'s 30 days is a *proposed product default pending the legal review this page itself requires*, and 15 stays **off** *until a privacy notice is written and approved*. The register section is `## OWNER-1004` in `docs/architecture/discovery-decision-register.md`. Questions **9, 11(b), 11(c), 17, 18, 22 and 25 are still open**. **SIX FURTHER DECISIONS WERE TAKEN THE SAME DAY** — commission, deposit, identity provider, payment mode, the creator-ledger retention hold and an activation freeze — recorded verbatim in **§§8.5–8.10** and summarised immediately below the register-mapping table in §1. **Two of those six govern how the whole of this page may be read: §8.10 FREEZES every production activation here, and §8.9 HOLDS PR #592 out of merge and out of application.** Neither is an approval of anything, and three of the six contradict shipped code. *(This paragraph is kept to one line on purpose: `docs/architecture/census-discovery.md` anchors a citation to a line number below, and that file is owned by another lane.)*

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
| 11 | *Q* Three retention values: `raw_recent` rows, trend snapshots, Trail stores — **(a) ANSWERED 2026-10-04, conditionally: 30 days as a PROPOSED default, pending legal review (§8.1). (b) and (c) are still open, so this action is NOT closed.** | retention | 13 |
| 12 | *Q* May the trend API publish, under the k ≥ 15 floor and protected zones? — **ANSWERED 2026-10-04: yes to both floors (§8.2). Verified: the k floor is applied on every published leg; the zone floor is NOT applied to the `areas` list, the emerging-Trails leg, or either producer.** | consent (disclosure) | DC-21, DV-29, DV-33 (3) |
| 13 | Turn on Trending v2, its stored post-after-visit leg and the Trail co-occurrence projection | production activation | 12 |
| 14 | Turn on the Trails ranking flags | production activation | 4 |
| 15 | *Q* Collect dwell time on the place sheet? — **ANSWERED 2026-10-04: no — publishing stays OFF until the privacy notice is written and approved (§8.3). The flag stays FALSE.** | consent | DV-41, DV-78 (2) |
| 16 | *Q* People-derived data: (a) circle mates' Memories, (b) circles, crews and visits for trends, (c) itineraries — **ANSWERED 2026-10-04: no to all three (§8.4).** | consent | DC-12, DV-34, DV-72 (3) |
| 17 | *Q* May a Trail serve non-public content? | consent | none (DC-20 does not wait on it) |
| 18 | *Q* Tagging definitions, "Nobody", and Invisible in name search | consent | none |
| 19 | A bounded debug-sampler window | production activation | DV-52 (1) |
| 20 | Retire the old `for_you` path (one commit) | production activation | C32, DC-24 (2) |
| 21 | 2893 in production: last, or never | production activation | DV-44 (1) |
| 22 | *Q* Money: C-11 erasure, B1–B11 creator rules, the Buddy payment leg, the Layover routing spend — **(a) ANSWERED AND CLOSED 2026-10-04: answer B, retain pseudonymised, seven years after fiscal year-end as the product default, jurisdiction-specific legal retention periods overriding it (§8.11). The question is closed; PR #592 is NOT cleared — legal confirmation is still required before it is merged or applied, and merging IS applying (§8.9, §8.11). (b) only B1's commission percentage is answered — 10 %, answered-but-not-yet-implemented (§8.5), plus the `standard` seed (§8.12). B2–B11 are open, so this action is NOT closed.** | financial (C-11 is retention too) | 19 |
| 23 | Activate Layover mode | production activation | A14 (1) |
| 24 | Apply the creator ledger (P2); attribution stays off until a rule is published — **HELD TWICE 2026-10-04: step 1 by the #592 hold (§8.9) and the whole action by the activation freeze (§8.10). Merging #592 IS the apply.** | production activation | 15 |
| 25 | *Q* Does G57 cover ß, æ and œ? | product definition (not one of the four) | none (B01 stays C on "no") |

**Taking every recommendation, the reply is:**
- step 0 as described; 1–8 approve;
- 9 no; 10 approve without 2289; 11 your three values; 12 yes; 13–14 approve;
- 15 not yet; 16 (a) no, (b) no, (c) no; 17 no; 18 as recommended;
- 19–21 approve; 22 retain-anonymised with your period, and B1–B11 as recommended; 23 and 24 after 22; 25 no.

**What is actually answered (2026-10-04), against that list.** 12 **yes**; 15 **not yet**, with a named condition; 16 (a) **no**, (b) **no**, (c) **no**; 11 **part (a) only** — 30 days, as a proposed default pending legal review, which is *not* the "three values" this action asks for. On **22**: (a) is answered in **shape only** — retain, pseudonymised — with the **period undecided and the apply held** (§8.9), so 22 is **not** closed; of (b), only **B1's commission percentage** is answered (10 %, §8.5), and **B2–B11 remain unanswered**. Everything else on the list above is **unanswered**. §8 holds all ten records. **And the approvals on that list cannot be executed yet, whatever their value:** §8.10 freezes every production activation — actions **1–8, 10, 13, 14, 19–21, 23 and 24** — while the deployment is unavailable and hosted testing shares production state, so an "approve" against one of those is a decision about *what to do*, not a clearance to do it today.

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

### The ten further decisions of 2026-10-04 — commission, deposit, identity, payment mode, the #592 hold, the activation freeze, **C-11 answer B**, the `standard` seed, the fee-rule version, the certification constraint

**Only one of these ten was a question on this page before 2026-10-04 (22(a), answered at the end of this list), and four of them change how everything above and below may be read.** The verbatim wording, the conditions and the `file:line` evidence are in **§§8.5–8.14**; the register entries are `D-OWNER1004-5` … `-14`.

- **§8.10 — ACTIVATION FREEZE. EVERY PRODUCTION ACTIVATION ON THIS PAGE IS FROZEN.** *"Don't flip flags or apply hosted migrations while the deployment is unavailable and hosted testing still shares production state."* **Both conditions were measured TRUE on 2026-10-04.** Nothing is serving at the configured production origin — `GET https://portava.replit.app/healthz` answers **404** with Replit's `This app isn't live yet` placeholder, which is a deployment-level answer and not a cold start. And `public.feature_flags` keys on `flag` alone (`artifacts/api-server/src/migrations/0037_feature_flags.sql:5#flag`), so **an environment distinction is not representable and there is no separate testing flag state to flip.** Actions **1–8, 10, 13, 14, 19–21, 23 and 24** are all frozen. Their "Recommendation: approve" lines mean *once this lifts*.
- **§8.11 — C-11 / QUESTION 22(a) IS ANSWERED: **B**, RETAIN PSEUDONYMISED. THE QUESTION IS CLOSED; PR #592 IS NOT CLEARED.** *"…retain creator-ledger entries pseudonymized for seven years after fiscal year-end. Jurisdiction-specific legal retention periods override this default. Record the owner decision as B; legal confirmation is still required before PR #592 is merged or applied."* **Seven years after fiscal year-end is the product default; jurisdiction-specific legal retention periods override it.** **Legal confirmation is still required before #592 is merged or applied, and the decision does not discharge it** — it has not happened. **No purge exists**, so the period is a stated policy and not a mechanism. See also §8.9, the superseded first ruling, whose hold stands.
- **§8.9 — THE #592 HOLD. NOT A CLEARANCE. STILL IN FORCE.** *"Keep PR #592 out of merge/application until legal review confirms the creator-ledger retention period…"* **The legal confirmation has NOT happened.** Because the chain's apply step runs on `main` only (`.github/workflows/live-db.yml:815#if:`), **merging #592 IS applying `3513`** — there is no later apply to withhold. **PR #594 must land before `3513` is ever applied.** **Action 24 step 1 may not be taken** — not because 22(a) is open (it is closed, §8.11), but because this hold, #594 and §8.10 each withhold it independently.
- **§8.14 — CERTIFICATION CONSTRAINT. `3520` IS HELD.** *"For #612 and #616, 11/11 checks is not full certification when the live-database tier is absent. Do not merge or apply migration 3520 until the required database checks run against a verified, recoverable environment. Keep deployment and real payments off."* **Measured 2026-10-04T16:02:51Z: #612 carries 11 checks and ZERO live-database-tier jobs.** `3520` exists only on PR #616's branch, and because the apply step runs on `main` only, **merging #616 is applying `3520`**.
- **§8.12 and §8.13 — the `standard` commission seed, and `RENT_BUDDY_FEE_RULE_VERSION` → `/v2` with `/v1` preserved. ANSWERED-AND-BEING-IMPLEMENTED.** PR #616's branch is implementing both now; **measured at its tip `f7cea254b`, neither is in any tree yet.**
- **§8.5 — commission: a flat 10 %, stored in basis points (1000), market overrides only when separately approved. ANSWERED-BUT-NOT-YET-IMPLEMENTED.** The tree seeds **25 / 22 / 15 / 12 / 12 %** by buddy level in an `integer` percent column, so the rate is neither flat nor expressible in basis points. This answers **B1's percentage only**; B2–B11 stay open.
- **§8.6 — booking deposit is 0 % for the first release; remove the shipped 30 %. ANSWERED-BUT-NOT-YET-IMPLEMENTED.** A hard-coded `0.3` still computes the deposit on the booking path, on `main` and on every open payments branch.
- **§8.7 — Sumsub as the primary identity provider, failing closed where coverage is unsupported. ANSWERED-BUT-NOT-YET-IMPLEMENTED.** `sumsub` has **zero hits** in the tree; the providers present are Stripe Identity and Persona. Bookings *are* unavailable today, but as a whole-surface closure — **no market-coverage check exists at all.**
- **§8.8 — payment processing stays in test mode.** No live charges, payouts or payment activation. This ratifies a control the tree already enforces, and bounds the work the three items above imply to a vendor **sandbox**.

**What these ten do NOT do.** They move **no census row**, they clear **no production activation**, and the five marked *answered-but-not-yet-implemented* or *answered-and-being-implemented* are **not satisfied by having been written down** — each names the code that contradicts it or the branch that has not yet changed it. **Answering 22(a) does not clear PR #592**, and no count of green checks certifies a tier that did not run.

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

> **FROZEN, 2026-10-04 (§8.10). EVERY ACTION IN THIS SECTION IS A FLAG FLIP OR A HOSTED APPLY, AND BOTH ARE REFUSED WHILE THE FREEZE HOLDS.** The owner's words: *"Don't flip flags or apply hosted migrations while the deployment is unavailable and hosted testing still shares production state."* **Both conditions were measured TRUE on 2026-10-04** — nothing is serving at `portava.replit.app` (404, Replit's `This app isn't live yet` placeholder, not a cold start), and `public.feature_flags` keys on `flag` alone (`artifacts/api-server/src/migrations/0037_feature_flags.sql:5#flag`), so an environment distinction is **not representable** and a flag flipped "for testing" is flipped in production.
>
> **This section is left unedited on purpose.** Its actions, values, unblock lists and recovery paths are all still correct and will all be needed. Read each **"Recommendation: approve"** as *what to do once the freeze lifts*, never as a clearance to act today. **Action 24 carries a second, independent hold (§8.9) that this freeze lifting would not clear.**

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

> **QUESTION 22(a) IS NOW ANSWERED — AND THE ACTION IS STILL HELD TWICE. Each hold is sufficient on its own.**
>
> 0. **§8.11 — step 1's answer EXISTS: C-11 answer B, retain pseudonymised.** *"…retain creator-ledger entries pseudonymized for seven years after fiscal year-end. Jurisdiction-specific legal retention periods override this default. Record the owner decision as B; legal confirmation is still required before PR #592 is merged or applied."* **So step 1 below is no longer waiting on a decision — the migration it selects is `3512`/`3513`, not `3511`.** It is waiting on the two holds that follow. **Do not read "22(a) is answered" as "step 1 may be taken".**
> 1. **§8.9 and §8.11 — step 1 is withheld specifically.** **Legal confirmation of the retention period has NOT happened**, and answer B does not discharge it. PR #592 promotes the retain-pseudonymised file into the chain as `3513`, and because the chain's apply step runs on `main` only (`.github/workflows/live-db.yml:815#if:`), **merging #592 IS applying `3513`** — there is no later apply step to withhold. **PR #594 must also land before `3513` is ever applied**, because it is the pre-apply fix for the severed-beneficiary coercion that pseudonymisation triggers. And **no purge exists**: seven years is a stated policy, not a mechanism.
> 2. **§8.10 — the whole action is frozen** with the rest of §4 while the deployment is unavailable and hosted testing shares production state.
>
> `3510_creator_ledger_erasure_policy_undecided.sql` continues to refuse every ledger deletion in the meantime (`artifacts/api-server/src/migrations/3510_creator_ledger_erasure_policy_undecided.sql:130#CREATE`). **That refusal is the correct state for an undecided policy, not a defect to be cleared by promoting `3513`.**

- **Approve**, only after the holds above lift (**question 22(a) itself is answered — §8.11**):
  1. **The C-11 answer is SELECTED: `reconciliation-staging/3512_creator_ledger_erasure_retain_pseudonymised.sql`** (answer **B**, retain pseudonymised), which PR #592 promotes as `3513`. `…/3511_…delete_on_erasure.sql` is **not** the chosen branch; both were written and rehearsed (census §107) and held out of the chain. **This step is still withheld** — by the outstanding legal confirmation, by PR #594, and by §8.10 — and because merging #592 is the apply, withholding it means not merging #592. Meanwhile `3510_creator_ledger_erasure_policy_undecided.sql` continues to refuse every ledger deletion, so P2 + 3510 may be applied without reaching this step (rollout plan §1.5).
  2. Then P2, in order: `2901` (with the fix), `2920`, `2921`, `2922`, `2930`, `3385`, `3386`, `3387`.
  3. `creator_attribution_enabled` stays FALSE until 22(b) publishes a rule (B1) and a producer exists (B7).
- **Unblocks:** it is a precondition of 15 rows: DC-23, DV-26, DV-56–DV-60, DV-63–DV-68, DV-70 and DV-74. None moves on the apply alone; most then need a producer or a published rule (§7).
- **Recovery:**
  - `db/rollback/2026-09-27-338{5,6,7}-…`, newest first. 3387's refuses while its audit table holds rows, and 3386's while 3387 is applied;
  - 2901, 2921 and 2930 have rollback files since §97 (W11-S). **2901's and 2921's refuse while their ledgers hold any row** (a true rollback would destroy financial records: question C-11), and 2930's while 3385 is applied or `creator_attribution_enabled` is TRUE. 2920 and 2922 carry manual REVERSAL notes;
  - every table ships empty.
- **Recommendation:** approve, once the holds lift. **22(a) is answered (§8.11) — that was a precondition and it is met; it is not a clearance.** What is still outstanding: the legal confirmation of the retention period, PR #594, and §8.10's freeze.

---

## 5. The questions — consent, money, retention (9, 11, 12, 15–18, 22, 25)

**Five are now answered: 11(a), 12, 15, 16 and 22(a), by the owner on 2026-10-04.** Each carries an `ANSWERED` line below with the operative wording **verbatim**; the analysis that produced the question follows it unchanged, so the reasoning the decision was taken against stays readable. The full records, with their conditions and consequences, are §8.

**22(a) / C-11 is CLOSED — answer B, retain pseudonymised (§8.11) — and closing it does NOT clear PR #592**, which stays out of merge and out of application until legal confirmation of the period, and which cannot be "merged now, applied later" because merging it is the apply.

This page does not answer the rest — 9, 11(b), 11(c), 17, 18, 22(b)–22(d) and 25. Each of those gives a recommended answer and what follows from each answer.

### Question 9 — engagement-integrity data use · consent

- **Question** (D-W10-R2-A1 step 4): *May Discovery's anti-abuse ranking read other accounts' save timestamps, account ages, follow edges and open `gaming_suspected` reviews, within the existing data-use terms?*
- **Recommended answer: no, not yet.** It uses other people's activity for a purpose they were not told about.
- **If yes:** 10.8 and 10.9 may be turned on. DV-12 and DC-11 then need production rows.
- **If no:** those two flags stay FALSE, and the integrity stage records `detector_off`.

### Question 11 — three retention values · retention

> **ANSWERED (part (a) only) — 2026-10-04 · CONDITIONAL APPROVAL, NOT A CLEARANCE.** *"Set Q11(a) raw behavioural-row retention to 30 days, then delete the identifiable raw rows; retain only irreversibly aggregated data where needed. Treat 30 days as the proposed product default **pending the required legal review**."*
>
> **The condition is the gate.** 30 days is a **proposed product default**. The privacy/legal review `04` §11 requires — the review the (a) row below records as mandatory — **has not happened**, and nothing here says it has. A sweep may be designed and tested to that horizon; no retention period may be published to a user or treated as settled policy, and no production row may be deleted under it, until the review has run.
>
> **Conflict, unresolved.** `ranking_debug_samples` is already purged at **7 days** in the chain (0203), and the row below recommends keeping that. "30 days" must not be read as authority to **lengthen** that enforced purge. Which horizon governs that one store is **unknown** until the review settles it; the 7-day purge is untouched.
>
> **State of the work.** No sweep exists over `recommendations`, `rank_events` or `ranking_debug_samples` at any horizon; `retention_tier` is a label enforced nowhere. So the position after this answer is: a number proposed, a sweep still owed, rows still accumulating.
>
> **Parts (b) and (c) are NOT answered.** Action 11 is therefore not closed, and the trend scheduler (13.1) is still gated on (b): DC-06, DC-07, DC-17, DV-28–DV-31, DV-33 and DV-34 continue to wait on it. Record: §8.1, and register `D-OWNER1004-1`.

| part | what is kept | recommended answer | if answered | if not |
|---|---|---|---|---|
| (a) W10D-C8 | `raw_recent` behavioural rows: `recommendations` (3376, 3491), `rank_events` dwell rows, `ranking_debug_samples` | **No spec value.** `04` §11: *"Exact retention must be decided with privacy/legal review"*. Choose it with legal. The one number already in the code is the debug-sample purge's 7 days (0203); keeping that for debug samples is recommended | a sweep is built and scheduled to that horizon | rows accumulate, labelled and unswept. Do not turn on dwell (question 15) without it |
| (b) D-W10-R1-12, W10D-C7 | `place_momentum` and `area_momentum` runs | **30 days**, the trend model's longest window. An older run describes a window nothing reads again | 13.1 may run, and each tick deletes older runs | the scheduler must stay off (13.1). DC-06, DC-07, DC-17, DC-21, DV-28–DV-31, DV-33 and DV-34 stay W |
| (c) D-W10T-14 | `trail_member_exposures`, `discovery_admin_audit_events`, `trail_content_suggestions` | prune exposures after **31 days** (30 are read); keep the audit rows, for accountability as with C-11; delete decided suggestions **90 days** after `decided_at` | a prune job is built | rows accumulate; nothing served changes |

### Question 12 — may the trend API publish? · consent (disclosure)

> **ANSWERED — 2026-10-04 · CLOSED, both floors required.** *"Close Q12 with the threshold of at least 15 travellers and suppress contributions inside protected zones."*
>
> **The "The lists already apply both" claim below was verified in code at `f71cfb85f`, and it holds for the place legs only.** The k ≥ 15 floor is applied, in both windows and fail-closed, on every published leg — the place lists, the explanations, the named-neighbourhood sentence and the emerging-Trails fold. **Protected-zone suppression is applied only to `places`, `for-you` and the places half of `emerging`**; `GET /v1/discovery/trending/areas` (Local Pulse, DV-29) and the emerging-Trails leg read no zone at all, and neither momentum producer excludes a contribution made inside a zone. For those legs the answer is **answered-but-not-yet-implemented**: a code gap, named, not a decision. The `file:line` evidence for every clause of this paragraph is in §8.2 and in register `D-OWNER1004-2`.

- **Question** (§58.12 Q1, the first half of W10D-C4): *Must a published trend meet `PRIVACY_THRESHOLD_V1` (at least 15 distinct travellers per window), and be withheld inside protected zones?*
- The neighbourhood-naming half is decided as routine (D-W10-R1-10): named neighbourhoods only, with at least 15 travellers in both windows.
- **Recommended answer: yes to both floors.** The lists already apply both.
- **If yes:** 13.3 may run. DC-21, DV-29 and DV-33 then need production rows.
- **If no:** `discovery_trending_api_enabled` stays FALSE.

### Question 15 — collect dwell time? · consent

> **ANSWERED — 2026-10-04 · REFUSED FOR NOW, with a named condition. NOT AN APPROVAL.** *"Keep Q15 dwell-time publishing off until the privacy notice is written and approved."*
>
> **The condition is the gate.** `discovery_dwell_telemetry_enabled` stays FALSE: nothing is measured, sent, read or written, and the route answers 404 `feature_disabled`. The draft notice wording is the one printed in the recommendation below. **It is a draft. It has not been written into any notice and it has not been approved, and nothing here approves it.** Who approves it, and whether the consent model also needs an opt-in built, are **unknown**.
>
> **Consequence.** DV-41 and DV-78 stay **W** — DV-41's production `place_dwell` row cannot exist while the flag is FALSE, and DV-78 additionally owes the unbuilt Trail-open event. Neither is a defect. Record: §8.3, and register `D-OWNER1004-3`.

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

> **ANSWERED — 2026-10-04 · NO to all three.** *"Answer Q16 'no' for all three people-derived-data uses."*
>
> **The consequences each part states below are this answer working as intended. They are not defects and must not be "fixed".**
> - **(a) no** → `discovery_circle_candidates_enabled` stays FALSE. **DC-12 stays at 10 of 11 sources, and stays W.** The eleventh source is *refused*, not missing; counting 10 as incomplete coverage re-litigates this answer.
> - **(b) no** → no lane is authorised to build aggregated circle, crew or visit counts. **DV-34 stays W on those legs.** Its post-after-visit leg is untouched by this answer and still waits on 11(b) and action 13.
> - **(c) no** → `traveler_affinities`, itinerary-based `place_cooccurrence` and `circle_momentum` are not built from people's data. The Trail-only form (3495) stands and is built. **DV-72 stays W** until a production `place_cooccurrence` run exists; its personal forms are refused permanently, not owed.
>
> Record: §8.4, and register `D-OWNER1004-4`.

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

> **(a) IS ANSWERED AND CLOSED — 2026-10-04, ANSWER B. ITS MERGE AND APPLY REMAIN HELD.** *"C-11 / question 22(a): retain creator-ledger entries pseudonymized for seven years after fiscal year-end. Jurisdiction-specific legal retention periods override this default. **Record the owner decision as B; legal confirmation is still required before PR #592 is merged or applied.**"*
>
> **The question is closed. The merge is not cleared. Those are two statements and both hold.** The **shape** is chosen — retain, pseudonymised, the 3512/3513 branch of (a) — and the **period** is chosen too: **seven years after fiscal year-end as the product default, with jurisdiction-specific legal retention periods overriding it.** So **(a) is CLOSED**, and the migration action 24 step 1 selects is `3512`/`3513`, not `3511`. **But legal confirmation is still required before PR #592 is merged or applied, and the decision does not discharge it** — no confirmation has happened. **PR #592 must not be merged: because the chain's apply step runs on `main` only, merging it IS the apply**, and there is no later apply to withhold. **PR #594 must land before `3513` is applied at all.** And a confirmed period still would not be an *enforced* one: **no purge exists**, the staged file builds none (`reconciliation-staging/3512_creator_ledger_erasure_retain_pseudonymised.sql:19#statutory`), and there is no retention-anchor column, no jurisdiction mapping and no delete path to build one from. Record: **§8.11**, and register **`D-OWNER1004-11`**; the superseded first ruling is §8.9 / `D-OWNER1004-9`.
>
> **(b) B1 — the commission percentage only — IS ANSWERED.** *"Set the Rent-a-Buddy commission to a flat 10% across Buddy levels. Store it in basis points (1000); allow market overrides only when separately approved."* This replaces B1's recommended *"no percentage"* below. **It is ANSWERED-BUT-NOT-YET-IMPLEMENTED:** the tree seeds 25/22/15/12/12 % by buddy level in an `integer` percent column (`artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:1208#INSERT`, `artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:1191#platform_fee_percent`), so basis points are not representable and the rate is not flat. Record: §8.5, and register `D-OWNER1004-5`. **B2–B11 are still unanswered**, and B1's publishing half is untouched.
>
> **Two related rulings sit outside this question's rows.** Payment processing stays in **test mode**, with no live charges, payouts or payment activation (§8.8, `D-OWNER1004-8`); and the booking **deposit is 0 % for the first release**, with the shipped 30 % default to be removed (§8.6, `D-OWNER1004-6`) — also answered-but-not-yet-implemented, the literal still being at `artifacts/api-server/src/routes/rentABuddy.ts:2162#const`.

- **(a) C-11** (W10D-B0; also retention). On account erasure, are a creator's earning records deleted, or retained with the direct identity removed (pseudonymised — census §107.4 shows the rows stay linkable, so not anonymous) for a statutory period?
  - **Recommended: retain, pseudonymised (3512), for the period your legal advice sets** (`09` §6, §11; `04` §11). The period has no spec value, and 3512 builds no purge for it.
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
4. The C-11 fix is written as two held answers (3511 delete, 3512 retain; census §107). **Question 22(a) has now selected 3512 — answer B (§8.11)** — so which one *would* be applied is settled; **what is unsettled is whether it may be applied at all**, which waits on legal confirmation of the period and on PR #594. 3510 continues to refuse every ledger deletion meanwhile, and that refusal is correct rather than a defect.
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

**Read the `actions` column against §8.** Six of the actions it names are touched by the 2026-10-04 decisions — four answered, one answered in part, one held twice — and the table below is unchanged, so a row that still lists one of them is not necessarily still waiting on the owner for it. **And §8.10 freezes every production activation, which no cell in this table reflects:**

- **16 is answered (no).** DC-12, DV-34 and DV-72 no longer wait on it. **They stay W**, for the reasons §8.4 records — the refused legs are refused, not owed. Nobody should "fix" these three rows.
- **12 is answered (yes).** DC-21, DV-29 and DV-33 no longer wait on it; they wait on 3, 11(b) and 13. DV-29's zone leg is additionally **not implemented** (§8.2).
- **15 is answered (not yet).** DV-41 and DV-78 no longer wait on an owner answer; they wait on a privacy notice being written and approved, and **stay W** meanwhile.
- **11 is answered in part (a) only, and conditionally.** Every row listing action 11 still waits on it, because (b) and (c) are open and (a)'s 30 days is a proposal pending legal review (§8.1). DV-06's horizon is proposed, not set.
- **22 is answered in part, and 24 is held twice.** Every row listing **22** still waits on it: (a) has a shape but no period, and B2–B11 are open (§8.9, §8.5). Every row listing **24** — DC-23, DV-26, DV-56–DV-60, DV-63–DV-68, DV-70 and DV-74 — **stays exactly where it is**, held by the #592 hold (§8.9) *and* by the activation freeze (§8.10). **Clearing one hold does not clear the other, and neither is a defect in these rows.**
- **Every "after them" cell in this table now has a prerequisite the table does not show: §8.10.** The column predicts what is owed *once an action happens*. While the freeze holds, no action that is a flag flip or a hosted apply happens at all — so a row reading `E` or `C` in that column is reading a conditional, not a forecast with a date.

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

---

## 8. The owner's answers — 2026-10-04

**Fourteen decisions were taken by the owner on 2026-10-04.** Four answer questions in §5 — 11(a), 12, 15 and 16 (§§8.1–8.4). **Six more (§§8.5–8.10) are about money, identity, the creator ledger and activation**, and four of those six are not §5 questions at all: they are rulings this page had no row for. **Four more (§§8.11–8.14) close question 22(a) / C-11 and govern how the money work may land**: answer **B** for the creator ledger (§8.11), the `standard` commission seed (§8.12), the fee-rule version (§8.13), and a **certification constraint** that holds migration `3520` out of merge and apply (§8.14). The operative wording of each is quoted **verbatim** below; the analysis that produced each §5 question is in §5 and is unchanged, so the reasoning a decision was taken against stays readable.

**§8.11 CLOSES C-11 AND ANSWERS QUESTION 22(a) — AND DOES NOT CLEAR PR #592.** C-11 had been open since the schema answered it twice, by accident and inconsistently; the owner has now chosen **B, retain pseudonymised**, with **seven years after fiscal year-end as the product default and jurisdiction-specific legal retention periods overriding it**. **Legal confirmation is still required before PR #592 is merged or applied, and the decision does not discharge it.** §8.9's hold therefore stands — only its reason changed, from *period undecided* to *period decided and unconfirmed*. **Merging #592 IS applying it**, so there is no later apply to withhold. Read §8.11 before acting on anything in §8.9, §5 question 22(a) or action 24.

**These answers authorise work. They do NOT move a verdict.** No census row changes on the strength of an answer — each still needs its own acceptance evidence, measured after the change lands. Anyone tempted to mark a row `C` because a decision exists should read this sentence again.

**Nothing was applied, deployed, flipped or enabled to record them.** This section is documentation.

**Three are NOT satisfiable by a setting: they require a code change, and the code today does the opposite.** 8.5 (commission), 8.6 (deposit) and 8.7 (identity provider) are marked **answered-but-not-yet-implemented**, with the contradicting `file:line` named in each. **Two more, 8.12 and 8.13, are marked answered-and-being-implemented**: PR #616's branch is implementing both now, and **measured at its tip `f7cea254b` neither is in any tree yet** — nothing here claims that code is done.

**FOUR OF THE FOURTEEN ARE HOLDS OR CONSTRAINTS, NOT CLEARANCES.** **8.9 withholds a merge**, and **8.11 keeps it withheld while closing the question behind it.** **8.10 freezes every production activation in §4 of this page** until two measured conditions are cleared; read it before acting on any action in §4. **8.14 holds migration `3520` out of merge and apply**, and records that **11/11 checks is not full certification when the live-database tier is absent** — measured, for #612, as *zero* database-tier checks out of eleven.

The matching register entries are `D-OWNER1004-1` … `-14`, in the section `## OWNER-1004` of `docs/architecture/discovery-decision-register.md`, which carries the same records with their `file:line` evidence.

| | question or topic | answer | date | the condition that gates it |
|---|---|---|---|---|
| **8.1** | 11(a) — raw behavioural-row retention | 30 days, **proposed** | 2026-10-04 | **pending the required privacy/legal review** — not yet held |
| **8.2** | 12 — may the trend API publish | **yes**, under both floors | 2026-10-04 | none on the answer; the zone floor is unimplemented on two legs |
| **8.3** | 15 — dwell-time publishing | **off** | 2026-10-04 | **until a privacy notice is written and approved** — neither done |
| **8.4** | 16 — people-derived data (a), (b), (c) | **no**, **no**, **no** | 2026-10-04 | none |
| **8.5** | Rent-a-Buddy commission (relates to 22(b) B1) | **flat 10 %**, stored in **basis points (1000)** | 2026-10-04 | market overrides **only when separately approved**. **ANSWERED-BUT-NOT-YET-IMPLEMENTED** — the tree seeds 25/22/15/12/12 in an `integer` percent column |
| **8.6** | booking deposit, first release | **0 %**; remove the shipped 30 % default | 2026-10-04 | none on the answer. **ANSWERED-BUT-NOT-YET-IMPLEMENTED** — a hard-coded 30 % still ships |
| **8.7** | primary identity provider | **Sumsub**, behind the provider interface | 2026-10-04 | verify market coverage; **fail closed** where verification is unsupported. **ANSWERED-BUT-NOT-YET-IMPLEMENTED** — Sumsub has zero hits; the tree carries Stripe Identity and Persona |
| **8.8** | payment processing mode | **test mode only** | 2026-10-04 | no live charges, payouts or payment activation |
| **8.9** | creator-ledger retention (22(a) / C-11) — the first ruling | **HOLD — NOT CLEARED.** PR #592 stays out of merge **and** out of application | 2026-10-04 | **the hold STANDS. Superseded on one point only by §8.11**, which answers the question it recorded as open |
| **8.10** | activation freeze | **no flag flips, no hosted migrations** | 2026-10-04 | **while the deployment is unavailable and hosted testing still shares production state.** Both conditions measured TRUE on 2026-10-04 |
| **8.11** | **22(a) / C-11 — the decision** | **ANSWER B: retain pseudonymised.** Seven years after fiscal year-end is the **product default**; **jurisdiction-specific legal retention periods override it**. **The question is CLOSED** | 2026-10-04 | **legal confirmation is STILL REQUIRED before PR #592 is merged or applied, and this decision does not discharge it.** Merging #592 **IS** applying it. **#594 must land before `3513` is ever applied.** No purge exists; seven years is a stated policy, not a mechanism |
| **8.12** | the `standard` Buddy level's commission | **seed `standard` at the approved flat 10 %** so its fee routes work | 2026-10-04 | **ANSWERED-AND-BEING-IMPLEMENTED** on PR #616. Measured at `f7cea254b`, `3520` still does not seed `standard` and preserves its refusal deliberately |
| **8.13** | `RENT_BUDDY_FEE_RULE_VERSION` | **`/v2`**, with **`/v1` preserved** for historical records and calculations | 2026-10-04 | **ANSWERED-AND-BEING-IMPLEMENTED** on PR #616. Measured at `f7cea254b` the constant is still `/v1`. An addition, never a re-stamp |
| **8.14** | certification of #612 and #616 | **11/11 checks is NOT full certification when the live-database tier is absent.** `3520` is **HELD** out of merge and apply | 2026-10-04 | **until the required database checks run against a verified, recoverable environment** — `unknown` whether any available environment qualifies. **Deployment and real payments stay off** |

### 8.1 Question 11(a) — raw behavioural-row retention · CONDITIONAL, NOT A CLEARANCE

**The answer, verbatim.**

> "Set Q11(a) raw behavioural-row retention to 30 days, then delete the identifiable raw rows; retain only irreversibly aggregated data where needed. Treat 30 days as the proposed product default **pending the required legal review**."

**Stores in scope:** `recommendations` (3376, 3491), `rank_events` dwell rows, `ranking_debug_samples` — the `raw_recent` tier of `04` §11.

**The condition, stated as the condition it is.** 30 days is a **proposed product default**. §5's own row for this question records that *"Exact retention must be decided with privacy/legal review"* and that there is **no spec value**. That review **has not happened**. This record does not say it has, and nothing here may be cited as it having happened. Until it has:

- a sweep may be **designed and tested** to a 30-day horizon;
- **no** retention period may be published to a user, written into a notice, or treated as settled policy;
- **no** production row may be deleted under it.

**Conflict with what is already written, recorded and not resolved.** `ranking_debug_samples` is already purged at **7 days** by a function in the migration chain (0203), and §5's recommendation for this question was explicitly to **keep** that 7 days for debug samples. Applying "30 days" to that store would **lengthen** an enforced purge. This record does not authorise that, the 7-day purge is left exactly as it is, and which horizon governs `ranking_debug_samples` is **unknown** until the legal review settles it.

**State of the work, measured at `f71cfb85f`.** `retention_tier` is a label with no enforcement — 3376 says so in terms — and **no sweep exists** over any of the three stores at any horizon. So the position after this answer is: a number proposed, a sweep still owed, rows still accumulating, labelled and unswept.

**What it does not unblock.** Question 15 (dwell): §5's rule is *"Do not turn on dwell (question 15) without it"*, and a conditional answer does not satisfy that — 15 is separately refused in §8.3. Parts **11(b)** and **11(c)** are **still unanswered**, so **action 11 is not closed** and the trend scheduler (13.1) stays gated on (b): DC-06, DC-07, DC-17, DV-28–DV-31, DV-33 and DV-34 continue to wait on it.

### 8.2 Question 12 — may the trend API publish · CLOSED, both floors required

**The answer, verbatim.**

> "Close Q12 with the threshold of at least 15 travellers and suppress contributions inside protected zones."

**What it unblocks.** 13.3 may run. DC-21, DV-29 and DV-33 then need production rows. Recovery is `UPDATE public.feature_flags SET enabled = false WHERE flag IN ('discovery_trending_api_enabled', 'discovery_trend_lists_enabled');` — both are read per request and fail closed, so revoking takes effect on the next request.

**§5 says of the two floors: "The lists already apply both." That claim was verified in code at `f71cfb85f`. It holds for the place legs. It does not hold for two others.**

**The k ≥ 15 floor — HOLDS, on every published leg.** k is reused, not re-chosen: `PRIVACY_THRESHOLD_V1.minUniqueActors` is 15 (`artifacts/api-server/src/lib/intelContracts.ts:733#minUniqueActors: 15,`) and is taken as the disclosure floor at `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:71#export const TREND_DISCLOSURE_MIN_TRAVELERS = PRIVACY_THRESHOLD_V1.minUniqueActors;`. It is required in **both** windows and fails closed on a missing count (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:136#function travelersOk(v: unknown): boolean {`, `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:145#export function mayDiscloseTrend(row: TrendSnapshotRow): boolean {`). Applied to:

| leg | where the floor is applied |
|---|---|
| `places`, `for-you`, `emerging` (places) | `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:531#export function orderLocated(rows: readonly LocatedRow[]` |
| `areas` (Local Pulse) and the neighbourhood name in a sentence | `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:356#export function mayNameNeighbourhood(area: TrendAreaRow` |
| `emerging` (Trails) | `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:760#async function emergingTrails` |
| the explanations route | `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:145#export function mayDiscloseTrend(row: TrendSnapshotRow): boolean {` |

Pinned by `artifacts/api-server/src/test/discoveryTrendingLists.test.ts:227#it("L-D1.` and `artifacts/api-server/src/test/discoveryTrendingLists.test.ts:286#it("L-G1.`.

**Protected-zone suppression — HOLDS for `places`, `for-you` and the places half of `emerging`.** `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:478#export async function eligibleListPlaces(sc: any, viewerId: string, placeIds: readonly string[])` reads the active zones (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:489#const zones = await loadActiveProtectedZones(sc);`), and drops any place the zone pass does not hand back unchanged (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:501#if (!zoneAllowsPosition(`), which withholds **every** positioned place when the zone policy is unreadable (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:608#if (zones === null) return false;`) and otherwise requires `applyProtection` to leave the probe untouched (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:612#return applyProtection(`). A list is never served with a rule it could not apply. Pinned by `artifacts/api-server/src/test/discoveryTrendingLists.test.ts:241#it("L-E1.` and `artifacts/api-server/src/test/discoveryTrendingLists.test.ts:259#it("L-E2.`.

**Protected-zone suppression — DOES NOT HOLD on two legs. For these, Q12 is ANSWERED BUT NOT YET IMPLEMENTED.**

> **SUPERSEDED BY PR #591, WHICH HAS SINCE MERGED TO `main`. Recorded 2026-10-04 when this branch merged `origin/main` at `48427089d`.** The finding below was measured at `f71cfb85f`, before `claude/q12-protected-zone-suppression-20261004` landed. **Both legs now read a protected zone in the merged tree**: `localPulse` calls a new cell-level zone pass (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:712#const clear = await zoneClearCells(` over `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:645#async function zoneClearCells(`), and `emergingTrails` now takes a viewer and calls the shared place pass (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:777#const eligible = await eligibleListPlaces(`). **This note records only that those call sites now exist.** It does **not** certify either leg, does not grade DV-29 or any other row, and does not establish that the contribution-side gap recorded two paragraphs below is closed. The paragraphs under it are left as the lane wrote them, and re-verifying them belongs to the lane that owns Q12's analysis.

1. **`GET /v1/discovery/trending/areas` (Local Pulse, DV-29).** `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:695#export async function localPulse` never calls `eligibleListPlaces`, reads no zone, and filters on the k floor alone. A named neighbourhood inside a protected zone is not withheld by any zone pass.
2. **The emerging-Trails leg.** `emergingTrails` applies the k floor and reads no zone either.

**No contribution-side suppression exists at either producer.** The answer's words are *"suppress contributions inside protected zones"*. What the tree does is withhold the **output** for a positioned place. It does not exclude a contribution made inside a zone from the momentum computation: no rebuild migration in the chain (2892, 3410, 3417, 3435, 3475–3477, 3497) reads a protected zone, and neither `lib/discoveryTrendNormalised.ts` nor `lib/discoveryLocalMomentum.ts` mentions one. Whether the answer requires input-side exclusion as well as output-side withholding is **unknown**, and is not decided here.

**Consequence for activation.** The place legs are covered by the verification above. Turning on the `areas` list, the emerging-Trails leg, or either producer on the strength of this answer alone would ship a leg whose zone floor is not applied. That is a code gap, named here; it is not a new decision and it does not reopen Q12.

### 8.3 Question 15 — dwell-time publishing · REFUSED FOR NOW, with a named condition

**The answer, verbatim.**

> "Keep Q15 dwell-time publishing off until the privacy notice is written and approved."

**This is a refusal with a condition attached. It is not an approval and it must not be recorded as one.** `discovery_dwell_telemetry_enabled` stays FALSE: nothing is measured, sent, read or written, and the route answers 404 `feature_disabled`. The migration that seeds the flag asserts the OFF state as a postcondition (`artifacts/api-server/src/migrations/3395_discovery_dwell_telemetry_flag.sql:76#WHERE flag = 'discovery_dwell_telemetry_enabled' AND enabled = TRUE;`), and that assertion is untouched.

**The condition, and its state.** A privacy notice must be **written and approved**. §5's recommendation for this question carries **draft** wording for it, beginning *"When you open a place from Discovery, Portava records how long the place stays open on your screen…"*. That draft is referenced here, not adopted: **it has not been written into any notice, it has not been approved, and nothing in this record approves it.** Who approves it, and whether the consent model also needs an opt-in built (the third bullet of §5's recommendation), are **unknown**.

**Consequence.** DV-41 and DV-78 stay **W**. DV-41 owes one production `place_dwell` row, which cannot exist while the flag is FALSE. DV-78 additionally owes the Trail-open event, which is not built. Neither is a defect, and neither is closable by code alone.

### 8.4 Question 16 — people-derived data, all three parts · NO

**The answer, verbatim.**

> "Answer Q16 'no' for all three people-derived-data uses."

**The consequences below are this answer working as intended. They are not defects, and a later pass must not "fix" them.**

| part | refused | consequence, recorded | why it is not a defect |
|---|---|---|---|
| **(a)** D-W10-R3-4 | circle mates' published Memories generating Discovery candidates | **DC-12 stays at 10 of 11 sources, and stays W.** `discovery_circle_candidates_enabled` stays FALSE | the eleventh source is **refused**, not missing. Counting 10 sources as incomplete coverage re-litigates this answer |
| **(b)** AR-W11A-2 | circle and crew membership, and `passport_stamps` / `circle_checkins` / `plan_checkins` visits, counting as independent convergence for a public trend | **DV-34 stays W on those legs.** No aggregated-count lane is authorised | small identified groups and location history, refused as inputs. DV-34's post-after-visit leg is untouched and still waits on 11(b) and action 13 |
| **(c)** W10D-C5 | `traveler_affinities`, itinerary-based `place_cooccurrence`, `circle_momentum` built from people's data | **DV-72 stays W** until one production `place_cooccurrence` run exists | the Trail-only form (3495) stands, is built and needs no personal data. The personal forms are **refused permanently**, not owed |

**Where the refusal is held in code.** 3480 asserts that both its §85 flags ship OFF (`artifacts/api-server/src/migrations/3480_discovery_candidate_sources_flag.sql:73#SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag IN (`), and the circle retrieval runs only when the caller opts in (`artifacts/api-server/src/lib/discoveryCandidates/generate.ts:119#...(opts.circle ? [retrieveCircleContext(ctx)] : []),` over `artifacts/api-server/src/lib/discoveryCandidates/retrievals.ts:392#export function retrieveCircleContext(ctx: RetrievalContext): Promise<RetrievalOutcome> {`).

**Reversibility.** Each part is a FALSE flag or an unbuilt projection, so "no" leaves today's state. A later "yes" would need its own consent basis named, and 16(a) would additionally need `circle_member_visibility_overrides` honoured in `retrieveCircleContext` before its flag could be turned on at all.

### 8.5 Rent-a-Buddy commission · ANSWERED-BUT-NOT-YET-IMPLEMENTED

**The decision, verbatim.**

> "Set the Rent-a-Buddy commission to a flat 10% across Buddy levels. Store it in basis points (1000); allow market overrides only when separately approved."

**What it answers.** The commission half of §5 question 22(b)'s **B1**, whose recommended default on this page is *"no percentage (the spec gives none)"*. A percentage now exists. **22(b)'s other ten parts, B2–B11, are untouched by this decision and remain unanswered.**

**This is not a setting change. The tree contradicts all three clauses, measured at `f71cfb85f`.**

| the clause | what the tree does today | evidence |
|---|---|---|
| **flat 10 %** | **25 / 22 / 15 / 12 / 12 % by buddy level**, seeded into `rent_buddy_fee_rules` and read through one resolver | `artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:1208#INSERT`, then `:1210#(` for `new` at 25 and `:1214#(` for `city_ambassador` at 12; resolver `artifacts/api-server/src/lib/rentBuddyFeeSchedule.ts:46#FEE_SCHEDULE_TABLE`, `artifacts/api-server/src/lib/rentBuddyFeeSchedule.ts:104#export` |
| **stored in basis points (1000)** | stored as a **whole percent in an `integer` column**, so 1000 bps is not representable and a fractional rate is not expressible at all | `artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:1191#platform_fee_percent` |
| **market overrides only when separately approved** | there is **no market dimension on the fee schedule and no approval gate of any kind**. Configurability today is by **buddy level**, not by market | the schedule's only key is `buddy_level` — `artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:1190#buddy_level` |

**The branch now implementing it, and the three ways it does not match.** `origin/claude/pay-d-rab-producers-20261004` (PR #603) adds `3824_rent_buddy_ledger_posting.sql`, which resolves the commission in one database function, most-specific first: a per-market launch-control override, then `rent_buddy_fee_rules` for the buddy's level, then `10` as the owner default. **It is the right shape and it is not this decision:**

1. It stores and resolves a **whole percent (`fee_percent := 10`)**, not basis points. **1000 bps is still not representable.**
2. It **deliberately does not rewrite** the 25/22/15/12/12 seed rows, and its own header says so — so while those rows stand, **they are what applies**, and the rate is not flat across Buddy levels.
3. Its market override is a nullable column an operator may set, with **no separate-approval gate**. This decision permits market overrides *only when separately approved*; whether a column an operator can write satisfies that is **unknown** and is not decided here.

**Consequence.** The decision is recorded, not satisfied. **No census row moves on it.** Nothing is activated by it either: `rent_buddy_enabled` is forced FALSE in the chain (`artifacts/api-server/src/migrations/2210_rent_buddy_default_off.sql:30#VALUES`), and §8.10 freezes flag flips regardless.

**Reversibility.** Documentation. No rate was changed in any database by this record.

### 8.6 Booking deposit, first release · ANSWERED-BUT-NOT-YET-IMPLEMENTED

**The decision, verbatim.**

> "Set the booking deposit to 0% for the first release. Remove the shipped 30% default."

**The 30 % is real, is hard-coded, and is still there.** A booking created in `deposit_plus_cash` mode computes its deposit from a literal `0.3` in the route, not from configuration:

- `artifacts/api-server/src/routes/rentABuddy.ts:2160#const` reads the hourly rate, and the deposit is computed two lines later at `artifacts/api-server/src/routes/rentABuddy.ts:2162#const` — `totalUsd * 0.3`. The cash balance is derived from it at `artifacts/api-server/src/routes/rentABuddy.ts:2163#const`, and the value is persisted at `artifacts/api-server/src/routes/rentABuddy.ts:2211#deposit_usd:`.
- **Checked on every open payments branch as well.** The literal survives unchanged on `origin/claude/pay-a-boundaries-20261004`, `…/pay-b-ledger-20261004`, `…/pay-c-provider-contract-20261004`, `…/pay-d-rab-producers-20261004` and `…/dashboard-collected-zero-20261004`. **No branch implements this decision**, and PR #603's own header quotes the ruling's *"Don't add a deposit in the first release"* while leaving the computation alone.

**A SECOND shipped deposit default the decision does not mention, recorded because "remove the shipped 30 %" does not reach it.** `deposit_percent` columns exist on the Rent-a-Buddy tables with **`DEFAULT 20`** — `artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:824#ADD`, `artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:885#ADD`, and originally `artifacts/api-server/migrations/0048_rent_buddy_marketplace.sql:32#ADD`. **Those columns are read by nothing on the booking path** — `deposit_percent` has zero hits in `routes/rentABuddy.ts` — so the tree carries **two** shipped deposit defaults, 30 % live in code and 20 % dormant in the schema, and removing only the 30 % would leave the 20 % behind the moment anything starts reading the column. Whether this decision intends the 20 % column default to go to 0 as well is **unknown**.

**Consequence.** Unreachable in production today, because `rent_buddy_enabled` is FALSE — but the decision's own words are *"for the first release"*, and the first release is exactly when it becomes reachable. The work is owed. **No census row moves on this record.**

**Reversibility.** Documentation.

### 8.7 Primary identity provider · ANSWERED-BUT-NOT-YET-IMPLEMENTED

**The decision, verbatim.**

> "Use Sumsub as the primary identity provider behind the provider interface. Verify market coverage; fail closed and keep bookings unavailable where suitable verification is unsupported."

**The provider interface exists; Sumsub does not.** Verified at `f71cfb85f`: **`sumsub` has zero hits** — `git grep -in "sumsub" HEAD` over all tracked files returns nothing, and `git grep -inE "sum[-_ ]?sub" HEAD` returns nothing either. The providers the tree actually carries are **Stripe Identity and Persona**, both real vendor integrations rather than stubs, plus a mock. Neither is Sumsub, and neither is a payment processor.

**"Fail closed … where suitable verification is unsupported" is BUILT AS A WHOLE-SURFACE CLOSURE, NOT AS A MARKET CHECK — and the distinction matters.**

- **The booking gate is closed, for every market at once.** The readiness allowlist contains only `"mock"` (`artifacts/api-server/src/services/identityVerification/readiness.ts:53#const`), the gate reads it (`artifacts/api-server/src/lib/rentBuddyKycGate.ts:58#const`) along with a FALSE override flag seeded in the chain (`artifacts/api-server/src/migrations/2074_rent_buddy_kyc_gate_flag.sql:37#(`), and answers **503** on every booking-creation path (`artifacts/api-server/src/lib/rentBuddyKycGate.ts:78#httpStatus:`). It fails closed on a database error. So "bookings unavailable" holds today — but because *no* provider is live, not because a market was checked.
- **Market coverage is NOT verified anywhere, and the one signal that could do it is discarded.** There is no country allowlist, no country parameter on a verification session request, and no gate reads a country. `documentCountry` is produced as an **output** of a completed verification (`artifacts/api-server/src/services/identityVerification/stripeIdentity.ts:197#result.documentCountry`, `artifacts/api-server/src/services/identityVerification/persona.ts:151#result.documentCountry`) and persisted (`artifacts/api-server/src/routes/verification.ts:152#document_country:`) — and then consulted by nothing. Worse, the vendor's own unsupported-country signal is **flattened into a generic failure**: `artifacts/api-server/src/services/identityVerification/stripeIdentity.ts:105#if` maps `country_not_supported` to `"other"`, so an unsupported market is indistinguishable from any other failure. **`country_not_supported` has zero other occurrences in the server.**

**Consequence.** Three distinct pieces of work are owed, and none is a setting: a Sumsub adapter behind the existing interface; a market-coverage check that runs **before** a booking is offered rather than after a document is read; and a refusal path that names unsupported coverage instead of collapsing it to `other`. Until then the decision is recorded and unimplemented. **Whether Sumsub's own coverage meets Portava's launch cities is `unknown`** — this record establishes nothing about the vendor, only about the tree.

**Reversibility.** Documentation.

### 8.8 Payment processing stays in test mode

**The decision, verbatim.**

> "Keep payment processing in test mode. No live charges, payouts, or payment activation."

**This decision matches what the tree already enforces, and that is worth stating precisely rather than as reassurance.** The guard is a built control, not a convention:

- Live mode is permitted **only by the exact string `"true"`** on one environment variable, and is unset by default: `artifacts/api-server/src/lib/paymentsMode.ts:78#export` over `artifacts/api-server/src/lib/paymentsMode.ts:79#PAYMENTS_ALLOW_LIVE`.
- A live provider key **throws before any outbound call** — `artifacts/api-server/src/lib/paymentsMode.ts:138#export` — and an unrecognised key prefix is refused outright rather than assumed to be a test key.
- A **signature-verified** webhook whose envelope claims `livemode` is refused on the same switch: `artifacts/api-server/src/lib/paymentsMode.ts:153#export`.
- No charge executes in any case: `pay-deposit` (`artifacts/api-server/src/routes/rentABuddy.ts:2292#router.post(`) and `pay-full` (`artifacts/api-server/src/routes/rentABuddy.ts:2302#router.post(`) answer **503** with no side effects, and `refund-eligibility` answers **501** (`artifacts/api-server/src/routes/rentABuddy.ts:4076#router.get(`).
- There is **no payout execution to disable**: §3.4 of the payments reconciliation establishes by enumerating all registered workers that none concerns payouts or earnings finalization.

**What this decision therefore does.** It converts a default into a ruling. `PAYMENTS_ALLOW_LIVE` must not be set, no live provider key may be installed, and no payment activation step may be taken. **It also forecloses a step §8.5–8.7's implementation work might otherwise reach for:** an adapter may be written and exercised against a vendor **sandbox** only.

**One thing this record does NOT establish.** Whether `PAYMENTS_ALLOW_LIVE` is currently set in the hosted environment is **unknown** — it is an environment variable on a deployment this page cannot read, and §8.10 records that nothing is deployed there at all. The repository default is unset; the hosted value is unverified.

**Reversibility.** Documentation; and the control it ratifies is one environment variable, reversible at no cost.

### 8.9 Creator-ledger retention · A HOLD. NOT CLEARED. **PR #592 MUST NOT BE MERGED.**

> **SUPERSEDED ON ONE POINT ONLY — SEE §8.11. THE HOLD IS NOT LIFTED.** This entry records the owner's *first* ruling of 2026-10-04 on the creator ledger, which held the merge and left question 22(a) **open**. **§8.11 records the owner's later decision the same day: answer B, retain pseudonymised, seven years after fiscal year-end as the product default with jurisdiction-specific legal retention periods overriding it. 22(a) and C-11 are therefore CLOSED**, and the single claim below that is no longer true is the one marked *"The SHAPE is chosen and the PERIOD is not"*. **Everything else in this entry stands, including the hold itself**: legal confirmation is still required before PR #592 is merged or applied, it has still not happened, and merging #592 is still the apply. The entry is left otherwise unedited so the reasoning the decision was taken against stays readable.

**The decision, verbatim.**

> "Keep PR #592 out of merge/application until legal review confirms the creator-ledger retention period. The proposed product default remains seven years after fiscal-year close, with jurisdictional rules taking precedence and account deletion pseudonymizing the ledger."

**READ THIS BEFORE READING ANYTHING ELSE IN THIS ENTRY. Nothing here clears PR #592, and nothing here authorises applying `3513`.**

- **Legal review has NOT happened.** No legal review of the creator-ledger retention period has been held, and no record of one exists in this repository. This entry does not say it has, and this entry may not be cited as evidence that it has.
- **Seven years after fiscal-year close is a PROPOSED PRODUCT DEFAULT, pending that review. It is not an approved retention period.** It has **zero occurrences in the tree**: `seven years`, `7 years` and `fiscal year` match nothing in `artifacts/api-server/src/migrations/`, nothing in `reconciliation-staging/`, and nothing in `docs/architecture/09_Payment_Architecture.md`. The number exists only as this proposal.
- **Jurisdictional rules take precedence over the proposed default.** Where a jurisdiction sets a different period, that period governs; the proposal does not override it, and no jurisdictional mapping exists in the tree.
- ~~**The retention SHAPE is the one the owner proposes — retain, pseudonymised — and the PERIOD is undecided.** Those are two answers, and only the first has one. §5 question 22(a) is therefore **not closed**, and **action 24 step 1 may not be taken**.~~ **NO LONGER TRUE — this is the one point §8.11 supersedes.** Both answers now exist: the shape is retain-pseudonymised and the period is seven years after fiscal year-end as the product default, jurisdiction-specific legal retention periods overriding it. **§5 question 22(a) is CLOSED.** Action 24 step 1 now has a selected migration (`3512`/`3513`), but **may still not be taken** — not because the question is open, but because the legal confirmation, PR #594 and §8.10's freeze each independently withhold it. See §8.11.

**WHY "DO NOT MERGE" AND "DO NOT APPLY" ARE THE SAME INSTRUCTION. MERGING IS THE APPLY.**

PR #592 does not add a new file beside the staged one — it **renames** `reconciliation-staging/3512_creator_ledger_erasure_retain_pseudonymised.sql` into the canonical chain as `artifacts/api-server/src/migrations/3600_creator_ledger_erasure_retain_pseudonymised.sql`. The chain is applied by CI, and **the apply step runs on the default branch only**: `.github/workflows/live-db.yml:804#THE` states it in terms, and the step itself is conditioned on `.github/workflows/live-db.yml:815#if:`. So the moment #592 lands on `main`, the next live-DB run applies `3513` with no further human step. **There is no separate "apply" button to withhold afterwards.** A reviewer who merges #592 intending to decide the period later has already applied it.

**AND `3513` MUST NOT BE APPLIED BEFORE PR #594 LANDS.** PR #594 (`origin/claude/creator-ledger-nullable-beneficiary-20261004`) is a **pre-apply fix for 3513**: it makes the ledger refuse a severed beneficiary identity instead of coercing it to the string `"null"`, across `lib/creatorLedgerEntries.ts`, `lib/creatorLedgerPlans.ts`, `lib/creatorLedgerStatus.ts`, `services/creators/CreatorAttributionService.ts` and `routes/adminCreatorLedger.ts`. Pseudonymisation is precisely the operation that severs that identity, so applying `3513` without #594 ships the pseudonymiser and the coercion bug together. **The required order is: legal review confirms the period → #594 lands → only then may `3513` be applied.** #594 is itself unmerged at the time of writing.

**What holds the line while this is held, and what it costs.** `3510_creator_ledger_erasure_policy_undecided.sql` is in the chain and refuses every ledger deletion with `CL451`, row-level, so a user with no ledger rows stays deletable: `artifacts/api-server/src/migrations/3510_creator_ledger_erasure_policy_undecided.sql:130#CREATE`. That refusal is the correct state for an undecided policy and it is **not** a defect to be fixed by promoting `3513`.

**No purge exists, and the proposed default does not create one.** The staged migration says so itself: `reconciliation-staging/3512_creator_ledger_erasure_retain_pseudonymised.sql:19#statutory` — deleting retained rows after the statutory period is a purge that file does not build. PR #592's own `3513` header repeats it. So even after a legal review sets a period, **a purge is still owed**; a confirmed number is not an enforced retention.

**Consequence for the census.** No row moves. DC-23, DV-26, DV-56–DV-60, DV-63–DV-68, DV-70 and DV-74 — the fifteen rows action 24 is a precondition of — stay exactly where they are, and they stay there **because this is held**, not because anything is broken.

**Reversibility.** Documentation, and a hold costs nothing to lift: every creator-ledger table ships empty, so either C-11 answer is still free. What is **not** reversible is applying `3513` to a database that later holds creator rows — `2901`'s and `2921`'s rollbacks refuse while their ledgers hold any row, by design, because a true rollback would destroy financial records.

### 8.10 Activation freeze · THIS GATES EVERY PRODUCTION ACTIVATION IN §4

**The decision, verbatim.**

> "Don't flip flags or apply hosted migrations while the deployment is unavailable and hosted testing still shares production state."

**Both conditions were MEASURED on 2026-10-04, and both are TRUE.** The measurements are in `docs/ops/runtime-evidence-20261004.md` on `origin/claude/runtime-evidence-20261004` (PR #605), read-only, with production project `ajrurzioarfkagpuxfnb` not touched.

**Condition 1 — the deployment is unavailable. Nothing is deployed.** `GET https://portava.replit.app/healthz` answered **HTTP 404** with Replit's deployment-level placeholder page, titled `This app isn't live yet`, measured 2026-10-04T12:10:38Z; `/`, `/api/healthz` and `/manifest` answered the same way through 12:16:38Z. That is Replit's edge responding for a hostname with **no live deployment behind it**, not a route-level miss from the application — and it is stronger than a cold start, because a suspended Autoscale deployment wakes on a request and serves it. `portava.replit.app` is the configured production origin, named in `.replit`, in the server's CORS fallback and in all three client build profiles.

**A decoy that must not be mistaken for the opposite.** `https://portava.app/healthz` answers **HTTP 200** — from **Squarespace**, with an empty body, and it answers `200` to *every* path including ones that do not exist. **A health check asserting only on the status code reports that host green while reaching no API at all.** No `200` from `portava.app` is evidence that anything is deployed.

**Condition 2 — hosted testing shares production state, and the flag table makes separating them structurally impossible.** `public.feature_flags` has **`flag` as its sole primary key** — `artifacts/api-server/src/migrations/0037_feature_flags.sql:5#flag` — and both the reader and the audited writer address exactly one global row per flag name. There is no environment, project or tenant column, so **an environment distinction is not representable in the table at all.** The consequence is not an inference and not an operational preference:

> **There is no separate testing flag state to flip. Flipping a flag "for testing" flips it in production, by construction.**

PR #605 records the same answer on all four axes it examined — same database, same flag table, same storage, same auth.

**What this freezes.** Every action in §4 of this page marked *production activation*: **1–8, 10, 13, 14, 19–21, 23 and 24.** Each of those is either a flag flip or a hosted apply, and both are refused by this decision while the two conditions hold. §4 is left **unedited** below — the actions, their values and their recovery paths are all still correct, and will be needed — but **none of them may be executed on the strength of its own "Recommendation: approve" line.** Read that line as *what to do once this freeze lifts*.

**What it does NOT freeze.** Work on a local PostgreSQL harness, work on `portava-ci` (Step 0, §3, which this page already records as not a decision), branch work, tests, and documentation. It freezes **hosted** applies and **flag** flips.

**What would lift it, stated so it is checkable rather than argued.** Condition 1 lifts when a build positively identified as running answers at the configured origin — and note that the repository offers **no way to identify it as a commit**: PR #605 enumerates six channels and finds no version endpoint, no build stamp, no commit sha, no version header, and a static `0.0.0` in `package.json`. Condition 2 lifts only when the flag table can represent an environment, or hosted testing is given its own database. **Neither has a date, and both are `unknown`.**

**Interaction with §8.9.** These are two independent holds and each is sufficient on its own. Even if this freeze lifted tomorrow, `3513` would still be withheld by §8.9; and even if legal review confirmed the period tomorrow, the hosted apply would still be frozen by this entry. **Clearing one does not clear the other.**

**Reversibility.** Documentation. Nothing was flipped or applied to record it — which is the decision operating on itself.

### 8.11 Question 22(a) / C-11 — **ANSWER B IS RECORDED. THE QUESTION IS CLOSED; THE MERGE IS NOT CLEARED.**

**The decision, verbatim.**

> "C-11 / question 22(a): retain creator-ledger entries pseudonymized for seven years after fiscal year-end. Jurisdiction-specific legal retention periods override this default. **Record the owner decision as B; legal confirmation is still required before PR #592 is merged or applied.**"

**This decision has two halves. Both are operative, and they say different things. Read them separately.**

**HALF ONE — THE DECISION IS MADE. C-11 and question 22(a) are ANSWERED, not open.** The answer is **B: retain creator-ledger entries pseudonymised.** This supersedes §8.9's position that *"the SHAPE is chosen and the PERIOD is not"* — the period is now chosen too:

- **Seven years after fiscal year-end is the product default.**
- **Jurisdiction-specific legal retention periods override that default.** Where a jurisdiction sets a different period, that period governs. No jurisdictional mapping exists anywhere in the tree, so the override is a stated rule with nothing implementing it.

C-11 has been open since the schema answered it twice, by accident and inconsistently, and both answers were written, rehearsed and held out of the chain (§5 question 22(a); census §107). **The owner has now chosen between them.** §5 question 22(a) and action 24 step 1 are closed accordingly below: the migration action 24 step 1 selects is `reconciliation-staging/3512_creator_ledger_erasure_retain_pseudonymised.sql`, which PR #592 promotes as `3513` — **not** `3511_…delete_on_erasure.sql`.

**HALF TWO — LEGAL CONFIRMATION IS STILL REQUIRED, AND THIS DECISION DOES NOT DISCHARGE IT.** The owner's own words make the confirmation a precondition of **the merge and the apply**, not of the decision. **No legal confirmation of the creator-ledger retention period has happened**, no record of one exists in this repository, and **this entry may not be cited as evidence that it has.** So:

> **PR #592 STAYS OUT OF MERGE AND OUT OF APPLICATION.** §8.9's hold is **not lifted** by answer B. What changed is *why* it is held. Before: the period was undecided. Now: the period is **decided and unconfirmed**.

**"Decided" and "cleared" are not the same word, and the distance between them is this entry's whole content.** A reader who takes answer B as permission to merge #592 has acted on half of the decision. Nothing below weakens the hold, and nothing in §8.9 is retracted except the single claim that 22(a) is unanswered.

**MERGING #592 *IS* APPLYING IT. THERE IS NO LATER APPLY TO WITHHOLD.** PR #592 does not add a file beside the staged one — it **renames** the staged `3512` into the canonical chain as `artifacts/api-server/src/migrations/3600_creator_ledger_erasure_retain_pseudonymised.sql`. The chain is applied by CI and **the apply step runs on the default branch only**: `.github/workflows/live-db.yml:804#THE` states it in terms, and the step itself is conditioned at `.github/workflows/live-db.yml:815#if:`. The moment #592 lands on `main`, the next live-DB run applies `3513` with no further human step. **A reviewer who merges #592 intending to obtain legal confirmation afterwards has already applied it.**

**AND `3513` MUST NOT BE APPLIED BEFORE PR #594 LANDS.** PR #594 (`origin/claude/creator-ledger-nullable-beneficiary-20261004`) is the **pre-apply fix for `3513`**: it makes the ledger refuse a severed beneficiary identity instead of coercing it to the string `"null"`. Pseudonymisation is precisely the operation that severs that identity, so applying `3513` without #594 ships the pseudonymiser and the coercion defect together. **Measured 2026-10-04: #594 is OPEN and `CONFLICTING` against `main`.** Answer B does not change this ordering — it makes it live, because B is the answer that reaches the pseudonymiser.

**The required order, with each step's state as measured 2026-10-04.**

| # | step | state |
|---|---|---|
| 1 | question 22(a) / C-11 is answered | **DONE — answer B, this entry** |
| 2 | legal confirmation of the retention period | **NOT DONE.** No review held, no record in this repository |
| 3 | PR #594 lands | **NOT DONE.** Open, `CONFLICTING` against `main` |
| 4 | `3513` may be applied — **and the apply is the merge of #592** | **BLOCKED on 2 and 3**, and independently frozen by §8.10 |

**NO PURGE EXISTS, AND ANSWER B DOES NOT CREATE ONE. SEVEN YEARS IS A STATED POLICY, NOT A MECHANISM.** The staged migration says so about itself — `reconciliation-staging/3512_creator_ledger_erasure_retain_pseudonymised.sql:19#statutory` — and PR #592's `3513` header repeats it. **A confirmed period would still not be an enforced one.** Stated so it is checkable rather than assumed: `seven years`, `7 years` and `fiscal year` have **zero occurrences** under `artifacts/api-server/src/migrations/`, zero under `reconciliation-staging/`, and zero in `docs/architecture/09_Payment_Architecture.md`. After answer B, the phrase exists only in these decision records.

**What would turn the policy into a mechanism — three pieces, none of which exists in the tree.** This is the owed work, named so the gap is not mistaken for an oversight:

1. **A per-entry retention anchor.** Seven years runs *from fiscal year-end*, and no creator-ledger table stores a fiscal-year-end or any retention date: `fiscal`, `retain_until`, `retention_until` and `purge_after` match **nothing** in the creator-ledger migrations under `artifacts/api-server/src/migrations/`, `artifacts/api-server/migrations/` or `reconciliation-staging/`. Without an anchor column there is no row-level answer to *when does this entry's seven years end*.
2. **A jurisdiction mapping that can select a longer statutory period per entry.** The override clause is unimplementable without one, and none exists.
3. **A purge that actually deletes.** No delete path over the ledger exists at all: `.delete(` and `DELETE FROM` match **nothing** in `artifacts/api-server/src/services/creators/` or `artifacts/api-server/src/services/ledger/`. A purge would additionally have to be registered on a schedule, and would have to pass the four `BEFORE DELETE` guards described next.

**What holds the line meanwhile, and why it is not a defect.** `3510_creator_ledger_erasure_policy_undecided.sql` is in the chain and exists **specifically to refuse**: a row-level `BEFORE DELETE` guard raising `CL451` on all four ledger tables — `rent_buddy_earnings_entries`, `creator_attributions`, `creator_earning_entries` and `creator_ledger_audit_events` — imposing no policy of its own (`artifacts/api-server/src/migrations/3510_creator_ledger_erasure_policy_undecided.sql:130#CREATE`). It is row-level, so a user with no ledger rows stays deletable. **That refusal remains the correct state until step 4 above is reached. Answer B does not make it a defect, and a later pass must not promote `3513` to "fix" it.**

**Consequence for the census. NO ROW MOVES.** DC-23, DV-26, DV-56–DV-60, DV-63–DV-68, DV-70 and DV-74 — the fifteen rows action 24 is a precondition of — stay exactly where they are, and they stay there **because the merge is held**, not because anything is broken and not because the question is open. It is not open any more.

**Reversibility.** Documentation. No migration was applied, no file renamed, no chain changed to record this. The decision itself is still free to revisit: every creator-ledger table ships empty, so **answer B costs nothing to change until a creator row exists**. What is **not** cheaply reversible is applying `3513` to a database that later holds creator rows — `2901`'s and `2921`'s rollbacks refuse while their ledgers hold any row, by design, because a true rollback would destroy financial records.

### 8.12 The `standard` Buddy level is seeded at the flat 10 % commission · ANSWERED-AND-BEING-IMPLEMENTED

**The decision, verbatim.**

> "Seed the `standard` Buddy level at the approved flat 10% commission so its fee routes work."

**What it decides, and why it is not a restatement of §8.5.** §8.5 set the *rate* — a flat 10 %, in basis points. This decides that the **`standard` level gets a row at all**. Those are different acts, and the second was deliberately withheld pending exactly this approval.

**The gap it closes is real and verified at this tree.** `rent_buddy_fee_rules` is keyed on `buddy_level` alone (`artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:1190#buddy_level`) and its only seed inserts **five** levels — `new`, `rising`, `pro`, `elite`, `city_ambassador` (`artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:1208#INSERT`). **`standard` is not among them**, although it is settable by an admin route; the resolver's own header records that it *"has never had a fee row"* (`artifacts/api-server/src/lib/rentBuddyFeeSchedule.ts:25#the buddy's level has no row`). The resolver returns a three-state result and **never invents a percentage**, so today a `standard` buddy resolves `no_such_level` and **every fee-dependent route refuses.** That is why the decision's words are *"so its fee routes work"*: the refusal is the symptom being fixed.

**This decision supplies an approval that the implementation explicitly declined to invent.** Migration `3520_rent_buddy_commission_basis_points.sql` on `origin/claude/rab-commission-basis-points-20261004` (PR #616) **preserves `standard`'s refusal on purpose**, and says why: *a level nobody priced must not acquire a price as a side effect of a storage change.* That reasoning was correct in the absence of a decision, and this decision is the thing it was waiting for. **The seed is now approved; it is not yet written.**

**State of the implementation, measured at `f7cea254b` (PR #616's tip, 2026-10-04).** PR #616's branch is implementing the commission work now. **At that SHA `3520` still does not seed `standard`**, and its own postcondition message still asserts the absence — *"`'standard'` is absent unless listed, and its refusal is preserved"*. **So this decision is recorded, approved and NOT YET IMPLEMENTED in any tree.** No claim is made here that the code is done. Whether #616 adopts the seed before it merges is **unknown** at the time of writing.

**Consequence.** **No census row moves.** Nothing is activated either: `rent_buddy_enabled` is forced FALSE in the chain (`artifacts/api-server/src/migrations/2210_rent_buddy_default_off.sql:30#VALUES`), §8.8 keeps payment processing in test mode, and §8.14 holds `3520` out of merge and apply regardless.

**Reversibility.** Documentation. No rate was seeded into any database by this record, and a seeded row is a one-row `UPDATE`/`DELETE` away while the ledger is empty.

### 8.13 `RENT_BUDDY_FEE_RULE_VERSION` becomes `/v2`, with `/v1` preserved · ANSWERED-AND-BEING-IMPLEMENTED

**The decision, verbatim.**

> "Change `RENT_BUDDY_FEE_RULE_VERSION` to `/v2`. Preserve `/v1` for historical records and calculations."

**What it is for.** The constant is stamped onto every earnings entry as the rule version the figure was computed under — `artifacts/api-server/src/lib/rentBuddyEarningsLedger.ts:135#ruleVersion:`. §8.5's rate change and §8.12's new seed change what that stamp *means*, so entries computed before and after must be distinguishable. **Preserving `/v1` is the operative half**: existing rows keep their stamp, and any historical record or recalculation that reads `/v1` must continue to resolve it. This is not a rename — **it is an addition, and a `/v1` row must never be re-stamped `/v2`.**

**State of the tree, measured here.** The constant is `"rent-buddy-fee-schedule/v1"` at `artifacts/api-server/src/lib/creatorLedgerRows.ts:25#export`. **Measured at `f7cea254b` (PR #616's tip, 2026-10-04), it is still `/v1` on that branch too.** PR #616's branch is implementing this now; **the change is not in any tree at the time of writing, and nothing here claims the code is done.**

**What this record does NOT establish.** Whether anything other than the ledger writer reads the constant's *value* (as opposed to importing it) — a migration, a report, a recalculation path keyed on the string — was **not** exhaustively audited here. The import sites found are `rentBuddyEarningsLedger.ts` and `src/test/db/creatorLedgerErasurePolicy.db.test.ts`; whether a stored `/v1` string is read anywhere by literal rather than through the constant is **unknown**. A `/v2` cutover that misses such a reader would silently mis-price a historical row, which is the thing "preserve `/v1`" exists to prevent.

**Consequence.** **No census row moves.** No ledger row was written, re-stamped or recomputed to record this.

**Reversibility.** Documentation.

### 8.14 **11/11 CHECKS IS NOT FULL CERTIFICATION FOR #612 AND #616. MIGRATION 3520 IS HELD.**

**The constraint, verbatim.**

> "For #612 and #616, 11/11 checks is not full certification when the live-database tier is absent. Do not merge or apply migration 3520 until the required database checks run against a verified, recoverable environment. Keep deployment and real payments off."

**This is a certification constraint, not an approval of anything.** It belongs in the record because it governs how the other three decisions' implementations may land.

**The absence it names is real, and it is structural rather than intermittent. Measured 2026-10-04T16:02:51Z.**

| PR | head | checks | pass / fail / skipping | live-DB-tier checks present |
|---|---|---|---|---|
| **#612** (`claude/sumsub-identity-provider-20261004`) | `dde6ecbc6` | **11** | 8 / 3 / 0 | **ZERO** |
| **#616** (`claude/rab-commission-basis-points-20261004`) | `f7cea254b` | 29 | 18 / 9 / 2 | 5 |

**#612 carries exactly eleven checks and not one of them is a live-DB-tier job.** No `live DB · …`, no `schema drift · …`, no `live_pulse` gate. **So "11/11" on #612 is a complete rollup of the static tier with the database tier structurally absent — the full set of checks that ran, not the full set that is required.** A green 11/11 there would certify the static tier and say nothing whatever about the database. That is the constraint's point, and it is measured, not inferred.

**#616 does carry the five database-tier jobs, and at this measurement they are failing**, including `schema drift · apply migrations, certify, then audit vs live (needs credentials)` and `live DB · verdict (cancelled or skipped is not a pass)`. **Neither PR is green at this measurement**, so whatever 11/11 rollup the constraint refers to is already superseded by a redder one. The constraint still stands: it is about what a count means, not about today's colour.

**MIGRATION `3520` IS HELD OUT OF MERGE AND OUT OF APPLY — and for `3520`, as for `3513`, merging is the apply.** `3520_rent_buddy_commission_basis_points.sql` exists **only** on PR #616's branch; it is **not** in `main`. Because the chain's apply step runs on the default branch only (`.github/workflows/live-db.yml:815#if:`), **the moment #616 lands, the next live-DB run applies `3520`.** There is no separate apply to withhold afterwards. The condition on lifting the hold is the constraint's own: **the required database checks must run against a verified, recoverable environment.**

**"Verified, recoverable" is not satisfied today, and §8.10 already measured why.** Nothing is deployed at the configured origin, and hosted testing shares production state because `public.feature_flags` has `flag` as its sole primary key and cannot represent an environment at all (`artifacts/api-server/src/migrations/0037_feature_flags.sql:5#flag`). **Whether any environment available to this repository meets "verified, recoverable" is `unknown`**: no backup or restore rehearsal for the live-DB tier's database is recorded anywhere this page can read, and production (`ajrurzioarfkagpuxfnb`) was not touched to find out.

**Why a database tier that goes missing is the dangerous case, not a harmless one.** `3520` is the migration that moves the commission to a basis-point column, and its own header records that `resolveFeeSchedule` selects `platform_fee_basis_points` **explicitly** — so against a database where `3520` has not run, that select fails `42703`, the resolver returns `read_failed`, and **every fee-dependent route refuses**. The ordering between migration and deploy therefore matters, and the tier that would catch getting it wrong is exactly the tier that was absent. A count of 11/11 cannot see this.

**"Keep deployment and real payments off."** This repeats and reinforces §8.8 (payment processing stays in test mode; no live charges, payouts or payment activation) and §8.10 (no flag flips, no hosted migrations). Nothing in §§8.11–8.13 may be read as authorising a deploy or a live payment. **An adapter or a rate change may be exercised against a local harness or a vendor sandbox only.**

**Consequence.** **No census row moves.** #612 and #616 stay unmerged; `3520` stays unapplied; `3513` is independently held by §8.11 and §8.9.

**Reversibility.** Documentation. Nothing was merged, applied, deployed or enabled to record it.
