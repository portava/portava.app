# Portava Layover — Requirement Census

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
| **"Layover Mode" feature build** | `replit.md:99` describes it in its own terms as an *"end-to-end system behind feature flags (migration 0127…)"*, with its own vocabulary — window tiers, hard-return anchored on boarding cutoff, `timeOfDayContext`. No spec reference. | `0127_layover_system.sql`, `services/airport/*`, `routes/airport.ts`, `app/layover/[id].tsx`, `components/layover/*` |
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
| L2 | The Layover domain owns the active session and **publishes certified outputs**; no other surface owns feasibility | W | Session ownership is real and single-writer (`LayoverSessionService.ts:111-345`). "Certified" is not: no output carries a version, an engine version, an input hash or a confidence. And the client re-derives a second feasibility judgement of its own — `components/layover/LayoverReturnPanel.tsx:113-114` (`usableMinutes < 30` / `< 60`) — with thresholds that appear nowhere on the server. |

### §2.1 Non-negotiable architecture rules

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L3 | Hard safety constraints are deterministic and cannot be overridden by Compass/LLM output | W | The deterministic engine is genuinely LLM-free and the *fields* returned to the client are server-computed (`LayoverCompassService.ts:124-131`). But the **prose** is the answer surface, and it is constrained only by prompt instructions (`:71-79`) and post-processed only for coordinate patterns (`LayoverPrivacyGuard.ts:100-106`). Nothing checks the prose against the deterministic verdict, so "you have plenty of time" ships next to a `not_recommended` note without contradiction being detected. |
| L4 | Unknown critical facts reduce confidence and may fail closed for landside recommendations | N | There is no confidence concept anywhere in `services/airport/`. Unknown entry is a sentence in `unknowns[]` attached to `verdict: "yes"` (`LayoverSafetyEngine.ts:302-304, 323-327`); unknown baggage is unrepresentable (L35). **[463]** |
| L5 | Every consequential recommendation is versioned, explainable and replayable | N | `layover_recommendations` has no version, snapshot, engine-version or input-hash column (`0127:106-138`), and rows are deleted wholesale and re-inserted on read (`LayoverRecommendationService.ts:309-318`, triggered from `routes/airport.ts:560-566`). Nothing can be replayed. |
| L6 | All surfaces consume the same certified `LayoverSnapshot`/`RecommendationContract`; **no duplicate time-budget logic** | W | One shared library exists (`computeBuffer`), which is real progress — but there are three independent *uses* of it with different inputs (`LayoverSafetyEngine.ts:90` departure-based, `:247` cutoff-based, `LayoverCompassService.ts:51` departure-based) plus the client's own thresholds (`LayoverReturnPanel.tsx:114`). No snapshot exists for surfaces to share. |
| L7 | Commercial ranking only after eligibility, safety and time feasibility (≡ §9.1, ≡ App C7) | N ∅ | No commercial input reaches the recommendation path at all — a grep of `services/airport/` and `routes/airport.ts` for `sponsored`/`promoted`/`is_paid`/`boost` returns nothing. But there is no gate either: ordering is `verified`-first plus time-of-day (`LayoverRecommendationService.ts:251-257`), and the one safety-first comparator that exists, `rankActivities` (`LayoverSafetyEngine.ts:148-168`), is dead code. Unguarded absence. |
| L8 | Precise social location is opt-in, temporary and automatically expires | C | Concrete artifact: layover presence structurally cannot carry a coordinate. `cityPresence` selects `user_id, manual_city, airport_profiles(city)` and nothing else (`routes/airport.ts:918-926`); `SafeRecommendation` has no lat/lng field at all (`LayoverPrivacyGuard.ts:31-52`). Opt-in: `share_city_status BOOLEAN NOT NULL DEFAULT FALSE` (`0127:82`). Temporary: presence is filtered on `status='active' AND departure_time > now()` (`:924`) and `expireOldSessions` flips the status (`LayoverSessionService.ts:327-345`). |
| L9 | Missing live intelligence degrades **visibly** to historical/conservative fallback; never fabricate freshness | W | The fallback ladder is real (DB row → `STATIC_AIRPORTS` → `buildFallbackProfile`, `services/airport/AirportProfileService.ts:37-68`), but it is invisible: `publicAirport` (`routes/airport.ts:830-843`) exposes only a `verified` boolean, rendered as a badge (`components/layover/LayoverHero.tsx:48`), and a generic-buffer session is indistinguishable from a curated one. Worse, freshness is *fabricated*: `estimateTravelTime(placeType)` returns 15 or 25 minutes without reading a coordinate (`LayoverRecommendationService.ts:212-216`) and that number becomes a "safe" rating. **[463]** |
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
| L18 | **Safe Return** owns escalation, return-state UX, notification priority; must not recompute core feasibility | W | `shouldSuggestSafeReturn` (`services/airport/LayoverNotificationService.ts:26-52`) produces suggestion reasons at session creation only (`routes/airport.ts:440-447`) and recomputes nothing — boundary holds there. But there is no escalation ladder and no notification priority, and the UI *does* recompute a risk judgement of its own (`LayoverReturnPanel.tsx:114-115`). |
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
| L42 | `RETURN_SOON → RETURN_NOW`: latest safe activity departure reached; side effect = switch primary CTA to *Return to Airport* | N | No CTA ever switches. The dead `LayoverReturnPanel.tsx:114` changes a panel colour under 30 usable minutes; the mounted dashboard footer keeps "Remind me / Telegraph / End layover" throughout (`app/layover/[id].tsx:333-357`). |
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
| L77 | **HARD GATE**: eligibility + entry + time + safety, before any optimisation | W | A gate exists but it is the wrong gate: landside candidates are fetched only when `wantsToLeave && layoverMinutes >= 90` (`LayoverRecommendationService.ts:244-246`), where `layoverMinutes` is the *scheduled* window, not usable time. So a 95-minute international connection with a 150-minute buffer still gets landside candidates; each is rated `not_recommended` and each is still written and returned (`:286-307`). Entry is not in the gate at all. The one safety-first ordering that exists is dead code (`LayoverSafetyEngine.ts:148-168`). |
| L78 | Optimise `preference_fit + local_uniqueness + opportunity_scarcity + social_value + experience_density + memory_value − monetary_cost − energy_cost − uncertainty − stress − return_risk` | N | The entire objective is two terms: `verified` first, then a time-of-day nudge (`LayoverRecommendationService.ts:251-257`). None of the eleven named terms exists. |

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
| L97 | Invalidate recommendations whose snapshot is stale or no longer feasible | W | There is wholesale invalidation — `generateRecommendations` DELETEs every row for the session and re-inserts (`LayoverRecommendationService.ts:309-318`), triggered whenever `layover_safety_engine_enabled` is on (`routes/airport.ts:560-566`). But it is driven by a client GET, not by an event; it has no staleness test; and it destroys rather than invalidates, so a client holding the previous ids loses them silently. |
| L98 | Emit an `OpportunityEvent` only if the user's actionable options materially changed | N | No such event type. |
| L99 | Notify only when user action should change | N | The only notification is a user-requested fixed 30-minute reminder (`app/layover/[id].tsx:167-191`). |

