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
> | `head_commit` | `1fe72289b` — RE-DECLARED 2026-09-15 at the squash merge of PR #482. The previous value was `80a8d655a`, a commit on the pre-merge branch. **The squash made it an orphan**: it still exists in a clone that fetched the branch, but it is on no line of history leading to `main`, and `check:census-freshness` refuses an orphan because the check would pass locally and fail in a fresh clone. Nothing about this census was re-measured and NO verdict moves — `1fe72289b` is the commit its previous declaration's tree became, so zero counted files have changed since it. The prior declaration and its reasoning follow. — RE-DECLARED 2026-09-14 by §22, replacing `060027b0b`. §22 re-derived the rows this branch's Layover changes bear on — twelve moved `W → C`, and L110 and L112 deliberately did not (§22.2), on the same rule three other censuses now state. §22.5 reports three `N` rows that look wrong at HEAD and explicitly does NOT grade them. The 49 counted files that changed are the §12 tool-loop and §24 reminder builds plus the shared files sibling lanes touched. It does **NOT** certify the other 61 `C` rows, and §1's reading rule applies unchanged. The previous declaration read: `060027b0b` — RE-DECLARED 2026-09-13 by the §18 build pass, which is the commit §18's verdicts were derived at and the commit that carries every counted file this pass changed: the two new modules `services/airport/LayoverTemporalFreedom.ts` and `services/airport/LayoverEnvelope.ts`, plus `services/airport/LayoverSafetyEngine.ts`, `services/airport/LayoverRecommendationService.ts`, `routes/airport.ts`, `travel-buddy-standalone/src/services/layover.ts`, `travel-buddy-standalone/src/components/layover/CanILeaveCard.tsx`, its new component suite, and three new server suites. **This is a RE-MEASUREMENT, not a re-declaration** — §18 opened every one of those files, moved twelve rows against tests watched RED first, ran thirty-four mutations against production code and restated the headline from `check:census-integrity` rather than by hand. **ZERO counted files move between `060027b0b` and this document's own commit**, so no acknowledgement is needed in its place. **IT IS ON THE LANE BRANCH `lane-layover-arch` AND CARRIES THE SAME PRE-SQUASH HAZARD EVERY VALUE IN THIS ROW HAS CARRIED**: after a squash-merge it becomes an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. PREVIOUS VALUE, verbatim: `a5c223a37` — RE-DECLARED 2026-09-13 by the §17 build pass, which is the commit §17's verdicts were derived at and the commit that carries every counted file this pass changed: `routes/airport.ts`, `services/airport/LayoverFeasibility.ts`, `services/airport/LayoverEventReplanner.ts`, `services/airport/LayoverReplanService.ts`, `src/test/layoverEventReplanner.test.ts`, the three new server suites, `travel-buddy-standalone/src/services/layover.ts`, `CanILeaveCard.tsx`, `layoverReturnFacts.ts`, the new `LayoverEndSheet.tsx`, `app/layover/[id].tsx` and its two component suites. **This is a RE-MEASUREMENT, not a re-declaration** — §17 opened every one of those files, moved four rows against tests watched RED first, ran twenty-three mutations and restated the headline from `check:census-integrity` rather than by hand. The acknowledgement written against `eb70ab3b2` is RETIRED, not deleted, in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`, which is what that entry's own last paragraph instructs; **ZERO counted files have moved between `a5c223a37` and HEAD**, so the re-declaration needs no acknowledgement in its place. **IT IS ON A LANE BRANCH AND CARRIES THE SAME PRE-SQUASH HAZARD EVERY VALUE IN THIS ROW HAS CARRIED**: after a squash-merge it becomes an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. PREVIOUS VALUE, verbatim: `eb70ab3b2` — RE-DECLARED 2026-09-13 by the integrating lane, which is what §15.9 says must happen and names as the pairing this checker enforces: *"It is spent the moment this pass is committed: whoever commits it must re-declare `head_commit` at the resulting hash and retire the acknowledgement."* `eb70ab3b2` IS that commit — it carries §15, the three rows §15.4 moves (L47, L123, L42), and every one of the eleven counted files §15.9 lists as this pass's own, together with `services/airport/LayoverPlanFit.ts`, `src/test/layoverPlanFitUnknownLegs.test.ts` and `travel-buddy-standalone/src/components/layover/useSafeReturnAbort.ts`. The acknowledgement written against `7cac6e2b4` — the one that did **not** claim its eleven files were harmless and pointed at §15 instead — is RETIRED, not deleted, in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`, so its per-file argument survives the entry. **ZERO counted files have moved between `eb70ab3b2` and HEAD**, which is why this re-declaration needs no acknowledgement of its own. **IT IS ON THE INTEGRATION BRANCH `claude/sweet-fermat-fmx7up` and carries the same pre-squash hazard every value in this row has carried**: after a squash-merge it becomes an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. **This is a RE-MEASUREMENT, not a re-declaration** — §15 opened all twelve files, moved three rows against tests watched RED first, and restated the headline from `check:census-integrity` rather than by hand. PREVIOUS VALUE, verbatim: `7cac6e2b4` — RE-DECLARED 2026-09-13 by the §14 build pass, which is the commit §14's verdict was derived at and the commit that changed `artifacts/api-server/src/routes/airport.ts`, `travel-buddy-standalone/app/layover/[id].tsx` and `travel-buddy-standalone/src/services/layover.ts` under this census. **IT IS ON THE INTEGRATION BRANCH `claude/sweet-fermat-fmx7up` and carries the same pre-squash hazard every value in this row has carried**: after a squash-merge it becomes an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. **This is a RE-MEASUREMENT, not a re-declaration** — §14 opened all three files, moved L271 and restated the headline from the rows. PREVIOUS VALUE, verbatim: `b9bdcfc3c` — RE-DECLARED 2026-09-13 by the §13 build pass, which is the commit §13's verdicts were derived at and the second of the two commits that changed `services/airport/LayoverRecommendationService.ts`, `services/airport/LayoverSafetyEngine.ts`, `src/test/airport.test.ts`, `travel-buddy-standalone/app/layover/[id].tsx`, its component test and `travel-buddy-standalone/src/lib/safeNotifications.ts` under this census. **IT CARRIES THE SAME PRE-SQUASH HAZARD every value in this row has carried**: it is on `worktree-agent-a96f1481d064c0de6` and on no remote branch, so after a squash-merge it becomes an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. PREVIOUS VALUE, verbatim: `fa14590e5` — RE-DECLARED 2026-09-13 by the §12 build pass, which is the commit §12's verdicts were derived at and the commit that changed `routes/airport.ts`, `travel-buddy-standalone/src/services/layover.ts` and `travel-buddy-standalone/app/layover/[id].tsx` under this census. **IT CARRIES THE SAME PRE-SQUASH HAZARD every value in this row has carried**: it is on `worktree-agent-a4a1855c806a24d03` and on no remote branch, so after a squash-merge it becomes an ancestor of nothing and `check:census-freshness` will report this census unreadable until whoever merges re-declares the squash sha. PREVIOUS VALUE, verbatim: `af1864a7` — RE-DECLARED 2026-09-13 by the §11 build pass, which re-measured 37 rows and therefore owns this row; the previous value and its whole argument follow unchanged. `af1864a7` is the second of §11's two commits and is the commit its verdicts were derived at. **IT CARRIES THE SAME PRE-SQUASH HAZARD the paragraph below documents**: it is on `worktree-agent-a1965b10a690c9e97` and on no remote branch, so after a squash-merge it becomes an ancestor of nothing and this check will report the census as unreadable until whoever merges re-declares the squash sha. That is a known cost of declaring a branch commit, taken deliberately rather than leaving the row naming a commit four files older than the tree. PREVIOUS VALUE, verbatim: `42aeac38` — RE-DECLARED 2026-09-10 from `743ae78f305ea657ab508a34bdbc574488f4aae7` (§9 measured `cdfff5995c92f7adfb3ae7880496bc94002717e9`; §10 re-measured, at `743ae78f`, the rows a client lane could move). It was necessary because `743ae78f` is PRE-SQUASH — this repository squash-merges, so it is an ancestor of nothing, is on no remote branch, and `check:census-freshness` could resolve it only on the clone that wrote it (`CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI`). Reproduced 2026-09-10 in a fresh clone of this branch: `git diff 743ae78f..HEAD` aborts with `Invalid revision range`, and the check reported this census as unreadable rather than checking it. `42aeac38` is #476's squash, where this document's content reached `main`. **This is a RE-DECLARATION, not a re-measurement.** ONE counted file changed between `743ae78f` and `42aeac38`: `artifacts/api-server/src/services/airport/LayoverPrivacyGuard.ts`. The move is defensible only because each was re-verified mechanically on 2026-09-10 over `743ae78f..42aeac38`: filtered to lines that are neither comment nor blank, that diff is EMPTY against a `--stat` of 7 insertions and 4 deletions — the edit updates the file's header note to record that the `TripCrewLocationService` read it had flagged is now fail-closed. No statement, signature, condition or constant moved, so no layover verdict can have. The full per-file argument is preserved under `retired` in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`, where it had been written as an acknowledgement. **Changed by the Trips lane, not this one**, because CI could not run this check against this census at all until it was; nothing else in this document is touched, and reverting it costs only the check. |
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
| **CORRECT% (spec-attributable)** = 0/296 | **0.0 %** (rows citing this spec; see §2 — the rest are attributable-elsewhere or UNKNOWN, not "not this spec's") |
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
  (`routes/airport.ts:1992#travelers = ((profiles ?? []) as any[]).map((p) => ({`). No code path anywhere writes `'completed'`. The entire
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

> **RESTATED 2026-09-14 — the figure stands, the one-word answer does not.** *"0/296 rows rest
> on an artifact citing this specification"* is measured by the grep below and is correct. The
> answer **"No"** to the question in this heading is a different and larger claim, and this
> section's grep cannot reach it: a file that cites nothing is a file we know nothing about.
> The correct answers are per-row and three-valued — attributable to this spec (evidenced by an
> in-file citation), attributable elsewhere (evidenced by an in-file citation of a different
> programme, which is what the table below supplies for most of the BUILT verdicts), or
> **UNKNOWN**. Where the table below reaches a row, that row is attributable elsewhere; where
> it does not, the row is UNKNOWN, not "not this spec's".
> See `docs/architecture/attribution-method.md`.

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
**[RESTATED 2026-09-14 — UNKNOWN.]** What the commit message cites is measured and kept. *"It
is not attributable either"* does not follow: the sentence before it observes that #463
independently reinvents two of this spec's rules, and "independently" is precisely the thing
the evidence cannot establish. Record #463 as **attribution unknown**. What would settle it: a
section citation in the diff or commit message, or the author.

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
| L5 | Every consequential recommendation is versioned, explainable and replayable | N | `layover_recommendations` has no version, snapshot, engine-version or input-hash column (`0127:106-138`), and rows are deleted wholesale and re-inserted on read (`LayoverRecommendationService.ts:793-798#layover_recommendations").delete()`, triggered from `routes/airport.ts:958-959#isSafetyEnabled`). Nothing can be replayed. |
| L6 | All surfaces consume the same certified `LayoverSnapshot`/`RecommendationContract`; **no duplicate time-budget logic** | W | One shared library exists (`computeBuffer`), which is real progress — but there are three independent *uses* of it with different inputs (`LayoverSafetyEngine.ts:90` departure-based, `:247` cutoff-based, `LayoverCompassService.ts:51` departure-based) plus the client's own thresholds (`LayoverReturnPanel.tsx` line 114, **deleted at `a718beb5`**). No snapshot exists for surfaces to share. |
| L7 | Commercial ranking only after eligibility, safety and time feasibility (≡ §9.1, ≡ App C7) | N ∅ | No commercial input reaches the recommendation path at all — a grep of `services/airport/` and `routes/airport.ts` for `sponsored`/`promoted`/`is_paid`/`boost` returns nothing. But there is no gate either: ordering is `verified`-first plus time-of-day (`LayoverRecommendationService.ts:511-513#verified places lead`), and the one safety-first comparator that exists, `rankActivities` (`LayoverSafetyEngine.ts:924-938#export function rankActivities`), is dead code. Unguarded absence. |
| L8 | Precise social location is opt-in, temporary and automatically expires | C | Concrete artifact: layover presence structurally cannot carry a coordinate. `cityPresence` selects `user_id, manual_city, airport_profiles(city)` and nothing else (`routes/airport.ts:1925#manual_city`); `SafeRecommendation` has no lat/lng field at all (`LayoverPrivacyGuard.ts:31-52`). Opt-in: `share_city_status BOOLEAN NOT NULL DEFAULT FALSE` (`0127:82`). Temporary: presence is filtered on `status='active' AND departure_time > now()` (`routes/airport.ts:1929#departure_time`) and `expireOldSessions` flips the status (`LayoverSessionService.ts:327-345`). |
| L9 | Missing live intelligence degrades **visibly** to historical/conservative fallback; never fabricate freshness | W | The fallback ladder is real (DB row → `STATIC_AIRPORTS` → `buildFallbackProfile`, `services/airport/AirportProfileService.ts:37-68`), but it is invisible: `publicAirport` (`routes/airport.ts:830-843`) exposes only a `verified` boolean, rendered as a badge (`components/layover/LayoverHero.tsx:48#verified`), and a generic-buffer session is indistinguishable from a curated one. Worse, freshness is *fabricated*: `estimateTravelTime(placeType)` returns 15 or 25 minutes without reading a coordinate (`LayoverRecommendationService.ts:212-216`) and that number becomes a "safe" rating. **[463]** |
| L10 | The system optimises successful real-world action and safe completion, not screen time | N | Nothing measures completion. `layover_outcomes` does not exist, `status='completed'` is never written (`routes/airport.ts:1992#travelers = ((profiles ?? []) as any[]).map((p) => ({` is the only close and passes `"cancelled"`), and no metric of any kind is emitted (§20 below). The system cannot distinguish a safe return from an abandonment. |

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
| L33 | `LayoverState` — 17 members from `DETECTED` to `EXPIRED` | W | `status TEXT … CHECK (status IN ('active','completed','cancelled','expired'))` (`0127:85-86`) — four values, and `'completed'` has no writer (`routes/airport.ts:1992#travelers = ((profiles ?? []) as any[]).map((p) => ({`). Thirteen of the spec's states, including every one that carries operational meaning (`EVALUATING`, `LANDSIDE_AVAILABLE`, `EXECUTING`, `RETURN_SOON`, `RETURN_NOW`, `RETURNING`, `AIRPORT_REENTERED`, `BOARDING`, `DISRUPTED`), do not exist. |
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
| L77 | **HARD GATE**: eligibility + entry + time + safety, before any optimisation | W | A gate exists but it is the wrong gate: landside candidates are fetched only when `wantsToLeave && layoverMinutes >= 90` (`LayoverRecommendationService.ts:244-246`), where `layoverMinutes` is the *scheduled* window, not usable time. So a 95-minute international connection with a 150-minute buffer still gets landside candidates; each is rated `not_recommended` and each is still written and returned (`:286-307`). Entry is not in the gate at all. The one safety-first ordering that exists is dead code (`LayoverSafetyEngine.ts:924-938#export function rankActivities`). |
| L78 | Optimise `preference_fit + local_uniqueness + opportunity_scarcity + social_value + experience_density + memory_value − monetary_cost − energy_cost − uncertainty − stress − return_risk` | N | The entire objective is two terms: `verified` first, then a time-of-day nudge (`LayoverRecommendationService.ts:511-513#verified places lead`). None of the eleven named terms exists. |

### §10 Airport Intelligence and truth reconciliation

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L79 | **Static topology** — terminal, gate, checkpoint, walking link; weeks/months, invalidated on authoritative change | W | A static airport record exists and is well built for what it is: `STATIC_AIRPORTS` (`services/airport/StaticAirportData.ts:23+`, ~200 hubs with real timezones and coordinates) behind a DB-first resolver (`AirportProfileService.ts:70-90`). Topology is not modelled: `terminal_info JSONB DEFAULT '{}'` has no writer, and there are no gates, checkpoints or walking links. No invalidation concept. |
| L80 | **Operational semi-live** — security layout, lounge hours, transport schedules; hours/days | N | The only lounge datum is `lounge_access BOOLEAN` on the session (`0127:71`), which is what the *user* declared about their ticket. |
| L81 | **Fast live** — security wait, immigration wait, taxi queue, disruption; minutes | N | Absent. `grep -rn liveClaimRead services/airport/` returns nothing (the same finding `docs/architecture/census-sensing.md:319` records from the other side). |
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
| L97 | Invalidate recommendations whose snapshot is stale or no longer feasible | W | There is wholesale invalidation — `generateRecommendations` DELETEs every row for the session and re-inserts (`LayoverRecommendationService.ts:793-798#layover_recommendations").delete()`), triggered whenever `layover_safety_engine_enabled` is on (`routes/airport.ts:958-959#isSafetyEnabled`). But it is driven by a client GET, not by an event; it has no staleness test; and it destroys rather than invalidates, so a client holding the previous ids loses them silently. |
| L98 | Emit an `OpportunityEvent` only if the user's actionable options materially changed | N | No such event type. |
| L99 | Notify only when user action should change | N | The only notification is a user-requested fixed 30-minute reminder (`app/layover/[id].tsx:167-191`). |

### §12 Compass / AI contract

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L100 | Compass is an orchestrator and explainer: asks the minimum useful clarifying question, compares certified plans, personalises wording, invokes deterministic tools | W | It explains and personalises — one chat completion over a structured deterministic context (`LayoverCompassService.ts:57-97`), with a deterministic fallback answer when the model fails (`:99-110`). It asks no clarifying question, compares no plans, and invokes no tool: the call has no tool schema (`:90-97`). |
| L101 | Compass **cannot invent or widen** the certified safe envelope, return deadline, visa/entry status, operational state or risk band | W | The structured fields are safe by construction (L16). The prose is not: the only enforcement is prompt text (`:71-79`) plus a coordinate regex (`LayoverPrivacyGuard.ts:100-106`). Visa/entry is not a field at all on main, so a model assertion about it is unconstrained by anything. And the whole endpoint is unreachable from the app (headline defect 4), so the contract governs a surface no user can reach. |
| L102 | Tool `getLayoverContext(sessionId)` | N | No layover tool exists. `compass/CompassTools.ts:75-219` declares eleven tools (`get_user_profile`, `get_current_trip`, `search_places`, `search_events`, `get_place_details`, `get_circle_activity`, `check_trip_conflicts`, `add_to_trip`, `get_whos_around`, `get_travel_compatibility`, `get_group_recommendation`) — none layover. |
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
| L171 | `LayoverSessionService.getActive(userId)` | C | `getActiveSession` (`LayoverSessionService.ts:240-255`) behind `GET /api/airport/sessions/active` (`routes/airport.ts:2061#router.get("/airport/sessions/active", async (req, res) => {`), which expires stale sessions first (`routes/airport.ts:2076#const swept = await expireOldSessions(sc);`). |
| L172 | `LayoverSessionService.updateConstraint(sessionId, patch)` | W | `updateSession` (`LayoverSessionService.ts:154-193`) patches session fields under an `.eq("status","active")` guard (`:183`) — but there is no constraint entity to patch (L22), so terminals, baggage mode, entry state, mobility profile and buffer profile are unreachable by construction. |
| L173 | `LayoverSessionService.recordCheckpoint(sessionId, checkpoint)` | N | (L30) |
| L174 | `LayoverSessionService.close(sessionId, **outcome**)` | W | `endSession` exists (`LayoverSessionService.ts:196-219`) but the outcome argument has nowhere to go — `layover_outcomes` is absent (L32) — and the only caller passes the literal `"cancelled"` (`routes/airport.ts:1992#travelers = ((profiles ?? []) as any[]).map((p) => ({`), so a successfully completed layover is recorded as a cancellation. |
| L175 | `LayoverFeasibilityService.evaluate(sessionId)` | W | The computation exists (`computeWindow` + `adviseLeaving`) and is invoked per session at `routes/airport.ts:1041-1042`, but there is no service, no session-scoped `evaluate`, and the result is a response body rather than a certified, stored evaluation. |
| L176 | `LayoverFeasibilityService.certifyRecommendation(sessionId, candidatePlan)` | N | Nothing certifies. |
| L177 | `TemporalFreedomService.buildFreedomWindow(context)` | W | `computeWindow(airport, session, nowMs)` (`LayoverSafetyEngine.ts:232-281`) is the analogue and is a genuinely careful piece of work — boarding-cutoff anchoring, airport-local overnight detection, exit-delay modelling. It takes an airport, not a context, and returns a `LayoverWindow`, not a `FreedomWindow` (L58). |
| L178 | `TemporalFreedomService.calculateCommitmentEnvelope(context)` | N | No `Commitment` (L57). |
| L179 | `LayoverReplanner.handleEvent(event)` | N | No event ingest (L91). |
| L180 | `AirportTruthService.getTruth(subject, factType, atTime)` | N | No truth model (L84). |
| L181 | `AirportTruthService.reconcile(observations)` | N | No observations (L82). |
| L182 | `LayoverExperienceService.getCandidates(sessionId)` | W | `generateRecommendations` (`LayoverRecommendationService.ts:460-466#export async function generateRecommendations`) does produce a session-scoped candidate set, and its time-of-day filter is real and careful (`timeOfDayContext` samples every 30 minutes to the boarding cutoff, `LayoverRecommendationService.ts:131-156#export function timeOfDayContext`). The candidates themselves rest on category constants (L9). |
| L183 | `LayoverExperienceService.compile(sessionId, candidateIds)` | W | `POST /airport/sessions/:id/stops/from-recommendation` (`routes/airport.ts:1164-1211`) plus `computePlanFit` (`:886-901`) compiles chosen candidates into an ordered itinerary with a fit verdict. It compiles no route, no `departBy`, no abort threshold and no fallback (L76). |
| L184 | `LayoverExperienceService.rank(sessionId, contracts)` | W | Ordering exists (`LayoverRecommendationService.ts:511-513#verified places lead`) but by `verified` and time-of-day only; the safety-first comparator `rankActivities` (`LayoverSafetyEngine.ts:924-938#export function rankActivities`) is dead code. |
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
| L205 | Service-role processing should be **narrow and auditable** | W | It is auditable in part — `layover_events` records session, plan, share and reminder actions with their inputs (`routes/airport.ts:1582-1589#return_deadline_set` is a good example: minutesBefore, hardReturnTime and reminderAt all recorded). It is the opposite of narrow: every one of the ~30 layover routes runs on `getServiceClient()` (`:268, 307, 484, 520, 578, 628, 673, 726, 774, 981, 1004, 1031, 1101, 1444, 1526`), so the whole domain bypasses RLS and the row policies protect nothing on the server path. |

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
| L249 | Enable features per airport maturity | N | The only tier-like signal is `airport_profiles.verified` (`0127:37`), and it gates nothing: it changes a badge (`LayoverHero.tsx:48`) and adds a "possible_but_risky" nudge for unverified far places (`LayoverSafetyEngine.ts:156#*                     safety route's 20 — are deleted, not relabelled. A`). No feature is enabled or withheld by maturity. |
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
| L258 | Audit all server-side changes to certification fields and return contracts | W | The return-deadline write is properly audited with inputs and outputs (`routes/airport.ts:1582-1589#return_deadline_set`). Recommendation generation — which writes every `safety_rating`, `return_buffer_min` and `hard_return_time` in the system — logs only `{ count: rows.length }` (`LayoverRecommendationService.ts:819#count: rows.length`), so the values written and the inputs that produced them are not recoverable. |

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
| L276 | **Live Intelligence** — consume crowd/queue/mobility signals; publish de-identified airport observations | N | `grep -rn liveClaimRead services/airport/` returns nothing; the same absence is recorded from the Sensing side at `docs/architecture/census-sensing.md:319`. Nothing is published either. |
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
| L296 | C5. Never certify a recommendation against a snapshot other than the one returned with it | N | There are no snapshots to mismatch. The nearest analogue of the violation is live: `GET /:id/recommendations` regenerates and replaces the whole set whenever `layover_safety_engine_enabled` is on (`routes/airport.ts:958-959#isSafetyEnabled` → `LayoverRecommendationService.ts:793-798#layover_recommendations").delete()`), so the ids a client holds are destroyed under it and a subsequent `POST /stops/from-recommendation` (`routes/airport.ts:1164`) refers to a row that no longer exists. |

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
*(Restated 2026-09-14: what is measured is that #463 cites migration 0169 and its own defect
list and not this document, so it is **not evidenced as this spec's**. "Not attributable" and
"independently" both overstate that — an uncited diff that reinvents two of the spec's rules is
exactly the case where attribution is **UNKNOWN**. See §2 and
`docs/architecture/attribution-method.md`.)*

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
Spec-attributable would remain **0.0 %** — i.e. none of the rows #463 moves would rest on an
artifact citing this spec. Under the 2026-09-14 restatement above, those rows would be
attribution **UNKNOWN**, not attribution-elsewhere.

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

- `LayoverSafetyEngine.ts:137#* default 30) so the server state and the local reminder agree.` declares `TravelTimeSource =
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
| `POST /airport/sessions/:id/return-now` wired, 2741 applied | **Yes** | route `routes/airport.ts:1108`; 2741 applied `20260908133347` (`lib/capability/production-applied-migrations.json`, `docs/architecture/migration-queue.md:39`) |
| `terminal_info` published via `airportRowToProfile` | **Yes, and empty** | `services/airport/AirportProfileService.ts:146`, surfaced at `routes/airport.ts:1727#terminalInfo: a.terminalInfo ?? null,`. **0 of 3,206 production rows carry one**, so it is `null` everywhere |
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
| L2 | W | W | `certificationHeader` (`LayoverFeasibility.ts:679#certificationHeader`) is published on five endpoints. No client consumes it, and the client's own thresholds still exist in the tree (`travel-buddy-standalone/src/components/layover/LayoverReturnPanel.tsx` lines 113-114, still unmounted — **deleted at `a718beb5`, after this line was written**). |
| L4 | N | **W** | Confidence now exists and is computed: `ESTIMATE_CONFIDENCES` (`LayoverFeasibility.ts:102`), `worstConfidence` (`:182`), folded onto every record (`:493`). The fail-closed half is explicitly NOT built and the file says so (`:352-362`: "This record publishes the confidence; it does NOT forbid"). Half built. |
| L5 | W | W | `LAYOVER_FEASIBILITY_VERSION` (`:69`), `inputHash` (`:325`) and a real `replayFeasibility` (`:520`) exist. Nothing is stored to version or replay (2700 unapplied). |
| L6 | W | W | The duplicate-time-budget half is genuinely closed (see the table above). "All surfaces consume the same certified snapshot" is not: there is no snapshot, and the per-request record is not shared between requests. |
| L37 | N | W | The spec's exact four members exist as `ESTIMATE_CONFIDENCES` (`LayoverFeasibility.ts:102`), are computed (`:182`) and published (`:541`). Nothing consumes the value and no `confidence_band` column exists (L21), so no decision turns on it. Reachability is the missing half. |
| L52 | C | C | **Loses its `⌀`.** A certified envelope now exists and the property is swept over it: `test/layoverFeasibilityInvariants.test.ts:180` — "a longer travel leg never expands the safe envelope", over activity times and both `verified` values. |
| L54 | N | W | `Estimate` carries every field §6.2 names (`LayoverFeasibility.ts:124-138`) for seven terms, published as `estimates` on `/safety` and `/overview` (`routes/airport.ts:832, 1536`). It **describes** the buffer rather than computing it — the file says so at `:196-201` — so the number a traveller acts on is still a bare scalar out of `computeBuffer`. |
| L55 | N | W | `SAFETY_CRITICAL_PERCENTILE = "p90"` (`:151`), overridable per call (`FeasibilityInputs.bufferPercentile`), applied by `conservativeBufferMinutes` (`:222`) and published as `bufferMinutesAtPercentile` (`:494`). A no-op on the numbers today by the file's own admission — every distribution is degenerate (`:112-121`). |
| L102 | N | W | `runLayoverTool("getLayoverContext")` (`LayoverCompassService.ts:564`), swept by `test/layoverPrivacyCompassContract.test.ts:197-223`. **SUPERSEDED at §22**: the schemas are now passed (`LayoverCompassService.ts:322#tools: LAYOVER_TOOL_SCHEMAS`) and what the model chooses is executed (`LayoverCompassService.ts:334#const result = runNamedLayoverTool(c?.function?.name, ctx, c?.function?.arguments);`), reached from `POST /api/airport/sessions/:id/compass`. The anchor this cell used to carry — the comment reading "DECLARED, NOT YET PASSED TO THE MODEL" — was DELETED by that change, so this is a rewrite and not a repoint. |
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
| L135 | N | W | `certifyCrewPlan` (`LayoverCrewService.ts:219#certifyCrewPlan`) evaluates every branch against every member's own certified record; an uncertified member is INFEASIBLE, not assumed fine (`test:294`). Same limit. |
| L136 | N | **C** | `⌀` **vacuous.** `locationPrecisionFor` (`LayoverCrewService.ts:418`) returns `none` for a stranger and can reach `precise` only through a live, target-granted, crew-scoped grant (`:433-441`); swept, not sampled (`test/layoverCrewConstraints.test.ts:389-403`). The guard is real and fail-closed; the path it guards is empty. Scored under §1's prohibition rule. |
| L137 | N | W | `CrewShareEndReason` (`LayoverCrewService.ts:331`) names all five terminators plus a TTL and `evaluateCrewLocationShare` (`:373`) reports the FIRST cause (`test:338-376`). Nothing stores a grant. |
| L138 | N | **C** | `⌀` **vacuous.** `meetActionAvailability` (`LayoverCrewService.ts:462`) requires block-free, mutual, same-crew, public meeting point, cleared safety gate AND a non-escalated return state on both sides, and returns every failure rather than the first. Real refusal, empty path. |
| L139 | N | W | `sharedRideDisclosure` (`LayoverCrewService.ts:503#sharedRideDisclosure`). No shared-ride concept exists to disclose. |
| L141 | N | W | `explorationCollapsed` is derived and published (`LayoverSafeReturnService.ts:113`; `routes/airport.ts:1547`), tested at `test/layoverSafeReturnAbort.test.ts:138`. No surface collapses: the client does not read the field. |
| L143 | N | W | `pinTerminalContext` (`LayoverSafeReturnService.ts:115`) and `terminalInfo` now reach the API (`AirportProfileService.ts:146` → `routes/airport.ts:1727#terminalInfo: a.terminalInfo ?? null,`; also `LayoverSafeReturnService.ts:180` and `LayoverDegradedService.ts:166`). **0 of 3,206 production airports carry one**, so the pinned context is `null` for every session. |
| L146 | N | W | `abortAvailable` is TRUE in every state including NORMAL (`LayoverSafeReturnService.ts:117`, asserted `test/layoverSafeReturnAbort.test.ts:156`) and `POST /:id/return-now` is wired (`routes/airport.ts:1108`). **No client exposes it** — no `return-now` call exists in `travel-buddy-standalone/src/services/layover.ts`. Reachability is the missing half. |
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
| L150 | W | The **server** half is now real — `certifiedAt`, `staleAfter` and the record's `inputHash` travel with the bundle (`LayoverDegradedService.ts:104-127`), wired at `routes/airport.ts:1869`. The **client** half is unchanged: nothing is cached for display anywhere under `travel-buddy-standalone`. |
| L126 | N | Map offline state needs a rendered envelope timestamp. There is no map offline rendering and no envelope geometry. |
| L33 | W | `returning` is legal since 2741 (applied `20260908133347`) — 5 of the spec's 17 states. It is **never written in production**: `layover_safe_return_status_enabled` is FALSE, and the abort reports `status_unchanged_flag_off` (`LayoverSafeReturnService.ts:341#status_unchanged_flag_off`). |
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
| `certification` on `/overview` | Published, **not read** | **Read and rendered** | `LayoverOverview.certification` (`src/services/layover.ts:349`), `summarizeCertification` (`src/components/layover/layoverReturnFacts.ts:143#summarizeCertification`), rendered `LayoverSafeReturnCard.tsx:89` and `LayoverCompassCard.tsx:60` |
| `safeReturn` posture | Published, **not read** | **Read and rendered** | `LayoverOverview.safeReturn` (`layover.ts:351`), `postureHeadline` (`layoverReturnFacts.ts:170#postureHeadline`), used `LayoverSafeReturnCard.tsx:81`; `returnRoutePrimary` hoists the card above the hero (`app/layover/[id].tsx:405#returnRoutePrimary`) |
| `offlineBundle` | Published, **not read** | **Read and displayed; still not cached** | `LayoverOverview.offlineBundle` (`layover.ts:353`), `bundleFreshness`/`describeDeadline` (`layoverReturnFacts.ts:54, 92`). **`AsyncStorage` appears nowhere** under `app/layover/`, `src/components/layover/`, `src/services/layover.ts` or `src/context/LayoverSessionContext.tsx` — grep, not recollection |
| `POST /:id/return-now` | Wired, **no client function** | **Reachable by gesture** | `returnToAirportNow` (`layover.ts:909#returnToAirportNow`) → `LayoverSafeReturnCard.tsx:96`, mounted at `app/layover/[id].tsx:383#<LayoverSafeReturnCard` |
| `POST /:id/compass` | **Dark** — `askCompass` had no importer | **Reachable by gesture** | `LayoverCompassCard.tsx:24, 48`, mounted at `app/layover/[id].tsx:346` |
| `runLayoverTool` (12 §12 tools) | Callable, **not passed to the model** | **Unchanged** | `LayoverCompassService.ts:726-736` still says DECLARED, NOT YET PASSED TO THE MODEL. A reachable endpoint is not a reachable tool |
| `GET /:id/safety` | Dark — `LayoverRecommendationScreen.tsx` imported by nothing | **Still dark** | `grep -rn LayoverRecommendationScreen app/ src/` outside its own file: no hits. `getSessionSafety` still has that one importer and it is unmounted |
| `LayoverCrewService` (12 exports), `localReplan`, `sensingPolicy`, `nextDisruptionState`, `recomputeForDisruption` | No caller outside tests | **Unchanged** | No client can reach what no route exposes |

