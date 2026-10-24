# Layover retest: one real layover, every retest row (2026-10-24)

The owner's signed-in retest on production, as ONE layover (census-layover §85.6). It covers the census-layover rows whose only remaining
dependency is "the owner's signed-in retest on production". Sources: `docs/architecture/census-layover.md`
(§3 requirement text, last statement per row, §82 and §83), the lane triage, the §83 suite
`artifacts/api-server/src/test/db/layoverRetestRows20261023.db.test.ts`, and the app source under
`travel-buddy-standalone/` on branch `claude/census-lay-audit-20261024`. Production flags are taken from
`artifacts/api-server/src/test/db/fixtures/productionFlags20261023.json`.

**Count.** The triage and the id list both have **83** rows. §82.6 says "84", but §83.1 later moved L94 to a ruling,
which leaves 83. Every one of the 83 appears exactly once in the table at the end.

## Read this before you start

1. **Landside stays closed for everyone on production, whatever the flags say.** Production has no curated airports
   (0 of 3,206), so every session carries the closure `airport_maturity_limited` (owner decision 2026-10-18,
   `LayoverConstraints.ts` gateLandside). Routes are also off (`layover_routed_corridor_enabled` FALSE), so every
   landside card is served BLOCKED (`journey_not_measured`, `available: false`). So this retest can show **refusals
   and closures**. It cannot show a landside-open answer: no clear envelope, no landside "Add", and no "confirmed
   traveller opens landside" control. The §83 suite only showed landside open because it seeds a curated airport
   (`seedCuratedAirport`), and production has none.
2. **A crew of two cannot be formed through the app on production.** For anyone whose landside is closed,
   `GET /crew` answers with no crews and `reason: "safety_gate_not_passed"` (`routes/airport.ts` ~3370,
   `buddySafetyGateFor` → `landsideStatusOf` = closed). That means account A never sees B's crew and is never offered
   "Join". **L124, L134 and L135 cannot be completed on production until an airport is curated**, which writes
   production airport facts and is the owner's own decision. The other crew rows can be run with a crew of one
   (step 9).
3. **Presence intents are OFF** (`layover_presence_intents_enabled` FALSE), so the "open to food" intent chips are
   not drawn and `layover_presence` stays empty. Presence is shown through the city-sharing switch and the
   L0 aggregate.
4. **Check what your build contains.** The build for this run is main `96d20f10d` (the lead, 2026-10-24), plus
   whatever merges before the owner connects. The server is whatever the lead has deployed at the time; the steps
   below say which observation needs which code.
   - In `96d20f10d`: #781's handling of served status on the ideas list. An unavailable idea shows
     "Unavailable — <server sentence>" and has no "+".
   - Only if #785 has merged and shipped in the build: the Compass fallback sentence (`compass-assistant-fallback`),
     and the map join that turns a served-unavailable stop into a BLOCKED pin.
   - Only if #789 has merged and shipped in the build: the Trips gate control (`TripFlightGateControl`, "Gate on the
     board, e.g. B4").
   - Only once the lifecycle-audit fixes (census-layover §85.3) are DEPLOYED on the server: an ended layover shows no
     crew and no crewmate's location; a deactivated, pending-deletion or banned account is not shown to its crew;
     Airport Pulse leaves out blocked authors. None of these needs a new app build.
   - If your build lacks one of these, the step says what you can observe without it.
5. **Do not press "Ask locals"** (footer, `layover-footer-ask-locals`). It posts a message into your trip chat. Do
   not press "Use Safe Return for this trip back" (`layover-product-setup`) either. Neither is needed here.
6. **Your real deadline matters.** Steps 11 and 12 move the session's departure time. Write down your true departure
   time before you start. Revert each change as the step says, then check that "hard return deadline" is correct
   before you rely on it.
7. "Lead SQL" below always means **read-only** `SELECT`s run on production after the step, by the lead, never by
   the app. `:A` is A's session id and `:B` is B's. Find them with
   `SELECT id, created_at FROM layover_sessions WHERE user_id = '<uid>' ORDER BY created_at DESC LIMIT 1`.

---

## Step 0: preparation (no rows yet)

