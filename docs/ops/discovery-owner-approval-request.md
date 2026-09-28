# Discovery — the owner approval request

*Prepared 2026-09-28 by lane W10-D (`disc-w10-d-rollout`, base `debd5ad4f`). Census section: census-discovery §83. Register section: `## W10-D — rollout, portava-ci apply and the owner approval pack` in `docs/architecture/discovery-decision-register.md`.*

Each request id below is recorded in the register as `W10D-<id>` (for example `W10D-B0`).

This page turns every Discovery decision that is **not delegated** into a concrete request. Non-delegated means real user consent, financial obligations, data retention, and production activation (owner authorisation, 2026-09-28). For each request it gives:
- the exact action and values;
- what happens if you approve and if you decline;
- the census rows it unblocks;
- how to undo it.

Routine product and architecture decisions are not here. The lanes decide those and record them in the register.

**Where a financial or retention request has a recommendation, the recommendation is grounded in the specifications, and the section it rests on is cited. Where the specifications give no value, this page says so and offers none. In every case, you choose.**

**The requests are grouped into four replies**, ordered by how many census rows they name as waiting on you. Rows are counted from census-discovery §69.2's owner-item column. The counts overlap where a row waits on two items.

| reply | topic | rows it names | requests |
|---|---|---|---|
| **A** | production activation | 20 | A1–A7 |
| **B** | creator economy and money | 16 (C-11 alone: 14) | B0 (C-11) first, then B1–B11 |
| **C** | consent, data use and retention | 8 | C1–C8 |
| **D** | the GitHub setting on `main` | 1 | D1 |

**Already authorised, so no request:** applying the 40 pending migrations to `portava-ci` (A-1, your 2026-09-28 instruction). `docs/ops/discovery-portava-ci-apply-plan.md` is the procedure. Before an operator runs it, know two consequences:
- `main`'s live-DB certification is red from the apply until PR #528 merges (apply plan §5.4), so apply immediately before the merge;
- certification is fully green only once four small fixes in other lanes' files land (apply plan §5.3, F1–F4). They are routine and are not yours to decide.

---

## Reply A — production activation (20 rows)

Everything in A happens only after the gates in `docs/ops/discovery-production-rollout.md` §0: a green `portava-ci` rehearsal, PR #528 merged, and a confirmed production point-in-time restore point.

### A1 — apply batches P0 and P1 to production

- **Action:** apply, in the order of the rollout plan §1.3–1.4, the Discovery migrations production lacks. Each is applied through the applier's own functions with `applied_by='manual'` and its PRE/POST reads:
  - P0: 2289, 2360, 2850 (flag rows, FALSE); 2892 (an empty table); and 2297, 2894, 2995 if the first ledger read shows them unapplied;
  - P1: 3366, 3375, 3376 (only with A2), 3380, 3381, 3390, 3391, 3395, 3400, 3410, 3415, 3416, 3417, 3420, 3421, 3422, 3435, 3440, 3441, plus any Discovery file seeded FALSE that lands after `debd5ad4f`.
  - The media files 3338–3365 stay under the Sensing pack's section H.
- **Approve:**
  - production gains the schema the branch's code needs. No served response changes until the API deploy (A3).
  - 3440 recomputes `canonical_locations.search_key` on every row under a lock. The last count was 31 rows (census §49.4, 2026-09-27); census §73.9's SQL re-sizes it just before.
  - 3375 validates the 234,224 `rank_events` rows once.
  - 3422 and 3390 remove client-role write and TRUNCATE privileges that no client uses.
- **Decline:** production keeps its current schema. A3 cannot ship the branch's API (its writes would name objects that do not exist). Every DEPLOY row stays where it is.
- **Unblocks** (as an apply precondition): DV-06, DV-40 (with A2), DV-37, DV-52, DV-76, DC-07, DV-70, DC-18, B04 (with A4c).
- **Recovery:** each file's rollback (apply plan §3; every one rehearsed, with the measured gaps named), or the restore point.

### A2 — 3376: the explicit yes

- **Action:** approve `3376_discovery_recommendations_per_request.sql` for production **while `discovery_serve_log_enabled` stays TRUE**, as it already is (snapshot 2026-09-22; census §47.1, 2026-09-27).
- **What that means:** from the API deploy on, every served Discovery request writes one `recommendations` row:
  - signed-in and anonymous serves both;
  - item ids, counts, the serve point, and a hash of coarse context;
  - no coordinates, IP, user agent or query text;
  - anonymous rows are unlinkable, and signed-in rows are erased with the account.