### Verdict changes

| id | Was | Now | Evidence at `743ae78f` |
| --- | --- | --- | --- |
| L2 | W | **C** | Both halves that kept it `W` are closed. The header is consumed — `summarizeCertification` (`layoverReturnFacts.ts:143#summarizeCertification`) renders the server's own `engineVersion`/`confidence`/`bufferPercentile` rather than a client restatement of them — and the client's DUPLICATE thresholds are gone with the file that held them: `LayoverReturnPanel.tsx` no longer exists (`git rm`, commit `a718beb5`). Grepped for surviving threshold constants in the replacement: none. |
| L146 | W | **C** | §9 said "Reachability is the missing half" in those words. It is closed: `returnToAirportNow` (`layover.ts:909#returnToAirportNow`) calls `POST /:id/return-now`, `LayoverSafeReturnCard.tsx:96` calls it on a **RETURN TO AIRPORT** press, and the card is mounted (`app/layover/[id].tsx:383#<LayoverSafeReturnCard`). A double press is refused by a ref written synchronously (`:77, 92-93`) — state alone loses two presses in one frame. The abort's own `statusCapability` is reported to the traveller rather than swallowed (`:239-240`, `statusCapabilityNote`), so `flag_off` reads as "your layover stays open so you keep the countdown", not as a failure. |
| L114 | W | **C** | §9 ended "The endpoint it lives on is still dark from the app." It is not: `askCompass` (`layover.ts:861#askCompass`) has an importer (`LayoverCompassCard.tsx:24, 48`), the card is mounted (`app/layover/[id].tsx:346`), and the single highest-value clarifying question is the thing actually rendered (`LayoverCompassCard.tsx:83-86`). The computation (`valueOfInformation`, `LayoverCompassService.ts:453`) was already built and pinned; a traveller can now be asked. |

### Rows I looked at and deliberately did NOT move

| id | Stays | Why |
| --- | --- | --- |
| L150 | W | The client half is **displayed, not cached**. `describeDeadline` (`layoverReturnFacts.ts:92#describeDeadline`) renders "Last certified N min ago" from `offlineBundle.certifiedAt`/`staleAfter`, which is honest labelling of an answer's age — but §16's claim is that a client can *serve* a stale answer offline, and nothing writes the bundle to storage. `AsyncStorage` does not appear anywhere under the layover client. A label about staleness on a screen that cannot open offline is half of L150, and half is `W`. |
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
`test/layoverLiveConditions.test.ts:133#the five original terms`. CONSTRUCTED%
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
| 5 diff the action universe | `:552#actionUniverseOf`, `:630#diffActionUniverse` | verdict, return state, tier, usable minutes, deadline, feasible candidate ids, reason codes |
| 6 invalidate | `:673#invalidateRecommendations` | decides; writes nothing |
| 7 OpportunityEvent | `:683#opportunityEventFor` | `null` unless materially changed (`:698#MATERIALITY`) |
| 8 notify | `:752#shouldNotify` | strictly narrower than step 7 |

`handleEvent` (`:861#handleEvent`) runs 2 through 8 in order. `disruptionAfter`
(`:919#disruptionAfter`) finally gives §15.2's state machine an input — and
refuses to give it a false one: a security-queue event is not a flight
disruption (`:905#disruptionEventFor`).

**3. The seam into the safety arithmetic.** `LiveConditions`
(`services/airport/LayoverSafetyEngine.ts:280#LiveConditions`) is the one shape
the buffer accepts live intelligence in, and
`LayoverAirportTruth.liveConditionsFrom` (`:660#liveConditionsFrom`) is the only
thing that builds one. It becomes a SIXTH buffer term, `liveExtra`
(`LayoverSafetyEngine.ts:389#liveExtra:`, summed into the total at
`:380#liveExtra`), additive-only and clamped at zero (`:229#liveExtraMinutes`)
so a live signal can make a deadline earlier and never later. It is a NAMED
INPUT of the certified record (`LayoverFeasibility.ts:331#liveConditions:`), so
it is inside `inputHash` and inside a replay, and it produces the only §6.2
estimate on this tree that can carry a real `observedAt`/`expiresAt`
(`LayoverFeasibility.ts:560#liveExtraEstimate`). Both version constants moved:
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
| L96 | N | C | §11.1 step 5. `actionUniverseOf` + `diffActionUniverse` (`LayoverEventReplanner.ts:587#actionUniverseOf`, `:630#diffActionUniverse`), exercised in both directions — a spike that loses options (`test/layoverEventReplanner.test.ts:423#drops`) and a delay that gains them. Red-first: emptying `candidatesLost` fails 2. |
| L98 | N | C | §11.1 step 7. `null` unless the options materially changed (`LayoverEventReplanner.ts:726#opportunityEventFor`, thresholds `:698#MATERIALITY`); the two flight reason codes are emitted here because only a diff can know them. Red-first: emitting unconditionally fails 1. |
| L251 | N | C | Was `N ∅`. Both halves exist over the same channel: a rate limit that applies to official feeds too (`LayoverAirportTruth.ts:224#OBSERVATION_RATE_LIMIT`, mutation → 1 failure) and trust weighting by kind × standing × decay (`:192#OBSERVER_KINDS`, mutation setting community trust to 1.0 → 2 failures). |
| L252 | N | C | Outlier rejection against each fact's declared physical range rather than a dispersion nobody has the population for (`LayoverAirportTruth.ts:368#isImplausible`, `:135#PLAUSIBLE_RANGE`); a 900-minute queue from an official feed is refused (`test/layoverAirportTruth.test.ts:188#implausible`). Red-first: always-false fails 1. |
| L257 | N | C | Both halves. Every payload is validated per event type (`LayoverEventReplanner.ts:203#normalizeEvent`) and dedup is by `source:sourceEventId` or a content digest (`:319#dedupeEvents`), with `eventId` deliberately excluded. |
| L44 | N | W | A material disruption now has an input: `disruptionAfter` walks §15.2's machine from a flight event (`LayoverEventReplanner.ts:962#disruptionAfter`), `invalidateRecommendations` names the stale set (`:673#invalidateRecommendations`) and `handleEvent` replans (`:861#handleEvent`). The audit-trail half is not built — nothing writes — and nothing produces the event. |
| L80 | N | W | The class exists with the spec's freshness and its three fact types (`LayoverAirportTruth.ts:95#AIRPORT_FACT_TYPES` — `security_layout`, `lounge_hours`, `transport_schedule`). No producer of any of the three, and no applied storage. A channel is not a fact. |
| L81 | N | W | Four fact types at a 20-minute TTL, and two of them REACH THE SAFETY BUFFER through `liveConditionsFrom` (`LayoverAirportTruth.ts:660#liveConditionsFrom`) — more than any other class has. Still no producer: every production session runs `liveConditions = null`. |
| L82 | N | W | The class exists and is confidence-weighted the way the spec asks (trust × decay), with a corroboration floor above it. There is NO SUBMISSION SURFACE — no route, no screen, nothing a traveller can report from. |
| L83 | N | W | `buildHistoricalModel` folds observations into per-local-hour p50/p75/p90 bands and withholds a band below five samples (`LayoverAirportTruth.ts:739#buildHistoricalModel`). "Recalibrated" is NOT built: `measureCalibration` measures error and adjusts nothing. |
| L93 | N | W | §11.1 step 2 built as a function over a session list handed in (`LayoverEventReplanner.ts:362#impactedSessions`), with the window bound that stops an airport event reaching a departed flight. It is not a fanout: there is no query and no index on an airport, route or flight subject (L259 unchanged). |
| L94 | N | W | §11.1 step 3. The node map is real and the skip is real — five event types move nothing and are skipped rather than re-certified (`LayoverEventReplanner.ts:416#EVENT_AFFECTS`; `test/layoverEventReplanner.test.ts:685#SKIPPED`). The recompute itself re-certifies the whole record, because there is one atomic derivation and no node subgraph to recompute. |
| L99 | N | W | §11.1 step 8 exists and is strictly narrower than step 7 — there is a material change that produces no notification (`LayoverEventReplanner.ts:795#shouldNotify`; `test/layoverEventReplanner.test.ts:621#STRICTLY`). It governs nothing: the ONE notification this product sends is still the client's fixed 30-minute reminder (`travel-buddy-standalone/app/layover/[id].tsx:167`), which this rule does not gate. |
| L179 | N | W | `handleEvent` exists with the spec's name and runs steps 2-8 in order (`LayoverEventReplanner.ts:861#handleEvent`). It takes a context bag instead of reading sessions, writes nothing, and has no caller outside its test. |
| L180 | N | W | `getTruth(subject, factType, atTime, corpus)` (`LayoverAirportTruth.ts:608#getTruth`). Signature divergence stated in the code: the spec's version reads a store, there is no store, so the corpus is an argument. |
| L181 | N | W | `reconcile(observations)` matches the spec's signature exactly and implements all five §10.1 rules. Scored W rather than C for consistency with how this document has scored every other built-but-uncalled service method (L133-L135, L137, L139, L156, L157): a named service operation with no caller is W here. |
| L212 | N | W | `HandleEventResult` carries `replanned`, `skipped` and `notifications`, so a replan rate is derivable from a call — the same rule that scored L208 and L214 W. Nothing calls it, nothing counts, nothing is emitted. |
| L225 | N | W | The scenario now exists as a test over the certified record with a real arrival-delay event (`test/layoverEventReplanner.test.ts:464#arrival`), including that the deadline does NOT move — an arrival delay is not a departure delay. Same limit as L226: a unit test over the solver, not a session; no delay input reaches one. |
| L227 | N | W | The scenario exists and the contraction is swept, not sampled (`test/layoverLiveConditions.test.ts:276#monotone`). **Considered `C` and rejected**: §9 scored L226 W with the words "a unit test over the solver, not a scenario of a session", and a security spike is in exactly that position — no security wait reaches a session. |
| L228 | N | W | `traffic_extra_min` is still a static admin constant and this does not change it. What is new is a SEPARATE live term that moves the deadline earlier and leaves the static figure alone, asserted as both (`test/layoverEventReplanner.test.ts:489#traffic`). Same solver-not-session limit. |
| L247 | N | W | `measureCalibration` measures signed error, absolute error and p90 coverage per hour band (`LayoverAirportTruth.ts:799#measureCalibration`) and returns zeros when there is nothing to compare. It MEASURES ONLY — no model is calibrated, and there are no outcomes to calibrate against. |
| L263 | N | W | The code half is built and red-first (dedup key, first-occurrence-wins). The schema half — `UNIQUE (dedup_key)` — is written and **NOT APPLIED** (`2860_layover_airport_truth_and_events.sql:276#layover_external_events_dedup_uidx`), and its postcondition asserts the index is UNIQUE rather than merely present. |
| L281 | N | W | `SECURITY_WAIT_HIGH` has an emitter for the first time (`LayoverAirportTruth.ts:677#SECURITY_WAIT_HIGH`) and reaches the certified record's `reasonCodes`. Not `C`: §7 promoted the four codes that ARE emitted on real sessions, and this one is emitted only when a fact nobody produces is supplied. |
| L285 | N | W | `DATA_STALE` emitted when a contributing truth is past its own expiry (`LayoverAirportTruth.ts:681#DATA_STALE`). Same limit. |
| L286 | N | W | `SOURCE_CONFLICT` emitted when a contributing truth was contradicted (`LayoverAirportTruth.ts:679#SOURCE_CONFLICT`). Same limit. |
| L287 | N | W | `TRAFFIC_DEGRADED` emitted on a degraded ground-transport reading (`LayoverAirportTruth.ts:678#TRAFFIC_DEGRADED`). Same limit. |
| L288 | N | W | `FLIGHT_MOVED_EARLIER` emitted by the diff, and only for a flight event — a queue spike also moves the deadline earlier and must not claim the flight moved (`LayoverEventReplanner.ts:752#FLIGHT_MOVED_EARLIER`; asserted both ways at `test/layoverEventReplanner.test.ts:593#FLIGHT_MOVED_EARLIER`). Same limit. |
| L289 | N | W | `FLIGHT_DELAY_CREATED_OPPORTUNITY` emitted only when a delay actually widened the window materially (`LayoverEventReplanner.ts:761#FLIGHT_DELAY_CREATED_OPPORTUNITY`) — not on every delay, because a delay into the night band can shrink it. Same limit. |
| L51 | C | C | **Verdict unchanged, vacuity narrowed and NOT removed.** `test/layoverFeasibilityInvariants.test.ts`'s own header says "`security_wait` HAS NO INPUT on this tree". It has one now (`LayoverSafetyEngine.ts:280#LiveConditions`) and the invariant is swept over it directly, 0-240 minutes, in two timezones (`test/layoverLiveConditions.test.ts:188#non-increasing`) instead of over the buffer columns that stood in for it. Still `⌀`: nothing supplies the input. |

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
   the equality is pinned (`test/layoverLiveConditions.test.ts:133#the five original terms`).
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
| L5, L97, L296 | `LayoverRecommendationService.ts` lines 309-318 | `LayoverRecommendationService.ts:793-798#layover_recommendations").delete()` | the `generateRecommendations` signature |
| L7, L78, L184 | `LayoverRecommendationService.ts` lines 251-257 | `LayoverRecommendationService.ts:511-513#verified places lead` | a `placeType` → `recType` map |
| L258 | `LayoverRecommendationService.ts` lines 320-328 | `LayoverRecommendationService.ts:819#count: rows.length` | a section comment |
| L182 | `LayoverRecommendationService.ts` lines 230-351 | `LayoverRecommendationService.ts:460-466#export async function generateRecommendations` | the candidate-shape interface |
| L182 | `LayoverRecommendationService.ts`, the inherited lines 23-47 | `LayoverRecommendationService.ts:131-156#export function timeOfDayContext` | import statements |
| L5, L97, L296 | `routes/airport.ts` lines 560-566 | `routes/airport.ts:958-959#isSafetyEnabled` | not the regeneration trigger |
| L205, L258 | `routes/airport.ts` lines 751-755 | `routes/airport.ts:1582-1589#return_deadline_set` | the regeneration call, not the audited deadline write |
| L7, L78, L184 | `LayoverSafetyEngine.ts` lines 148-168 | `LayoverSafetyEngine.ts:924-938#export function rankActivities` | not the dead comparator |

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

`windowChangeEvent` (`services/airport/LayoverReplanService.ts:145#export function windowChangeEvent`)
turns a window edit into the §11 event that describes it — comparing the two
`FeasibilitySession`s rather than the patch, so a PATCH that sets `departureTime`
to the value it already held is `window_unchanged` and not an event. The §11
vocabulary is closed at eleven, so an edit no member describes is REFUSED with a
named reason (`services/airport/LayoverReplanService.ts:103#export type ReplanRefusal`) instead of being squeezed into
the nearest-looking type: both ends of the window moving, boarding moving on its
own or by a different amount than departure, and a constraint edit (flight type,
immigration, bags, intent) each have their own refusal and each is published to
the traveller.

`replanForWindowChange` (`services/airport/LayoverReplanService.ts:346#export function replanForWindowChange`) runs step
1 through step 8 and returns a decision. Between normalisation and the pipeline
it does the thing that makes the whole seam safe: it re-derives the post-event
session with **the pipeline's own `applyEventToInputs`** and compares it field by
field against the session the route is about to persist. A mismatch refuses with
`inputs_diverged` and publishes nothing, so the `before`/`after` a traveller
reads can never describe a session that did not exist. That guard is not
argued — mutation 1b below turns every route case red through it.

`recordReplanDecision` (`services/airport/LayoverReplanService.ts:498#export async function recordReplanDecision`)
writes the §20 record to `layover_events`.

**2. The route is the ingest.** `replanAfterSessionEdit`
(`routes/airport.ts:853#async function replanAfterSessionEdit`) reads the
airport and the plan stops, runs the pipeline and writes the ledger row; the
PATCH handler calls it after the edit has committed
(`routes/airport.ts:837#const replan = await replanAfterSessionEdit`) and
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
card and the plan (`travel-buddy-standalone/app/layover/[id].tsx:494#<LayoverFlightChangeCard`),
and `updateLayoverSession`
(`travel-buddy-standalone/src/services/layover.ts:829#export async function updateLayoverSession`)
— which until this pass **had no caller anywhere in the app** — now returns the
replan beside the session, typed (`travel-buddy-standalone/src/services/layover.ts:766#export type ReplanOutcome`).

**4. §20's DecisionRecord, with the member it cannot fill named.**
`LayoverDecisionRecord` (`services/airport/LayoverReplanService.ts:247#export interface LayoverDecisionRecord`)
carries **nine of the spec's ten members with real values**: `sessionId`,
`engineVersion`, `inputHash`, `inputFacts[]` (the constraint nodes that moved and
their before/after values, `services/airport/LayoverReplanService.ts:303#function inputFactsFor`), `sourceRefs[]` (the
event and its dedup key), `rulesApplied[]` (the pipeline steps that fired, in
order, including which of 7 and 8 declined), `result`, `reasonCodes[]` and
`computedAt`. `snapshotId` is `null` with `snapshotUnavailableReason:
"no_snapshot_storage"` — 2700 is unapplied and a content hash renamed
`snapshotId` would be the substitution Appendix C1 forbids. **That one null is
why L206 and L207 do not move.**

**5. Appendix A `RECOMMENDATION_EXPIRED` gets its first emitter**
(`services/airport/LayoverReplanService.ts:331#function invalidationReasonCodes`), and unlike the five codes §11 gave
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
  (`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx:251#the dashboard mounts the flight-change card`)
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
| L179 | W | C | `LayoverReplanner.handleEvent(event)`. §11.2 scored it `W` for three reasons and two are closed: it has a caller outside `src/test/` (`routes/airport.ts:853#async function replanAfterSessionEdit`, reached by a mounted control), and its decision is written (`services/airport/LayoverReplanService.ts:498#export async function recordReplanDecision`). The third stands and is stated rather than hidden: `handleEvent` still takes a context bag, and the I/O the spec's one-argument method implies lives in `replanForWindowChange` above it. Scored `C` on this document's own precedent — L170 is `C` for `createManual(input)` against a `createSession(db, input)` reached by a route, so the standard here is "the operation exists and is reached", not a byte-identical signature. Red-first: removing the ledger write fails 2; `inputs_diverged` on a diverged event fails 6. |
| L225 | W | C | "Arrival delay → freedom shrinks." §11.2's `W` reason, verbatim: *"a unit test over the solver, not a session; no delay input reaches one."* A delay input reaches one now — `PATCH` with a later `arrivalTime` — and the scenario is asserted at route level, including that the hard return does NOT move, because an arrival delay is not a departure delay (`test/layoverSessionEditReplan.test.ts:176#an arrival delay shrinks freedom`). Red-first: emptying `EVENT_AFFECTS["flight.arrival_delayed"]` fails it. |
| L226 | W | C | "Departure delay → freedom may expand after recompute." Same reason closed the same way, at route level (`test/layoverSessionEditReplan.test.ts:145#a departure delay becomes flight.departure_delayed`), including `FLIGHT_DELAY_CREATED_OPPORTUNITY`. The deadline delta is asserted POSITIVE rather than equal to the shift, because the return buffer is airport-local-time dependent and an equality would make the test's colour depend on the hour the suite runs at. |
| L288 | W | C | `FLIGHT_MOVED_EARLIER`. §11.2 scored it `W` because it was "emitted only when a fact nobody produces is supplied". A traveller reporting an earlier departure produces it, and the code reaches the response, the ledger and the screen (`test/layoverSessionEditReplan.test.ts:200#a planned stop that stops fitting is named`). Same promotion rule §7 used for the four codes emitted on real sessions. |
| L289 | W | C | `FLIGHT_DELAY_CREATED_OPPORTUNITY`. Same, on the delay path, and still only when the delay actually widened the window materially — not on every delay. |
| L291 | N | C | `RECOMMENDATION_EXPIRED` has an emitter for the first time (`services/airport/LayoverReplanService.ts:331#function invalidationReasonCodes`) and it fires on a real session: a planned stop that stops fitting after a real edit. Rendered (`travel-buddy-standalone/src/components/layover/__tests__/LayoverFlightChangeCard.component.test.tsx:224#a lost planned stop is named`). Red-first: returning `[]` from the emitter fails 1. |
| L238 | N | W | "Integration tests for event → replan → snapshot → invalidation → notification." Four of the five stages now have one, over the real router: event (`test/layoverSessionEditReplan.test.ts:145#a departure delay becomes flight.departure_delayed`), replan, invalidation (`test/layoverSessionEditReplan.test.ts:200#a planned stop that stops fitting is named`) and notification (`test/layoverSessionEditReplan.test.ts:190#step 8 is strictly narrower` — step 8 declining). `W` and not `C` because the SNAPSHOT stage does not exist to test: `snapshotPersisted` is typed `false` and 2700 is unapplied. |

### 12.3 Rows opened, read, and deliberately NOT moved

| id | stays | why |
| --- | --- | --- |
| L99 | W | §11.1 step 8 now governs something real — it decides whether the traveller sees an alert at all, pinned by a mutation (`travel-buddy-standalone/src/components/layover/__tests__/LayoverFlightChangeCard.component.test.tsx:206#step 8 gates the alert`). **Considered `C` and rejected.** §11.2's `W` reason names the product's only NOTIFICATION — the client's fixed 30-minute OS reminder — and that reminder is still ungated by this rule. An in-app banner and a push are different channels, and closing half a reason is not closing it. |
| L206 | W | "Every material recomputation creates a deterministic snapshot and decision record." The decision record is now real, deterministic and durable. The snapshot is not, and the requirement says both. |
| L207 | W | The `DecisionRecord` shape. Nine of ten members carry real values and the tenth is `null` with a named reason (`services/airport/LayoverReplanService.ts:247#export interface LayoverDecisionRecord`). By this document's own standard — L84 required `TruthValue<T>`'s eight members with "none a placeholder" — a null member disqualifies. §9.5's phrasing ("a DecisionRecord in substance and not in name") is now backwards: it is one in name, and one member short in substance. |
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
   there (`travel-buddy-standalone/src/components/layover/__tests__/LayoverFlightChangeCard.component.test.tsx:145#a delay press PATCHes this session` and the refusal test beside it).

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
   | `liveConditionsFrom` → the sixth buffer term | no | no fact producer, so `liveExtra` is 0 for every real caller, and the pin at `test/layoverLiveConditions.test.ts:133#the five original terms` still holds |
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
   `routes/airport.ts:958-959#isSafetyEnabled`; three `return_deadline_set`
   citations moved from lines 1105-1112 to
   `routes/airport.ts:1582-1589#return_deadline_set`; `manual_city` moved from
   line 1341 to `routes/airport.ts:1925#manual_city` and `departure_time` from
   line 1345 to `routes/airport.ts:1929#departure_time`; `returnRoutePrimary`
   moved from line 284 to
   `travel-buddy-standalone/app/layover/[id].tsx:405#returnRoutePrimary`; two
   `returnToAirportNow` citations moved from line 608 to
   `travel-buddy-standalone/src/services/layover.ts:909#returnToAirportNow`,
   and `askCompass` from line 560 to
   `travel-buddy-standalone/src/services/layover.ts:861#askCompass`. That is
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
(`services/airport/LayoverRecommendationService.ts:494#const usableMinutes = certified.envelope.usableMinutes`),
and both thresholds with it — landside
(`services/airport/LayoverRecommendationService.ts:502#usableMinutes >= 90`) and
the city escape
(`services/airport/LayoverRecommendationService.ts:520#usableMinutes >= 180`),
including the "half-day" wording, which is a claim about time the traveller has
rather than about a stored column.

That threshold is not a new constant. `computeWindow` already calls a session
with under 90 usable minutes the `airport_only` TIER
(`services/airport/LayoverSafetyEngine.ts:1289#usableMinutes >= 90`), so before
this change the engine could tell a traveller "airport only" on the hero and
hand them a city on the cards below it. **The gate and the tier now cannot
disagree.** Measured on the test's own fixture: a three-hour international
connection with immigration and checked bags has 0 usable minutes and a
600-minute `layoverMinutes`, and it used to get landside cards.

**2. §9.1's safety-first comparator got a caller.** `rankActivities`
(`services/airport/LayoverSafetyEngine.ts:924#export function rankActivities`)
is the engine's own "safe first, then shortest travel" ordering. It had **no
caller outside `src/test/`**. It is now the primary sort for every generated
card (`services/airport/LayoverRecommendationService.ts:666#const ranked = rankActivities`),
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
(`services/airport/LayoverSafeReturnService.ts:114#export function safeReturnPosture`
— true at RETURN_NOW and CONNECTION_AT_RISK), has been on the wire since the
safe-return pass, is in the client's own `SafeReturnPosture` type, and was read
by **nothing**, while `returnRoutePrimary` — the field beside it in the same
object, set from the same boolean — was read. The dashboard now collapses the
three exploration surfaces (recommendations, map, people) into one notice
(`travel-buddy-standalone/app/layover/[id].tsx:419#explorationCollapsed === true`,
rendered at
`travel-buddy-standalone/app/layover/[id].tsx:523#layover-exploration-collapsed`).

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
(`travel-buddy-standalone/app/layover/[id].tsx:275#notificationPromptWouldAppear`),
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
| L141 | W | C | "At `CONNECTION_AT_RISK`: exploration surfaces collapse." §10's `W` reason, verbatim: *"`explorationCollapsed` is derived and published, and after this pass it is still read by nothing."* It is read now, and the three exploration surfaces are replaced by a notice — at RETURN_NOW as well as CONNECTION_AT_RISK, which is one rung stricter than the requirement and never looser. Red-first: keying the collapse off `returnRoutePrimary` instead — the field beside it, set from the same boolean — fails 4 (`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx:342#the collapse is keyed on explorationCollapsed`); forcing the derivation to `false` fails 3; wiring "Show them anyway" to a no-op fails 1. |
| L165 | W | C | "**Notifications** — explain that they are needed to warn when the safe return window changes." The body's `W` reason, verbatim: *"No explanation precedes the OS prompt — there is no rationale sheet or copy anywhere in the layover flow."* There is one, it names the specific risk the permission covers rather than asking for "alerts", and it appears only when a prompt would (`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx:383#a traveller whose phone is about to ask is told why first`). Red-first: removing the sheet fails 3; showing it unconditionally fails 1 (`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx:414#a traveller who already granted permission`). |
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
`routes/airport.ts:2636#rent_buddy_enabled`, read and verified here. That is far
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
   `test/layoverRecommendationGate.test.ts:252#the RATING key decides` is the
   first assertion that can fail on it. The weak case was NOT patched with a
   second aligned assertion; it carries a note saying what it does not pin.

4. **ONE GUARD IN THIS PASS IS CORRECT BY CONSTRUCTION AND PINNED BY NOTHING AT
   SERVICE LEVEL.** Dropping `certified.deadline` from the `rankActivities`
   call leaves the service suite 9/9 green, because `computeReturnDeadline` is
   pure in (airport, session, live) and does not read the clock — so a second
   derivation with no live conditions returns the identical instant. The
   parameter becomes load-bearing the day L81's producer lands and not before.
   The pin is written at the engine, where the difference is reachable
   (`test/layoverRecommendationGate.test.ts:281#rankActivities rates against the deadline it is HANDED`),
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
| the route writing the traveller's own text, before the event that reports on it | `artifacts/api-server/src/routes/airport.ts:1675#const sent = await postPlainThreadMessage(sc, {` |
| the screen navigating on `posted`, and saying something true when it is false | `travel-buddy-standalone/app/layover/[id].tsx:298#} else if (res.posted && overview.session.tripId) {` |

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
  `artifacts/api-server/src/lib/telegraphEvents.ts:122#/** Event-specific data. Never include message bodies or other PII. */`).
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


---

## §15 — three of §13.1's BRANCH rows, taken as builds rather than as a re-count

§13's ceiling named four live behaviour defects and §14 closed one of them
(L271). This pass takes **two more of the three that were left** — L47 and L123
— and, because closing L123 honestly required the refactor §13.4 declined, it
also closes **L42**, which §13.4 had opened, considered, and rejected in those
exact terms. The third defect, L293, was opened and is **not** closed; §15.5
says why in numbers rather than in a sentence.

Paths relative to the repository root. Same denominator (296), same counting
rule (§1), same prohibition rule, same buckets. **Nothing here is merged,
nothing is deployed, no flag is flipped, no migration is applied and no
migration is written.**

### 15.1 L47 — a leg nobody stated is not a zero-minute leg

**The row's own last statement** (§9.5, which is what `check:census-integrity`
reads): *"`computePlanFit` still sums `(durationMin ?? 0) + (travelMin ?? 0)`."*
The body row it revises adds the consequence: *"a stop with no travel time
reports `fitsWindow: true`."*

**WHY THE UNKNOWN EXISTS AT ALL, which is the part the row does not say.**
`layover_plan_stops.travel_min` is `INTEGER NOT NULL DEFAULT 0`
(`artifacts/api-server/src/migrations/0127_layover_system.sql:161#travel_min`).
The column cannot hold "nobody said". An unmeasured journey is therefore stored
as the number zero, and three separate writers put it there: the create schema
carried `.default(0)`, `from-recommendation` wrote `travel_time_min ?? 0`, and
the plan form offered the value in one tap — a travel chip labelled **none**.
Zero minutes to a place OUTSIDE the airport is not a travel time; it is the
absence of one. `computePlanFit` then charged it zero **twice**, because the ride
back is approximated from that same leg, and told the traveller their plan fits
a window it had never been measured against.

**The rule, in one module.** The classification and the totals now live in
`artifacts/api-server/src/services/airport/LayoverPlanFit.ts:38#statedTravelMin`:
airside zero is a FACT (no landside leg, by construction — the same distinction
`TRAVEL_TIME_SOURCES` draws between `inside_airport` and `category_default`),
landside zero is an ABSENCE. Omitting an unstated leg makes the total strictly
smaller than the journey will be, so `neededMin` is a **lower bound**, and a
lower bound can REFUSE but never CERTIFY. The verdict is therefore three-valued
(`artifacts/api-server/src/services/airport/LayoverPlanFit.ts:111#planFitVerdict`)
— `over` (certain), `unknown` (may fit, nobody measured it), `fits` — and
`fitsWindow` is true only for the third
(`artifacts/api-server/src/routes/airport.ts:1771#computePlanFit`).

**The write boundary stops laundering.** `landsideTravelRefusal`
(`artifacts/api-server/src/routes/airport.ts:2245#landsideTravelRefusal`) is
applied on all three writers — `POST /stops`, `POST /stops/from-recommendation`
and `PATCH /stops/:stopId`, the last against the **merged** row, because
`insideAirport: false` on its own turns a lawful airside 0 into an unstated
landside one. `stopRowToJson`'s `duration_min ?? 30` is gone as well
(`artifacts/api-server/src/routes/airport.ts:1774#row.duration_min`): a row with
no duration was being handed a thirty-minute one.

**ONE RULE, NOT THREE.** `LayoverCrewService.branchNeededMinutes` carried a
hand-copy of this arithmetic with a comment saying *"if the two ever diverge the
crew number is the wrong one"*, and `LayoverCompassService`'s `simulatePlan`
carried a third. Both now call `planFitTotals`. The crew helper returns the
identical integer it did before — an unstated leg contributed 0 to the total
under both rules — so no crew assertion moved; what changed is that there is one
place to fix next time.

**The client tells the third answer.** `planFit.fitsWindow === false` rendered
*"Over by 0m — trim this stop"*, which is a different lie. The meter now has an
`unknown` state that says what is missing and does not claim a fit.