- **Account A (owner):** add a passport under Profile → Edit profile → "Passports" ("Saved for trip entry and visa
  checks", screen `app/profile/edit/passports.tsx`). Set "Issuing Country" and turn on "Set as primary".
- **Lead pre-check (read-only):**
  `SELECT status FROM entry_requirements WHERE passport_country = '<A passport>' AND destination_country = '<layover country>';`
  The A-vs-B border contrast in step 3 needs a row the entry gate treats as confirmed. The suite uses
  `status = 'visa_free'`. UNSURE which other statuses confirm entry. If no such row exists, A is also
  "entry unconfirmed" and the contrast in step 3 is lost.
- **Account B (second account, a second phone or a simulator):** no passport on file. B is used for
  presence, mutual discovery, crowd reports and the crew of one.
- **A's trip:** a trip in Trips that contains the two real flights. The inbound lands at the layover airport and the
  onward leaves from the same airport. Use a gap of several hours (the suite uses about 9 h).
- Both accounts must be at (or have sessions for) the **same airport and city** while steps 7–9 run.
- Install the build on the iPhone and sign in as A.

## Step 1: A detects the connection in Trips and starts the layover

**Rows:** L11, L169, L267 (opens L239's end-to-end chain)

1. Open the trip (`app/trip/[id].tsx`) and find the card "Layovers on this trip" (`trip-layovers-card`).
2. Press "Add a flight" (`trip-flight-add`) and fill in Flight (`trip-flight-flight`, e.g. "BA286"), From / To
   (`trip-flight-departureAirport`, `trip-flight-arrivalAirport`), "Leaves (local time there)" and "Lands (local time
   there)" (`YYYY-MM-DD HH:MM`). Optionally fill the terminals and "Booking reference". Then press "Add flight"
   (`trip-flight-save`). Do this for the inbound flight and again for the onward flight.
3. **Observe (L169, L11):** a connection row appears by itself (`trip-layover-<key>`), showing
   "<IATA> · <gap>", "<inbound> → <onward> · <booking words>" and a risk line (`trip-layover-risk-<key>`, e.g.
   "Connection on track"). If the two segments name different terminals you also see "Terminal change: …". Trips
   never shows a safety verdict here. That is L11's "must not own layover safety".
4. Press "Start this layover" (`trip-layover-start-<key>`). The app opens `/layover/<id>`.
5. **Observe (L267):** go back to the trip. The row now reads "Layover: <state words>"
   (`trip-layover-state-<key>`) and has an "Open" button (`trip-layover-open-<key>`). An active-layover pill is shown
   on Home (`ActiveLayoverPill`, mounted in `app/(tabs)/index.tsx`).
6. **Lead SQL:** in `layover_sessions` for `:A`, `detected_source = 'trip_itinerary'`, `state = 'DETECTED'`, both
   `arrival_segment_id` and `departure_segment_id` are set, `trip_id` is set and `connection_type` is set. The
   segments are in `trip_transport_segments` (`carrier_code`, `flight_number`, `departure_airport_iata`, …).

**B (second phone):** open the Discovery tab and press the "Layover Mode" button. This opens `LayoverModeSheet`.
Search the same airport under "Where's your layover?", set "You land" and "Your next flight leaves" to times close to
A's, and under "Your bags" pick "Carry-on only" (`layover-start-baggage-CARRY_ON_ONLY`). Press "Start layover".

## Step 2: A's first look at the dashboard, before answering anything

**Rows:** L49, L4, L40, L1, L12, L175

The screen is `app/layover/[id].tsx`. Scroll down to "Your bags and connection" (`LayoverConstraintsCard`).

- **Observe (L49, L4):**
  - The badge reads "One answer needed" (`layover-badge-ask`).
  - A question box (`layover-constraints-question`) asks the one fact that is critical and still unknown. For a
    session created the way the app creates it, that is "Different airport for the next flight?". Its "why" line
    (`layover-constraints-question-why`) reads "If your next flight leaves from a different airport, getting there
    comes first — so we are holding back anything outside this one until you confirm."
  - UNSURE: whether a Trips-started session is asked this question or a different one. Whatever is asked, it is
    the critical unknown.
  - In the "Return to airport" card (`layover-safe-return-card`), the small line `safe-return-certification` reads
    "Computed HH:MM · engine … · feasibility … · **confidence insufficient** · buffer … · inputs xxxxxxxx".
  - Under "What you can actually do", filter "Out in the city": no idea has a "+".
- **Observe (L1, L175):** pull to refresh twice without changing anything. The `inputs xxxxxxxx` hash should stay the
  same (the canonical door reuses the active snapshot). UNSURE: whether `nowMs` enters the hash on this path.
- **L40 (server-side only).** The §5 lifecycle is published on the overview (`lifecycle`,
  `layover_lifecycle_machine_enabled` ON), but the app does not render it (§83.4), and nothing stores it. Production
  can never reach `LANDSIDE_AVAILABLE` (see "Read this before you start", item 1), so only the guard's refusal can be
  checked. The lead reads the API logs for `layover_lifecycle_shadow: overview` (fields `state` and `guardFailures`).
  UNSURE whether the deployment's logs are readable for this.
- **Lead SQL (L1, L12, L175):** `layover_sessions.active_snapshot_id` and `confidence_band` for `:A` equal the
  newest `layover_certified_computations` row (`snapshot_id`, `confidence = 'INSUFFICIENT'`,
  `session_id = :A`). After the two refreshes, `count(*)` of those rows did not grow by one per refresh. For L12, the
  constraints, snapshots and state are all keyed by `session_id`, and the ideas come from `discovery_places` with no
  layover catalog table.

## Step 3: A answers the question; A and B compare the border

**Rows:** L172, L230, L48, L77

1. **A:** on the question, press "No" (`layover-constraints-answer-false`). **B:** answer the same question with
   "No" on B's dashboard.
2. **Observe (L172):** the question disappears, and "Different airport for the next flight?"
   (`layover-constraints-airportChangeRequired-false`) is shown selected. The screen reloads itself after the save.
3. **Observe (L230, L48), side by side:** look at the box "Why we are not suggesting anything outside the airport"
   (`layover-landside-closed`) on each phone.
   - **B (no passport):** shows "· We could not confirm that your passport lets you into this country."
     (`layover-landside-closed-entry_unconfirmed`) **and** "· We don't have checked information about this airport's
     terminals, transport and timings yet, so we only suggest things to do inside the airport."
     (`layover-landside-closed-airport_maturity_limited`). B's "Can I leave the airport?" pill reads "Time is fine —
     entry unconfirmed" (`layover-verdict-caution`), and "Why this answer" lists "Entry permission not confirmed"
     (`layover-reason-code-ENTRY_NOT_CONFIRMED`).
   - **A (passport, confirmed corridor):** shows the maturity line **without** the `entry_unconfirmed` line. A's pill
     is "Yes — you have time" or "Tight — stay close". Both phones show "Limited data for this airport"
     (`layover-reason-code-AIRPORT_MATURITY_LIMITED`).
4. **Observe (L77):** on both phones, under "What you can actually do", the "Out in the city" ideas read
   "Unavailable — <server sentence>" (`layover-rec-unavailable-<n>`) and have no "+". The "In airport" ideas have a
   "+". This is the hard gate (eligibility + entry + time + safety) applied before any ordering.
5. **Lead SQL:**
   - `layover_constraints` for `:A` and `:B`: a new `version` row with `airport_change_required = false`, plus
     `entry_permission_state` and `critical_unknowns`. Expect `UNKNOWN` for B and `CONFIRMED_ALLOWED` for A.
   - `layover_recommendations` for `:B`: no row with `recommendation_status` in an offered state for a
     non-airside card.

## Step 4: A tries the three connection scenarios (each one reverted)

**Rows:** L224, L283, L222, L284, L229, L279, L206, L207, L264

Write down the "usable out of the airport" number in "Can I leave the airport?" before you start.

1. **Airport change (L224, L283).** Press "Different airport for the next flight?" → "Yes"
   (`layover-constraints-airportChangeRequired-true`).
   - Observe "You have to change airports" (`layover-reason-code-AIRPORT_CHANGE_REQUIRED`) and the closure line
     "Your next flight leaves from a different airport." (`layover-landside-closed-airport_change`).
   - Still no landside "+". Then press "No" again.
2. **Self-transfer (L222, L284).** Press "Separate tickets?" → "Yes"
   (`layover-constraints-recheckRequired-true`).
   - Observe "Self-transfer connection" (`layover-reason-code-SELF_TRANSFER_FRICTION`) and a smaller "usable out of
     the airport" number than the one you wrote down. The recheck friction is charged.
   - Press "No" again. The number comes back.
3. **Unknown bags (L229, L279).** Under "Your bags", press "Not sure" (`layover-constraints-baggage-UNKNOWN`).
   - If one bag decides this window, the badge returns to "One answer needed", a bag question appears, and "Bag
     routing not known" (`layover-reason-code-BAGGAGE_STATUS_CRITICAL_UNKNOWN`) is listed. Answering it lifts the
     code.
   - If the bag does not decide on your window, you see only a "What we can't know" line, and L229/L279 are **not
     demonstrated on this layover**. The suite had to search windows from 3 h to 10 h to find one where the bag
     decides. UNSURE whether your real window is such a window.
   - Afterwards, press your real bag answer.
4. **Lead SQL (L206, L207, L264):**
   - `layover_constraints` holds one `version` per accepted press.
   - Each answer-changing press added a `layover_certified_computations` row (`snapshot_id`, `snapshot_version`
     incrementing). The row has the DecisionRecord members `session_id`, `snapshot_id`, `engine_version`,
     `input_hash`, `input_facts`, `source_refs`, `rules_applied`, `verdict`, `reason_codes` and `computed_at` (L207).
   - `expected_active_version` on each new row equals the previous row's `snapshot_version` (3873's CAS, L264).
   - There is no `LY409` / stale-write error in the API logs for these presses.