### §12 Compass / AI contract

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L100 | Compass is an orchestrator and explainer: asks the minimum useful clarifying question, compares certified plans, personalises wording, invokes deterministic tools | W | It explains and personalises — one chat completion over a structured deterministic context (`LayoverCompassService.ts:57-97`), with a deterministic fallback answer when the model fails (`:99-110`). It asks no clarifying question, compares no plans, and invokes no tool: the call has no tool schema (`:90-97`). |
| L101 | Compass **cannot invent or widen** the certified safe envelope, return deadline, visa/entry status, operational state or risk band | W | The structured fields are safe by construction (L16). The prose is not: the only enforcement is prompt text (`:71-79`) plus a coordinate regex (`LayoverPrivacyGuard.ts:100-106`). Visa/entry is not a field at all on main, so a model assertion about it is unconstrained by anything. And the whole endpoint is unreachable from the app (headline defect 4), so the contract governs a surface no user can reach. |
| L102 | Tool `getLayoverContext(sessionId)` | N | No layover tool exists. `compass/CompassTools.ts:66-210` declares eleven tools (`get_user_profile`, `get_current_trip`, `search_places`, `search_events`, `get_place_details`, `get_circle_activity`, `check_trip_conflicts`, `add_to_trip`, `get_whos_around`, `get_travel_compatibility`, `get_group_recommendation`) — none layover. |
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
| L140 | The escalation ladder `NORMAL → RETURN_SOON → RETURN_NOW → CONNECTION_AT_RISK` | N | No state ladder. The only escalation-flavoured artifact is a colour change in an unmounted component (`LayoverReturnPanel.tsx:114-115, 132`). |
| L141 | At `CONNECTION_AT_RISK`: exploration surfaces collapse | N | The dashboard renders the same eight sections regardless of remaining time (`app/layover/[id].tsx:295-325`). |
| L142 | …fastest return route is primary | N | No route. |
| L143 | …terminal/gate context is pinned | N | No gate data (L80). |
| L144 | …crew/buddy is notified if policy + settings allow | N | No crew; no buddy notification path. |
| L145 | …rebooking / airline / airport help becomes available | N | Absent. |