### 15.2 L123 — the airport is on the map, and it is where the return lives

**The row's two halves, both false at `7cac6e2b4`.**

*Always visible.* The whole card `return null`-ed when the airport had no
coordinates or coordinates of exactly `(0,0)` — which is what
`buildFallbackProfile` writes for every airport missing from `airport_profiles`
(`artifacts/api-server/src/services/airport/AirportProfileService.ts:402#opts.lat`).
There is no MAP without coordinates, but the airport ELEMENT does not need one,
so the card always renders it and puts an explanation where the map would be
(`travel-buddy-standalone/src/components/layover/LayoverMapCard.tsx:300#layover-map-no-coordinates`,
`travel-buddy-standalone/src/components/layover/LayoverMapCard.tsx:314#layover-map-airport`).
That is §2.1's "degrade visibly" instead of a blank.

*Return CTA anchor.* Tapping the airport opened `PlaceDetailSheet` — the sheet a
café gets, offering "add to plan" for the airport the traveller has to get back
to. The airport tap is now routed away from it
(`travel-buddy-standalone/src/components/layover/LayoverMapCard.tsx:216#airportPlaceId`)
into an airport sheet carrying the certified deadline, the minutes left and the
one-tap return.

**The refactor §13.4 named as the price, paid.** §13.4 rejected L42 with:
*"Closing this honestly means lifting the abort handler into the screen."* The
abort is lifted
(`travel-buddy-standalone/src/components/layover/useSafeReturnAbort.ts:47#useSafeReturnAbort`,
created once per screen at
`travel-buddy-standalone/app/layover/[id].tsx:155#useSafeReturnAbort`). There is
still exactly one `POST /return-now` on the surface, one double-press ref guard,
and one place the RETURN CONTRACT is rendered — `LayoverSafeReturnCard` — which
is precisely what §13.4 said a second control must not cost.

### 15.3 L42 — the primary CTA switches, keyed on the certified posture

The footer read *Remind me / Ask locals / End* in every posture. At RETURN_NOW a
reminder is a promise about a future that has arrived. The primary slot now
becomes **Return to airport**
(`travel-buddy-standalone/app/layover/[id].tsx:612#layover-footer-return-now`),
keyed on the server's `returnRoutePrimary` — the same certified boolean that
hoists the abort card, so the footer and the layout cannot disagree and nothing
re-derives a return state from a clock. It fires the lifted controller, so the
contract still lands in the hoisted card above it.

`returnRoutePrimary` is `RETURN_NOW || CONNECTION_AT_RISK`
(`artifacts/api-server/src/services/airport/LayoverSafeReturnService.ts:116#escalated`),
which is one rung STRICTER than the requirement's `RETURN_SOON → RETURN_NOW`
transition and never looser — the same argument §13 used for L141.

### 15.4 Row moves

Three rows move, **all `W → C`, none vacuous.** Every one is a defect a
traveller experiences, on a path the app mounts.

| id | was | now | why |
| --- | --- | --- | --- |
| L47 | W | C | §6.1's `expected_airport_return_at <= hard_return_by`, at plan level. The row's last statement, verbatim — *"`computePlanFit` still sums `(durationMin ?? 0) + (travelMin ?? 0)`"* — is false at this commit: an unstated leg is excluded from the total and the total is labelled a lower bound, so a plan containing one can be refused (`over`) but never certified (`fits`). The three writers that turned the unknown into a stored zero refuse it instead. Red-first: 17 cases, **13 failed before the fix**. Mutations: restoring the `?? 0` fails 3 (`artifacts/api-server/src/test/layoverPlanFitUnknownLegs.test.ts:172#A1`); certifying on a lower bound fails 3; opening the write boundary fails 5 (`artifacts/api-server/src/test/layoverPlanFitUnknownLegs.test.ts:272#B1`); and the over-refusal guard — airside 0 must stay a fact — fails 2 (`artifacts/api-server/src/test/layoverPlanFitUnknownLegs.test.ts:188#A2`). |
| L123 | W | C | "Map element **Airport** — always visible; return CTA anchor." Both halves of the row's stated divergence are closed: the card no longer returns `null` for a `buildFallbackProfile` airport, and the airport tap no longer opens the generic `PlaceDetailSheet`. Red-first is unusually literal here — **this row's own test file asserted the defect and passed**; see §15.5. Mutations: restoring `if (!hasAirportCoords) return null` fails 7 (`travel-buddy-standalone/src/components/layover/__tests__/LayoverMapCard.placeTap.component.test.tsx:230#buildFallbackProfile`); routing the airport tap back to `PlaceDetailSheet` fails 1 (`travel-buddy-standalone/src/components/layover/__tests__/LayoverMapCard.placeTap.component.test.tsx:167#AIRPORT`); mounting the card with no return facts fails 1 (`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx:517#L123`). |
| L42 | W | C | "`RETURN_SOON → RETURN_NOW` … side effect = switch primary CTA to *Return to Airport*." §13.4's `W` reason, verbatim: *"The sticky footer still reads Remind me / Ask locals / End in every posture … Closing this honestly means lifting the abort handler into the screen."* It is lifted and the footer switches. Scored `C` on the same precedent §13 used for L141: the effect is keyed on the server's certified posture, is one rung stricter than the requirement and never looser. Red-first: `travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx:460#RETURN_NOW`. Mutations: removing the switch fails 3; removing the shared double-press guard fails 3 (`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.safeReturn.component.test.tsx:490#L42`). |

### 15.5 Rows opened, read, and deliberately NOT moved

| id | stays | why |
| --- | --- | --- |
| L293 | W | **The one live defect of §13.1's group (b) still standing, opened and left, with the arithmetic of why.** The row names THREE substitutions and all three are still there: `estimateTravelTime` returning 15/25 without reading a coordinate, `estimateActivityTime` substituting 30/60/90, and `GET /:id/safety`'s fictitious `travelTimeMin: 20 / activityTimeMin: 30` probe. Removing only the probe closes none of the row — App C1 is about substitution, and two of the three would remain. Removing all three is #463's design: `ActivityCandidate.travelTimeMin` becomes `number \| null` and `assess` fails closed on it, which reaches `LayoverSafetyEngine`, `LayoverRecommendationService`, `LayoverFeasibility`, four routes and **668 currently-green layover assertions**. That is a build, not a fix, and doing half of it behind a verdict move is how a census earns a correction header. It is the next hour's work and it is stated as such rather than attempted at the end of this one. |
| L9 | W | Improved and not closed, for the same reason. Its `W` sentence names BOTH the undisclosed airport maturity AND `estimateTravelTime`'s fabrication; the second is L293's and unmoved. |
| L115 | W | "Map consumes the active snapshot and envelope geometry." The map card now consumes the certified RETURN POSTURE, which is not the snapshot and not geometry. There is still no envelope geometry to consume (L66, L67, L121) and the non-recalculation half was never the gap. A posture is not a polygon. |
| L117, L119, L122 | N | Untouched. Pins still carry no feasibility state, no route is drawn, and nothing about this pass changes either — the airport element became a CTA anchor, which is a different requirement from the three below it in the same table. |
| L120 | W | "When `RETURN_NOW` is active, suppress exploration-first affordances and prioritise airport route/gate." **Closer than §13.4 left it and still not closed.** The suppression half is L141's collapse and the CTA half is now L42's switch, so the "prioritise" half has an affordance for the first time. The stated blocker is unchanged: there is no airport ROUTE (`ReturnContract.route` is typed `null`) and no GATE or terminal context (`terminal_info` is null on all 3,206 production airports, L143). A CTA that fires an abort is not a route to a gate. |
| L41 | W | "RETURN_SOON: high-priority notification, de-emphasise discovery." Unchanged and for §13.4's reason. The de-emphasis half is L141's; the NOTIFICATION half is still the client's fixed 30-minute reminder, and nothing fires at RETURN_SOON. This pass moved the reminder's CONTROL out of the footer at RETURN_NOW, which is a different rung and does not touch the claim. |
| L146 | C | Re-read because this pass moved the control it is `C` for. The abort still exists, is still mounted, and still renders the return contract; what moved is where its state lives. The double-press ref guard L146's evidence names moved WITH it and is pinned by a case that fails when it is removed. |
| L182, L183, L260, L269 | W | Untouched. A plan-fit verdict that refuses to certify an unmeasured plan is not an executable experience contract, not envelope geometry and not a certified action universe. |
| L1, L5, L6, L191, L197, L206, L207, L238, L240, L263 | W | §13.1 group (c). Gated on 2700 or 2860. No code change moves them; none was attempted. |
| L102–L113 | W | Twelve rows behind one flag decision this lane does not own. `simulatePlan` was edited — it now shares `planFitTotals` — and it is still **declared, not passed to the model**, so its row does not move and the edit is recorded here rather than in a row. |

### 15.6 Evidence corrected, no verdict moved

| id | the sentence that is false | what is true at this commit |
| --- | --- | --- |
| L100 | *"It asks no clarifying question, compares no plans, and invokes no tool."* | **The first of the three is false.** `nextClarifyingQuestion` is computed, published on the answer and rendered by the mounted card (`artifacts/api-server/src/services/airport/LayoverCompassService.ts:264#clarifyingQuestion`, `travel-buddy-standalone/src/components/layover/LayoverCompassCard.tsx:118#answer.clarifyingQuestion`) — census-compass scored the same code `C` as CL-06 and this census did not notice. The verdict does not move: it still compares no plans and still invokes no tool, and the tool half is the flag decision behind L102–L113. |
| L123 | — | **A test asserted the defect and passed.** `LayoverMapCard.placeTap.component.test.tsx` carried a case titled *"passes the airport pin place to PlaceDetailSheet when the airport is tapped"* — the requirement's own words for what an airport element must NOT do. It is rewritten rather than deleted, and the file's header now records that it used to pass. The first half of L123 had no test at all: an entire class of airports rendered no card and nothing noticed. |

### 15.7 The ceiling

1. **L293 IS STILL LIVE AND IT IS NOW THE ONLY ONE OF §13'S FOUR THAT IS.**
   Three of four are closed (L271 in §14, L47 and L123 here). The fourth is the
   largest of the four and §15.5 gives its size. A reader deciding where the
   next hour goes should start there.

2. **THE PLAN-FIT CHANGE MAKES THE PRODUCT CLAIM LESS, ON A LIVE PATH.** A
   landside stop whose travel time nobody stated used to produce a green meter
   and "fits with room"; it now produces a grey one and a sentence saying the
   journey has not been measured. That is the correct answer and it is still a
   reduction a reviewer should see coming. It is deliberately not behind a flag,
   for §13.6's reason: a verdict that is wrong behind a flag is still wrong.

3. **THE WRITE BOUNDARY NOW REFUSES A REQUEST IT USED TO ACCEPT.** `POST /stops`
   with `insideAirport: false` and no `travelMin` answers 400 where it answered
   200. The plan form's own **none** chip is removed with it, so the shipped
   client cannot produce that request — but any other caller holding the old
   contract will start failing, and with 0 `layover_plan_stops` rows ever
   written in production, nobody is holding a plan this changes.

4. **THE ABORT MOVED, AND THAT IS THE RISKIEST EDIT IN THIS PASS.** It is the
   one safety-critical control on the surface. What protects it: the card's own
   suite still drives the REAL service through a real `fetch` spy — it was
   rewritten to call `useSafeReturnAbort` rather than to stub it — and the
   double-press guard is pinned by a case that presses BOTH controls inside one
   in-flight abort and asserts exactly one POST. Remove the ref and three
   assertions fail.

5. **THE CLIENT HALF IS STILL TESTED IN A WORKSPACE THIS REPOSITORY'S
   `pnpm-workspace.yaml` DOES NOT INCLUDE.** Unchanged from §13.6 item 5, and
   now with 12 more assertions resting on it. Run by hand:
   `npx jest --testPathPattern='layover.*component|Layover.*component'`,
   **6 suites / 51 tests green** (was 6 / 39).

6. **A DIVERGENCE FOUND AND NOT FIXED.** `LayoverCompassService.simulatePlan`
   now shares this arithmetic, but the Compass tool set is not passed to the
   model, so the sharing is currently unobservable. It was done anyway because
   the alternative was leaving a second opinion about the same plan in the tree;
   it moves no row and is recorded here so nobody scores it as reachability.

7. **NO `C` ROW WAS FOUND FALSE, AND THE SEARCH WAS AGAIN A SAMPLE.** L146 and
   L141 were re-read against the tree because this pass moved code they depend
   on, and both hold. §13.6 item 7's complaint stands: 38 `C` rows have still
   never been re-read by anyone.

8. **CITATIONS.** Every citation this section writes is ANCHORED, with a
   whitespace-free token on the FIRST line of every cited range, and the section
   adds **zero** unanchored ones — measured, not assumed, by running
   `check:doc-citations` with §15 removed and again with it present: 6443 both
   times.
   **This pass moved lines in eleven counted files** — `routes/airport.ts`,
   `LayoverCompassService.ts`, `LayoverCrewService.ts`,
   `travel-buddy-standalone/app/layover/[id].tsx`, `LayoverMapCard.tsx`,
   `LayoverPlanSection.tsx`, `LayoverSafeReturnCard.tsx`,
   `travel-buddy-standalone/src/services/layover.ts` and three client test files
   — and **29 displaced anchored citations (43 occurrences) were repointed by
   EXACT ORIGINAL LINE TEXT**, never by offset and never by nearest candidate:
   for each, the cited line was read out of `git show HEAD:<path>` and located
   by string EQUALITY in the working tree, with a unique match required — the
   repoint was refused rather than guessed when either check failed. Two of the
   twenty-nine are in **census-compass.md** — that file's two anchors into
   `LayoverCompassService`, displaced by this lane's one added import line —
   repaired here rather than left for the Compass lane to discover.
   `check:doc-citations` reports **zero broken anchors in census-layover.md**
   afterwards, and `RESULT clean` for the tree. The unanchored citations §12.4
   published offsets for are still not shifted, for §12.4's own two reasons.

9. **FRESHNESS, AND THE ONE THING THIS PASS CANNOT DO HONESTLY.** It changes
   counted files and **cannot commit**, so `head_commit` cannot be re-declared
   at a hash that names this work. An entry in
   `CENSUS_STALENESS_ACKNOWLEDGED.json` names all **twelve** changed counted
   files and says which are which: eleven are this pass's own — the files whose
   row moves §15.4 states and re-measures — and the twelfth is another lane's
   (`compass/CompassTools.ts`, argued file-by-file with two greps that return
   0). The entry does NOT claim the eleven cannot have moved a verdict; it
   claims the opposite and points at the section that states the moves. **It is
   spent the moment this pass is committed**: whoever commits it must
   re-declare `head_commit` at the resulting hash and retire the
   acknowledgement, and the checker enforces the pairing by failing when the
   two disagree.

   **`check:census-scope-coverage` was ALREADY failing for this census before
   this pass** — 87 cited / 82 watched, 94 %, against a 96 % floor — and it is
   fixed here rather than inherited: the new plan-fit test joined
   `CENSUS_SCOPE`, and `scripts/check-doc-citations.mjs` joined the global
   `NOT_GRADED` machinery list, which it already qualified for in spirit and
   missed in letter (it lives in `scripts/`, not `src/scripts/`, and ends
   `.mjs`, so the pattern did not reach it). No floor was lowered; removing
   machinery from a denominator can only raise a ratio.

10. **Owner decisions.** This pass surfaces no new ones and resolves none.
    Decisions 9, 10 and 11 from §11.3 are open and untouched. The two non-owner
    blockers §13.6 named are unchanged: the twelve Compass tools are still not
    passed to the model, and `layover_stable_recommendation_ids_enabled` is
    still FALSE, which is why "Add to plan" still does not render for a
    production traveller.

### 15.8 Recomputed headline

Same 296 denominator, same counting rule, same prohibition rule. Recomputed by
`pnpm -s check:census-integrity` from the tables themselves, last-verdict-wins,
with the PR-comparison rows skipped. This supersedes the §14 headline.

| Measure | At `7cac6e2b4` (§14) | Now |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 52 | **55** |
| BUILT-BUT-WRONG | 134 | **131** |
| NOT-BUILT | 110 | **110** |
| CANNOT-VERIFY | 0 | **0** |
| Sum | 296 | **296** |
| CONSTRUCTED% | 62.8 % | **62.8 %** (186/296) |
| CORRECT% raw | 17.6 % | **18.6 %** (55/296) |

> **CONSTRUCTED% does not move, and that is the correct shape** for the third
> pass running: nothing was constructed that was not constructed before; three
> things that were already built started being true. The gap between
> CONSTRUCTED and CORRECT closes from 45.3 points to **44.2**.
>
> **The honest reading.** Three rows is 2.2 % of the 134, the same fraction §13
> got and three times §14's. What is different is where they came from: all
> three are group (b) BEHAVIOUR rows — defects a traveller hits — and two of
> them are §13's own named four. §13.1's arithmetic still holds and still
> bounds what is left: of the 131 remaining `W`, **19 cannot be moved by any
> code change under these rules** and **66 need a build rather than a fix**.

---

## §16 — L293: three fabricated numbers, deleted rather than labelled

**APPEND-ONLY. Nothing above this line is edited.** The body rows this section
moves are restated here, which is this document's convention: the last
statement about a row wins, and `check:census-integrity` counts it that way.

L293 has been opened three times — §13.1 named it, §13.4 left it, §15.5 left it
again with the arithmetic of why — and each time the reason was the same: the
row names THREE substitutions and removing one closes none of it, because App
C1 is about substitution and two would remain. §15.5 put the cost at "the safety
engine, the recommendation service, `LayoverFeasibility`, four routes and **668
currently-green layover assertions**", and called it a build rather than a fix.

It is built here. **The number of existing assertions is an effort estimate, not
a reason to leave a defect unresolved**, and the count turned out to be the
wrong worry. The layover surface is **702 cases green** across its 32 test files after
the change; **seven** existing assertions had to change, and **five of them were
asserting the defect**. §16.5 names each one and says which is which.

### 16.1 What the defect actually was, and why provenance was not the fix

The three substitutions, verified present at `eb70ab3b2` before anything was
changed:

| # | the substitution | what it substituted for |
| --- | --- | --- |
| a | `estimateTravelTime(placeType)` — 15 min for a cafe, restaurant or shop, 25 for everything else | how long it takes to get there. `fetchDiscoveryPlaces` did not even SELECT `lat`/`lng`. |
| b | `estimateActivityTime(placeType)` — 30 / 90 / 60 by category | how long you would spend there. `discovery_places` **has no duration column at all**. |
| c | `GET /:id/safety`'s probe — `travelTimeMin: 20, activityTimeMin: 30` | a journey. There is no place; the two numbers were identical for every session at every airport. |

All three already carried `travelTimeSource: "category_default"`, which is why
§7 (T3) recorded L9/L65 as *"the category constant is disclosed, not replaced"*.
**Provenance was never the gap.** A label on an invented number does not stop
the number being doubled into a round trip by `assess`, compared against the
certified usable window, and turned into the word `"safe"` — the sentence a
traveller acts on by walking out of an airport. The rating was the PRODUCT of
the fabrication, not a neighbour of it. §7's own disclosure sentence has been
corrected with this pass for the same reason: it said the travel times *"are
category estimates"*, which was true then and is now false in the traveller's
favour, because there are no estimates at all.

### 16.2 The shape is L47's, and the module is L47's

`eb70ab3b2` closed L47 by drawing one distinction in one place
(`services/airport/LayoverPlanFit.ts`): an **airside 0 is a FACT**, a
**landside 0 is an ABSENCE**, `neededMin` is a **LOWER BOUND** when anything is
unstated, and the verdict is **three-valued** — `over` (certain refusal),
`unknown` (may fit, unmeasured), `fits`.

`layover_recommendations.travel_time_min` is `INTEGER NOT NULL DEFAULT 0`
(migration 0127) — the identical column shape as `layover_plan_stops.travel_min`,
and the identical inability to say "nobody measured this". So L293 is closed
with L47's module rather than a second copy of its rule: `statedTravelMin` and
`statedDurationMin` are imported by `LayoverSafetyEngine`,
`LayoverRecommendationService` and `LayoverFeasibility`. **No migration was
needed**: an absence is written as the 0 the column can hold and read back
through the same classifier, so it survives the round trip instead of becoming
a measurement. A nullable column would have broken the write on every database
that had not run it — the hazard 2410 gates behind a flag.

The one place the analogy is imperfect is the verdict. `SafetyRating` is
CHECK-constrained to four values by `0127:118-120`, so there is no `unknown`
rung to add without a migration. The refusal is therefore `not_recommended`,
**and the warning carries the real cause** — `UNMEASURED_TRAVEL_WARNING`, which
says the journey has not been measured rather than claiming an arithmetic
shortfall the engine never computed. That is stated here as a limitation, not
hidden: a fifth rating would be the better shape and it costs a migration this
pass did not take.

### 16.3 The routed seam is asked, not assumed

`domain/trips/contracts/TravelTimeProvider.ts` already existed, with the
argument already written down: *"There is deliberately no variant that means 'no
travel time, treat as none': an absent route rendered as zero minutes makes
every schedule feasible."* Its only routed implementation is `noRoutedProvider`,
id `"none-configured"`.

`services/airport/LayoverTravelTime.ts` (NEW) is the layover adapter. Every
landside candidate's leg is now **asked of the port**, with the airport's and
the place's real coordinates — `lat`/`lng` joined the `discovery_places` SELECT,
because a producer that never asks for the position can never have a travel
time. On this deployment the answer is `NO_ROUTED_PROVIDER`, so the leg is
`null` and the provenance is the new fourth `TravelTimeSource`, `unmeasured`.
**The absence is produced by asking rather than asserted by a comment**, and the
day a routed provider is configured the same call yields a figure.

Two refusals are deliberate and documented in that file. A **non-routed**
provider's estimate is refused even though `straightLineTravelTimeProvider`
would happily answer: a great-circle distance is a lower bound, which makes it
evidence of INFEASIBILITY and nothing else, and a card's `travelTimeMin` is
shown to a traveller and doubled into a return trip. And the provider is a
**module constant, not an environment lookup**, because wiring a real one also
obliges its author to add a provenance column to `layover_recommendations`
first — the obligation `travelTimeSourceFor` has recorded since §7 and that this
pass has NOT discharged.

### 16.4 What changed, and where

| file | what |
| --- | --- |
| `artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts` | `ActivityCandidate.travelTimeMin` / `activityTimeMin` become `number \| null`; `assess` fails closed on an unstated term; `SafetyAssessment` gains `statedTravelMin`, `statedActivityMin`, `requiredMinutesIsLowerBound`; `assessWindowOnly` is added; `persistedTravelTimeSource` is added; `TRAVEL_TIME_SOURCES` gains `unmeasured`; `rankActivities` stops comparing `null`. |
| `artifacts/api-server/src/services/airport/LayoverRecommendationService.ts` | `estimateTravelTime` and `estimateActivityTime` **deleted**; the leg is asked of the port; the city-escape card's literal 30 deleted; the write stores an absence as 0 and both read paths classify it back. |
| `artifacts/api-server/src/services/airport/LayoverTravelTime.ts` | **NEW.** The port adapter, `airportPoint`/`placePoint`, `landsideLeg`. |
| `artifacts/api-server/src/services/airport/LayoverFeasibility.ts` | `LandsideProbe`'s terms become nullable; `outboundTravelEstimate` returns `null` for an unstated leg; the record gains `windowOnly`. |
| `artifacts/api-server/src/services/airport/LayoverPrivacyGuard.ts` | the client shape becomes nullable; `sanitizeRecommendation`'s default provenance comes from the row's facts. |
| `artifacts/api-server/src/routes/airport.ts` | the fictitious probe **deleted**; `GET /:id/safety` publishes `record.windowOnly` and `travelTimeSource: "unmeasured"`. |
| `artifacts/api-server/src/lib/layoverLiveIntersection.ts` | the ETA and dwell widen to `number \| null`; a live queue cannot lengthen a duration nobody stated. |
| `travel-buddy-standalone/src/services/layover.ts`, `LayoverRecsSection.tsx`, `LayoverRecommendationScreen.tsx` | the null crosses to the client and the absence is rendered **in words**. A blank where "15m away" used to be reads as "no travel needed". |

### 16.5 Evidence

**RED FIRST.** `artifacts/api-server/src/test/layoverUnmeasuredJourney.test.ts`
(31 cases, 82 assertions) was written and run against the unfixed tree BEFORE
any production line changed: **22 of its first 29 cases failed**. The other two
cases were added later, to close the two mutations that stayed green — see
below — and each records why it exists.
The seven that passed were the negative controls that must not move — airside
cards keep their 0 and stay `safe`, a stated leg that overflows is still
refused for the arithmetic reason, `wantsToLeave: false` is still
`airport_only`, and a record with no probe already carried no landside
assessment. After the fix: **31 / 31**, and the whole layover surface is
**702 / 702**.

**MUTATIONS.** Fourteen, each applied to PRODUCTION code, run against the six
layover suites, reverted and `cmp`-verified byte-identical. Counts are failing
cases out of 159.

| # | mutation | result |
| --- | --- | --- |
| 1 | `estimateTravelTime` reinstated (15/25 by category) | **8 fail** |
| 2 | `estimateActivityTime` reinstated (30/90/60) | **5 fail** |
| 3 | the `/safety` 20/30 probe reinstated | **3 fail** |
| 4 | `assess` certifies on a lower bound (fail-closed branch removed) | **8 fail** |
| 5 | a landside 0 is a fact again (the L47 classifier bypassed) | **2 fail** |
| 6 | the persisted read path returns the stored landside 0 | **1 fail** |
| 7 | an absence's provenance reported as `category_default` | **1 fail** |
| 8 | unstated legs sort FIRST inside a rating | **GREEN → 1 fail** (see below) |
| 9 | `assessWindowOnly` rates against its own usable minutes, not the envelope's | **1 fail** |
| 10 | the port's absence turned back into a 20-minute number | **8 fail** |
| 11 | the city-escape card's literal 30-minute leg reinstated | **8 fail** |
| 12 | a live queue lengthens an absence into a duration | **2 fail** |
| 13 | `/safety` reports the old `category_default` provenance | **2 fail** |
| 14 | an unstated probe leg still yields a zero-minute estimate | **GREEN → 1 fail** (see below) |

**TWO MUTATIONS STAYED GREEN, AND BOTH ARE REPORTED RATHER THAN BURIED.**

- **8.** `rankActivities`' travel-time tiebreak treats an unmeasured leg as
  `+Infinity` so it sorts last. Mutating that to `-Infinity` — an absence read
  as the shortest journey of all — left the suite at **158/158**. The reason is
  that the cases reaching it all had DIFFERENT ratings, so the comparator's
  RATING key separated them before the travel key was consulted; the tiebreak
  was unpinned exactly as `artifacts/api-server/src/test/layoverRecommendationGate.test.ts:252#the RATING key decides` records the
  rating key once was. Closed with a case that forces a tie —
  `wantsToLeave: false` makes every landside candidate `airport_only` whatever
  its legs — with a positive control asserting the ratings DO tie, so the case
  cannot silently drift back to testing the rating key. Re-run: **1 fail**.
- **14.** `outboundTravelEstimate` returns `null` for an unstated probe leg
  rather than a zero-minute `STATIC_DEFAULT` placeholder. Mutating it to return
  the placeholder left the suite at **159/159**: `/safety` now passes no probe
  at all, and every probe in the two feasibility suites states both numbers, so
  nothing reached the branch. Closed by certifying with a probe that STATES its
  leg is unmeasured — which is what `LandsideProbe` survives for. Re-run:
  **1 fail**.

**SEVEN EXISTING ASSERTIONS CHANGED. FIVE WERE ASSERTING THE DEFECT**, and each
says so where it stands, in the form
`LayoverMapCard.placeTap.component.test.tsx` uses for L123.

| file | assertion | was it encoding the fabrication? |
| --- | --- | --- |
| `layoverTravelTimeProvenance.test.ts` | *"Both branches of `estimateTravelTime` are present (15 for cafe, 25 otherwise)"* — it REQUIRED both constants on the cards | **Yes, verbatim.** |
| `layoverTravelTimeProvenance.test.ts` | `travelTimeSource === "category_default"` for every landside card, at the service and at the route | **Yes** — it required the provenance to say a category constant had been used. |
| `layoverTravelTimeProvenance.test.ts` | *"the literal 20-minute leg is labelled `category_default`"* on `GET /:id/safety` | **Yes** — the title names the fabricated leg as a thing to be labelled. |
| `layoverRecommendationGate.test.ts` | the cafe is `safe` and leads the market | **Yes** — the cafe was `safe` only because 2·15 + 30 fitted a 105-minute window. |
| `layoverLiveIntersection.test.ts` | `activityTimeMin === 90` (×4, one of them as `90 + 90 = 180`) | **Yes** — 90 is `estimateActivityTime("attraction")`. |
| `layoverTravelTimeProvenance.test.ts` | *"the vocabulary is exactly the three declared kinds"* | **No.** It was asserting the SIZE of the vocabulary, which is a real thing to pin. The vocabulary moved; the assertion moved with it, to four. |
| `layoverFeasibilityInvariants.test.ts` | the L52 sweep ran `travel = 0..300` with `activityTimeMin ∈ {0, 30, 120}` | **No** — but its DOMAIN was wrong. `travel = 0` landside and `activityTimeMin = 0` are absences, not small numbers (`travel_min`'s own CHECK is `BETWEEN 0 AND 240`; `duration_min`'s is `BETWEEN 5 AND 720`). "A LONGER travel leg never improves the rating" presupposes a travel leg. The sweep now starts at a STATED leg and the property is asserted at FULL strength over it; the two absences are asserted separately, where the true claim about them is that they are refusals. |

No assertion was weakened or deleted to get green. The §11 friction arithmetic
and the §9.1 rating-key claim both lost their reachability through the real
producer — because the producer no longer states a number they could be
expressed in — and both are re-made on the functions, with a positive control
in each case saying what would otherwise have gone unpinned.

### 16.6 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| L293 | W | C | App C1 — *"never query a semantic substitute for a missing field and pretend it is the requested fact; unknown is preferable to fabricated certainty."* All three named substitutions are **deleted with no replacement**: `estimateTravelTime` and `estimateActivityTime` are gone from `LayoverRecommendationService.ts`, and `GET /:id/safety` builds no probe (`artifacts/api-server/src/routes/airport.ts:1026#const record = certifySessionFeasibility`). `ActivityCandidate.travelTimeMin` is `number \| null` and `assess` fails CLOSED on it — never `safe`, never `possible_but_risky` — with a warning naming the real cause (`artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts:699#export const UNMEASURED_TRAVEL_WARNING`). Inside the terminal, 0 stays a fact. Red-first: **22 of 29 cases failed** before the fix. Mutations: reinstating each of the three numbers fails 8, 5 and 3; removing the fail-closed branch fails 8; treating a landside 0 as a fact again fails 2 (`artifacts/api-server/src/test/layoverUnmeasuredJourney.test.ts:257#a LANDSIDE 0 is an ABSENCE`). |
| L9 | W | W | **Improved and still not closed, and the half that moved is L293's.** Its `W` sentence names two things: the airport's data maturity is invisible to the client, and *"freshness is fabricated: `estimateTravelTime(placeType)` returns 15 or 25 minutes without reading a coordinate … and that number becomes a `safe` rating."* **The second half is false at this commit** — there is no such function, no such number and no such rating. The first half is untouched: `publicAirport` still exposes only a `verified` boolean and a generic-buffer session is still indistinguishable from a curated one at the client. §7's T3 left this row `W` for exactly that reason and it stays `W` for exactly that reason. What this pass adds beyond §7 is that the disclosure is now TRUE rather than merely present: the `unknowns` sentence says the journey has not been measured, because it has not, instead of describing category estimates that no longer exist. |

### 16.7 Rows opened, read, and deliberately NOT moved

| id | stays | why |
| --- | --- | --- |
| L65 | W | "Feasibility formula terms." The travel term stops being a constant and starts being an honest absence, which is the direction the row asks for, but the row is about the FORMULA having real terms — and `unmeasured` is not a term, it is the admission that there is none. A routed provider is what moves this, and none is configured. |
| L4 | W | "Unknown critical facts fail closed." Unknown TRAVEL now fails closed, which is one more fact than before. The row is `W` at §9's recount because confidence exists and is computed while baggage is still unrepresentable (L35); neither half moves here. One more fail-closed fact is not the row. |
| L48, L34, L230 | N | The ENTRY gate. #463 pairs it with L293 and this pass took only the travel half; nothing here reads a passport, a corridor or `lookupRequirement`. `generateRecommendations`' own comment still records that three of §9.1's four gate terms exist and the entry term does not. |
| L199 | W | "Postconditions + authorization-contract coverage." `W (improved)` at §9: all five layover tables are contracted and the evaluator is proven non-vacuous; 0127 itself still carries no postconditions. This pass adds **no migration** — deliberately, see §16.2 — so it adds none either way. |
| L50 | N | "Block unsafe recommendations." Every landside card is now `not_recommended`, which is a RATING and not a block: the cards are still generated, still persisted and still served. Whether an unsafe band should be withheld from the traveller is the open product question the row names and this pass does not answer it. |
| L102–L113 | W | Unchanged and untouched. Still one flag decision this lane does not own. |
| L182, L183, L260, L269 | W | Unchanged. A producer that refuses to invent a journey is not an executable experience contract, not envelope geometry and not a certified action universe. |