## Step 5: A explains and replays the stored answer

**Rows:** L189, L191, L5, L240

On "Portava's record of this answer" (`layover-decision-record-card`, drawn only when the overview says the answer
was stored):

1. Press "Explain the stored answer" (`layover-decision-explain`). **Observe (L189):** "FROM PORTAVA'S RECORD",
   then "Checked: re-run from the facts it was given, the stored answer comes out exactly the same."
   (`layover-decision-verified`). The line "Be back at the airport by HH:MM · usable time …"
   (`layover-decision-stored-deadline`) must equal "hard return deadline" above. "Recorded HH:MM · engine …" is
   `layover-decision-provenance`.
2. Press "Re-check stored answers" (`layover-decision-replay`). **Observe (L191, L240):** "RE-CHECKED — Portava
   re-ran N stored answers for this layover: N came out exactly as stored." (`layover-decision-replay-summary`). Any
   "did not" line is a finding.
3. **L5 / Lead SQL:** every `layover_recommendations` row for `:A` has a `snapshot_id` that exists in
   `layover_certified_computations`, which carries `engine_version` and `input_hash`. That is "versioned"; the
   explain and replay above are "explainable" and "replayable".

## Step 6: A's ideas, plan, timed experience, map and Discovery

**Rows:** L64, L296, L117, L122, L125, L269, L15

1. **Ideas (L64, L296).** In "What you can actually do", press "+" on an **In airport** idea (accessibility label
   "Add <title> to plan"). Observe the toast "Added to your plan".
   - Optional stale check for L296 (UNSURE whether you can stage it): with the same account on a second device,
     change a constraint and then press "+" on the first device without refreshing. Expect "These ideas were
     refreshed since you opened them, so nothing was added. Reload them and check the card before adding it."
     (`layover-recs-expired`) and no stop added.
   - **Lead SQL (L64):** run the §83 query for `:A`. Every non-SUPERSEDED `layover_recommendations.snapshot_id` is
     non-null and has exactly one `layover_certified_computations` row. **(L296):** each `layover_plan_stops` row's
     `recommendation_id` belongs to a recommendation generated under the snapshot the add carried.
2. **Timed experience (L15).** On "Your timed experience" (`experience-plan-card`), press "Review timed experience".
   - Observe "Ready to review", the itinerary lines ("HH:MM–HH:MM · Experience", "… · Return to airport"),
     "Back by HH:MM" (it must equal the hard return), and "If the plan becomes unavailable, remain inside the
     airport".
   - Press "Start experience". The card now shows "In progress".
   - **Lead SQL:** `layover_experience_plans` for `:A` has `version` rows with `phase` going from `selected` to
     `executing`, plus `snapshot_id` and `contract`. Nothing in this flow reads the passport. Entry truth stays in
     the entry gate.
3. **Map (L117, L122, L125).** On the map card (`layover-map-card`):
   - Observe the withheld envelope: "Leaving the airport is not on for this layover, so no reach is drawn on this
     map." (`layover-map-envelope-withheld`).
   - In "Your plan" (`LayoverPlanSection`), add a manual stop with **New stop** ("e.g. Ramen at the old market"),
     not inside the airport.
   - The map lists every plan stop with its band. The airside stop is `layover-map-pin-band-<id>` with a band label
     `layover-map-band-<SAFE|TIGHT|BLOCKED>-<id>` (L122). The manual city stop is `layover-map-blocked-<id>` or a
     row reading "Leaving the airport is not on for this layover, so this stop is not on offer." (L117, L125: blocked
     with a reason and never drawn as reachable). UNSURE which of the two texts the server's `mapBand` produces
     here.
   - Not observable on production: the "Inside the ring is not a guarantee…" caveat
     (`layover-map-envelope-inward-caveat`), because there is no envelope.
   - Not observable on a main build: #785's join that blocks a stop whose idea became unavailable.
   - Keep the manual stop. Step 14 cancels it.