### §15.1 One-tap abort

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| L146 | **Every active landside plan must expose RETURN TO AIRPORT** | N | The only control resembling it is the "Safe Return" button in `LayoverReturnPanel.tsx:147-150`, whose `onSafeReturn` prop is a caller-supplied callback — and the component is mounted nowhere (headline defect 4). The mounted dashboard footer offers Remind me / Telegraph / End layover (`app/layover/[id].tsx:333-357`). |
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
| L182 | `LayoverExperienceService.getCandidates(sessionId)` | W | `generateRecommendations` (`LayoverRecommendationService.ts:230-351`) does produce a session-scoped candidate set, and its time-of-day filter is real and careful (`timeOfDayContext` samples every 30 minutes to the boarding cutoff, `:23-47`). The candidates themselves rest on category constants (L9). |
| L183 | `LayoverExperienceService.compile(sessionId, candidateIds)` | W | `POST /airport/sessions/:id/stops/from-recommendation` (`routes/airport.ts:1164-1211`) plus `computePlanFit` (`:886-901`) compiles chosen candidates into an ordered itinerary with a fit verdict. It compiles no route, no `departBy`, no abort threshold and no fallback (L76). |
| L184 | `LayoverExperienceService.rank(sessionId, contracts)` | W | Ordering exists (`LayoverRecommendationService.ts:251-257`) but by `verified` and time-of-day only; the safety-first comparator `rankActivities` (`LayoverSafetyEngine.ts:148-168`) is dead code. |
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
| L205 | Service-role processing should be **narrow and auditable** | W | It is auditable in part — `layover_events` records session, plan, share and reminder actions with their inputs (`routes/airport.ts:751-755` is a good example: minutesBefore, hardReturnTime and reminderAt all recorded). It is the opposite of narrow: every one of the ~30 layover routes runs on `getServiceClient()` (`:268, 307, 484, 520, 578, 628, 673, 726, 774, 981, 1004, 1031, 1101, 1444, 1526`), so the whole domain bypasses RLS and the row policies protect nothing on the server path. |

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
| L255 | Public-meetup and in-app-payment controls inherited from Rent a Buddy where applicable | W | The layover surface links to buddy profiles rather than booking, so Rent-a-Buddy's own controls apply once the user leaves it. But the inheritance is not asserted anywhere: `GET /airport/sessions/:id/buddies` queries `rent_buddy_profiles` directly (`routes/airport.ts:1355-1364`) behind the layover flag only — it never checks `rent_buddy_enabled`, the master flag every other buddy read gates on (`lib/buddyMapRead.ts:199-203`), and which `lib/rentBuddyFeeSchedule.ts:225` and `lib/rentBuddyEarningsLedger.ts:120` both describe as off in production. |
| L256 | Prevent sponsored/merchant inputs from modifying safety constraints | N ∅ | No sponsored input path reaches the safety engine, and no guard prevents one being added. |
| L257 | Validate all external event payloads and deduplicate by stable source keys | N | No external events (L91), no dedup key (L194). |
| L258 | Audit all server-side changes to certification fields and return contracts | W | The return-deadline write is properly audited with inputs and outputs (`routes/airport.ts:751-755`). Recommendation generation — which writes every `safety_rating`, `return_buffer_min` and `hard_return_time` in the system — logs only `{ count: rows.length }` (`LayoverRecommendationService.ts:320-328`), so the values written and the inputs that produced them are not recoverable. |

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
| L296 | C5. Never certify a recommendation against a snapshot other than the one returned with it | N | There are no snapshots to mismatch. The nearest analogue of the violation is live: `GET /:id/recommendations` regenerates and replaces the whole set whenever `layover_safety_engine_enabled` is on (`routes/airport.ts:560-566` → `LayoverRecommendationService.ts:309-318`), so the ids a client holds are destroyed under it and a subsequent `POST /stops/from-recommendation` (`routes/airport.ts:1164`) refers to a row that no longer exists. |

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