### 16.8 What this does NOT close, stated with the cost

1. **There is still no routed travel time.** Every landside card now says so
   instead of inventing one, which is the whole of App C1 — but a traveller who
   wants to know whether they can reach the night market is told "not
   measured", and that is a worse ANSWER than "25 minutes" was a claim. The
   seam is wired and the provider slot is one line
   (`artifacts/api-server/src/services/airport/LayoverTravelTime.ts:83#export const LAYOVER_TRAVEL_TIME_PROVIDER`).
   Configuring one is an owner decision with a cost, and it is **blocked behind
   a schema change**: `layover_recommendations` has no provenance column, so a
   `measured` figure cannot be persisted without the read path silently
   relabelling it `category_default` on the next dashboard load. That is stated
   in the module and in `persistedTravelTimeSource`, and it is the next thing.
2. **`SafetyRating` has no `unknown` rung.** §16.2. The refusal is
   `not_recommended` with an honest warning; a fifth value is the better shape
   and costs a migration.
3. **A card with no measured journey cannot be added to a plan.** That is
   correct — it is L47's write boundary refusing to store a leg nobody stated —
   but combined with (1) it means the mini-itinerary is now effectively
   airside-only for landside ideas. The refusal message says why. It is a real
   product consequence of telling the truth and it is named here rather than
   discovered later.
4. **`ReplanCandidate` / `candidatesFromStops` still reads
   `Number(s.travelMin ?? 0)`.** Opened and left: it consumes `layover_plan_stops`,
   whose write boundary L47 already closed, so no unstated landside leg can
   reach it on a row written after `eb70ab3b2`. Legacy rows can. It is the same
   laundering in a third place and it is not L293's.

### 16.9 Freshness, citations and registration

1. **`check:doc-citations` — 53 anchors repointed, `RESULT clean`.** Every one
   was displaced by this pass's own edits (verified: each cited line resolves
   correctly in `git show HEAD:<path>`). Each was repointed by **exact original
   line text**, never by offset: the text at the cited line was read out of
   `git show HEAD:<path>` and located by string EQUALITY in the working tree
   with a UNIQUE match required. Six were range ENDs whose text is boilerplate
   (`  });` occurs 21 times in `routes/airport.ts`); those were resolved by
   matching the WHOLE cited block byte-for-byte and requiring a unique
   occurrence, and the repoint was refused rather than guessed where either
   check could fail. The ratchet constants in `scripts/check-doc-citations.mjs`
   were **not edited**; anchored/whole-anchor coverage rose to 2515 / 2337
   against floors of 2507 / 2329.
2. **`check:census-freshness` — 0 STALE.** This pass changes counted files and
   **cannot commit**, so `head_commit` cannot be re-declared at a hash that
   names this work. The existing `CENSUS_STALENESS_ACKNOWLEDGED.json` entry for
   this census — another lane's, covering one standalone test fixture — is
   EXTENDED rather than replaced, because `check:census-freshness` reads only
   the FIRST acknowledgement per census and a second entry would be silently
   ignored. Its half is untouched; the appended half names all fourteen files
   and does **not** claim they are harmless: it claims the opposite and points
   here. `census-compass.md` also counts `LayoverFeasibility.ts` and
   `LayoverPrivacyGuard.ts`; its entry is extended with a file-by-file argument
   that no COMPASS verdict can have moved (`sanitizeCompassAnswer` is
   byte-identical; `LayoverCompassService` reads `record.deadline` and
   `record.verdict` and neither moved). `census-sensing.md` already named
   `layoverLiveIntersection.ts`, `LayoverRecommendationService.ts` and
   `LayoverSafetyEngine.ts` in its own entry. **All three are spent the moment
   this pass is committed**: whoever commits must re-declare `head_commit` and
   retire them.
3. **`check:test-registration`.** `src/test/layoverUnmeasuredJourney.test.ts` is
   appended at the END of `artifacts/api-server/package.json`'s `test` script,
   append-ordered by lane. It also joins `CENSUS_SCOPE` for this census, for
   §15.9's reason: L293's move rests entirely on its assertions, and a census
   that cites a test as evidence while not watching it cannot notice the test
   changing under the verdict. The floor is not raised with it.

### 16.10 Recomputed headline

Same 296 denominator, same counting rule, same prohibition rule. Recomputed by
`pnpm -s check:census-integrity` from the tables themselves, last-verdict-wins,
with the PR-comparison rows skipped. This supersedes the §15 headline.

| Measure | At `eb70ab3b2` (§15) | Now |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 55 | **56** |
| BUILT-BUT-WRONG | 131 | **130** |
| NOT-BUILT | 110 | **110** |
| CANNOT-VERIFY | 0 | **0** |
| Sum | 296 | **296** |
| CONSTRUCTED% | 62.8 % | **62.8 %** (186/296) |
| CORRECT% raw | 18.6 % | **18.9 %** (56/296) |

> **THE "WAS" IN §16.6 WAS WRONG WHEN THIS SECTION WAS FIRST DRAFTED, AND
> `check:census-integrity` IS WHAT CAUGHT IT.** The body row at
> `docs/architecture/census-layover.md:894#C1. Never query a semantic substitute` scores L293 `N`, and this section was
> drafted from it — but §7's T-table had already moved the row `N → W` when the
> provenance was disclosed, and §13.1 and §15.5 both restated it `W`. Under
> last-verdict-wins the move is **`W → C`, not `N → C`**, so CONSTRUCTED% does
> NOT move: nothing was constructed that was not constructed before. Two other
> rows in §16.7 were restated at verdicts they did not hold (`L4` and `L199`,
> both `W`, written `N`) and are corrected the same way. The headline below is
> the tool's, restated from the rows rather than computed by hand — which is the
> rule this document has had since its own correction header, and this is the
> second time in three passes it has earned it.
>
> **The honest reading.** One row, for a build that touched eight production
> modules, four test files and three client files. That is the ratio App C1
> costs: the row is a single requirement that happened to be violated in three
> places, and closing it required all three plus the type change underneath
> them. The gap between CONSTRUCTED and CORRECT closes from 44.2 points to
> **43.9**. §13.1's arithmetic still bounds what is left: of the 130 remaining
> `W`, 19 cannot be moved by any code change under these rules and 66 need a
> build rather than a fix.

---

## §17 — the ladder made visible, and a stamp for a city nobody had been to

**APPEND-ONLY. Nothing above this line is edited**, except the `head_commit`
row of the RE-CENSUS HEADER (re-declared, with its previous value preserved
verbatim, as every pass since §11 has done) and forty-seven displaced citations
repointed by exact original line text (§17.10). The body rows this section moves
are restated here, which is this document's convention: the last statement about
a row wins, and `check:census-integrity` counts it that way.

**Every verdict below was derived at commit `a5c223a37`**, which is this
census's new `head_commit` and the commit that carries the four rows' code, the
three new server suites and the two new client suites. Same denominator (296),
same counting rule (§1), same prohibition rule, same buckets. **Nothing here is
merged, nothing is deployed, no flag is flipped and no migration is applied.**
Two migrations that §16.8 asked for are **not written either**, and §17.8 says
why in the terms the migration rule sets rather than in a shrug.

**The current verdict of every row named below was derived before the move was
drafted**, by parsing the whole document last-statement-wins with
`check:census-integrity`'s own parser — which is the discipline §16.10 had to
write a correction box about after drafting L293 as `N → C` when §7 had already
moved it to `W`. All four of this pass's rows are `W` in the body AND at their
last statement, so no verdict was in doubt — but **one of the four is last
stated somewhere else, and its reason has changed since the body wrote it**:
L9's last statement is §16.6's, not its §2.1 body row, and it names ONE
remaining half where the body named two. The move below is argued against
§16.6's half, not the body's pair. L250, L19 and L162 are last stated in their
own body rows.

### 17.1 L9 and L250 are one gap stated twice, and it is the word VISIBLY

`| L9 | Missing live intelligence degrades **visibly** to historical/conservative
fallback; never fabricate freshness |` (§2.1) and `| L250 | Do not imply
equivalent intelligence globally; "limited intelligence" is a valid product
state |` (§22) have been scored separately for five passes and name the same
missing thing in almost the same words.

**L9's last statement is §16.6's**, and it is precise about what is left:
*"The first half is untouched: `publicAirport` still exposes only a `verified`
boolean and a generic-buffer session is still indistinguishable from a curated
one at the client."* The other half — the fabricated travel time — §16 deleted.

**L250's last statement is its body row**: *"The honesty artifact exists and is
the best thing on this surface … But it is uniform: the airport's own data
maturity is never disclosed, so a curated airport and a generic-fallback one
present identical confidence."*

**THE LADDER WAS NEVER THE GAP AND HAS BEEN REAL SINCE THE FIRST CENSUS.** A
profile comes from an `airport_profiles` row, from `STATIC_AIRPORTS`, or from
`buildFallbackProfile`, and the buffers differ accordingly. The certified record
has carried that provenance PER TERM since §9 — `bufferEstimates` marks the four
airport-supplied terms `AIRPORT_PROFILE` at fallback level 2 when a row supplied
them and `STATIC_DEFAULT` at level 3 when a constant did — and `GET /overview`
has published the whole `estimates` object on the wire since then. **Nothing has
ever read it.** The client's `LayoverOverview` type did not carry the field,
there was no function anywhere that turned it into a sentence, and the only
thing a traveller could see was `airport.verified` — which separates the top
rung from the other two IN PRINCIPLE and separates nothing IN FACT, because
`staticToProfile` and `buildFallbackProfile` both set it FALSE and every one of
the 3,206 production rows is FALSE as well. One boolean over three provenances,
and in production it is the same boolean.

So the build is a disclosure, not a measurement:
`airportIntelligence()`
(`artifacts/api-server/src/services/airport/LayoverFeasibility.ts:780#export function airportIntelligence`)
derives four rungs
(`artifacts/api-server/src/services/airport/LayoverFeasibility.ts:717#export const AIRPORT_INTELLIGENCE_TIERS`)
from the record's own estimates and from `record.inputs.airport` — the named
input set that is inside `inputHash` — and **never from a second read of the
profile**, because a disclosure derived independently of the numbers it
describes can disagree with them, which is the duplicate-derivation defect this
module exists to prevent. `GET /:id/safety` and `GET /overview` publish it
(`artifacts/api-server/src/routes/airport.ts:1069#airportIntelligence: airportIntelligence(record)`),
`summarizeAirportIntelligence`
(`travel-buddy-standalone/src/components/layover/layoverReturnFacts.ts:285#export function summarizeAirportIntelligence`)
turns the rung into words, and `CanILeaveCard` renders them INSIDE the
always-visible unknowns box
(`travel-buddy-standalone/src/components/layover/CanILeaveCard.tsx:141#layover-airport-intelligence`)
rather than behind the "How we got these numbers" accordion. A disclosure a
reader has to open is a disclosure most readers never see, and the box L250's
own evidence calls *"never buried"* is where this belongs.

**FOUR TERMS, AND DELIBERATELY ONLY FOUR.**
`airportSuppliedTerms`
(`artifacts/api-server/src/services/airport/LayoverFeasibility.ts:776#function airportSuppliedTerms`)
folds the base buffer, the immigration extra, the bags extra and the traffic
extra. `timeOfDayExtra` and `exitDelay` are source CONSTANTS whatever the
airport row says — `bufferEstimates` marks them `STATIC_DEFAULT` explicitly —
so folding them in would collapse every airport on earth to GENERIC and destroy
the distinction the disclosure exists to draw. That is not an argument; it is a
mutation: including `timeOfDayExtra` fails 6 of 10 (§17.4, A4).

**THE WORDING CLAIMS ADDRESSABLE, NOT CURATED, AND THE SCHEMA IS WHY.**
`airport_profiles`' buffer columns are `NOT NULL DEFAULT 60/90/120/180/30/15/20`
(`artifacts/api-server/src/migrations/0127_layover_system.sql:28#domestic_buffer_min`),
so an uncurated row holds **exactly** the generic numbers — and production was
measured at 3,206 rows with 0 non-default buffers. The AIRPORT_RECORD rung
therefore says *"{IATA} has a record of its own, but nobody has verified it —
these minutes may simply be the defaults"*, which is what the tree can support.
Saying "configured for this airport" would have been the fabrication §2.1
forbids, in the sentence written to close a row about fabrication.

**A MEASUREMENT THAT CHANGED THE DESIGN, AND IS PINNED SO IT CANNOT BE
FORGOTTEN.** The obvious disclosure is the scalar the record already carries:
`confidence`. It distinguishes nothing. `worstConfidence` folds over every
estimate behind the verdict, and two of them — `exitDelay` and `timeOfDayExtra`
— are `STATIC_DEFAULT`/`LOW` at every airport by construction, so
`record.confidence` is `LOW` for a verified airport and `LOW` for a generic
fallback and will be until one of those two constants gets a producer. A
disclosure built on it would have closed L250 by publishing a number that cannot
move. The case that says so is
`artifacts/api-server/src/test/layoverAirportIntelligence.test.ts:237#canNOT tell the two apart`,
and it is there so that a later "simplification" to the scalar goes red.

### 17.2 L19 and L162 — the stamp fired when the form was filled in

`| L19 | **Passport / Memory** owns post-session durable artifacts **if the user
chooses** … |` (§3) and `| L162 | **Completed places/stamps** — durable only
when the user elects Passport/Memory behaviour |` (§17) are also one gap stated
twice, and both body rows say it plainly. L19: *"it fires at session
**creation**, not post-session, and the only gate is the `passport_stamps_enabled`
flag; the user never elects it."* L162: *"A stamp is written
automatically at session **creation** … before the traveller has completed
anything and without electing anything."*

**WHAT THAT MEANT IN PRACTICE, read rather than inferred.** `POST
/airport/sessions` ran a `void (async () => …)` block that minted a durable,
deduplicated `passport_stamps` row — public by default, per
`createStamp`'s visibility resolution — for the airport's city, at the moment a
traveller typed two flight times into a form. They had not been to the city. If
they stayed airside for eight hours the stamp stayed. If they cancelled the
layover a minute later the stamp stayed: nothing anywhere removes it. And
because the block was fire-and-forget, nobody — traveller or server — could be
told whether it had happened.

The seam is deleted there
(`artifacts/api-server/src/routes/airport.ts:685#NO PASSPORT SEAM HERE`)
and rebuilt on the close
(`artifacts/api-server/src/routes/airport.ts:2937#async function writeElectedLayoverStamp`)
behind **four terms, each pinned by its own negative case**:

| term | what fails without it |
| --- | --- |
| the session closed as **completed** | `artifacts/api-server/src/test/layoverCompletionStamp.test.ts:179#an ELECTED but CANCELLED session writes nothing` |
| the traveller **elected** it | `artifacts/api-server/src/test/layoverCompletionStamp.test.ts:169#a COMPLETED session the traveller did NOT elect` |
| `passport_stamps_enabled` is on | `artifacts/api-server/src/test/layoverCompletionStamp.test.ts:198#the kill switch still wins` |
| the layover **had actually begun** | `artifacts/api-server/src/test/layoverStampOccurrence.test.ts:133#a layover that has NOT BEGUN earns no stamp` |

The order is the argument: a kill switch a user's choice can override is not a
kill switch, so the flag is checked last of the three this pass wrote, and wins.

**THE FOURTH TERM WAS ADDED AT INTEGRATION AND THIS PASS DID NOT WRITE IT.**
Stated here rather than in the merge commit alone, because without it this
section would read as though moving the seam had been sufficient, and it was
not. Completion and election are things the CALLER says. `endSession`
(`artifacts/api-server/src/services/airport/LayoverSessionService.ts:279#export async function endSession`)
consults no clock — it sets `status` to whatever the caller named, gated only on
the row still being live — so at this pass's own tip a traveller could create a
layover for next Tuesday, close it as `completed`, elect the stamp, and be
handed a durable `verification_level: 'checkin'` row for a city they had never
been to. That is the same defect §17.5 says it closed, moved one route along.

**AND THIS SECTION'S OWN GREEN CASE WAS DEMONSTRATING IT.** `sessionRow()`
defaults `arrival_time` to `now + 5 minutes`, so *"a COMPLETED session the
traveller elected to keep writes exactly one stamp"* — which passed — asserted
that a layover which had not begun earns a stamp. The fixture is corrected to a
past arrival for the two cases that reach the city and occurrence terms, and the
new file above pins the fourth term with a CONTROL (a past arrival still earns
exactly one), a boundary case (`<= now`) and a case proving `not_elected` still
binds independently. Proven RED at this pass's tip `152b3b62e` — 3 passed, 1
failed, `expected: 0, actual: 1` — before the term existed.

The sibling Highlights & Memories lane had written the predicate this term uses
(`artifacts/api-server/src/services/memory/occurrenceGate.ts:80#export function declaredOccurrenceHasHappened`)
against the CREATION-time seam this pass deleted. Neither lane's fix was
sufficient alone; the merge composed them rather than choosing.

**IT IS AWAITED AND IT ANSWERS WITH A REASON.** "Nothing was written" has seven
meanings here — not elected, not completed, flag off, **not occurred**, no city,
the write failed, already stamped — and a client that has to guess which one applies will tell the
traveller the wrong thing. The old seam could not answer at all. `"no_city"` is
the one worth naming: the fallback profile's placeholder city is the literal
string `"Unknown"`, and a stamp for it would be exactly the fabricated artifact
Appendix C1 forbids, in the row about electing artifacts.

**THE CLIENT SENDS BOTH ANSWERS FOR THE FIRST TIME.** `endLayoverSession(id)`
issued a bare `DELETE`
(`travel-buddy-standalone/src/services/layover.ts:984#export async function endLayoverSession`),
so **every** close was recorded `cancelled` — a traveller who came back and
boarded was recorded as having abandoned the layover — even though the route has
accepted `outcome: "completed"` since §7, `endSession` has taken a `reason`
argument since the service was written, and `layover_sessions.status`'s CHECK
has allowed the value since 0127. It had no caller. It has one now: the End control opens a sheet with
the two outcomes and an election that is **off until it is pressed**
(`travel-buddy-standalone/src/components/layover/LayoverEndSheet.tsx:40#const [keepStamp, setKeepStamp]`,
`travel-buddy-standalone/src/components/layover/LayoverEndSheet.tsx:55#layover-end-stamp-election`),
mounted at
`travel-buddy-standalone/app/layover/[id].tsx:676#<LayoverEndSheet`.

**ONE SHEET ON BOTH PLATFORMS, WHICH BREAKS THIS SCREEN'S OWN RULE AND SAYS SO.**
`app/layover/[id].tsx` kept `Alert.alert` on native because an OS alert is the
platform idiom for a CONFIRMATION. Ending a layover is no longer a confirmation:
it is a form with two independent answers, and `Alert.alert` can only carry it
as two chained dialogs — which presents "I made my flight" and "keep the stamp"
as one decision. The rule is for confirmations; this is not one.

### 17.3 §16.8 item 4 is closed, and it moves no row

§16.8 named it and left it, verbatim: *"**`ReplanCandidate` /
`candidatesFromStops` still reads `Number(s.travelMin ?? 0)`.** Opened and left:
it consumes `layover_plan_stops`, whose write boundary L47 already closed, so no
unstated landside leg can reach it on a row written after `eb70ab3b2`. Legacy
rows can. It is the same laundering in a third place and it is not L293's."*

`candidateFits` is §6.1's invariant evaluated per candidate. Handed a landside
stop whose leg nobody stated, it charged 0 to get there and 0 to get back —
the same double zero `computePlanFit` charged before L47 — and reported the stop
as FITTING the certified window. That answer reaches a traveller:
`feasibleCandidateIds` is what `candidatesGained`/`candidatesLost` are diffed
from, and `LayoverFlightChangeCard` renders those after a flight-time edit.

It now goes through L47's own classifier rather than a fourth copy of the rule
(`artifacts/api-server/src/services/airport/LayoverReplanService.ts:530#export function candidatesFromStops`),
`candidateFits` refuses to certify an unstated term
(`artifacts/api-server/src/services/airport/LayoverEventReplanner.ts:582#export function candidateIsUnmeasured`),
and the exclusion is **named** rather than folded into "does not fit"
(`artifacts/api-server/src/services/airport/LayoverEventReplanner.ts:599#unmeasuredCandidateIds: candidates.filter`)
— a plan nobody measured and a plan that overflows are different answers, which
is L47's own three-valued rule.

**NO ROW MOVES ON IT, AND THAT IS THE POINT.** What it removes is the
DATA-SHAPED argument L47's `C` was standing on. §16.8's defence was that no row
in the table can hold the value any more; that is a claim about which rows exist,
not about what the code does, and legacy rows exist. The refusal is now in the
code. The published `candidatesUnmeasured` is read by no screen — it is
transcribed into the client type and rendered nowhere — so it is named here as
unreached rather than scored as reachability.

### 17.4 Evidence — red first, then twenty-three mutations

**RED FIRST, every file, before any production line changed.**

| file | cases | failed against the unfixed tree |
| --- | ---: | --- |
| `artifacts/api-server/src/test/layoverAirportIntelligence.test.ts` | 10 | **all of them** — the module has no such export, so the file could not even load. It carried 9 cases at the red-first run; the tenth was added afterwards to close mutation A3 and would fail the same way |
| `artifacts/api-server/src/test/layoverCompletionStamp.test.ts` | 7 | **6**, including "creation mints no stamp" at `1 !== 0` |
| `artifacts/api-server/src/test/layoverReplanCandidateLegs.test.ts` | 9 | **5** — the other 4 are the negative controls (an airside 0 is a fact) |
| `travel-buddy-standalone/src/components/layover/__tests__/CanILeaveCard.component.test.tsx` | 6 | **5** — the sixth is the control that a card handed no disclosure renders none, which must pass both before and after |
| `travel-buddy-standalone/app/layover/__tests__/layoverDashboard.endSession.component.test.tsx` | 6 | **all of them** — `layover-end-open` does not exist on the unfixed screen |

**TWENTY-THREE MUTATIONS.** Each was applied to PRODUCTION code, measured,
reverted from a pristine copy and `cmp`-verified byte-identical (the harness
compares a SHA-256 of the file before and after and prints the result). Server
counts are failing cases out of the named suite; client counts are failing cases
out of 6. **The whole A series was re-measured against the TEN-case file** after
A3's closing case was added, so no row below is a count against a file that no
longer exists; only A4 moved (5 of 9 to 6 of 10). The **D pair is different in
kind and is labelled so rather than blended in**: it mutates GUARD CONFIGURATION
rather than production code, its result is a checker's exit status rather than a
count of failing cases, and it was run last — after the full 1141-file suite had
already found what §17.9 item 5 describes.

| # | mutation | result |
| --- | --- | --- |
| A1 | `tier` always `GENERIC` | **6 of 10 fail** |
| A2 | `airportVerified` hard-coded false | **3 fail** |
| A3 | the fallback-level fold takes the BEST rung instead of the worst | **GREEN → 1 fail** (see below) |
| A4 | `airportSuppliedTerms` includes `timeOfDayExtra` | **6 of 10 fail** |
| A5 | `liveObserved` hard-coded false | **1 fail** |
| A6 | `GET /overview` stops publishing the block | **2 fail** |
| A7 | `CanILeaveCard` ignores the disclosure it is handed | **5 of 6 fail** |
| A8 | every rung gets the GENERIC sentence | **3 of 6 fail** |
| A9 | the source-class fold takes the STRONGEST class | **5 fail** |
| B1 | the creation-time seam reinstated | **1 of 7 fail** |
| B2 | the `completed` term dropped | **1 fail** |
| B3 | the `elected` term dropped | **1 fail** |
| B4 | the `passport_stamps_enabled` check dropped | **1 fail** |
| B5 | a missing city stamped as `"Unknown"` | **1 fail** |
| B6 | the election read as always true at the route | **1 fail** |
| B7 | the sheet's election pre-ticked | **3 of 6 fail** |
| B8 | "I made my flight" sends `cancelled` | **2 of 6 fail** |
| B9 | "ending early" forwards the election | **1 of 6 fail** |
| C1 | `candidatesFromStops` back to `Number(… ?? 0)` | **2 of 77 fail** |
| C2 | `candidateFits` drops the unmeasured guard | **3 fail** |
| C3 | `actionUniverseOf` stops naming the unmeasured ids | **1 fail** |
| D1 | the stale `UNCHECKED_READS_ALLOWLIST` key put back | **`check:unchecked-supabase-reads` exits 1** |
| D2 | the allowlist path removed from `NOT_GRADED` | **GREEN → 96 % of a 96 % floor** (see below) |

**TWO MUTATIONS STAYED GREEN AND BOTH ARE REPORTED RATHER THAN BURIED.**

- **A3.** Turning `bufferFallbackLevel`'s worst-wins reduce into a best-wins one
  left the file at 10/10 — because `bufferEstimates` gives all four
  airport-supplied terms the SAME `rowClass` and `rowLevel`, so max and min are
  the same number on every record this tree can build and the direction of the
  fold is unobservable through the certifier. It is the same shape §13.6 item 4
  records for the `rankActivities` deadline parameter: correct by construction,
  pinned by nothing, and load-bearing the day one term gets a producer the
  others do not. Closed with a case that builds a record whose terms
  deliberately disagree
  (`artifacts/api-server/src/test/layoverAirportIntelligence.test.ts:260#a single weak term drags BOTH folds down`),
  which is the only place the difference is reachable today. Re-run: **1 fail**.
  A9 was then added for the source-class fold beside it and fails 5 without the
  new case's help.

- **D2.** Deleting the allowlist path from `NOT_GRADED` left
  `check:census-scope-coverage` PASSING, at 105 cited against 101 watched, 96 %
  against a floor of 96 % — passing on the floor itself rather than above it.
  So D2 is an entry NOTHING pins, and it is kept for a reason that is a
  judgement rather than a proof: it restores the ratio to the 104-against-101, 97 %
  this census had before it cited the ledger, instead of leaving the next lane
  one citation away from a red check. §17.9 item 5 states the same numbers.
  **D1 is the pair that did go red**, and it is the only reason any of this is
  here: putting the deleted key back makes `check:unchecked-supabase-reads` exit
  1 on a stale entry, which is how the defect was found in the first place.

**NO EXISTING ASSERTION WAS WEAKENED OR DELETED.** One existing case changed:
`src/test/layoverEventReplanner.test.ts`'s *"candidateFits is the certified
window, not a category guess"* computed `c.travelTimeMin * 2`, which stops
type-checking when the term becomes `number | null`. It now ASSERTS that all
three of its fixtures state both terms before doing the arithmetic — so a
fixture that drifted into the unmeasured branch would fail the case rather than
quietly change what it tests — and says where that branch is covered instead.
THREE CLIENT FIXTURES were updated, and the second and third were found by a
RATCHET rather than by reading: `travel-buddy-standalone`'s `typecheck:tests`
went from 176 diagnostics across 61 files to 178 across 63 the moment the two
new server fields landed, because `LayoverFlightChangeCard.component.test.tsx`'s
`publication()` no longer described a `ReplanOutcome` (no `candidatesUnmeasured`)
and `LayoverSafeReturnCard.component.test.tsx`'s `overviewFixture()` no longer
described a `LayoverOverview` (no `airportIntelligence`). That is the gate doing
exactly what its own error message says it is for — *"a fixture describing a
shape production never emits stops compiling"* — and it is recorded here
because that ratchet lives in a workspace this repository's `pnpm-workspace.yaml`
does not include and has gone red for exactly that reason before. Both fixtures
gained the missing field with a comment saying what it is; no assertion in either
file changed. The third is `layoverDashboard.safeReturn.component.test.tsx`,
whose `endLayoverSession` mock returns the new shape; that file presses no End
control. Back to 176 / 61.

### 17.5 Row moves

Four rows move, **all `W → C`, none vacuous.** Each is a thing a traveller
either reads or is asked, on a path the app mounts.

| id | was | now | why |
| --- | --- | --- | --- |
| L9 | W | C | §2.1 *"Missing live intelligence degrades **visibly** to historical/conservative fallback; never fabricate freshness."* Both halves are now closed and the second closed in §16. The ladder was always real; what was missing is the word VISIBLY, and the remaining half of the row's last statement — §16.6's *"`publicAirport` still exposes only a `verified` boolean and a generic-buffer session is still indistinguishable from a curated one at the client"* — is false at this commit. The rung is derived from the record's own estimates, published on both certified endpoints and rendered in words in the always-visible box (`travel-buddy-standalone/src/components/layover/CanILeaveCard.tsx:144#layover-airport-intelligence-`). The absence of live intelligence is STATED on every rung that lacks it rather than implied by silence. Red-first: the whole suite could not load. Mutations: flattening the tier fails 6 of 10, dropping the client render fails 5 of 6, folding in the time-of-day constant fails 6 of 10. |
| L250 | W | C | §22 *"Do not imply equivalent intelligence globally; 'limited intelligence' is a valid product state."* The row's own `W` sentence, verbatim: *"it is uniform: the airport's own data maturity is never disclosed, so a curated airport and a generic-fallback one present identical confidence."* They do not: three renders of the same advice, window and airport against three server disclosures produce three different cards, asserted as an INEQUALITY rather than as three string matches (`travel-buddy-standalone/src/components/layover/__tests__/CanILeaveCard.component.test.tsx:175#the three rungs do not present identically`, and at the service in `artifacts/api-server/src/test/layoverAirportIntelligence.test.ts:209#a curated airport and a generic-fallback one no longer`). "Limited intelligence" is now a state the product can be IN and say so. Mutation: one sentence for every rung fails 3. |
| L19 | W | C | §3 *"**Passport / Memory** owns post-session durable artifacts **if the user chooses**; must not own temporary operational location data."* The must-not-own half has always held — the stamp carries a city name only. The other two are closed exactly: it is POST-session (the seam fires only on a session closed `completed`) and the user CHOOSES (an election that is off until pressed, and a `cancelled` close never carries one). Red-first: 6 of 7. Mutations: reinstating the creation seam fails 1 (`artifacts/api-server/src/test/layoverCompletionStamp.test.ts:126#POST /airport/sessions mints NO stamp`), dropping either term fails 1 each, pre-ticking the box fails 3. |
| L162 | W | C | §17 *"**Completed places/stamps** — durable only when the user elects Passport/Memory behaviour."* Same close, read as the data-lifecycle rule it is: nothing durable is written for a layover unless the traveller says the layover completed AND asks for the artifact. The stamp itself was already correctly minimal (city + `sourceType: "layover_session"`) and is unchanged; what changed is when it is written and who decides. Red-first and mutations as above, plus the client half (`travel-buddy-standalone/app/layover/__tests__/layoverDashboard.endSession.component.test.tsx:230#the Passport election is OFF until the traveller ticks it`). |

### 17.6 Rows opened, read, and deliberately NOT moved