4. **Discovery (L269).** Scroll to "Worth leaving for" (`LayoverDiscoveryCard`). Observe either
   `layover-discovery-empty` ("Nothing local is logged in <city> for a layover this length yet.") or gems, each
   showing "needs N min".
   - Then open the Discovery tab while the layover is active. Places outside the certified action universe must not
     be listed.
   - The response's `layover` summary (`excluded`, `UNMEASURED`) is **not rendered by the app** (§83.4), and it is
     not stored. UNSURE what the list looks like when every landside place is excluded. This row can only be judged
     partly on screen.

## Step 7: presence and mutual discovery (A and B)

**Rows:** L127, L128, L202, L130

1. **Both:** in "People in <city>" (`LayoverPeopleSection`), turn on the switch "Show me to other layover
   travelers". Leave it OFF on B for a moment first: B sees no presence box while sharing is off.
2. **Observe (L127, L128, L202):**
   - With both sharing, neither phone shows the other's avatar or name (no `layover-presence-travelers`).
   - Each phone shows "Fewer than 5 other travelers are sharing a layover here this hour, so no number is shown."
     (`layover-presence-below-k`). This is the L0 aggregate rung with k = 5. A number such as "N travelers are also
     on a layover here" needs at least 5 sharers, which this retest cannot stage.
   - If a phone instead shows "We couldn't check who else is here right now…" (`layover-presence-unmeasured`), that
     is a degraded read, not a zero. Record it.
3. **Mutual discovery (L130):** on "Travellers you agreed to see" (`layover-mutual-discovery`):
   - **A** types B's "@handle" and presses "Ask".
   - **B** sees "<A> would like you to see each other on this layover." (`layover-discovery-incoming-<id>`) and
     presses "Agree".
   - Both now list each other (`layover-discovery-mutual-<id>`) with "Stop seeing each other". Before B agreed,
     neither was listed.
   - Optional: press "Stop seeing each other" and observe that both lists empty.
4. **Lead SQL:**
   - `layover_sessions.share_city_status` is true for `:A` and `:B`.
   - `layover_presence` has 0 rows (intents OFF).
   - `layover_discovery_consents` holds the request (`requester_user_id`, `target_user_id`), then `status`
     accepted, and `ended_at` if you stopped.

## Step 8: crowd reports from the terminal (A and B)

**Rows:** L82, L84, L85, L86, L87, L88, L89, L181, L251, L252, L276

On "Live from the terminal" (`AirportConditionsCard`):

1. **A** presses "Queue right now" → "5 min". **Observe (L82, L88 corroboration):** "Thank you — your report is in."
   and "1 traveller has reported — waiting for one more before we show a figure."
2. **B** presses "Queue right now" → "45 min". Pull to refresh on A. **Observe (L181, L84, L85, L86, L87, L89):**
   - A reading appears with "2 travellers · N min ago · <low|medium|high> confidence".
   - "Reports disagree — the more cautious one is shown." appears. The figure shown is the larger, cautious one.
3. **Rate limit (L251):** the footnote reads "We accept N of each kind every M minutes." Press the same kind more
   than N times. Observe the server's refusal sentence in the card's notice. Trust weighting is server-side only.
