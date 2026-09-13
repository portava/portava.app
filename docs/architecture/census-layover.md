# Portava Layover — Requirement Census

> ## CORRECTION HEADER — added 2026-09-07 after production measurement and two build passes
>
> The body below is unedited and describes HEAD `68ed59d9`. Two later commits
> changed verdicts: `9c26efba` (non-monotonic deadline; forgeable safety row)
> and the pass recorded in **§7** at the end of this file. **The headline
> numbers below are stale.** Recomputed over the same 296 denominator, same
> counting rule, same prohibition rule:
>
> | Measure | Was | Now |
> | --- | --- | --- |
> | BUILT-AND-CORRECT | 10 | **20** (18 non-vacuous; L51/L52 still `⌀`) |
> | BUILT-BUT-WRONG | 83 | **87** |
> | NOT-BUILT | 202 | **189** |
> | CANNOT-VERIFY | 1 | **0** |
> | CONSTRUCTED% | 31.4 % | **36.1 %** (107/296) |
> | CORRECT% | 3.4 % | **6.8 %** (20/296) |
> | CORRECT% (spec-attributable) | 0.0 % | **2.0 %** (6/296 — L140, L235, L278, L280, L290, L292; see §7) |
>
> **Production was measured this time** (`ajrurzioarfkagpuxfnb`, read-only,
> aggregates only). Three of the body's "could not check" notes resolve, and
> one framing is wrong:
> - **Note 1 (flags):** all five layover flags are TRUE; so is
>   `passport_entry_intelligence_enabled`. `rent_buddy_enabled` is **FALSE**.
> - **Note 2 (airport_profiles):** 3,206 rows, **0 verified, 0 with any
>   non-default buffer, 0 with terminal_info** — every production session runs
>   on the generic 60/120/30/15/20 constants regardless of airport. The L243
>   divergence is realised for 100 % of airports. Timezones are real (0 rows
>   at 'UTC'; 0 at (0,0)); the fallback profile's `timezone: "UTC"` would only
>   bite on a failed read (L262, still open — PR #463).
> - **Note 3 (sessions):** "live sessions" overstates it. **5 sessions ever,
>   from 2 users, 0 active** (2 cancelled, 3 expired; last created 2026-08-09,
>   last event 2026-08-12), 30 recommendation rows, **0 plan stops**,
>   38 events. Every BUILT verdict is about code that a handful of people ran
>   a month ago — not code nobody ran, and not code under load.
> - **L201 (CANNOT-VERIFY) resolves against the tree's favour in production.**
>   `authenticated` held the full default grant set (DELETE, INSERT, …,
>   TRUNCATE) on all five layover tables, so the missing `WITH CHECK` was
>   exploitable, and the write was demonstrated on CI by `9c26efba`. Migration
>   2335 closes it **on CI only**; production still carries the 0127 policy
>   and grants as of this pass. Owner decision.
>
> **Headline defect 4 is larger than written.** `LayoverRecommendationScreen.tsx`
> (326 lines) is also imported by nothing, so `getSessionSafety` has no live
> caller either: `GET /:id/safety` — the endpoint with the fictitious
> `travelTimeMin: 20 / activityTimeMin: 30` probe (L293c) — is dark from the app.
>
> **A live defect the body missed, on the path the body scored as working
> (L74, L183):** the client renders "Add to plan" only when `rec.id` is set
> (`LayoverRecsSection.tsx:63,81`), and with `layover_safety_engine_enabled`
> TRUE every `GET /:id/recommendations` regenerated the cards by delete+insert
> without reading ids back (`LayoverRecommendationService.ts` pre-2410). **No
> production traveller has ever seen that control** — consistent with 0 plan
> stops — and `layover_plan_stops.recommendation_id` (ON DELETE SET NULL) was
> nulled on every dashboard load. Fixed behind `layover_stable_recommendation_ids_enabled`,
> seeded FALSE (2410); see §7.
>
> **Two open PRs cover rows this pass deliberately did not re-author:** #463
> (entry gate L48/L34/L230, fabricated travel time L293, unknown-leg plan fit
> L47, failed-airport-read L262/L294) and #469 (fail-closed blocks at 15 sites,
> one of them this file's buddies list). Both are "do not merge without an
> owner decision" and both now conflict with `9c26efba` in
> `LayoverSafetyEngine.ts` / `routes/airport.ts`. Their verdict deltas in §5
> stand, unrealised.

> ## RE-CENSUS HEADER — 2026-09-08 (second pass), measured at HEAD `743ae78f`
>
> | Field | Value |
> | --- | --- |
> | `generated_at` | 2026-09-08 |
> | `head_commit` | `b9bdcfc3c` — RE-DECLARED 2026-09-13 by the §13 build pass, which is the commit §13's verdicts were derived at and the second of the two commits that changed `services/airport/LayoverRecommendationService.ts`, `services/airport/LayoverSafetyEngine.ts`, `src/test/airport.test.ts`, `travel-buddy-standalone/app/layover/[id].tsx`, its component test and `travel-buddy-standalone/src/lib/safeNotifications.ts` under this census. **IT CARRIES THE SAME PRE-SQUASH HAZARD every value in this row has carried**: it is on `worktree-agent-a96f1481d064c0de6` and on no remote branch, so after a squash-merge it becomes an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. PREVIOUS VALUE, verbatim: `fa14590e5` — RE-DECLARED 2026-09-13 by the §12 build pass, which is the commit §12's verdicts were derived at and the commit that changed `routes/airport.ts`, `travel-buddy-standalone/src/services/layover.ts` and `travel-buddy-standalone/app/layover/[id].tsx` under this census. **IT CARRIES THE SAME PRE-SQUASH HAZARD every value in this row has carried**: it is on `worktree-agent-a4a1855c806a24d03` and on no remote branch, so after a squash-merge it becomes an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. PREVIOUS VALUE, verbatim: `af1864a7` — RE-DECLARED 2026-09-13 by the §11 build pass, which re-measured 37 rows and therefore owns this row; the previous value and its whole argument follow unchanged. `af1864a7` is the second of §11's two commits and is the commit its verdicts were derived at. **IT CARRIES THE SAME PRE-SQUASH HAZARD the paragraph below documents**: it is on `worktree-agent-a1965b10a690c9e97` and on no remote branch, so after a squash-merge it becomes an ancestor of nothing and this check will report the census as unreadable until whoever merges re-declares the squash sha. That is a known cost of declaring a branch commit, taken deliberately rather than leaving the row naming a commit four files older than the tree. PREVIOUS VALUE, verbatim: `42aeac38` — RE-DECLARED 2026-09-10 from `743ae78f305ea657ab508a34bdbc574488f4aae7` (§9 measured `cdfff5995c92f7adfb3ae7880496bc94002717e9`; §10 re-measured, at `743ae78f`, the rows a client lane could move). It was necessary because `743ae78f` is PRE-SQUASH — this repository squash-merges, so it is an ancestor of nothing, is on no remote branch, and `check:census-freshness` could resolve it only on the clone that wrote it (`CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI`). Reproduced 2026-09-10 in a fresh clone of this branch: `git diff 743ae78f..HEAD` aborts with `Invalid revision range`, and the check reported this census as unreadable rather than checking it. `42aeac38` is #476's squash, where this document's content reached `main`. **This is a RE-DECLARATION, not a re-measurement.** ONE counted file changed between `743ae78f` and `42aeac38`: `artifacts/api-server/src/services/airport/LayoverPrivacyGuard.ts`. The move is defensible only because each was re-verified mechanically on 2026-09-10 over `743ae78f..42aeac38`: filtered to lines that are neither comment nor blank, that diff is EMPTY against a `--stat` of 7 insertions and 4 deletions — the edit updates the file's header note to record that the `TripCrewLocationService` read it had flagged is now fail-closed. No statement, signature, condition or constant moved, so no layover verdict can have. The full per-file argument is preserved under `retired` in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`, where it had been written as an acknowledgement. **Changed by the Trips lane, not this one**, because CI could not run this check against this census at all until it was; nothing else in this document is touched, and reverting it costs only the check. |
> | `methodology_version` | 2 — **the §1 denominator rule is unchanged and the denominator is still 296.** Bucket meanings unchanged (`C` / `W` / `N` / `?`, `⌀` vacuous, `∅` unguarded absence). Only the verdicts moved, and every verdict that moved cites a `file:line` opened at this commit. |
> | Scanned | `artifacts/api-server/src/services/airport/` (14 files, 5,896 lines), `artifacts/api-server/src/routes/airport.ts` (2,452 lines), `artifacts/api-server/src/migrations/2700`, `2740`, `2741`, `artifacts/api-server/src/test/layover*.test.ts` (21 files), `travel-buddy-standalone/src/services/layover.ts`, `travel-buddy-standalone/app/layover/[id].tsx`, `travel-buddy-standalone/src/components/layover/`, `artifacts/api-server/src/lib/deletionDispositions.ts` |
> | Production state | Read from the repository's own committed artifacts, not from a live query: `src/lib/capability/snapshots/20260908-production-schema.json` (watermark `20260908133347`) for tables and flags, `src/lib/capability/production-applied-migrations.json` for applied migrations, `src/lib/capability/layover-cutover-measurement.json` for row counts. 5 sessions (2 cancelled, 3 expired, 0 active), 42 events, 30 recommendations, **0 plan stops**, 3,206 `airport_profiles` — 0 verified, 0 with `terminal_info`. |
>
> ### Headline, side by side
>
> | Measure | Body (`68ed59d9`) | §7/§8 **as stated** | §7/§8 **as its rows read** | **Now (`cdfff599`)** |
> | --- | ---: | ---: | ---: | ---: |
> | Denominator | 296 | 296 | 296 | **296** |
> | BUILT-AND-CORRECT (`C`) | 10 | 20 | 20 | **25** |
> | BUILT-BUT-WRONG (`W`) | 83 | 87 | 90 | **123** |
> | NOT-BUILT (`N`) | 202 | 189 | 186 | **148** |
> | CANNOT-VERIFY (`?`) | 1 | 0 | 0 | **0** |
> | CONSTRUCTED% | 31.4 % | 36.1 % | 37.2 % | **50.0 %** (148 / 296 = 50.0 %) |
> | CORRECT% raw | 3.4 % | 6.8 % | 6.8 % | **8.4 %** (25 / 296 = 8.4 %) |
> | CORRECT% non-vacuous | 2.7 % | 6.1 % | 6.1 % | **7.4 %** (22 / 296 = 7.4 %) |
> | CORRECT% spec-attributable | 0.0 % | 2.0 % | 2.0 % | **3.7 %** (11 / 296 = 3.7 %) |
>
> **The two §7/§8 columns differ, and that is a finding, not a rounding.** §7's
> "Corrected §6 summary" carries a Total row of 20 / 87 / 189 that is **not** the
> sum of this document's own verdict rows; read row by row, the same document
> says 20 / 90 / 186. The `C` figure is right and the `W`/`N` split was carried
> by hand. The **Now** column is derived from the rows, which is the only form
> another censor can reproduce — and §9.5 below makes every one of the 296 rows
> machine-readable so the arithmetic can be re-run rather than believed.
>
> Three `C` verdicts are vacuous (`⌀`): **L51** (no security-wait input exists),
> **L136** and **L138** (real fail-closed guards over a crew feature that has no
> storage and no route). **L52 loses its `⌀`** — a certified envelope now exists
> and the property is swept over it (`src/test/layoverFeasibilityInvariants.test.ts:180`).
>
> ### Read the CONSTRUCTED jump correctly
>
> **CONSTRUCTED rose 12.8 points — 37.2 % to 50.0 %, both derived from this
> document's own rows — and almost none of it is visible to a traveller.** 35 requirements moved `N → W`. Of those, **28 are code with no
> caller outside `src/test/`** — the twelve §12 Compass tools, the seven §14/§14.1
> crew-solver requirements, the §15.2 disruption machine, §16's `localReplan` and
> `sensingPolicy`, `replayFeasibility`. Of the 7 that ARE wired into a live route,
> **0 are consumed by the client**: the app's own `LayoverOverview` type
> (`travel-buddy-standalone/src/services/layover.ts:161-171`) carries no
> `certification`, no `safeReturn`, no `offlineBundle` and no `presence` field,
> and there is no client function for `POST /airport/sessions/:id/return-now`
> anywhere in that file. Nothing a traveller sees changed.
>
> **Three flags and two migrations hold the rest down**, and each is stated where
> it applies rather than averaged away:
> - `2700_layover_certified_feasibility.sql` — **written, NOT applied.** There is
>   nowhere to put a certified record, so L1, L5, L6, L191 and L209 stay `W`/`N`.
> - `2740_layover_presence_ladder_flag.sql` — **written, NOT applied**, so
>   `layover_presence_ladder_enabled` has no row and `isFlagEnabled` fails closed.
>   Aggregate-first presence (L128) is built and OFF.
> - `layover_safe_return_status_enabled` = **FALSE** in production
>   (`snapshots/20260908-production-schema.json`), so `returning` is legal
>   (2741 applied `20260908133347`) and is never written.
> - `layover_stable_recommendation_ids_enabled` = **FALSE**
>   (`layover-cutover-measurement.json`), unchanged since §7.
>
> ### One thing this file previously got wrong
>
> **L163's evidence was false.** It said `layover_events` and `layover_sessions`
> are "at least covered by the erasure cascade (`lib/deletionDispositions.ts:356-357`)".
> Those lines are inside **`UNCLASSIFIED_BACKLOG`** (`src/lib/deletionDispositions.ts:270`,
> entries at `:370-371`), whose own header says "the data survives deletion and no
> one has said whether it should" (`:35-38`). `layover_plan_stops` and
> `layover_recommendations` are in `DENOMINATOR_CORRECTION_BACKLOG` (`:544`,
> entries `:571-572`) and `airport_profiles` is also in `UNCLASSIFIED_BACKLOG`
> (`:281`). `AccountDeletionService.ts` names no layover table. **No layover row
> is erased by account deletion today.** The verdict stays `W`; the reason is
> worse than written. This is the same miscitation the Highlights census made at
> H84, from the same file — see `census-highlights-memories.md` §A.



| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt` (v3.0), `.docx` original authoritative |
| **Tree censused** | `claude/portava-continuation-uqta94`, HEAD `68ed59d9`, 2026-09-07. **Verdicts are about MAIN.** Open PR #463 is censused separately in §5 below. |
| **Method** | Requirement-level, four buckets, exactly one bucket per requirement. Every BUILT verdict cites a file:line that was opened and read. |
| **Database** | Not queried. Storage facts are the ones supplied as ground truth: `layover_events`, `layover_plan_stops`, `layover_recommendations`, `layover_sessions` and `airport_profiles` are all deployed in production `ajrurzioarfkagpuxfnb`. |
| **First census** | This spec has never been censused. There is no prior number to agree or disagree with. |

**The `.txt` and the `.docx` are identical after whitespace normalisation.** I extracted
`word/document.xml`, stripped tags, collapsed whitespace and compared line-by-line: 837
non-empty lines each side, **zero diff lines**. The `.docx`-is-authoritative clause never had to
be exercised, and nothing below rests on a transcription difference.

Backend paths are relative to `artifacts/api-server/src/`, client paths to
`travel-buddy-standalone/` unless stated. `pr/463:` prefixes a path as it exists on that branch.

---

## Headline

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **296** |
| BUILT-AND-CORRECT | **10** |
| BUILT-BUT-WRONG | **83** |
| NOT-BUILT | **202** |
| CANNOT-VERIFY | **1** |
| **CONSTRUCTED%** = (10+83)/296 | **31.4 %** |
| **CORRECT%** (raw) = 10/296 | **3.4 %** |
| **CORRECT% (spec-attributable)** = 0/296 | **0.0 %** |
| CANNOT-VERIFY share | 1/296 = 0.3 % |

Two of the ten BUILT-AND-CORRECT verdicts are **vacuous** (`⌀` — the guard is real but the path
it guards is empty). A reader who rejects vacuous satisfaction should read **8/296 = 2.7 %**.

**The briefed section count is wrong.** The brief says 114 numbered sections. The spec has
**27 top-level numbered sections, 17 numbered subsections and 3 appendices = 47 headings.**
Verified by heading extraction (`grep -nE '^[0-9]+\.[0-9]*\s|^Appendix [A-C]\.'` after removing
in-section numbered list items): §1–§27, plus §2.1 §4.1 §6.1 §6.2 §8.1 §9.1 §10.1 §11.1 §12.1
§14.1 §15.1 §15.2 §17.1 §19.1 §21.1 §21.2 §26.1, plus Appendices A, B and C. There is no reading
of the document that yields 114 sections. It is nevertheless the largest spec in the corpus by
testable-requirement count (296 vs Wall's 205 and Sensing's 127), which is presumably what the
brief was reaching for.

### The one sentence that matters

**Layover's tables are deployed and its code runs, and almost none of what this specification
asks for is in either.** The tree contains a real, coherent, shipped *airport-layover assistant*
— a buffer calculator, a tiered "can I leave" verdict, a mini-itinerary, a city-level presence
list and an LLM Q&A endpoint. The spec asks for a *Temporal Freedom Engine with a certified
snapshot lifecycle*: constraints, time budgets, return plans, immutable versioned snapshots,
checkpoints, canonical external events, crews, outcomes, a decision ledger, reason codes,
provenance, confidence bands and a replanner. Of the twelve canonical tables §4 names, **four
exist and eight do not**, and the four that exist share only their names with the spec's columns.

The deployed-storage fact makes this the most important discipline in this census, exactly as
briefed. Presence looks like completeness. It is not:

- `layover_sessions.status` is a four-value CHECK (`active|completed|cancelled|expired`), not
  the spec's seventeen-member `LayoverState` — and **`completed` is unreachable.** The only
  endpoint that closes a session passes the literal `"cancelled"`
  (`routes/airport.ts:1532`). No code path anywhere writes `'completed'`. The entire
  return/re-entry/boarding/completion half of the lifecycle has no writer.
- `layover_events` is deployed and written on every session action, but it is an **in-app UI
  audit trail**, not the spec's canonical event envelope. Its `event_type` CHECK lists eighteen
  things the user did in the app (`0127:198-208`). None of `flight.*`, `airport.*`,
  `mobility.*` or `weather.*` exists, and the table has no `occurred_at`, `source`,
  `source_event_id`, `dedup_key` or `processed_at`.
- `layover_recommendations` is deployed and written, but carries no `snapshot_id`, no
  `risk_band`, no `confidence`, no `utility_score` and no `expires_at`; its `status` vocabulary
  is `active|hidden|flagged` — moderation states, not the spec's
  `ELIGIBLE|TIGHT|BLOCKED|STALE|EXPIRED`.

### Four defects found by reading, worth acting on independently of the spec

1. **A one-minute-earlier departure can move the hard return deadline nine minutes LATER.**
   `timeOfDayExtra` (`services/airport/LayoverSafetyEngine.ts:49-53`) is a step function on the
   airport-local hour: `>=22 || <6 → 20`, `>=20 || <8 → 10`, else `0`. `hardReturnTime = cutoff −
   totalBuffer`. Move a 20:00 departure to 19:59 and the buffer drops by 10 while the cutoff
   drops by 1, so the deadline moves **+9 minutes later** and `usableMinutes` grows by 9. Same at
   the 22:00 boundary. This is §6.1's *"departure_time earlier must never expand safe_envelope"*
   violated by arithmetic, on a live surface, with no test covering it.
2. **`GET /airport/sessions/:id/safety` returns two different buffers in one response.**
   `returnBufferMin` comes from `assess()`, which computes the buffer at
   `new Date(session.departureTime)` (`LayoverSafetyEngine.ts:90`); `hardReturnTime` comes from
   `computeWindow()`, which computes it at `new Date(cutoffMs)` where cutoff is
   `boardingTime ?? departureTime` (`:244`). When boarding time is set and falls in a different
   hour band, the two disagree and the endpoint publishes both (`routes/airport.ts:610-611`).
3. **`layover_recommendations`' RLS policy has no `WITH CHECK`.** `0127:144-151` is
   `FOR ALL … USING (session_id IN (SELECT id FROM layover_sessions WHERE user_id = auth.uid()))`
   with no check clause; PostgreSQL then reuses `USING` as the write check, so a session owner
   who can reach the table through PostgREST may insert or update their own recommendation rows
   and set `safety_rating`, `return_buffer_min` and `hard_return_time` to anything. The sibling
   table `layover_plan_stops` in the *same migration* has both clauses (`0127:179-190`). Whether
   this is reachable depends on the table-level grant to `authenticated`, which is production
   state — this is the census's single CANNOT-VERIFY.
4. **Four shipped components and one shipped endpoint are dead code.**
   `components/layover/LayoverReturnPanel.tsx` (240 lines: the countdown, "Set Reminder", the
   "Safe Return" button and the Ask-Compass panel) is imported by nothing — the dashboard
   (`app/layover/[id].tsx:38-45`) does not mount it. Because it is the only caller of
   `askCompass`, **`POST /api/airport/sessions/:id/compass` has no client caller at all.**
   `LayoverSafetyEngine.rankActivities` (`:148-170`), `LayoverPrivacyGuard.sanitizeNearbyTraveler`
   (`:108-132`) and `LayoverPrivacyGuard.isSharingAllowed` (`:134-142`) are referenced only from
   `test/airport.test.ts`. `isSharingAllowed` is the Ghost-Mode / location-off / sharing-paused
   gate that `LayoverPrivacyGuard.ts:1-6` claims the module "enforces"; the live presence path
   (`routes/airport.ts:909-971`) never calls it.

---

## 1. Denominator: how 296 was counted

One requirement = one independently testable assertion — something that could be **falsified by
reading this tree**. The rule, stated so it can be re-applied:

- **A bullet that asserts a required property, behaviour or prohibition = 1.** (§2.1's eight
  architecture rules; §6.1's seven invariants; §8's eight geometry rules; §10.1's five
  contradiction rules; §13's six map rules.)
- **A table row that names a required artifact, condition or behaviour = 1.** §3's nine domain
  rows are nine; §4's twelve canonical tables are twelve; §8.1's six robustness signals are six;
  §16's seven offline capabilities are seven; §21.1's fifteen scenarios are fifteen; §25's eleven
  integration points are eleven; Appendix A's fifteen reason codes are fifteen.
- **A declared interface = 1**, unless a member carries independent behaviour, in which case the
  member is counted separately. §18's service methods each name a distinct operation, so they
  count individually (23 after merges); §12's twelve Compass tools likewise. `Estimate`,
  `Commitment`, `FreedomWindow`, `TruthValue<T>`, `ExperiencePrimitive`,
  `LayoverRecommendationContract` and `DecisionRecord` are one each, because their members are
  fields of one contract rather than separate behaviours.
- **A named enum = 1** (§4.1's six).
- **A numbered pipeline step = 1** (§11.1's eight; §19's eight migration steps).
- **Narrative, diagrams, rationale and restatement = 0.**

**Excluded, and why.**

- **§2's scope paragraph** ("The first production scope covers connection detection…") is a
  forward summary of §5–§17. Counting it would double-score eleven capabilities. **0.**
- **§3's ASCII context diagram** and §5's ASCII state graph as *drawings* are 0; the §5 graph is
  counted once as "the state machine exists with these states".
- **§26 Delivery phases** and **§26.1 implementation order** are process and re-list §4/§5/§6/
  §11/§19/§20 deliverables. **0.**
- **§27 Definition of done**: all twelve bullets restate requirements already counted (DoD-1 ≡
  §2.1-4, DoD-2 ≡ §19.1, DoD-3 ≡ §6.1, DoD-4 ≡ §6.1+§6.2, DoD-5 ≡ §11.1, DoD-6 ≡ §16, DoD-7 ≡
  §14.1, DoD-8 ≡ §19-8, DoD-9 ≡ §21.2, DoD-10 ≡ §21.1, DoD-11 ≡ §22, DoD-12 ≡ §2.1-8). **0.**
- **Appendix B**'s three worked sessions are illustrations. **0.**
- **Appendix C**: ten of its fourteen rules restate §2.1/§6.1/§8/§9.1/§12/§14.1/§20/§21.2/§24.
  Only C1, C2, C3 and C5 assert something not already counted. **4.**

**Merges (same assertion, one id).** §9.1's *"Commercial/sponsored value may only be considered
after the hard gate"* ≡ §2.1 rule 5 ≡ Appendix C7 → one id (L7). §18's `simulate` ≡ §12's
`simulatePlan`; §18's `replan` ≡ §12's `replan`; §18's `discover` ≡ §12's `getCrewCandidates`
→ the §12 tool ids survive, the three §18 methods are dropped. Four ids removed in total.

**Per-section contribution:** §1 2 · §2.1 8 · §3 9 · §4 13 · §4.1 6 · §5 6 · §6 2 · §6.1 7 ·
§6.2 2 · §7 4 · §8 8 · §8.1 6 · §9 3 · §9.1 2 · §10 6 · §10.1 5 · §11 2 · §11.1 8 · §12 14 ·
§12.1 1 · §13 12 · §14 6 · §14.1 7 · §15 6 · §15.1 2 · §15.2 2 · §16 8 · §17 6 · §17.1 5 ·
§18 23 · §19 8 · §19.1 6 · §20 12 · §21 1 · §21.1 15 · §21.2 9 · §22 8 · §23 8 · §24 8 · §25 11 ·
App A 15 · App C 4 = **296**.

### The rule for prohibitions

Much of §2.1, §10.1, §14.1, §17.1 and §23 is prohibition. Applied uniformly:

- **BUILT-AND-CORRECT** when a concrete artifact makes the violation unrepresentable or refuses
  it — a type, a CHECK, an explicit strip, a fail-closed branch. Citation required.
- **NOT-BUILT (`∅`, "unguarded absence")** when the forbidden path simply does not exist and
  nothing guards against it being added. The guarantee is not constructed; it is merely currently
  unviolated.
- **`⌀` (vacuous)** marks a BUILT-AND-CORRECT verdict where the guard is real but the path it
  guards is empty. Two verdicts carry it (L51, L52).

### Method caveat, inherited

`src/scripts/checkWriterlessReads.ts:1-40` declares its own writer attribution **INCOMPLETE** and
erring toward silence, because a `from(expr)` with a variable defeats static attribution. Every
"nothing writes X" / "nothing calls Y" claim below was settled by opening the call sites, not by
counting greps. The four dead-code findings in the headline were each confirmed by reading the
importing files: `app/layover/[id].tsx:38-45` (no `LayoverReturnPanel` import) and
`test/airport.test.ts:27,40,41` (the only importers of `rankActivities`,
`sanitizeNearbyTraveler`, `isSharingAllowed`).

---

## 2. Attribution: is any of this built FOR this spec?

**No. Spec-attributable CORRECT% = 0/296 = 0.0 %.** This makes three of five completed censuses
in this corpus that return zero attributable work.

The test, run over the whole tree and over PR #463:

```
git grep -lniE "Layover_Development_Architecture|Temporal Freedom|LayoverSnapshot|
                Experience Compiler|Real-World Orchestration|layover spec" HEAD -- '*.ts' '*.tsx' '*.sql' '*.md'
→ HEAD:docs/architecture/census-sensing.md          (a sibling census, not an artifact)

… same expression against pr/463 → (no matches)
```

No source file, migration, test or doc in the tree cites this specification, its section numbers,
or any of its coined names (`LayoverSnapshot`, `SafeEnvelope`, `FreedomWindow`, `Commitment`,
`TruthValue`, `ExperiencePrimitive`, `LayoverRecommendationContract`, `DecisionRecord`,
`OpportunityEvent`, `AirportTruthService`, `LayoverReplanner`, `LayoverDecisionService`).

Every BUILT verdict below traces to a **different, self-describing programme**:

| Programme | Evidence it is not this spec | What it produced |
| --- | --- | --- |
| **"Layover Mode" feature build** | `replit.md:99#timeOfDayContext` describes it in its own terms as an *"end-to-end system behind feature flags (migration 0127…)"*, with its own vocabulary — window tiers, hard-return anchored on boarding cutoff, `timeOfDayContext`. No spec reference. | `0127_layover_system.sql`, `services/airport/*`, `routes/airport.ts`, `app/layover/[id].tsx`, `components/layover/*` |
| **The repair of the never-applied 0044** | `0127:1-14` states its own purpose: *"The original 0044_airport_layover.sql lived only in the stale migrations dir and was never applied … its feature-flag seed used a nonexistent `key` column."* A schema-repair errand, not a spec build. | the five deployed tables and their flag seeds |
| **Repo-wide safety programmes** (fail-closed flags, delayed-publish, block filtering, name visibility, deletion dispositions, location purposes) | Each names its own ruling in-file: `routes/airport.ts:29-37` (the fail-open `isFlagEnabled` shadow deletion), `:1470-1481` (§23/§37 delayed-publish gate), `lib/locationPurposes.ts:315-321` | the correctness that exists in `routes/airport.ts` |
| **Passport / Rent-a-Buddy / Telegraph / Hidden Gems** | Their own specs and services, consumed by Layover as an integration | `createStamp`, `rent_buddy_profiles` read, `detectIntent`, `/hidden-gems/layover-safe` |

PR #463 is the closest thing to spec-aligned work in the corpus — it independently reinvents §6.1's
entry gate and Appendix C1's no-substitution rule — but its commit message
(`599155f9`) argues from the code's own defects and cites migration 0169 and this repo's own
honesty contract, never this document. It is not attributable either.

---

## 3. Requirement-by-requirement

Verdict key: **C** = BUILT-AND-CORRECT · **W** = BUILT-BUT-WRONG · **N** = NOT-BUILT ·
**?** = CANNOT-VERIFY · `⌀` vacuous satisfaction · `∅` unguarded absence.
Rows marked **[463]** change verdict under PR #463 — see §5.

### §1 Architectural mandate

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L1 | A dedicated Layover domain with **one canonical operational truth** | W | The domain exists — `services/airport/` (8 modules), `routes/airport.ts` (1883 lines), four tables. The canonical truth does not: nothing is persisted as a certified computation. Feasibility is recomputed from scratch at four call sites (`routes/airport.ts:573` safety, `:721` return-deadline, `:1026` overview, `:1113` stops) and again inside `LayoverCompassService.ts:51-54`. Two of them use different buffer inputs — see headline defect 2. |
| L2 | The Layover domain owns the active session and **publishes certified outputs**; no other surface owns feasibility | W | Session ownership is real and single-writer (`LayoverSessionService.ts:111-345`). "Certified" is not: no output carries a version, an engine version, an input hash or a confidence. And the client re-derives a second feasibility judgement of its own — `components/layover/LayoverReturnPanel.tsx` lines 113-114 (`usableMinutes < 30` / `< 60`) — **the file was deleted at `a718beb5`; see §10 L2, where this row closes** — with thresholds that appear nowhere on the server. |

### §2.1 Non-negotiable architecture rules

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L3 | Hard safety constraints are deterministic and cannot be overridden by Compass/LLM output | W | The deterministic engine is genuinely LLM-free and the *fields* returned to the client are server-computed (`LayoverCompassService.ts:124-131`). But the **prose** is the answer surface, and it is constrained only by prompt instructions (`:71-79`) and post-processed only for coordinate patterns (`LayoverPrivacyGuard.ts:100-106`). Nothing checks the prose against the deterministic verdict, so "you have plenty of time" ships next to a `not_recommended` note without contradiction being detected. |
| L4 | Unknown critical facts reduce confidence and may fail closed for landside recommendations | N | There is no confidence concept anywhere in `services/airport/`. Unknown entry is a sentence in `unknowns[]` attached to `verdict: "yes"` (`LayoverSafetyEngine.ts:302-304, 323-327`); unknown baggage is unrepresentable (L35). **[463]** |
| L5 | Every consequential recommendation is versioned, explainable and replayable | N | `layover_recommendations` has no version, snapshot, engine-version or input-hash column (`0127:106-138`), and rows are deleted wholesale and re-inserted on read (`LayoverRecommendationService.ts:645-650#layover_recommendations").delete()`, triggered from `routes/airport.ts:806-807#isSafetyEnabled`). Nothing can be replayed. |
| L6 | All surfaces consume the same certified `LayoverSnapshot`/`RecommendationContract`; **no duplicate time-budget logic** | W | One shared library exists (`computeBuffer`), which is real progress — but there are three independent *uses* of it with different inputs (`LayoverSafetyEngine.ts:90` departure-based, `:247` cutoff-based, `LayoverCompassService.ts:51` departure-based) plus the client's own thresholds (`LayoverReturnPanel.tsx` line 114, **deleted at `a718beb5`**). No snapshot exists for surfaces to share. |
| L7 | Commercial ranking only after eligibility, safety and time feasibility (≡ §9.1, ≡ App C7) | N ∅ | No commercial input reaches the recommendation path at all — a grep of `services/airport/` and `routes/airport.ts` for `sponsored`/`promoted`/`is_paid`/`boost` returns nothing. But there is no gate either: ordering is `verified`-first plus time-of-day (`LayoverRecommendationService.ts:440-442#verified places lead`), and the one safety-first comparator that exists, `rankActivities` (`LayoverSafetyEngine.ts:532-546#export function rankActivities`), is dead code. Unguarded absence. |
| L8 | Precise social location is opt-in, temporary and automatically expires | C | Concrete artifact: layover presence structurally cannot carry a coordinate. `cityPresence` selects `user_id, manual_city, airport_profiles(city)` and nothing else (`routes/airport.ts:1434#manual_city`); `SafeRecommendation` has no lat/lng field at all (`LayoverPrivacyGuard.ts:31-52`). Opt-in: `share_city_status BOOLEAN NOT NULL DEFAULT FALSE` (`0127:82`). Temporary: presence is filtered on `status='active' AND departure_time > now()` (`routes/airport.ts:1438#departure_time`) and `expireOldSessions` flips the status (`LayoverSessionService.ts:327-345`). |
| L9 | Missing live intelligence degrades **visibly** to historical/conservative fallback; never fabricate freshness | W | The fallback ladder is real (DB row → `STATIC_AIRPORTS` → `buildFallbackProfile`, `services/airport/AirportProfileService.ts:37-68`), but it is invisible: `publicAirport` (`routes/airport.ts:830-843`) exposes only a `verified` boolean, rendered as a badge (`components/layover/LayoverHero.tsx:48#verified`), and a generic-buffer session is indistinguishable from a curated one. Worse, freshness is *fabricated*: `estimateTravelTime(placeType)` returns 15 or 25 minutes without reading a coordinate (`LayoverRecommendationService.ts:212-216`) and that number becomes a "safe" rating. **[463]** |
| L10 | The system optimises successful real-world action and safe completion, not screen time | N | Nothing measures completion. `layover_outcomes` does not exist, `status='completed'` is never written (`routes/airport.ts:1532` is the only close and passes `"cancelled"`), and no metric of any kind is emitted (§20 below). The system cannot distinguish a safe return from an abandonment. |

### §3 System context and domain boundaries

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L11 | **Trips** owns flight segments / itinerary relationships / trip context; must not own layover safety calculations | W | The must-not-own half holds — no safety arithmetic lives in trip code. The owns half does not: there is no flight-segment model anywhere, the session takes raw typed wall times (`routes/airport.ts:194-222`), and the link is a mirrored summary row in `trip_plan_items` (`:143-179`), not a segment relationship. |
| L12 | **Layover Session** owns lifecycle, constraints, snapshots and state; must not own a generic city content catalog | W | The boundary holds cleanly: candidates are read from the existing `discovery_places` (`LayoverRecommendationService.ts:156-201`), no catalog is forked. But it owns no constraints (L22) and no snapshots (L25), and its lifecycle is four states of which one is unreachable (L33). |
| L13 | **Temporal Freedom Engine** owns usable time / next commitment / freedom window; must not own LLM prose | N | No such domain. `computeWindow` (`LayoverSafetyEngine.ts:232-281`) takes `AirportProfile` and `LayoverSession` directly and knows nothing of commitments; there is no engine that owns "next commitment". |
| L14 | **Airport Intelligence** owns airport operational facts + **provenance + TTL**; must not own user social identity | W | `airport_profiles` holds operational facts and no social identity — boundary holds. It holds no provenance and no TTL: every column is a bare value (`0127:17-41`), `terminal_info JSONB DEFAULT '{}'` (`:27`) has no writer, and `verified BOOLEAN` (`:37`) is the only quality signal. |
| L15 | **Experience Compiler** owns executable plans from feasible actions; must not own visa/entry legal truth | W | `layover_plan_stops` plus `computePlanFit` (`routes/airport.ts:886-901`) is a plan model, and it correctly holds no legal truth. But nothing else owns entry truth either: on main, no file under `routes/airport.ts` or `services/airport/` reads `entry_requirements` or `traveler_passports`. **[463]** |
| L16 | **Compass** owns conversation, explanation, preference, tool orchestration; **must not own return deadlines or safety overrides** | C | The prohibition is structurally enforced: `answerLayoverQuestion` computes `hardReturnTime` itself from `computeBuffer` and returns *its own* value (`LayoverCompassService.ts:51-68, 127`); the model's output reaches only the `answer` string. There is no path by which model text becomes a deadline. (The absent tool-orchestration half is scored at L102–L113.) |
| L17 | **Map** visualises the certified envelope / recommendations / routes; must not own independent feasibility logic | W | The boundary holds — `components/layover/LayoverMapCard.tsx:28-64` takes `airport` and `stops` as props and computes nothing. It also visualises nothing the requirement names: no envelope, no route, no per-pin feasibility; every stop becomes `category: 'activity'` (`:53-59`). |
| L18 | **Safe Return** owns escalation, return-state UX, notification priority; must not recompute core feasibility | W | `shouldSuggestSafeReturn` (`services/airport/LayoverNotificationService.ts:26-52`) produces suggestion reasons at session creation only (`routes/airport.ts:440-447`) and recomputes nothing — boundary holds there. But there is no escalation ladder and no notification priority, and the UI *does* recompute a risk judgement of its own (`LayoverReturnPanel.tsx` lines 114-115, **deleted at `a718beb5`**). |
| L19 | **Passport / Memory** owns post-session durable artifacts **if the user chooses**; must not own temporary operational location data | W | The boundary holds — the stamp carries a city name only (`routes/airport.ts:456-460`). But it fires at session **creation**, not post-session, and the only gate is the `passport_stamps_enabled` flag (`:453`); the user never elects it. |

### §4 Canonical domain model

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L20 | Normalised operational tables + **immutable/versioned snapshots**; no single JSON blob as source of truth; JSON only for provenance/reason detail | W | The normalisation half is done right: five typed tables, no JSON blob as truth, `metadata JSONB` confined to event detail (`0127:209`). The snapshot half is entirely absent. |
| L21 | `layover_sessions` (id, user_id, trip_id, airport_place_id, arrival/departure_segment_id, **state**, connection_type, detected_source, started_at, expires_at, **active_snapshot_id**, **confidence_band**) | W | Deployed (`0127:53-89`). Present: id, user_id, trip_id, an airport ref. Absent: `arrival_segment_id`, `departure_segment_id`, `connection_type`, `detected_source`, `expires_at`, `active_snapshot_id`, `confidence_band`. `status` (`:85-86`) is not `state`. |
| L22 | `layover_constraints` (terminals, immigration/customs, baggage_mode, recheck, airport_change, entry_permission_state, mobility_profile, buffer_profile, minimum_boarding_buffer, **critical_unknowns_json**, version) | N | No such table. Two of its eleven concepts survive as booleans on the session (`immigration_required`, `checked_bags`, `0127:69-70`). Terminals, baggage mode, airport change, entry state, mobility profile, buffer profile and critical unknowns have no representation anywhere in the tree. |
| L23 | `layover_time_budgets` (per-snapshot deplane/immigration/baggage/exit/outbound/return/security/transfer/boarding/contingency/usable minutes) | N | The breakdown is computed per request and returned in the response body (`LayoverSafetyEngine.ts:56-72` returns a struct; `routes/airport.ts:613` serialises it). No writer, no table. |
| L24 | `layover_return_plans` (hard_return_by, recommended_return_by, latest_activity_departure_at, risk_band, confidence, reason_codes_json) | N | `layover_sessions.return_reminder_at` (`0127:84`) stores one reminder instant set by the user's tap. None of the six fields exists. |
| L25 | `layover_snapshots` (version, input_hash, computed_at, engine_version, safe_envelope_ref, candidate_set_version, sources_json, reason_codes_json) | N | Absent. This is the spec's central artifact. |
| L26 | `layover_recommendations` (snapshot_id, candidate_type, status, plan_json, utility_score, risk_band, confidence, expires_at) | W | Deployed (`0127:106-138`). `rec_type` ≈ candidate_type with a different nine-value vocabulary (`:109-115`); `place_id`/`plan_item_id` stand in for candidate_id. Absent: `snapshot_id`, `plan_json`, `utility_score`, `risk_band`, `confidence`, `expires_at`. `status` is `active|hidden|flagged` (`:132-134`). |
| L27 | `layover_presence` (visibility_scope, available_from/until, intents_json, max_travel_minutes, precise_location_enabled, expires_at) | N | One boolean, `share_city_status` (`0127:82`). None of the six fields exists. |
| L28 | `layover_crews` | N | Absent. |
| L29 | `layover_crew_members` | N | Absent. |
| L30 | `layover_checkpoints` | N | Absent. No checkpoint is ever observed or recorded. |
| L31 | `layover_events` (occurred_at, source, source_event_id, payload_json, **dedup_key**, processed_at) | W | Deployed and written (`0127:194-211`; writer `LayoverSessionService.ts:94-108`). It is an in-app audit trail: eighteen UI-action `event_type` values (`:198-208`), plus `metadata JSONB`. Absent: `occurred_at` (only `created_at`), `source`, `source_event_id`, `dedup_key`, `processed_at`. |
| L32 | `layover_outcomes` (completed_at, left_airport, completed_experience, met_people_count, actual_airport_return_at, boarding_outcome, comfort_rating, plan_change_reason, anonymization_state) | N | Absent, and unreachable in principle: nothing ever marks a session completed. |

### §4.1 Core enums

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L33 | `LayoverState` — 17 members from `DETECTED` to `EXPIRED` | W | `status TEXT … CHECK (status IN ('active','completed','cancelled','expired'))` (`0127:85-86`) — four values, and `'completed'` has no writer (`routes/airport.ts:1532`). Thirteen of the spec's states, including every one that carries operational meaning (`EVALUATING`, `LANDSIDE_AVAILABLE`, `EXECUTING`, `RETURN_SOON`, `RETURN_NOW`, `RETURNING`, `AIRPORT_REENTERED`, `BOARDING`, `DISRUPTED`), do not exist. |
| L34 | `EntryPermissionState = CONFIRMED_ALLOWED \| CONFIRMED_NOT_ALLOWED \| UNKNOWN` | N | No entry state of any kind on main. **[463]** |
| L35 | `BaggageMode = CHECKED_THROUGH \| COLLECT_RECHECK \| CARRY_ON_ONLY \| UNKNOWN` | W | `checked_bags BOOLEAN NOT NULL DEFAULT FALSE` (`0127:70`) collapses four states into two and destroys `UNKNOWN` — the exact distinction the spec calls decisive in §12.1 and works through in Appendix B.2. A traveller who does not know is recorded as *not having checked bags*, the optimistic reading. |
| L36 | `RiskBand = LOW \| MODERATE \| HIGH \| UNSAFE` | W | `SafetyRating = "safe" \| "possible_but_risky" \| "not_recommended" \| "airport_only"` (`LayoverSafetyEngine.ts:11-15`). Four values, but a different axis: there is no `UNSAFE` band, and `airport_only` encodes a user *preference* (`:113-115`), not a risk level. |
| L37 | `ConfidenceBand = HIGH \| MEDIUM \| LOW \| INSUFFICIENT` | N | No confidence value is computed, stored or returned anywhere under `services/airport/`. |
| L38 | `RecommendationStatus = ELIGIBLE \| TIGHT \| BLOCKED \| STALE \| EXPIRED` | W | `status … CHECK (status IN ('active','hidden','flagged'))` (`0127:132-134`) — a moderation vocabulary, consumed by the admin report queue (`routes/airport.ts:1829-1880`). Eligibility has no status; it lives in `safety_rating`, which never blocks anything (L50). |

### §5 State machines

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L39 | The declared state graph (DETECTED → … → COMPLETED, plus DISRUPTED/CANCELLED/EXPIRED) | N | See L33. The only transitions implemented are `active → cancelled` (`LayoverSessionService.ts:196-219`) and `active → expired` (`:327-345`). |
| L40 | `EVALUATING → LANDSIDE_AVAILABLE`: guard = entry allowed + no critical unknowns + usable ≥ floor + return contract satisfiable; side effects = create snapshot + safe envelope + candidate set | N | No state, no guard, no snapshot, no envelope. The nearest analogue is an inline ternary: landside candidates are fetched when `session.wantsToLeave && session.layoverMinutes >= 90` (`LayoverRecommendationService.ts:244-246`) — a *scheduled* window threshold, not usable time, and entry is not consulted. |
| L41 | `EXECUTING → RETURN_SOON`: threshold reached or risk worsened; side effects = high-priority notification, de-emphasise discovery | N | Neither state exists. The only return signal is one client-scheduled OS notification at a fixed 30 minutes, requested by an explicit tap (`app/layover/[id].tsx:167-191`). |
| L42 | `RETURN_SOON → RETURN_NOW`: latest safe activity departure reached; side effect = switch primary CTA to *Return to Airport* | N | No CTA ever switches. The dead `LayoverReturnPanel.tsx` line 114 (**deleted at `a718beb5`**) changed a panel colour under 30 usable minutes; the mounted dashboard footer keeps "Remind me / Telegraph / End layover" throughout (`app/layover/[id].tsx:333-357`). |
| L43 | `RETURNING → AIRPORT_REENTERED`: checkpoint confirms re-entry; side effect = stop landside discovery, refresh gate/security | N | No checkpoint model (L30), no gate data. |
| L44 | `* → DISRUPTED`: material disruption; side effects = invalidate stale recommendations, replan, preserve audit trail | N | No disruption input exists. |

### §6 Deterministic feasibility and safety engine

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L45 | The feasibility service is the safety authority; **no LLM call is part of this calculation** | C | `services/airport/LayoverSafetyEngine.ts` imports only two type modules and `AirportTime` (`:1-9`); it contains no network call and no model reference. The dependency runs the correct way: `LayoverCompassService.ts:11` imports `computeBuffer` from the engine, never the reverse. |
| L46 | The subtraction ladder: scheduled − deplane − immigration/customs − baggage − exit friction − outbound − **return (future conditions, not symmetric)** − security/re-entry − terminal transfer − boarding buffer − contingency = usable | W | Six of eleven terms are modelled: deplane+immigration+baggage+exit are one lumped `estimateExitDelay` (`LayoverSafetyEngine.ts:210-216`, hardcoded 45/25/15 + 20, unrelated to `airport_profiles.immigration_extra_min`); base buffer covers security + boarding; `traffic_extra_min` covers transfer + contingency. **Outbound and return transport are not in the ladder at all** — they are per-candidate and symmetric (`travelTimeMin * 2`, `:97`), which is the exact opposite of "not symmetric". |

### §6.1 Hard invariants

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L47 | `recommendation.expected_airport_return_at <= return_plan.hard_return_by` | W | The shape is enforced — `assess` refuses when `usableMin < tripTime + activity` (`LayoverSafetyEngine.ts:119-121`). But the numbers it enforces against are constants (L9), and the plan-level check launders unknowns into the optimistic value: `computePlanFit` sums `(s.durationMin ?? 0) + (s.travelMin ?? 0)` (`routes/airport.ts:888-890`), so a stop with no travel time reports `fitsWindow: true`. **[463]** |
| L48 | `if entry_permission_state != CONFIRMED_ALLOWED: forbid_landside_recommendations()` | N | Nothing under `routes/airport.ts` or `services/airport/` reads `entry_requirements` or `traveler_passports` (both present since migration 0169). `adviseLeaving` returns `verdict: "yes"` while listing *"Visa or transit-permit requirements for your nationality"* in `unknowns[]` (`LayoverSafetyEngine.ts:302-304, 323-327`). A caveat attached to an affirmative answer. **[463]** |
| L49 | Critical unknown ⇒ `confidence = INSUFFICIENT` **and** forbid landside | N | No confidence (L37); unknown baggage unrepresentable (L35); no landside prohibition of any kind. |
| L50 | `risk_band == UNSAFE ⇒ recommendation.status = BLOCKED` | N | No `UNSAFE` band (L36). More concretely: `generateRecommendations` writes and returns **every** candidate regardless of rating (`LayoverRecommendationService.ts:286-307` — the loop pushes each assessed row with no filter), and the client renders `not_recommended` cards in full, hiding only the "Add to plan" button (`components/layover/LayoverRecsSection.tsx:61-84`). A blocked recommendation is a differently-coloured card. |
| L51 | `security_wait ↑` must never increase `usable_time` | C ⌀ | Monotone by construction: `usableMinutes = availableMin − totalBuffer` and every buffer term is additive (`LayoverSafetyEngine.ts:56-72, 251`). Vacuous — there is no security-wait input to increase. No test asserts it. |
| L52 | `return_travel_time ↑` must never expand the safe envelope | C ⌀ | `requiredMin = tripTimeMin + activityTimeMin + bufferMin` is monotone increasing in travel time (`:97-99`), and `rankActivities` orders shorter travel first (`:148-168`). Vacuous twice over: there is no envelope, and travel time is a category constant. |
| L53 | `departure_time` earlier must never expand the safe envelope | **W** | **Violated by arithmetic.** `timeOfDayExtra` is a step function on the local hour (`LayoverSafetyEngine.ts:49-53`) and `hardReturnTime = cutoff − totalBuffer` (`:247`). Moving a 20:00 departure to 19:59 drops the extra from 10 to 0 while the cutoff drops by 1 minute, so the deadline moves **9 minutes later** and `usableMinutes` grows by 9. Identical at the 22:00 boundary (20 → 10). Untested on main and on PR #463. |

### §6.2 Time estimate representation

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L54 | `Estimate { valueMinutes, p50/p75/p90, confidence, sourceClass, observedAt, expiresAt, fallbackLevel, sourceRefs[] }` | N | Every time value in the tree is a bare `number`. No percentile, source class, observation time, expiry or fallback level exists. |
| L55 | Safety-critical calculations use a configurable conservative percentile by data maturity/consequence; do not collapse to a single average | N | Every estimate is a single scalar, most of them literals: 45/25/15/20 (`LayoverSafetyEngine.ts:211-216`), 20/10/0 (`:51-53`), 15/25 (`LayoverRecommendationService.ts:213-215`), 30/60/90 (`:219-222`). |

### §7 Temporal Freedom Engine

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L56 | A generalised engine answering "what can this user do before they must be somewhere else" | N | `computeWindow(airport: AirportProfile, session: LayoverSession, …)` (`LayoverSafetyEngine.ts:232-236`) is airport-typed at its signature. There is no generic engine, and no second adapter. |
| L57 | `Commitment { type, startsAt, requiredArrivalAt, location, preparationTime, latenessTolerance, hardConstraints, confidence }` | N | Absent. |
| L58 | `FreedomWindow { beginsAt, endsAt, origin, requiredDestination, usableMinutes, hardConstraints, softConstraints, riskBudget, uncertaintyBudget, confidence }` | W | `LayoverWindow` (`LayoverSafetyEngine.ts:189-208`) is the analogue and shares two members in substance (`usableMinutes`; `earliestOutTime`/`hardReturnTime` ≈ begins/ends). It has no origin, destination, constraint sets, risk budget, uncertainty budget or confidence, and it is coupled to `AirportProfile`. |
| L59 | Keep airport-specific logic in the Layover adapter, not the generalised engine | N ∅ | There is no adapter boundary to keep clean — `LayoverSafetyEngine` is wholly airport-specific and nothing separates a generic layer from it. |

### §8 Reachability, routing and safe-envelope geometry

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L60 | Bidirectional reachability: airport→candidate and candidate→airport **under future return-time conditions** | N | Return is modelled as outbound × 2 (`LayoverSafetyEngine.ts:97`) — explicitly symmetric and time-independent. |
| L61 | Time-based isochrone/envelope geometry, not a fixed radius | N | No geometry at all. `fetchDiscoveryPlaces` matches with `ilike("city", "%" + city + "%")` and does not even select `lat`/`lng` (`LayoverRecommendationService.ts:174-183`), so a place in another city whose name contains the string is a candidate. |
| L62 | Incorporate transport reliability, route alternatives, queue friction, weather and airport re-entry cost | N | `traffic_extra_min` is a single admin-set integer defaulting to 20 (`0127:34`). None of the five signals exists. |
| L63 | Envelope edges contract as confidence drops or return risk rises | N | No envelope, no confidence. |
| L64 | Every recommendation stores the envelope/snapshot version under which it was certified | N | No version column on `layover_recommendations` (`0127:106-138`). |
| L65 | `candidate_feasible iff outbound_arrival + minimum_experience_duration + conservative_return_duration <= hard_return_by` | W | The inequality is implemented (`LayoverSafetyEngine.ts:119-121`), but each term is a category constant: `minimum_experience_duration` is `estimateActivityTime(placeType)` (30/60/90, `LayoverRecommendationService.ts:218-223`) and `conservative_return_duration` equals the outbound constant. **[463]** |
| L66 | `SafeEnvelope = union(points satisfying the feasibility constraint)` | N | Absent. |
| L67 | Map bands `SAFE` / `TIGHT` / `BLOCKED` | N | `components/layover/LayoverMapCard.tsx:41-64` renders undifferentiated pins; no band, no colour, no feasibility state reaches the map. |

### §8.1 Route robustness

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L68 | Multiple independent return routes → increase robustness / candidate preference | N | No route model exists. |
| L69 | Single fragile corridor → increase risk penalty | N | " |
| L70 | Non-interruptible transport/activity → increase risk penalty | N | `interruptibility` has no representation (L75). |
| L71 | Transfer count → increase plan complexity/uncertainty | N | " |
| L72 | Return traffic forecast → use future-time estimate, not outbound time | N | Directly contradicted by `travelTimeMin * 2` (`LayoverSafetyEngine.ts:97`). |
| L73 | Offline risk → require cached route + deadline before departure where possible | N | Nothing is cached (§16). |

### §9 Experience Compiler and recommendation contracts

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L74 | The planner generates **executable experiences**, not place cards; a recommendation is a contract carrying time, return, risk and failure information | W | `layover_plan_stops` plus `computePlanFit` (`routes/airport.ts:853-901, 1124-1306`) is genuinely more than a card list — an ordered itinerary with durations, travel legs and a fit verdict against the usable window. The recommendations that feed it are still cards: title, blurb, two constants and a rating (`LayoverRecommendationService.ts:100-154`). |
| L75 | `ExperiencePrimitive { type: EAT\|SEE\|MEET\|…, minDuration, idealDuration, compressibility, interruptibility, reversibility, costRange, energyCost, weatherCompatibility, reservationRequirement }` | N | `rec_type` is a nine-value CHECK (`0127:109-115`) with none of the ten behavioural fields. |
| L76 | `LayoverRecommendationContract { snapshotId, departBy, estimatedArrival, minExperienceMinutes, idealExperienceMinutes, leaveActivityBy, expectedAirportReturn, hardReturnBy, returnBufferMinutes, riskBand, confidence, fallbackPlan, abortThreshold, failureModes[], reasonCodes[] }` | W | `SafeRecommendation` (`LayoverPrivacyGuard.ts:31-52`) carries `hardReturnTime`, `returnBufferMin`, `travelTimeMin`, `activityTimeMin`, `safetyRating` and a free-text `warningReason` — four of the contract's fifteen members in substance. Absent: snapshotId, departBy, estimatedArrival, leaveActivityBy, expectedAirportReturn, confidence, fallbackPlan, abortThreshold, failureModes, reasonCodes. |

### §9.1 Candidate ranking

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L77 | **HARD GATE**: eligibility + entry + time + safety, before any optimisation | W | A gate exists but it is the wrong gate: landside candidates are fetched only when `wantsToLeave && layoverMinutes >= 90` (`LayoverRecommendationService.ts:244-246`), where `layoverMinutes` is the *scheduled* window, not usable time. So a 95-minute international connection with a 150-minute buffer still gets landside candidates; each is rated `not_recommended` and each is still written and returned (`:286-307`). Entry is not in the gate at all. The one safety-first ordering that exists is dead code (`LayoverSafetyEngine.ts:532-546#export function rankActivities`). |
| L78 | Optimise `preference_fit + local_uniqueness + opportunity_scarcity + social_value + experience_density + memory_value − monetary_cost − energy_cost − uncertainty − stress − return_risk` | N | The entire objective is two terms: `verified` first, then a time-of-day nudge (`LayoverRecommendationService.ts:440-442#verified places lead`). None of the eleven named terms exists. |

### §10 Airport Intelligence and truth reconciliation

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L79 | **Static topology** — terminal, gate, checkpoint, walking link; weeks/months, invalidated on authoritative change | W | A static airport record exists and is well built for what it is: `STATIC_AIRPORTS` (`services/airport/StaticAirportData.ts:23+`, ~200 hubs with real timezones and coordinates) behind a DB-first resolver (`AirportProfileService.ts:70-90`). Topology is not modelled: `terminal_info JSONB DEFAULT '{}'` has no writer, and there are no gates, checkpoints or walking links. No invalidation concept. |
| L80 | **Operational semi-live** — security layout, lounge hours, transport schedules; hours/days | N | The only lounge datum is `lounge_access BOOLEAN` on the session (`0127:71`), which is what the *user* declared about their ticket. |
| L81 | **Fast live** — security wait, immigration wait, taxi queue, disruption; minutes | N | Absent. `grep -rn liveClaimRead services/airport/` returns nothing (the same finding `census-sensing.md:290` records from the other side). |
| L82 | **Traveler observation** — checkpoint timing, queue report, closure; confidence-weighted | N | `GET /airport/pulse` (`routes/airport.ts:1439-1519`) surfaces ordinary social posts filtered by `location_city`; it is a feed, not an observation channel, and nothing it returns is an operational fact. |
| L83 | **Historical model** — time-of-day distributions, recalibrated | N | `timeOfDayExtra` (`LayoverSafetyEngine.ts:49-53`) is a three-band literal step function that no data informs and nothing recalibrates. |
| L84 | `TruthValue<T> { value, confidence, conflict, sourceClass, sourceRefs[], observedAt, expiresAt, fallbackLevel }` | N | Absent. |

### §10.1 Source hierarchy and contradiction handling

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L85 | Never silently merge contradictory gate/terminal/queue facts | N ∅ | There are no such facts and no merge step; nothing would refuse one if added. |
| L86 | Preserve source provenance and a conflict flag | N | No provenance column on any layover table. |
| L87 | For safety calculations, prefer conservative values when credible sources disagree | N | Single-source throughout. |
| L88 | Community observations require plausibility checks, corroboration and decay | N | No community observation channel exists. |
| L89 | Official data is not automatically truth when fresh contradictory evidence exists; contradiction increases uncertainty | N | No uncertainty representation (L37). |

### §11 Event-driven replanning architecture

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L90 | Canonical event envelope `{ eventId, eventType, occurredAt, receivedAt, source, sourceEventId, subjectRefs, payload, dedupKey, confidence }` | W | `layover_events` implements three of the ten members (`id`, `event_type`, `created_at` ≈ occurredAt) plus `metadata` ≈ payload (`0127:194-210`). No receivedAt, source, sourceEventId, subjectRefs, dedupKey or confidence. |
| L91 | The event vocabulary: `flight.arrival_delayed`, `flight.departure_delayed`, `flight.gate_changed`, `flight.cancelled`, `airport.security_wait_changed`, `airport.immigration_wait_changed`, `mobility.route_degraded`, `weather.condition_changed`, `layover.checkpoint_observed`, `layover.return_started`, `layover.airport_reentered` | N | None of the eleven exists. The CHECK list (`0127:198-208`) is eighteen in-app actions (`session_created`, `plan_stop_added`, `share_toggled`, …). No external event of any kind reaches this system. |

### §11.1 Replanner pipeline

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L92 | Normalise and deduplicate the external/internal event | N | No ingest; `layover_events` has no unique key at all. |
| L93 | Identify impacted active sessions | N | No fanout. The only index that could serve it (`layover_sessions_departure_idx`, `0127:92`) is used by nothing. |
| L94 | Recompute only the affected constraint nodes | N | No constraint nodes (L22). |
| L95 | Create a new immutable snapshot | N | (L25) |
| L96 | Diff previous vs new action universe | N | Nothing is retained to diff against. |
| L97 | Invalidate recommendations whose snapshot is stale or no longer feasible | W | There is wholesale invalidation — `generateRecommendations` DELETEs every row for the session and re-inserts (`LayoverRecommendationService.ts:645-650#layover_recommendations").delete()`), triggered whenever `layover_safety_engine_enabled` is on (`routes/airport.ts:806-807#isSafetyEnabled`). But it is driven by a client GET, not by an event; it has no staleness test; and it destroys rather than invalidates, so a client holding the previous ids loses them silently. |
| L98 | Emit an `OpportunityEvent` only if the user's actionable options materially changed | N | No such event type. |
| L99 | Notify only when user action should change | N | The only notification is a user-requested fixed 30-minute reminder (`app/layover/[id].tsx:167-191`). |

### §12 Compass / AI contract

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L100 | Compass is an orchestrator and explainer: asks the minimum useful clarifying question, compares certified plans, personalises wording, invokes deterministic tools | W | It explains and personalises — one chat completion over a structured deterministic context (`LayoverCompassService.ts:57-97`), with a deterministic fallback answer when the model fails (`:99-110`). It asks no clarifying question, compares no plans, and invokes no tool: the call has no tool schema (`:90-97`). |
| L101 | Compass **cannot invent or widen** the certified safe envelope, return deadline, visa/entry status, operational state or risk band | W | The structured fields are safe by construction (L16). The prose is not: the only enforcement is prompt text (`:71-79`) plus a coordinate regex (`LayoverPrivacyGuard.ts:100-106`). Visa/entry is not a field at all on main, so a model assertion about it is unconstrained by anything. And the whole endpoint is unreachable from the app (headline defect 4), so the contract governs a surface no user can reach. |
| L102 | Tool `getLayoverContext(sessionId)` | N | No layover tool exists. `compass/CompassTools.ts:70-214` declares eleven tools (`get_user_profile`, `get_current_trip`, `search_places`, `search_events`, `get_place_details`, `get_circle_activity`, `check_trip_conflicts`, `add_to_trip`, `get_whos_around`, `get_travel_compatibility`, `get_group_recommendation`) — none layover. |
| L103 | `getConnectionState(sessionId)` | N | " |
| L104 | `getTimeWallet(sessionId)` | N | " |
| L105 | `getSafeEnvelope(sessionId)` | N | " |
| L106 | `getReachableExperiences(sessionId)` (≡ §18 `getCandidates`… counted here as the tool; the service method is L182) | N | " |
| L107 | `simulatePlan(sessionId, candidateSet)` | N | " |
| L108 | `getReturnContract(sessionId)` | N | " |
| L109 | `getAirportState(sessionId)` | N | " |
| L110 | `getCrewCandidates(sessionId)` | N | " |
| L111 | `requestConstraintClarification(sessionId, field)` | N | " |
| L112 | `replan(sessionId, trigger)` | N | " |
| L113 | `explainDecision(snapshotId \| recommendationId)` | N | " |

### §12.1 Value-of-information rule

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L114 | Before asking, determine whether the answer could materially change eligibility, safety, risk band or the top plan; ask the smallest sufficient number of questions | N | Compass asks nothing (L100). The spec's own worked example — baggage-through status — is unrepresentable in the schema (L35), so the decisive question could not be recorded even if asked. |

### §13 Map architecture and UI semantics

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L115 | Map consumes the active snapshot and envelope geometry; does not recalculate feasibility | W | The non-recalculation half holds — `LayoverMapCard.tsx:28-31` takes `airport` and `stops` as props only. There is no snapshot or geometry to consume. |
| L116 | Show safe/tight/blocked geography from certified envelope versions | N | (L67) |
| L117 | Pins outside the certified action universe are hidden or visibly blocked | N | Every stop with coordinates is rendered identically (`LayoverMapCard.tsx:52-61`); feasibility never reaches the pin. |
| L118 | Changing time-budget chips triggers simulation/replanning, not local visual filtering alone | N | No chips. The recommendation filter chips that do exist (`LayoverRecsSection.tsx:41-49`) are pure client-side `Array.filter` on `insideAirport` — precisely the local visual filtering the requirement forbids as a substitute. |
| L119 | The primary route always includes the return leg and the return deadline | N | No route is drawn at all. |
| L120 | When `RETURN_NOW` is active, suppress exploration-first affordances and prioritise airport route/gate | N | No such state (L42). |
| L121 | Map element **Safe envelope** — dynamic isochrone/polygon that contracts as conditions worsen | N | (L66) |
| L122 | Map element **Candidate pin** — carries feasibility state from the recommendation contract | N | (L117) |
| L123 | Map element **Airport** — always visible; return CTA anchor | W | The airport pin is rendered (`LayoverMapCard.tsx:44-51`) but it is not always visible — the entire card returns `null` when the airport has no coordinates or coordinates of `(0,0)` (`:29-31, 66`), which is the default for a `buildFallbackProfile` airport. It is not a CTA anchor; tapping it opens a generic `PlaceDetailSheet` (`:86-91`). |
| L124 | Map element **Crew member** — only with explicit temporary location permission | N | No crew (L28). |
| L125 | Map element **Blocked area** — explain the reason, never imply safe fit | N | No blocked areas. |
| L126 | Map element **Offline state** — show last-certified envelope timestamp + stale badge | N | No offline rendering; the screen shows a generic failure line (`app/layover/[id].tsx:256`). |

### §14 Social, Layover Crew and Presence

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L127 | Aggregate presence is the **default**; identity and precise location are progressively disclosed only with consent | W | Two of three properties are right: sharing is opt-in and off by default (`0127:82`), reciprocal (`routes/airport.ts:1330-1333`), block-filtered in both directions with a fail-closed error path (`:940-949`), and coordinate-free (L8). But it is not aggregate-**first**: the very first response returns up to six named traveller profiles with id, handle, name and avatar (`:955-968`). The ladder is skipped, not climbed. |
| L128 | **L0 aggregate only** — "14 travelers connecting here" | W | The count is computed and returned (`routes/airport.ts:968`) but never on its own; it always ships alongside the profile list, and each profile carries a raw `profiles.id` (`:963`) which no visibility gate covers (only `name` is gated, via `nameVisibilitySet` at `:961`). |
| L129 | **L1 opt-in intent** — "5 open to food" | N | No intent model (`intents_json` absent, L27). |
| L130 | **L2 mutual discovery** — profiles visible under policy | W | Visibility has a policy (blocks, name gate) but not a *mutual* one: reciprocity is a single global toggle (`share_city_status`), not a per-pair opt-in, so enabling it exposes you to, and shows you, everyone sharing in the city at once. |
| L131 | **L3 crew formed** — shared chat / meeting point | N | (L28, L29) |
| L132 | **L4 temporary location** — explicit, scoped, auto-expiring | N | No location sharing of any precision in the layover path. |

### §14.1 Crew constraint solving

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L133 | `shared_return_by = min(member.required_return_by)` | N | No crew. |
| L134 | Explicit split plans (A leaves at T1, B/C continue to T2) | N | " |
| L135 | Crew plan certified against every member branch | N | " |
| L136 | No precise stranger location by default | N ∅ | Holds only because no crew and no precise location exist; nothing guards the addition. (The recommendation-side guard is scored at L8/L256.) |
| L137 | Crew location sharing expires on dissolution, re-entry, boarding, session expiry or revocation | N | " |
| L138 | Traveler pins must not expose an unsafe "meet here" action without the social/safety gate | N ∅ | The presence list exposes no meet action at all (`components/layover/LayoverPeopleSection.tsx`), so the forbidden affordance is absent — unguarded. |
| L139 | Shared rides require opt-in and must avoid revealing the full itinerary to unrelated users | N | No shared-ride concept. |

### §15 Safe Return and disruption recovery

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L140 | The escalation ladder `NORMAL → RETURN_SOON → RETURN_NOW → CONNECTION_AT_RISK` | N | No state ladder. The only escalation-flavoured artifact is a colour change in an unmounted component (`LayoverReturnPanel.tsx` lines 114-115 and 132, **deleted at `a718beb5`**). |
| L141 | At `CONNECTION_AT_RISK`: exploration surfaces collapse | N | The dashboard renders the same eight sections regardless of remaining time (`app/layover/[id].tsx:295-325`). |
| L142 | …fastest return route is primary | N | No route. |
| L143 | …terminal/gate context is pinned | N | No gate data (L80). |
| L144 | …crew/buddy is notified if policy + settings allow | N | No crew; no buddy notification path. |
| L145 | …rebooking / airline / airport help becomes available | N | Absent. |

### §15.1 One-tap abort

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L146 | **Every active landside plan must expose RETURN TO AIRPORT** | N | The only control resembling it is the "Safe Return" button in `LayoverReturnPanel.tsx` lines 147-150 (**deleted at `a718beb5`**), whose `onSafeReturn` prop is a caller-supplied callback — and the component is mounted nowhere (headline defect 4). The mounted dashboard footer offers Remind me / Telegraph / End layover (`app/layover/[id].tsx:333-357`). |
| L147 | The abort action cancels optional itinerary state, marks the session `RETURNING`, surfaces the fastest certified route, notifies crew/buddy flows, preserves the offline route/deadline, and records the transition in the decision ledger | N | None of the six effects has an implementation. `RETURNING` is not a representable status (L33). |

### §15.2 Disruption mode

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L148 | `CONNECTION → DELAYED → SEVERE_DELAY → OVERNIGHT`, and `↘ CANCELLED → REBOOKING/RECOVERY` | N | No disruption states, no disruption input. `overnight` exists but as a *tier* computed from the scheduled window (`LayoverSafetyEngine.ts:255-257`), not a disruption state. |
| L149 | Disruption may expand or shrink the FreedomWindow; **recompute, do not append delay minutes** | N | No disruption path to recompute from. `PATCH /airport/sessions/:id` does recompute from scratch on a manual time edit (`routes/airport.ts:479-513`), which is the right shape, but nothing drives it. |

### §16 Offline, battery and degraded-mode architecture

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L150 | **Return deadline** — persist the latest certified value + snapshot timestamp | W | Half-built, and the built half is real: the reminder instant is persisted server-side (`0127:84`; writer `LayoverSessionService.ts:307-323`) and the client schedules an OS-level local notification that fires without the app (`app/layover/[id].tsx:179-185`, `lib/safeNotifications.ts:115-136`). But nothing is cached for *display* — there is no `AsyncStorage` write anywhere in `services/layover.ts`, `context/LayoverSessionContext.tsx` or `app/layover/[id].tsx` — and there is no snapshot timestamp to persist. |
| L151 | **Map** — cache airport + selected route/area | N | No tile or geometry cache. |
| L152 | **Route** — cache outbound/return instructions and the airport address | N | No route exists to cache. |
| L153 | **Flight/gate** — cache last confirmed values with a stale indicator | N | No flight or gate data. |
| L154 | **Crew** — cache meeting point; optional peer proximity | N | No crew. |
| L155 | **Translation** — cache context phrases required by the active plan | N | `AirportEssentialsCard.tsx:21-49` bundles static per-country currency/language/tipping strings, which is offline-available by accident of being in the bundle, but it is keyed on country, not on the active plan, and contains no phrases. |
| L156 | **Replanning** — local conservative fallback only if deterministic inputs suffice; otherwise show unavailable/stale | N | Offline, `getLayoverOverview` returns null and the screen renders a generic failure (`app/layover/[id].tsx:250-260`) with no distinction between "removed" and "offline" — the copy says both. |
| L157 | Adaptive sensing: low frequency when safe/stationary, moderate near decision boundaries, navigation-appropriate during `RETURNING`; avoid continuous GPS | N | The layover surface performs no location sensing at all: no `expo-location` import under `src/components/layover/`, `app/layover/` or `src/services/layover.ts`. The only cadence is a fixed 60-second overview refetch and a 30-second local clock (`app/layover/[id].tsx:72-88`), neither state-dependent. |

### §17 Privacy, permissions and data lifecycle

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L158 | **Precise crew/live location** — session scoped, expires automatically | N | No such data. |
| L159 | **Operational checkpoints** — short-lived operational + bounded diagnostics | N | No checkpoints (L30). |
| L160 | **Raw flight operational cache** — expires after usefulness/diagnostic window | N | No flight cache. |
| L161 | **Aggregate airport timing** — may persist after de-identification/aggregation | N | No aggregate timing is ever produced. |
| L162 | **Completed places/stamps** — durable only when the user elects Passport/Memory behaviour | W | A stamp is written automatically at session **creation**, gated only on `passport_stamps_enabled` (`routes/airport.ts:451-468`), before the traveller has completed anything and without electing anything. The stamp itself is correctly minimal (city + `sourceType: "layover_session"`, `:456-460`). |
| L163 | **Decision ledger** — retained per safety/diagnostic policy; minimise direct personal data | W | `layover_events` is the nearest ledger and carries `user_id UUID NOT NULL REFERENCES profiles(id)` on every row (`0127:197`) — direct personal data, not minimised — with no retention policy or TTL anywhere. It is at least covered by the erasure cascade (`lib/deletionDispositions.ts:356-357` lists `layover_events` and `layover_sessions`). |

### §17.1 Permission prompting

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L164 | **Location** — request when enabling live return assistance / map context, not solely because Layover exists | N ∅ | Layover requests no location permission anywhere; `components/discovery/DiscoveryMapView.tsx` (mounted by `LayoverMapCard`) has no `expo-location` reference. The prohibition holds by absence. The nearest real artifact is the purpose registry, which classifies `layover_plan_stops` and `airport_profiles` as venue reference data rather than personal location (`lib/locationPurposes.ts:315-321`) under the standing `checkLocationPurposes` guard — but that governs storage, not prompting. |
| L165 | **Notifications** — explain that they are needed to warn when the safe return window changes | W | The request is correctly *contextual*: `scheduleLocalNotificationAt` only prompts inside the "Remind me" tap (`lib/safeNotifications.ts:122-126`, reached from `app/layover/[id].tsx:176-185`). No explanation precedes the OS prompt — there is no rationale sheet or copy anywhere in the layover flow. |
| L166 | **Precise crew sharing** — separate explicit control, off by default | N | No precise sharing exists to control. The city-level `share_city_status` toggle is a separate control and is off by default (`0127:82`; UI `LayoverPeopleSection.tsx`), but it governs a different, coarser thing. |
| L167 | **Calendar/flight import** — only if used for detection; **manual session creation must remain possible** | C | Manual creation is the only creation path and is fully built: `POST /api/airport/sessions` (`routes/airport.ts:302-478`) with an airport picker, wall-time entry and validation, driven by `components/layover/LayoverModeSheet.tsx`. There is no calendar or flight import anywhere, so the conditional half cannot be violated. |
| L168 | **Photos/contacts** — not required for core safety operation | N ∅ | No layover path touches photo or contact permissions. Unguarded absence. |

### §18 APIs and service interfaces

Three methods are merged into their §12 tool twins and not scored here (`simulate`≡L107,
`replan`≡L112, `discover`≡L110).

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L169 | `LayoverSessionService.detectFromTrip(userId, tripId)` | N | Nothing detects a connection. The trip screen shows a manual banner that opens the creation sheet (`app/trip/[id].tsx:646-652, 774`). |
| L170 | `LayoverSessionService.createManual(input)` | C | `createSession` (`services/airport/LayoverSessionService.ts:111-148`) behind `POST /api/airport/sessions` (`routes/airport.ts:302-478`), with airport resolution, airport-local wall-time conversion, a refusal when the timezone is unknown (`:342-348`), ordering/duration/past-departure validation (`:369-393`) and a `session_created` event. |
| L171 | `LayoverSessionService.getActive(userId)` | C | `getActiveSession` (`LayoverSessionService.ts:240-255`) behind `GET /api/airport/sessions/active` (`routes/airport.ts:999-1024`), which expires stale sessions first (`:1010`). |
| L172 | `LayoverSessionService.updateConstraint(sessionId, patch)` | W | `updateSession` (`LayoverSessionService.ts:154-193`) patches session fields under an `.eq("status","active")` guard (`:183`) — but there is no constraint entity to patch (L22), so terminals, baggage mode, entry state, mobility profile and buffer profile are unreachable by construction. |
| L173 | `LayoverSessionService.recordCheckpoint(sessionId, checkpoint)` | N | (L30) |
| L174 | `LayoverSessionService.close(sessionId, **outcome**)` | W | `endSession` exists (`LayoverSessionService.ts:196-219`) but the outcome argument has nowhere to go — `layover_outcomes` is absent (L32) — and the only caller passes the literal `"cancelled"` (`routes/airport.ts:1532`), so a successfully completed layover is recorded as a cancellation. |
| L175 | `LayoverFeasibilityService.evaluate(sessionId)` | W | The computation exists (`computeWindow` + `adviseLeaving`) and is invoked per session at `routes/airport.ts:1041-1042`, but there is no service, no session-scoped `evaluate`, and the result is a response body rather than a certified, stored evaluation. |
| L176 | `LayoverFeasibilityService.certifyRecommendation(sessionId, candidatePlan)` | N | Nothing certifies. |
| L177 | `TemporalFreedomService.buildFreedomWindow(context)` | W | `computeWindow(airport, session, nowMs)` (`LayoverSafetyEngine.ts:232-281`) is the analogue and is a genuinely careful piece of work — boarding-cutoff anchoring, airport-local overnight detection, exit-delay modelling. It takes an airport, not a context, and returns a `LayoverWindow`, not a `FreedomWindow` (L58). |
| L178 | `TemporalFreedomService.calculateCommitmentEnvelope(context)` | N | No `Commitment` (L57). |
| L179 | `LayoverReplanner.handleEvent(event)` | N | No event ingest (L91). |
| L180 | `AirportTruthService.getTruth(subject, factType, atTime)` | N | No truth model (L84). |
| L181 | `AirportTruthService.reconcile(observations)` | N | No observations (L82). |
| L182 | `LayoverExperienceService.getCandidates(sessionId)` | W | `generateRecommendations` (`LayoverRecommendationService.ts:389-395#export async function generateRecommendations`) does produce a session-scoped candidate set, and its time-of-day filter is real and careful (`timeOfDayContext` samples every 30 minutes to the boarding cutoff, `LayoverRecommendationService.ts:109-134#export function timeOfDayContext`). The candidates themselves rest on category constants (L9). |
| L183 | `LayoverExperienceService.compile(sessionId, candidateIds)` | W | `POST /airport/sessions/:id/stops/from-recommendation` (`routes/airport.ts:1164-1211`) plus `computePlanFit` (`:886-901`) compiles chosen candidates into an ordered itinerary with a fit verdict. It compiles no route, no `departBy`, no abort threshold and no fallback (L76). |
| L184 | `LayoverExperienceService.rank(sessionId, contracts)` | W | Ordering exists (`LayoverRecommendationService.ts:440-442#verified places lead`) but by `verified` and time-of-day only; the safety-first comparator `rankActivities` (`LayoverSafetyEngine.ts:532-546#export function rankActivities`) is dead code. |
| L185 | `LayoverCrewService.join(sessionId, crewId)` | N | No crew. |
| L186 | `LayoverCrewService.create(sessionId, input)` | N | " |
| L187 | `LayoverCrewService.updatePresence(sessionId, input)` | W | `PATCH /airport/sessions/:id/share` (`routes/airport.ts:1308-1320`) → `setShareStatus` (`LayoverSessionService.ts:282-305`). It updates one boolean; the spec's presence record (window, intents, max travel minutes, precise-location flag, expiry) does not exist. |
| L188 | `LayoverCrewService.leave(sessionId, crewId)` | N | No crew. |
| L189 | `LayoverDecisionService.explain(snapshotId)` | W | Explanation is genuinely built and is the best-designed thing on this surface — `adviseLeaving` returns structured `reasons[]`, `unknowns[]` and a disclaimer (`LayoverSafetyEngine.ts:296-339`), rendered as an always-visible "What we can't know" box plus a "How we got these numbers" breakdown (`components/layover/CanILeaveCard.tsx:61-95`). But it explains a live computation, not a snapshot, and there is no `explain(snapshotId)` entry point. |
| L190 | `LayoverDecisionService.diff(previousSnapshotId, nextSnapshotId)` | N | No snapshots. |
| L191 | `LayoverDecisionService.replay(sessionId, engineVersion)` | N | No engine version is recorded anywhere. |

### §19 Storage and migration plan

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L192 | 1. Create **enum types** and the core `layover_sessions` table with RLS | W | Table and RLS exist (`0127:53-104`). No PostgreSQL enum type was created — every vocabulary is a CHECK on TEXT — and the state vocabulary is wrong (L33). |
| L193 | 2. Create constraints, snapshots, time budgets and return plans | N | None of the four exists (L22–L25). |
| L194 | 3. Create events + checkpoints **with dedup indexes** | W | `layover_events` exists with two indexes (`0127:213-214`); there is no checkpoints table and **no dedup index or unique constraint of any kind** on the events table. |
| L195 | 4. Create recommendations + outcome tables | W | Recommendations yes (`0127:106-151`); outcomes no (L32). |
| L196 | 5. Create presence/crew tables with restrictive policies and **expiration jobs** | N | No presence or crew tables, and no expiration job — `expireOldSessions` (`LayoverSessionService.ts:327-345`) is called inline from two GET handlers (`routes/airport.ts:992, 1010`), not scheduled. |
| L197 | 6. Create airport intelligence observation/truth tables if the existing intelligence schema cannot represent the required TTL/provenance cleanly | W | A new table was created (`airport_profiles`, `0127:17-41`) *and* it carries neither TTL nor provenance — so the clause's condition was neither evaluated nor satisfied by the outcome. The existing `intel_*` schema, which does carry both, is not consulted from `services/airport/`. |
| L198 | 7. Indexes for active-session lookup, session event ordering, unexpired presence, snapshot versioning and impacted-session event fanout | W | Three of five have an index: active-session (`layover_sessions_user_status_idx`, `0127:91`), event ordering (`layover_events_user_idx … created_at DESC`, `:214`), and a partial share index that serves the presence read (`layover_sessions_share_idx … WHERE share_city_status = TRUE`, `:94-95`). Snapshot versioning and impacted-session fanout have no subject. |
| L199 | 8. **Migration postconditions and authorization-contract tests for every client-writable table** | N | `0127` contains no postcondition block, in a tree where 118 of 420 migrations carry one (e.g. `2130_intel_storage.sql`). And none of the four client-writable layover tables appears in `src/security/authorization-contract.json`, which lists seventeen tables, none of them layover — so `checkAuthorizationContract.ts:52` never queries them and RLS drift on them is invisible to CI. **[463]** |

### §19.1 RLS expectations

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L200 | Users may read/write their own session inputs **within allowed fields** | W | Ownership is correct and symmetric: `FOR ALL … USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())` (`0127:99-102`). "Within allowed fields" is not enforced — the policy is column-blind, so the owner has write authority over `status`, `return_reminder_at` and `share_city_status` as well as their own inputs, and no column grant or contract entry narrows it (L199). |
| L201 | **Computed snapshots, risk, return plans and certification fields are server-controlled** | **?** | The only computed fields that exist — `safety_rating`, `return_buffer_min`, `hard_return_time` on `layover_recommendations` — sit behind a policy with **no `WITH CHECK`**: `FOR ALL … USING (session_id IN (SELECT id FROM layover_sessions WHERE user_id = auth.uid()))` (`0127:144-151`). PostgreSQL reuses `USING` as the write check when none is given, so the policy as written permits a session owner to insert or update their own recommendation rows. The sibling table in the same migration has both clauses (`:179-190`), which is why this reads as an oversight rather than a decision. **Whether it is exploitable depends on the table-level grant to `authenticated` in production**, which I was instructed not to query and which no authorization-contract entry pins (L199). See §6. |
| L202 | Presence is readable only according to visibility scope and safety policy | W | The policy is real but lives entirely in application code: reciprocity (`routes/airport.ts:1330-1333`), bidirectional block filtering with a fail-closed error branch (`:940-949`), name-visibility gating (`:961-966`). At the database level `layover_sessions` is owner-only (`0127:99-102`), so the presence query runs on the **service role** (`getServiceClient()`, `:1097-1103`) and has no database-level scope at all. `share_city_status` also has no expiry of its own; it lapses only when the session does. |
| L203 | Crew membership/location rows require membership and explicit permission | N | No crew tables (L28, L29). |
| L204 | Aggregated airport intelligence must not leak raw user identifiers | N | No aggregated airport intelligence exists to leak from. (The related identifier exposure in the *presence* surface is scored at L128.) |
| L205 | Service-role processing should be **narrow and auditable** | W | It is auditable in part — `layover_events` records session, plan, share and reminder actions with their inputs (`routes/airport.ts:1160-1167#return_deadline_set` is a good example: minutesBefore, hardReturnTime and reminderAt all recorded). It is the opposite of narrow: every one of the ~30 layover routes runs on `getServiceClient()` (`:268, 307, 484, 520, 578, 628, 673, 726, 774, 981, 1004, 1031, 1101, 1444, 1526`), so the whole domain bypasses RLS and the row policies protect nothing on the server path. |

### §20 Observability and decision ledger

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L206 | Every material recomputation creates a deterministic snapshot and decision record | N | (L25) |
| L207 | `DecisionRecord { sessionId, snapshotId, engineVersion, inputHash, inputFacts[], sourceRefs[], rulesApplied[], result, reasonCodes[], computedAt }` | N | Absent. `layover_events.metadata` carries ad-hoc scalars (`{ count }`, `{ enabled }`, `{ minutesBefore, … }`), never inputs, rules or reason codes. |
| L208 | Metric `layover_sessions_detected` | W | The underlying event is recorded (`session_created`, `LayoverSessionService.ts:144-147`) so the number is derivable by query — but no metric is emitted, aggregated or reported anywhere: there is no counter, no exporter and no `report*` script for layover under `src/scripts/`. |
| L209 | Metric `layover_sessions_evaluated` (sessions receiving a certified snapshot) | N | Nothing is certified to count. |
| L210 | Metric `critical_unknown_rate` | N | No critical-unknown concept (L22). |
| L211 | Metric `landside_eligible_rate` | N | No eligibility decision is recorded. |
| L212 | Metric `replan_rate` | N | No replan (§11.1). |
| L213 | Metric `return_warning_rate` | N | `RETURN_SOON`/`RETURN_NOW` do not exist (L41, L42). |
| L214 | Metric `safe_return_completion_rate` | N | No completion is ever recorded (L10, L33). |
| L215 | Metric `stale_fallback_rate` | N | The fallback ladder emits nothing when it fires (`AirportProfileService.ts:70-90`; `routes/airport.ts:127` swallows the failure silently). |
| L216 | Metric `recommendation_contract_violation`, target 0 | N | No contract to violate (L76). |
| L217 | Metric `decision_replay_mismatch`, target 0 | N | No replay (L191). |

### §21 Testing, replay and certification

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L218 | Certification must prove hard invariants across deterministic scenarios, synthetic disruption, replay, database authorization and E2E lifecycle — not that cards render | N | No certification artifact for Layover exists. `docs/architecture/` carries `wall-certification.md`, `passport-certification.md`, `media-v2-certification.md` and `input-intelligence-certification.md`; there is no layover equivalent, and none of the five named proof classes is covered (see §21.2). |

### §21.1 Minimum deterministic scenario matrix

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L219 | 2h domestic → airport-only expected | N | No such scenario in `test/airport.test.ts`. The nearest is *"2h international layover with immigration → too_short"* (`:729-738`) — a different flight type, a different tier and a different assertion. |
| L220 | 4h international, visa allowed → potential landside depending on airport model | N | No entry model on main (L48); no airport-model variation in any test. |
| L221 | 6h visa-free → landside + return contract | N | No return contract (L24). |
| L222 | 5h self-transfer → recheck friction included | N | Self-transfer and recheck are unrepresentable (L35). |
| L223 | Overnight → overnight state / expanded options | W | Half covered, and the covered half is well done: `"overnight layover crossing local midnight → overnight"` (`test/airport.test.ts:755-762`) exercises the airport-local day-boundary logic at `LayoverSafetyEngine.ts:255-257`. There are no expanded options — `insideAirportCandidates` adds the same sleep-pod card to every session (`LayoverRecommendationService.ts:145-151`). |
| L224 | Airport change → exploration subordinate to transfer | N | `airport_change_required` is unrepresentable (L22). |
| L225 | Arrival delay → freedom shrinks | N | No delay input and no test. |
| L226 | Departure delay → freedom may expand after recompute | N | " |
| L227 | Security spike → envelope contracts monotonically | N | No security-wait input (L51). |
| L228 | Traffic spike → return deadline moves earlier | N | `traffic_extra_min` is a static admin constant (`0127:34`); nothing moves it. |
| L229 | Unknown baggage → fail closed if critical | N | (L35, L49) |
| L230 | Unknown entry permission → no landside recommendation | N | (L48) **[463]** |
| L231 | Flight cancellation → transition to disruption/recovery | N | (L148) |
| L232 | Crew mixed departures → shared constraint = earliest or explicit split | N | (L133) |
| L233 | Offline after leaving → cached return plan remains visible with a stale indicator | N | (L150, L156) |

### §21.2 Test layers

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L234 | Pure unit tests for time math, monotonicity, risk/uncertainty rules and reason codes | W | The time-math half is genuinely well covered: `test/airport.test.ts` runs ~45 pure tests over buffers, tiers, exit delay, DST-crossing wall-time conversion and time-of-day coverage (`:349-464, 683-708, 711-796, 852-931`), including a fractional-hour overshoot case (`:901-916`). No monotonicity test exists — which is why the L53 boundary bug is live. No uncertainty rules and no reason codes to test. |
| L235 | Property-based tests for "worse input cannot produce safer/larger output" | N | None on main. **[463]** |
| L236 | Database tests against a real CI schema for column names, enum literals, RLS and migration postconditions | W | Two of four are covered by repo-wide guards that do reach layover: `checkMissingLiveColumns.ts` diffs every migration-declared column against the live schema (so 0127's columns are checked), and `checkEnumLiterals.ts:73-83` scans `../routes` and `../services` — i.e. `routes/airport.ts` and `services/airport/` — for filter literals a CHECK column cannot hold. RLS and migration postconditions are not covered for layover at all (L199). |
| L237 | Contract tests proving Compass cannot override deterministic safety fields | N | No such test; `test/airport.test.ts` does not exercise `answerLayoverQuestion`. |
| L238 | Integration tests for event → replan → snapshot → invalidation → notification | N | No such pipeline (§11.1). |
| L239 | E2E tests for detection → evaluation → plan → execution → return → completion | N | Four of the six stages have no implementation to test. |
| L240 | Deterministic replay tests for recorded sessions | N | (L191) |
| L241 | Decision-diff CI comparing old/new engine behaviour over historical/synthetic corpora | N | Absent. |
| L242 | Shadow mode in real environments before high-confidence rollout | N | Absent; all five layover flags were seeded directly to TRUE (`0127:224-230`). |

### §22 Rollout and airport maturity model

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L243 | **L0 Generic** — static airport + conservative generic timing; **airport-side guidance only by default** | W | The static+generic tier is real and reasonably built (`StaticAirportData.ts` ~200 hubs; `AirportProfileService.ts:37-68` `staticToProfile`/`FALLBACK_PROFILE`). The default is not airport-side-only: a session on a generic fallback profile still receives landside recommendations (`LayoverRecommendationService.ts:244-246` gates on time and preference, never on data maturity) and a `"yes, you can leave"` verdict. |
| L244 | **L1 Mapped** — terminal/topology and known transport modelled | N | (L79) |
| L245 | **L2 External live** — reliable flight/transport/airport live signals | N | (L81) |
| L246 | **L3 Portava observed** — recent Portava operational observations available | N | (L82) |
| L247 | **L4 Calibrated** — prediction errors measured, model calibrated by airport/time band | N | Nothing measures its own error (L217). |
| L248 | **L5 Dense live intelligence** — high-confidence dynamic replanning | N | (§11.1) |
| L249 | Enable features per airport maturity | N | The only tier-like signal is `airport_profiles.verified` (`0127:37`), and it gates nothing: it changes a badge (`LayoverHero.tsx:48`) and adds a "possible_but_risky" nudge for unverified far places (`LayoverSafetyEngine.ts:125`). No feature is enabled or withheld by maturity. |
| L250 | Do not imply equivalent intelligence globally; "limited intelligence" is a valid product state | W | The honesty artifact exists and is the best thing on this surface: `adviseLeaving` returns an `unknowns[]` list that always includes the visa caveat (`LayoverSafetyEngine.ts:302-304`) plus a standing disclaimer (`:291-293`), rendered in an always-visible box that is explicitly *"never buried"* (`components/layover/CanILeaveCard.tsx:85-93`). But it is uniform: the airport's own data maturity is never disclosed, so a curated airport and a generic-fallback one present identical confidence. |

### §23 Security and abuse controls

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L251 | Rate-limit and trust-weight community operational observations | N ∅ | No observation channel exists (L82); nothing would rate-limit one. |
| L252 | Outlier detection for implausible queue/transport claims | N | " |
| L253 | **No stranger precise location by default** | C | Structurally enforced at two layers: the presence query selects no coordinate column at all (`routes/airport.ts:918-926`), and `SafeRecommendation` has no coordinate field, so `sanitizeRecommendation` cannot forward one even if `RawRecommendation.lat/lng` were populated (`LayoverPrivacyGuard.ts:19-52, 61-99`). Compass prose is additionally scrubbed with a coordinate regex (`:100-106`). |
| L254 | Verified/trusted requirements for high-risk Buddy/marketplace interactions | W | `verified` and `buddy_level` are read and returned (`routes/airport.ts:1411-1427`) but nothing *requires* them — the layover buddy list is filtered only on `status='active'`, city and blocks (`:1355-1364, 1374-1385`). Ordering is by review count, then availability. |
| L255 | Public-meetup and in-app-payment controls inherited from Rent a Buddy where applicable | W | The layover surface links to buddy profiles rather than booking, so Rent-a-Buddy's own controls apply once the user leaves it. But the inheritance is not asserted anywhere: `GET /airport/sessions/:id/buddies` queries `rent_buddy_profiles` directly (`routes/airport.ts:1355-1364`) behind the layover flag only — it never checks `rent_buddy_enabled`, the master flag every other buddy read gates on (`lib/buddyMapRead.ts:199-203`), and which `lib/rentBuddyFeeSchedule.ts:225` and `lib/rentBuddyEarningsLedger.ts:120#rent_buddy_enabled` both describe as off in production. |
| L256 | Prevent sponsored/merchant inputs from modifying safety constraints | N ∅ | No sponsored input path reaches the safety engine, and no guard prevents one being added. |
| L257 | Validate all external event payloads and deduplicate by stable source keys | N | No external events (L91), no dedup key (L194). |
| L258 | Audit all server-side changes to certification fields and return contracts | W | The return-deadline write is properly audited with inputs and outputs (`routes/airport.ts:1160-1167#return_deadline_set`). Recommendation generation — which writes every `safety_rating`, `return_buffer_min` and `hard_return_time` in the system — logs only `{ count: rows.length }` (`LayoverRecommendationService.ts:671#count: rows.length`), so the values written and the inputs that produced them are not recoverable. |

### §24 Performance, scaling and reliability

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L259 | **Replan fanout** — index active sessions by airport/route/flight subjects; recompute impacted sessions only | W | Indexes exist but on the wrong axes: `(user_id, status)` and `(departure_time)` (`0127:91-92`). There is no airport, route or flight subject index and no fanout to serve. |
| L260 | **Candidate explosion** — pre-filter by envelope/time/category before expensive ranking | W | A pre-filter exists — `limit(8)` on the discovery read (`LayoverRecommendationService.ts:180`), plus the ≥90 min and ≥180 min gates (`:244-246, 260-261`) and the nightlife drop for daytime-only windows (`:247-250`). It filters on the scheduled window rather than the usable one, and there is no envelope and no expensive ranking to protect. |
| L261 | **Snapshot growth** — immutable snapshots with bounded retention/compaction | N | (L25) |
| L262 | **Live feed outages** — explicit fallback ladder + confidence reduction | W | The ladder is explicit and three-deep (DB row → static dataset → generic profile, `AirportProfileService.ts:70-90` and `routes/airport.ts:98-140`). There is no confidence reduction, and on main a *failed read* is indistinguishable from a missing row — `routes/airport.ts:100-127` destructures `{ data }` and drops `error`, then falls through to generic buffers. **[463]** |
| L263 | **Duplicate events** — unique dedup key / source event id | N | (L194) |
| L264 | **Race conditions** — version/compare-and-swap the active snapshot; reject stale writes | W | A CAS-flavoured guard exists and is applied consistently: `updateSession`, `endSession`, `setShareStatus` and `setReturnReminder` all filter `.eq("status","active")` (`LayoverSessionService.ts:183, 208, 294, 319`), so a write to a closed session is rejected rather than resurrecting it. But there is no snapshot to version and no stale-engine-result rejection. |
| L265 | **Notification storm** — material-change threshold + suppression/debounce | W | Debounce is real: the client cancels the previously scheduled notification before scheduling a new one, explicitly *"never stack them"* (`app/layover/[id].tsx:171-173`). There is no material-change threshold, because nothing detects change. |
| L266 | **AI outage** — core flight/return/map/route remains functional without Compass | C | Three independent layers: `answerLayoverQuestion` catches the model failure and returns a deterministic answer built from the engine's own numbers (`LayoverCompassService.ts:90-110`); Compass sits behind its own separate flag (`layover_compass_enabled`, `routes/airport.ts:633-636`); and the dashboard's whole window/advice/plan/map path never calls Compass at all (`:1026-1095`). |

### §25 Portava integration points

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L267 | **Trips** — detect connection; show Layover card/status; pass flight segments into session creation | W | The card and status are built: a banner on the trip screen (`app/trip/[id].tsx:646-652`), an active-session pill with shared context (`context/LayoverSessionContext.tsx:31-45`, `components/layover/ActiveLayoverPill.tsx`), and a `trip_plan_items` mirror row so the layover appears in the trip timeline, deduped on `(source_type, source_id)` and permission-checked (`routes/airport.ts:143-179`). Nothing detects a connection; no flight segment is passed because none exists. |
| L268 | **Compass** — tool access to certified context; proactive OpportunityEvents; explanation/clarification | W | Explanation only, and the endpoint is unreachable from the client (headline defect 4). No tools (L102–L113), no OpportunityEvents (L98), no clarification (L114). |
| L269 | **Discovery** — only show experiences from the certified action universe in Layover mode | W | A real gated integration exists: `GET /hidden-gems/layover-safe` filters on `layover_safe` and `minimum_layover_minutes <= availableMinutes` behind two flags (`routes/hiddenGems.ts:599-628`). But it takes `availableMinutes` from the query string rather than the session's computed window, **the layover dashboard never calls it** (`services/hiddenGems.ts:276-284` has no caller under `app/layover/` or `components/layover/`), and the path the dashboard *does* use applies no feasibility filter at all (`LayoverRecommendationService.ts:174-183`). |
| L270 | **Map** — safe envelope, plan route, return state, airport digital-twin layers | W | Pins only (L17, L121–L123). |
| L271 | **Telegraph** — crew chat, return coordination, buddy communication | W | **The message is discarded.** `POST /airport/sessions/:id/telegraph` classifies the intent (`services/telegraphIntent.ts:160-192`), resolves the trip's thread id when the caller is an accepted member (`routes/airport.ts:788-805`) and writes a `telegraph_suggestion_sent` event carrying `{ intent, city, threadId }` (`:812-818`) — but it never writes the message to any thread. The client composes real text (`app/layover/[id].tsx:194-198`), posts it, and is then navigated to the trip chat where the text does not appear. |
| L272 | **Safe Return** — reuse escalation/return UX; Layover provides certified deadlines and state | W | `shouldSuggestSafeReturn` produces reasons at creation and records them (`routes/airport.ts:440-447`), which is a real seam. No escalation UX is reused — the "Safe Return" control lives in the unmounted `LayoverReturnPanel`, and no state is provided because none exists. |
| L273 | **Rent a Buddy** — layover-specialist services **after the safety/time gate**; strict boundaries | W | A time filter exists — availability is checked against the layover's airport-local day span (`routes/airport.ts:1388-1407`) — and blocks are filtered bidirectionally (`:1374-1385`). There is no safety gate, no layover-specialist category filter, and the master `rent_buddy_enabled` flag is not consulted (L255). |
| L274 | **Visa Buddy** — human assistance path for complex visa/entry questions | N | No such path from the layover surface. |
| L275 | **Passport / Memories** — convert a **completed** session into an optional stamp/postcard/memory | W | The seam is wired (`routes/airport.ts:449-470`) but fires at creation, not completion, and is not optional (L19, L162). No postcard or memory path. |
| L276 | **Live Intelligence** — consume crowd/queue/mobility signals; publish de-identified airport observations | N | `grep -rn liveClaimRead services/airport/` returns nothing; the same absence is recorded from the Sensing side at `docs/architecture/census-sensing.md:290`. Nothing is published either. |
| L277 | **Locate My Friends** — optional crew peer-proximity/offline assistance after explicit opt-in | N | No crew, no proximity. |

### Appendix A. Reason codes

All fifteen are **NOT-BUILT**. There is no reason-code vocabulary anywhere in the layover code —
no enum, no constant table, no column. Warnings are free-text English sentences constructed
inline (`LayoverSafetyEngine.ts:109-129`, `:296-329`), so they cannot be counted, tested,
localised or diffed. `layover_recommendations.warning_reason` is a bare `TEXT` (`0127:127`).

| id | Reason code | V |
| --- | --- | --- |
| L278 | `ENTRY_NOT_CONFIRMED` | N |
| L279 | `BAGGAGE_STATUS_CRITICAL_UNKNOWN` | N |
| L280 | `INSUFFICIENT_USABLE_TIME` | N |
| L281 | `SECURITY_WAIT_HIGH` | N |
| L282 | `RETURN_ROUTE_UNRELIABLE` | N |
| L283 | `AIRPORT_CHANGE_REQUIRED` | N |
| L284 | `SELF_TRANSFER_FRICTION` | N |
| L285 | `DATA_STALE` | N |
| L286 | `SOURCE_CONFLICT` | N |
| L287 | `TRAFFIC_DEGRADED` | N |
| L288 | `FLIGHT_MOVED_EARLIER` | N |
| L289 | `FLIGHT_DELAY_CREATED_OPPORTUNITY` | N |
| L290 | `RETURN_THRESHOLD_REACHED` | N |
| L291 | `RECOMMENDATION_EXPIRED` | N |
| L292 | `AIRPORT_MATURITY_LIMITED` | N |

### Appendix C. Developer rules (only the four not already counted)

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L293 | C1. Never query a semantic substitute for a missing field and pretend it is the requested fact; unknown is preferable to fabricated certainty | N | Violated in three named places, all on the safety path. (a) `estimateTravelTime(placeType)` returns 15 or 25 minutes without reading a coordinate (`LayoverRecommendationService.ts:212-216`), and `assess` doubles it into a round trip and turns it into `"safe"` (`LayoverSafetyEngine.ts:97, 128-129`). (b) `estimateActivityTime(placeType)` substitutes 30/60/90 for a real duration (`:218-223`). (c) `GET /:id/safety` builds a fictitious probe candidate — `travelTimeMin: 20, activityTimeMin: 30` — purely so `assess` has something to score, then publishes the result as the session's overall safety (`routes/airport.ts:593-599`); those two numbers are identical for every session at every airport. **[463]** |
| L294 | C2. Never swallow a schema/data error into plausible empty operational state without structured logging and degraded confidence | W | Half-built, unevenly. The **write** path logs: recommendation delete/insert failures and the `recommendation_generated` event failure all warn with the error (`LayoverRecommendationService.ts:311-328`), `emitEvent` warns (`LayoverSessionService.ts:108`), `suggestSafeReturn` warns (`LayoverNotificationService.ts:114-118`), and the passport seam warns explicitly because *"a silently lost layover stamp is a product-integrity gap"* (`routes/airport.ts:464-467`). The **read** path does not: nine bare `catch { return null }` / `catch { return [] }` blocks in `LayoverSessionService.ts` (`:149, 191, 217, 235, 254, 276, 301, 321, 343`), plus `loadStops` (`routes/airport.ts:871-884`), `fetchDiscoveryPlaces` (`LayoverRecommendationService.ts:198-200`), `cityPresence` (`routes/airport.ts:969-971`) and `resolveAirportForSession` (`:127`). Degraded confidence exists nowhere. **[463]** |
| L295 | C3. Never let a test fixture assert impossible production joins; live-schema/literal checks must cover safety-critical query paths | W | The repo-wide guards do reach layover — `checkEnumLiterals.ts:73-83` scans `routes/` and `services/`, so a filter on a literal `layover_sessions.status` or `layover_recommendations.rec_type` cannot hold would fail CI; `checkMissingLiveColumns.ts` checks 0127's columns against the live schema. What is missing is the fixture half: `test/airport.test.ts` uses a hand-rolled fake client whose filters are `r[col] === val` predicates, exactly the structure `checkEnumLiterals.ts:20-27` documents as *"structurally incapable"* of catching a bad literal — and no layover test runs against a real CI schema. |
| L296 | C5. Never certify a recommendation against a snapshot other than the one returned with it | N | There are no snapshots to mismatch. The nearest analogue of the violation is live: `GET /:id/recommendations` regenerates and replaces the whole set whenever `layover_safety_engine_enabled` is on (`routes/airport.ts:806-807#isSafetyEnabled` → `LayoverRecommendationService.ts:645-650#layover_recommendations").delete()`), so the ids a client holds are destroyed under it and a subsequent `POST /stops/from-recommendation` (`routes/airport.ts:1164`) refers to a row that no longer exists. |

---

## 4. CANNOT-VERIFY

Exactly one requirement cannot be settled by reading this tree. It is listed here and is **not**
folded into either side of the score.

| id | Requirement | Why it cannot be verified from the tree |
| --- | --- | --- |
| **L201** | §19.1 — *"Computed snapshots, risk, return plans and certification fields are server-controlled."* | The verdict turns on a production fact I was instructed not to query. What the tree shows: the only computed fields that exist (`safety_rating`, `return_buffer_min`, `hard_return_time` on `layover_recommendations`) are governed by a policy with **no `WITH CHECK`** clause — `0127:144-151` — and PostgreSQL then reuses the `USING` predicate as the write check, so the policy *as written* admits owner INSERT and UPDATE. What the tree does not show: whether `authenticated` actually holds INSERT/UPDATE privilege on that table in production. That grant is not pinned by `src/security/authorization-contract.json` (the table is absent from all seventeen entries, L199), so `checkAuthorizationContract.ts` never reads it, and no migration in the tree revokes it. If the grant exists, this is a client-writable certification field — the exact thing the requirement forbids. If it does not, the requirement is met by accident of a default nobody asserted. **Either way the missing `WITH CHECK` should be added**, and the table should be entered in the authorization contract so the answer stops depending on an unasserted default. The sibling table `layover_plan_stops` in the same migration has both clauses (`0127:179-190`). |

### Three facts I could not check, which are notes rather than verdicts

None of these changes any verdict above; each would change how a reader weights them.

1. **Whether the five layover feature flags are still TRUE in production.** `0127:224-230` seeds
   `airport_mode_enabled`, `layover_safety_engine_enabled`, `airport_pulse_enabled`,
   `layover_plans_enabled` and `layover_compass_enabled` to `TRUE` with
   `ON CONFLICT (flag) DO UPDATE SET enabled = EXCLUDED.enabled`. Since the tables exist, that
   seed ran. They could have been flipped since. Every route in `routes/airport.ts` is gated on
   `airport_mode_enabled` through the shared fail-closed helper (`:38`), so if it is off the
   whole surface is dark and every BUILT verdict above describes unreachable code.
2. **Whether `airport_profiles` holds any curated rows.** If it is empty or sparse, every real
   session runs on `buildFallbackProfile`'s generic 60/90/120/180/30/15/20 buffers
   (`AirportProfileService.ts:58-68`) — which is the L243 divergence realised, and would mean the
   *entire* deployed safety arithmetic is generic constants regardless of airport.
3. **Whether `layover_sessions` holds rows at all.** The tables being deployed is not evidence
   that anything has run. As with the intel spine (`census-sensing.md`), a reader wanting
   "correct *and* demonstrated" should treat every verdict here as a statement about code.

---

## 5. What PR #463 would change

`pr/463` ("Layover: stop rating journeys nobody measured, and gate leaving on entry",
`599155f9`..`aecae521`, 6 commits, +2265/−154 across 15 files) is **unmerged** and is the only
work in the corpus that moves this spec's numbers. It is not attributable to the spec — it cites
migration 0169 and the code's own defects, never this document — but it independently
reinvents §6.1's entry gate and Appendix C1's no-substitution rule.

**Verdicts it changes**

| id | Requirement | Main | With #463 | What changes |
| --- | --- | --- | --- | --- |
| L48 | §6.1 — entry ≠ CONFIRMED_ALLOWED ⇒ forbid landside | **N** | **C** | `pr/463:src/lib/layoverEntryEligibility.ts` resolves the corridor from `traveler_passports.issuing_country`, `airport_profiles.country_code` and `lookupRequirement`, behind the existing `passport_entry_intelligence_enabled` flag, and `adviseLeaving` takes it as a required argument. The gate **can only downgrade** — asserted as a monotonicity property, not a comment — and `entry === null` is treated as unresolved, so a caller that forgets gets the cautious answer. |
| L34 | §4.1 — `EntryPermissionState` | **N** | **C** | The `EntryEligibility` union (`permitted` / `not_permitted` / `unresolved`) is the spec's three states, plus five *distinct* unresolved reasons (`entry_intelligence_disabled`, `no_passport_on_file`, `airport_country_unknown`, `no_data_for_corridor`, `lookup_failed`) — each needing something different from the user, never merged. |
| L293 | App C1 — never substitute a semantic stand-in for a missing fact | **N** | **C** | All four fabricated numbers are deleted with no replacement: `estimateTravelTime`, the hardcoded 30-minute Quick City Tour leg, and the fictitious `travelTimeMin: 20 / activityTimeMin: 30` probe in `GET /:id/safety` (replaced by `assessWindowOnly`, which makes no journey claim at all). `ActivityCandidate.travelTimeMin` becomes `number \| null` and `assess` **fails closed** on null — never "safe", never "possible_but_risky" — with a warning naming the real cause. Inside the terminal, 0 stays a fact. |
| L47 | §6.1 — expected return ≤ hard return | **W** | **C** | `computePlanFit` no longer sums unknown legs as `?? 0`; an unknown total is never a fit, and the last-stop return approximation survives only as an explicitly labelled lower bound that can refuse but never certify. Stop writes stop laundering `null` into `0`. |
| L230 | §21.1 — unknown entry permission ⇒ no landside recommendation | **N** | **C** | Covered by `pr/463:src/test/layoverProductionPath.test.ts` (568 lines) and `layoverRouteFailureSemantics.test.ts` (270 lines), which drive the **real producers** rather than hand-built candidates. |
| L235 | §21.2 — property-based tests for "worse input cannot produce safer output" | **N** | **C** | The entry-gate monotonicity property is asserted directly. |
| L262 | §24 — live-feed fallback ladder | **W** | **C** | `resolveAirportForSession` returns a discriminated result (`{ok:true, curated}` / `{ok:false, reason:"airport_read_failed"}`), and every caller that produces a safety verdict now **refuses** rather than silently substituting generic buffers for an airport it could not read. `mirrorSessionToTrip` takes the resolution whole so two arguments cannot disagree. |
| L9 | §2.1 — never fabricate freshness | **W** | **W** (improved) | The travel-time fabrication and the failed-read substitution both go; the airport's data maturity is still not disclosed to the client. |
| L4 | §2.1 — unknown critical facts fail closed | **N** | **W** | Unknown *entry* now fails closed. Unknown *baggage* is still unrepresentable (L35), and there is still no confidence band (L37). |
| L15, L65, L294 | domain boundary / feasibility formula / error-swallowing | **W** | **W** (improved) | Entry truth acquires an owner; the formula's terms become honest nulls rather than constants; `resolveAirportForSession` stops swallowing — but `LayoverSessionService`'s nine bare catches survive untouched. |
| L199 | §19-8 — postconditions + authorization-contract coverage | **N** | **N** (improved) | `pr/463:src/migrations/2312_layover_travel_time_unknown.sql:101-136` carries six real postconditions on exactly the columns it changes, and `checkNotNullWrites.ts` is extended with `parseBaselineSchema.ts`. 0127's tables still have no postconditions and still appear in no authorization contract. |

**Net effect:** BUILT-AND-CORRECT 10 → **17** (five NOT-BUILT and two BUILT-BUT-WRONG promoted);
NOT-BUILT 202 → **196**; BUILT-BUT-WRONG 83 → **82** (−2 promoted, +1 from L4's N→W).
CONSTRUCTED% would rise 31.4 % → **33.4 %** (99/296) and CORRECT% 3.4 % → **5.7 %** (17/296).
Spec-attributable would remain **0.0 %**.

**What #463 does not fix, and should:** the L53 monotonicity violation. Its own monotonicity
property covers the *entry gate* only. `timeOfDayExtra`'s step function is untouched on that
branch, so a one-minute-earlier departure across 20:00 or 22:00 still moves the hard return
deadline nine minutes later. It also leaves the mixed-buffer `/safety` response (headline
defect 2 is partly addressed by `assessWindowOnly`, but `returnBufferMin` there comes from
`computeBuffer(… session.departureTime …)` while `hardReturnTime` still comes from the
cutoff-based window), and it does not touch the missing `WITH CHECK` (L201), the discarded
Telegraph message (L271), the unreachable Compass endpoint, or the unmounted
`LayoverReturnPanel`.

**PRs #464 and #469** also touch `routes/airport.ts` and change no verdict here. #464
(`fdaba436`, 46 insertions in this file) is the same "a failed read must never be written back as
a default" class as #463's airport-resolution fix; #469 (`b14cbf68`, 11 insertions) makes the
`blocks` read fail closed at 15 sites, one of which is `cityPresence` — already fail-closed on
that path in main (`routes/airport.ts:940-944`), so it hardens the buddy list (`:1374-1385`)
rather than changing L127.

---

## 6. Summary by section

| Section | n | C | W | N | ? |
| --- | ---: | ---: | ---: | ---: | ---: |
| §1 Architectural mandate | 2 | 0 | 2 | 0 | 0 |
| §2.1 Non-negotiable rules | 8 | 1 | 3 | 4 | 0 |
| §3 Domain boundaries | 9 | 1 | 7 | 1 | 0 |
| §4 Canonical domain model | 13 | 0 | 4 | 9 | 0 |
| §4.1 Core enums | 6 | 0 | 4 | 2 | 0 |
| §5 State machines | 6 | 0 | 0 | 6 | 0 |
| §6 Feasibility engine | 2 | 1 | 1 | 0 | 0 |
| §6.1 Hard invariants | 7 | 2 | 2 | 3 | 0 |
| §6.2 Time estimates | 2 | 0 | 0 | 2 | 0 |
| §7 Temporal Freedom Engine | 4 | 0 | 1 | 3 | 0 |
| §8 Reachability / envelope | 8 | 0 | 1 | 7 | 0 |
| §8.1 Route robustness | 6 | 0 | 0 | 6 | 0 |
| §9 Experience Compiler | 3 | 0 | 2 | 1 | 0 |
| §9.1 Candidate ranking | 2 | 0 | 1 | 1 | 0 |
| §10 Airport Intelligence | 6 | 0 | 1 | 5 | 0 |
| §10.1 Contradiction handling | 5 | 0 | 0 | 5 | 0 |
| §11 Event architecture | 2 | 0 | 1 | 1 | 0 |
| §11.1 Replanner pipeline | 8 | 0 | 1 | 7 | 0 |
| §12 Compass contract | 14 | 0 | 2 | 12 | 0 |
| §12.1 Value of information | 1 | 0 | 0 | 1 | 0 |
| §13 Map semantics | 12 | 0 | 2 | 10 | 0 |
| §14 Social / presence | 6 | 0 | 3 | 3 | 0 |
| §14.1 Crew constraints | 7 | 0 | 0 | 7 | 0 |
| §15 Safe Return | 6 | 0 | 0 | 6 | 0 |
| §15.1 One-tap abort | 2 | 0 | 0 | 2 | 0 |
| §15.2 Disruption mode | 2 | 0 | 0 | 2 | 0 |
| §16 Offline / battery | 8 | 0 | 1 | 7 | 0 |
| §17 Data lifecycle | 6 | 0 | 2 | 4 | 0 |
| §17.1 Permission prompting | 5 | 1 | 1 | 3 | 0 |
| §18 Service interfaces | 23 | 2 | 9 | 12 | 0 |
| §19 Storage / migration plan | 8 | 0 | 5 | 3 | 0 |
| §19.1 RLS expectations | 6 | 0 | 3 | 2 | 1 |
| §20 Observability / ledger | 12 | 0 | 1 | 11 | 0 |
| §21 Certification rule | 1 | 0 | 0 | 1 | 0 |
| §21.1 Scenario matrix | 15 | 0 | 1 | 14 | 0 |
| §21.2 Test layers | 9 | 0 | 2 | 7 | 0 |
| §22 Airport maturity | 8 | 0 | 2 | 6 | 0 |
| §23 Security / abuse | 8 | 1 | 3 | 4 | 0 |
| §24 Performance / reliability | 8 | 1 | 5 | 2 | 0 |
| §25 Integration points | 11 | 0 | 8 | 3 | 0 |
| App A Reason codes | 15 | 0 | 0 | 15 | 0 |
| App C Developer rules | 4 | 0 | 2 | 2 | 0 |
| **Total** | **296** | **10** | **83** | **202** | **1** |

### Where the correctness is

All ten BUILT-AND-CORRECT verdicts cluster in three places, and none of them is in the spec's
subject matter:

- **Boundary hygiene the tree already practises** (L45 no LLM in the calculation, L16 Compass
  cannot own the deadline, L266 AI outage degradation). These are properties of how the existing
  code is *structured*, and they would hold whether or not this spec existed.
- **Privacy by construction** (L8, L253). The layover surface cannot emit a coordinate because
  no coordinate-carrying type reaches the client. Real, and stronger than the spec asks.
- **Two service methods and one permission policy** (L170 `createManual`, L171 `getActive`,
  L167 manual creation remains possible) — the parts of the spec that happen to describe an
  ordinary CRUD surface.

The two `⌀` verdicts (L51, L52) are monotonicity properties that hold because their inputs do not
exist. Reject those and the correct column is **8**.

Everything the spec is *about* — a certified snapshot lifecycle, a time budget with percentiles
and confidence, an entry gate, isochrone reachability, canonical external events, a replanner, a
decision ledger, reason codes, crews, outcomes, an airport maturity model — is NOT-BUILT, with
the single exception that PR #463 supplies the entry gate.

---

## 7. Recount — `9c26efba` and the 2026-09-07 build pass

Paths relative to `artifacts/api-server/src/`. Every verdict change cites the
line that earns it. Changes are gated, additive, or apply an owner decision
already made; the one visible-behaviour repair is behind a flag seeded FALSE.

### What was live vs dark, measured before changing anything

| Path | Live? | Reading |
| --- | --- | --- |
| Dashboard `GET /:id/overview`, `/:id/recommendations`, `/:id/buddies` | **Live** — called on every dashboard load (`app/layover/[id].tsx:104-108`) | 5 sessions ever, 0 active |
| `GET /:id/buddies` serving `rent_buddy_profiles` | **Live, wrong** — 6 active buddy profiles served while `rent_buddy_enabled` = FALSE | every load |
| "Add to plan" from a recommendation (`POST /stops/from-recommendation`) | **Dead in production** — cards never carry an id | 0 stops ever |
| `GET /:id/safety`, `POST /:id/compass` | **Dark** — `LayoverRecommendationScreen`, `LayoverReturnPanel` unmounted | — |
| `PATCH /sessions/:id` | Reachable, **no client caller** (`updateLayoverSession` has no importer) | — |
| `DELETE /sessions/:id` | **Live** — always `cancelled` | 2 cancelled, 0 completed |

### Verdict changes

| id | Was | Now | Evidence |
| --- | --- | --- | --- |
| L53 | W | **C** | `9c26efba`: `computeReturnDeadline` (`LayoverSafetyEngine.ts:212`) is the single anchor; 1-Lipschitz ramp; 1,520,640-case sweep in `test/layoverDeadlineMonotonicity.test.ts`. Also closes headline defect 2 (one buffer per response). Not spec-attributable (cites the census, not the spec). |
| L201 | ? | **C** (tree) | `2335_layover_recommendation_write_boundary.sql`: `layover_recs_owner` FOR SELECT, `authenticated` = SELECT only, measured on CI (`pg_policies`, `role_table_grants`, `column_privileges` INSERT/UPDATE = 0). **Production still open.** |
| L199 | N | W | 2410 carries four postconditions (`2410_layover_recommendation_identity.sql:82-103`); `security/authorization-contract.json:205` now pins `layover_recommendations` (grants, no client-writable columns, one SELECT policy). `layover_sessions` / `layover_plan_stops` remain uncontracted — the contract's invariant 1 requires SELECT-only client grants and those tables are owner-writable by design. 0127 still has no postconditions. |
| L41 | N | W | `computeReturnState` (`LayoverSafetyEngine.ts:382`) derives RETURN_SOON at `hardReturn − 30 min` (`RETURN_SOON_LEAD_MIN`, `:84`), wired into every window (`:463`) and serialised to the client by `serializeWindow`. No notification fires and discovery is not de-emphasised — those effects are client/Safe Return work. |
| L42 | N | W | RETURN_NOW at `hardReturn`; CONNECTION_AT_RISK once the traffic + time-of-day cushion is consumed (`:382-392`). No CTA switches. |
| L140 | N | **C** | The ladder NORMAL → RETURN_SOON → RETURN_NOW → CONNECTION_AT_RISK exists as a deterministic, certified derivation with two proved properties — monotone in time and in the cutoff — over 3 timezones incl. two DST falls-back (`test/layoverReturnState.test.ts`, 20k+ and 10k+ point sweeps). L141–L145 (what happens AT the state) stay N. Spec-attributable. |
| L278, L280, L290, L292 | N | **C** | `LAYOVER_REASON_CODES` declares Appendix A's fifteen (`:48`); `adviseLeaving` emits `ENTRY_NOT_CONFIRMED` always (`:499` — entry is never confirmed on main, so the code is always true), `AIRPORT_MATURITY_LIMITED` when `!airport.verified` (`:500` — every production airport), `RETURN_THRESHOLD_REACHED` at RETURN_NOW+ (`:502`), `INSUFFICIENT_USABLE_TIME` on verdict `no` (`:538`). The other eleven are declared and **never emitted** because their triggering fact does not exist (baggage-unknown is unrepresentable, L35); they stay N. Spec-attributable. |
| L235 | N | **C** | Property sweeps for "worse input cannot produce safer/larger output": cutoff monotonicity of the deadline (`layoverDeadlineMonotonicity.test.ts`) and of the return state (`layoverReturnState.test.ts`, "monotone in the flight cutoff"). Spec-attributable. |
| L258 | W | **C** | `recommendation_generated` now records `engineVersion`, the deadline inputs (airport, flags, cutoff, computedAt), the buffer breakdown, `hardReturnTime` and a ratings histogram for every `safety_rating` / `return_buffer_min` / `hard_return_time` written (`LayoverRecommendationService.ts:420-440`). |
| L207, L206 | N | W | The event metadata above is a DecisionRecord in substance (sessionId, engineVersion, inputFacts, result, computedAt) but not in name, lacks snapshotId / inputHash / sourceRefs / rulesApplied / reasonCodes, and only the recommendation recomputation writes one — the overview window writes nothing. |
| L5 | N | W | `LAYOVER_ENGINE_VERSION` (`:31`) on every window and advice (`:463`, `adviseLeaving` `engineVersion`), and the recorded inputs make a by-hand replay possible. No version column on rows; no replay entry point (L191 stays N). |
| L214 | N | W | `session_completed` is now writable (below), so the metric is derivable by query — the same rule that scored L208 W. Not emitted. |
| L255 | W | **C** | `GET /:id/buddies` gates on `rent_buddy_enabled` through the shared fail-closed reader (`routes/airport.ts:1427`), the same row `lib/buddyMapRead.ts:199` and `routes/rentABuddy.ts` gate on. Applies an owner decision already made (the flag is FALSE in production); with it, the marketplace's own controls govern. Its blocks read also fails closed now (`:1458`) — overlapping PR #469's change at this one site. |
| L33 | W | W (improved) | `completed` is reachable: `DELETE /sessions/:id` takes `outcome` in body or query (`routes/airport.ts:1623-1626`), default `cancelled` unchanged. Thirteen spec states still absent. |
| L174 | W | W (improved) | `close(sessionId, outcome)` now has an outcome that lands (status + `session_completed` event). No `layover_outcomes` record (L32 stays N). |
| L172 | W | W (improved) | `PATCH` validates the merged window — departure after arrival, ≤ 48 h, boarding inside the window, not already departed — and converts the `*Local` wall-time fields it always accepted but silently dropped (`routes/airport.ts:496-557`). Still no constraint entity. |
| L97, L296 | W / N | W (improved) / N | Behind `layover_stable_recommendation_ids_enabled` (2410, seeded FALSE): regeneration upserts on `(session_id, rec_key)` (`LayoverRecommendationService.ts:359-396`, key at `:223`) and deletes only cards that no longer apply, so ids survive, `layover_plan_stops.recommendation_id` survives, and the client's "Add to plan" becomes reachable. Flag off = the legacy path byte-for-byte (`:398`), pinned by `test/layoverRecommendationIdentity.test.ts`. Still client-GET-driven, still no snapshot. |
| L294 | W | W (improved) | `fetchDiscoveryPlaces` checks and logs the read error (`:191`). Log-only: the path was already fail-closed via `if (!data)`; the hand-revert of the check alone passes its test and the test says so. Nine bare catches in `LayoverSessionService.ts` and the swallowed airport read (`resolveAirportForSession`) remain. |

### Corrected §6 summary (rows that changed only)

| Section | n | C | W | N | ? |
| --- | ---: | ---: | ---: | ---: | ---: |
| §2.1 Non-negotiable rules | 8 | 1 | 4 | 3 | 0 |
| §5 State machines | 6 | 0 | 2 | 4 | 0 |
| §6.1 Hard invariants | 7 | 3 | 1 | 3 | 0 |
| §15 Safe Return | 6 | 1 | 0 | 5 | 0 |
| §19 Storage / migration plan | 8 | 0 | 6 | 2 | 0 |
| §19.1 RLS expectations | 6 | 1 | 3 | 2 | 0 |
| §20 Observability / ledger | 12 | 0 | 4 | 8 | 0 |
| §21.2 Test layers | 9 | 1 | 2 | 6 | 0 |
| §23 Security / abuse | 8 | 3 | 1 | 4 | 0 |
| App A Reason codes | 15 | 4 | 0 | 11 | 0 |
| **Total** | **296** | **20** | **87** | **189** | **0** |

### What this pass did NOT do, and why

- **Did not re-author PR #463 or #469.** Both are open, both say "do not
  merge without an owner decision", and both now conflict with `9c26efba`.
  Re-implementing them here would have produced a third divergent copy of the
  same fix on a live safety file. Owner decision: rebase-and-merge, or ask for
  a port.
- **Did not change any number a traveller sees.** `returnState`, `engineVersion`
  and `reasonCodes` are new fields the client ignores; the buddies gate applies
  a flag the owner already set to FALSE; the PATCH validation only refuses input
  the POST already refused; the completion outcome defaults to the old value;
  the stable-id path is flag-off.
- **Did not touch §25 outbound integration.** `LayoverSnapshot` still has zero
  occurrences; Compass, Trips, Discovery and Map still reference nothing under
  `services/airport/`. Every one of those contracts is owned by another surface.
- **Did not apply 2335 or 2410 to production.** Both are on CI
  (`schema_migration_ledger` rows `2335…`, `2410…`); production carries neither.

### Owner decisions surfaced

1. Apply `2335` to production — the certified fields are client-writable there today.
2. Apply `2410` to production and flip `layover_stable_recommendation_ids_enabled` — this is the only way "Add to plan" from a recommendation ever renders.
3. Merge or port PR #463 (entry gate; fabricated travel time; failed-read substitution) and PR #469 (blocks fail-closed) after rebasing over `9c26efba`.
4. Whether `airport_profiles` should carry curated buffers at all: 3,206 rows, 0 non-default. Until then the spec's L0 "airport-side guidance only by default" (L243) is the honest product state and the engine's `AIRPORT_MATURITY_LIMITED` code now says so on every session.

## 8. Lane B4 (2026-09-07, later) — L201 verified, L199 pinned, L9 disclosed, L50 not built

Paths relative to `artifacts/api-server/src/`. Every number below was measured
in this pass; nothing is carried forward from §7 without being re-read.

### What the brief got wrong, and what was already there

The lane brief asked for a new `2510_layover_write_boundary.sql` implementing
L201. **That migration already existed** as
`migrations/2335_layover_recommendation_write_boundary.sql` (committed in
`9c26efba`, applied to CI, ledgered with checksum `efe7172d…`), and the
contract entry the brief asked for under L199 already existed for
`layover_recommendations` (`security/authorization-contract.json`, entry
`layover_recommendations`). The lead corrected the brief mid-pass and handed
over 2335/2410 for in-place edits. **That edit is not possible either**: the CI
ledger row carries the sha256 of the file as committed, equal to the file on
disk, and `scripts/checkMigrationLedger.ts` reports an edited applied
migration as its own finding. Anything 2335 lacks has to be a new file.

### Measured before changing anything (aggregates only)

| Fact | production `ajrurzioarfkagpuxfnb` | CI `hwokxgbmezheskbzskfr` |
| --- | --- | --- |
| `layover_recs_owner` cmd / `with_check` | **ALL / NULL** (0127 state) | SELECT / NULL (2335 applied) |
| Policies on `layover_recommendations` | exactly 1 | exactly 1 |
| `authenticated` on `layover_recommendations` (aclexplode) | DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE | SELECT |
| `anon` on `layover_recommendations` | same full set | none |
| `service_role` on `layover_recommendations` | full set | SELECT,INSERT,UPDATE,DELETE |
| Sibling tables, `anon`/`authenticated` | full set incl. TRUNCATE | full set minus TRUNCATE (MAINTAIN remains) |
| `rec_key` column / stable-ids flag row | absent / absent (2410 not applied) | present / present |
| `schema_migration_ledger` | **absent** | present |

So the question the census left open in L201 — "whether it is exploitable
depends on the grant" — is answered: **yes, in production, today.** The grant
is the blanket default, the policy is FOR ALL with no WITH CHECK, and the only
thing 2335 changes is exactly that. `MAINTAIN` (PG17) does not appear in
`information_schema.role_table_grants`, so the contract checker cannot see it;
it is noted, not pinned.

### T1 — 2335 and 2410 read adversarially: both sound

- **No live path breaks under 2335.** Every `layover_recommendations` access
  runs on `getServiceClient()`: `routes/airport.ts` constructs `sc` that way at
  every handler (`:268, :307, :484, :581, :644, :694, :739, :792, :840, :1047`)
  and passes it to the services; `services/airport/*.ts` contain no
  `createClient` and no `getServiceClient` (grep: zero hits), so the
  regeneration write, the stale-scan delete and the admin update all carry
  BYPASSRLS. There is no mobile client in this repository (`artifacts/` holds
  `api-server` and `mockup-sandbox` only), and no other file in the tree names
  the table outside migrations, tests and generated types.
- **No surviving policy dominates.** One policy in both databases (table
  above). `layover_sessions` / `layover_plan_stops` keep their FOR ALL +
  WITH CHECK owner policies; `layover_events` / `airport_profiles` are SELECT-only.
- **2335's one gap is the postcondition block.** Built as
  `migrations/2510_layover_write_boundary_postconditions.sql` — verify-only,
  changes nothing, six conditional `RAISE EXCEPTION`s (RLS on; exactly one
  policy, `layover_recs_owner`, FOR SELECT, permissive, `{authenticated}`;
  `authenticated` = SELECT and not INSERT/UPDATE/DELETE/TRUNCATE; `anon` and
  PUBLIC hold nothing; `service_role` = DML and not TRUNCATE; no client
  TRUNCATE on the four siblings). It **fails on production today by design**
  and must run after 2335. Passes `migrationDeployability` (every RAISE is
  under an IF) and `check:migration-prefixes`.
- **2410** carries preconditions and four real postconditions already; the
  unique index is full (PostgREST `on_conflict` needs that), the upsert omits
  `id` so identities survive, the flag seed is `DO NOTHING`, and the flag is
  read through the shared fail-closed reader (`lib/featureFlags.ts:21`). No
  change made.
- Rollback files exist for both: `db/rollback/2026-09-07-2335-…` and `…-2410-…`.

### T2 — L199: the other four layover tables enter the contract

`security/authorization-contract.json` now pins `layover_sessions`,
`layover_plan_stops`, `layover_events` and `airport_profiles` **at the state
measured on CI**, under a top-level `$pinnedAsMeasured` note saying so. They
are broader than invariant 1's SELECT-only ideal (0127's default
DELETE/INSERT/REFERENCES/TRIGGER/UPDATE grants, minus the TRUNCATE 2335 took
back); what denies client writes today is RLS — owner-scoped WITH CHECK
policies, and no `anon` policy at all — plus the fact that every application
writer is the service client. This is a pin, not an approval: narrowing those
grants is a separate migration and owner decision **L199-b**.

The CLI (`check:authorization-contract`) cannot run in this environment (no
`SUPABASE_URL` / token; it exits 2). The same evaluator it calls
(`security/authorizationContract.ts:evaluateContract`) was run over the three
queries it issues, answered by CI: **0 violations** on the measured rows, and
four perturbations each caught — `layover_recs_owner` back to FOR ALL,
`authenticated` UPDATE restored on `layover_recommendations`,
`layover_sessions_owner` dropped, `anon` TRUNCATE restored on
`layover_plan_stops`. `test/authorizationContractGuard.test.ts` still passes
over the 22-table contract.

### T3 — L9 / L65: the category constant is disclosed, not replaced

No routing was built. What travels now is **provenance**:

- `LayoverSafetyEngine.ts:106` declares `TravelTimeSource =
  inside_airport | category_default | measured`; `:121` `travelTimeSourceFor`
  resolves an absent or unknown value to the least-trusted kind that applies
  (never `measured`); `ActivityCandidate.travelTimeSource` is optional.
- `LayoverRecommendationService.ts` tags every candidate — airside `inside_airport`
  (`:121`), discovery places `category_default` (`:210`, the SELECT reads no
  coordinate), city escape `category_default` (`:328`) — keeps the source
  beside the row (`:353`, not in the insert payload: the table has no
  column and adding one unconditionally would break the write on any database
  without the migration, the hazard 2410 gates), and the persisted read path
  infers it from `inside_airport` (`:491`) — exact only while nothing
  produces `measured`.
- `LayoverPrivacyGuard.ts:49` adds `travelTimeSource` to `SafeRecommendation`;
  `:89` always populates it.
- `adviseLeaving(airport, session, window, facts?)` (`LayoverSafetyEngine.ts:557`)
  pushes `TRAVEL_TIME_UNMEASURED_UNKNOWN` into `unknowns[]` whenever the
  traveller intends to leave and the facts do not say `measured` (`:572`);
  absence fails closed. `routes/airport.ts:663` labels the safety route's
  literal 20 and returns `travelTimeSource` (`:667`); `/overview` passes no
  facts and relies on the closed default (`:1117`).
- `test/layoverTravelTimeProvenance.test.ts` (17 tests, registered): resolver,
  both generation paths, persisted read, sanitizer, `adviseLeaving` in all four
  states, the three routes at the HTTP boundary, and a tripwire that `"measured"`
  appears nowhere but the engine's declaration and comparison. Non-vacuity was
  proved by four breaks (drop the push; tag discovery `measured`; tag the
  returned card `measured`; drop the field in the sanitizer): 4, 4, 4 and 5
  failures respectively, 17/17 after restore.

What this does NOT do: change any number a traveller sees, or render the
disclosure — the client lives outside this repository. L9 and L65 stay **W**;
the fabrication is now labelled at the API, which is the obligation §2.1
actually states.

### T4 — L50: NOT BUILT, with the reason

`status IN ('active','hidden','flagged')` (`0127:132-134`) could express BLOCKED
as `hidden` without a new enum value. It was not built because (a) hiding
`not_recommended` cards changes what the traveller sees, which every change on
this surface so far has refused to do without a flag seeded FALSE, and (b) the
read path ignores `status` entirely: `getRecommendations`
(`LayoverRecommendationService.ts:491-500`) selects `*` with no status
filter, so **a card an admin sets to `hidden` through
`POST /admin/airport/reports/:id/resolve` is still returned to the user** —
the admin "hide" action is ineffective today. A BLOCKED status would inherit
that defect until the read path filters, and filtering is the same visible
change. Owner decision **L50-a**: is BLOCKED "not rendered" or "rendered as
refused"? Then a flag, a status filter that also makes admin-hide real, and
the write.

### Verdict changes

| id | Was (§7) | Now | Evidence |
| --- | --- | --- | --- |
| L201 | C (tree) | **C (tree)**, postconditions now exist | 2510 asserts 2335's six claims; production still open (owner decision 1 stands). |
| L199 | W | **W (improved)** | all five layover tables contracted; evaluator proven non-vacuous; 0127 itself still has no postconditions. |
| L9 | W | **W (improved)** | provenance field + `unknowns` disclosure at the API; no route measured; client rendering out of tree. |
| L65 | W | W | terms are still constants; now labelled. |
| L50 | N | N | not built; admin-hide defect found (above). |

### Gates, measured at the end of the pass

- `npm run typecheck`: 0 errors.
- `typecheck:tests`: my file adds 0 diagnostics; the gate reports **one new
  diagnostic in `test/mapTripProjectionWorker.test.ts`**, an uncommitted
  sibling-lane file, not this lane's.
- `check:test-registration`: `layoverTravelTimeProvenance.test.ts` registered;
  the check fails on `test/trustEmitterWiring.test.ts` (sibling, unregistered).
- `migrationDeployability.test.ts`: passes 2510; fails on
  `2462_meetup_time_votes_write_boundary.sql` (sibling band, unconditional RAISE).
- `check:enum-literals`, `check:migration-prefixes`: pass.

### Owner decisions surfaced by this pass

5. Apply 2335 **then** 2510 to production; 2510 is the loud check that 2335 took.
6. **L199-b** — narrow `anon`/`authenticated` on `layover_sessions`,
   `layover_plan_stops`, `layover_events`, `airport_profiles` to SELECT-only
   (or nothing for `anon`), since no application path writes them as a user.
   Shrink the four contract entries in the same PR.
7. **L50-a** — what BLOCKED means on screen, before any status write is built.

---

## 9. Re-census — 2026-09-08, HEAD `cdfff599`

Paths relative to `artifacts/api-server/src/` unless prefixed `travel-buddy-standalone/`.
Same denominator (296), same rule (§1), same buckets. **Every row below was
re-derived by opening the file at this commit.** Rows not restated here keep the
verdict §7 or §8 left them with; the §6 summary is superseded by the table at
the end of this section.

### What landed, verified rather than taken on trust

| Claim in the brief | Verified? | Where |
| --- | --- | --- |
| A certified feasibility record with engineVersion, feasibilityVersion, inputHash, verdict, envelope, buffer breakdown, reasons, reason codes, confidence | **Yes** | `services/airport/LayoverFeasibility.ts:340-388` (record), `:69` `LAYOVER_FEASIBILITY_VERSION`, `:325` `feasibilityInputHash`, `:451` `certifyFeasibility` |
| `replayFeasibility` reproduces a record deep-equal | **Yes** | `LayoverFeasibility.ts:520` (`= certifyFeasibility`, no clock, no I/O — `:449-450`), pinned by `test/layoverFeasibilityRecord.test.ts` |
| Five derivations collapsed onto one | **Yes** | The only remaining callers of `computeWindow`/`adviseLeaving`/`computeReturnDeadline` outside the engine are inside `LayoverFeasibility.ts:455-472`. `LayoverRecommendationService.ts:374` still calls `assess` per candidate, but against `certified.deadline` — the same certified deadline, not a second derivation |
| `routes/airport.ts` no longer imports `assess`, `computeWindow`, `adviseLeaving` | **Yes** | `routes/airport.ts:74-86` — the import block carries `certifySessionFeasibility` / `certificationHeader` only, with the reason in comment |
| Non-monotonic buffer and two-buffers-in-one-response both fixed | **Yes, and now swept** | `test/layoverFeasibilityInvariants.test.ts:225` (earlier departure never expands the envelope, 3 timezones), `:275` ("the record's deadline is always exactly cutoff minus the buffer it publishes") |
| `LayoverCrewService`, `LayoverSafeReturnService`, `LayoverDegradedService` exist | **Yes** | 512 / 520 / 341 lines |
| `LayoverPrivacyGuard` gate WIRED into `/presence` and `/overview` | **Yes** | `routes/airport.ts:1854` and `:1508` (`evaluateSharingGate`), `:1858`/`:1869` and `:1513` (`disclosePresence`), `:1377` (`publishableUserIds`) |
| `POST /airport/sessions/:id/return-now` wired, 2741 applied | **Yes** | route `routes/airport.ts:1002`; 2741 applied `20260908133347` (`lib/capability/production-applied-migrations.json`, `docs/architecture/migration-queue.md:39`) |
| `terminal_info` published via `airportRowToProfile` | **Yes, and empty** | `services/airport/AirportProfileService.ts:146`, surfaced at `routes/airport.ts:1210`. **0 of 3,206 production rows carry one**, so it is `null` everywhere |
| 2700 and 2740 written and NOT applied; 2741 applied | **Yes** | `lib/capability/production-applied-migrations.json` lists 35 entries, none of them 2700 or 2740; the production schema snapshot (watermark `20260908133347`) has no `layover_certified_computations` and no `layover_presence_ladder_enabled` flag |

### Reachability, measured before scoring anything

| Surface | Server | Client |
| --- | --- | --- |
| `certification`, `estimates` on `/safety`, `/overview`, `/stops`, `/return-deadline` | **Published** (`routes/airport.ts:830, 1121, 1535, 1611`) | **Not read.** `LayoverOverview` has 10 fields, none of them `certification` (`travel-buddy-standalone/src/services/layover.ts:161-171`) |
| `safeReturn` posture on `/safety` and `/overview` | **Published** (`:835`, `:1547`) | **Not read** (same type) |
| `offlineBundle` on `/overview` | **Published** (`:1548`) | **Not read**; no `AsyncStorage` write exists anywhere under `travel-buddy-standalone/src/services/layover.ts`, `src/context/LayoverSessionContext.tsx` or `app/layover/` |
| `POST /:id/return-now` | **Wired** (`:1002`) | **No client function.** `travel-buddy-standalone/src/services/layover.ts` exports 22 layover calls (`:275-502`); none targets `return-now` |
| `runLayoverTool` (12 §12 tools) | **Callable** (`LayoverCompassService.ts:564`); schemas declared but **deliberately not passed to the model** (`:730-736`) | Unreachable. `POST /:id/compass` remains dark — `askCompass` (`layover.ts:339`) still has no importer |
| `LayoverCrewService` (all 12 exports) | **No caller** outside `test/layoverCrewConstraints.test.ts` | — |
| `localReplan`, `sensingPolicy`, `bundleFreshness` | **No caller** outside `test/layoverDegradedOffline.test.ts` | — |
| `nextDisruptionState`, `recomputeForDisruption` | **No caller** outside `test/layoverSafeReturnAbort.test.ts` | — |
| Presence sharing gate | **Live, unflagged** — `location_preferences` and `trip_crew_location_preferences` both exist in production | The gate changes who is published; the client reads the same `othersInCity` shape |

### Verdict changes

| id | Was | Now | Evidence at `cdfff599` |
| --- | --- | --- | --- |
| L1 | W | W | One canonical derivation now exists and all five surfaces consult it (`LayoverFeasibility.ts:451`; `routes/airport.ts:798, 1033, 1096, 1499, 1604`; `LayoverCompassService.ts:109`; `LayoverRecommendationService.ts:318`; `LayoverNotificationService.ts:99`). It is still not *persisted*: `2700_layover_certified_feasibility.sql` is written and NOT applied, so there is no canonical row anywhere. Code built, storage unapplied (2700). |
| L2 | W | W | `certificationHeader` (`LayoverFeasibility.ts:535`) is published on five endpoints. No client consumes it, and the client's own thresholds still exist in the tree (`travel-buddy-standalone/src/components/layover/LayoverReturnPanel.tsx` lines 113-114, still unmounted — **deleted at `a718beb5`, after this line was written**). |
| L4 | N | **W** | Confidence now exists and is computed: `ESTIMATE_CONFIDENCES` (`LayoverFeasibility.ts:102`), `worstConfidence` (`:182`), folded onto every record (`:493`). The fail-closed half is explicitly NOT built and the file says so (`:352-362`: "This record publishes the confidence; it does NOT forbid"). Half built. |
| L5 | W | W | `LAYOVER_FEASIBILITY_VERSION` (`:69`), `inputHash` (`:325`) and a real `replayFeasibility` (`:520`) exist. Nothing is stored to version or replay (2700 unapplied). |
| L6 | W | W | The duplicate-time-budget half is genuinely closed (see the table above). "All surfaces consume the same certified snapshot" is not: there is no snapshot, and the per-request record is not shared between requests. |
| L37 | N | W | The spec's exact four members exist as `ESTIMATE_CONFIDENCES` (`LayoverFeasibility.ts:102`), are computed (`:182`) and published (`:541`). Nothing consumes the value and no `confidence_band` column exists (L21), so no decision turns on it. Reachability is the missing half. |
| L52 | C | C | **Loses its `⌀`.** A certified envelope now exists and the property is swept over it: `test/layoverFeasibilityInvariants.test.ts:180` — "a longer travel leg never expands the safe envelope", over activity times and both `verified` values. |
| L54 | N | W | `Estimate` carries every field §6.2 names (`LayoverFeasibility.ts:124-138`) for seven terms, published as `estimates` on `/safety` and `/overview` (`routes/airport.ts:832, 1536`). It **describes** the buffer rather than computing it — the file says so at `:196-201` — so the number a traveller acts on is still a bare scalar out of `computeBuffer`. |
| L55 | N | W | `SAFETY_CRITICAL_PERCENTILE = "p90"` (`:151`), overridable per call (`FeasibilityInputs.bufferPercentile`), applied by `conservativeBufferMinutes` (`:222`) and published as `bufferMinutesAtPercentile` (`:494`). A no-op on the numbers today by the file's own admission — every distribution is degenerate (`:112-121`). |
| L102 | N | W | `runLayoverTool("getLayoverContext")` (`LayoverCompassService.ts:564`), swept by `test/layoverPrivacyCompassContract.test.ts:197-223`. **Not passed to the model** (`LayoverCompassService.ts:730-736#DECLARED`) and reachable from no route. |
| L103 | N | W | `getConnectionState` — same file, same limits; `test/layoverPrivacyCompassContract.test.ts:287` asserts it does not assert a disruption state nothing measured. |
| L104 | N | W | `getTimeWallet` — same. |
| L105 | N | W | `getSafeEnvelope` — same; `:223` proves no tool can widen the certified envelope. |
| L106 | N | W | `getReachableExperiences` — same; reads the caller-supplied, already-sanitised card list. |
| L107 | N | W | `simulatePlan` — same; `:255` compares a candidate set against the certified window and refuses one that does not fit. |
| L108 | N | W | `getReturnContract` — same. |
| L109 | N | W | `getAirportState` — same; `:280` reports maturity honestly for an unverified airport. |
| L110 | N | W | `getCrewCandidates` exists and returns `{ ok: false, unavailable: true, reason }` by construction — no crew storage (L28). A declared tool with an honest refusal, reachable from nothing. |
| L111 | N | W | `requestConstraintClarification` — same file; `:375` refuses a field that would not move the outcome. |
| L112 | N | W | `replay` exists and returns `unavailable` — no event-driven replanner (§11). |
| L113 | N | W | `explainDecision` — same file; `:269` "hands back the replayable identity, not a story". |
| L114 | N | W | §12.1 is a computation, not a prompt instruction: `valueOfInformation` (`LayoverCompassService.ts:453`) re-certifies with each candidate answer flipped and compares verdict, rating and usable minutes; `nextClarifyingQuestion` (`:486`) asks only the highest-value one, and `answerLayoverQuestion` carries at most one (`test/layoverPrivacyCompassContract.test.ts:426`). The endpoint it lives on is still dark from the app. |
| L120 | N | W | `primaryAction` and `explorationCollapsed` are derived from the certified return state and published (`LayoverSafeReturnService.ts:107-118`; `routes/airport.ts:835, 1547`). The dashboard still renders the same sections; the client type has no `safeReturn` field. |
| L133 | N | W | `sharedReturnBy` takes the minimum and names the binding members (`LayoverCrewService.ts:169`), and **refuses rather than taking a minimum over a readable subset** (`test/layoverCrewConstraints.test.ts:102`). No crew storage (L28/L29), no route. |
| L134 | N | W | Explicit split plans: `CrewBranch` (`LayoverCrewService.ts:79`), asserted at `test/layoverCrewConstraints.test.ts:217`. Same reachability limit. |
| L135 | N | W | `certifyCrewPlan` (`LayoverCrewService.ts:216#certifyCrewPlan`) evaluates every branch against every member's own certified record; an uncertified member is INFEASIBLE, not assumed fine (`test:294`). Same limit. |
| L136 | N | **C** | `⌀` **vacuous.** `locationPrecisionFor` (`LayoverCrewService.ts:418`) returns `none` for a stranger and can reach `precise` only through a live, target-granted, crew-scoped grant (`:433-441`); swept, not sampled (`test/layoverCrewConstraints.test.ts:389-403`). The guard is real and fail-closed; the path it guards is empty. Scored under §1's prohibition rule. |
| L137 | N | W | `CrewShareEndReason` (`LayoverCrewService.ts:331`) names all five terminators plus a TTL and `evaluateCrewLocationShare` (`:373`) reports the FIRST cause (`test:338-376`). Nothing stores a grant. |
| L138 | N | **C** | `⌀` **vacuous.** `meetActionAvailability` (`LayoverCrewService.ts:462`) requires block-free, mutual, same-crew, public meeting point, cleared safety gate AND a non-escalated return state on both sides, and returns every failure rather than the first. Real refusal, empty path. |
| L139 | N | W | `sharedRideDisclosure` (`LayoverCrewService.ts:500#sharedRideDisclosure`). No shared-ride concept exists to disclose. |
| L141 | N | W | `explorationCollapsed` is derived and published (`LayoverSafeReturnService.ts:113`; `routes/airport.ts:1547`), tested at `test/layoverSafeReturnAbort.test.ts:138`. No surface collapses: the client does not read the field. |
| L143 | N | W | `pinTerminalContext` (`LayoverSafeReturnService.ts:115`) and `terminalInfo` now reach the API (`AirportProfileService.ts:146` → `routes/airport.ts:1210`; also `LayoverSafeReturnService.ts:180` and `LayoverDegradedService.ts:166`). **0 of 3,206 production airports carry one**, so the pinned context is `null` for every session. |
| L146 | N | W | `abortAvailable` is TRUE in every state including NORMAL (`LayoverSafeReturnService.ts:117`, asserted `test/layoverSafeReturnAbort.test.ts:156`) and `POST /:id/return-now` is wired (`routes/airport.ts:1002`). **No client exposes it** — no `return-now` call exists in `travel-buddy-standalone/src/services/layover.ts`. Reachability is the missing half. |
| L147 | N | W | Six effects, three real: landside stops cancelled with the ids actually removed (`LayoverSafeReturnService.ts:234-249`), the transition recorded in the decision ledger with certification (`:344-357`, legal since 2741), the offline deadline preserved (`buildReturnContract:158`). Mark RETURNING is built and **off** — `layover_safe_return_status_enabled` is FALSE in production. Route is `null` with `no_routing_provider` (`:279-280`); crew notification is `[]` with `no_crew_storage` (`:363-365`). |
| L148 | N | W | `DISRUPTION_STATES` (`LayoverSafeReturnService.ts:392`) is exactly §15.2's seven, `nextDisruptionState` (`:425`) walks both chains and is total over every state × event (`test/layoverSafeReturnAbort.test.ts:348`), and the disruption `OVERNIGHT` is deliberately a different type from the tier `overnight` — the confusion the body named. No disruption input exists and nothing calls it. |
| L149 | N | W | `recomputeForDisruption` (`:487`) is a FULL re-certification, proved to both expand and shrink relative to an appender (`test/layoverSafeReturnAbort.test.ts:385, 404, 418, 433`). Nothing drives it. |
| L156 | N | W | `localReplan` (`LayoverDegradedService.ts:234`) allows an offline replan only while the bundle is fresh AND the schedule is unchanged, and a refusal still hands back the last certified deadline (`test/layoverDegradedOffline.test.ts:160-212`). Not wired into any route or client. |
| L157 | N | W | `sensingPolicy` (`LayoverDegradedService.ts:297#sensingPolicy`) permits continuous GPS in exactly the returning states and nowhere else, and no permission means no sensing in every state (`test/layoverDegradedOffline.test.ts:226-256`). **The layover surface still performs no location sensing at all**, so the policy governs nothing. |
| L176 | N | W | Candidates are now assessed against the one certified deadline (`LayoverRecommendationService.ts:318, 374`) and the generation event carries the certification header (`:505`). There is no `certifyRecommendation` entry point and no per-recommendation certified contract is stored. |
| L191 | N | W | `replayFeasibility` (`LayoverFeasibility.ts:520`) reproduces a record from its stored inputs, pinned by `test/layoverFeasibilityRecord.test.ts`. It takes inputs, not `(sessionId, engineVersion)`, and nothing is stored to replay (2700 unapplied). |
| L226 | N | W | `test/layoverSafeReturnAbort.test.ts:404, 433` exercise a departure moved later and earlier through a full recompute. It is a unit test over the solver, not a scenario of a session: no delay input reaches a session. |
| L231 | N | W | `test/layoverSafeReturnAbort.test.ts:329` walks the cancellation chain and never re-enters the delay chain. Same limit — no flight feed. |
| L232 | N | W | `test/layoverCrewConstraints.test.ts:88, 217` cover both arms — earliest shared deadline and an explicit split. Same limit — no session can form a crew. |
| L234 | W | **C** | All three gaps the body named are closed: monotonicity is swept (`test/layoverFeasibilityInvariants.test.ts:115, 180, 225`), the uncertainty rules exist and are exercised (`worstConfidence`, `LayoverFeasibility.ts:182`), and the reason codes are emitted and asserted (§7). Spec-attributable — the test file cites §6.1 by name. |
| L237 | N | **C** | `test/layoverPrivacyCompassContract.test.ts` is exactly the named artifact: `:223` "NO TOOL CAN WIDEN THE ENVELOPE — every deadline and window it emits is the certified one", plus `:113-189` proving `enforceCompassEnvelope` (`LayoverCompassService.ts:307`) refuses a model answer stating a later deadline or more usable time, with positive controls on both. Spec-attributable. |
| L240 | N | W | A deterministic replay test exists (`test/layoverFeasibilityRecord.test.ts`) but over synthesised inputs. No session is recorded, so there is nothing to replay *from* (2700 unapplied). |
| L262 | W | **C** | Both halves now exist. The ladder is explicit and a **failed read is now distinguished from a missing row and refuses** rather than silently substituting generic buffers (`routes/airport.ts:135-160` — `error` is bound, logged, and returns `ok:false`). Confidence is reduced on the fallback: a fallback profile is `STATIC_DEFAULT` at fallback level 3, a real row is `AIRPORT_PROFILE` at level 2, and an unverified airport is `LOW` (`LayoverFeasibility.ts:414-421`) — which, at 0 verified production airports, is every session. |
| L293 | N | W | The three substitutions are all still there — `estimateTravelTime` 15/25 (`LayoverRecommendationService.ts:212-216`), `estimateActivityTime` 30/60/90, and the fictitious `travelTimeMin: 20 / activityTimeMin: 30` probe on `GET /:id/safety` (`routes/airport.ts:791-796`). What changed is that they no longer *pretend*: the probe is a named input of the certified record and covered by its `inputHash`, and its provenance is published (`travelTimeSource`, `routes/airport.ts:807`) and classified `STATIC_DEFAULT` / `LOW` / fallback level 3 (`LayoverFeasibility.ts:399-412`). Substitution disclosed, not removed. |
| L163 | W | W | **Evidence corrected, verdict unchanged.** `layover_events` and `layover_sessions` are in `UNCLASSIFIED_BACKLOG` (`lib/deletionDispositions.ts:370-371#layover_events`), not the erasure cascade; `layover_plan_stops` and `layover_recommendations` are in `DENOMINATOR_CORRECTION_BACKLOG` (`:571-572`); `airport_profiles` is in `UNCLASSIFIED_BACKLOG` (`:281`). `AccountDeletionService.ts` names no layover table. No layover row is erased by account deletion. |

### Rows I looked at and deliberately did NOT move

| id | Stays | Why |
| --- | --- | --- |
| L142 | N | `returnRoutePrimary` is a boolean asking for a route to be made primary. **There is no route.** `ReturnContract.route` is `null` with `routeUnavailableReason: "no_routing_provider"` (`LayoverSafeReturnService.ts:150-153`). A flag about an absent thing is not the thing. |
| L144 | N | `notifyCrew` is published; `crewNotified` is `[]` with `crewNotifyUnavailableReason: "no_crew_storage"` (`LayoverSafeReturnService.ts:363-365`), and `test/layoverSafeReturnAbort.test.ts:300` asserts it never claims otherwise. No crew, no notification. |
| L145 | N | `offerRecoveryHelp` is a boolean. No rebooking, airline or airport-help content exists anywhere in the tree. |
| L151 | N | `mapGeometry: unavailable("no_envelope_geometry")` (`LayoverDegradedService.ts:170`). An honest refusal is not a cache. |
| L152 | N | `route: unavailable("no_routing_provider")` (`:171`). |
| L153 | N | `flightStatus: unavailable("no_flight_feed")` (`:172`), and `test/layoverDegradedOffline.test.ts:126` asserts the traveller's own typed schedule is not dressed up as a confirmed flight status. |
| L154 | N | `crewMeetingPoint: unavailable("no_crew_storage")` (`:173`). |
| L155 | N | `translationPhrases: unavailable("no_phrase_catalogue")` (`:174`). |
| L150 | W | The **server** half is now real — `certifiedAt`, `staleAfter` and the record's `inputHash` travel with the bundle (`LayoverDegradedService.ts:104-127`), wired at `routes/airport.ts:1548`. The **client** half is unchanged: nothing is cached for display anywhere under `travel-buddy-standalone`. |
| L126 | N | Map offline state needs a rendered envelope timestamp. There is no map offline rendering and no envelope geometry. |
| L33 | W | `returning` is legal since 2741 (applied `20260908133347`) — 5 of the spec's 17 states. It is **never written in production**: `layover_safe_return_status_enabled` is FALSE, and the abort reports `status_unchanged_flag_off` (`LayoverSafeReturnService.ts:319`). |
| L39 | N | `active → returning` joins `active → cancelled` and `active → expired`. Three transitions out of a 17-state graph is not the graph. |
| L128 | W | `disclosePresence` can serve aggregate-only, but only when `layover_presence_ladder_enabled` is on (`LayoverPrivacyGuard.ts:452-461`). **2740 is not applied, so the flag has no row and `isFlagEnabled` fails closed.** Built and OFF; the default served in production is still L2 with up to six named profiles. |
| L127, L130 | W | The consent gate is now genuinely enforced on both sides — the viewer's own `location_mode` / `sharing_paused` / ghost mode (`LayoverPrivacyGuard.ts:300`, wired `routes/airport.ts:1508, 1854`) and the publish side (`publishableUserIds:356`, wired `:1377`), both fail-closed. This is the largest live change in the pass. It does not make presence aggregate-first (L127) or per-pair mutual (L130). |
| L209 | N | "Sessions receiving a certified snapshot" cannot be counted while no snapshot is stored (2700). |
| L218 | N | There is still no `layover-certification.md` in `docs/architecture/`, and four of the five named proof classes have no artifact. |
| L294 | W | The airport read now binds `error` and refuses (`routes/airport.ts:150-157`). Seven bare `catch { return … }` blocks remain in `LayoverSessionService.ts` (`:187, 229, 255, 367, 387, 416`). |
| L296 | N | `layover_stable_recommendation_ids_enabled` is still FALSE (`lib/capability/layover-cutover-measurement.json`); the legacy delete-and-reinsert path is what production runs. |
| L50 | N | Unchanged, and still blocked on the `L50-a` owner decision recorded in §8. |
| L34, L48, L230 | N | Entry permission state is still unread anywhere under `routes/airport.ts` or `services/airport/`. The certified record publishes `ENTRY_NOT_CONFIRMED` on every session and explicitly declines to forbid on it (`LayoverFeasibility.ts:352-362`). |

### Attribution — the body's §2 claim is now false

§2 asserted "No source file, migration, test or doc in the tree cites this
specification". At `cdfff599` that is wrong. Six source files open with a
`Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt` block
naming the sections they implement: `LayoverFeasibility.ts:4-9`,
`LayoverCrewService.ts:4-19`, `LayoverSafeReturnService.ts:4-17`,
`LayoverDegradedService.ts:4-16`, `LayoverCompassService.ts:4-13`,
`LayoverPrivacyGuard.ts:4-9`, plus `2700_layover_certified_feasibility.sql`.

**Spec-attributable CORRECT = 11/296 = 3.7 %** — the six from §7 (L140, L235,
L278, L280, L290, L292) plus L136, L138, L234, L237 and L262. The far larger
effect is on CONSTRUCTED: **35 of the 123 `W` verdicts are now spec-attributable
code**, which is the first time this surface has had any. None of it is
satisfying a requirement end-to-end yet, which is the whole content of the
section above.

### Corrected summary — all 42 sections, derived from the rows

Recomputed by the same rule `check:census-integrity` uses (one verdict per id,
last statement wins), over all 296 rows after §9.5.

| Section | n | C | W | N | ? |
| --- | ---: | ---: | ---: | ---: | ---: |
| §1 Architectural mandate | 2 | 0 | 2 | 0 | 0 |
| §2.1 Non-negotiable architecture rules | 8 | 1 | 5 | 2 | 0 |
| §3 System context and domain boundaries | 9 | 1 | 7 | 1 | 0 |
| §4 Canonical domain model | 13 | 0 | 4 | 9 | 0 |
| §4.1 Core enums | 6 | 0 | 5 | 1 | 0 |
| §5 State machines | 6 | 0 | 2 | 4 | 0 |
| §6 Deterministic feasibility and safety engine | 2 | 1 | 1 | 0 | 0 |
| §6.1 Hard invariants | 7 | 3 | 1 | 3 | 0 |
| §6.2 Time estimate representation | 2 | 0 | 2 | 0 | 0 |
| §7 Temporal Freedom Engine | 4 | 0 | 1 | 3 | 0 |
| §8 Reachability, routing and safe-envelope geometry | 8 | 0 | 1 | 7 | 0 |
| §8.1 Route robustness | 6 | 0 | 0 | 6 | 0 |
| §9 Experience Compiler and recommendation contracts | 3 | 0 | 2 | 1 | 0 |
| §9.1 Candidate ranking | 2 | 0 | 1 | 1 | 0 |
| §10 Airport Intelligence and truth reconciliation | 6 | 0 | 1 | 5 | 0 |
| §10.1 Source hierarchy and contradiction handling | 5 | 0 | 0 | 5 | 0 |
| §11 Event-driven replanning architecture | 2 | 0 | 1 | 1 | 0 |
| §11.1 Replanner pipeline | 8 | 0 | 1 | 7 | 0 |
| §12 Compass / AI contract | 14 | 0 | 14 | 0 | 0 |
| §12.1 Value-of-information rule | 1 | 0 | 1 | 0 | 0 |
| §13 Map architecture and UI semantics | 12 | 0 | 3 | 9 | 0 |
| §14 Social, Layover Crew and Presence | 6 | 0 | 3 | 3 | 0 |
| §14.1 Crew constraint solving | 7 | 2 | 5 | 0 | 0 |
| §15 Safe Return and disruption recovery | 6 | 1 | 2 | 3 | 0 |
| §15.1 One-tap abort | 2 | 0 | 2 | 0 | 0 |
| §15.2 Disruption mode | 2 | 0 | 2 | 0 | 0 |
| §16 Offline, battery and degraded-mode architecture | 8 | 0 | 3 | 5 | 0 |
| §17 Privacy, permissions and data lifecycle | 6 | 0 | 2 | 4 | 0 |
| §17.1 Permission prompting | 5 | 1 | 1 | 3 | 0 |
| §18 APIs and service interfaces | 23 | 2 | 11 | 10 | 0 |
| §19 Storage and migration plan | 8 | 0 | 6 | 2 | 0 |
| §19.1 RLS expectations | 6 | 1 | 3 | 2 | 0 |
| §20 Observability and decision ledger | 12 | 0 | 4 | 8 | 0 |
| §21 Testing, replay and certification | 1 | 0 | 0 | 1 | 0 |
| §21.1 Minimum deterministic scenario matrix | 15 | 0 | 4 | 11 | 0 |
| §21.2 Test layers | 9 | 3 | 2 | 4 | 0 |
| §22 Rollout and airport maturity model | 8 | 0 | 2 | 6 | 0 |
| §23 Security and abuse controls | 8 | 3 | 1 | 4 | 0 |
| §24 Performance, scaling and reliability | 8 | 2 | 4 | 2 | 0 |
| §25 Portava integration points | 11 | 0 | 8 | 3 | 0 |
| Appendix A. Reason codes | 15 | 4 | 0 | 11 | 0 |
| Appendix C. Developer rules | 4 | 0 | 3 | 1 | 0 |
| **Total** | **296** | **25** | **123** | **148** | **0** |

**§12 is the shape of this pass in one row.** Fourteen requirements, zero `C`,
zero `N`: every Compass tool the spec names now exists and not one of them is
reachable from a model, a route or a client. §14.1 is the same story with two
vacuous guards on top.

### Owner decisions this pass surfaces

8. **Apply `2700`.** Until it lands there is no canonical record and L1, L5, L6,
   L191, L209 and L240 cannot leave `W`/`N` however good the code is.
9. **Apply `2740` and decide the presence ladder.** Turning it on is a visible
   product change: today's default shows six named travellers; the ladder's
   default shows a count. That is a product decision, not a deployment step.
10. **`layover_safe_return_status_enabled`.** 2741 is applied, so the write is
    legal. Leaving the flag FALSE means `returning` is a state the database
    accepts and nothing writes.
11. **Reachability, which is now the binding constraint on this surface.** Seven
    live endpoints publish fields no client reads, and `POST /:id/return-now` —
    the §15.1 one-tap abort — has no client caller at all. Every `N → W` in this
    pass is blocked behind that, not behind more server work.
12. **D6 for layover.** `layover_events`, `layover_sessions`, `airport_profiles`,
    `layover_plan_stops` and `layover_recommendations` all survive account
    deletion (L163 above). That is the D6 backlog showing through on this
    surface and it is an owner decision, not a defect this census may close.

### 9.5 Verdict register — closing the gap between this document and its own tables

`check:census-integrity` reads verdict rows and takes the **last** statement of a
revised id. Run against this file before this pass, it disagreed with the prose
in nineteen places, and in four of them it reported an **unmerged PR's
hypothetical verdict as the current one**. That is the exact drift the check
exists to catch, in the census that first carried a correction header. Every one
is pinned below, at its measured main-branch verdict at `cdfff599`. After this
table the document has **0 requirements the tool cannot read**: 296 rows, 296
parsed.

| id | What the tool read | Correct | Why it misread |
| --- | --- | --- | --- |
| L48 | C | **N** | §5's PR #463 table is `\| Main \| With #463 \|`; the tool takes the last verdict cell, so #463's hypothetical became current. **On main, nothing under `routes/airport.ts` or `services/airport/` reads `entry_requirements` or `traveler_passports`** — re-grepped at this commit. #463 is still unmerged. |
| L34 | C | **N** | Same row family. No `EntryPermissionState` of any kind exists on main. |
| L47 | C | **W** | Same. `computePlanFit` still sums `(durationMin ?? 0) + (travelMin ?? 0)` on main. |
| L230 | C | **N** | Same. The entry-permission scenario has no test on main. |
| L278 | N | **C** | §7 promoted four reason codes in one row keyed `L278, L280, L290, L292`; a comma-separated id cell is not an id, so the promotion was invisible and the Appendix A row's `N` stood. `LAYOVER_REASON_CODES` declares the fifteen and `ENTRY_NOT_CONFIRMED` is emitted on every session (`services/airport/LayoverSafetyEngine.ts`, re-read at this commit). |
| L280 | N | **C** | Same row. `INSUFFICIENT_USABLE_TIME` on verdict `no`. |
| L290 | N | **C** | Same row. `RETURN_THRESHOLD_REACHED` at RETURN_NOW and beyond. |
| L292 | N | **C** | Same row. `AIRPORT_MATURITY_LIMITED` on every unverified airport — which is all 3,206 of them. |
| L206 | N | **W** | §7's `L207, L206` row, same comma problem. The recommendation event's metadata is a DecisionRecord in substance and not in name. |
| L207 | N | **W** | Same row. |
| L7 | — | **N** | `N ∅` is not a bare verdict token, so the row was skipped entirely. Unguarded absence, unchanged. |
| L51 | — | **C** | `C ⌀` likewise. Vacuous: monotone by construction, no security-wait input exists. Now also swept by `test/layoverFeasibilityInvariants.test.ts:115` over every buffer column. |
| L59 | — | **N** | `N ∅`. |
| L85 | — | **N** | `N ∅`. |
| L164 | — | **N** | `N ∅`. |
| L168 | — | **N** | `N ∅`. |
| L201 | — | **C** | §8 wrote `C (tree)`, which is not a bare token. Verdict unchanged: 2335 + 2510 are applied to production (`20260908104231`, `20260908104255`), which is a change since §8 wrote "production still open" — the write boundary is now closed in production, and owner decision 1 from §7 is discharged. |
| L251 | — | **N** | `N ∅`. |
| L256 | — | **N** | `N ∅`. |


## 10. Re-census — 2026-09-08 (later), HEAD `743ae78f`

Paths relative to `travel-buddy-standalone/` unless prefixed
`artifacts/api-server/src/`. Same denominator (296), same rule (§1), same
buckets. **Every row below was re-derived by opening the file at this commit.**
Rows not restated here keep the verdict §9 left them with.

This pass exists because §9's reachability table was, in its own words, a list of
things the server published that no client read. A lane closed part of that list.
The interesting question is not "did a component get written" — it is which of
those `W` rows had *reachability* as their only missing half, because those are
the ones a client can move, and which had a second missing half that a component
cannot supply.

### Reachability, re-measured

| Surface | §9 (`cdfff599`) | Now (`743ae78f`) | Evidence |
| --- | --- | --- | --- |
| `certification` on `/overview` | Published, **not read** | **Read and rendered** | `LayoverOverview.certification` (`src/services/layover.ts:349`), `summarizeCertification` (`src/components/layover/layoverReturnFacts.ts:142#summarizeCertification`), rendered `LayoverSafeReturnCard.tsx:89` and `LayoverCompassCard.tsx:60` |
| `safeReturn` posture | Published, **not read** | **Read and rendered** | `LayoverOverview.safeReturn` (`layover.ts:351`), `postureHeadline` (`layoverReturnFacts.ts:169#postureHeadline`), used `LayoverSafeReturnCard.tsx:81`; `returnRoutePrimary` hoists the card above the hero (`app/layover/[id].tsx:345#returnRoutePrimary`) |
| `offlineBundle` | Published, **not read** | **Read and displayed; still not cached** | `LayoverOverview.offlineBundle` (`layover.ts:353`), `bundleFreshness`/`describeDeadline` (`layoverReturnFacts.ts:53, 91`). **`AsyncStorage` appears nowhere** under `app/layover/`, `src/components/layover/`, `src/services/layover.ts` or `src/context/LayoverSessionContext.tsx` — grep, not recollection |
| `POST /:id/return-now` | Wired, **no client function** | **Reachable by gesture** | `returnToAirportNow` (`layover.ts:676#returnToAirportNow`) → `LayoverSafeReturnCard.tsx:96`, mounted at `app/layover/[id].tsx:272` |
| `POST /:id/compass` | **Dark** — `askCompass` had no importer | **Reachable by gesture** | `LayoverCompassCard.tsx:24, 48`, mounted at `app/layover/[id].tsx:346` |
| `runLayoverTool` (12 §12 tools) | Callable, **not passed to the model** | **Unchanged** | `LayoverCompassService.ts:726-736` still says DECLARED, NOT YET PASSED TO THE MODEL. A reachable endpoint is not a reachable tool |
| `GET /:id/safety` | Dark — `LayoverRecommendationScreen.tsx` imported by nothing | **Still dark** | `grep -rn LayoverRecommendationScreen app/ src/` outside its own file: no hits. `getSessionSafety` still has that one importer and it is unmounted |
| `LayoverCrewService` (12 exports), `localReplan`, `sensingPolicy`, `nextDisruptionState`, `recomputeForDisruption` | No caller outside tests | **Unchanged** | No client can reach what no route exposes |

### Verdict changes

| id | Was | Now | Evidence at `743ae78f` |
| --- | --- | --- | --- |
| L2 | W | **C** | Both halves that kept it `W` are closed. The header is consumed — `summarizeCertification` (`layoverReturnFacts.ts:142`) renders the server's own `engineVersion`/`confidence`/`bufferPercentile` rather than a client restatement of them — and the client's DUPLICATE thresholds are gone with the file that held them: `LayoverReturnPanel.tsx` no longer exists (`git rm`, commit `a718beb5`). Grepped for surviving threshold constants in the replacement: none. |
| L146 | W | **C** | §9 said "Reachability is the missing half" in those words. It is closed: `returnToAirportNow` (`layover.ts:676#returnToAirportNow`) calls `POST /:id/return-now`, `LayoverSafeReturnCard.tsx:96` calls it on a **RETURN TO AIRPORT** press, and the card is mounted (`app/layover/[id].tsx:272`). A double press is refused by a ref written synchronously (`:77, 92-93`) — state alone loses two presses in one frame. The abort's own `statusCapability` is reported to the traveller rather than swallowed (`:239-240`, `statusCapabilityNote`), so `flag_off` reads as "your layover stays open so you keep the countdown", not as a failure. |
| L114 | W | **C** | §9 ended "The endpoint it lives on is still dark from the app." It is not: `askCompass` (`layover.ts:628#askCompass`) has an importer (`LayoverCompassCard.tsx:24, 48`), the card is mounted (`app/layover/[id].tsx:346`), and the single highest-value clarifying question is the thing actually rendered (`LayoverCompassCard.tsx:83-86`). The computation (`valueOfInformation`, `LayoverCompassService.ts:453`) was already built and pinned; a traveller can now be asked. |

### Rows I looked at and deliberately did NOT move

| id | Stays | Why |
| --- | --- | --- |
| L150 | W | The client half is **displayed, not cached**. `describeDeadline` (`layoverReturnFacts.ts:91#describeDeadline`) renders "Last certified N min ago" from `offlineBundle.certifiedAt`/`staleAfter`, which is honest labelling of an answer's age — but §16's claim is that a client can *serve* a stale answer offline, and nothing writes the bundle to storage. `AsyncStorage` does not appear anywhere under the layover client. A label about staleness on a screen that cannot open offline is half of L150, and half is `W`. |
| L141 | W | `explorationCollapsed` is derived and published, and after this pass it is still read by nothing: grep across `app/layover/` and `src/components/layover/` finds `returnRoutePrimary` (`[id].tsx:284`) and no `explorationCollapsed`. The card is HOISTED; exploration is not COLLAPSED. Those are different claims and only one is built. |
| L102–L113 | W | Twelve §12 tools, reachable from a route that a traveller can now reach — and still not passed to the model (`LayoverCompassService.ts:726-736`). The endpoint becoming live does not make the tools live; wiring the model to choose among them is a change made behind a flag, which the service file itself says. |
| L142 | N | `returnRoutePrimary` is now consumed by the client, which is exactly why this row does **not** move: it is a boolean asking for a ROUTE to be made primary, and there is still no route (`ReturnContract.route` is `null` with `routeUnavailableReason: "no_routing_provider"`). What the client hoists is the return CARD. Rendering a flag about an absent thing is not the thing. |
| L33, L147 | W | `layover_safe_return_status_enabled` is still FALSE and 2741's widened domain is still unused in production (0 rows in `returning`, measured 2026-09-08). The client now *reports* that state instead of hiding it, which is why L146 moves and these do not: the capability is honest, and off. |
| L293 | W | Nothing in this pass touched the three substitutions. A client that renders `travelTimeSource` does not remove a fabricated 20/30 probe. |

### Recomputed headline — HEAD `743ae78f`

Same 296 denominator, same counting rule, same prohibition rule. Three rows move
`W → C`; nothing moves into or out of `N`.

> **CORRECTED, same day, before anyone quoted it.** The first version of this
> table said 27 → 30 correct, 133 → 130 wrong, 139 not built. Those numbers came
> from ADDING this pass's three moves to §9's stated headline instead of counting
> the rows — and §9's headline does not sum to its own denominator: 27 + 133 +
> 139 = **299**, against a denominator of 296. Carrying it forward carried the
> error forward and made it look freshly measured.
>
> The numbers below are the ones `check:census-integrity` recomputes from the
> tables themselves, last-verdict-wins, with the eight PR-comparison rows skipped
> because they describe unmerged work. For this census that arithmetic is
> authoritative rather than approximate: it reports **0 requirements counted
> where the parser cannot read**, so there is no prose gap for a headline to
> differ by. A layover headline that disagrees with the parsed counts is simply
> wrong, and this one was.

| Measure | Parsed at `743ae78f` |
| --- | --- |
| BUILT-AND-CORRECT | **28** |
| BUILT-BUT-WRONG | **120** |
| NOT-BUILT | **148** |
| CANNOT-VERIFY | **0** |
| Sum | **296** — equal to the denominator, which the previous headline was not |
| CONSTRUCTED% | **50.0 %** (148/296) |
| CORRECT% | **9.5 %** (28/296) |

The three rows this pass moved (L2, L146, L114) are inside that 28. What the
earlier table got wrong was the BASE, not the moves.

**CONSTRUCTED% did not move, and that is still the finding.** Nothing was built
in this pass that was not already built; three capabilities a traveller could not
reach became reachable. A census that counted a mounted component as new
construction would have reported growth where there was none — and the corrected
arithmetic above does not change that, because all three moves are W → C, which
leaves C + W where it was.

---

## 11. Build pass — 2026-09-13, §10 truth reconciliation and §11 event-driven replanning

Paths relative to `artifacts/api-server/src/` unless prefixed `db/` or
`travel-buddy-standalone/`. Same denominator (296), same counting rule (§1),
same prohibition rule (§1's three bullets), same buckets. Commits `4a7d9e0f`
and `af1864a7` on `worktree-agent-a1965b10a690c9e97`. **Nothing here is merged,
nothing is deployed, no flag is flipped and no migration is applied.** Most of
the owner's rule chain is not even reached: this is BUILT ON BRANCH and no more.

**Read this before any verdict below.** Every artifact in this pass is reachable
from a test and from nothing else. There is no ingest route, no reader, no feed,
no webhook and no producer of an observation or an event anywhere in the tree,
and the migration that would store either is **written and NOT applied**. The
arithmetic a traveller's session runs is term-for-term what it was before this
pass — pinned, not asserted, by
`test/layoverLiveConditions.test.ts:134#the five original terms`. CONSTRUCTED%
below moves by 12 points and **not one number on any screen changes.** A reader
who wants only the second fact should skip to §11.3.

### 11.1 What was built, and where

**1. `services/airport/LayoverAirportTruth.ts` — §10 and §10.1, 824 lines.**

The spec's five fact classes as a closed set (`:62#AIRPORT_FACT_CLASSES`) with
the freshness its table gives each (`:80#FACT_CLASS_TTL_MIN` — FAST_LIVE 20
minutes, TRAVELER_OBSERVATION 45, OPERATIONAL_SEMI_LIVE 12 hours,
STATIC_TOPOLOGY a month, HISTORICAL_MODEL 90 days). Fifteen fact types, each
bound to exactly one class (`:95#AIRPORT_FACT_TYPES`), one per example in the
spec's own Examples column. `TruthValue<T>` with all eight members
(`:304#TruthValue`), every one set by the reconciler and none a placeholder —
asserted member by member and as an exact key set at
`test/layoverAirportTruth.test.ts:306#eight`.

`reconcile` (`:447#reconcile`) applies §10.1's five rules and records which
fired, in order, in `rulesApplied`:

- **never silently merge** — the chosen value is the maximum over the credible
  readings (`:512#chosen`), never a mean; a disagreement past the fact's own
  tolerance (`:511#conflict`, table at `:164#CONFLICT_TOLERANCE_MIN`) sets
  `conflict` and keeps BOTH sources rather than averaging them (`:519#average`);
- **preserve provenance and the conflict flag** — `sourceRefs` carries every
  accepted reading's ref and `conflict` is always set explicitly, conflict or
  not (`:581#fallbackLevel:` is inside the same record literal);
- **prefer conservative** — observer kind is nowhere in the selection, so an
  official feed's lower figure does not beat a corroborated higher one
  (`test/layoverAirportTruth.test.ts:345#largest`);
- **community observations require plausibility, corroboration and decay** —
  `isImplausible` rejects rather than down-weights (`:368#isImplausible`, ranges
  at `:135#PLAUSIBLE_RANGE`), a community-only safety-critical fact needs
  `MIN_COMMUNITY_CORROBORATION` DISTINCT observers (`:232#MIN_COMMUNITY_CORROBORATION`,
  enforced `:497#community-only`), and weight decays linearly to zero at the
  class TTL (`:353#decayFactor`);
- **official data is not automatically truth; contradiction increases
  uncertainty** — the step-down at `:531#stepDownConfidence`.

Plus §23's controls over the same channel: a per-(observer, fact) rate limit
(`:224#OBSERVATION_RATE_LIMIT`) that applies to official feeds too, and trust
weighting by observer kind × the observer's own standing × decay
(`:192#OBSERVER_KINDS`). Plus §10's historical model — per-local-hour percentile
bands that are **not published below five samples** (`:739#buildHistoricalModel`,
`:718#MIN_SAMPLES_PER_BAND`) — and §22-L4 calibration measurement
(`:799#measureCalibration`), which measures prediction error and deliberately
adjusts nothing.

`getTruth(subject, factType, atTime, corpus)` (`:608#getTruth`) is §18's method
with the I/O lifted out; the divergence is stated in its own doc comment rather
than hidden.

**2. `services/airport/LayoverEventReplanner.ts` — §11 and §11.1, 922 lines.**

§11's canonical envelope with all ten members, none optional
(`:106#LayoverEventEnvelope`), and the eleven-type vocabulary as a closed set
(`:71#LAYOVER_EVENT_TYPES`) checked against a hand transcription of the spec at
`test/layoverEventReplanner.test.ts:170#eleven`. Then the eight numbered steps,
each a separately exported function carrying its step number:

| Step | Function | Note |
| --- | --- | --- |
| 1 normalise + dedupe | `:203#normalizeEvent`, `:319#dedupeEvents` | per-type payload validator; dedup key is `source:sourceEventId`, or a content digest — **never the eventId**, which is the §24 failure |
| 2 impacted sessions | `:362#impactedSessions` | direct subject, or airport fanout bounded by the session's own window |
| 3 affected nodes | `:416#EVENT_AFFECTS`, `:442#applyEventToInputs` | maps each event type to the named `FeasibilityInputs` fields it can move; **five of the eleven move nothing** and are skipped |
| 4 immutable snapshot | — | **NOT BUILT.** `ReplanOutcome.snapshotPersisted` is typed literally `false` (`:796#snapshotPersisted:`) with reason `no_snapshot_storage` (`:797#no_snapshot_storage`) |
| 5 diff the action universe | `:552#actionUniverseOf`, `:588#diffActionUniverse` | verdict, return state, tier, usable minutes, deadline, feasible candidate ids, reason codes |
| 6 invalidate | `:630#invalidateRecommendations` | decides; writes nothing |
| 7 OpportunityEvent | `:683#opportunityEventFor` | `null` unless materially changed (`:655#MATERIALITY`) |
| 8 notify | `:752#shouldNotify` | strictly narrower than step 7 |

`handleEvent` (`:818#handleEvent`) runs 2 through 8 in order. `disruptionAfter`
(`:919#disruptionAfter`) finally gives §15.2's state machine an input — and
refuses to give it a false one: a security-queue event is not a flight
disruption (`:905#disruptionEventFor`).

**3. The seam into the safety arithmetic.** `LiveConditions`
(`services/airport/LayoverSafetyEngine.ts:192#LiveConditions`) is the one shape
the buffer accepts live intelligence in, and
`LayoverAirportTruth.liveConditionsFrom` (`:660#liveConditionsFrom`) is the only
thing that builds one. It becomes a SIXTH buffer term, `liveExtra`
(`LayoverSafetyEngine.ts:270#liveExtra:`, summed into the total at
`:380#liveExtra`), additive-only and clamped at zero (`:229#liveExtraMinutes`)
so a live signal can make a deadline earlier and never later. It is a NAMED
INPUT of the certified record (`LayoverFeasibility.ts:303#liveConditions:`), so
it is inside `inputHash` and inside a replay, and it produces the only §6.2
estimate on this tree that can carry a real `observedAt`/`expiresAt`
(`LayoverFeasibility.ts:496#liveExtraEstimate`). Both version constants moved:
`LAYOVER_ENGINE_VERSION` to `2026.09.13-1` because the arithmetic gained a term,
`LAYOVER_FEASIBILITY_VERSION` because the record shape did.

**4. `migrations/2860_layover_airport_truth_and_events.sql` — WRITTEN, NOT
APPLIED, NO WRITER.** `airport_fact_observations` (`:155#airport_fact_observations`)
carries the provenance (`:187#observer_kind`, `:194#source_ref`) and TTL
(`:197#observed_at`, `:200#expires_at`) this census records as absent from every
layover table. `layover_external_events` (`:233#layover_external_events`)
carries the envelope and the UNIQUE dedup index §24 requires
(`:276#layover_external_events_dedup_uidx`). Both are SELECT-only or nothing for
client roles, and the write boundary is asserted as a postcondition
(`:347#client-writable`) — the check L201 records as missing the last time a
layover table shipped. Rollback at
`db/rollback/2026-09-13-2860-layover-airport-truth-and-events-rollback.sql:54#REFUSED`;
it refuses rather than dropping rows if a writer has appeared since. Both tables
are recorded as `unapplied` in `scripts/checkProductionDrift.ts` with the
reason, so `check:production-drift` is green by explanation rather than by
silence.

**§19-7's condition is EVALUATED, in writing, for the first time.** L197 says
the clause "Create airport intelligence observation/truth tables IF the existing
intelligence schema cannot represent the required TTL/provenance cleanly" was
"neither evaluated nor satisfied". 2860's header now evaluates it
(`:29#EVALUATED`): `intel_observations` and `intel_claims`
(`2130_intel_storage.sql:140`, `:204`) DO carry most of `TruthValue<T>`, and
three things block reuse — `actor_id uuid NOT NULL REFERENCES profiles(id)`
(`2130_intel_storage.sql:142#actor_id`), `subject_id uuid NOT NULL REFERENCES
places(id)` (`:144#subject_id`), and a `subject_kind` CHECK with no 'airport'
(`:166#intel_observations_subject_kind_check`). An airport feed has no profile
and an airport is not a place. The condition is satisfied; the alternative is a
Sensing-lane change to a live table, which this lane does not own.

**5. Three test files, 117 tests, 18 mutations.** `test/layoverLiveConditions.test.ts`
(27), `test/layoverAirportTruth.test.ts` (40), `test/layoverEventReplanner.test.ts`
(50). Every mutation was made to PRODUCTION code, measured, and reverted, and
each is recorded with its pass/fail count in its file's header. Two are worth
lifting out:

- **A monotonicity sweep cannot see a term wired to nothing.** Omitting
  `liveExtra` from `totalBuffer` failed 3 of 27 — all three the STRICT cases —
  and passed all six monotonicity sweeps over ~1,400 points, because a term that
  never enters the sum is CONSTANT in its input and a constant is
  non-increasing. Recorded at `test/layoverLiveConditions.test.ts:39#READ`.
- **A mutation that changed nothing found dead code.** Disabling the second half
  of §10.1 rule 5 — an `if (fresherContradiction && confidence === "HIGH")` cap
  the first draft carried — produced 40 pass / 0 fail, identical to unmutated,
  because its condition implies `conflict`, which had already stepped HIGH down.
  The branch was deleted (`af1864a7`) rather than kept with a test written
  around it, and the step-down mutation was RE-MEASURED afterwards: 2 failures
  instead of 1, because the dead cap had been covering for it.

### 11.2 Row moves

Thirty-seven rows move. **Thirteen `N → C`, one `W → C`, twenty-three `N → W`.**

Every `C` in this table is **vacuous in the §1 sense (`⌀`)**: the rule,
prohibition or vocabulary is real, fail-closed and swept, and the path it
governs is EMPTY because nothing on this tree produces an observation or an
event. §1's prohibition rule admits that verdict and marks it `⌀`; a reader who
rejects vacuous satisfaction should subtract all fourteen and read **28/296 =
9.5 %**, unchanged from §10. The `⌀` is stated here in the column header rather
than in the verdict cell because `check:census-integrity` cannot read `C ⌀` as a
verdict — the defect §9.5 had to repair for L51 and L52.

| id | was | now | why — every `C` below is `⌀`, vacuous |
| --- | --- | --- | --- |
| L84 | N | C | `TruthValue<T>` with all eight members the spec names, every one set by `reconcile` — `LayoverAirportTruth.ts:304#TruthValue`, exact key set asserted `test/layoverAirportTruth.test.ts:306#eight`. §1 counts a declared interface as one requirement. |
| L85 | N | C | Was `N ∅`, unguarded absence. Now guarded: two credible readings past the fact's tolerance set `conflict` and keep both refs (`LayoverAirportTruth.ts:511#conflict`), and no code path averages (`:512#chosen`, `:519#average`). Red-first: replacing the maximum with the mean fails 6 of 40. |
| L86 | N | C | Provenance and the conflict flag are both always set, conflict or not (`LayoverAirportTruth.ts:581#fallbackLevel:`; `test/layoverAirportTruth.test.ts:306#eight`). The storage half — provenance columns on a table — is written and unapplied (2860), which is part of why this is `⌀`. |
| L87 | N | C | The conservative reading wins and observer kind is nowhere in the selection: an official feed's lower figure loses to a corroborated higher one, swept over every observer kind (`LayoverAirportTruth.ts:512#chosen`; `test/layoverAirportTruth.test.ts:345#largest`). |
| L88 | N | C | All three named halves, each independently red-first: plausibility (`LayoverAirportTruth.ts:368#isImplausible`, mutation to always-false → 1 failure), corroboration (`:497#community-only`, mutation → 2), decay (`:353#decayFactor`, mutation → 1). |
| L89 | N | C | Contradiction steps confidence down (`LayoverAirportTruth.ts:531#stepDownConfidence`, mutation → 2 failures) and the official reading does not win by being official (L87's selection). A redundant third mechanism was found dead by mutation and deleted — see §11.1. |
| L90 | W | C | Was 3 of 10 members on `layover_events`. All ten now exist as one non-optional shape (`LayoverEventReplanner.ts:106#LayoverEventEnvelope`), produced by `normalizeEvent` and asserted member by member (`test/layoverEventReplanner.test.ts:196#ten`); `receivedAt` is pinned apart from `occurredAt` by mutation. The table that would store it is unapplied. |
| L91 | N | C | Exactly the spec's eleven, in its order, as a closed set (`LayoverEventReplanner.ts:71#LAYOVER_EVENT_TYPES`), compared against a hand transcription rather than against itself (`test/layoverEventReplanner.test.ts:170#eleven`). Dropping one fails 3 of 50; a twelfth cannot be introduced by writing one. |
| L92 | N | C | §11.1 step 1. Normalisation with a per-type payload validator (`LayoverEventReplanner.ts:203#normalizeEvent`) and dedup by a stable source key, never by eventId (`:319#dedupeEvents`). Red-first: keying on eventId fails 2, skipping validation fails 4. |
| L96 | N | C | §11.1 step 5. `actionUniverseOf` + `diffActionUniverse` (`LayoverEventReplanner.ts:552#actionUniverseOf`, `:588#diffActionUniverse`), exercised in both directions — a spike that loses options (`test/layoverEventReplanner.test.ts:423#drops`) and a delay that gains them. Red-first: emptying `candidatesLost` fails 2. |
| L98 | N | C | §11.1 step 7. `null` unless the options materially changed (`LayoverEventReplanner.ts:683#opportunityEventFor`, thresholds `:655#MATERIALITY`); the two flight reason codes are emitted here because only a diff can know them. Red-first: emitting unconditionally fails 1. |
| L251 | N | C | Was `N ∅`. Both halves exist over the same channel: a rate limit that applies to official feeds too (`LayoverAirportTruth.ts:224#OBSERVATION_RATE_LIMIT`, mutation → 1 failure) and trust weighting by kind × standing × decay (`:192#OBSERVER_KINDS`, mutation setting community trust to 1.0 → 2 failures). |
| L252 | N | C | Outlier rejection against each fact's declared physical range rather than a dispersion nobody has the population for (`LayoverAirportTruth.ts:368#isImplausible`, `:135#PLAUSIBLE_RANGE`); a 900-minute queue from an official feed is refused (`test/layoverAirportTruth.test.ts:188#implausible`). Red-first: always-false fails 1. |
| L257 | N | C | Both halves. Every payload is validated per event type (`LayoverEventReplanner.ts:203#normalizeEvent`) and dedup is by `source:sourceEventId` or a content digest (`:319#dedupeEvents`), with `eventId` deliberately excluded. |
| L44 | N | W | A material disruption now has an input: `disruptionAfter` walks §15.2's machine from a flight event (`LayoverEventReplanner.ts:919#disruptionAfter`), `invalidateRecommendations` names the stale set (`:630#invalidateRecommendations`) and `handleEvent` replans (`:818#handleEvent`). The audit-trail half is not built — nothing writes — and nothing produces the event. |
| L80 | N | W | The class exists with the spec's freshness and its three fact types (`LayoverAirportTruth.ts:95#AIRPORT_FACT_TYPES` — `security_layout`, `lounge_hours`, `transport_schedule`). No producer of any of the three, and no applied storage. A channel is not a fact. |
| L81 | N | W | Four fact types at a 20-minute TTL, and two of them REACH THE SAFETY BUFFER through `liveConditionsFrom` (`LayoverAirportTruth.ts:660#liveConditionsFrom`) — more than any other class has. Still no producer: every production session runs `liveConditions = null`. |
| L82 | N | W | The class exists and is confidence-weighted the way the spec asks (trust × decay), with a corroboration floor above it. There is NO SUBMISSION SURFACE — no route, no screen, nothing a traveller can report from. |
| L83 | N | W | `buildHistoricalModel` folds observations into per-local-hour p50/p75/p90 bands and withholds a band below five samples (`LayoverAirportTruth.ts:739#buildHistoricalModel`). "Recalibrated" is NOT built: `measureCalibration` measures error and adjusts nothing. |
| L93 | N | W | §11.1 step 2 built as a function over a session list handed in (`LayoverEventReplanner.ts:362#impactedSessions`), with the window bound that stops an airport event reaching a departed flight. It is not a fanout: there is no query and no index on an airport, route or flight subject (L259 unchanged). |
| L94 | N | W | §11.1 step 3. The node map is real and the skip is real — five event types move nothing and are skipped rather than re-certified (`LayoverEventReplanner.ts:416#EVENT_AFFECTS`; `test/layoverEventReplanner.test.ts:677#SKIPPED`). The recompute itself re-certifies the whole record, because there is one atomic derivation and no node subgraph to recompute. |
| L99 | N | W | §11.1 step 8 exists and is strictly narrower than step 7 — there is a material change that produces no notification (`LayoverEventReplanner.ts:752#shouldNotify`; `test/layoverEventReplanner.test.ts:613#STRICTLY`). It governs nothing: the ONE notification this product sends is still the client's fixed 30-minute reminder (`travel-buddy-standalone/app/layover/[id].tsx:167`), which this rule does not gate. |
| L179 | N | W | `handleEvent` exists with the spec's name and runs steps 2-8 in order (`LayoverEventReplanner.ts:818#handleEvent`). It takes a context bag instead of reading sessions, writes nothing, and has no caller outside its test. |
| L180 | N | W | `getTruth(subject, factType, atTime, corpus)` (`LayoverAirportTruth.ts:608#getTruth`). Signature divergence stated in the code: the spec's version reads a store, there is no store, so the corpus is an argument. |
| L181 | N | W | `reconcile(observations)` matches the spec's signature exactly and implements all five §10.1 rules. Scored W rather than C for consistency with how this document has scored every other built-but-uncalled service method (L133-L135, L137, L139, L156, L157): a named service operation with no caller is W here. |
| L212 | N | W | `HandleEventResult` carries `replanned`, `skipped` and `notifications`, so a replan rate is derivable from a call — the same rule that scored L208 and L214 W. Nothing calls it, nothing counts, nothing is emitted. |
| L225 | N | W | The scenario now exists as a test over the certified record with a real arrival-delay event (`test/layoverEventReplanner.test.ts:464#arrival`), including that the deadline does NOT move — an arrival delay is not a departure delay. Same limit as L226: a unit test over the solver, not a session; no delay input reaches one. |
| L227 | N | W | The scenario exists and the contraction is swept, not sampled (`test/layoverLiveConditions.test.ts:265#monotone`). **Considered `C` and rejected**: §9 scored L226 W with the words "a unit test over the solver, not a scenario of a session", and a security spike is in exactly that position — no security wait reaches a session. |
| L228 | N | W | `traffic_extra_min` is still a static admin constant and this does not change it. What is new is a SEPARATE live term that moves the deadline earlier and leaves the static figure alone, asserted as both (`test/layoverEventReplanner.test.ts:489#traffic`). Same solver-not-session limit. |
| L247 | N | W | `measureCalibration` measures signed error, absolute error and p90 coverage per hour band (`LayoverAirportTruth.ts:799#measureCalibration`) and returns zeros when there is nothing to compare. It MEASURES ONLY — no model is calibrated, and there are no outcomes to calibrate against. |
| L263 | N | W | The code half is built and red-first (dedup key, first-occurrence-wins). The schema half — `UNIQUE (dedup_key)` — is written and **NOT APPLIED** (`2860_layover_airport_truth_and_events.sql:276#layover_external_events_dedup_uidx`), and its postcondition asserts the index is UNIQUE rather than merely present. |
| L281 | N | W | `SECURITY_WAIT_HIGH` has an emitter for the first time (`LayoverAirportTruth.ts:677#SECURITY_WAIT_HIGH`) and reaches the certified record's `reasonCodes`. Not `C`: §7 promoted the four codes that ARE emitted on real sessions, and this one is emitted only when a fact nobody produces is supplied. |
| L285 | N | W | `DATA_STALE` emitted when a contributing truth is past its own expiry (`LayoverAirportTruth.ts:681#DATA_STALE`). Same limit. |
| L286 | N | W | `SOURCE_CONFLICT` emitted when a contributing truth was contradicted (`LayoverAirportTruth.ts:679#SOURCE_CONFLICT`). Same limit. |
| L287 | N | W | `TRAFFIC_DEGRADED` emitted on a degraded ground-transport reading (`LayoverAirportTruth.ts:678#TRAFFIC_DEGRADED`). Same limit. |
| L288 | N | W | `FLIGHT_MOVED_EARLIER` emitted by the diff, and only for a flight event — a queue spike also moves the deadline earlier and must not claim the flight moved (`LayoverEventReplanner.ts:709#FLIGHT_MOVED_EARLIER`; asserted both ways at `test/layoverEventReplanner.test.ts:585#FLIGHT_MOVED_EARLIER`). Same limit. |
| L289 | N | W | `FLIGHT_DELAY_CREATED_OPPORTUNITY` emitted only when a delay actually widened the window materially (`LayoverEventReplanner.ts:718#FLIGHT_DELAY_CREATED_OPPORTUNITY`) — not on every delay, because a delay into the night band can shrink it. Same limit. |
| L51 | C | C | **Verdict unchanged, vacuity narrowed and NOT removed.** `test/layoverFeasibilityInvariants.test.ts`'s own header says "`security_wait` HAS NO INPUT on this tree". It has one now (`LayoverSafetyEngine.ts:192#LiveConditions`) and the invariant is swept over it directly, 0-240 minutes, in two timezones (`test/layoverLiveConditions.test.ts:177#non-increasing`) instead of over the buffer columns that stood in for it. Still `⌀`: nothing supplies the input. |

### 11.3 The ceiling

**What would turn each green claim red, and what this pass does not touch.**

1. **The whole of §11.2 is one route away from being nothing, and there is no
   route.** Not "a route behind a flag seeded FALSE" — NO ROUTE. Nothing
   constructs an `AirportObservation` or a `LayoverEventEnvelope` outside
   `src/test/`; the only importers of `LayoverAirportTruth.ts` and
   `LayoverEventReplanner.ts` are their two test files. Every `C` above is a
   rule over an empty set and every `W` above is a channel with no content.

2. **2860 is written and NOT applied, and no writer may land before it is.**
   That ordering is 2700's rule and the reason is mechanical: supabase-js sends
   every key in an insert payload, so a writer naming an unapplied table's
   column fails outright on every database. The sequence is apply → confirm the
   postconditions → land the writer behind a flag seeded FALSE. Anyone who lands
   the writer first breaks the route, not the migration.

3. **The live buffer term is the one change that could move a traveller's
   number, and it cannot today.** `liveExtra` is 0 for every caller that
   supplies no conditions, which is every caller on this tree outside tests, and
   the equality is pinned (`test/layoverLiveConditions.test.ts:134#the five original terms`).
   **The day an ingest route exists, that pin is what stands between a
   crowd-sourced queue report and a traveller's flight deadline.** It should be
   read as a load-bearing test, not a regression check.

4. **A monotonicity sweep is not a wiring check** — measured, not argued: see
   §11.1's second bullet. Any future term added to the ladder needs a STRICT
   assertion as well as a monotone one, or it can be wired to nothing and stay
   green over a thousand points.

5. **§11.1 step 4 is not built and cannot be faked.** No snapshot is persisted,
   `snapshotPersisted` is typed `false`, and L95 stays `N`. Until 2700 AND 2860
   are applied there is nowhere to put a snapshot, so L5, L191, L206, L207,
   L209, L240 and L261 stay where they are.

6. **Rows deliberately NOT moved, having been opened and read:**

| id | stays | why |
| --- | --- | --- |
| L95 | N | §11.1 step 4. The certified record IS immutable; a snapshot in the spec's sense is a stored versioned artifact, and 2700 is unapplied. Reporting `snapshotPersisted: false` is honesty, not a snapshot. |
| L97 | W | §11.1 step 6 now has a real staleness test (`inputHash` mismatch) and a real feasibility test, but nothing APPLIES the decision — the legacy delete-and-reinsert path is what runs, and `layover_stable_recommendation_ids_enabled` is still FALSE. |
| L62 | N | Queue friction is now modelled as a buffer term — but §8's requirement is about REACHABILITY AND ROUTE geometry, and transport reliability, route alternatives, weather and re-entry cost have no model. A buffer term is not a route. |
| L79 | W | Four topology fact types now exist with a month-long TTL. "Invalidated on authoritative change" is not built: expiry is by TTL only, and `terminal_info` still has no writer and is null on all 3,206 production airports. |
| L197 | W | §19-7's condition is now EVALUATED in writing (§11.1 item 4) and the table carries both TTL and provenance — but "create" means applied, and 2860 is not. This is the row that moves the day 2860 lands. |
| L194, L198, L259 | W | 2860 adds a dedup index for a NEW table. `layover_events` still has no dedup index, there is still no checkpoints table, and there is still no airport/route/flight subject index for a fanout that does not exist. |
| L54, L55 | W | The live term is the first estimate on this tree that CAN carry a non-degenerate provenance — and it is a `STATIC_DEFAULT` zero in production, so every distribution is still flat and the percentile selection is still a no-op on the numbers. |
| L34, L48, L230, L49 | N | Entry permission is untouched by this pass. Still unread anywhere under `routes/airport.ts` or `services/airport/`, still an open PR's subject, still an owner decision. |
| L50 | N | Unchanged, still blocked on owner decision **L50-a** from §8. |
| L218 | N | No layover certification document was written. Adding one describing tests over an empty channel would make the artifact list longer and the product no more certified. |
| L245, L246 | N | §22's L2 and L3 rungs are about SIGNALS BEING AVAILABLE, not about a channel existing. Zero external live signals, zero Portava observations. Defining where they would go does not make an airport more mature. |

7. **One row in another lane's census is adjacent and that file is NOT edited.**
   `census-sensing.md` records, from the Sensing side, that
   `grep -rn liveClaimRead services/airport/` returns nothing — still true, this
   pass consumes no `intel_*` table. But 2860's header takes a position on
   whether `intel_observations` should carry airport facts, and that is a
   Sensing decision. It is surfaced as owner decision 9 below rather than
   written into their document.

8. **Owner decisions this pass surfaces** (numbering continues from §8's 1-7):

   9. **Apply 2860, or reject the second table.** The alternative recorded in its
      header is widening `intel_observations`' two NOT NULL foreign keys and its
      `subject_kind` CHECK — a change to a live table the Sensing lane owns. One
      of the two has to happen before any observation can be stored anywhere.
   10. **Is a traveller-submitted queue report wanted at all?** The screening,
       corroboration and rate limiting are built for it, and the table forbids
       attributing a row to a profile. If the answer is no, the
       `TRAVELER_OBSERVATION` class and `MIN_COMMUNITY_CORROBORATION` should be
       deleted rather than left looking like a shipped capability.
   11. **`SECURITY_WAIT_BASELINE_MIN = 20` is a declared assumption, not a
       measurement** (`LayoverAirportTruth.ts:634#SECURITY_WAIT_BASELINE_MIN`).
       It says how much queue the generic base buffer already covers, and no
       column anywhere holds that number per airport. Before any live wait
       reaches a traveller, someone has to decide whether that constant is
       right — or whether `airport_profiles` should gain a real column.

### Recomputed headline — commit `af1864a7`

Same 296 denominator, same counting rule, same prohibition rule. Recomputed by
`pnpm -s check:census-integrity` from the tables themselves, last-verdict-wins,
with the eight PR-comparison rows skipped. As at §10 this census reports **0
requirements counted where the parser cannot read**, so the headline must sum to
the denominator, and a figure that disagrees with the parsed counts is simply
wrong.

| Measure | At `743ae78f` (§10) | Now (`af1864a7`) |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 28 | **42** |
| BUILT-BUT-WRONG | 120 | **142** |
| NOT-BUILT | 148 | **112** |
| CANNOT-VERIFY | 0 | **0** |
| Sum | 296 | **296** |
| CONSTRUCTED% | 50.0 % | **62.2 %** (184/296) |
| CORRECT% raw | 9.5 % | **14.2 %** (42/296) |
| CORRECT% non-vacuous | 9.1 % (27/296) | **9.5 %** (28/296 — all fourteen new `C` verdicts are `⌀`) |
| CORRECT% spec-attributable | 3.7 % (11/296) | **8.4 %** (25/296 — the eleven, plus the fourteen new `C` rows, each of which cites the spec section it implements in its source file's own header) |

**Read the CORRECT% jump the way §10 asked its own to be read.** Raw CORRECT%
rises 4.7 points; NON-VACUOUS CORRECT% rises by one row, and that row is L51,
which keeps its `⌀` — the 28 is 27 plus a re-derivation, not a new capability.
Every one of the fourteen new `C` verdicts is a rule over a path with nothing in
it. That is a real improvement, because §1's prohibition rule exists precisely
to distinguish a guarded absence from an unguarded one and three of these rows
were `N ∅` — but it is not a traveller noticing anything.

**CONSTRUCTED% rose 12.2 points and no traveller can reach any of it.** 36 rows
left `N`. Of those, **every single one** is code with no caller outside
`src/test/`, or a schema object in an unapplied migration. Zero are consumed by
a route. Zero are consumed by the client. The last three passes of this census
have each had to write a version of that sentence, and this one is the largest
gap between construction and reach so far.

---

## §11.1 The integration re-read — six counted files, and rot older than the merge

**No verdict moves in this section.** It exists because §11 was measured at `af1864a7`
on a worktree branched from `014a25d5`, and merging it onto `claude/sweet-fermat-fmx7up`
put it on a tree the Trips and Sensing lanes had moved. `check:census-freshness` named the
six files to look at. Two things were found: one stale sentence, and one problem that is
older and larger than this merge.

`head_commit` stays `af1864a7`, which the merge commit makes an ancestor of HEAD — the rule
`checkCensusFreshness.ts` states for itself. Like every pre-squash declaration in this
repository it must be re-declared at the squash when this branch lands.

**The lane's own ten files are byte-identical to `af1864a7` in the merged tree** —
migration 2860, its rollback, `LayoverAirportTruth.ts`, `LayoverEventReplanner.ts`,
`LayoverFeasibility.ts`, `LayoverSafetyEngine.ts` and the four layover test files, each
compared with `cmp`, not eyeballed. Nothing §11 measured changed underneath it.

### The six that did change

| file | what changed | effect here |
|---|---|---|
| `artifacts/api-server/src/routes/airport.ts` | +1/−1 | The import specifier `../lib/tripKernel.js` became `../domain/trips/commands/tripKernel.js` when Trips §61 moved the file. Same symbols, zero executable change. |
| `artifacts/api-server/src/routes/hiddenGems.ts` | +1/−1 | The same one line. |
| `artifacts/api-server/src/test/mapTripProjectionWorker.test.ts` | +1/−1 | The same one line. |
| `artifacts/api-server/src/routes/rentABuddy.ts` | +25/−1 | Trips §60's trip-fit gate on `POST /rent-a-buddy/bookings`. L255 is the only row citing this file and it grades one thing — the `rent_buddy_enabled` fail-closed gate. The diff does not contain that string at all. **L255 stays C.** |
| `artifacts/api-server/src/compass/CompassTools.ts` | +739/−23 | Twenty-two new tools. **L102's evidence is stale**; see below. |
| `artifacts/api-server/src/services/airport/LayoverRecommendationService.ts` | +130/−7 | Sensing §11's live intersection. **No verdict moves and the citations were already wrong**; see below. |

### L102: the count is stale, the verdict is not

L102 says no layover tool exists and quotes a list of **eleven**. On the merged tree
`COMPASS_TOOL_DEFINITIONS` holds twenty-five entries and spreads eight more, so the real
figure is **thirty-three**. The row's verdict is **N and stays N**, and the test is
mechanical rather than an assurance: `grep -cE 'name: "[a-z_]*layover'` over
`compass/CompassTools.ts` and `compass/TelegraphConversationTools.ts` returns **0** and
**0**, and so does a grep for the bare word `layover` in either file. There is no
`getLayoverContext` and nothing layover-facing of any shape.

### The finding this merge did not cause and does not fix

`LayoverRecommendationService.ts` gained the Sensing §11 live intersection, behind
`layover_live_intersection_enabled` (migration `2851`, seeded FALSE) and behind the Live
gates in `lib/liveClaimRead.ts` under that. With either closed the pass reads nothing and
every card is generated exactly as before, which is the flag state on every deployment
today — so no row here moves on behaviour.

It inserts 77 lines at `:26`, which shifts every line citation into that file. Checking
where they should land turned up something worse than a shift: **they were already wrong at
`af1864a7`, and at `014a25d5`, the lane's own base.** Measured:

| row | cites | what is actually at that range | where the claim's code really is |
|---|---|---|---|
| L5 | `LayoverRecommendationService.ts:309-318` for the wholesale delete-and-reinsert | the `generateRecommendations` signature | `.delete()` at `:473` and `.insert()` at `:477` **at `af1864a7` and at `014a25d5` alike**; `:596` / `:600` on the merged head |
| L78 | `:251-257` for "`verified` first, then a time-of-day nudge" | a `placeType` → `recType` map | elsewhere in the ranking block |
| L182 | `:23-47` for "`timeOfDayContext` samples every 30 minutes" | import statements | elsewhere |
| L258 | `:320-328` for "logs only `{ count: rows.length }`" | a section comment | elsewhere |

This is ordinary rot in **unanchored `path:line` citations** written when the file was much
smaller. `check:doc-citations` cannot see it: it verifies the `path:line#anchor` form by
re-reading the anchor at the line, and a citation with no anchor gives it nothing to check.
So the guard was green over all four of these, truthfully, about a form it does not cover.

**It is recorded rather than repaired here on purpose.** Repointing them by the merge's
measured offset would move a wrong pointer to a different wrong place; each one needs its
claim re-read against the current file, which is a pass of its own and not something to
bury inside a merge. What this section fixes is the invisibility: the four above are
named with their real line numbers, and the class they belong to is now written down.

**§11's headline is unchanged: 42 / 142 / 112 / 0 over 296, 62.2 % constructed, 14.2 %
correct raw, 9.5 % non-vacuous.** And §11's own closing sentence still stands over this
section too — 36 rows left `N` and not one of them is reachable by a traveller.

---

## §11.2 The four are repaired, and the guard that would have caught them

§11.1 recorded four wrong citations and said it was leaving them alone, because
repointing by the merge's offset would only move a wrong pointer somewhere else. That
was the right call for a merge. This section does the thing it deferred: each claim was
re-read against the current file, and each citation now carries an **`#anchor`** so
`check:doc-citations` re-reads it on every run instead of taking it on trust.

### The guard first, because it is the part that lasts

`check-doc-citations.mjs` gains a **ceiling**, `MAX_UNANCHORED_CITATIONS`, beside its two
floors. The floors stop the good form being deleted; nothing stopped the bad form being
added, and the bad form is the one that rots. Measured on the merged tree: **8135
citations, 1610 anchored, 6525 unanchored** — so 80 % of this corpus is checked for one
thing only, that the file is long enough.

The ceiling may only ever go **down**. It was seen red before it was trusted: adding one
bare `path:line` to this document took it to 6526 and the check exited 2 naming the
delta. It cannot repair the existing population; it stops that population growing, which
is the part that compounds.

### What the repair actually took, including the wrong turn

A first mechanical pass proposed 76 anchors by testing whether an identifier the census
names beside a citation appears **anywhere in the cited range**. Two things were wrong
with that, and both are worth writing down:

1. **A token that merely occurs proves nothing.** `error`, `airport` and `verified` occur
   everywhere; anchoring on one would make a citation that is WRONG look
   machine-verified. Requiring the needle to occur **exactly once in the whole file** cut
   76 to 25.
2. **It was testing the wrong rule.** `anchorHolds()` is
   `ranges.every(([lo]) => fileLines[lo - 1].includes(needle))` — the anchor must sit on
   the **first line of every cited range**, not anywhere inside it. Applying the 25
   turned **12 of them red**. Measured, reverted, and the proposer rewritten to use the
   checker's own rule, which left **14**.

Those 14 are mechanical. The **17** below are the ones that needed the claim read.

| row(s) | cited | now | what the old range actually held |
|---|---|---|---|
| L5, L97, L296 | `LayoverRecommendationService.ts` lines 309-318 | `LayoverRecommendationService.ts:645-650#layover_recommendations").delete()` | the `generateRecommendations` signature |
| L7, L78, L184 | `LayoverRecommendationService.ts` lines 251-257 | `LayoverRecommendationService.ts:440-442#verified places lead` | a `placeType` → `recType` map |
| L258 | `LayoverRecommendationService.ts` lines 320-328 | `LayoverRecommendationService.ts:671#count: rows.length` | a section comment |
| L182 | `LayoverRecommendationService.ts` lines 230-351 | `LayoverRecommendationService.ts:389-395#export async function generateRecommendations` | the candidate-shape interface |
| L182 | `LayoverRecommendationService.ts`, the inherited lines 23-47 | `LayoverRecommendationService.ts:109-134#export function timeOfDayContext` | import statements |
| L5, L97, L296 | `routes/airport.ts` lines 560-566 | `routes/airport.ts:806-807#isSafetyEnabled` | not the regeneration trigger |
| L205, L258 | `routes/airport.ts` lines 751-755 | `routes/airport.ts:1160-1167#return_deadline_set` | the regeneration call, not the audited deadline write |
| L7, L78, L184 | `LayoverSafetyEngine.ts` lines 148-168 | `LayoverSafetyEngine.ts:532-546#export function rankActivities` | not the dead comparator |

**No verdict moves.** Every claim above was re-read at its corrected location and every
one is still true: the delete-and-reinsert is still wholesale, the objective is still two
terms, the generation audit still logs only a count, and `rankActivities` is still
exported and called from nowhere outside `src/test/`. What changed is that a reader — and
the checker — can now find the code each sentence is about.

### What is NOT fixed, with the number

census-layover carries **320** unanchored `path:line` citations. This section anchored
**31** of them. The other **289** are not known to be wrong; they are *unverifiable*,
which is a different and quieter problem, and the four above are the measured evidence
that the class contains real errors. Repo-wide the figure is **6494**. The ceiling now
holds that number down while it is worked off a document at a time.

### A second hole, found by not trusting the repair either

Writing the table above produced a citation made of a lone spec, 622, carrying the anchor
"count: rows.length" — a bare inherited spec with a multi-word anchor. (It is spelled out
in prose here rather than shown, because the check below now refuses the literal shape,
and a document must not fail a guard by describing it.) **No pass matches that shape.** `INHERITED_RE`'s
anchor stops at the first space (it must: the grammar reads unbackticked prose too), and
`FULL_ANCHOR_RE` needs the path spelled out. The citation was not checked, not counted,
and not reported — worse than either half being wrong.

Found the only way it can be: by mutating one to a wrong line and watching the check stay
green. Measured across `docs/architecture`, `docs/handoff` and `docs/ci` at that moment —
**310 inherited `:spec#anchor` citations, ZERO of them multi-word** — so the shape was
refused outright rather than taught to the parser, which is the cheapest moment to refuse
a shape nothing uses. `check:doc-citations` now fails on it and the message says the fix:
spell the path. Seen red before it was trusted.

**The three ratchets after this section: `MIN_ANCHORED_CITATIONS` 1532 → 1640,
`MIN_FULL_ANCHOR_CITATIONS` 1319 → 1513, `MAX_UNANCHORED_CITATIONS` 6525 → 6494.**

---

## 12. Build pass — 2026-09-13 (later), the replanner gets a producer, a caller and a screen

Paths relative to `artifacts/api-server/src/` unless prefixed `travel-buddy-standalone/`.
Same denominator (296), same counting rule (§1), same prohibition rule, same
buckets. **Nothing here is merged, nothing is deployed, no flag is flipped, no
migration is applied and no migration is written.**

**This pass built no new capability. It built the only thing §11 was missing.**
§11 closed with its own verdict on itself: *"CONSTRUCTED% rose 12.2 points and
no traveller can reach any of it. 36 rows left `N`. Of those, EVERY SINGLE ONE
is code with no caller outside `src/test/` … Zero are consumed by a route. Zero
are consumed by the client."* That sentence is now false for one of the two
artifacts §11 wrote, and it is still true for the other, and both halves are
below.

The finding that decided the pass: **§11 said "there is no event producer on
this tree", and there was one all along.** A traveller whose gate agent has just
announced a ninety-minute delay knows a fact no feed here carries, and
`PATCH /api/airport/sessions/:id` — a route that has existed since 0127 and that
the client had never called — is where they can say it. No flight feed, no
webhook, no ingest table and no migration stands between that gesture and the
whole eight-step pipeline. What stood between them was two hundred lines of
wiring and a card.

### 12.1 What was built, and where

**1. `services/airport/LayoverReplanService.ts` — 519 lines, the I/O half of §18's
`LayoverReplanner`.**

`windowChangeEvent` (`services/airport/LayoverReplanService.ts:143#export function windowChangeEvent`)
turns a window edit into the §11 event that describes it — comparing the two
`FeasibilitySession`s rather than the patch, so a PATCH that sets `departureTime`
to the value it already held is `window_unchanged` and not an event. The §11
vocabulary is closed at eleven, so an edit no member describes is REFUSED with a
named reason (`services/airport/LayoverReplanService.ts:101#export type ReplanRefusal`) instead of being squeezed into
the nearest-looking type: both ends of the window moving, boarding moving on its
own or by a different amount than departure, and a constraint edit (flight type,
immigration, bags, intent) each have their own refusal and each is published to
the traveller.

`replanForWindowChange` (`services/airport/LayoverReplanService.ts:344#export function replanForWindowChange`) runs step
1 through step 8 and returns a decision. Between normalisation and the pipeline
it does the thing that makes the whole seam safe: it re-derives the post-event
session with **the pipeline's own `applyEventToInputs`** and compares it field by
field against the session the route is about to persist. A mismatch refuses with
`inputs_diverged` and publishes nothing, so the `before`/`after` a traveller
reads can never describe a session that did not exist. That guard is not
argued — mutation 1b below turns every route case red through it.

`recordReplanDecision` (`services/airport/LayoverReplanService.ts:496#export async function recordReplanDecision`)
writes the §20 record to `layover_events`.

**2. The route is the ingest.** `replanAfterSessionEdit`
(`routes/airport.ts:737#async function replanAfterSessionEdit`) reads the
airport and the plan stops, runs the pipeline and writes the ledger row; the
PATCH handler calls it after the edit has committed
(`routes/airport.ts:721#const replan = await replanAfterSessionEdit`) and
publishes the result as an additive `replan` member. **It cannot fail the edit**,
and every path that cannot produce an honest replan returns a named refusal
rather than a partial one — including `plan_unreadable`, because a replan
computed against an unreadable plan would publish "0 options lost", which is the
exact failure `stopsOr503` exists to stop everywhere else on this router.

**3. The client is the producer.**
`travel-buddy-standalone/src/components/layover/LayoverFlightChangeCard.tsx`
offers five shifts (`travel-buddy-standalone/src/components/layover/LayoverFlightChangeCard.tsx:34#const OFFERED_SHIFTS`), PATCHes departure AND boarding
together by the same minutes — which is what an airline delay does and what
`flight.departure_delayed` is defined to do — and renders what came back:
sentences derived from the server's own diff
(`travel-buddy-standalone/src/components/layover/LayoverFlightChangeCard.tsx:82#export function replanLines`), never re-derived on the client, and every
refusal in the traveller's language (`travel-buddy-standalone/src/components/layover/LayoverFlightChangeCard.tsx:49#const REFUSAL_TEXT`) so a press is
never left unanswered. It is mounted on the dashboard between the can-I-leave
card and the plan (`travel-buddy-standalone/app/layover/[id].tsx:401#<LayoverFlightChangeCard`),
and `updateLayoverSession`
(`travel-buddy-standalone/src/services/layover.ts:596#export async function updateLayoverSession`)
— which until this pass **had no caller anywhere in the app** — now returns the
replan beside the session, typed (`travel-buddy-standalone/src/services/layover.ts:541#export type ReplanOutcome`).

**4. §20's DecisionRecord, with the member it cannot fill named.**
`LayoverDecisionRecord` (`services/airport/LayoverReplanService.ts:245#export interface LayoverDecisionRecord`)
carries **nine of the spec's ten members with real values**: `sessionId`,
`engineVersion`, `inputHash`, `inputFacts[]` (the constraint nodes that moved and
their before/after values, `services/airport/LayoverReplanService.ts:301#function inputFactsFor`), `sourceRefs[]` (the
event and its dedup key), `rulesApplied[]` (the pipeline steps that fired, in
order, including which of 7 and 8 declined), `result`, `reasonCodes[]` and
`computedAt`. `snapshotId` is `null` with `snapshotUnavailableReason:
"no_snapshot_storage"` — 2700 is unapplied and a content hash renamed
`snapshotId` would be the substitution Appendix C1 forbids. **That one null is
why L206 and L207 do not move.**

**5. Appendix A `RECOMMENDATION_EXPIRED` gets its first emitter**
(`services/airport/LayoverReplanService.ts:329#function invalidationReasonCodes`), and unlike the five codes §11 gave
emitters to, this one fires on a REAL session: a traveller who reports an
earlier departure and whose planned stop stops fitting gets the code in the
response, in the ledger and on the screen.

**6. Two test files, 28 tests, 10 mutations.**
`test/layoverSessionEditReplan.test.ts` (18, real router + table-backed fake DB)
and
`travel-buddy-standalone/src/components/layover/__tests__/LayoverFlightChangeCard.component.test.tsx`
(10, real service module + a fetch spy; nothing mocks `services/layover`), plus
one assertion added to the dashboard mount test. Every mutation was made to
PRODUCTION code, measured, reverted and `cmp`-verified; each file's header
records them with counts. Three are worth lifting out:

- **A guard whose reachability is the point fired anyway.** Mutation 1 zeroed
  `delayMinutes` on the departure path and only **3** tests failed, because
  `applyEventToInputs` prefers `newDepartureTime` when a producer supplies one,
  so the departure still landed correctly and only boarding drifted. Mutation 1b
  — pointing `newDepartureTime` at the OLD instant — failed **6**, every route
  case refusing with `inputs_diverged`. The first mutation is the weaker one and
  saying so is the point: a mutation that produces a small red can flatter a
  guard that a sharper mutation shows is doing real work.
- **The §11 suite did not pin its own node map.** Mutation 7 gave
  `flight.arrival_delayed` an EMPTY entry in `EVENT_AFFECTS`, so the pipeline
  skips it. Two tests failed here — **and `test/layoverEventReplanner.test.ts`
  stayed at 50 pass / 0 fail.** That suite tests that the five no-op event types
  ARE skipped and never that the six real ones are NOT, so the map's positive
  entries were unpinned from the day they were written until a route depended on
  them. No verdict moves on it; L94 was `W` and stays `W`. The evidence §11.2
  cites for it was weaker than it read.
- **The whole reachability claim rests on one assertion.** Removing
  `<LayoverFlightChangeCard>` from the dashboard turned exactly ONE test red
  (`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx:239#the dashboard mounts the flight-change card`)
  and nothing else in the repository. An unmounted component reaches no
  traveller and every other suite is happy about it — which is how
  `LayoverReturnPanel` survived 240 lines and two censuses.

### 12.2 Row moves

Seven rows move. **Five `W → C`, one `N → C`, one `N → W`.** None of the six new
`C` verdicts is vacuous: every one is on a path a traveller can walk from a
control the app mounts, which is the distinction §11's fourteen `⌀` rows could
not make.

| id | was | now | why |
| --- | --- | --- | --- |
| L179 | W | C | `LayoverReplanner.handleEvent(event)`. §11.2 scored it `W` for three reasons and two are closed: it has a caller outside `src/test/` (`routes/airport.ts:737#async function replanAfterSessionEdit`, reached by a mounted control), and its decision is written (`services/airport/LayoverReplanService.ts:496#export async function recordReplanDecision`). The third stands and is stated rather than hidden: `handleEvent` still takes a context bag, and the I/O the spec's one-argument method implies lives in `replanForWindowChange` above it. Scored `C` on this document's own precedent — L170 is `C` for `createManual(input)` against a `createSession(db, input)` reached by a route, so the standard here is "the operation exists and is reached", not a byte-identical signature. Red-first: removing the ledger write fails 2; `inputs_diverged` on a diverged event fails 6. |
| L225 | W | C | "Arrival delay → freedom shrinks." §11.2's `W` reason, verbatim: *"a unit test over the solver, not a session; no delay input reaches one."* A delay input reaches one now — `PATCH` with a later `arrivalTime` — and the scenario is asserted at route level, including that the hard return does NOT move, because an arrival delay is not a departure delay (`test/layoverSessionEditReplan.test.ts:176#an arrival delay shrinks freedom`). Red-first: emptying `EVENT_AFFECTS["flight.arrival_delayed"]` fails it. |
| L226 | W | C | "Departure delay → freedom may expand after recompute." Same reason closed the same way, at route level (`test/layoverSessionEditReplan.test.ts:145#a departure delay becomes flight.departure_delayed`), including `FLIGHT_DELAY_CREATED_OPPORTUNITY`. The deadline delta is asserted POSITIVE rather than equal to the shift, because the return buffer is airport-local-time dependent and an equality would make the test's colour depend on the hour the suite runs at. |
| L288 | W | C | `FLIGHT_MOVED_EARLIER`. §11.2 scored it `W` because it was "emitted only when a fact nobody produces is supplied". A traveller reporting an earlier departure produces it, and the code reaches the response, the ledger and the screen (`test/layoverSessionEditReplan.test.ts:200#a planned stop that stops fitting is named`). Same promotion rule §7 used for the four codes emitted on real sessions. |
| L289 | W | C | `FLIGHT_DELAY_CREATED_OPPORTUNITY`. Same, on the delay path, and still only when the delay actually widened the window materially — not on every delay. |
| L291 | N | C | `RECOMMENDATION_EXPIRED` has an emitter for the first time (`services/airport/LayoverReplanService.ts:329#function invalidationReasonCodes`) and it fires on a real session: a planned stop that stops fitting after a real edit. Rendered (`travel-buddy-standalone/src/components/layover/__tests__/LayoverFlightChangeCard.component.test.tsx:218#a lost planned stop is named`). Red-first: returning `[]` from the emitter fails 1. |
| L238 | N | W | "Integration tests for event → replan → snapshot → invalidation → notification." Four of the five stages now have one, over the real router: event (`test/layoverSessionEditReplan.test.ts:145#a departure delay becomes flight.departure_delayed`), replan, invalidation (`test/layoverSessionEditReplan.test.ts:200#a planned stop that stops fitting is named`) and notification (`test/layoverSessionEditReplan.test.ts:190#step 8 is strictly narrower` — step 8 declining). `W` and not `C` because the SNAPSHOT stage does not exist to test: `snapshotPersisted` is typed `false` and 2700 is unapplied. |

### 12.3 Rows opened, read, and deliberately NOT moved

| id | stays | why |
| --- | --- | --- |
| L99 | W | §11.1 step 8 now governs something real — it decides whether the traveller sees an alert at all, pinned by a mutation (`travel-buddy-standalone/src/components/layover/__tests__/LayoverFlightChangeCard.component.test.tsx:200#step 8 gates the alert`). **Considered `C` and rejected.** §11.2's `W` reason names the product's only NOTIFICATION — the client's fixed 30-minute OS reminder — and that reminder is still ungated by this rule. An in-app banner and a push are different channels, and closing half a reason is not closing it. |
| L206 | W | "Every material recomputation creates a deterministic snapshot and decision record." The decision record is now real, deterministic and durable. The snapshot is not, and the requirement says both. |
| L207 | W | The `DecisionRecord` shape. Nine of ten members carry real values and the tenth is `null` with a named reason (`services/airport/LayoverReplanService.ts:245#export interface LayoverDecisionRecord`). By this document's own standard — L84 required `TruthValue<T>`'s eight members with "none a placeholder" — a null member disqualifies. §9.5's phrasing ("a DecisionRecord in substance and not in name") is now backwards: it is one in name, and one member short in substance. |
| L44 | W | `* → DISRUPTED`. Two of the three side effects are built and reached: the replan runs on a real flight event and the audit trail is written. The third is not — `invalidateRecommendations` DECIDES and nothing server-side applies it, because `layover_recommendations` has no snapshot column (L64). The client refetches; a refetch is not an invalidation. |
| L93 | W | §11.1 step 2 is handed exactly ONE session, the edited one, matched by `session_subject`. There is still no fanout, no airport-subject producer and no index for one (L259). |
| L94 | W | The node map is real and the skip is real. The recompute still re-certifies the whole record because there is one atomic derivation. What changed is only the evidence — see §12.1's second mutation. |
| L97 | W | §11.1 step 6 is now driven by an event rather than by a client GET, which was half of the `W`. The other half stands: nothing APPLIES the decision, and `layover_stable_recommendation_ids_enabled` is still FALSE. |
| L212 | W | `replan_rate` is now derivable by query — every replan writes a ledger row carrying `counts.replanned`, `counts.skipped` and `counts.notifications`. It is still not emitted, aggregated or exported anywhere, which is the rule that scored L208 and L214 `W`. |
| L172 | W | `updateConstraint(sessionId, patch)`. A constraint edit is now REFUSED by the replanner with `non_window_fields_changed` rather than mis-described — which is honesty about the gap, not a closing of it. There is still no constraint entity (L22). |
| L281, L285, L286, L287 | W | Untouched. Each needs an airport-truth fact, and this pass built no fact producer — see the ceiling. |
| L180, L181, L84–L89, L251, L252 | W / C | `LayoverAirportTruth.ts` is **not touched by this pass and has no caller outside its test.** Every verdict §11 gave it stands exactly as §11 gave it, including all its `⌀`. |
| L95, L209, L261 | N | No snapshot storage. Unchanged. |
| L191 | W | `LayoverDecisionService.replay(sessionId, engineVersion)`. **This row was nearly moved BACKWARD by accident.** §12's first draft listed it beside L95, L209 and L261 as `N`, reading the body row at §18 and not §10's move to `W` — `replayFeasibility` reproduces a record from its stored inputs. `check:census-integrity` caught it as a one-row disagreement between this section's headline and its own tables, which is the exact defect that check exists for and the only reason it is written down here rather than shipped. Verdict unchanged at `W`: still `(inputs)` rather than `(sessionId, engineVersion)`, still nothing stored to replay. |
| L118 | N | The card is a row of chips that triggers a real server-side replan rather than a local filter — but §13's requirement is about TIME-BUDGET chips on the map, and there is no map feasibility surface (L67, L117). A flight-time control on the dashboard is not that control. |
| L248 | N | §22's L5 rung is "dense live intelligence → high-confidence dynamic replanning". Dynamic replanning now has exactly ONE input, supplied by hand, at HIGH confidence because the traveller is the authority on their own itinerary. One self-reported input is not dense and is not intelligence. |
| L169 | N | Nothing detects a connection. A traveller telling us their flight moved is not detection. |

### 12.4 The ceiling

**What would turn each green claim red, and what this pass does not touch.**

1. **`LayoverAirportTruth.ts` IS STILL UNREACHABLE, AND THIS PASS CHOSE NOT TO
   REACH IT.** 824 lines, fourteen `C` verdicts, and the only importers are its
   own test file and `checkProductionDrift.ts`. That is not an oversight. Its
   corpus can come from exactly two places and **both are open owner decisions
   this lane must not take**: a traveller-submitted queue report is decision 10
   ("is it wanted at all?"), and an operator feed needs `airport_fact_observations`,
   which is decision 9 (apply 2860, or widen a live Sensing table). Building
   either would have been taking the decision by shipping it. So §11's closing
   sentence still stands over half its own output: fourteen `C` rows over a path
   with nothing in it, unchanged.

2. **A route is not a deployment.** Everything above is on a branch. The PATCH
   response gained a member and the ledger gained a row shape; neither reaches a
   traveller until this merges and deploys. There is no flag — deliberately, because
   a flag seeded FALSE would have made this pass one more `W` — which means the
   review of this diff IS the safety mechanism, and the diff should be read with
   that in mind.

3. **Two `session_updated` rows per replanned edit, and a query that does not
   know will double-count.** `updateSession` emits its own bare row before the
   decision row, and they cannot be merged: `layover_events.event_type` is a
   closed CHECK (`migrations/0127_layover_system.sql:199#CHECK (event_type IN (`, widened once by 2741) with no value for a
   replan, and widening it needs an applied migration. The alternative — passing
   the metadata through `updateSession` — would have shifted eight unanchored
   `path:line` citations into `LayoverSessionService.ts`, which is the rot class
   §11.1 measured and §11.2 repaired. The cost is stated in the writer's own doc
   comment and asserted by a test (`test/layoverSessionEditReplan.test.ts:257#the ledger keeps the bare session_updated row`).

4. **The replan is computed against the session the route is ABOUT to hold, and
   a concurrent edit can supersede it.** The DecisionRecord carries the
   `inputHash` it was made at, so a superseded decision is identifiable rather
   than silent — which is what a decision ledger is for — but nothing detects
   the race, and there is no snapshot to compare against (L95).

5. **A refusal is the common case and the client must keep saying so.** Most
   PATCHes to this route are `window_unchanged`. If the card ever stops
   rendering `REFUSAL_TEXT`, a traveller who presses a button gets a screen that
   does not answer, and no server test can see it. One component test stands
   there (`travel-buddy-standalone/src/components/layover/__tests__/LayoverFlightChangeCard.component.test.tsx:139#a delay press PATCHes this session` and the refusal test beside it).

6. **The client half is tested under jest in a workspace this repository's
   `pnpm-workspace.yaml` does not include.** `travel-buddy-standalone` is not a
   workspace member, so its 14 layover component tests do not run in
   `artifacts/api-server`'s suite and are not in the gate the api-server package
   defines. They were run — `npx jest --testPathPattern='layoverDashboard|LayoverFlightChangeCard'`,
   14 pass — and a reader should know they are run by hand and not by that gate.

7. **What is NOT reachable, still, and why** — the list §11 wrote, minus one
   line:

   | artifact | reachable? | why not |
   | --- | --- | --- |
   | `LayoverEventReplanner.handleEvent` | **YES, from a mounted control** | — |
   | `LayoverEventReplanner` steps 5-8 | **YES**, on the two flight event types | the other nine types have no producer |
   | `LayoverAirportTruth` (all of it) | no | owner decisions 9 and 10 |
   | `liveConditionsFrom` → the sixth buffer term | no | no fact producer, so `liveExtra` is 0 for every real caller, and the pin at `test/layoverLiveConditions.test.ts:134#the five original terms` still holds |
   | migration 2860, both tables | no | written, NOT applied |
   | §11.1 step 4, the snapshot | no | 2700 unapplied |
   | `LayoverCrewService` (12 exports), `localReplan`, `sensingPolicy`, `runLayoverTool`'s 12 tools | no | unchanged since §10 |

8. **THIS PASS MOVED LINES IN THREE COUNTED FILES AND THEREFORE AGED THIS
   DOCUMENT'S OWN CITATIONS.** Stated with the numbers, because a pass that
   caused citation rot and did not say so is the failure §11.1 measured:

   | file | where the pass inserted | offset a citation needs |
   | --- | --- | ---: |
   | `routes/airport.ts` | an import block after line 99, and the replan call plus its helper after line 707 | `+0` below 100, **`+8`** for 100-707, **`+54`** from 710 |
   | `travel-buddy-standalone/src/services/layover.ts` | the `ReplanOutcome` type after line 532, and the reworked `updateLayoverSession` body | **`+63`** for 533-543, **`+68`** from 544 |
   | `travel-buddy-standalone/app/layover/[id].tsx` | one import after line 46, the mount after line 322 | **`+1`** for 47-322, **`+10`** from 323 |

   **THIRTEEN ANCHORED citations were caught by `check:doc-citations` and
   repointed**, each verified by re-reading its anchor at the new line. Four
   `isSafetyEnabled` citations moved from lines 751-752 to
   `routes/airport.ts:806-807#isSafetyEnabled`; three `return_deadline_set`
   citations moved from lines 1105-1112 to
   `routes/airport.ts:1160-1167#return_deadline_set`; `manual_city` moved from
   line 1341 to `routes/airport.ts:1434#manual_city` and `departure_time` from
   line 1345 to `routes/airport.ts:1438#departure_time`; `returnRoutePrimary`
   moved from line 284 to
   `travel-buddy-standalone/app/layover/[id].tsx:345#returnRoutePrimary`; two
   `returnToAirportNow` citations moved from line 608 to
   `travel-buddy-standalone/src/services/layover.ts:676#returnToAirportNow`,
   and `askCompass` from line 560 to
   `travel-buddy-standalone/src/services/layover.ts:628#askCompass`. That is
   the anchor ratchet paying for itself on its first real test: it named every
   one, and an unanchored citation would have moved silently.

   **106 UNANCHORED citations into those three files were NOT shifted, and that
   is a decision, not an oversight.** An offset script was written and dry-run:
   all 106 map cleanly, every one verified by exact line-content equality
   between the pre-pass file and the shifted line. It was not applied for two
   reasons. First, most of them are in the BODY, which the correction header
   declares "unedited and describes HEAD `68ed59d9`" — a commit that is not in
   this repository, so those citations are anchored to a tree nobody here can
   read, and shifting them would make them describe no commit at all. Second,
   for the rest, shifting a pointer whose correctness was never re-verified is
   exactly the move §11.2 refused ("repointing them by the merge's measured
   offset would move a wrong pointer to a different wrong place"). The offsets
   above are published so the next re-read can apply them per row, after the
   claim is checked. **A reader following an unanchored `routes/airport.ts`
   line citation in this document to code above line 100 is fine, and below it
   is 8 or 54 lines short.**

9. **A measurement taken while checking the above, which is not a verdict.**
   The body's citations into `LayoverSessionService.ts` point, at THIS commit,
   at the wrong functions by a wide margin. Cited range → where the named
   function actually is, measured by reading the file:

   | row | cited lines | the function is really at |
   | --- | ---: | ---: |
   | L170 `createSession` | 111-148 | **149-190** (line 111 is inside `rowToSession`) |
   | L172 `updateSession` | 154-193 | **192-232** |
   | L174 `endSession` | 196-219 | **234-258** |
   | L171 `getActiveSession` | 240-255 | **306-323** |
   | L187 `setShareStatus` | 282-305 | **348-370** |
   | L196 `expireOldSessions` | 327-345 | **393-419** |

   **This pass did not touch that file** — the whole point of routing the
   ledger write through `emitLayoverEvent` rather than adding a parameter to
   `updateSession` was to avoid moving those lines. Whether they are the §11.1
   defect class (wrong at their own `head_commit`) or ordinary declared
   staleness cannot be settled here: the body's `68ed59d9` is unreachable in
   this clone. **No verdict moves**; every one of those six rows was re-read at
   its real location this pass and every claim still holds.

10. **Two shapes this pass got wrong before the guards caught them, recorded
    because the next author will reach for both.** Ten citations were first
    written as bare `` `:NNN#anchor` `` continuations with spaces in the anchor —
    the shape §11.2 added a refusal for, matched by no pass, silently
    uncounted. And §12.3's first draft moved L191 backward from `W` to `N` by
    reading the §18 body row and not §10's later move; `check:census-integrity`
    caught it as a one-row disagreement between this section's headline and its
    own tables. Both were found by a guard and neither by review.

11. **The three ratchets after this section: `MIN_ANCHORED_CITATIONS`
    1640 → 1701, `MIN_FULL_ANCHOR_CITATIONS` 1513 → 1574,
    `MAX_UNANCHORED_CITATIONS` UNCHANGED at 6491.** The ceiling is the one that
    matters and this pass did not move it: 61 anchored citations were added and
    not one existing unanchored citation was converted, because the 106 that
    this pass's own edits displaced are the ones it had the evidence to touch
    and item 8 says why it did not. A pass that raised two floors and left the
    ceiling where it found it has improved the new material and left the old
    material exactly as unverifiable as it was.

12. **Owner decisions.** This pass surfaces no new ones and resolves none.
   Decisions 9, 10 and 11 from §11.3 are all still open, and 9 and 10 are the
   reason §12 built no fact producer. Decision 11 —
   `SECURITY_WAIT_BASELINE_MIN = 20` as a declared assumption with no column
   behind it — is untouched and unreached, because nothing supplies a security
   wait for it to be subtracted from.

### Recomputed headline — commit `fa14590e5`

Same 296 denominator, same counting rule, same prohibition rule. Recomputed by
`pnpm -s check:census-integrity` from the tables themselves, last-verdict-wins,
with the eight PR-comparison rows skipped.

| Measure | At `af1864a7` (§11) | Now |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 42 | **48** |
| BUILT-BUT-WRONG | 142 | **138** |
| NOT-BUILT | 112 | **110** |
| CANNOT-VERIFY | 0 | **0** |
| Sum | 296 | **296** |
| CONSTRUCTED% | 62.2 % | **62.8 %** (186/296) |
| CORRECT% raw | 14.2 % | **16.2 %** (48/296) |
| CORRECT% non-vacuous | 9.5 % | **11.5 %** (34/296) |
| CORRECT% spec-attributable | 8.4 % | **10.5 %** (31/296) |

> **CONSTRUCTED% moved 0.6 points and that is the correct shape for this pass.**
> Only one row was constructed that was not constructed before (L238's
> integration test). The other six moves are `W → C`, which is what happens when
> something already built starts being reached. **NON-VACUOUS CORRECT% is the
> number that moved: 28 → 34, +2.0 points, and every one of the six is on a path
> a traveller can walk from a control the app mounts.** §11 moved 37 rows and
> none of them; this pass moved 7 and all of them. That is the trade the brief
> asked for, and it is also an admission: the previous pass's twelve-point jump
> bought less than this pass's half-point one.
>
> **Half of §11's output is still unreachable and this pass left it that way on
> purpose.** `LayoverAirportTruth.ts` — 824 lines and fourteen `C` verdicts, all
> `⌀` — has no caller outside its test, and the two ways to give it one are both
> open owner decisions. A census that had wired it anyway would be reporting a
> decision as a build.

---

## 13. Build pass — 2026-09-13 (third), the 138 `W` rows are counted and three of them stop being `W`

Paths relative to `artifacts/api-server/src/` unless prefixed
`travel-buddy-standalone/`. Same denominator (296), same counting rule (§1),
same prohibition rule, same buckets. **Nothing here is merged, nothing is
deployed, no flag is flipped, no migration is applied and no migration is
written.** Commits `d97af005` and `b9bdcfc3` on
`worktree-agent-a96f1481d064c0de6`.

**This pass took §12's brief one step further and changed what it measured
first.** §12 closed the gap between "built" and "reachable" for the replanner.
The same gap exists in 137 other places and nobody had counted it, so this
section opens with the count: which of the 138 `W` rows are a reachability
problem, which are a behaviour problem, which are held down by an unapplied
migration or a flag, and which need code nobody has written. The count is the
most durable thing here. Three row moves is less than a lane could wish for, and
§13.1 says why: **only 28 of 138 are reachability rows, and 12 of those 28 are
the Compass tool set, whose wiring is a flag decision this lane does not own.**

### 13.1 The 138 `W` rows, grouped by WHY they are `W`

Derived from the LAST statement of each row — the same rule
`check:census-integrity` uses — and cross-checked mechanically: the four groups
are disjoint, every id appears exactly once, and they sum to 138.

| group | meaning | rows |
| --- | --- | ---: |
| **(a) REACHABILITY** | The code is built and correct. Nothing outside `src/test/` calls it, or the server publishes it and no client reads it. A caller, a route or a screen closes it. | **28** |
| **(b) BEHAVIOUR** | Built AND reached, and what it does — or the shape it does it in — diverges from the requirement. | **25** |
| **(c) GATED** | The code is right and is held down by an unapplied migration or a flag seeded FALSE. **No code change in this repository can move these.** | **19** |
| **(d) UNBUILT HALF** | A named half of the requirement has no code at all. Someone has to write it. | **66** |

**(a) REACHABILITY — 28.** L9, L37, L41, L42, L99, L100, L102–L113, L120, L141,
L148, L149, L156, L180, L181, L184, L265, L268.
Twelve of the 28 are one object: the §12-spec Compass tools (L102–L113), built,
reachable from a live endpoint, and **not passed to the model** — which
`LayoverCompassService.ts` itself says is a change made behind a flag. Two more
(L180, L181) are `LayoverAirportTruth`'s two service methods, blocked behind
owner decisions 9 and 10. Two (L148, L149) are the disruption machine, which has
no producer to drive it. **The ones that need nothing but a caller or a client
read were five — L37, L41, L42, L120, L141 — and this pass took one of them,
plus L184.**

**(b) BEHAVIOUR — 25.** L15, L18, L19, L47, L58, L76, L77, L123, L162, L177,
L182, L183, L189, L205, L243, L250, L254, L260, L264, L269, L271, L273, L275,
L293, L294. This is the group a correctness pass can act on without needing a
decision from anyone, and it is the group this census has spent the least time
in. Four of them are single, specific, live defects a traveller can hit today:
L47 (`computePlanFit` sums `(durationMin ?? 0) + (travelMin ?? 0)`, so an
unknown leg costs zero minutes), L123 (the map card renders NOTHING for an
airport at `(0,0)`, which is the fallback profile's default), L271 (**the
Telegraph message is written to no thread** — the traveller is navigated to a
chat their text is not in), and L293 (the `/safety` probe's fabricated
`travelTimeMin: 20 / activityTimeMin: 30`). **This pass closed the gate half of
L77 and left the other four standing.**

**(c) GATED — 19.** L1, L5, L6, L14, L20, L33, L44, L97, L128, L147, L175, L176,
L191, L197, L206, L207, L238, L240, L263. **Fifteen** of the nineteen wait on
**2700** (no certified snapshot storage) or **2860** (no observation or event
storage); the other four — L33, L97, L128, L147 — wait on
`layover_safe_return_status_enabled`,
`layover_stable_recommendation_ids_enabled` or `layover_presence_ladder_enabled`
being FALSE. **A lane that may not apply a migration or flip a flag cannot move
any of these, and pretending otherwise is how a census gets a correction
header.** 19 of 138 is the hard floor on what any build pass under these rules
can reach.

**(d) UNBUILT HALF — 66.** Nearly half the `W` column. The largest clusters are
the schema-shape rows (L21, L26, L31, L35, L36, L38, L192, L194, L195, L198,
L199, L200, L202, L259 — fourteen rows that each need a migration written and
applied), the airport-truth rows with no fact producer (L79–L83, L143, L227,
L228, L247, L281, L285, L286, L287 — thirteen), the crew rows with no storage
(L133–L135, L137, L139, L187 — six), and the observability rows with no exporter
(L208, L212, L214 — three).

**What the grouping says about this census's headline.** CONSTRUCTED% is
62.8 % and CORRECT% is 16.2 %, a 46.6-point gap of 138 rows. Of those 138,
**19 cannot be moved by code at all** and **66 need a build rather than a fix**.
The gap a correctness pass can actually close in this repository, under these
rules, is **53 rows** — reachability and behaviour together — and 14 of those 53
sit behind an owner decision or a flag decision. The reachable-today number is
**39**.

### 13.2 What was built, and where

**1. §9.1's hard gate changed units.** `generateRecommendations` fetched
landside candidates when `session.wantsToLeave && session.layoverMinutes >= 90`.
`layoverMinutes` is the SCHEDULED arrival-to-departure span, typed in at session
creation; it knows nothing about immigration, bags, security, traffic or the
current time. The gate now reads the certified envelope
(`services/airport/LayoverRecommendationService.ts:423#const usableMinutes = certified.envelope.usableMinutes`),
and both thresholds with it — landside
(`services/airport/LayoverRecommendationService.ts:431#usableMinutes >= 90`) and
the city escape
(`services/airport/LayoverRecommendationService.ts:449#usableMinutes >= 180`),
including the "half-day" wording, which is a claim about time the traveller has
rather than about a stored column.

That threshold is not a new constant. `computeWindow` already calls a session
with under 90 usable minutes the `airport_only` TIER
(`services/airport/LayoverSafetyEngine.ts:814#usableMinutes >= 90`), so before
this change the engine could tell a traveller "airport only" on the hero and
hand them a city on the cards below it. **The gate and the tier now cannot
disagree.** Measured on the test's own fixture: a three-hour international
connection with immigration and checked bags has 0 usable minutes and a
600-minute `layoverMinutes`, and it used to get landside cards.

**2. §9.1's safety-first comparator got a caller.** `rankActivities`
(`services/airport/LayoverSafetyEngine.ts:532#export function rankActivities`)
is the engine's own "safe first, then shortest travel" ordering. It had **no
caller outside `src/test/`**. It is now the primary sort for every generated
card (`services/airport/LayoverRecommendationService.ts:530#const ranked = rankActivities`),
with the existing `verified` / time-of-day / live ordering surviving beneath it
— `Array.prototype.sort` is stable, so nothing decided above is discarded, it is
only demoted below the certified rating.

**Giving it a caller naively would have regressed a `C` row, and that is worth
recording.** `rankActivities` derived its own `computeReturnDeadline`. Called
from a service that has already certified one, that is a SECOND deadline
derivation inside a single request — at a different instant and blind to the
request's `LiveConditions` — which is the duplicate buffer `9c26efba` removed
and L53 is `C` for removing. The certified deadline is threaded in instead. The
function is also now generic in its candidate type, because a non-generic
signature discarded `recType` / `placeId` / `city` at the type level and would
have pushed the caller into re-deriving what it already held.

**3. The certified posture reaches the screen.** `explorationCollapsed` is
derived server-side from the certified return state
(`services/airport/LayoverSafeReturnService.ts:102#export function safeReturnPosture`
— true at RETURN_NOW and CONNECTION_AT_RISK), has been on the wire since the
safe-return pass, is in the client's own `SafeReturnPosture` type, and was read
by **nothing**, while `returnRoutePrimary` — the field beside it in the same
object, set from the same boolean — was read. The dashboard now collapses the
three exploration surfaces (recommendations, map, people) into one notice
(`travel-buddy-standalone/app/layover/[id].tsx:359#explorationCollapsed === true`,
rendered at
`travel-buddy-standalone/app/layover/[id].tsx:430#layover-exploration-collapsed`).

**Collapsed, not hidden**, and the distinction is the requirement: §13 asks for
exploration-first affordances to be suppressed when the traveller is due back,
not for the app to decide on their behalf that the city stopped existing. "Show
them anyway" is one press. Compass moved above the block so the three surfaces
are contiguous; it is the explainer, not an exploration affordance, and it stays
mounted in every posture — which keeps L114's `C` true.

**4. §17.1's permission gets its explanation.** The notification request was
already contextual and that half was never the gap; the gap was that nothing
said WHY, and the OS dialog cannot — the sentence it shows is the app's name and
the word "notifications". A rationale sheet now precedes it
(`travel-buddy-standalone/app/layover/[id].tsx:232#notificationPromptWouldAppear`),
and only when a dialog would actually appear
(`travel-buddy-standalone/src/lib/safeNotifications.ts:93#export async function notificationPromptWouldAppear`).
That probe fails towards NO sheet: an unreadable permission state is treated as
"no prompt", because an explanation on every tap is how people learn to dismiss
the one that matters. "Not now" dismisses the explanation and asks the OS for
nothing — declining an explanation is not declining a permission, and the OS
remembers the second answer and not the first.

**5. One new test file and one widened one, 18 new cases, 11 mutations.**
`test/layoverRecommendationGate.test.ts` (9 cases, real service + table-backed
fake DB) and 9 cases added to
`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx`.
Every mutation was made to PRODUCTION code, measured, reverted and `cmp`-verified
byte-identical; each file's header records them with counts.

### 13.3 Row moves

Three rows move, **all `W → C`, none vacuous.** Every one is on a path a
traveller walks from a control the app mounts. Two of the three are group (a)
rows; L165 is a group (d) row, which is the only thing this pass built that did
not already exist in some form.

| id | was | now | why |
| --- | --- | --- | --- |
| L141 | W | C | "At `CONNECTION_AT_RISK`: exploration surfaces collapse." §10's `W` reason, verbatim: *"`explorationCollapsed` is derived and published, and after this pass it is still read by nothing."* It is read now, and the three exploration surfaces are replaced by a notice — at RETURN_NOW as well as CONNECTION_AT_RISK, which is one rung stricter than the requirement and never looser. Red-first: keying the collapse off `returnRoutePrimary` instead — the field beside it, set from the same boolean — fails 4 (`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx:330#the collapse is keyed on explorationCollapsed`); forcing the derivation to `false` fails 3; wiring "Show them anyway" to a no-op fails 1. |
| L165 | W | C | "**Notifications** — explain that they are needed to warn when the safe return window changes." The body's `W` reason, verbatim: *"No explanation precedes the OS prompt — there is no rationale sheet or copy anywhere in the layover flow."* There is one, it names the specific risk the permission covers rather than asking for "alerts", and it appears only when a prompt would (`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx:371#a traveller whose phone is about to ask is told why first`). Red-first: removing the sheet fails 3; showing it unconditionally fails 1 (`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx:402#a traveller who already granted permission`). |
| L184 | W | C | `LayoverExperienceService.rank(sessionId, contracts)`. The body's `W` reason, verbatim and in full: *"Ordering exists but by `verified` and time-of-day only; the safety-first comparator `rankActivities` is dead code."* It is not dead code; it is the primary sort on the route the dashboard calls. Scored `C` on §12's own precedent for L179 — "the operation exists and is reached", not a byte-identical signature. **The counter-precedent is named rather than hidden**: L177 is `W` for a signature divergence and stays `W`, because its stated divergence is unclosed — `computeWindow` still takes an airport rather than a context. L184's stated divergence is closed exactly. Red-first: `test/layoverRecommendationGate.test.ts:186#no card outranks a safer card`. |

### 13.4 Rows opened, read, and deliberately NOT moved

| id | stays | why |
| --- | --- | --- |
| L77 | W | The gate is now the right quantity and its evidence is restated below for it. It is still not the requirement: §9.1 asks for eligibility + **entry** + time + safety, and entry permission is read nowhere on this tree (L34, L48, L230) and is an open owner decision. Three terms of four is not four, and a row that moved on three would be the substitution Appendix C1 forbids. |
| L120 | W | "When `RETURN_NOW` is active, suppress exploration-first affordances and prioritise airport route/gate." **Considered `C` and rejected, and the reason is the half nobody can build yet.** The suppression half is now real — it is L141's collapse. The other half is not: there is no airport ROUTE on this tree (`ReturnContract.route` is typed `null`, "there is no routing provider") and no GATE or terminal context (`pinTerminalContext` is published and `terminal_info` is null on all 3,206 production airports — L143). Hoisting a card that gives a deadline is not prioritising a route to a gate. §9's `W` reason has ALSO gone stale on its own terms — it reads *"the client type has no `safeReturn` field"*, and the client type has carried one since §10 — so the row is `W` for a different reason than the one written against it. |
| L42 | W | "Switch primary CTA to *Return to Airport*." **Considered and rejected, with the reason.** The sticky footer still reads Remind me / Ask locals / End in every posture. The two implementations available are both worse than the gap: a second control firing the same `POST /:id/return-now` loses the RETURN CONTRACT that `LayoverSafeReturnCard` renders on its own abort — the deadline and the stops it cancelled, the output that matters most — and a footer button that merely scrolls to the hoisted card is a navigation aid, not a CTA. Closing this honestly means lifting the abort handler into the screen, which is a refactor of the one safety-critical control on the surface and not something to do in the same pass that moved it. |
| L41 | W | "RETURN_SOON: high-priority notification, de-emphasise discovery." The de-emphasis half is now built — it is L141's collapse, one rung later. The notification half is not: the only notification this product sends is the traveller's own 30-minute reminder, and nothing fires at RETURN_SOON. |
| L99, L265 | W | Unchanged and for the same reason §12 gave. Step 8 and `MATERIALITY` are a real material-change threshold; the ONE notification this product sends is still the client's fixed reminder and neither rule gates it. |
| L260 | W | "Pre-filter by envelope/time/category before expensive ranking." Half closed by this pass: the pre-filter is now on the certified envelope rather than the scheduled window. The other half of its own `W` sentence stands — there is still no envelope GEOMETRY (§8), and a comparison of four rating buckets is not expensive ranking to protect. |
| L269 | W | "Discovery — only show experiences from the certified action universe." Closer, and still not it. The dashboard's own path now GATES on the certified window and ORDERS by the certified rating, but it still returns `not_recommended` cards — deliberately, with their warning, because hiding a card is not the same as explaining it. `GET /hidden-gems/layover-safe` is still not called from the layover surface. |
| L78 | N | "Optimise `preference_fit + local_uniqueness + …`" — eleven named terms. This pass added a SORT KEY, not an objective function, and a rating bucket is not one of the eleven. |
| L182, L183 | W | `getCandidates` and `compile`. Untouched: a candidate set that is better gated and better ordered is still not an executable experience contract, and `compile` still emits no route, no `departBy` and no abort threshold. |
| L47, L123, L271, L293 | W | The four live behaviour defects §13.1 names. Opened, read, confirmed still present at this commit, and **not fixed** — see the ceiling for why each was left. |
| L1, L5, L6, L191, L197, L206, L207, L238, L240, L263 | W | Gated on 2700 or 2860. No code change moves them. |
| L180, L181, L84–L89, L251, L252 | W / C | `LayoverAirportTruth.ts` is **not touched by this pass and still has no caller outside its test.** Every verdict §11 gave it stands exactly as §11 gave it, including all fourteen `⌀`. |

### 13.5 Evidence corrected, no verdict moved

Three rows carry a sentence that is false at this commit. Each is restated
rather than repointed, because the claim — not the line number — is what went
stale.

| id | the sentence that is false | what is true at this commit |
| --- | --- | --- |
| L294 | *"**Seven** bare `catch { return … }` blocks remain in `LayoverSessionService.ts` (`:187, 229, 255, 367, 387, 416`)."* | **Six.** The sentence names six line numbers and calls them seven, and `grep -n catch` over that file returns exactly those six, all still bare. The verdict does not move — six swallowed errors is the same defect — but the count in its evidence was wrong when it was written. |
| L272 | *"the 'Safe Return' control lives in the unmounted `LayoverReturnPanel`"* | `LayoverReturnPanel.tsx` **no longer exists in the tree**; the abort control is `LayoverSafeReturnCard`, which §10 mounted and which L146 is `C` for. The verdict does not move, because the requirement is about reusing the PRODUCT's Safe Return escalation UX — the route, circle-presence and safety-history screens, none of which the layover surface touches — and the layover surface still has its own. |
| L268 | *"the endpoint is unreachable from the client (headline defect 4)"* | `askCompass` has had an importer and a mounted card since §10, which is why L114 is `C`. The verdict does not move: no tools are passed to the model (L102–L113), there are no proactive OpportunityEvents and there is no clarification. |

**A fourth measurement, which is not a verdict and is not repaired.** L255's
citation into `routes/airport.ts` — line 1427, unanchored — is wrong at this
commit by **520 lines**: the gate is at
`routes/airport.ts:1986#rent_buddy_enabled`, read and verified here. That is far
more than §12.4's published `+54`, so it is not this branch's drift; the file
has grown by other lanes' merges since §10 measured it. **L255's own row is not
repointed**, for the reason §12.4 gives — a pointer whose correctness at its own
commit was never re-established should not be moved somewhere it will look
verified — and the verified location is published here instead, so the next
re-read can repair the row deliberately rather than by arithmetic. The verdict
holds: the gate exists and is the shared fail-closed reader.

### 13.6 The ceiling

**What would turn each green claim red, and what this pass does not touch.**

1. **THE FOUR LIVE DEFECTS IN GROUP (b) ARE STILL LIVE, AND THAT IS THIS PASS'S
   LARGEST OMISSION.** L271 discards a traveller's Telegraph message and then
   navigates them to a chat it is not in. L47 charges zero minutes for a leg
   with an unknown travel time, on the plan-fit verdict a traveller uses to
   decide whether a stop fits. L123 renders no map at all for an airport with
   no coordinates, which is every `buildFallbackProfile` airport. L293's
   `/safety` probe still fabricates a 20-minute leg and a 30-minute activity.
   **Three of the four are inside PR #463's stated scope and one (L271) is
   not**; this pass did not re-author #463's rows, for the reason §7 gave, and
   L271 was left because the write is into another lane's message contract. A
   reader deciding where the next hour goes should start here, not in group (d).

2. **THE GATE CHANGE IS A BEHAVIOUR CHANGE ON A LIVE PATH AND IT MAKES THE
   PRODUCT OFFER LESS.** Sessions that used to receive landside cards on a long
   scheduled window with no usable time will now receive inside-airport cards
   only. That is the correct answer and it is still a reduction a reviewer
   should see coming. It is deliberately not behind a flag: a flag seeded FALSE
   would have made this one more `W`, and a gate that is wrong behind a flag is
   still wrong. With 5 sessions ever and 0 active in production, nobody is
   holding a card this removes today.

3. **THE ORDERING CHANGE MOVES CARDS A TRAVELLER SEES, AND ITS PRIMARY KEY WAS
   UNPINNED UNTIL THIS PASS.** Neutralising `rankActivities`' rating key
   (`const rDiff = 0`) failed NOTHING — not in the new file and not in
   `test/airport.test.ts`, whose case is titled "rankActivities sorts safe
   first then shorter travel time" and asserts only that the travel-0 card
   leads, which the SECONDARY key alone produces. In every candidate set either
   file had, rating order and travel-time order agreed. The comparator's
   primary key was unpinned from the day it was written, and
   `test/layoverRecommendationGate.test.ts:230#the RATING key decides` is the
   first assertion that can fail on it. The weak case was NOT patched with a
   second aligned assertion; it carries a note saying what it does not pin.

4. **ONE GUARD IN THIS PASS IS CORRECT BY CONSTRUCTION AND PINNED BY NOTHING AT
   SERVICE LEVEL.** Dropping `certified.deadline` from the `rankActivities`
   call leaves the service suite 9/9 green, because `computeReturnDeadline` is
   pure in (airport, session, live) and does not read the clock — so a second
   derivation with no live conditions returns the identical instant. The
   parameter becomes load-bearing the day L81's producer lands and not before.
   The pin is written at the engine, where the difference is reachable
   (`test/layoverRecommendationGate.test.ts:259#rankActivities rates against the deadline it is HANDED`),
   and the case says in its own body that the service-level assertion above it
   does not catch this.

5. **THE CLIENT HALF IS STILL TESTED IN A WORKSPACE THIS REPOSITORY'S
   `pnpm-workspace.yaml` DOES NOT INCLUDE.** Unchanged from §12.4 item 6, and
   now with 9 more assertions resting on it. Run by hand:
   `npx jest --testPathPattern='layover.*component|Layover.*component'`,
   6 suites / 39 tests green at `b9bdcfc3`.

6. **THE COLLAPSE REORDERED THE DASHBOARD.** `LayoverCompassCard` moved from
   between the recommendations and the map to above both, so the three
   exploration surfaces are contiguous and can be collapsed as one child. That
   is a visible change no requirement asked for, taken because the alternative
   — three separate conditionals with one notice rendered in the middle of them
   — hides one rule in three places. The Compass panel itself is unchanged and
   is still mounted in every posture, which L114's `C` depends on.

7. **NO `C` ROW WAS FOUND FALSE, AND THE SEARCH WAS A SAMPLE.** Ten `C`
   verdicts were re-read against the tree (L2, L8, L45, L114, L146, L171, L253,
   L255, L278, L292) and all ten held. That is 10 of 48, chosen because they
   are the mechanically checkable ones, not because they were the most suspect.
   **A sample that finds nothing is not a sweep that found nothing**, and this
   census's own history — four `C` verdicts falsified in §9.5, four citations
   falsified in §11.2 — says the other 38 deserve the same treatment from
   someone.

8. **WHAT IS STILL NOT REACHABLE**, unchanged from §12.4 item 7 except for one
   line:

   | artifact | reachable? | why not |
   | --- | --- | --- |
   | `rankActivities` | **YES, from the dashboard's own card list** | — |
   | `LayoverAirportTruth` (all of it) | no | owner decisions 9 and 10 |
   | `runLayoverTool`'s 12 tools | no | declared, not passed to the model — a flag decision |
   | `LayoverCrewService` (12 exports) | no | no crew storage |
   | `localReplan`, `sensingPolicy` | no | no route, no client, no sensing |
   | `nextDisruptionState`, `recomputeForDisruption` | no | nothing drives them |
   | migration 2860, both tables | no | written, NOT applied |
   | §11.1 step 4, the snapshot | no | 2700 unapplied |

9. **CITATIONS.** Every citation this section writes is ANCHORED, and that is
   not a style choice: `MAX_UNANCHORED_CITATIONS` is at its ceiling, so one
   unanchored citation added here fails the tree. The three ratchets are left
   exactly where this pass found them. **This pass moved lines in five counted
   files** — `LayoverRecommendationService.ts`, `LayoverSafetyEngine.ts`,
   `airport.test.ts`, `travel-buddy-standalone/app/layover/[id].tsx` and its
   test — and `check:doc-citations` reports zero broken anchors afterwards,
   which is the anchor ratchet doing the job §12.4 said it would. The 106
   unanchored citations §12.4 published offsets for are **still not shifted**,
   for §12.4's own two reasons.

10. **Owner decisions.** This pass surfaces no new ones and resolves none.
    Decisions 9, 10 and 11 from §11.3 are open and untouched. Two decisions
    that are NOT owner decisions but block group (a) are named because twelve
    `W` rows sit behind the first: passing the twelve Compass tools to the model
    is a flag decision somebody has to take (L102–L113), and
    `layover_stable_recommendation_ids_enabled` is still FALSE, which is why
    "Add to plan" still does not render for a production traveller.

### Recomputed headline — commit `b9bdcfc3`

Same 296 denominator, same counting rule, same prohibition rule. Recomputed by
`pnpm -s check:census-integrity` from the tables themselves, last-verdict-wins,
with the eight PR-comparison rows skipped.

| Measure | At `fa14590e5` (§12) | Now |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 48 | **51** |
| BUILT-BUT-WRONG | 138 | **135** |
| NOT-BUILT | 110 | **110** |
| CANNOT-VERIFY | 0 | **0** |
| Sum | 296 | **296** |
| CONSTRUCTED% | 62.8 % | **62.8 %** (186/296) |
| CORRECT% raw | 16.2 % | **17.2 %** (51/296) |
| CORRECT% non-vacuous | 11.5 % | **12.5 %** (37/296) |
| CORRECT% spec-attributable | 10.5 % | **11.5 %** (34/296) |

> **CONSTRUCTED% did not move and that is the correct shape.** Nothing was
> constructed that was not constructed before; three things that were already
> built started being right or being reached. The gap between CONSTRUCTED and
> CORRECT closed by 1.0 point, from 46.6 to 45.6, and every fraction of it is a
> `W → C` move on a path a traveller walks.
>
> **The unflattering reading, which is the accurate one.** Three rows is 2.2 %
> of the 138. §13.1 says why: 19 of the 138 cannot be moved by any code change
> under these rules, 66 need a build rather than a fix, and 14 of the remaining
> 53 sit behind a decision this lane must not take. But it also says something
> this pass cannot excuse — **there are 25 behaviour rows, four of them specific
> live defects a traveller can hit, and this pass fixed half of one of them.**
> The rest of the time went into a count, and a count moves no number.


---

## §14 — L271: the message a traveller sent, in the thread they were sent to

§13's own ceiling named this the largest omission of that pass, in these words:
*"L271 discards a traveller's Telegraph message and then navigates them to a
chat it is not in … L271 was left because the write is into another lane's
message contract."* The reason was a reason, not a good one. It is closed here.

### 14.1 What was actually wrong — both halves, because either alone still lies

`POST /airport/sessions/:id/telegraph` classified the intent, resolved the
trip's chat thread for an ACCEPTED member, emitted a `telegraph_suggestion_sent`
event **carrying that thread id**, and answered `ok: true`. It never wrote the
message. The screen then pushed the traveller into that chat on `tripId` alone —
not even looking at the response — so the second half would have lied even if
the first had not: a failed send still landed them in a conversation their text
was not in, with nothing said.

Three things now exist:

| what | where |
| --- | --- |
| one plain-text thread writer, with the E2EE refusal that makes it safe to call from a second route | `artifacts/api-server/src/lib/threadMessage.ts:59#export async function postPlainThreadMessage` |
| the route writing the traveller's own text, before the event that reports on it | `artifacts/api-server/src/routes/airport.ts:1251#const sent = await postPlainThreadMessage(sc, {` |
| the screen navigating on `posted`, and saying something true when it is false | `travel-buddy-standalone/app/layover/[id].tsx:255#} else if (res.posted && overview.session.tripId) {` |

**Why a helper rather than an inline insert.** One of the rules is a privacy
rule, not a convenience: an end-to-end encrypted thread REFUSES a plaintext
body, and an unreadable `is_e2ee` refuses too rather than guessing `false` —
supabase-js RESOLVES on a database error, so an unchecked read yields
`data: null`, which reads as `is_e2ee: false`, which admits plaintext to an
E2EE thread during exactly the minute the database is unhappy. A second write
path that inlined the insert would be the one place the server quietly can read
a conversation it promises it cannot.

**What the helper deliberately does not do**, so no later caller assumes it: it
does not authorize (the route proves accepted trip membership first, and the
write is gated on the `threadId` that check produces), it does not translate or
scan for off-app solicitation or resolve reply references, and it does not
accept ciphertext. A caller needing those wants `POST /threads/:id/messages`.

### 14.2 The mutation that stayed green, and what it cost to fix

Block B of `artifacts/api-server/src/test/layoverTelegraphMessage.test.ts:198#describe("B. the layover Telegraph route WRITES` reads the route's SOURCE
TEXT. That was written first, and a mutation says why it is not enough: leaving
the call site written but unreachable —
`await Promise.resolve({ ok: true }) ?? await postPlainThreadMessage(...)` —
**kept every one of its assertions green** while the traveller's message went
nowhere, which is L271 exactly. Source text is not behaviour.

Block C is the repair: the route is exercised over HTTP against the layover
database double, and the assertion is on the `messages` table rather than on the
handler's prose (`artifacts/api-server/src/test/layoverTelegraphMessage.test.ts:321#describe("C. POST /airport/sessions/:id/telegraph`). Re-run against the same
mutation it fails 2.

| mutation | result |
| --- | --- |
| the writer's call site present but unreachable (L271's own defect) | **2 fail** |
| the `metaErr` binding dropped, so an unreadable `is_e2ee` reads as `false` | **1 fail** |
| the E2EE refusal removed | **2 fail** |
| the accepted-membership gate removed | **1 fail** |
| the screen navigating on `tripId` alone again | **1 fail** |
| control | **15 pass, 0 fail** |

### 14.3 Row moved

| id | was | now | why |
| --- | --- | --- | --- |
| L271 | W | **C** | *"The message is discarded"* — the row's own words — is false at this commit. The traveller's text is inserted into the resolved trip thread (`artifacts/api-server/src/test/layoverTelegraphMessage.test.ts:334#assert.equal(tables.messages![0]!.body, text`), `posted` travels on the response and on the emitted event so the audit record is a fact rather than a guess, and the screen navigates to the chat only when the message is in it. Three refusals are asserted rather than assumed: a non-member gets no thread and no write, an E2EE thread is refused with `postFailure: "e2ee"` and no plaintext row, and a trip with no thread yet writes nothing and does not crash. Red-first, five mutations, including one that first exposed a source-reading test as worthless. |

### 14.4 What this does NOT close

- **The other three live defects of group (b) stand**: L47 still charges zero
  minutes for a leg with an unknown travel time, L123 still renders no map for
  a `buildFallbackProfile` airport, and L293's `/safety` probe still fabricates
  a 20-minute leg and a 30-minute activity. §13's ceiling is otherwise unchanged.
- **The message carries no trip context object.** It is the client's composed
  sentence, stored as `msg_type: "text"` with `subtype: "layover_suggestion"`.
  Anything richer is a Telegraph message-contract question, not a layover one.
- **There is no idempotency key.** Two taps in quick succession post twice. The
  screen has no double-press ref on this control the way the Safe Return card
  does (L146), and adding one belongs with that control, not here.
- **A DIVERGENCE FOUND AND NOT FIXED, recorded so it is not lost**: inside
  `artifacts/api-server/src/routes/messaging.ts` the TEXT send path publishes
  `message.created` with `messageId` and no body, while the MEDIA path publishes
  `id` **and `body`** — against the payload field's own documented contract
  (*"Never include message bodies or other PII"*,
  `artifacts/api-server/src/lib/telegraphEvents.ts:105#/** Event-specific data. Never include message bodies or other PII. */`).
  The new helper follows the text path. The media path is census-telegraph's to
  answer for; copying it here would have made it two places instead of one.

### 14.5 Recomputed headline — one row, and the headline says so

Same 296 denominator, same counting rule, same prohibition rule. Recomputed by
`pnpm -s check:census-integrity` from the tables themselves, last-verdict-wins,
with the PR-comparison rows skipped. This supersedes the §13 headline.

| Measure | At `b9bdcfc3` (§13) | Now |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 51 | **52** |
| BUILT-BUT-WRONG | 135 | **134** |
| NOT-BUILT | 110 | **110** |
| CANNOT-VERIFY | 0 | **0** |
| Sum | 296 | **296** |
| CONSTRUCTED% | 62.8 % | **62.8 %** (186/296) |
| CORRECT% raw | 17.2 % | **17.6 %** (52/296) |

> **One row. 0.4 of a point.** That is the honest size of this pass and it is
> written here rather than dressed up: a single `W → C`, on one of the four live
> defects §13 named, chosen because a traveller hits it and because §13's stated
> reason for skipping it — *"the write is into another lane's message
> contract"* — turned out to cost one small module with one privacy rule in it.
> CONSTRUCTED% does not move, correctly: nothing was constructed that was not
> constructed before; one thing that was already built started being true.
>
> **What would turn this red.** Delete `postPlainThreadMessage`'s call site and
> block C fails. Make the call site unreachable without deleting it and block C
> still fails — which block B did not, and that is recorded in §14.2 rather than
> quietly fixed, because a source-reading test that cannot tell reachable code
> from dead code is the shape of a green run that proves nothing.