- **Retention (yours):** the rows are labelled `raw_recent`, and **no horizon is enforced.** `04` §11 says retention "must be decided with privacy/legal review". Recommended: approve now and set the horizon in C8. If you want a horizon before any row exists, answer C8 first.
- **Approve:** the per-request denominator exists, and anonymous serves are counted for the first time. DV-06 and DV-40 can move once rows exist.
- **Decline, option (a):** 3376 is not applied, and the new API's writer fails closed and logs. DV-06 and DV-40 stay W.
- **Decline, option (b):** turn `discovery_serve_log_enabled` FALSE. That also stops the existing `rank_events` serve log, so it is not recommended.
- **Unblocks:** DV-06, DV-40.
- **Recovery:** 3376's rollback drops the table; once rows exist, it refuses unless forced, because those rows are the only record of anonymous serves.

### A3 — deploy the API, then ship the client

- **Action:** D2, then D3, in the rollout plan §2's order, after A1.
- **Approve:**
  - the shipped client sends the viewer's token, which ends the six-week gap in which every production Discovery request was anonymous (census §47.1);
  - served ids come back on outcomes, and keyed outcomes land once;
  - the Trails, search and privacy fixes of lanes P1–P17 reach users.
- **Decline:** production keeps the current API and client. Every DEPLOY row stays W.
- **Unblocks:** DV-02, DV-47, C19 (with its build floor), and the production evidence for most rows in A1.
- **Recovery:** redeploy the previous build. The objects from A1 are inert to it.

### A4 — the flag plan (activation after A3)

One answer covers each line. "Recommended" is this lane's recommendation.

| # | flag | production today (source, date) | recommended | if approved | if declined | unblocks |
|---|---|---|---|---|---|---|
| a | `discovery_candidate_projection_enabled` (2361) | FALSE (snapshot 2026-09-22) | **TRUE** after A3 | reason labels on the projection | labels withheld | A25, DC-22, DV-18, A07 (E-1; also Sensing pack item 5) |
| b | `discovery_buddy_launch_gate_enabled` (2360) | absent (snapshot) | **TRUE** after A3 | buddies withheld while the marketplace is off | buddies shown regardless of marketplace state | B03 (launch leg) |
| c | `discovery_search_protected_zones_enabled` (3366) | absent (§49.4, 2026-09-27) | **TRUE** after A3 | Map §24's protected-place pass on search; the identity while 0 zones exist | protected places served at full precision on search once zones exist | B04 (A-3) |
| d | `discovery_live_rank_enabled` (2850) | absent (snapshot) | TRUE at mode step M4 of the rollout plan §3.1, not before | bounded live re-ordering of the head window | no live layer | A01, A05, DV-42, A07 (E-10) |
| e | `trip_operational_projections_enabled` (2778, Trips) | FALSE (snapshot) | stays with the Trips approval; not asked here | — | — | A11 |
| f | `discovery_ranking_modifiers_enabled` (2289), `DISCOVERY_DIVERSITY_ENABLED`, and every flag wave-10 lanes seed for the held ranker designs | absent / FALSE | **FALSE in production** | — | — | A-6's 27 rows. The build hold is lifted; each design's production switch comes back to you as its own request once built and measured |

- **Recovery:** set the flag back to FALSE. It takes effect within the flag cache.

### A5 — Phase F gates 1 and 2: shadow, then serving

- **Action:** the `DISCOVERY_ENGINE_MODE` sequence in the rollout plan §3.1:
  - **Gate 1:** `shadow` for a 5 % cohort, then `compare`.
  - **Gate 2:** `partial` at 5 %, then 25 % and 50 %, then `pde` for all.
  - Each step holds for a full observation window with no stop condition tripped. The stop values in force are those `lib/discoveryStopConditions.ts` carries at the deployed commit (`STOP_CONDITION_RULINGS`, set by another lane).
  - The step to `kind: all` is yours explicitly.