4. **L252 (server-side only):** the chips are inside the plausible range by design ("a press can never be refused
   as implausible"), so the app cannot send an outlier. The lead confirms the outlier rule in the route; nothing can
   be shown on screen.
5. **L276:**
   - The publish half is these rows.
   - The consume half (`layover_live_intersection_enabled` ON) would show up as "Security queue running long"
     (`layover-reason-code-SECURITY_WAIT_HIGH`) or, after re-entry, "Security: about N min longer than usual…".
     UNSURE whether two queue reports reach the engine. If they do not, the lead checks the newest
     `layover_certified_computations.inputs` for a live-conditions term.
6. **Lead SQL:** `airport_fact_observations` for this airport (`airport_ref`, `fact_type = 'queue_report_minutes'`,
   `value`, `observer_kind`, `observer_trust`, `source_ref`, `observed_at`, `expires_at`). Two rows from two
   observers. They decay because `expires_at` is set. L84's `sourceClass`, `sourceRefs`, `expiresAt` and
   `fallbackLevel` are served on GET /observations but not rendered.

## Step 9: crew (B creates; A cannot join on production)

**Rows:** L124, L134, L135, L166, L132, L158

1. **B:** in "Layover crew" (`LayoverCrewSection`), press "Start a crew". Enter a title, and either leave "Where to
   meet" empty or type one and pick the inside-airport option (`layover-crew-meeting-place-inside`). Press "Create
   crew".
   - Observe "Everyone must be back by HH:MM" (or "Shared deadline — Not certified") and "Just you so far".
2. **A:** pull to refresh. **Expected on production:** "Your layover does not leave room to go and meet a crew in the
   city right now, so none is being offered.", with no "Join".
   - **So L124 (a crewmate on A's map, `layover-map-crew-<userId>`), L134 and L135 (a split plan across two members,
     "Propose a split" → `layover-crew-plan-branch-*`, "Certified against every crewmate's own layover.") cannot be
     retested on production.** Record "BLOCKED: no curated airport".
   - If A **does** see B's crew and can join, landside is not closed for A, and that contradicts item 1 of "Read this
     before you start". Record it, then continue with the crew plan and crew map.
   - UNSURE whether B alone can submit "Propose a split" (one branch, rest empty). That would not demonstrate L134
     in any case.
3. **B, crew of one (L166, L132, L158):** on "Where the crew is" (`layover-crew-location`):
   - **L166:** observe that "Allow exact location with this crew" (`layover-crew-location-precise-switch`) is OFF,
     with "Off by default. Area and venue shares never need it.". Press "Share where I am"
     (`layover-crew-location-share-open`). Only "area" and "venue" precisions are offered
     (`layover-crew-location-precision-area|venue`), not "exact".
   - **L132:** the note says "at most <4 h>, and never past your boarding time". No duration chip goes past it
     (`layover-crew-location-duration-<m>`). Type a label (`layover-crew-location-label`) and press "Share"
     (`layover-crew-location-send`). Observe "You are sharing: <label> · <precision> · until HH:MM"
     (`layover-crew-location-mine`).
   - **L158:** turn the exact switch ON. If a plan-stop pick with a point is offered
     (`layover-crew-location-pick-<id>`), share "exact". Then turn the switch OFF and observe the exact share end.
     UNSURE: an exact share needs a plan stop with coordinates on B's plan.
   - Leave one area or venue share live for step 15.
4. **Lead SQL:**
   - `layover_crews` and `layover_crew_members` (B's crew, one member).
   - `layover_crew_location_grants` for B: `purpose = 'live_session_sharing'`, `session_id = :B`, and
     `expires_at − granted_at ≤ 4 h`.
   - `layover_crew_location_controls`: no row means off. A row with `precise_sharing_enabled` appears while ON. After
     OFF there is no `precision = 'exact'` grant.

## Step 10: A asks Compass

**Rows:** L100, L102, L103, L104, L105, L106, L107, L108, L109, L110, L111, L112, L113, L268

Open "Ask Compass about this layover" (`compass-toggle`). Ask one question at a time in `compass-input` and press
"Ask" (`compass-ask-btn`).

1. **What to look for on every answer:**
   - The answer (`compass-answer`).
   - "Checked: <tools>" (`compass-tools-consulted`). The labels map to tools: your layover = L102, your connection
     = L103, your time = L104, your safe window = L105, what is reachable = L106, your plan = L107, your return
     deadline = L108, this airport = L109, people nearby = L110, what is still unknown = L111, a replan = L112, how
     this was decided = L113.
   - "Computed HH:MM · engine …" (`compass-certification`).
   - Where present, a clarifying question (`compass-clarifying`), "This answer was corrected against your certified
     window." (`compass-boundary-violation`), and a safety note.
2. **Questions that should reach each tool.** The model chooses the tools (`tool_choice: auto`), so UNSURE which
   tools a given question triggers. Re-ask until every label above has appeared at least once.
   - "How much time do I really have, and is my connection OK?"
   - "What could I reach from here, and does my plan fit?"
   - "When exactly do I have to start heading back?"
   - "What is this airport like right now?"
   - "Is anyone here I could meet up with?"
   - "What do you still need to know about me?"
   - "My flight is delayed an hour — what changes?"
   - "Why did you say I can't leave the airport?"
3. **L112 replan:** when an answer offers "Recheck plan with saved details" (`compass-replan-apply`), press it.
   Observe the result line (`compass-replan-result`) or "compass-replan-notice", and the dashboard reloads.
4. **L100 (the model actually ran):**
   - With #785 in the build, a fallback answer carries "The assistant did not shape this answer (…). This is your
     certified answer on its own." (`compass-assistant-fallback`).
   - On a main build that sentence does not exist, so the lead checks it: `layover_events` for `:A` with
     `event_type = 'compass_question_asked'`. In `metadata`, look at `assistant` (`answered` vs `fallback`),
     `assistantFallback`, `modelConsulted`, `toolsConsulted`, `answerMode` and `liveLayover`. Each tool in L102–L113
     must appear in some row's `toolsConsulted`.
5. **L268:** tool access, explanation and clarification are observed above. The "proactive OpportunityEvent" half
   reaches the app only as the replan notice in step 11 ("Worth knowing — …"). UNSURE whether that counts for L268.
6. **Lead SQL (L112):** `layover_compass_actions` (`kind`, `expected_snapshot_id`, `status`, `result`) for the
   recheck.

## Step 11: A changes the flight time (the traveller's own edit)

**Rows:** L95, L190, L238

1. On "Flight time changed?" (`layover-flight-change-card`), press "+15m" (`flight-shift-15`).
2. **Observe (L238):**
   - The outcome box (`replan-outcome`) shows either "Worth knowing — …" / "Check your plan — …" (`replan-notify`)
     or "Nothing you need to do differently." (`replan-no-notify`).
   - "Some saved options were certified against your old window." (`replan-recommendation-expired`) may appear, if
     a planned stop was affected.
   - The line `replan-certification` reads "flight.… · <engine> · replan <v>".
3. **Observe (L190):** "What changed since your last answer" (`layover-answer-changes-card`) lists the moves
   (`layover-answer-change-<i>`), for example the return deadline. Press "Got it" (`layover-answer-changes-ack`).
4. **Revert:** press "15m earlier" (`flight-shift--15`). Check that "hard return deadline" is your true one again.
5. **Lead SQL:**
   - **L95:** a new `layover_certified_computations` row with a new `snapshot_id` and the session's highest
     `snapshot_version`. Its `snapshot_id` equals `layover_sessions.active_snapshot_id`. The row is immutable (2992
     and 3896 triggers present).
   - **L238:** the chain event (`layover_events`), then the new snapshot, then `layover_recommendation_supersessions`
     rows (`superseded_snapshot_id`, `superseding_snapshot_id`, `cause`) for cards certified under the old window,
     then the notify decision shown on screen.

## Step 12: A reports a disruption

**Rows:** L44

1. On the disruption card (`layover-disruption-card`), press "Delayed" (`layover-disruption-open-delay`). Under "Or
   only the total delay in minutes", enter 15 (`layover-disruption-delay-minutes`) and press "Send". Do not use
   "Cancelled": the card says a cancellation cannot be undone.
2. **Observe:**
   - The state (`layover-disruption-state-<state>`) and the source (`layover-disruption-source`).
   - The recompute block (`layover-disruption-recompute`) with the new usable time
     (`layover-disruption-usable`), the hard return (`layover-disruption-hard-return`) and the return state
     (`layover-disruption-return-state`).
   - The ideas list reloads. Cards certified before the report are no longer offered, or show "Unavailable — …".
3. **Revert:** press "Back on time" (`layover-disruption-report-on_time`). UNSURE whether "Back on time" restores the
   departure time. If it does not, use the flight-change chips and re-check your deadline.
4. **Lead SQL:**
   - `layover_events` rows with `event_type = 'session_updated'` (the disruption ledger, `metadata`).
   - A new `layover_certified_computations` row.
   - `layover_recommendation_supersessions` rows for the stale cards: the card is kept, marked SUPERSEDED, and the
     history row is the audit trail.

## Step 13: A goes offline

**Rows:** L233, L153

1. Turn on airplane mode and pull to refresh on the dashboard.
2. **Observe (L233):**
   - "Couldn't load this layover" with "We couldn't reach Portava. Check your connection and try again."
     (`layover-load-error`).
   - "Last certified return time" with the time (`layover-cached-deadline-time`) and a staleness line
     (`layover-cached-deadline-staleness`).
   - "Your last certified plan" (`layover-cached-plan`) with the airport and your stops, and its staleness line
     (`layover-cached-plan-staleness`).
   - The offline map with its stale badge (`layover-map-offline-badge`).
3. **Observe (L153, main build):** in the cached plan, the flight line reads "No update has been recorded for your
   flight, so no gate or status is saved. Check the departure board." (`layover-cached-plan-flight-none`).
   - With the batch-3 build, before going offline, open the trip and use "Gate on the board, e.g. B4"
     (`trip-flight-gate-input-<id>`, then save). Expect "Gate saved. Departure boards change: check it again before
     you head back.". Offline, the cached flight lines (`layover-cached-plan-flight-<i>`) then show the gate with who
     recorded it and when. After 15 minutes the stale line appears (`layover-cached-plan-flight-stale`).
   - On a main build there is no control that records a gate (§83.2), so the recorded-gate half of L153 waits for
     that release.
4. Turn airplane mode off and press "Try again" (`layover-load-retry`).
5. **Lead SQL (batch-3 build only):** `trip_transport_segments` for the onward segment: `departure_gate`,
   `flight_status_source = 'traveller'`, `flight_status_observed_at`.

## Step 14: A returns to the airport now

**Rows:** L6

1. Before pressing anything, compare the deadline on every surface. They must be the same instant:
   - "hard return deadline" in "Can I leave the airport?"
   - "Be back by" on the return card (`safe-return-hard-time`)
   - The map's airport sheet (tap the airport, `layover-map-airport-sheet-time`)
   - The decision record's "Be back at the airport by" (step 5)
   - B's crew "Everyone must be back by" (B's own deadline, for B's crew)
   - Also the `inputs xxxxxxxx` hash on `safe-return-certification`
2. Press "RETURN TO AIRPORT" (`return-to-airport-btn`). There is no confirm. **Observe:** the return contract
   (`return-contract`) with the same hard time (`contract-hard-time`), the count of landside stops cancelled
   (`contract-cancelled-count`, which should include the manual city stop from step 6) and the effect lines
   (`abort-effect-line`).
3. **Lead SQL (L6):** for `:A`, the `layover_recommendations.snapshot_id` of the current cards,
   `layover_sessions.active_snapshot_id`, and the snapshot of the newest `layover_return_plans` and
   `layover_time_budgets` rows are one and the same `snapshot_id`. UNSURE: what `layover_sessions.status` becomes
   after the abort (`returning` is expected).

## Step 15: back at the airport (A and B)

**Rows:** L173, L43, L137

1. **A:** on the return card's check-in block (`layover-checkpoints`), press "I've left the airport"
   (`layover-checkpoint-left`), then "I'm back at the airport" (`layover-checkpoint-back`). The block says "This does
   not change your return time.".
   - On production you never actually leave (landside is closed), so these are reports only. The server takes them
     anyway.
2. **Observe (L173):** "You told us you were back at the airport at HH:MM." (`layover-checkpoints-status`). Press the
   button twice quickly: still one check-in.
3. **Observe (L43):**
   - The card "Back at the airport — your gate" (`layover-reentry-card`) shows "You checked in at HH:MM. City
     suggestions are paused; this was refreshed at HH:MM.", the flight line (main build: "No gate or status has been
     recorded for your flight yet. Check the departure board."), and "Security: no live reading. Your return time
     already allows the airport's usual security time." (`layover-reentry-security`).
   - In ideas: "You told us you're back at the airport, so ideas out in the city are hidden."
     (`layover-recs-landside-suppressed`).
4. **B (L137):** with B's share from step 9 still live, B presses "I've left the airport" and then "I'm back at the
   airport". **Observe:** "You are sharing: …" (`layover-crew-location-mine`) is gone, and "Share where I am" is back.
5. **Lead SQL:**
   - `layover_checkpoints` for `:A`: two rows (`checkpoint_type` LANDSIDE_EXIT then AIRPORT_REENTRY, `source`,
     `observed_at`, `expires_at`, `dedup_key`), with no duplicate for the double press.
   - `layover_crew_location_grants` for B: 0 live rows.

## Step 16: end the layover (A, then B)

**Rows:** L174, L239, L241, L294, L200

1. **A:** press the footer's end button (`layover-end-open`). The sheet asks "How did this layover end?"
   (`layover-end-sheet`). Leave the stamp, memory and postcard elections off (or on, if you want them) and press "I made
   my flight" (`layover-end-completed`).
2. **Observe (L174):** a toast, then the screen closes. Re-open the layover from the trip ("Open"). Observe "This
   layover is completed. You're viewing a snapshot." and "Make a postcard of this layover".
3. **B:** press "Disband crew" first, which is the dissolution end of a share (extra evidence for L137). Then end B's
   layover with "I'm ending it early" (`layover-end-cancelled`).
4. **Lead SQL:**
   - **L174:** `layover_outcomes` for `:A` has `completed_at`, `boarding_outcome = 'BOARDED'` and
     `actual_airport_return_at` (if set). `layover_sessions.status = 'completed'` for `:A`, and `cancelled` for `:B`.
   - **L239:** one session now has every stage: detection (`detected_source = 'trip_itinerary'`), evaluation
     (`layover_certified_computations`), plan (`layover_plan_stops`, `layover_experience_plans`), execution
     (`phase = 'executing'`), return (abort plus `layover_checkpoints`) and completion (`layover_outcomes`).
   - **L241 (lead action, not an app action):** this session's stored decisions are the first post-press
     **historical** corpus. The lead runs the decision-diff comparison over those rows. The synthetic half already
     runs in `check:all`. UNSURE how the historical corpus is exported read-only.
   - **L294 (server convention; the owner cannot fault-inject production):** the lead confirms that the API logs for
     the retest window carry no layover read failure answered as data. The owner confirms that no card ever showed a
     zero or empty state that the server had not measured; during step 13 each card said it could not load.
   - **L200 (server-side only):** the app only ever sent the declared fields (constraints card), `departureTime`
     (flight-change chips), the disruption report, share, reminder and close. The lead confirms that `anon` and
     `authenticated` still hold no column-level write grant on any layover table (§82.1) and that the session's
     rows for `:A` changed only through those routes. No screen shows this.

---

## Row map: every retest row, once

| row | step | requirement (short) | what proves it |
| --- | --- | --- | --- |
| L1 | 2 | One canonical operational truth | inputs hash stable on refresh; `active_snapshot_id` = newest computation, no row per refresh |
| L4 | 2 | Unknown critical facts lower confidence, may fail closed | "confidence insufficient" + no landside "+" while the question is open |
| L5 | 5 | Recommendations versioned, explainable, replayable | `snapshot_id` → computation with `engine_version`/`input_hash`; Explain + Re-check buttons |
| L6 | 14 | All surfaces read one certified snapshot | same deadline on 5 surfaces; recs/session/return-plan share one `snapshot_id` |
| L11 | 1 | Trips owns flight segments, not safety maths | "Add a flight" → segments in `trip_transport_segments`; Trips shows no verdict |
| L12 | 2 | Session owns lifecycle/constraints/snapshots/state, no catalog | lead SQL: all keyed by `session_id`; ideas from `discovery_places` |
| L15 | 6 | Experience plans from feasible actions, no entry truth | "Review timed experience" → "Start experience"; `layover_experience_plans` phases |
| L40 | 2 | EVALUATING → LANDSIDE_AVAILABLE guard | server-side only: `layover_lifecycle_shadow` log `guardFailures`; positive branch unreachable on prod |
| L43 | 15 | Re-entry stops landside, refreshes gate/security | `layover-reentry-card` + `layover-recs-landside-suppressed` |
| L44 | 12 | Disruption invalidates, replans, keeps audit | recompute block; `layover_recommendation_supersessions` rows |
| L48 | 3 | Unconfirmed entry forbids landside | B shows `layover-landside-closed-entry_unconfirmed`, A does not |
| L49 | 2 | Critical unknown ⇒ INSUFFICIENT + no landside | "One answer needed" + "confidence insufficient" |
| L64 | 6 | Each recommendation stores its snapshot | §83 SQL: every card's `snapshot_id` is a stored computation |
| L77 | 3 | Hard gate before optimisation | landside ideas "Unavailable — …" with no "+"; airside "+" |
| L82 | 8 | Traveller observation channel | "Queue right now" chips → "Thank you — your report is in." |
| L84 | 8 | TruthValue shape | value/confidence/conflict/age shown; other members only on GET /observations |
| L85 | 8 | Never silently merge contradictions | "Reports disagree — the more cautious one is shown." |
| L86 | 8 | Provenance + conflict flag | `airport_fact_observations.observer_kind/source_ref` + conflict line |
| L87 | 8 | Conservative value on disagreement | shown figure is B's larger 45 min |
| L88 | 8 | Plausibility, corroboration, decay | "waiting for one more" then reading; `expires_at` |
| L89 | 8 | Contradiction raises uncertainty | confidence word after the conflicting report |
| L95 | 11 | Replan creates a new immutable snapshot | new `snapshot_id`/`snapshot_version` after "+15m" |
| L100 | 10 | Compass orchestrates and explains | answers + tools line; `layover_events` `compass_question_asked.metadata.assistant` |
| L102 | 10 | Tool getLayoverContext | "Checked: your layover" / `toolsConsulted` |
| L103 | 10 | getConnectionState | "your connection" |
| L104 | 10 | getTimeWallet | "your time" |
| L105 | 10 | getSafeEnvelope | "your safe window" |
| L106 | 10 | getReachableExperiences | "what is reachable" |
| L107 | 10 | simulatePlan | "your plan" |
| L108 | 10 | getReturnContract | "your return deadline" |
| L109 | 10 | getAirportState | "this airport" |
| L110 | 10 | getCrewCandidates | "people nearby" |
| L111 | 10 | requestConstraintClarification | "what is still unknown" / `compass-clarifying` |
| L112 | 10 | replan | "a replan" + "Recheck plan with saved details"; `layover_compass_actions` |
| L113 | 10 | explainDecision | "how this was decided" |
| L117 | 6 | Pins outside the universe hidden or blocked | manual city stop listed blocked / "not on offer" |
| L122 | 6 | Candidate pin carries feasibility | `layover-map-band-<BAND>-<id>` on the airside stop |
| L124 | 9 | Crew member on map only with permission | BLOCKED on prod: A cannot join B's crew (safety_gate_not_passed) |
| L125 | 6 | Blocked area explains, never implies fit | withheld-envelope sentence + blocked stop reason; ring caveat not reachable on prod |
| L127 | 7 | Aggregate presence by default | both sharing, no names/avatars shown |
| L128 | 7 | L0 aggregate only | `layover-presence-below-k` sentence (k = 5) |
| L130 | 7 | L2 mutual discovery | Ask → Agree → `layover-discovery-mutual-<id>`; `layover_discovery_consents` |
| L132 | 9 | Temporary location: explicit, scoped, auto-expiring | B's share "until HH:MM", ≤ 4 h; grant row `expires_at − granted_at ≤ 4h` |
| L134 | 9 | Explicit split plans | BLOCKED on prod (needs two crew members) |
| L135 | 9 | Crew plan certified per branch | BLOCKED on prod (needs two crew members) |
| L137 | 15 | Crew share ends at re-entry/dissolution/… | B's `layover-crew-location-mine` gone after "I'm back"; 0 live grants |
| L153 | 13 | Flight/gate cached with stale indicator | main: "No update has been recorded…"; batch-3 build: recorded gate + stale line |
| L158 | 9 | Precise location session-scoped, expires | exact share ends when the control goes OFF; grant `session_id = :B` |
| L166 | 9 | Precise sharing separate control, off by default | switch OFF; no "exact" chip until ON; no controls row = off |
| L169 | 1 | detectFromTrip | connection row appears after adding both flights |
| L172 | 3 | updateConstraint | answer chip saved; new `layover_constraints.version` |
| L173 | 15 | recordCheckpoint | "You told us you were back…"; one row per tap (dedup) |
| L174 | 16 | close(outcome) | "I made my flight" → `layover_outcomes.boarding_outcome = 'BOARDED'` |
| L175 | 2 | evaluate(sessionId) | server-side: /overview certification rows (with L1) |
| L181 | 8 | reconcile(observations) | two reports → one reconciled reading with confidence |
| L189 | 5 | explain(snapshotId) | "Checked: re-run … exactly the same." |
| L190 | 11 | diff(previous, next) | "What changed since your last answer" after "+15m" |
| L191 | 5 | replay(sessionId, engineVersion) | "Re-check stored answers" summary |
| L200 | 16 | Own session inputs within allowed fields | server-side only: no client write grants; writes only via routes |
| L202 | 7 | Presence readable only by scope/policy | no identities across A/B; `layover_presence` empty |
| L206 | 4 | Every material recomputation stores snapshot + record | one computation row per answer-changing press |
| L207 | 4 | DecisionRecord shape | computation row columns `input_facts/source_refs/rules_applied/reason_codes/…` |
| L222 | 4 | Self-transfer → recheck friction | "Separate tickets? Yes" lowers usable minutes |
| L224 | 4 | Airport change → exploration subordinate | "Different airport? Yes" closes landside |
| L229 | 4 | Unknown baggage fails closed if critical | "Not sure" → bag question (only if the bag decides; UNSURE) |
| L230 | 3 | Unknown entry → no landside | B closed by `entry_unconfirmed`, A not |
| L233 | 13 | Offline: cached return plan with stale badge | airplane mode → `layover-cached-plan` + staleness |
| L238 | 11 | event → replan → snapshot → invalidation → notification | `replan-notify` + new snapshot + supersession rows |
| L239 | 16 | E2E detection → … → completion | one session with rows in every stage's table |
| L240 | 5 | Deterministic replay of recorded sessions | replay of this real session: N of N match |
| L241 | 16 | Decision-diff over historical corpora | lead runs diff over this session's stored decisions |
| L251 | 8 | Rate-limit + trust-weight observations | footnote limit; refusal past N presses |
| L252 | 8 | Outlier detection | server-side only: chips cannot send an outlier |
| L264 | 4 | CAS the active snapshot | `expected_active_version` = previous `snapshot_version`; no LY409 |
| L267 | 1 | Trips: detect, show status, pass segments | "Layover: <state>" + "Open"; session has both segment ids |
| L268 | 10 | Compass: tools, clarification, OpportunityEvents | tools line + `compass-clarifying`; opportunity only via replan notice (UNSURE) |
| L269 | 6 | Discovery shows only the certified universe | Discovery tab during the layover; `layover` summary not rendered (partial) |
| L276 | 8 | Consume crowd signals; publish observations | `airport_fact_observations` rows; consume effect UNSURE |
| L279 | 4 | BAGGAGE_STATUS_CRITICAL_UNKNOWN | `layover-reason-code-BAGGAGE_STATUS_CRITICAL_UNKNOWN` (conditional, as L229) |
| L283 | 4 | AIRPORT_CHANGE_REQUIRED | `layover-reason-code-AIRPORT_CHANGE_REQUIRED` |
| L284 | 4 | SELF_TRANSFER_FRICTION | `layover-reason-code-SELF_TRANSFER_FRICTION` |
| L294 | 16 | Never swallow a read error into empty state | server-side: no failure answered as data in logs; app never shows unmeasured zeros |
| L296 | 6 | Never certify against another snapshot | add carries the card's snapshot; stale add → `layover-recs-expired` (optional) |

## Open items (the lead settles these before the run)

1. Whether the local `origin/main` (`9d5f6d481`) is current, and so which of #785 and batch 3 the iPhone build
   contains.
2. Which `entry_requirements.status` values confirm entry. The suite uses `visa_free`. This decides the A-vs-B
   contrast.
3. Whether a session started from Trips is asked "Different airport for the next flight?" or a different first
   question.
4. Whether the inputs hash stays the same across refreshes (whether `nowMs` enters it on the canonical path).
5. Whether the API logs (`layover_lifecycle_shadow`) can be read for L40.
6. Whether the real window is one where one bag decides (L229/L279).
7. Which text the map shows for a manual city stop (server `mapBand` reason vs "not on offer").
8. What the Discovery tab shows in layover mode with every landside place excluded (L269).
9. Whether two community queue reports reach the certified record (L276 consume half).
10. Whether B alone can submit a split plan, and whether an exact share is reachable without a plan stop that has
    coordinates.
11. Which tools the Compass model calls for each question, and whether the replan notice counts as L268's
    OpportunityEvent.
12. Whether "Back on time" restores the departure time after a delay report.
13. What `layover_sessions.status` becomes after "Return to airport".
14. How the historical corpus for L241 is exported read-only.