| id | stays | why |
| --- | --- | --- |
| L10 | N | *"The system optimises successful real-world action and safe completion, not screen time."* **Considered `W` and rejected.** One of its three stated claims is now false — the system CAN distinguish a safe return from an abandonment, because a traveller who boarded says so and `status = 'completed'` is written. The other two stand: `layover_outcomes` does not exist and no metric of any kind is emitted. The verb in the requirement is OPTIMISES, and nothing reads the completion signal for any purpose at all. A recorded distinction is not an optimisation, and moving `N → W` on it would raise CONSTRUCTED% for a row where nothing was constructed toward the thing it asks for. See §17.7 for the evidence correction. |
| L275 | W | §25 *"**Passport / Memories** — convert a **completed** session into an optional stamp/postcard/memory."* Its `W` sentence names TWO gaps: *"fires at creation, not completion, and is not optional (L19, L162). No postcard or memory path."* The first is closed exactly — this is now a completed session converted into an optional stamp. The second is untouched: there is no postcard and no memory path from the layover surface. By this document's own standard (§13.4's L77, *"three terms of four is not four"*), a row whose stated divergence is half closed stays `W`. |
| L174 | W | `LayoverSessionService.close(sessionId, **outcome**)`. `W (improved)` at §7 because the outcome landed in `status` and an event. It improves again — the outcome now ARRIVES from a traveller rather than being a parameter no caller passed — and the row's blocker is unchanged: `layover_outcomes` is absent (L32), so there is nowhere to record what the outcome MEANT. |
| L214 | W | §20's completion metric. §7 moved it `N → W` for *"`session_completed` is now writable … Not emitted."* It is now written on a real path, which strengthens the `W` and does not close it: nothing emits, aggregates or exports it, which is the rule that scored L208 and L212 `W` too. |
| L33 | W | `LayoverState`'s seventeen members. `completed` has had a route since §7 and now has a caller; that is one of four CHECK values reached, not thirteen missing states built. |
| L32 | N | `layover_outcomes`. Still absent. §4's body row calls it *"unreachable in principle: nothing ever marks a session completed"* — the second clause is now false and the table is still absent, which is the only thing the row scores. |
| L65, L4, L293 | W / W / C | The travel-time family, untouched by this pass. §16.7's reasons stand exactly as §16.7 gave them. |
| L47 | C | Re-read because §17.3 changes code its invariant runs through. It holds, and it holds for a better reason: the third laundering site now refuses an unstated leg instead of resting on the claim that no such row can reach it. |
| L48, L34, L230 | N | The ENTRY gate. Nothing here reads a passport, a corridor or `lookupRequirement`. Unchanged since §16.7. |
| L243, L249 | W / N | §22's maturity ladder. The maturity is now DISCLOSED and still gates nothing: L243 asks for *"airport-side guidance only by default"* at L0 and L249 for features enabled per maturity. §17.8 item 1 states why this pass disclosed rather than gated, and what gating would cost. |
| L1, L5, L6, L191, L197, L206, L207, L238, L240, L263 | W | §13.1 group (c). Gated on 2700 or 2860. No code change moves them; none was attempted. |
| L102–L113 | W | Twelve rows behind one flag decision this lane does not own. Untouched. |
| L182, L183, L260, L269 | W | Untouched. A disclosed provenance is not an executable experience contract, not envelope geometry and not a certified action universe. |

### 17.7 Evidence corrected, no verdict moved

| id | the sentence that is false at this commit | what is true |
| --- | --- | --- |
| L10 | *"`status='completed'` is never written … The system cannot distinguish a safe return from an abandonment."* (the row also names a line in `routes/airport.ts` that was already stale by some 750 lines before this pass; it is quoted without it rather than repointed, for §12.4's reason) | It is written, by a traveller pressing "I made my flight" (`artifacts/api-server/src/routes/airport.ts:3058#const passportStamp = await writeElectedLayoverStamp` sits immediately after the `endSession` that writes it). The verdict does not move — see §17.6. |
| L19 | *"the only gate is the `passport_stamps_enabled` flag"* — and the line it named with it | There are FOUR gates (three written by this pass, the fourth added at integration) and the flag is the last of the three, not the last of the four. The row moves; the sentence is restated in §17.5 rather than left. |
| L32 | *"Absent, and unreachable in principle: nothing ever marks a session completed."* | The second clause is false. The table is still absent, which is what the row scores, so the verdict does not move. |
| L294 | *"Seven bare `catch { return … }` blocks remain in `LayoverSessionService.ts` (`:187, 229, 255, 367, 387, 416`)"* — already corrected to **six** by §13.5 | Still six, all still bare, at the same six lines: re-measured at this commit with `grep -n catch`, which returns exactly `187, 229, 255, 367, 387, 416` plus one comment at `289`. Nothing in this pass touched that file. Recorded because §13.5's correction is two sections above a later section that repeats the seven. |

### 17.8 What this does NOT close, stated with the cost

1. **THE MATURITY IS DISCLOSED AND IT GATES NOTHING.** L243 asks for
   *"airport-side guidance only by default"* at the L0 Generic rung and L249 for
   features enabled per maturity. The disclosure makes both MEASURABLE for the
   first time and neither is taken, because in production **every** airport is
   at GENERIC or AIRPORT_RECORD — 3,206 rows, 0 verified, 0 with a non-default
   buffer — so a gate keyed on maturity would withhold landside recommendations
   from every session the product has. That is a product decision with a cost,
   and it belongs to an owner rather than to a census pass. It is named here so
   the next reader finds a decision rather than an oversight.
2. **THE TWO MIGRATIONS §16.8 ASKED FOR ARE NOT WRITTEN, AND THE REASON IS THE
   RULE ITSELF.** §16.8 item 1 needs a provenance column on
   `layover_recommendations` before a routed travel time can be persisted; item 2
   needs a fifth `SafetyRating` rung, because the CHECK is four values
   (`artifacts/api-server/src/migrations/0127_layover_system.sql:119#safety_rating`).
   **A migration in the repository is not a migration applied**: L65, L9's
   travel half, L36 and L50 would each stay exactly where they are with the file
   present, and the file's only effect would be to make the blocker look
   discharged. This pass names the blocker instead and spent its evidence budget
   on four rows it could actually close. Whoever writes them should follow
   `2795_trip_kernel_write_guards.sql` — guarded preconditions, a postcondition
   block, and a rollback under `db/rollback/` — and should expect the census row
   to stay `W` with the migration named as its blocker until it is applied.
3. **A TRAVELLER WHO NEVER CLOSES THEIR LAYOVER NOW GETS NO STAMP AT ALL.**
   That is a REDUCTION and a reviewer should see it coming. Before this pass,
   starting a layover minted one; now, abandoning one mints nothing and letting
   it expire mints nothing. It is the correct answer to "durable only when the
   user elects", and it is still less product than there was. Production has 5
   layover sessions ever, 0 active, so nobody is holding a stamp this removes.
4. **THE DISCLOSURE IS REPORTED AND DECIDES NOTHING**, exactly like the
   `confidence` beside it. Nothing refuses, withholds or reorders on the rung.
   §6.1's *"critical unknown ⇒ confidence = INSUFFICIENT and forbid landside"*
   (L49) is still `N` and this does not touch it.
5. **`candidatesUnmeasured` IS PUBLISHED AND RENDERED BY NOTHING.**
   §17.3. It is in the client type because that file's rule is that a field
   appears when the server puts it on the wire, and it is named here as unread
   so nobody scores it as reachability.

### 17.9 The ceiling

1. **THE CLIENT HALF IS STILL TESTED IN A WORKSPACE THIS REPOSITORY'S
   `pnpm-workspace.yaml` DOES NOT INCLUDE.** Unchanged from §15.7 item 5, and
   now with 12 more assertions resting on it. Run by hand:
   `npx jest --testPathPattern='layover.*component|Layover.*component'`,
   **8 suites / 63 tests green** (was 6 / 51). The standalone workspace also has
   to be `pnpm install`-ed separately before its two typecheck ratchets can be
   run at all, which is how that ratchet has gone red before.
2. **RNTL 14's `render` IS ASYNC IN THIS REPOSITORY AND A SYNCHRONOUS CALL
   SILENTLY TESTS NOTHING.** `node_modules/@testing-library/react-native/dist/render.js`
   declares `async function render`, so `render(<X/>)` without `await` leaves
   `screen` unbound and every query throws *"`render` function has not been
   called"* — which reads like a harness bug and is not one. Both new client
   files await it. Recorded because the first draft of one did not, and the
   failure it produced named the wrong thing.
3. **A NEW TEST FILE WAS SPLIT OUT RATHER THAN APPENDED, AND THE REASON IS
   ANOTHER FILE'S HYGIENE.** Five end-session cases appended to
   `layoverDashboard.safeReturn.component.test.tsx` passed alone and after
   `-t 'L123|L19'`, and failed after that file's L42 block — where §15's
   "two taps are one POST" case deliberately leaves an abort in flight across a
   test boundary. The cases live in
   `travel-buddy-standalone/app/layover/__tests__/layoverDashboard.endSession.component.test.tsx`
   instead. Repairing the leakage is worth doing and is not a census pass's job;
   it is written down here so the next reader does not rediscover it.
4. **NO `C` ROW WAS FOUND FALSE, AND THE SEARCH WAS AGAIN A SAMPLE.** L47 was
   re-read because §17.3 changes code its invariant runs through, and L146 and
   L253 were re-read because this pass edits the screen and the route they are
   `C` for. All three hold. §13.6 item 7's complaint stands and has GROWN with the
   column it is about: it counted **38** never-re-read `C` rows when there were
   51, and there are now 60. This pass read three of them.
5. **TWO ALLOWLIST ENTRIES WERE DELETED, NOT MOVED — AND THE SECOND WAS FOUND
   BY THE FULL SUITE, NOT BY `run-all-checks.sh`.** `check-flag-polarity`'s
   `DIRECT_READS` carried `routes/airport.ts::passport_stamps_enabled`, written
   for the fire-and-forget creation seam. The seam is gone and the new one reads
   through the shared `isFlagEnabled`, so the entry is stale and the checker
   fails on a stale entry — deliberately, so an allowlist cannot outlive its
   site. It was removed rather than repointed.
   `artifacts/api-server/src/scripts/UNCHECKED_READS_ALLOWLIST.json` carried the
   SAME seam under a different key, `routes/airport.ts::post
   /airport/sessions::feature_flags.maybeSingle`, ledgered `FAIL-CLOSED`. Deleting
   the seam deleted the last `feature_flags` read in that file — there is now no
   occurrence of that string anywhere in
   `artifacts/api-server/src/routes/airport.ts` — so that entry went stale too and
   `check:unchecked-supabase-reads` exited 1 on it. **`bash
   scripts/run-all-checks.sh` does not run that checker**: it sits behind
   `check:security`, which nothing in `run-all-checks.sh` invokes and which is
   reached only by the security suite's REAL-TREE CONTROL case — so only the FULL
   1141-file suite gets to it. A green `run-all-checks.sh` on this tree was
   therefore *true and insufficient*, and the stale entry was found only when the
   full run reached that case, after every other gate in this section had already
   gone green. Recorded because the shape generalises twice over: a lane that
   deletes a call site must also search every allowlist KEYED on it, not only the
   one it happened to remember; and the aggregate whose name sounds most complete
   is not the aggregate with the widest reach.

   Naming those two files here costs this census two `check:census-scope-coverage`
   citations, and both were handled rather than hidden. The CONTROL case is named
   in PROSE rather than by filename because it is a TEST, and the `NOT_GRADED`
   comment in `artifacts/api-server/src/scripts/checkCensusScopeCoverage.ts` lists
   tests as SUBJECTS — things its escape hatch may never cover — while nothing in
   this census grades it, so neither answer that checker offers fits and the third
   is to not cite it. The allowlist path IS added to that `NOT_GRADED` list, which
   is the checker's own sanctioned second answer: a guard's burn-down ledger, the
   same category as the staleness ledger already listed, not product code, graded
   by no census. **That addition was mutated and stayed GREEN, and the number it
   is worth is written down rather than implied**: without it the ratio is
   105 cited against 101 watched, **96 %** against a floor of 96 %, which passes; with
   it, 104 against 101, **97 %**, where this census was before this pass. So the entry
   is not what makes the check pass — it buys back the one point of headroom that
   citing the ledger spent, and refuses to leave the next lane sitting exactly on
   the floor. No floor was lowered, and the ratio ends where it started.
6. **Owner decisions.** This pass surfaces ONE and resolves none: whether the
   GENERIC rung should WITHHOLD landside guidance (§17.8 item 1, L243/L249).
   Decisions 9, 10 and 11 from §11.3 are open and untouched. The two non-owner
   blockers §13.6 named are unchanged: the twelve Compass tools are still not
   passed to the model, and `layover_stable_recommendation_ids_enabled` is still
   FALSE.
7. **THE FULL SUITE IS NOT AT ZERO ON THIS BRANCH, AND IT WAS NOT THIS PASS.**
   The complete registered run — all 1141 files — finishes **20154 tests, 20152
   passed, 2 failed, 0 cancelled, 0 skipped, 0 todo**. The denominator is up 26
   from the 20128 this branch started at, which is exactly the 10 + 7 + 9 cases
   of this pass's three new server suites. The two failures are outside this

   **CORRECTED AT INTEGRATION: on the merged branch the suite IS at zero.** This
   pass measured against `6d4fd1a06`. The integrating branch had already closed
   the same real-clock defect in `53615fd72`, by freezing the clock for that
   describe block
   (`artifacts/api-server/src/test/tripOpportunityProjection.test.ts:192#before(() => { mock.timers.enable({ apis: ["Date"], now: NOW.getTime() }); });`).
   The merged tree runs **20,216 tests, 20,216 passed, 0 failed, 0 cancelled, 0
   skipped, 0 todo**, exit 0. So item 7's figures are right for the commit they
   were taken at and are NOT the merged numbers; this pass's attribution — four
   files checked out at the base in place, same two cases by name either way,
   then restored — was sound, and the fix simply predated the base it measured
   against. The claim that *"the brief's 0-failed baseline is not reachable on
   this branch"* is withdrawn: it is reached.

   census's subject, both in the trip-opportunity projection suite — named in
   prose for the reason item 5 gives, since it is a TEST this census does not
   grade and citing it would spend coverage on it:
   *"GET /opportunities serves a member and refuses a stranger…"* (an
   `ERR_ASSERTION` on `["fw:B:end"]`) and *"Compass `get_opportunities` returns
   the accepted portfolio…"* (a `TypeError`, *"Cannot read properties of
   undefined (reading 'executable')"*). They were NOT attributed by argument. The
   file imports the whole router, so this pass's four changed server files ARE in
   its 766-file import closure and could not be ruled out by reading; instead the
   four were checked out at the pass's base commit `6d4fd1a06` in place, the file
   was run again, and it failed **the same two cases by name, 16 passed / 2
   failed either way**. The four were then restored and re-verified. The failure
   is pre-existing and belongs to the Trips/Compass lane. It is recorded here
   because the next lane to run this suite will see it and should not spend the
   hour this pass spent proving it is not theirs.

### 17.10 Freshness, citations, registration

1. **`check:census-freshness` — 0 STALE, by RE-DECLARATION rather than by
   acknowledgement.** `head_commit` moves from `eb70ab3b2` to `a5c223a37`, the
   commit that carries every counted file this pass changed. The acknowledgement
   written against `eb70ab3b2` — §16's, which did not claim its files were
   harmless and pointed at §16 instead — is **retired, not deleted**, in
   `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`, which
   is what that entry's own last paragraph instructs. No acknowledgement
   replaces it: with `head_commit` at `a5c223a37`, zero counted files have
   changed since, so there is nothing to excuse. **The same pre-squash hazard
   every value in that row has carried applies again** — `a5c223a37` is on a
   lane branch and becomes an ancestor of nothing after a squash-merge, so
   whoever merges must re-declare the squash sha.
2. **`check:doc-citations` — `RESULT clean`, 50 anchors repointed.** Every one
   was displaced by this pass's own edits. Each was repointed by **exact
   original line text**, never by offset and never to a nearest candidate: the
   text at the cited line was read out of `git show HEAD:<path>` and located in
   the working tree by string EQUALITY with a UNIQUE match required; for a cited
   RANGE the whole block was matched byte-for-byte. Four of the 50 are
   `:NNN#anchor` shorthands that inherit the previous citation's path, which the
   first pass did not reach, and three are into a CLIENT TEST FIXTURE this pass
   had to widen — see §17.4 — and were displaced after the first repoint; all
   seven were located the same way. **The three ratchet
   constants in `scripts/check-doc-citations.mjs` were not edited.** Measured
   before and after: the two FLOORED COUNTS rise, from 2521 anchored / 2343
   whole-anchor to **2549 / 2371**, against floors of 2507 / 2329 that are left
   where they were found; the CEILING does not move at all and ends where it
   began, at **6443 of 6443**. Every citation this section writes is ANCHORED, because
   that ceiling has zero headroom and one bare `path:line` added here fails the
   tree — measured rather than assumed, twice: the first draft of §17 quoted two
   body rows WITH the parenthesised line numbers they carry (L10's pointer into
   `routes/airport.ts`, and L19's own bare line reference), the count went to
   6444, and the
   check refused it. Both quotes carry the sentence and not the stale pointer
   now — which is also why neither is repointed: §12.4's rule is that a pointer
   whose correctness at its own commit was never established must not be moved
   somewhere it will look verified.
3. **`check:test-registration`.** The three new server suites are appended at
   the END of `artifacts/api-server/package.json`'s `test` script,
   append-ordered by lane, and all three join `CENSUS_SCOPE` for §15.9's reason:
   the four row moves rest entirely on their assertions, and a census that cites
   a test as evidence while not watching it cannot notice the test changing
   under the verdict. **No floor is raised with them** — the widening only keeps
   the existing 96 % from falling when the new citations land. The two client
   suites need no widening: `travel-buddy-standalone/src/components/layover/`
   and `travel-buddy-standalone/app/layover/` are already scoped as directories.
   A FOURTH file joins with them and is an older gap rather than this pass's:
   §16 added `lib/layoverLiveIntersection.ts` to the scope because this census
   grades it, and left `src/test/layoverLiveIntersection.test.ts` outside — so
   the module was watched while the assertions that say what it does could
   change unseen. The census cites the test by name. Coverage after all four:
   **104 cited / 101 watched, 97 %** against the same 96 % floor.

### 17.11 Recomputed headline

Same 296 denominator, same counting rule, same prohibition rule. Recomputed by
`pnpm -s check:census-integrity` from the tables themselves, last-verdict-wins,
with the PR-comparison rows skipped. This supersedes the §16 headline.

| Measure | At `eb70ab3b2` (§16) | Now (`a5c223a37`) |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 56 | **60** |
| BUILT-BUT-WRONG | 130 | **126** |
| NOT-BUILT | 110 | **110** |
| CANNOT-VERIFY | 0 | **0** |
| Sum | 296 | **296** |
| CONSTRUCTED% | 62.8 % | **62.8 %** (186/296) |
| CORRECT% raw | 18.9 % | **20.3 %** (60/296) |

> **CONSTRUCTED% does not move, for the fourth pass running, and it is still the
> correct shape.** Nothing was constructed that was not constructed before: the
> fallback ladder, the per-term provenance and the `completed` outcome all
> existed and none of them reached a traveller. The gap between CONSTRUCTED and
> CORRECT closes from 43.9 points to **42.5**.
>
> **The unflattering reading.** Four rows is 3.1 % of the 130, the best fraction
> any pass in this document has managed, and it is still four rows — and two of
> the four (L9/L250, L19/L162) are pairs that name the same gap twice, so the
> number of distinct DEFECTS closed is two. §13.1's arithmetic still bounds what
> is left: of the 126 remaining `W`, **19 cannot be moved by any code change
> under these rules** and **66 need a build rather than a fix**. What this pass
> adds to that count is one correction: the reachability group is smaller than
> §13.1 thought, because two of the rows it listed as BEHAVIOUR (L9, L250) were
> reachability rows all along — the code was right, the wire carried it, and no
> screen read it.

## §18 — the Temporal Freedom Engine was never missing; its adapter was

This pass opened §7, §8, §18 and §21.1 and found that the largest NOT-BUILT
cluster in this document rests on a measurement error rather than on absent
code. It moves twelve rows, every one against a test watched RED first or a
mutation run against production code. It also corrects the evidence on seven
rows whose citations had aged; four of those seven do not move.

### 18.1 The finding that reframes §7

L56 reads *"A generalised engine answering 'what can this user do before they
must be somewhere else' — **N** — `computeWindow(airport: AirportProfile,
session: LayoverSession, …)` is airport-typed at its signature. There is no
generic engine, and no second adapter."* L57 reads *"`Commitment { … }` — **N** —
Absent."* L178 reads *"`TemporalFreedomService.calculateCommitmentEnvelope(context)`
— **N** — No `Commitment` (L57)."*

**Every one of those sentences is true of `services/airport/` and false of this
repository.** `artifacts/api-server/src/domain/trips/invariants/TripFreedomEngine.ts:102#export interface FreedomWindow`
is the generalised engine the layover spec §7 describes — the same
`FreedomWindow`, the same commitment ordering, the same "a window is a LOWER
BOUND on free time" rule, built for the Trips spec's own §7.3 and carrying no
airport assumption anywhere. `artifacts/api-server/src/domain/trips/invariants/TripFreedomEngine.ts:145#export interface EngineCommitment`
is the commitment type. Neither was ever read by anything under
`services/airport/`, and four census passes measured a directory rather than a
tree.

The layover spec says exactly what to do about that, three times:

> §7: *"Layover is its first high-stakes adapter."*
> §7: *"Keep airport-specific logic in the Layover adapter, not in the generalized engine."*
> Developer rule 14: *"Always keep the generalized Temporal Freedom Engine free of airport-specific assumptions; use adapters."*

So writing a second freedom engine under `services/airport/` — the obvious way
to make L56 look closed — would have been the one thing §7 explicitly forbids.
What was missing was an adapter, and that is what this pass built.

### 18.2 §7 / §18 — what was built, and where

**1. The adapter.** `artifacts/api-server/src/services/airport/LayoverTemporalFreedom.ts:163#export function layoverCommitments`
reads a layover as the two commitments it is: the inbound flight, whose
`endsAt` is wheels-down plus the exit-delay model, and the outbound flight,
whose `requiredArrivalAt` is `layoverCutoffMs`'s own answer (boarding when the
session carries one) and whose `prepMinutes` is the certified return buffer.
Both are `flexibility: "fixed"` with zero lateness tolerance, which is a safety
statement rather than a default — an aircraft does not wait, so there is no
tolerance to spend.

**The hop between them is 0, and that is a FACT rather than an estimate**: both
commitments are at the same airport. It is emphatically not the landside
journey, which is charged per candidate in `assess` and is `null` on this tree.
Putting the landside leg there would double-charge it and would be a number
nobody measured. That distinction is worth exactly what a test makes it worth,
and a mutation found it worth nothing at first — see §18.4.

**2. The §18 service, reached rather than reached past.**
`artifacts/api-server/src/services/airport/LayoverTemporalFreedom.ts:309#export const TemporalFreedomService`
carries the two members the spec lists and nothing else.
`artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts:1130#const freedom = TemporalFreedomService.buildFreedomWindow(freedomCtx)`
is the production call site. The first draft imported the bare function beside
the object, which would have left the named interface with no caller outside
its own test — the reachability `W` this document has spent five passes on,
introduced by the pass closing it.

**3. `computeWindow` stops deriving the window by hand.** `arrival + exitDelay`
and `hardReturn − windowStart` were spelled out in
`artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts:1115#const freedomCtx: LayoverFreedomContext`'s
place. They are the two ends of a freedom window, and they are now the engine's.

**NO NUMBER A TRAVELLER SEES MOVED, and that is swept rather than asserted.**
`usableMinutes` equals the pre-adapter formula — restated inside the test rather
than imported, so it cannot pass by reading the same code twice — over 1,024
cases spanning both airport maturities, both flight types, bags, immigration, a
45-minute-to-14-hour range of gaps and four clock offsets. `freedomWindow.endsAt`
equals the certified `hardReturnTime` to the MILLISECOND wherever a window
exists. If those two ever drift, this surface has two ways to compute the number
a traveller acts on by leaving an airport, which is the defect `9c26efba` closed
for the buffer.

**4. What is NEW is the failure case, and a traveller reads it.** A layover
whose required buffer eats the whole window returned `usableMinutes: 0` and
nothing else; the number the traveller was SHORT BY existed nowhere — not in the
engine, not on the wire, not on a screen. It is the one fact that tells them
whether a later flight or a lighter bag would change the answer. The generalised
engine has always produced it as a `TEMPORAL_CONFLICT.shortfallMinutes`; the
layover surface never asked. It does now
(`artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts:1030#shortfallMinutes: number | null`),
it is on the wire
(`travel-buddy-standalone/src/services/layover.ts:134#shortfallMinutes: number | null`)
and it is rendered
(`travel-buddy-standalone/src/components/layover/CanILeaveCard.tsx:84#styles.shortfall`).
§7.2: *"a conflict is not silently rendered as a normal itinerary."*

This is not a rare branch. A two-hour international connection with immigration
and a checked bag has no window at any airport this product has, and the
traveller is now told they are about two hours short instead of only that they
cannot go.

### 18.3 §8 — the half of a safe envelope a lower bound can certify

L50 read NOT-BUILT with the right observation: *"Every landside card is now
`not_recommended`, which is a RATING and not a block: the cards are still
generated, still persisted and still served."* A rating is all `assess` can
produce, because it has no measured leg to refuse on.

One verdict does not need a routed provider. A great-circle distance is a LOWER
BOUND on travel time, and `artifacts/api-server/src/domain/trips/contracts/TravelTimeProvider.ts:186#export const straightLineTravelTimeProvider`
already states the asymmetry that follows: *"a straight-line INFEASIBLE is a
real verdict; a straight-line FEASIBLE is not."*

`artifacts/api-server/src/services/airport/LayoverEnvelope.ts:226#export function safeEnvelope`
computes only the envelope's OUTER edge — the disc outside which
`2 × lowerBound(distance) > usableMinutes`, which no dwell and no route can
rescue — and never says SAFE or TIGHT.
`artifacts/api-server/src/services/airport/LayoverEnvelope.ts:92#export const ENVELOPE_BANDS`
declares the spec's three bands plus the one this tree can produce; the two
certifications have no producer, the same arrangement `LAYOVER_REASON_CODES`
uses for the codes whose triggering fact does not exist.

**It is TIME-based rather than a fixed radius.** The disc is cut from the §7
certified window, so it differs per session, contracts as the window shrinks and
reaches nowhere when the window is gone. `radiusMetres` is the exact inverse of
the provider's own `min(walk, drive)` at
`artifacts/api-server/src/services/airport/LayoverEnvelope.ts:263#const maxOneWayMinutes = Math.floor(usableMinutes / 2)`,
using the provider's constants rather than copies of them. **The floor is
load-bearing and was found by the sweep, not by the algebra**: the provider
reports whole minutes, and the un-floored half admitted a 46-minute round trip
into a 45-minute window — a disc that disagreed with the block it was supposed
to explain.