- **Approve gate 1:** shadow rows are written; users still get legacy. **Approve gate 2:** PDE serves the cohort.
- **Decline:** production stays `legacy`.
- **Unblocks:** DC-14 (gate 1), DV-03 (gate 2), DC-27 (the rollout record), and C32 and DC-24 with Q66-2.
- **Recovery:** `disable_discovery_pde` TRUE and `enabled=false`; a tripped stop falls back to legacy automatically within 30 s.

### A6 — 2893 in production (E-4)

- **Action:** apply `2893_rank_events_retire_writerless_surfaces.sql` last (batch P3), or never.
- **Approve:** the `rank_events` surface CHECK narrows to the surfaces with a writer. §49.4 found 0 rows on the seven it retires.
- **Decline:** the CHECK stays wide. DV-44 stays W.
- **Unblocks:** DV-44.
- **Recovery:** its REVERSAL block. This is not free: writes refused in between are lost.

### A7 — ratify that the stop values in force are the lane's

- **Action:** accept that the halt values in `STOP_CONDITION_RULINGS` at the deployed commit are the ones the rollout stops on. The two current values are `EVENT_REJECTION_RATE_THRESHOLD` 0.05 and `LOGGING_GAP_THRESHOLD` 0.10, both labelled unratified. The other five are being set by another wave-10 lane. Two operator rules apply regardless: any `rls_leak` deviation and any attribution duplicate group stops the rollout.
- **Approve:** the values become `owner_ruled`. **Decline:** name different values; the lane changes the constants.
- **Unblocks:** DV-82, DC-32 (its stop leg).
- **Recovery:** change the constant; takes effect at the next deploy.

---

## Reply B — creator economy and money (16 rows)

Nothing here pays anyone. Every creator table ships empty, and `creator_attribution_enabled` (2922) stays FALSE until you say otherwise. The questions are census §52.8's, verbatim.

### B0 — C-11: erasure retention. **Answer this first: it gates the production deploy of every ledger row (batch P2).**

> *"On account erasure, may a creator's earning records be deleted (the cascade 3387 implements, following 2921's stated intent), or must financial records be retained, anonymised, for a statutory period?"* The same question decides 2901's SET NULL defect (§52.2 item 3).

- **Recommended default (grounded):** **retain, anonymised, for the statutory period your legal advice sets.**
  - `09` §6 "Never mutate old ledger rows. Create reversing entries."
  - `09` §11 "every earning can be reconstructed".
  - `04` §11 "audit/security events with separate retention … Exact retention must be decided with privacy/legal review".
  - A deleted earning cannot be reconstructed, and a creator's record is also Portava's financial record.
- **The period itself: no spec value. You choose it, with legal.**
- **If you answer "retain, anonymised":**
  - 3387's two `ON DELETE CASCADE` foreign keys, and 2901's `SET NULL`, are replaced before P2 by an audited pseudonymisation path that keeps the rows and removes the identity. The ledger lane writes it; it is routine once you answer. It is rehearsed on the harness, then on `portava-ci`.
  - P2 is then applied with it.
- **If you answer "delete on erasure":**
  - 3387 stands as written.
  - One small new migration gives 2901's table the same CASCADE. P2 can then be applied.
- **If you decline to answer:** P2 stays unapplied. The 14 rows below stay W, and nothing else is affected.
- **Unblocks:** DC-23, DV-26, DV-56, DV-57, DV-58, DV-59, DV-60, DV-63, DV-64, DV-65, DV-66, DV-67, DV-68, DV-69. That is their first blocker, not their last: most then need B1–B11 and a producer.
- **Recovery:** before any creator row exists, either answer can be changed by a forward migration at no cost. After rows exist, "delete" cannot be undone for rows already erased.

### B1 … B11 — the other eleven rules

Each is "approve the recommendation", "decline and give the value", or "defer" (the flag stays FALSE and nothing is paid).