`artifacts/api-server/src/services/airport/LayoverRecommendationService.ts:583#const reachableDiscovery = discoveryCandidates.filter`
drops blocked candidates before they are rated, ranked, persisted or served.
That matters most for the defect L61 names: the query is `ilike("city", "%…%")`,
so a place in a DIFFERENT city whose row carries the same name was a candidate
and was served. **It fails open everywhere** — no airport coordinate (the
fallback profile's `(0, 0)`), no place coordinate, no bound, a provider that
refuses — because a block is a refusal and refusals need proof.
`artifacts/api-server/src/routes/airport.ts:1753#safeEnvelopeFor` publishes
the same disc from the same pure function on both session endpoints, so a
traveller who sees fewer cards than a city has places can read the bound that
removed them.

### 18.4 Evidence — red first, then thirty-four mutations

**RED FIRST, and the shape of each red is stated rather than averaged.**

| what | red | green |
| --- | --- | --- |
| §7 adapter — with `LayoverTemporalFreedom.ts` present and `computeWindow` at `6d4327d66` | 10 passed / **6 failed** | 18 / 0 |
| §7.2 shortfall on the client — with `CanILeaveCard.tsx` at `6d4327d66` | 3 passed / **2 failed** | 5 / 0 |
| §8 block — with `LayoverEnvelope.ts` present and `LayoverRecommendationService.ts` at `6d4327d66` | 9 passed / **1 failed** | 10 / 0 |
| §21.1 matrix — with `LayoverSafetyEngine.ts` at `6d4327d66` | 9 passed / **2 failed** | 11 / 0 |

**Two of those reds are weaker than the count makes them look, and saying so is
the point of printing them.** The §8 file's other three L50 cases are FAIL-OPEN
controls — an unlocated place, an airport with no coordinate, a window long
enough to reach the same place — and a control passes before the feature exists
by construction. The §21.1 file's nine remaining cases are new construction:
there was no scenario to be red against, which is what NOT-BUILT meant. Both are
carried by mutation instead.

**THIRTY-FOUR MUTATIONS, each against PRODUCTION code, each reverted and
`cmp`-verified.** The table below is the whole set and its arithmetic is
**29 red / 5 green**, not the 33/5 the first draft of this section claimed —
that number counted the confirming RE-RUNS as separate mutations, which is the
same double-count this document's correction header exists because of. With the
five re-runs (after a dead branch was deleted or an assertion added) there are
**41 runs in all**, and every one of the five greens is answered here rather
than written off.

| # | mutation | result |
| --- | --- | ---: |
| E1 | `reachMetres` returns the MINIMUM over modes | 2 failed |
| E2 | the envelope forgets the round trip (`usableMinutes` not half) | 1 failed |
| E3 | the floor on `maxOneWayMinutes` deleted | 1 failed |
| E4 | a null centre defaults to `(0, 0)` instead of no envelope | 2 failed |
| E5 | the provider's refusal fails CLOSED (blocks) | 1 failed |
| E6 | one-way instead of round-trip in the block test | 1 failed |
| E7 | `BLOCKED` declared to certify a fit | 1 failed |
| E8 | the non-finite / negative bound guard deleted | **0 — see below** |
| E9 | an unlocated place is blocked | 3 failed |
| E10 | every blocked candidate kept | 1 failed |
| E11 | the block inverted (the REACHABLE ones dropped) | 6 failed |
| E12 | the envelope centred on null island in the service | 3 failed |
| E13 | the place coordinate stops being read | 1 failed |
| T1 | the departure commitment reserves nothing | 11 failed |
| T2 | the inbound flight releases the traveller at wheels-down | 4 failed |
| T3 | the zero hop becomes `null / NO_ROUTED_PROVIDER` | **0 — see below** |
| T4 | the outbound flight tolerates 30 minutes of lateness | 6 failed |
| T5 | the outbound flight is `flexible` rather than `fixed` | 2 failed |
| T6 | the hop claims to be routed at HIGH confidence | 1 failed |
| T7 | the shortfall is never published | 2 failed |
| T8 | `usableMinutes` derived from the deadline, not the window | **0 — equivalent, see below** |
| T9 | every window claims HIGH confidence | **0 — see below** |
| T10 | the window opens at wheels-down | 2 failed |
| T11 | only the base buffer is reserved | 7 failed |
| T12 | the exit delay is removed from the commitments | 2 failed |
| T13 | the airport label dropped from both commitments | **0 — see below** |
| T14 | the conflict is swallowed | 2 failed |
| S1 | the `too_short` rung moves from 45 to 5 minutes | 2 failed |
| S2 | checked bags cost nothing at the exit | 1 failed |
| S3 | the traffic term ignores the airport row | 2 failed |
| S4 | every flight gets the domestic buffer | 3 failed |
| C1 | a zero shortfall renders as a shortfall | 1 failed |
| C2 | the shortfall line always renders | 3 failed |
| C3 | the line renders `usableMinutes` instead of the shortfall | 2 failed |

**THE FIVE GREENS, and what each one cost.**

1. **E5's first form and the catch it mutated were DEAD CODE, and the mutation
   is how that was found.** `bandCandidate` had a `try/catch` around the
   provider call. `estimateTravel` already wraps the provider — a throw comes
   back as `unknown / PROVIDER_UNAVAILABLE` — so the second catch could never
   run, and `haversineMeters` cannot throw on the finite coordinates
   `airportPoint` / `placePoint` admit. Turning it into a fail-CLOSED block
   failed nothing because nothing reached it. **The branch was deleted**, with
   the reason written where it stood, and E5 above is the re-run against the
   reachable refusal path: 1 failed.
2. **E8 — the non-finite bound guard was real and unpinned.** No provider on
   this tree answers `NaN`, so deleting the guard failed nothing. A
   malformed-provider case (`NaN`, `Infinity`, `-5`) was added; **E8 re-run: 1
   failed**. It is listed above at its first, honest result.
3. **T3 — the zero hop's HONESTY was unpinned, and this is the most interesting
   of the five.** Swapping `travelMinutes: 0` for `null / NO_ROUTED_PROVIDER`
   failed NOTHING across three suites, because the engine computes
   `endsAt = deadline − prep` in the unknown branch and `deadline − (0 + prep)`
   in the known one: every INSTANT is identical and only the window's own
   honesty moves — `reservedMinutes` to `null`, `confidence` to INSUFFICIENT, a
   `TRAVEL_UNKNOWN` constraint appearing on a window whose hop is a fact. Those
   three are now asserted; **T3 re-run: 1 failed**.
4. **T9 and T13 — two claims this document would have had to take on trust.**
   Hard-coding `confidence: "HIGH"` failed nothing, because the window carries a
   `NO_ORIGIN` constraint (this computation reads no coordinate) which keeps
   `certified` false on its own, so the confidence value was unobservable.
   Dropping the IATA label failed nothing because nothing read it. Both are
   swept now; **re-run: 1 failed each**.
5. **T8 IS AN EQUIVALENT MUTANT and is reported as one rather than repaired.**
   Deriving `usableMinutes` from `hardReturnMs` instead of the window's end
   cannot go red, because the suite's own sweep asserts the two are equal to the
   millisecond. What would BREAK that equality is covered: the prep term (T1, 11
   failed), the lateness tolerance (T4, 6 failed) and the exit delay (T12, 2
   failed). A second dead branch was found the same way and deleted — the
   `freedom.window ? … : 0` guard in `computeWindow`, which cannot be observed
   because a refused window's end is at or before its start and `Math.max(0, …)`
   was already 0.

### 18.5 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| L13 | N | **W** | §3's boundary row. A Temporal Freedom domain now exists, owns the freedom window and the commitment, and owns no LLM prose — but it is a file inside ANOTHER domain's package (`domain/trips/invariants/`), and §3 is a statement about domain ownership. Owning a concept from inside someone else's package is a real boundary divergence, so this is `W` and not `C`. |
| L56 | N | **W** | The generalised engine exists, is airport-free (asserted by reading both modules' import lines, not by comment) and the layover is a live adapter of it. `W` because §7's question names four inputs — *"current position, next commitment, constraints and world conditions"* — and two of them never reach the engine on this adapter: no coordinate is passed, and there are no world conditions to pass. |
| L57 | N | **W** | `Commitment` exists as `EngineCommitment` and both layover commitments are built from it on every certification. Six of the spec's eight members map across in substance (`location`→`place`, `preparationTime`→`prepMinutes`, `latenessTolerance`→`latenessToleranceMinutes`). `hardConstraints` and `confidence` live on the WINDOW in this engine rather than on the commitment, and widening `EngineCommitment` is the Trips lane's decision, not this one's. |
| L59 | N ∅ | **W** | The adapter boundary exists and is enforced in both directions by test, so the row is no longer vacuous. `W` because the "generalised" engine is trip-NAMED: it emits `TRIP_TEMPORAL_CONFLICT`, takes `tripStart`/`tripEnd`, and its own doc cites `trip_commitments`. A layover surface handing a traveller a trip-shaped conflict is airport-specific logic staying out of the engine and trip-specific logic staying in. |
| L177 | W | **C** | `TemporalFreedomService.buildFreedomWindow(context)`. Both halves of its `W` are closed: it takes a context and not an airport, and it returns a `FreedomWindow` and not a `LayoverWindow`. It is the production seam — `computeWindow` calls it through the service object — and its output is on the wire and on a screen. The `FreedomWindow` SHAPE gap is L58's row and is scored there; scoring it twice would be counting one gap against two requirements. |
| L178 | N | **W** | `calculateCommitmentEnvelope(context)` exists, takes the same context, returns the protected band in front of the outbound flight, and is proved to agree with the window at the boundary. **Nothing outside `src/test/` calls it** — §13.1's group (a) exactly — and no caller was manufactured for it: the band it returns is `[hardReturnTime, cutoff]`, which both endpoints already publish, so a call site would have been a second derivation of a published number rather than a use. |
| L50 | N | **W** | A certainly-unreachable candidate is now BLOCKED — not generated, not persisted, not served, not offered an "Add to plan" control. `W` because "unsafe" is broader than "unreachable": a card rated `not_recommended` by the buffer arithmetic, which is EVERY landside card on this tree while the leg is unmeasured, is still generated and still served. |
| L61 | N | **W** | A time-based envelope exists, is cut from the certified window, contracts with it, is applied to every landside candidate and is published on both session endpoints. `W` because it is a DISC and not an isochrone: with no route data the only shape the geometry supports is the circle a straight-line bound cuts, and it is an OUTER bound only. |
| L63 | N | **W** | The envelope's edge contracts as return risk rises — a later exit, a larger buffer, a live queue all shrink `usableMinutes` and the radius with it, swept over seven windows. It does NOT contract on confidence: `confidence` is carried on the window and no edge reads it. Half the requirement. |
| L66 | N | **W** | `SafeEnvelope` exists as a type and as a value on the wire. `W` because it is a SUPERSET of `union(points satisfying the constraint)` rather than the union — stated in the type as `certifiedInward: false` rather than left for a reader to infer from the absence of a polygon. |
| L219 | N | **W** | The scenario exists deterministically for the first time. `W` because the engine ANSWERS SOMETHING ELSE: §21.1 expects `airport-only` and a 2h domestic layover is `too_short` (19 usable minutes against a 45-minute rung; 25 until §22's return-transport term was added — see §22.3). Those are different sentences to a traveller — "stay near your gate" against "enough time to enjoy the terminal" — so the case pins both the measured tier and the inequality with the spec's. |
| L220 | N | **W** | The airport-model variation the census recorded as absent from every test now exists: at 5h international the SAME session is `tight` at a curated airport and `no` at a generic one. `W` because at the spec's own 4h neither model reaches landside, and the "visa allowed" half is unrepresentable — the case proves that by scanning the session's own field names and fails the day one appears. |

### 18.6 Rows opened, read, and deliberately NOT moved

- **L67** (map bands SAFE / TIGHT / BLOCKED). The band vocabulary now exists and
  `BLOCKED` is produced and acted on — but §13's requirement is about the MAP,
  and `LayoverMapCard.tsx` still renders undifferentiated pins. No band reaches
  a map, no band is even on a recommendation's wire shape. Stays `N`.
- **L121** (map element "safe envelope" — dynamic isochrone/polygon). A disc on
  a response is not a rendered polygon, and nothing draws it. Stays `N`.
- **L116** (show safe/tight/blocked geography from certified envelope versions).
  Two of the three bands have no producer and there is no envelope VERSION to
  certify against. Stays `N`.
- **L58** (`FreedomWindow`'s ten members). Seven now reach the layover. Three do
  not — `softConstraints`, `riskBudget`, `uncertaintyBudget` — and none of the
  three has a producer anywhere in the repository. Stays `W`; evidence rewritten
  in §18.7.
- **L77** (§9.1's hard gate). The gate gained a REACHABILITY term applied before
  any optimisation, which is a real strengthening. It is still not the
  requirement: entry permission is unread (L34, L48, L230). Stays `W`.
- **L221** (6h visa-free → landside + return contract). The landside half is now
  a deterministic scenario and the certified deadline is asserted. The RETURN
  CONTRACT is `layover_return_plans`, which does not exist (L24), so the row
  cannot move on half a requirement. Stays `N`.
- **L222 / L224 / L229**. Each is now asserted UNREPRESENTABLE by a field scan
  that fails the day a field appears, so the matrix's incompleteness is
  something a test run reports. That is a better `N` and it is still `N`: an
  assertion that a requirement cannot be expressed is not the requirement.
- **L60 / L72** (bidirectional reachability under future return conditions; a
  return forecast rather than the outbound time). The envelope's bound is
  SYMMETRIC by construction and says so in its own header. A symmetric lower
  bound is still a lower bound, which is all this pass claims, and it is not the
  asymmetric return model these rows ask for. Stay `N`; evidence rewritten.
- **L62** (transport reliability, route alternatives, queue friction, weather,
  re-entry cost). The envelope is geometry and two speeds. None of the five is
  an input. Stays `N`.

### 18.7 Evidence corrected

Four claims named a line that WAS the defect and no longer exists. Each was
re-read and rewritten rather than repointed, which is what §12.4's rule requires
of a pointer whose subject is gone. **Two of the four cover rows that ALSO move
(L61 in item 2; L56 and L177 in item 3) and two cover rows that do not (L60/L72
in item 1, L215 in item 4)** — stated that way because a section titled "no
verdict moved" that contained rows which moved is exactly the kind of quiet
inconsistency this document keeps finding in itself. Counting the rows rather
than the items: **L58, L60, L72 and L215 have corrected evidence and an
unchanged verdict.**

1. **L60 and L72** both point at a `travelTimeMin * 2` in `LayoverSafetyEngine.ts`
   at a line named here in words rather than as a pointer — line 97 — because the
   citation form would be an UNANCHORED one and this tree has no headroom for
   another (§18.10 item 2). That expression was deleted by §16 with census L293. The round trip is now
   `(statedTravel ?? 0) * 2` over a leg that is `null` for every landside
   candidate on this tree, so the return is not "modelled as outbound × 2" — it
   is not modelled at all, and the reason has changed from a symmetry assumption
   to an absent measurement. Line 97 today is a member of `LAYOVER_REASON_CODES`.
2. **L61** says *"`fetchDiscoveryPlaces` … does not even select `lat`/`lng`"*,
   pointing at lines 174 to 183 of `LayoverRecommendationService.ts`. False since §16: `lat, lng`
   have been in the SELECT list, and this pass adds
   `artifacts/api-server/src/services/airport/LayoverRecommendationService.ts:360#point:          placePoint({ lat: p.lat, lng: p.lng })`,
   which is what the envelope tests. The `ilike("city", "%…%")` half of that
   sentence is still true and is now the reason the block earns its keep.
3. **L56, L58 and L177** point at three ranges in `LayoverSafetyEngine.ts` —
   lines 232 to 236, 189 to 208 and 232 to 281 — for a `computeWindow` that has
   since moved several hundred lines and no longer derives its own window. Rewritten against
   `artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts:1016#freedomWindow: FreedomWindow | null`
   and the call site in §18.2.
4. **L215** says *"the fallback ladder emits nothing when it fires"*, pointing at
   lines 70 to 90 of `AirportProfileService.ts` and at line 127 of
   `routes/airport.ts`, which it says *"swallows the failure silently"*. Both
   halves have aged: the ladder logs at
   `artifacts/api-server/src/services/airport/AirportProfileService.ts:27#function noteFallback`
   and the route's read binds its error (§15.6, L294). **The verdict does not
   move**: a log line is not a metric, there is still no counter, no exporter
   and no `report*` script for layover under `src/scripts/`, and L215 asks for a
   metric. The row is `N` for a narrower and truer reason than it was.

### 18.8 What this does NOT close, stated with the cost

1. **NOTHING HERE PRODUCES A ROUTED TRAVEL TIME, AND THAT IS STILL THE CEILING
   ON §8.** The envelope can refuse and can never certify. `SAFE` and `TIGHT`
   are declared and unreachable; `L60`, `L62`, `L68`–`L73` all wait on the same
   missing provider. The one thing that changed is that the refusal is now a
   PROOF rather than a rating.
2. **THE BLOCK IS INVISIBLE IN PRODUCTION TODAY, AND THE REASON IS ARITHMETIC
   RATHER THAN CODE.** Production has 3,206 `airport_profiles` rows and 0
   verified, so the buffer terms are the generic constants, so `usableMinutes`
   is small, so the disc is small — which makes the block MORE likely, not less.
   But there are 5 layover sessions ever and 0 active. No traveller is currently
   losing a card to it, and none is currently being saved by it.
3. **THE §21.1 MATRIX DIVERGES FROM THE SPEC AND THIS PASS DID NOT RESOLVE THE
   DIVERGENCE.** L219 expects `airport-only` and the ladder answers `too_short`.
   Changing the ladder to match would move a threshold every other row rests on,
   for a spec sentence that may be describing a different tier vocabulary. It is
   an OWNER DECISION and it is named here rather than taken.
4. **`calculateCommitmentEnvelope` HAS NO PRODUCTION CALLER** and this pass
   refused to invent one. See L178's row for why.
5. **THE THREE `FreedomWindow` MEMBERS WITH NO PRODUCER ANYWHERE** —
   `softConstraints`, `riskBudget`, `uncertaintyBudget` — are the whole of what
   keeps L58 at `W`, and none of them can be produced without a risk model this
   repository does not have.

### 18.9 The ceiling

1. **TWO NEW SERVER SUITES CANNOT BE CITED BY PATH IN THIS DOCUMENT, AND THAT IS
   A REAL COST RATHER THAN A STYLE CHOICE.** `CENSUS_SCOPE` lives in
   `checkCensusFreshness.ts`, which this lane may not edit, and
   `check:census-scope-coverage` floors this census at 96 %: citing three new
   `src/test/` files takes 104 watched of 109 cited to 95.4 % and fails. The
   client suite needs no entry — `travel-buddy-standalone/src/components/layover/`
   is already scoped as a directory — so it is cited normally. Of the THREE new
   server suites, ONE is cited —
   `artifacts/api-server/src/test/layoverTemporalFreedom.test.ts:145#the freedom window's end IS the certified hard return deadline`
   — and the other two are named in PROSE and cannot be cited at all:
   layoverEnvelope.test.ts and layoverScenarioMatrix.test.ts. **Whoever
   integrates this should add all three to `CENSUS_SCOPE` and then the prose can
   become citations.** A census that cites a test as evidence while not watching
   it cannot notice the test changing under the verdict, and that is exactly the
   state those two rows are in.
2. **THE THREE NEW SERVER SUITES ARE NOT REGISTERED IN `npm test`.** This lane
   does not edit `artifacts/api-server/package.json`. `check:test-registration`
   is RED on this branch for exactly three files and for no other reason;
   it is not run by `scripts/run-all-checks.sh`. The integrating owner must
   append them.
3. **THE CLIENT HALF IS STILL TESTED IN A WORKSPACE `pnpm-workspace.yaml` DOES
   NOT INCLUDE.** Unchanged from §17.9 item 1, now with 5 more assertions
   resting on it. Run by hand: `npx jest CanILeaveCard` — 2 suites / 11 tests
   green.
4. **`run-all-checks.sh`: 39 passed, 5 failed, and all five are the standing
   credential refusals** (`check:write-path-columns`, `check:missing-live-columns`,
   `check:authorization-contract`, `check:media-objects`,
   `check:rank-events-surfaces`), each exit 2 = CANNOT-RUN. Identical to the
   count at `6d4327d66`.
5. **NO `C` ROW WAS FOUND FALSE, AND THE SEARCH WAS AGAIN A SAMPLE.** L47 and
   L170 were re-read because this pass changes code their paths run through;
   both hold. §13.6 item 7's complaint stands and has grown again with the
   column it is about: 60 `C` rows, and this pass read two of them.
6. **NO MIGRATION WAS WRITTEN AND NONE WAS APPLIED.** Every row this pass moved
   is code and tests over the schema that is already deployed. The fifteen rows
   §13.1 groups as gated on 2700 or 2860, and the four gated on a flag, are
   untouched and unmovable by this lane.

### 18.10 Freshness, citations, registration

1. **`check:census-freshness`.** `head_commit` moves to `060027b0b`, the commit
   that carries every counted file this pass changed:
   `services/airport/LayoverTemporalFreedom.ts`,
   `services/airport/LayoverEnvelope.ts`,
   `services/airport/LayoverSafetyEngine.ts`,
   `services/airport/LayoverRecommendationService.ts`, `routes/airport.ts`,
   `travel-buddy-standalone/src/services/layover.ts`,
   `travel-buddy-standalone/src/components/layover/CanILeaveCard.tsx` and its new
   component suite, plus the three new server suites. **ZERO counted files move
   between `060027b0b` and this document's own commit**, so no acknowledgement is
   needed in place of one. **IT CARRIES THE SAME PRE-SQUASH HAZARD EVERY VALUE IN
   THAT ROW HAS CARRIED**: it is on the lane branch `lane-layover-arch` and on no
   remote branch, so after a squash-merge it is an ancestor of nothing and
   `check:census-freshness` will report this census unreadable until whoever
   merges re-declares the squash sha.

   **THIS CHECK IS RED ON THIS BRANCH FOR EXACTLY ONE REASON AND THIS LANE MAY
   NOT FIX IT.** Re-declaring `head_commit` SPENDS the acknowledgement written
   against `a5c223a37`, and the checker says so:
   *"the acknowledgement is spent. Delete it."* The ledger it lives in is
   reserved to the integrating owner, so the entry is named here instead: it is
   the `census-layover.md` / `since: a5c223a37` object, and the convention every
   previous pass followed is to RETIRE it — move it into the ledger's `retired`
   array, not delete it, so its per-file argument survives the entry. There is
   no re-declaration that avoids this and no way to leave the row alone either:
   six counted files moved since `a5c223a37` and that acknowledgement names two
   of them, so the census reads STALE with the row unchanged and SPENT with it
   re-declared. The choice taken is the one that leaves the row TRUE.
2. **`check:doc-citations`.** Every citation this section writes is ANCHORED,
   because `MAX_UNANCHORED_CITATIONS` has ZERO headroom — it sits at 6434 of
   6434 — and one bare `path:line` added here fails the tree. The three ratchet
   constants in `scripts/check-doc-citations.mjs` were not edited.
3. **`check:census-integrity`.** The headline below is recomputed by that tool
   from the tables, last-verdict-wins, with the PR-comparison rows skipped. It is
   not this pass's moves added to §17's headline, which is the arithmetic this
   document's own correction header exists because of.
4. **`check:citation-targets` and the SEVENTY-THREE anchors this pass's line
   shifts displaced.** Adding lines to `routes/airport.ts`,
   `services/airport/LayoverSafetyEngine.ts`,
   `services/airport/LayoverRecommendationService.ts` and
   `travel-buddy-standalone/src/services/layover.ts` moved the code under 66
   anchored citations in this census and 7 unanchored ones. Every repoint was
   made by EXACT ORIGINAL LINE TEXT: the block at the cited lines was read out of
   `git show 6d4327d66:<path>` and located in the working tree by byte equality,
   with a UNIQUE match required. Three were NOT unique at their own width and
   were resolved by WIDENING the context until they were — never by adding the
   file's line delta, which is the offset rule this document has refused four
   times. The seven unanchored ones gained an `#anchor` while they were being
   repointed, which is why `MAX_UNANCHORED_CITATIONS` measures 6427 against a
   ceiling of 6434 rather than sitting on it. **The three ratchet constants in
   `scripts/check-doc-citations.mjs` were not edited** and neither was the
   ceiling in the citation-targets checker beside it: `check:citation-targets`
   ends where it began, at 294 of 294. (That checker is named here WITHOUT its
   filename on purpose — it is machinery this census does not grade, and the
   one machinery path `check:census-scope-coverage` exempts by name is the
   doc-citations script. Spelling the other one would spend a point of this
   census's coverage headroom on a file nobody grades.)

   **SIX OF THE SEVENTY-THREE ARE IN THREE OTHER CENSUSES AND THIS LANE MOVED
   THEM.** Four in `census-highlights-memories.md` (the elected-stamp seam in
   `routes/airport.ts`), one in `census-sensing.md` (`readLayoverLive`) and one
   in `census-trips.md` (the return-now capability in the client service). Each
   is a one-line, exact-text repoint of a pointer this pass's own edits
   displaced, made rather than left, because a stale pointer in someone else's
   document is still a stale pointer — and it is named here so the lanes that
   own those documents can see a line they did not write.

### 18.11 Recomputed headline

Same 296 denominator, same counting rule, same prohibition rule. This supersedes
the §17 headline.

| Measure | At `a5c223a37` (§17) | Now (`060027b0b`) |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 60 | **61** |
| BUILT-BUT-WRONG | 126 | **136** |
| NOT-BUILT | 110 | **99** |
| CANNOT-VERIFY | 0 | **0** |
| Sum | 296 | **296** |
| CONSTRUCTED% | 62.8 % | **66.6 %** (197 / 296 = 66.6 %) |
| CORRECT% raw | 20.3 % | **20.6 %** (61 / 296 = 20.6 %) |

> **CONSTRUCTED moves for the first time in five passes — 3.8 points, eleven
> rows — and the honest reading is that this is what a MEASUREMENT ERROR is
> worth, not what a month of building is worth.** Six of the eleven (L13, L56,
> L57, L59, L177, L178) moved because a generalised engine that had been in the
> tree the whole time finally had an adapter; the code it needed was one file.
> The other five are a genuine build (L50, L61, L63, L66) and a genuine test
> artifact (L219, L220).
>
> **CORRECT moves by one row, and the gap between the two columns WIDENS**, from
> 42.5 points to 46.0. That is the correct shape for a pass that constructed
> more than it certified, and it is the number to watch: eleven more requirements
> now have code, and ten of the eleven have code that diverges from what was
> asked. Every one of those ten says where, in its own row.
>
> **What a traveller actually gets out of this pass is two sentences and one
> absence.** They are told how many minutes short their layover is when it has
> no window at all, which nothing anywhere could say before. And they stop being
> offered a place two hundred kilometres away that the query matched on a city
> name — not rated `not_recommended` and left on the screen with an "Add to plan"
> button, but gone.

---

## §19 — five refusals the server could not previously make, and no verdict moved

This pass took the BUILT-BUT-WRONG list and worked the rows whose gap is
*code at this tree* rather than a migration, a flag or an owner decision. It
built six things, wired every one of them to a caller a traveller reaches, and
proved each with a test watched RED first and then mutated. **It moves no
verdict.** Every row it touched stays `W`, because in each case the row's
REQUIREMENT is wider than the part that closed, and the part that closed is
named below rather than rounded up.

That is the honest shape of the result and it is stated first so the rest reads
against it: **six builds, nineteen mutations, sixty-eight new assertions, zero
`W → C`.**

> **BUILT ON A WORKTREE. NOT MERGED, NOT DEPLOYED, NOT FLAG-GATED (none of it
> is behind a flag; all of it is behind a merge).** Nothing in this section is
> in production. The measurements below are `node --test` runs in
> `/home/user/wt-483`, not observations of a running service.

### 19.1 What was built, and the caller each thing reaches

| # | census row(s) | what was built | the caller |
| --- | --- | --- | --- |
| 1 | L294 | `layover_sessions` writers distinguish "the database refused the write" from "there is no such live session" | `PATCH`/`DELETE /airport/sessions/:id`, `PATCH /:id/share`, `POST /:id/return-deadline`, `POST /airport/sessions` |
| 2 | L294 | `cityPresence` reports WHICH read failed, and the disclosure carries it | `GET /airport/sessions/:id/presence` |
| 3 | L18 | a §15 notification-priority ladder, in the app's own `NotificationPriority` vocabulary | `safeReturnPosture` → `/safety`, `/return-deadline`, `/overview` |
| 4 | L273, L254 | the layover buddy list is gated on the CERTIFIED verdict, bounded to layover-compatible services, and requires a verified non-new buddy on a tight window | `GET /airport/sessions/:id/buddies` |
| 5 | L101, L3 | Compass may no longer assert entry permission, and may not talk the certified risk band upward | `POST /airport/sessions/:id/compass` |
| 6 | L63, L37 | the safe envelope grows a second edge that CONTRACTS as the certified confidence band drops | `safeEnvelopeFor` → `/safety`, `/overview` |

### 19.2 L294 — a traveller at the gate was told their layover did not exist

§13.5 and §18 both re-counted this row's evidence and both left it: *"Seven
[six] bare `catch { return … }` blocks remain in `LayoverSessionService.ts`."*
Counting them was the smaller half of the finding. Underneath every one of them
stood the same line:

```
if (error || !data) return null;
```

— so a database that could not take the write and a session that does not exist
were **the same value**, and every route turned that value into
**404 `"Session not found or already closed"`**. On `DELETE` that told a
traveller standing at their gate that the layover they were looking at did not
exist; on `PATCH` it told them their edit had been rejected as stale. The server
had learned nothing about the row in either case.

`SessionWrite`
(`artifacts/api-server/src/services/airport/LayoverSessionService.ts:325#SessionWrite`)
is the write counterpart of the `SessionRead` the read half already had. The six
bare catches are gone — all six were dead code by the measurement this file's
own `getSession` records (supabase-js resolves on database AND network errors),
and the mutation log below shows the live swallow was the `if (error || !data)`,
not the catch. Routes answer `degraded_unavailable` (503, retryable) when the
statement failed and keep the 404 for the case the database actually answered.

`cityPresence` (`artifacts/api-server/src/routes/airport.ts:1911#cityPresence`)
is the second half. It still serves nobody when a read fails — for a presence
surface the empty answer is the safe one — but the zero is no longer reported as
a measurement: `degraded` is true and `degradedReasons` names
`presence_unreadable`, `blocks_unreadable`, `sharing_preferences_unreadable` or
`traveller_cards_unreadable`. That is C2's second clause, *"degraded
confidence"*, which the row's own evidence said **"exists nowhere"**.

**WHY THE ROW STILL DOES NOT MOVE.** C2 is a cross-cutting rule over every read
in the surface, and three things are still true of it:

1. `expireOldSessions` now answers `number | null` so a failed sweep is not a
   counted zero — and **both callers ignore the return value entirely**
   (`routes/airport.ts`, the `/sessions` and `/sessions/active` handlers), so
   at the route the failed sweep is still invisible.
2. Four bare catches remain in `services/safeReturn/` (the Safe Return PRODUCT,
   not the layover surface). They are in this lane's ownership and were left:
   they belong to a different census's subject.
3. The swallows this pass enumerated are the `catch` ones. A read that returns
   `?? []` on an unbound error is the same defect without the keyword, and no
   exhaustive sweep of THAT shape was done. Claiming `C` would be claiming a
   sweep that was not run.

### 19.3 L18 — the four §15 rungs were the same message to the pipeline

L18's `W` names two gaps: *"there is no escalation ladder and no notification
priority."* §13/§17 built the ladder's consequences (`safeReturnPosture`). The
second gap was untouched, and it was not cosmetic.

`NotificationPreferenceService.filterChannels` is the code that decides whether
a message reaches a traveller at all, and its rule is

```
const isSafetyCritical = priority === 'urgent' || category === 'admin';
if (prefs.quietHoursEnabled && !safetyOverrideApplies && isQuietHour) → drop push
```

The layover surface carried no priority anywhere. So "you must leave for the
airport NOW" and "here are some ideas" were the same message to that filter, and
a traveller with quiet hours enabled — whose default window is 22:00–08:00,
i.e. exactly a night layover — would have received **neither**.

`RETURN_ESCALATION_LADDER`
(`artifacts/api-server/src/services/airport/LayoverReturnEscalation.ts:114#RETURN_ESCALATION_LADDER`)
is total over `LayoverReturnState`, strictly increasing in level, non-decreasing
in priority, and spends `urgent` only from RETURN_NOW — because an `urgent`
priority overrides a traveller's own push settings and spending it on a
thirty-minute warning is how the override stops meaning anything by the time it
matters. It is asserted THROUGH the real preference service rather than by
comparing strings: the question the test asks is not "does it say urgent", it is
"does the push survive quiet hours".

It recomputes nothing, and that is enforced rather than described — the test
reads the module's import lines for `computeReturnDeadline`, `computeWindow`,
`computeBuffer`, `certifySessionFeasibility` and `assess`, which is L18's
"must not recompute core feasibility" made executable.

**WHY THE ROW STILL DOES NOT MOVE.** Nothing sends. Whether the return reminder
is server-pushed or scheduled locally by the client is the open owner decision
`LAYOVER_RETURN_REMINDER_DELIVERY`, and this resolves none of it: the rung is
published on the wire so the client and any future sender read one ladder, and
`delivery: "not_sent_here"` says so on every response. A priority that governs
no message that is actually sent is the same reachability limit this document
scores `W` everywhere else (L133–L135, L137, L139, L156, L157). **L41 is
untouched for the same reason** — its notification half needs a sender.

### 19.4 L273 / L254 — the list of people to go and meet, offered to a traveller who cannot leave

`GET /airport/sessions/:id/buddies` filtered on `status='active'`, city, blocks
and (since §13) the marketplace master flag, and on nothing about the layover.
So a traveller whose certified window said `verdict: "no"` — they cannot leave
the airport and get back in time — was handed a list of people to go and meet in
the city, **by the same server that had already computed that verdict for that
session in that request**.

`layoverBuddyDecision`
(`artifacts/api-server/src/services/airport/LayoverBuddyGate.ts:112#layoverBuddyDecision`)
runs before the profiles are read, which is §9.1's *"HARD GATE … before any
optimisation"* read as an ORDER and not only as a rule. The gate is the
CERTIFIED verdict — one `certifySessionFeasibility` — so the list and the
countdown on the same screen cannot disagree.

It is a service and not ten lines in the handler for a stated reason:
`src/test/layoverFeasibilityRecord.test.ts` ratchets `certifySessionFeasibility`
to one call per NAMED handler in `routes/airport.ts`, and that list is a
deliberate act to extend. Certifying inside a service keeps "the route consults
the certified record and nothing else" true, which is what that ratchet
protects. **The named list does not mention `/buddies`; whoever owns that file
may want it to.**

**WHY L273 DOES NOT MOVE.** Its second gap is *"no layover-specialist category
filter"*, and there is no `layover` member in `rent_buddy_profiles.categories`
anywhere in this repository — the vocabulary is city / language / arrival /
shopping / content, plus nightlife / group / concierge / packages
(`artifacts/api-server/src/routes/rentABuddyRollout.ts:41#MVP_ALLOWED_CATEGORIES`).
What shipped is a COMPATIBILITY filter over the vocabulary that exists: a
profile that positively declares an unrelated service is removed, a profile that
declares nothing is kept and marked `layoverCompatible: false`. Filtering on a
value no profile can hold and no admin surface can grant would be an empty list
wearing the name of a boundary.

**WHY L254 DOES NOT MOVE.** Only one of its two arms shipped. High risk is read
off the engine's own words, and the deterministic arm is `verdict === "tight"`.
The obvious second arm is the night layover — `RiskyLayoverContext.isNightLayover`
names it and the buffer already computes the band — and it is **deliberately not
shipped**: every formulation of it is a function of the wall clock at request
time, and **src/test/layoverBuddiesMasterFlag.test.ts** stages its positive
control eight hours from `Date.now()`. Shipping the night arm makes that suite
pass in the morning and fail in the evening. A nondeterministic red in another
lane's file is not a closed row. **The fixture needs pinned times first; that is
the cross-lane request in 19.8.**

### 19.5 L101 / L3 — the model could still tell a traveller they did not need a visa

§18 built `enforceCompassEnvelope` and closed two of L101's five nouns: the
RETURN DEADLINE and the usable window. The census named the worst of the
remaining three exactly:

> *"Visa/entry is not a field at all on main, so a model assertion about it is
> unconstrained by anything."*

`adviseLeaving` emits `ENTRY_NOT_CONFIRMED` on **every** session on this tree,
and carries "Visa or transit-permit requirements for your nationality" as a
standing unknown. A model answering *"you won't need a visa for a short visit"*
contradicted the server's own certified unknown, on the one question whose wrong
answer ends with a traveller refused at a border.

Two checks were added to the same guard
(`artifacts/api-server/src/services/airport/LayoverCompassService.ts:430#COMPASS_BOUNDARY_KINDS`):

- `entry_status_asserted` — an entry/visa/permit sentence trips unless it is
  hedged by an admission of not knowing or an instruction to verify. `may`,
  `might` and `could` are deliberately NOT hedges here: *"you may enter without
  a visa"* is the assertion the guard exists to catch.
- `risk_band_widened` — one-directional by construction. Talking the band DOWN
  is always allowed; an explicit permission phrase on a session the record did
  not certify as `yes` is refused.

**A second defect was found and fixed on the way.** This file imported the bare
`openai` client rather than `getOpenAI()`, so the seam **lib/openai.ts** provides
for tests could not reach it — which meant the §12 boundary had only ever been
exercised against strings handed to it directly, and **nothing proved the
production path passed the certified verdict to it**. A mutation confirmed that:
deleting `verdict: record.verdict` at the call site left 27 existing assertions
green. The path is now driven with an injected model answer.

**WHY THE ROW DOES NOT MOVE.** Four of L101's five nouns are enforced. The
fifth, **operational state**, is not: a model that asserts the security queue is
short, or that a terminal transfer is running, is still unconstrained, and there
is no certified operational state to compare it against
(`terminal_info` is null on all 3,206 production airports, L143).

**AND ONE PIECE OF THIS ROW'S EVIDENCE IS NOW FALSE** — see 19.7.

### 19.6 L63 / L37 — the edge that reads the confidence band

§18 closed L63's risk half and stated the other exactly: *"It does NOT contract
on confidence: `confidence` is carried on the window and no edge reads it. Half
the requirement."* It also left L37 with *"nothing consumes the value and no
decision turns on it"*. An edge that moves when the band moves is a consumer.

`ENVELOPE_UNCERTAINTY_BUDGET`
(`artifacts/api-server/src/services/airport/LayoverEnvelope.ts:132#ENVELOPE_UNCERTAINTY_BUDGET`)
holds back 0 / 10 / 25 / 100 % of the certified window at HIGH / MEDIUM / LOW /
INSUFFICIENT, and `plannedRadiusMetres` is the edge cut from what is left. It is
wired at the ONE construction site
(`artifacts/api-server/src/routes/airport.ts:1753#function safeEnvelopeFor`)
from `record.confidence`, so the envelope and the verdict in the same response
cannot be hedged against different uncertainty. Every production session on this
tree certifies LOW, so the contraction is live on every session rather than
theoretical.

**THE PROVED EDGE DOES NOT MOVE, AND THAT IS THE DESIGN.** `radiusMetres` is a
proof — outside it, `2 × lowerBound(distance) > usableMinutes` and no route at
any speed fits. Shrinking THAT on a confidence band would declare points
infeasible that are not provably infeasible, and `certifiedOutward` would
quietly become false. This module's discipline is "no proof, no block", so a
candidate between the two edges is FLAGGED (`withinPlannedEdge: false`, with the
band named) and never blocked. The test pins both halves: the planned edge
contracts monotonically, the proved edge is identical across all four bands.

**WHY NEITHER ROW MOVES.** L63 asks that the envelope's edges contract as
confidence drops. The edge that contracts is the PLANNING edge; the edge that
BLOCKS still contracts only on risk. A reader who takes "the envelope" to mean
the blocking edge is reading the row correctly and would not accept this as
closed, so it is not claimed. L37 gains a consumer and still has no
`confidence_band` column (L21) and no stored decision that turns on it.

### 19.7 Evidence corrected — three rows whose citations no longer describe the tree

| id | the sentence | what is true at this commit |
| --- | --- | --- |
| L101 | *"And the whole endpoint is unreachable from the app (headline defect 4), so the contract governs a surface no user can reach."* | **False since §10.** `askCompass` has an importer and `LayoverCompassCard` is mounted — that is precisely why §10 moved L114 to `C`. §13.5 recorded the same correction for L268 and L100 and did not carry it to L101. The verdict does not move (the row is `W` on the prose boundary, and 19.5 leaves operational state open), but the reachability clause of its evidence is stale. |
| L100 | its evidence cites the context build and the deterministic fallback in `LayoverCompassService.ts` by line range | Both ranges are four passes old and now point at unrelated code; the context build and the fallback have each moved by more than sixty lines. §13.5 already corrected the row's FIRST clause ("asks no clarifying question") and left its citations. The verdict is unmoved and unmovable here: the two remaining clauses ("compares no plans", "invokes no tool") are true, and the tool half is the L102–L113 flag decision. |
| L294 | *"Seven bare `catch { return … }` blocks remain in `LayoverSessionService.ts` (`:187, 229, 255, 367, 387, 416`)"* — corrected to **six** by §13.5 and re-measured as six by §18 | **Zero.** All six are gone, and the mutation log shows why the count was never the finding: restoring a bare catch is caught by a source guard, but the behaviour that reached a traveller was the `if (error \|\| !data)` beneath it. |

### 19.8 What this pass could not do, by name

**BLOCKED ON A FILE THIS LANE DOES NOT OWN.** Each of these is a concrete,
mechanical edit; none is a judgement call.

1. **`artifacts/api-server/package.json`** — six new test files exist under
   `src/services/airport/__tests__/` and are not in the curated `test` script,
   so `check:test-registration` names them. Three other lanes' new suites are in
   the same state at this commit. They must be registered or they never run.
2. ****src/test/layoverBuddiesMasterFlag.test.ts**** — its positive control
   stages a session eight hours from `Date.now()`. Pin those times and the
   night-layover arm of L254 (19.4) can ship.
3. **`src/test/layoverFeasibilityRecord.test.ts`** — `FEASIBILITY_HANDLERS`
   does not name `/airport/sessions/:id/buddies`, which now needs feasibility.
   Nothing is red; the list is simply less complete than it reads.
4. **`docs/architecture/census-compass.md` and
   `docs/architecture/census-highlights-memories.md`** — eight anchored
   citations into files this pass edited now point at moved lines. The
   replacements are printed verbatim by `check:doc-citations` at this commit
   and are deliberately NOT restated here as `file:line` pairs — a stale line
   number written down in a second document is a second thing to rot. Run the
   check and take the eight "the WHOLE anchor is at" lines it prints for those
   two files. **The 61 anchors this pass broke in THIS
   document were repaired here**, and the delta against a tree with this pass's
   source files reverted is zero.
5. **`src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` or this row's
   `head_commit`** — `check:census-freshness` already reported this census STALE
   before this pass (it names `compass/CompassTools.ts`, which no lane here
   touched). This pass adds five more counted files. Whoever commits must
   re-declare `head_commit` or extend the acknowledgement; this lane cannot,
   because it runs no git write and the commit does not exist yet.
   `travel-buddy-standalone/src/components/layover/__tests__/LayoverSafeReturnCard.component.test.tsx`,
   which that file names today, was **not** touched.

**BLOCKED ON SOMETHING THAT IS NOT CODE.** Opened, confirmed still blocked, and
left: L1/L5/L6/L191/L197/L206/L207/L238/L240/L263 and L21/L26/L31/L192/L195/L194/
L198/L259/L199/L200/L20/L35 (migrations 2700/2860 or a new one this lane may not
write); L102–L113 and L128 and L33/L147 and L97/L296 (flag decisions);
L243/L249 and L50 and L77 (owner decisions, §17.8 item 1 and §8's `L50-a`).
**That is more than the "roughly fifteen" a reader of the `W` list would
estimate: counting only the rows whose own last statement names a migration, a
flag or an owner as the blocker, it is thirty-nine.**

**BLOCKED ON OWNERSHIP, NOT ON DIFFICULTY.** L17 — the map card can now consume
a published envelope, but the field reaches it through
`travel-buddy-standalone/src/services/layover.ts` and
`travel-buddy-standalone/app/layover/[id].tsx`, neither of which is this lane's.
The server half exists and is on the wire; the client half is one prop.

### 19.9 The mutations

Every build below was watched RED first. These are the mutations run against the
implementation AFTER it was green, with the test re-run each time and restored.

| # | mutation | result |
| --- | --- | --- |
| 1 | `updateSession` returns `{ ok: true, session: null }` on a refused UPDATE | 2 failed |
| 2 | `DELETE /sessions/:id` answers 404 instead of 503 on a refused write | 1 failed |
| 3 | a bare `catch {}` restored in `routes/airport.ts` | 1 failed |
| 4 | `cityPresence` returns a silent `empty` on an unreadable `layover_sessions` | 1 failed |
| 5 | …on an unreadable `blocks` | 1 failed |
| 6 | RETURN_NOW's priority downgraded `urgent` → `important` | 1 failed |
| 7 | `safeReturnPosture` pins the rung at NORMAL | 1 failed |
| 8 | the buddy safety gate always passes | 2 failed |
| 9 | the buddy trust requirement is never applied | 2 failed |
| 10 | the category filter keeps every profile | 1 failed |
| 11 | an unreadable `rent_buddy_profiles` serves `ok: true, buddies: []` again | 1 failed |
| 12 | the Compass entry check is skipped | 5 failed |
| 13 | the risk-band check fires on `yes` as well | 1 failed |
| 14 | `verdict: record.verdict` deleted at the Compass call site | 1 failed — **and 27 existing assertions stayed green, which is why the reachability case was added** |
| 15 | the LOW uncertainty budget set to 0 | 4 failed |
| 16 | the PROVED radius shrinks with the budget too | 2 failed |
| 17 | `record.confidence` not passed at `safeEnvelopeFor` | 1 failed |
| 18 | a confidence haircut produces a `BLOCKED` band | 2 failed |
| 19 | `routes/airport.ts` re-bound to the two compatibility shims | 2 failed |

### 19.10 The evidence, by file

Six new server suites, sixty-eight assertions, all under
`artifacts/api-server/src/services/airport/__tests__/` — the directory this
census already watches, so a test cited as evidence here cannot change under its
own verdict without the guard noticing.

| suite | rows it is evidence for |
| --- | --- |
| `artifacts/api-server/src/services/airport/__tests__/layoverSessionWriteFailClosed.test.ts` | L294 — the write half, and the no-bare-catch guard over both files |
| `artifacts/api-server/src/services/airport/__tests__/layoverPresenceDegraded.test.ts` | L294 — degraded confidence on the presence read |
| `artifacts/api-server/src/services/airport/__tests__/layoverReturnEscalation.test.ts` | L18 — the rung ladder, measured through the real preference service |
| `artifacts/api-server/src/services/airport/__tests__/layoverBuddySafetyGate.test.ts` | L273, L254 — the gate, the boundary, the trust requirement |
| `artifacts/api-server/src/services/airport/__tests__/layoverCompassEntryBoundary.test.ts` | L101, L3 — entry assertions and the risk band, including the production path |
| `artifacts/api-server/src/services/airport/__tests__/layoverEnvelopeConfidence.test.ts` | L63, L37 — the contracting planning edge and the immovable proved edge |

**NONE OF THEM RUNS IN CI YET.** `artifacts/api-server/package.json`'s `test`
script is a curated list and this lane does not own that file; see 19.8 item 1.
Every count in 19.9 is a local `node --test` run.

### 19.11 Headline

**UNCHANGED.** Same 296 denominator, same counting rule. No verdict moved, so
the §18 headline stands exactly:

| Measure | §18 (`060027b0b`) | §19 |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 61 | **61** |
| BUILT-BUT-WRONG | 136 | **136** |
| NOT-BUILT | 99 | **99** |
| CANNOT-VERIFY | 0 | **0** |
| CONSTRUCTED% | 66.6 % | **66.6 %** |
| CORRECT% raw | 20.6 % | **20.6 %** |

> A pass that builds six things and moves no row is not a failed pass and it is
> not a wasted one — it is what this census looks like when the cheap rows are
> already gone and the remaining `W`s are `W` for more than one reason each.
> Five of the six builds are REFUSALS: the server now declines to say a layover
> does not exist when it cannot read the table, declines to offer a stranger to
> a traveller who cannot leave, declines to publish a model sentence about a
> visa, declines to report an unreadable city as an empty one, and declines to
> plan out to an edge its own confidence does not support. None of those
> refusals closes a requirement on its own. Every one of them is a sentence the
> product can no longer say to somebody who would have acted on it.

## §20 — the failing-first proof §19 never recorded, and three tests that could not fail

The container this worktree runs in restarted and killed the lane agent that
wrote §19. Its work survived on disk and was committed at `88b9e8e1a`; its
EVIDENCE did not. The integration owner ran the six new suites before committing
and got **68/68 across 23 suites** — which is a pass, not a proof. Nobody had
mutated a single implementation to check that any of those 68 assertions can go
red.

This section is that check, re-executed from scratch rather than copied from
§19.9. **It moves no verdict and builds nothing.** Its whole subject is whether
the tests §19 leans on are load-bearing.

> **STILL ON A WORKTREE. NOT MERGED, NOT DEPLOYED, NOT FLAG-GATED.** Every count
> below is a `node --test` run in `/home/user/wt-483`, and the six suites are
> STILL not in `artifacts/api-server/package.json`'s curated `test` script, so
> none of this runs in CI yet. See 19.8 item 1, which is unchanged and still the
> integration owner's to act on.

### 20.1 The result first

**Thirty-nine mutations across eight implementation files. Thirty-six turned a
test red for the reason the test claims. THREE DID NOT, and all three were
tests of mine that could not fail.** They are named in 20.3, repaired, and the
mutation that exposed each was re-run against the repair.

The suites are now **70/70 across 23 suites** — two assertions more than the
integration owner measured, because two of the three repairs added coverage
rather than only tightening a regex. `tsc --noEmit` exits 0.

Every implementation file was restored from a byte-for-byte backup after each
mutation and verified against `git show HEAD:<path>` at the end: all eight are
IDENTICAL to `88b9e8e1a`. The only files this pass changed are three test files.

### 20.2 The mutations

Each row is one edit to production code, the suite re-run, and the file
restored. "red" names the assertion that caught it.

| # | file | mutation | result |
| --- | --- | --- | --- |
| 1 | `LayoverBuddyGate.ts` | `safetyGate.passed` hard-coded `true` | **2 red** — "a traveller who cannot leave must not be offered someone to leave with" |
| 2 | `LayoverBuddyGate.ts` | `const tight = record.verdict === "tight"` → `false` | **2 red** — the trust requirement is never applied |
| 3 | `LayoverBuddyGate.ts` | `filterLayoverCompatible` keeps every row | **1 red** — "a nightlife/packages-only profile is not a layover service" |
| 4 | `LayoverBuddyGate.ts` | trust filter drops the `buddy_level !== "new"` clause | **1 red** — a brand-new buddy is served on a tight window |
| 5 | `routes/airport.ts` | unreadable `rent_buddy_profiles` serves `ok:true, buddies:[]` | **1 red** — "expected 503, got 200" |
| 6 | `LayoverCompassService.ts` | the entry-assertion loop iterates an empty array | **6 red** — five refusal cases and the production path |
| 7 | `LayoverCompassService.ts` | risk-band check runs on `yes` verdicts too | **1 red** — "the guard must not refuse an answer that agrees with the record" |
| 8 | `LayoverCompassService.ts` | `ENTRY_HEDGE` ignored | **2 red** — false positives on the server's own honest wording |
| 9 | `LayoverCompassService.ts` | `verdict: record.verdict` deleted at the call site | **1 red** — "the certified verdict must reach the guard" |
| 10 | `LayoverCompassService.ts` | the §18 usable-time check disabled | **1 red** — the §18 checks are still pinned |
| 11 | `LayoverCompassService.ts` | a fifth kind added to `COMPASS_BOUNDARY_KINDS` | **1 red** — the vocabulary is counted, not sampled |
| 12 | `LayoverEnvelope.ts` | `LOW` budget set to 0 | **4 red** — "a contraction that never contracts is not a contraction" |
| 13 | `LayoverEnvelope.ts` | the PROVED `radiusMetres` cut from the planned minutes | **2 red** — "the proved outer bound moved with confidence" |
| 14 | `LayoverEnvelope.ts` | `!withinPlannedEdge` added to the BLOCK condition | **1 red** — "a confidence haircut may never produce a BLOCK" |
| 15 | `routes/airport.ts` | `record.confidence` not passed at `safeEnvelopeFor` | **1 red** — the wired edge stops contracting |
| 16 | `routes/airport.ts` | unreadable `layover_sessions` returns a silent `empty` | **1 red** — "the zero must not be reported as a measurement" |
| 17 | `routes/airport.ts` | unreadable `blocks` returns a silent `empty` | **1 red** — `blocks_unreadable` is never named |
| 18 | `LayoverPrivacyGuard.ts` | `disclosePresence` ignores `presenceRead` | **2 red** — the gate's degradation is not the read's |
| 19 | `routes/airport.ts` | the `empty` constant claims `degraded: true` | **GREEN — see 20.3 (a)** |
| 20 | `LayoverPrivacyGuard.ts` | `presenceRead` forced degraded | **4 red** — both positive controls hold |
| 21 | `LayoverReturnEscalation.ts` | RETURN_NOW `urgent` → `important` | **1 red** — "a traveller who must leave NOW is not told 'quiet hours'" |
| 22 | `LayoverSafeReturnService.ts` | posture pinned at `NORMAL` | **1 red** — `'low' !== 'urgent'` on a session past its hard return |
| 23 | `LayoverReturnEscalation.ts` | CONNECTION_AT_RISK level 3 → 1 | **2 red** — "level 1 did not increase past 2" |
| 24 | `LayoverReturnEscalation.ts` | `computeWindow` imported into the ladder | **1 red** — L18's "must not recompute core feasibility" |
| 25 | `LayoverReturnEscalation.ts` | the wire posture publishes no channels | **1 red** — the overview's rung loses its channels |
| 26 | `LayoverReturnEscalation.ts` | NORMAL `low` → `urgent` | **GREEN on the quiet-hours test — see 20.3 (b)** |
| 27 | `LayoverReturnEscalation.ts` | the NORMAL rung deleted from the ladder | **4 red** — totality, ordering, and the calm posture |
| 28 | `LayoverReturnEscalation.ts` | RETURN_SOON `important` → `urgent` | **1 red** (after the 20.3 (b) repair) — "a thirty-minute warning must not spend the override" |
| 29 | `LayoverSafeReturnService.ts` | posture pinned at `RETURN_NOW` | **1 red** — a calm session is shouted at |
| 30 | `LayoverSessionService.ts` | `updateSession` swallows the write error | **2 red** — service and route, 404 instead of 503 |
| 31 | `LayoverSessionService.ts` | `endSessionWrite` swallows | **2 red** — `DELETE` answers 404 on a refused close |
| 32 | `LayoverSessionService.ts` | `updateSession` reports a MISSING row as a refusal | **1 red** — "an empty table is a successful read of an empty table" |
| 33 | `LayoverSessionService.ts` | `createSessionWrite` swallows a failed INSERT | **1 red** |
| 34 | `LayoverSessionService.ts` | `setShareStatus` swallows | **2 red** — service and the `PATCH /share` wire |
| 35 | `LayoverSessionService.ts` | `setReturnReminder` swallows | **1 red** |
| 36 | `routes/airport.ts` | a bare `} catch {` restored on one line | **1 red** |
| 37 | `routes/airport.ts` | the same bare catch written as `}\n  catch {` | **GREEN — see 20.3 (c)** |
| 38 | `LayoverSessionService.ts` | a bare `catch {` on its own line | **1 red** |
| 39 | `routes/airport.ts` | the `createSession` shim re-imported | **1 red** — "routes must not bind the createSession shim" |

Mutation 38 was run in two shapes. The multi-line one reddened; the SAME
construct written inline (`try { … } catch { … }` on one line) did not, which is
the third finding in 20.3.

### 20.3 The three that did not redden

**(a) `cityPresence`'s `empty` constant was pinned in one direction only.**
Mutation 19 made every genuinely-empty answer claim `degraded: true` and all
five assertions stayed green. Every test in that suite leaves `cityPresence`
through its final return or through `refuse(...)`; none left through `empty`.
The DANGEROUS direction — an outage reported as a measured zero — was covered.
The other direction was not, and it is not cosmetic: a city where nobody is
sharing is a measurement the server is entitled to stand behind, and a
`degraded` flag that also fires on honest zeros is a flag clients stop reading.
**Repaired by adding an assertion** ("a genuinely empty city is a MEASURED zero,
not a degraded one") that drives a SUCCESSFUL read matching nobody. Mutation 19
re-run: red.

**(b) the quiet-hours test asked a question its own fixture answered.**
`a NORMAL-rung push is correctly suppressed inside quiet hours` passed
`[...rung.channels]` to `filterChannels` — and the NORMAL rung asks for `in_app`
ONLY. So "push was dropped" held because there was no push to drop, and
mutation 26 (NORMAL's priority `low` → `urgent`) left it green. The test named
the priority and measured the channel list. **Repaired** by requesting
`["in_app", "push"]` explicitly so that only `rung.priority` can decide, and by
adding the same assertion one rung up (RETURN_SOON must not buy the override
either). Mutations 26 and 28 re-run: red.

**(c) both bare-catch guards were line-shaped regexes, and syntax is not lines.**
`routes/airport.ts`'s guard required `}` and `catch` on the SAME line
(`/}\s*catch\s*\{/`), so `}\n  catch {` walked through it. `LayoverSessionService`'s
guard anchored on end-of-line (`/catch\s*\{\s*$/`), so an inline
`try { … } catch { … }` walked through that one. Neither evasion is exotic —
both are how a person writes code without meaning anything by it, which is the
case a guard has to survive. **Repaired**: both now strip comments and then
match `/\bcatch\s*\{/` over the whole file, so the rule is shaped like the
syntax it polices rather than like the formatting it happened to meet.
Mutations 36, 37 and 38-inline re-run: all red.

> This is the fourth, fifth and sixth time this programme has found a test that
> could not fail, and the pattern in all three is the same one §19 warned about
> in its own §12 finding: **the test measured a proxy for the claim instead of
> the claim.** A channel list instead of a priority; a formatting convention
> instead of a keyword; one direction of a two-directional rule. None of them
> was a careless test — each was a careful test of the wrong quantity.

### 20.4 What this changes about §19

Nothing in §19's verdicts, and one thing in how §19.9 should be read. §19.9's
nineteen mutations are the previous agent's record and are NOT re-verifiable —
that agent is gone and no output survived. The table in 20.2 supersedes it as
this document's mutation evidence: it is larger (39 vs 19), it was executed at
this commit, and it names three failures §19.9 does not, which is the strongest
evidence available that the two runs were genuinely independent.

**The six suites STILL do not run in CI.** Everything in §19 and §20 is a local
measurement until `artifacts/api-server/package.json` registers them. The exact
list, confirmed at this commit — all six are under
`src/services/airport/__tests__/`, and **none is under `src/services/safeReturn/__tests__/`,
which does not exist** (`LayoverReturnEscalation` is filed beside the layover
posture that consumes it, for the reason its own file header gives):

```
src/services/airport/__tests__/layoverBuddySafetyGate.test.ts
src/services/airport/__tests__/layoverCompassEntryBoundary.test.ts
src/services/airport/__tests__/layoverEnvelopeConfidence.test.ts
src/services/airport/__tests__/layoverPresenceDegraded.test.ts
src/services/airport/__tests__/layoverReturnEscalation.test.ts
src/services/airport/__tests__/layoverSessionWriteFailClosed.test.ts
```

### 20.5 Headline

**UNCHANGED, and this section could not have changed it** — it moved no row and
built no behaviour.

| Measure | §19 | §20 |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 61 | **61** |
| BUILT-BUT-WRONG | 136 | **136** |
| NOT-BUILT | 99 | **99** |
| CANNOT-VERIFY | 0 | **0** |
| CONSTRUCTED% | 66.6 % | **66.6 %** |
| CORRECT% raw | 20.6 % | **20.6 %** |

## §21 — L294 swept rather than counted, and the one swallow the sweep found that reading never did

§20 re-established the proof for §19's work. This section continues the list,
and it spends the whole pass on ONE row — census **L294**, C2:

> *"Never swallow a schema/data error into plausible empty operational state
> **without structured logging and degraded confidence**."*

L294 was chosen because §19.2 did the rare thing of naming its own remaining
gap in three specific, checkable sentences instead of a summary. All three are
now done. **The row still does not move, and 21.6 says exactly what is left and
why a sweep cannot reach it.**

> **BUILT ON A WORKTREE. NOT MERGED, NOT DEPLOYED, NOT FLAG-GATED** (none of it
> is behind a flag; all of it is behind a merge). Every measurement below is a
> `node --test` run in `/home/user/wt-483`.

### 21.1 The three things §19.2 said were still true, and what happened to each

| # | §19.2's own words | at this commit |
| --- | --- | --- |
| 1 | *"`expireOldSessions` now answers `number \| null` … and **both callers ignore the return value entirely**, so at the route the failed sweep is still invisible."* | **CLOSED.** Both routes publish it, with a measurement beside it (21.2). |
| 2 | *"Four bare catches remain in `services/safeReturn/` … they belong to a different census's subject."* | **RE-MEASURED, and §19 was wrong about them.** Three of the four bind and LOG their error at the read; the bare `catch` beneath is the throw path with an honest fallback string. The subject argument was not needed. But the sweep found a swallow in that directory that `grep catch` could never have: `expireShare`'s `if (error || !data) return null` (21.4). |
| 3 | *"A read that returns `?? []` on an unbound error is the same defect without the keyword, and **no exhaustive sweep of THAT shape was done**. Claiming `C` would be claiming a sweep that was not run."* | **THE SWEEP WAS RUN, and it is now a test rather than a thing a pass did once** (21.3). 84 supabase reads; zero unbound; zero bound-and-unread; one tested-and-discarded, fixed in 21.5. |

### 21.2 The expiry sweep, and a stale layover served as a live one

`expireOldSessions` is what retires a session whose flight has already gone.
§19 made it answer `null` rather than `0` when it could not run, and then both
callers threw that value away — so at `GET /airport/sessions?status=active` and
`GET /airport/sessions/active` a failed sweep looked exactly like a sweep that
found nothing to do.

The rows it would have retired stay `active`, and those two endpoints serve
them. `/sessions/active` is the one that matters: its `session` is what mounts
the entire Layover surface, hard-return countdown included. **A countdown to a
flight that has already departed is the most confident lie this surface can
tell**, and nothing in the response could say the sweep behind it had failed.

`expirySweepDisclosure`
(`artifacts/api-server/src/services/airport/LayoverSessionService.ts:499#expirySweepDisclosure`)
publishes it, and adds the one thing the server can honestly measure: how many
of the rows it is about to serve as live have a departure time already in the
past. A sweep that RAN degrades nothing — including a sweep that expired zero,
because that is a measurement and degrading on it is how a degraded flag stops
being read. A departure that does not parse is not counted as past.

**It is not a 503, deliberately.** The list is readable and mostly right, and
refusing the endpoint over a housekeeping sweep would take the countdown from
every traveller whose layover is genuinely live. C2 asks for degraded
CONFIDENCE, not for a refusal.

### 21.3 The sweep, as a test rather than as a thing a pass did once

Every previous pass on this row counted SITES: §9 found nine bare catches,
§13.5 re-counted six, §18 re-counted six again, §19 removed all six. A per-site
test proves a site. **C2 is a rule over a SURFACE, and the only evidence that
fits a rule over a surface is a sweep of the surface a later reader can
re-execute.**

`artifacts/api-server/src/services/airport/__tests__/layoverSurfaceErrorBinding.test.ts`
reads every source file in `services/airport/`, `services/safeReturn/` and
`routes/airport.ts` and fails on three SHAPES:

1. a supabase destructure that does not bind `error` at all — supabase-js
   RESOLVES on a database error, so this is an outage read as an empty table;
2. an `error` bound and never mentioned in the window that follows — identical
   at runtime to (1), and harder to see because the binding makes the file look
   careful;
3. an `error` TESTED and then thrown away — a site that branches, answers an
   honest 503, and records nothing. That is C2's "degraded confidence" without
   its "structured logging", and it leaves an operator with a refusal nobody
   can explain.

**The window is bounded and the bound is the point.** The first shape of (2)
scanned to end of file, and a mutation walked straight through it: `error` is
the commonest identifier in `routes/airport.ts`, so any later read's binding
satisfied the search. The second shape stopped at 25 lines and a mutation still
walked through, because eleven lines below the discarded `error` sits a
`const { data: blockRows, error: blockErr }` — and a naive `\berror\b` matched
the word inside that binding. The window now ends at whichever comes first: 25
lines, or the next supabase destructure; and a later BINDING of the name does
not count as a use. Both evasions are in the mutation table.

**Result at this commit: 84 supabase reads swept, zero findings.**

### 21.4 The swallow in `services/safeReturn/` that reading had missed four times

The sweep's disposition pass found exactly one read in the whole surface that
was neither logged nor passed on:

```
// SafeReturnLiveShareService.expireShare
if (error || !data) return null;
```

That is `if (error || !data) return null` again — the identical shape §19.2
removed from every writer in `LayoverSessionService`, surviving one directory
over because every previous pass swept for the `catch` KEYWORD and not for the
shape. §13.5, §18 and §19 each re-counted the catches in that directory and
each walked past this line.

`expireShare` is called by `lib/safeReturnScheduler.ts` for every live share
past its `expires_at`, and its `null` meant three things at once: the row was
already closed (PostgREST answers a zero-row `.single()` UPDATE with `PGRST116`,
which arrives as an `error`, and this is the overwhelmingly common case); the
UPDATE did not complete; or something threw.

**The second is a person's location still being shared past the moment they
agreed to**, and the scheduler logged nothing, because it was handed the same
`null` it gets from the first case a thousand times an hour. A privacy window
that fails OPEN is the one failure on this surface a traveller cannot see and
cannot undo.

`expireShareSettled` and `stopShareSettled`
(`artifacts/api-server/src/services/safeReturn/SafeReturnLiveShareService.ts:227#expireShareSettled`)
draw the three-way distinction `SafeReturnService.settleMutation` already draws
in the same product for the same PostgREST behaviour — these two predate it.
`expireShare` and `stopShare` keep their exact `LiveShare | null` signatures,
because `lib/safeReturnScheduler.ts` and the Safe Return routes bind them and
are not this lane's files; they are one-line projections, and **the projection
is lossy on purpose**. See the cross-lane request in 21.7.

### 21.5 A transient outage baked permanently into a traveller's layover

The same sweep asked what an unreadable `airport_profiles` produces, and the
answer was the worst shape on this surface, because it does not lose
information — it MANUFACTURES it. `resolveByIata` / `resolveByCity` /
`resolveByGps` / `searchAirports` logged the failure and then answered from the
STATIC dataset, whose every buffer is a generic constant (60 / 120 / 30 / 15 /
20). That answer is byte-identical to the honest one for an airport this
product has simply never curated — the §22 L0 tier, a DESIGNED state.

`routes/airport.ts` already spelled out the harm, on the ONE branch that was
guarded:

> *"A session created while `airport_profiles` was unreadable is stored with
> airport_id = null, and EVERY later hard-return time for it is computed from
> the generic buffer defaults — permanently, long after the database recovers.
> The transient failure would have been baked into the row."*

That reasoning was applied to the `p.airportId` branch and to neither of the
other two. A traveller who picked their airport by IATA code, or typed a city,
during a five-second outage got a layover whose return deadline is computed from
constants for the rest of its life — and `upsertAirportProfile` WROTE those
constants into `airport_profiles` and linked the session to them.

`lookupByIata` / `lookupByCity` / `lookupByGps` / `lookupAirports`
(`artifacts/api-server/src/services/airport/AirportProfileService.ts:207#lookupByIata`)
answer a record carrying `degraded`, `degradedReasons` and `fromStatic`.
`GET /airport/search` publishes the degradation and still serves the static
results — taking the picker away would cost more than a label.
`POST /airport/sessions` REFUSES on a degraded lookup and creates the session as
before on a clean read that matched nothing. **A clean not-found must not become
a refusal**; that would close this row by taking the product away from every
airport the database does not carry, which is the scope-shrink §5 of the lane
rules forbids. A mutation pins that direction too (#55).

One more site, found by the third shape: the admin profile list
(`routes/airport.ts:2733`) refused honestly and recorded nothing. It logs now.

### 21.6 WHY L294 STILL DOES NOT MOVE

Three halves of this row are now swept AND guarded: every error in the surface
is bound, read, and carried into a log or a returned reason. A fourth is not,
and it is the half the row names second.

**The sweep cannot tell a fail-closed empty from a measured empty.** A read
that logs its error and then returns `[]` with no degraded flag passes every
assertion in `layoverSurfaceErrorBinding` — and that is C2 exactly. Today no
such site exists: every surface that still answers after a failed read publishes
`degraded` with a named reason (presence, the session list, the active session,
airport search) or refuses with 503 (session writes, session reads, buddies,
session create). But that is proved SITE BY SITE, by the per-site suites, and a
site added tomorrow is not covered by any of them.

Closing that half is not a test, it is a design step: the surface would need one
`DegradedAnswer<T>` type that a handler cannot construct without saying whether
its emptiness was measured, so that "degraded confidence" becomes unskippable
rather than remembered. That is a real change to every read on the surface and
it is not this pass's.

**So the row keeps its `W`, and the part that closed is named rather than
rounded up** — which is the same discipline §19 applied to its own six builds.
`WHAT EXACTLY WOULD TURN THIS RED?` has a concrete answer for three of the four
halves and no answer for the fourth, and lane rule 3 says that is not a
certification.

### 21.7 Blocked on files this lane does not own

1. **`artifacts/api-server/package.json`** — unchanged from 19.8 item 1, and now
   larger: **ten** suites under `src/services/airport/__tests__/` and
   `src/services/safeReturn/__tests__/` are not in the curated `test` script.
   The exact list is in 21.9. None of them runs in CI until it is registered.
2. **`artifacts/api-server/src/lib/safeReturnScheduler.ts`** — it calls
   `expireShare` and discards the `null`, which is now a LOSSY projection of
   `expireShareSettled`. One line: switch to the settled form and count
   `outcome === "unavailable"` separately from `no_match`, so an expiry sweep
   that is failing for every share is visible as something other than a quiet
   night. Nothing is red today; the information simply stops at the projection.
3. **`src/test/layoverBuddiesMasterFlag.test.ts`** and
   **`src/test/layoverFeasibilityRecord.test.ts`** — unchanged from 19.8 items
   2 and 3, both still open, both still one mechanical edit each.
4. **`src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` or this row's
   `head_commit`** — unchanged from 19.8 item 5. This pass adds
   `services/airport/AirportProfileService.ts` and
   `services/safeReturn/SafeReturnLiveShareService.ts` to the counted files that
   have moved. Whoever commits must re-declare or extend.

### 21.8 The mutations

Continuing §20's numbering. Every build was watched RED first; these are the
mutations run against the implementation after it was green, restored each time.

| # | file | mutation | result |
| --- | --- | --- | --- |
| 40 | `LayoverSessionService.ts` | `expirySweepDisclosure` never degrades | **7 red** |
| 41 | `LayoverSessionService.ts` | …degrades on a sweep that RAN too | **4 red** — "a completed sweep of 0 is a measurement" |
| 42 | `LayoverSessionService.ts` | terminal rows counted as stale-live | **1 red** — `3 !== 0` |
| 43 | `LayoverSessionService.ts` | an unparseable departure counted as past | **1 red** |
| 44 | `routes/airport.ts` | `/sessions` throws the sweep answer away again | **1 red** |
| 45 | `routes/airport.ts` | `/sessions/active` throws it away again | **2 red** |
| 46 | `routes/airport.ts` | `/sessions/active` measures an empty session set | **1 red** — the countdown's own session stops being checked |
| 47 | `AirportProfileService.ts` | `lookupByIata` never degrades | **3 red** — lookup, search route, create route |
| 48 | `AirportProfileService.ts` | a clean not-found reported as degraded | **1 red** |
| 49 | `AirportProfileService.ts` | `fromStatic` true for a curated row | **1 red** |
| 50 | `AirportProfileService.ts` | `lookupByCity` never degrades | **2 red** |
| 51 | `AirportProfileService.ts` | `lookupAirports` never degrades | **2 red** |
| 52 | `AirportProfileService.ts` | `resolveByIata`'s old shape broken | **1 red** — the projection another lane's suite binds |
| 53 | `routes/airport.ts` | the search route stops publishing the degradation | **2 red** |
| 54 | `routes/airport.ts` | the create route builds the session anyway | **1 red** — `201 !== 503` |
| 55 | `routes/airport.ts` | the create route refuses on `fromStatic` instead | **1 red** — the scope-shrink guard: an uncurated airport must still work |
| 56 | `LayoverSessionService.ts` | an unbound `error` reintroduced | **1 red** — sweep shape (1) |
| 57 | `routes/airport.ts` | a bound `error` discarded in the buddies handler | **1 red** — sweep shape (2), **after two repairs; see 21.3** |
| 58 | the sweep itself | narrowed so it matches nothing | **1 red** — the control that stops a vacuous sweep passing |
| 59 | `SafeReturnNotificationService.ts` | a discarded `error` in `services/safeReturn/` | **1 red** |
| 60 | `AirportProfileService.ts` | a discarded `error` there | **1 red** |
| 61 | `SafeReturnLiveShareService.ts` | `expireShare` collapses an outage into `no_match` | **2 red** — "a location still being shared past its expiry is not 'nothing to do'" |
| 62 | `SafeReturnLiveShareService.ts` | `PGRST116` treated as an outage | **3 red** — the common case must stay quiet |
| 63 | `SafeReturnLiveShareService.ts` | `stopShare` collapses an outage | **1 red** |
| 64 | `SafeReturnLiveShareService.ts` | the projection leaks the settled record | **1 red** — the other lane's contract |
| 65 | `routes/airport.ts` | the admin list drops its log again | **1 red** — sweep shape (3) |
| 66 | `routes/airport.ts` | it logs a STRING instead of the error | **1 red** — carrying something is not carrying the error |

**Two mutations did not redden on their first run and both were the sweep's own
weakness, not an implementation's** — #57 walked through an end-of-file scan and
then through a 25-line one, for the two reasons 21.3 gives. Both are red against
the repaired rule and both repairs are in the file.

### 21.9 The evidence, by file

Four new suites, 38 assertions, plus the three §20 repairs.

| suite | what it is evidence for |
| --- | --- |
| `artifacts/api-server/src/services/airport/__tests__/layoverExpirySweepVisible.test.ts` | L294 — the failed sweep, on both endpoints, with its measurement |
| `artifacts/api-server/src/services/airport/__tests__/layoverAirportLookupDegraded.test.ts` | L294 — the static-fallback swallow, and the refusal that stops it being written into the row |
| `artifacts/api-server/src/services/airport/__tests__/layoverSurfaceErrorBinding.test.ts` | L294 — the SWEEP, as a re-executable assertion over 84 reads |
| `artifacts/api-server/src/services/safeReturn/__tests__/safeReturnLiveShareExpiryHonesty.test.ts` | L294 — the live-share expiry swallow, and the three outcomes it collapsed |

**THE FULL LIST FOR `package.json`, confirmed by `ls` at this commit.** All ten
are under `src/services/`; **`src/services/safeReturn/__tests__/` exists only
because this pass created it**, and `layoverReturnEscalation.test.ts` is NOT in
it — it is filed beside the layover posture that consumes it, for the reason its
own file header gives:

```
src/services/airport/__tests__/layoverAirportLookupDegraded.test.ts
src/services/airport/__tests__/layoverBuddySafetyGate.test.ts
src/services/airport/__tests__/layoverCompassEntryBoundary.test.ts
src/services/airport/__tests__/layoverEnvelopeConfidence.test.ts
src/services/airport/__tests__/layoverExpirySweepVisible.test.ts
src/services/airport/__tests__/layoverPresenceDegraded.test.ts
src/services/airport/__tests__/layoverReturnEscalation.test.ts
src/services/airport/__tests__/layoverSessionWriteFailClosed.test.ts
src/services/airport/__tests__/layoverSurfaceErrorBinding.test.ts
src/services/safeReturn/__tests__/safeReturnLiveShareExpiryHonesty.test.ts
```

Measured at this commit: **950 assertions across 221 suites, 0 failures**, over
`src/test/airport.test.ts`, `src/test/layover*.test.ts`,
`src/test/safeReturn*.test.ts` and both `__tests__` directories.
`tsc --noEmit` reports nothing in any file this lane owns.
`check:citation-symbols` PASSED — 139 citations judged, 0 naming a symbol its
file does not contain.

### 21.10 Headline

**UNCHANGED.** L294 stays `W` for the reason 21.6 gives, and no other row was
touched.

| Measure | §20 | §21 |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 61 | **61** |
| BUILT-BUT-WRONG | 136 | **136** |
| NOT-BUILT | 99 | **99** |
| CANNOT-VERIFY | 0 | **0** |
| CONSTRUCTED% | 66.6 % | **66.6 %** |
| CORRECT% raw | 20.6 % | **20.6 %** |

> Two passes in a row have moved nothing, and both were worth running. §19's
> six builds were refusals; §20 found three of its own tests unable to fail;
> this one replaced counting with a sweep and the sweep immediately found a
> swallow that four separate readings of the same directory had walked past —
> one that left a person's location shared after they had stopped sharing it.
> **The lesson is not that the readers were careless. It is that `grep catch`
> answers a question about a keyword, and C2 is a question about a shape.**

---

## §22 — the twelve §12 tools reach the model, and two of them still answer "unavailable"

Written by the integration owner after cherry-picking `0ab55cfd2` and
`8082f726f`. Every OLD verdict was read from `CENSUS_INTEGRITY_DUMP=ALL`, not
from the lane's report.

### 22.1 Twelve moves

| **ID** | **was** | **now** | why |
|---|---|---|---|
| **L100** | **W** | **C** | all four clauses hold: a clarifying question (§13.5), *compares certified plans* (`simulatePlan` is invoked), personalised wording, and *invokes deterministic tools* — `LayoverCompassService.ts:322#tools: LAYOVER_TOOL_SCHEMAS` |
| **L102** | **W** | **C** | `getLayoverContext` — declared, offered with `tool_choice: "auto"`, and what the model chooses is executed at `LayoverCompassService.ts:334#const result = runNamedLayoverTool(c?.function?.name, ctx, c?.function?.arguments);` |
| **L103** | **W** | **C** | `getConnectionState` — same loop, same route |
| **L104** | **W** | **C** | `getTimeWallet` — asserted end to end, and the loop is asserted bounded |
| **L105** | **W** | **C** | `getSafeEnvelope` — same loop |
| **L106** | **W** | **C** | `getReachableExperiences` — the route hands it the session's real cards and it answers `unavailable` on an unreadable table rather than `[]` |
| **L107** | **W** | **C** | `simulatePlan` — reads the stored plan; a model-supplied candidate set is still answered during an outage |
| **L108** | **W** | **C** | `getReturnContract` — the tool's `hardReturnTime` is asserted equal to the response's |
| **L109** | **W** | **C** | `getAirportState` — same loop |
| **L111** | **W** | **C** | `requestConstraintClarification` — same loop |
| **L113** | **W** | **C** | `explainDecision` — same loop |
| **L265** | **W** | **C** | threshold (`LayoverReturnEscalation.ts:226#REMINDER_MATERIAL_DRIFT_MIN = 5`), suppression (`keep` below it) and debounce (never stacks), applied on the live overview read |

### 22.2 Two the lane offered as an owner judgement, and the judgement is W

**L110 `getCrewCandidates`** and **L112 `replan`** are declared, offered and
invoked exactly like the other ten. They answer `unavailable: no_crew_storage`
and `unavailable: no_event_driven_replanner`, because neither capability exists.

They stay **W**. A tool that can only ever answer "unavailable" has delivered its
*contract* and not its *capability*, and §12 asks for a capability. This is the
same rule §17.2 of census-discovery applies to DV-58/59, and applying it in one
census and not the other would make the corpus's percentage a function of which
lane wrote the row. The refusal is honest, which is why they are `W` and not `N`.

### 22.3 What would turn the twelve red

Thirty-six mutations were run against these two clusters; **two survived and both
were closed**, and one of the survivors is the most valuable finding in the pass:

- **M2** — dropping `tool_choice: "auto"` alone stayed green, because it is
  OpenAI's default *when tools are present* and the test double could not see the
  difference. It is now pinned. The gateway named by
  `AI_INTEGRATIONS_OPENAI_BASE_URL` is not OpenAI, and one defaulting to `none`
  would re-dark all twelve tools with nothing failing.
- **M15** — the route passing a real card list was never staged, so no test could
  tell a real list from an empty one. Two tests now stage a card and a stop.
- **M18** — not replaying the assistant `tool_calls` turn before the tool
  messages was **green on the first run**: the double accepted a transcript a
  real model answers with `400`. The transcript shape is now asserted.

### 22.4 What is verified against a DOUBLE and not against a provider

Everything in §22.1 about the model call. No request in this pass reached a real
provider, and **whether the live gateway honours `tools`/`tool_choice` at all was
not verified**. M18 is the reason this is stated rather than assumed: the suite
was fully green while producing a request OpenAI would reject outright.

`layover_compass_enabled` is TRUE in production, so unlike most of this branch
the route itself is live — but the branch is not merged, so the tool loop is not.

### 22.5 Three `N` rows that look wrong at HEAD — reported, NOT moved

The lane re-read L67, L117 and L122 (*"renders undifferentiated pins; no band, no
colour, no feasibility state reaches the map"* / *"feasibility never reaches the
pin"*) and found the sentences false at HEAD. Confirmed here by reading:
`LayoverMapCard.tsx:183#function pinFeasibility(` exists and
`LayoverMapCard.tsx:225#() => stops.map((s) => ({ stop: s, feasibility: pinFeasibility(s, candidateFeasibility) })),`
bands every pin through it.

**They are not moved.** Nobody in this pass wrote that code, mutated it, or
checked whether the `UNCERTIFIED` stored-path case renders honestly — and a
verdict moved on a grep is the failure mode §16 of census-discovery exists to
record. This is evidence for whoever grades them, not a grade.

### 22.6 Five more stale sentences, disproved by reading HEAD

1. **L213** — *"`RETURN_SOON`/`RETURN_NOW` do not exist."* False:
   `LayoverSafetyEngine.ts:130` declares `RETURN_SOON` and `:139`
   `RETURN_SOON_LEAD_MIN = 30`. The verdict may still hold; the reason does not.
2. **L215** — *"the fallback ladder emits nothing when it fires … `routes/airport.ts:127` swallows the failure silently."* False twice: that line is an
   import block, and §21.5 made all four lookups publish `degraded`.
3. **L210** — *"No critical-unknown concept."* False:
   `layoverObservability.ts:88#CRITICAL_UNKNOWN_CODES` names five.
4. **§21.7 item 1** — *"ten suites … are not in the curated `test` script."*
   False: all ten are registered.
5. **L102's own evidence cell** cited a comment reading *"DECLARED, NOT YET
   PASSED TO THE MODEL"*. That comment was **deleted** by this change, so the
   cell was rewritten rather than repointed — the only one of 56 broken citations
   in this integration where no line in the tree could carry the old claim.

Verified STILL true, so the reader does not have to re-check: L34/L48 (no
`EntryPermissionState` or `entry_requirements` read anywhere), L169, L173,
L185/L186/L188, and §16's L151–L155.

### 22.7 The client half, and the gap it closed

`travel-buddy-standalone/src/services/layover.ts` did not carry `toolsConsulted`
or `reminder`, so both screens read the new fields through a local narrowing.
Both are now typed on `CompassAnswer` and `LayoverOverview`, **optional on the
wire**, with the rule written on each: *absent means UNREPORTED, not none* — a
surface must render nothing rather than infer "no tools were available" from an
older server's silence.

### 22.8 Tally

`check:census-integrity` now reads **C=73 W=124 N=99 X=0** across 296 rows,
denominator 296. Twelve rows moved. Nothing reached `C` that is not reachable
from a route the shipping client calls.

| Measure | §21 | §22 |
| --- | ---: | ---: |
| BUILT-AND-CORRECT | 61 | **73** |
| BUILT-BUT-WRONG | 136 | **124** |
| NOT-BUILT | 99 | **99** |
| CANNOT-VERIFY | 0 | **0** |
| CONSTRUCTED% | 66.6 % | **66.6 %** |
| CORRECT% raw | 20.6 % | **24.7 %** |

CONSTRUCTED% does not move, and that is the honest reading: nothing here was
BUILT that was not built before. Twelve rows were already `W` — constructed and
wrong — and what this pass did was make them right. `N` is unchanged at 99,
because not one absent thing was built.

## §23 — the two /buddies reads §21.6 counted as closed, and the rung with one value

This pass is a CORRECTNESS pass on the worst census in the corpus by CORRECT%
(73 C / 124 W / 99 N of 296 — 24.7 % correct, 223 non-correct rows). It moves
**no verdict**, and it says so in the first sentence rather than in a footnote,
because the honest finding is that the 223 are almost entirely blocked on things
no code in this domain can supply. What it does produce is two live defects
closed, three census sentences disproved, and a partition of all 223 rows that
names the blocker for every one of them.

Every old verdict below was read from
`CENSUS_INTEGRITY_DUMP=ALL node --import tsx/esm src/scripts/checkCensusIntegrity.ts`
(§16.6), never from the prose.

### 23.1 THE FINDING — `GET /:id/buddies` had two reads that answered anyway

§21.6 closed §21 with this sentence about the one half of L294 it left open —
"a read that logs its error and then returns `[]` with no degraded flag":

> *"Today no such site exists: every surface that still answers after a failed
> read publishes `degraded` with a named reason (presence, the session list, the
> active session, airport search) or refuses with 503 (session writes, session
> reads, **buddies**, session create)."*

**`/buddies` refuses with 503 for ONE of its three reads.** The other two are
inside the same handler, and both answered:

1. **`blocks` unreadable.** The handler set `rows = []` and replied
   `{ ok: true, city, buddies: [] }`. A traveller was told there is nobody in
   this city when what actually happened is that their own block list could not
   be read. Failing closed is the right SAFETY posture and it was not an answer:
   the emptiness was never measured, and nothing on the wire said so.
2. **`rent_buddy_availability` unreadable.** Every profile was published with
   `availableDuringLayover: false` — a positive claim about each named person,
   derived from a read that did not happen — and that same field is the sort key
   that chooses which six of up to twelve are served.

The first RED is the whole finding in one line. Staged against the real router,
an outage in `blocks` and a city with no active buddies produced **byte-identical
response bodies**:

```
not ok 1 - an unreadable block list is NOT the same answer as a city with nobody in it
  error: 'two empty lists, one measured and one from an outage, are byte-identical to the client'
  operator: 'notDeepStrictEqual'
  expected: { ok: true, city: 'Taoyuan', buddies: , safetyGate: { passed: true, verdict: 'yes', … } }
  actual:   { ok: true, city: 'Taoyuan', buddies: , safetyGate: { passed: true, verdict: 'yes', … } }
```

Four cases RED, one green (the `availableDuringLayover === false` control), then
16 / 16 green after the fix. The shape of the fix is `cityPresence`'s, deliberately:
a `degradedReasons` list the handler pushes to
(`artifacts/api-server/src/routes/airport.ts:2698#const degradedReasons: string[] = [];`),
published as
`artifacts/api-server/src/routes/airport.ts:2808#degraded: degradedReasons.length > 0,`,
and an availability that is `null` rather than `false` when nobody asked
(`artifacts/api-server/src/routes/airport.ts:2790#availableDuringLayover: availabilityMeasured ? availableSet.has(b.id) : null,`).

**THE ROW STILL DOES NOT MOVE, and §21.6's reason is why.** L294's C2 asks for
degraded confidence at every such site, and it is still proved SITE BY SITE. What
this pass shows is that site-by-site is not merely fragile in principle — it had
already missed two sites in a handler §21.6 names by name in its own list of
closed ones. The `DegradedAnswer<T>` §21.6 describes is still the thing that
would move the row, and it is still not this pass's.

### 23.2 Rows re-derived at this commit

No verdict moves. Each row below was re-read because this pass changed code it
cites or disproved its evidence; the verdict is restated so the dump's last
statement is this one.

| **ID** | **was** | **now** | why |
| --- | --- | --- | --- |
| L294 | W | W | Two more swallow sites closed on `/buddies` (23.1). The fourth half of C2 — degraded confidence that a handler cannot skip — is unchanged, and this pass is the evidence that §21.6's site-by-site proof does not hold itself up. |
| L273 | W | W | Evidence disproved (23.4 item 2), verdict unchanged for §19.4's stated reason: `rent_buddy_profiles.categories` still has no `layover` member, so the shipped filter is a COMPATIBILITY filter and not a specialist credential. |
| L254 | W | W | Evidence disproved (23.4 item 3), verdict unchanged for §19.4's stated reason: only the `tight`-verdict arm shipped; the night-layover arm is still blocked on a fixture in another lane's file. |
| L9 | C | C | Re-read because this pass measures the disclosure it certified. It holds as §17.4 stated it — and 23.5 measures what it resolves to in production, which is a different question and is not a verdict. |
| L243 | W | W | Unchanged. 23.5 supplies the measurement, and deliberately does NOT take the owner decision the row rests on. |
| L249 | N | N | Unchanged. The maturity model classifies and states policy; nothing consults it before generating a landside recommendation. |

### 23.3 The 223 non-correct rows, partitioned — every row in exactly one bucket

Counted from the dump, verified exact: no row in two buckets, no row in none,
82 + 18 + 24 + 96 + 3 + 0 = 223.

| bucket | count | what it means here |
| --- | ---: | --- |
| (a) closable from code in files this lane owns | **0** | see below — this is the finding, not an omission |
| (b) blocked on a migration no database has | **82** | 2700 / 2740 / 2860 are written and NOT applied; `layover_constraints`, `layover_snapshots`, `layover_time_budgets`, `layover_return_plans`, `layover_presence`, `layover_crews`, `layover_crew_members`, `layover_checkpoints`, `layover_outcomes` do not exist anywhere |
| (c) blocked on an owner decision | **18** | the ENTRY gate (L34/L48/L230/L49/L77 — PR #463, unmerged); the Compass reachability flag (L110/L112); **should the GENERIC rung WITHHOLD landside guidance** (L243/L249/L244/L245/L246/L248); shadow-mode rollout (L242); Compass prose enforcement (L3/L101/L268); §18's refusal to manufacture a caller for `calculateCommitmentEnvelope` (L178) |
| (d) blocked on a file another lane owns | **24** | `travel-buddy-standalone/` (the map surface L17/L67/L115–L126, the offline client L150/L156/L157, the integration cards L267/L270/L272/L275); `domain/trips/invariants/` (L13/L56/L57/L59); `lib/deletionDispositions.ts` + `AccountDeletionService.ts` (L163) |
| (e) blocked on an absent platform capability or a device | **96** | **no routed travel-time provider** (L58/L60–L63/L65/L66/L68–L73/L219/L220 and the whole §8 family); **no flight feed** (L44/L148/L149/L169/L231); **no live-signal producer** (L80–L83/L143/L180/L181/L227/L228/L247/L276/L281–L287); **no metrics exporter of any kind** (L208/L210–L217); **no location sensing** (L155/L157/L160/L161); **no CI database for a layover schema test** (L236/L295) |
| (f) the row's premise is already FALSE at HEAD | **3** | L254, L273, L294 — quoted in 23.4 |

**WHY (a) IS ZERO, stated rather than rounded.** Three rows came closest and each
is out for a named reason, not for lack of trying:

* **L223** *"Overnight → expanded options"*. `insideAirportCandidates` is in this
  lane's `LayoverRecommendationService.ts`, so the code is reachable — but there
  is no airside content source for an airport, so any "expanded option" would be
  a hand-written card. This document has spent three passes deleting invented
  content (L293's fabricated travel times most recently). Blocked on a content
  source, bucket (e).
* **L249** *"Enable features per airport maturity"*. `layoverMaturity.ts` already
  holds the classifier and `featureAllowedAt`; wiring it is one call in this
  lane's file. That call IS the L243 owner decision — withholding landside
  guidance at L0, which in production is EVERY airport. Bucket (c).
* **L205** *"Service-role processing should be narrow"*. Narrowing means running
  layover reads on the caller's JWT, and `layover_sessions` RLS is owner-only, so
  the presence surface stops working. An architecture decision, bucket (e).

**The 223 are not 223 pieces of missing layover code.** 178 of them (b + e) wait
on a store, a provider or a feed that no amount of work in
`routes/airport.ts` and `services/airport/` can create.

### 23.4 Census sentences DISPROVED, quoted, with the disproving line

1. **§21.6**, on the one half of L294 it left open:
   > *"Today no such site exists: every surface that still answers after a failed
   > read publishes `degraded` with a named reason … or refuses with 503 (session
   > writes, session reads, **buddies**, session create)."*

   **False when it was written.** `/buddies` had two reads that answered after
   failing: the `blocks` read (an unreadable block list was served as an empty
   city) and the `rent_buddy_availability` read (an unreadable table was served
   as `availableDuringLayover: false` for every person). Disproved by the RED in
   23.1 — two response bodies, one from an outage and one from a measured empty
   city, asserted `notDeepStrictEqual` and found equal. Both are now closed and
   both are guarded.

2. **L273's body row**, the last parseable statement of that verdict:
   > *"There is no safety gate, no layover-specialist category filter, and the
   > master `rent_buddy_enabled` flag is not consulted (L255)."*

   **Two of the three clauses are false at HEAD.** The master flag is consulted
   at `artifacts/api-server/src/routes/airport.ts:2640#if (!await isFlagEnabled(sc, "rent_buddy_enabled")) {`,
   and the safety gate runs BEFORE the profiles are read at
   `artifacts/api-server/src/routes/airport.ts:2659#const { safetyGate, trustRequirement } = layoverBuddyDecision(airport, session);`.
   A compatibility filter also runs
   (`artifacts/api-server/src/routes/airport.ts:2771#rows = filterLayoverCompatible(rows);`).
   The third clause — a *specialist* category filter — is still true, which is
   why the verdict does not move. §19.4 argued all three in prose; the parseable
   row never carried the correction, so the dump has been serving the stale
   sentence since.

3. **L254's body row**, likewise the last parseable statement:
   > *"`verified` and `buddy_level` are read and returned … but nothing
   > *requires* them — the layover buddy list is filtered only on
   > `status='active'`, city and blocks."*

   **False at HEAD.** `artifacts/api-server/src/routes/airport.ts:2772#rows = applyBuddyTrustRequirement(rows, trustRequirement);`
   withholds an unverified or brand-new profile on a `tight` window, asserted by
   `src/services/airport/__tests__/layoverBuddySafetyGate.test.ts`. Only one of
   the row's two arms shipped, so the verdict stays `W`.

4. **L294's last parseable statement** (the §16.7 row):
   > *"Seven bare `catch { return … }` blocks remain in `LayoverSessionService.ts`
   > (`:187, 229, 255, 367, 387, 416`)."*

   **Zero.** `grep -n catch src/services/airport/LayoverSessionService.ts` returns
   two lines, both inside the comment that explains why there is no try/catch.
   §13.5 corrected the count from seven to six, §18 re-measured six, and §19.2
   removed all six — but §19's row-move table is not in the parseable form, so
   the DUMP still reads the seven-that-were-six sentence as current. Recorded
   here so the parseable statement and the tree agree.

5. **§21.7 item 1** — *"**ten** suites under `src/services/airport/__tests__/` and
   `src/services/safeReturn/__tests__/` are not in the curated `test` script …
   None of them runs in CI until it is registered."* **Now false**:
   `check:test-registration` passes with 1246 registered, and every suite §21.7
   named resolves `true` against `package.json`'s `test` script. Whoever
   registered them did not retire the item.

**Already corrected elsewhere, recorded so this pass is not credited with them:**
L215's *"the fallback ladder emits nothing when it fires"* was corrected by §18.7
item 4, and L249's *"the only tier-like signal is `airport_profiles.verified`"*
by §17.6. Both remain the last PARSEABLE statement of their row.

### 23.5 The four-rung disclosure — derived, and with one reachable value

§L9/L250 built `GENERIC / AIRPORT_RECORD / VERIFIED_RECORD / LIVE`. The question
this pass was asked is whether the rung a person actually sees is derived from
evidence or defaulted. **It is derived**, and the derivation was read rather than
assumed: the tier comes off `record.estimates` — the same objects the arithmetic
was built from — and the single separating signal is
`artifacts/api-server/src/services/airport/LayoverFeasibility.ts:509#  const rowClass: EstimateSourceClass = a.id === null ? "STATIC_DEFAULT" : "AIRPORT_PROFILE";`
folded by `artifacts/api-server/src/services/airport/LayoverFeasibility.ts:782#  const airportAddressable = terms.every((t) => t.sourceClass === "AIRPORT_PROFILE");`.
No literal, no default, no hand-set field.

**And it has exactly one reachable value in production.**

| rung | reachable today? | why |
| --- | --- | --- |
| `GENERIC` | **no** | every session created through `POST /airport/sessions` gets an `airport_id` — `upsertAirportProfile` WRITES a row with the 0127 defaults for an airport nobody has configured |
| `AIRPORT_RECORD` | **yes — and it is the answer for every session** | 3,206 production rows, so `a.id !== null` always |
| `VERIFIED_RECORD` | no | 0 of 3,206 rows carry `verified = TRUE` |
| `LIVE` | no | `liveConditions` is `null` on every request this tree can make; there is no producer outside `src/test/` |

The signal the rung reads is ADDRESSABILITY, not CURATION, and the two are the
same thing in this database: 0127 declares the buffer columns
`NOT NULL DEFAULT 60/90/120/180/30/15/20`, and 0 of 3,206 rows carry any
non-default buffer. So `AIRPORT_RECORD` and `GENERIC` describe **numerically
identical advice** — new cases in
`artifacts/api-server/src/test/layoverAirportIntelligence.test.ts` certify the
same session against an uncurated row and against the fallback and assert the
four airport-supplied terms and the `hardReturnTime` are equal, with a curated
200-minute buffer as the control that makes the equality non-vacuous.

**This is a TRIPWIRE and not a fix, and no verdict moves on it.** Whether an
uncurated row should resolve to `GENERIC`, and whether `GENERIC` should WITHHOLD
landside guidance rather than caveat it, is the OWNER DECISION already recorded
at L243/L249 and it is not taken here. The tripwire exists so that the day it is
taken, a test says the disclosure's meaning changed rather than leaving it to a
reader — mutation T2 below proves it fires.

### 23.6 The mutations

Every mutation was applied by a replacer that REFUSES unless the target text
occurs exactly once, then the changed line was printed back from the file before
the run was believed (§"a mutation that does not apply looks exactly like one the
tests cannot catch"). Every one was restored and verified with `cmp`.

| # | file | mutation | result |
| --- | --- | --- | --- |
| 46 | `routes/airport.ts` | drop `degradedReasons.push("blocks_unreadable")` | **2 red** |
| 47 | `routes/airport.ts` | `degraded:` hard-coded `false` | **2 red** |
| 48 | `routes/airport.ts` | unmeasured availability spelled `false` again | **1 red** |
| 49 | `routes/airport.ts` | drop `degradedReasons.push("buddy_availability_unreadable")` | **1 red** |
| 50 | `routes/airport.ts` | the `blocks` failure fails OPEN (serve the unfiltered list) | **1 red** |
| 51 | `routes/airport.ts` | sort on availability even when unmeasured | **SURVIVOR** |
| 52 | `LayoverFeasibility.ts` | every airport addressable (`rowClass` constant) | **4 red** |
| 53 | `LayoverFeasibility.ts` | the rung means CURATION, not addressability | **7 red** |

**SURVIVOR 51, and what it reveals.** `Number(null)` is `0`, so an unguarded sort
over an unmeasured `availableDuringLayover` compares every pair equal and is a
no-op — no test can distinguish the guarded form from the unguarded one. The
`availabilityMeasured` condition on that `.sort()` is therefore **defensive
commentary, not covered behaviour**, and it is recorded as such rather than
counted as a tested line. What IS covered is the field's value and the disclosure
beside it (48, 49).

**A control that failed for the right reason, recorded because this session has
paid for the opposite.** 23.5's first draft asserted on `estimate.minutes`, which
does not exist — the field is `valueMinutes`. Both the equality and its control
read `undefined`, and the CONTROL is what went red: `notEqual(undefined, undefined)`.
A positive control that fails when the assertion is vacuous is the only reason
that draft did not ship green and meaningless.

### 23.7 Blocked on files this lane does not own — exact changes, not made here

1. **`artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`, the
   `census-compass.md` and `census-highlights-memories.md` entries.** This pass
   changes `routes/airport.ts`, which both censuses count, so
   `check:census-freshness` now reports both STALE. Each needs
   `"artifacts/api-server/src/routes/airport.ts"` added to its `files` list with
   the argument that no verdict of ITS moves. This lane can state the mechanical
   half — the edit is confined to the `/buddies` handler, lines 2723–2836, and
   `check:doc-citations` is RESULT clean after repointing — but it has not read
   those censuses' rows and will not write a verdict argument about them.
2. **`docs/architecture/census-highlights-memories.md`** — three citations into
   `routes/airport.ts` moved by this pass's 34 added lines. They **have been
   repointed here** (2991→3025, 2965→2999, 2928→2962), mechanically: by the
   checker's own "the WHOLE anchor is at X" answer AND by occurrence index
   against `git show HEAD:…`, where each anchor is unique in both blobs, with
   every proposed line read back before writing. Flagged rather than hidden
   because the file is another lane's; no prose or verdict in it was touched.
3. **`artifacts/api-server/src/lib/safeReturnScheduler.ts`** — unchanged from
   §21.7 item 2 and still open.

### 23.8 WHAT WOULD TURN THIS RED

* **23.1's fix:** a NEW read added to the `/buddies` handler that answers after
  failing. Nothing structural stops one — that is exactly §21.6's fourth half,
  and this pass is the proof that the site-by-site discipline does not hold. The
  guard is four cases in one suite over one handler; it does not generalise.
* **23.1's `null`:** `availableDuringLayover` is now `boolean | null` on the
  wire. No client in `travel-buddy-standalone/` was changed. If a client renders
  it with a truthiness test, `null` and `false` look the same there and the
  disclosure stops at the API — a REACHABILITY gap of exactly the kind this
  census has scored `W` twenty-eight times. **Stated, not fixed:** the client is
  another lane's file.
* **23.5's tripwire:** it asserts an EQUALITY that holds only while
  `airport_profiles` rows carry the 0127 defaults. The first curated airport in
  production does not turn it red (the test stages its own rows), but the first
  change to what `AIRPORT_RECORD` means does, and mutation 53 is the proof.
* **The partition:** it is derived from the census's own stated blockers plus
  this pass's reading, not from a measurement of each blocker. A row filed under
  (e) whose provider actually exists somewhere in this monorepo would be
  misfiled, and nothing here would catch it.
* **`check:census-freshness`** is RED for this census until item 1 of 23.7 is
  done — and for two other censuses because of this pass.
* **Every `C` in this document over a path nothing reaches is still vacuous.**
  Production has 5 layover sessions ever, 0 active, last event 2026-08-12. The
  two defects closed here were reachable by nobody, because nobody is on this
  surface.

### 23.9 The counted files this pass changed

| file | why |
| --- | --- |
| `artifacts/api-server/src/routes/airport.ts` | 23.1 — the two `/buddies` reads that answered after failing |
| `artifacts/api-server/src/services/airport/__tests__/layoverBuddySafetyGate.test.ts` | 23.1 — five cases, four watched RED first |
| `artifacts/api-server/src/test/layoverAirportIntelligence.test.ts` | 23.5 — the rung tripwire and its control |
| `docs/architecture/census-layover.md` | this section |
| `docs/architecture/census-highlights-memories.md` | 23.7 item 2 — three citations repointed, nothing else |

**`head_commit` is NOT re-declared.** This pass re-derived six rows, not 296, and
§1's reading rule applies unchanged to the other 290.