| # | question (§52.8, abbreviated) | recommended default and its ground | if approved | if deferred | unblocks | recovery |
|---|---|---|---|---|---|---|
| B1 (C-1) | What `creator_share_ppm` / `platform_fee_ppm` does each of the six lineages publish, and who may publish? | **No percentage: the spec gives none.** `07` §8 "Actual percentages must remain configurable"; `09` §1 puts real payouts "later". Recommended: publishing restricted to the owner (an admin action writing a new `creator_rule_versions` row), and nothing published until B6 is answered. | the rule is recorded; still no payout | `{}` keeps refusing every earning | DV-58 | publish a new version; old versions stay |
| B2 (C-2) | How is one conversion's gross divided among several parties? | **No split: the spec gives none.** `07` §7 "record contributions before deciding payout weights". Recommended: keep refusing a weight below 1 until you publish a split. | multi-party credit | single-party only | — | new rule version |
| B3 (C-3) | How long before a conversion may a served recommendation be credited, and does an impression count? | **Click-through only, no view-through:** `07` §1 "Do not pay directly for views". **Window: the spec gives none; you choose the number.** | the window is enforced at attribution | only causality is enforced (served no later than the conversion) | DV-67 | new rule version |
| B4 (C-4) | Is a Rent-a-Buddy booking "verified" at traveller confirmation, or only once payment is captured? | `09` §3 lists the states (`provisional`, `pending`, `verified`, …) but does not map events to them; this lane's reading maps confirmation to `pending` and captured payment to `verified`. Recommended: **verified only on captured payment**; confirmation books `pending`. | earnings wait for capture | the producer keeps treating confirmation as verified | B03 (payment leg, nearest) | new rule version |
| B5 (C-5) | What makes a creator payout-eligible, and in what order? | `07` §4's own progression, as the order: Explorer → Contributor → Trusted Contributor → Trail Builder / Local Expert → Monetization Eligible → Creator Partner, on `07` §4's criteria. **Thresholds: none in the spec; you choose.** | DC-23's fourth read gets its rule | eligibility stays unruled | DC-23 | new rule version |
| B6 (C-6) | Which payout provider, and what must a recipient prove? | `09` §1: payouts "later"; `09` §9: a provider abstraction. Recommended: **`none`** (today's value) until payouts are scheduled. | — | — | DV-69 | swap the provider behind the interface |
| B7 (C-7) | Which revenue events are ingested, from which system, under which key? | `11` §7's list; `09` §10 "idempotency keys". Recommended: first ingest Rent-a-Buddy **booking completed** and **refund/reversal**, keyed by (booking id, event type), because it is the only marketplace that exists. The others wait until their systems exist. | the first writer of `creator_earning_entries` | no writer | DV-57 | stop the ingest; reverse by new entries |
| B8 (C-8) | Will Discovery carry sponsored placements? | `08` §3 if yes: labelled, own selection, "not displace all organic inventory". Recommended: **no sponsored placements at launch**; none exist to label. | DV-62 is graded on the answer | N stays | DV-62 | — |
| B9 (C-9) | Which revenue streams are in scope, each tied to which traveller-value outcome? | `08` §1 "make money when it creates measurable travel value". Recommended: marketplace fees tied to a **verified booking** (B4) first; the others when built. | DV-61 is graded | N stays | DV-61 | — |
| B10 (C-10) | Is a contribution reaching the served live state the Local Expert's value event, or must a post-visit confirmation be recorded first? | `07` §1 "reward verified travel value"; `07` §3 lists "post-visit confirmation". Recommended: **require post-visit confirmation**. | the reward pass's credit waits for confirmation | DV-56/DV-63 stay | DV-56, DV-63 | new rule version |
| B11 (C-12) | Is flooring both figures, leaving the remainder undistributed, the rounding you want? | `09` §8 "integers in minor units"; `09` §11 "every earning can be reconstructed". **The spec does not choose a rounding.** Recommended: floor both, and book the remainder as an explicit platform leg rather than leaving it implicit. | rounding ruled | flooring stays as coded | — | new rule version |

---

## Reply C — consent, data use and retention (8 rows)

Every item below is built and **off**, or fails closed. Approving turns a behaviour on in production. Declining leaves it off.

| # | request (question source) | recommended | if approved | if declined | unblocks | recovery |
|---|---|---|---|---|---|---|
| C1 (B-1) | Turn on dwell collection: `discovery_dwell_telemetry_enabled` (3395) → TRUE, adopting the 10-second active window (`DWELL_INTERACTION_WINDOW_MS`) (§55.10 Q1–Q2) | **Decline for now.** It is new behavioural collection, and its retention is unset (C8). | active/passive/idle dwell per signed-in viewer on the place sheet, written to `rank_events` | nothing is measured or sent | DV-41, DV-78 (dwell leg) | set the flag FALSE; rows stay under C8's horizon |
| C2 (B-1) | Is passive-foreground dwell ever an interest signal? (§55.10 Q3) | No: `04` §4 names `active_dwell` alone | — | — | DV-41 | — |
| C3 (B-2) | Should Invisible hide a person from Discovery **name** search, or only from availability projections? (§53.12) | **Keep hiding from name search** (today's behaviour, privacy-conservative; no production user is affected, §53.12) | no change | a one-line narrowing at `artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts:574#const peopleGate` | — (A24 holds either way) | revert the line |
| C4 (B-3) | Trend disclosure: must a published trend meet PRIVACY_THRESHOLD_V1 (≥ 15 distinct travellers per window) and be withheld inside protected zones? May a public explanation name a neighbourhood? (§58.12 Q1, Q3) | **Yes to both floors; no neighbourhood names** until a signal-led sentence exists | the trend API (`discovery_trending_api_enabled`) may be turned on under those rules | the API stays off | DC-21, DV-33 | flag FALSE |
| C5 (B-4) | Per-person projections: `traveler_affinities`, `place_cooccurrence` from itineraries, `circle_momentum` (§61.12 Q1–Q3) | **Decline all three personal forms.** Allow `place_cooccurrence` only from places sharing a Trail, which needs no personal data (`04` §12) | the projections are built under the consent basis you name | only the Trail-derived form is built | DV-72 | drop the projection tables (derived and rebuildable) |
| C6 (B-5) | May a Trail serve non-public events (friends-only, invite-only, circle, trip, draft, cancelled) or another traveller's route plan? (§61.12 Q4, §64.9 Q1–Q3) | **No.** Serve public events only, and never another traveller's route plan; today's fail-closed state | Trails widen to each viewer's relationships | fail-closed stays | DC-20 | revert the rule |
| C7 (retention, D-2's half) | How long are `place_momentum` snapshots kept, and may a stored state be served longer than the 10-minute in-process reading? (§58.12 Q4; the rebuild cadence is routine and is not asked here) | **No spec value; you choose.** The one number in the code is the momentum loader's 30-day window (census §58), which is offered as a floor, because anything shorter cannot reproduce a served reading. It is not offered as a spec value. | a sweep is scheduled with that horizon | snapshots are not scheduled | DC-07, DV-80 (with D-2) | change the horizon |
| C8 (retention) | The horizon for `raw_recent` behavioural rows: `recommendations` (3376), `rank_events` dwell rows, and the per-request log | **No spec value** (`04` §11: "decided with privacy/legal review"). You choose it, with legal. Until then, rows are labelled and not swept. | a sweep is built and scheduled to that horizon | rows accumulate, labelled | DV-06/DV-40's retention leg; C1 | change the horizon |

---

## Reply D — the GitHub setting on `main` (1 row)

### D1 — A-4: require the three verdicts on `main`

- **Action (GitHub → Settings → Rules → Rulesets → New branch ruleset):**
  - target `main`;
  - enforcement active;
  - "Require status checks to pass", with exactly these three check names:
    - `CI · verdict (skipped or cancelled is not a pass)`
    - `live DB · verdict (cancelled or skipped is not a pass)`
    - `unwired · verdict (skipped or cancelled is not a pass)`
- The only ruleset recorded requiring them targets `bughunt-20260805`, not `main` (read 2026-09-15; `ciWorkflowArchitecture.test.ts`).
- **Approve:** no merge to `main` while any verdict is red, skipped or cancelled.
  - Know that the live-DB verdict is red on PR #528 until the `portava-ci` apply lands, and red on `main` from a pre-merge apply until the merge (apply plan §5.4).
  - So set this **after** #528 merges, or accept that the merge needs the apply first.
- **Decline:** the verdicts stay advisory.
- **Unblocks:** DV-75.
- **Recovery:** disable the ruleset.

---

## How to answer

One line per reply is enough, for example:

```
A: approve A1–A7 as recommended.   (or: approve A1, A3; A2 decline; A4 a–c yes, d later …)
B: B0 retain-anonymised, period = <n> years; B1–B11 as recommended, B3 window = <n> days, B5 thresholds = …
C: C1 decline; C2–C7 as recommended; C8 horizon = <n> days.
D: approve after #528 merges.
```

Each answer is recorded in the register as the owner's ruling, with its date, and the rows move only when the evidence each row names exists.
