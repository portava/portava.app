# Layover 165: verification ledger (in progress)

Updated 2026-10-22. This ledger records actual evidence and outstanding verification. It is not a declaration of completion. Through the 2026-10-20 continuation no row was promoted to VERIFIED PASS. On 2026-10-22, after release 9d3dc5d0, four of the 165 rows (L20, L195, L197 and L199) are VERIFIED PASS on production evidence. The final section records them with implementation, production activation and external evidence kept apart. Each is "writer reachable", not "rows observed". For every other row, production activation and external evidence remain separate requirements.

The complete requirement, acceptance rule, dependencies and implementation status are in [the remediation tracker](layover-165-remediation-progress.md). The original baseline remains unchanged.

## Confirmed continuation evidence

- Five beta release-script suites: 379 passed, zero failures.
- Focused flight and rollout checks in the isolated staged tree: 37 passed, zero failures.
- Assistant safety suite: 370 passed, zero failures. Six regression mutants were killed in an isolated copy, restored byte-identically afterward.
- PostgreSQL result-collection repair: original INSERT subquery reproduced error 42601; repaired INSERT, SELECT, UPDATE, DELETE and empty-result cases passed.
- Flight commit `2a99ebc365ba8445c3b929380e021afde6a3ac53` passed all 33 gates. Fresh broad API main run: 41079 passed, 2 static checks failed and then passed after repairs; final aggregate full-suite verification remains open.
- Curation readiness: 17/17 migrated workflow tests. Crew: 55/55 migrated tests. Canonical snapshot: 8 real-schema tests and rollback/refusal proofs; cross-surface matrix subsequently passed6 migrated cases and15 neighbors; original drop-filter mutant killed.
- Live Compass continuity: red deadline regression repaired, 10/10 migrated live tests; assistant/privacy/abort combined 425/425.

## Latest integrated batch evidence

- Compass execution: 12 migrated/rollback tests and 11 client tests.
- Safe Return: 16 migrated product/abort tests, 64 client tests and 15 isolated mutants killed; rollback tested in two orders.
- Metrics: 7 migrated tests; audit: 8 migrated tests and 3 rollback/refusal tests; authorization: 87 endpoints refused missing authentication.
- Query/schema inventory: 5 migrated tests and 2 inventory/control tests. These do not establish arbitrary runtime payloads or every ownership path.
- MAP: API 79 plus adapter 3; client 107 plus dashboard 130; eleven client and four API mutants killed, masked/redundant survivors disclosed. L61 continuous coverage and L270 digital twin remain incomplete.
- Provenance: actual absent-column refusal preserves existing recommendations/history, 7/7 migrated tests.
- ENGINE delivered lifecycle/policy/incremental/localization evidence; full per-stage timing, traveller GPS and activity interruptibility remain open. L15 lifecycle passed38 API/database,14 outdoor and8 client tests; rollback review continues. L273 passed7 migrated cases,30 client checks and isolated mutants; final handback integration is pending.
- Independent audit review reproduced two defects: expired-row backlog incorrectly reported success and rollback removed later permissions. Catch-up/scheduler29 and hardened rollback6 now pass. Retention may lag during outages/backlog; health exposes incomplete work and retries.
- L259 route integration passed3 unit and5 migrated cases, but independent review then found snapshot-change and partial-publication gaps. Those were hardened and superseded by the 3908 durable fanout evidence below; independent verification is still pending.
- Citation repairs are semantic source checks, with a clean citation scan and the dead-target ceiling tightened152 to150. No final aggregate, real PostgreSQL CI, production activation or human review is claimed.

## Independent continuation evidence, 2026-10-19

- L78:55/55 server and5/5 client;3898/3899 final rollback16/16. Curator erasure15/15 unit and2/2 migrated cases, including permission refusal and idempotent retry.
- L273:58/58 server,30/30 client,9 isolated mutants. Route watches10/10 unit/migrated and92/92 neighbors;7 mutants.3893/3894/3895 complete catalog/all-row roundtrips6/6, both orders. Durable fanout above200 remains open.
- Canonical3871/3873/3896/3897 hardened rollback8/8 with21/15/8/21 refusal controls per order;14/14 existing neighbors. Dashboard/vocabulary independent5/5, with isolated shared-evaluation, dropped-CHECK and open-RLS mutants killed.
- Audit3890 final9/9 including whole-catalog/all-row roundtrips and function planner-attribute drift. Endpoint missing-authentication probe and query inventory factory controls pass; independent service-scope review continues.
- MAP:102/102 focused API plus12/12 later controls,18/18 migrated curation,1/1 actual geometry-persistence proof; client20/20 and10/10 cache/map. Native production types and existing test baseline pass. Google credentials/native builds/real airport coordinates, future DRIVE coverage, full indoor twin and between-stop geometry remain outstanding.
- Combined repository gates30/33 passed at the recorded run; citation references and route type diagnostics were then repaired. Fresh final aggregate remains required.
- Flight commit CI run39212772750 finished failed: stale kernel count assertions, flight index-planner fixture and PostgreSQL absent-schema harness. These are being repaired; no green CI claim. Live DB run39212772738 also failed, recorded separately.

## Claude resume evidence, 2026-10-20

All logs are under the session scratchpad `l165/` directory, recorded in the handoff follow-up; PostgreSQL runs used the task-local PostgreSQL 17.11/PostGIS 3.6 server. CI's local-DB job uses PostgreSQL 16/PostGIS 3.4, so these runs do not substitute for that job.

- Current position (L56): the production type error at `LayoverCurrentPosition.ts:80` is fixed by narrowing stored confidence; any grade outside HIGH/MEDIUM/LOW is the weakest grade and the preview refuses. Unit 5/5; migrated 3/3. The client late-fix test now presses the mounted control and switches the session while the fix is outstanding (an earlier version that held the press open across a rerender voided later renders in the file and was replaced): client 5/5, and a mutant removing the post-fix session guard is killed. Refusals now map feature-off/not-found to 404 and unreadable/outage reasons to 503; a measured not-enough-time refusal has its own copy.
- Between-stop geometry (L270): normal selected plans failed because recommendation stops never store coordinates. Compile now writes `routeInputHash` (SHA-256 over ordered keys, positions, dwell and activity commitment); geometry refuses a plan without it and a moved place before or after routing. The final recheck recomputes before reading the plan, so a canonical change reports `snapshot_changed`. Migrated 7/7, zero skips; client 5/5; six binding mutants killed, source bytes restored.
- Route fanout (L259): rerun on the current tree, the route-subject/fanout, timing, executable-plan and experience-contract suites pass 39/39 on PostgreSQL 17 with zero skips. The crew's 10 fanout mutants (killed, source restored) are recorded in its handback logs and were not rerun. The 3895 and 3908 full-catalog rollback proofs, previously scratch-only, are now registered (`layoverRouteMigrations.db.test.ts`): 4/4, both installation orders, 14 and 15 refusal controls.
- Type checks (before the cross-review fixes below; rerun in the final aggregate): API production clean; API tests 860/113 and client tests 173/60, both equal to baseline; client production clean.
- Client `check:all` on the staged tree first failed 4 node tests and 6 component tests, all from the uncommitted continuation, none from 2a99ebc3: the sensing guard flagged `showsUserLocation={false}`/`showsMyLocationButton={false}` by name in `LayoverGoogleRouteMap.tsx` (removed; both are the SDK defaults or depend on them); `layoverGoogleMap.ts` loaded React Native through the geometry service (the pure binding moved to `lib/layoverExperienceGeometryBinding.ts`); the Telegraph cursor source assertion pinned the pre-epoch auth callback text (regex updated, mutant killed); the location door test still said live return assistance was unbuilt (L157 built it; test and comment updated); the crew-location flag test answered every dashboard read with the crew scenario, so the objective-intent card's own refusal copy matched its error regex (spy now answers only the crew read).
- Independent cross-review (read-only, different model) of current position and between-stop geometry: no CRITICAL or HIGH. Fixed: activity commitment `sourceRefs` now sorted so the plan input hash cannot change with database row order (mutant killed); status mapping and copy above; the geometry fall-back test now carries real card data with a positive control (fall-through mutant killed). Left for the owner: (M1) each current-position check spends three Routes calls from the session's lifetime cap of 36 (R5), with no reserve held back for compile or return guidance; (L1) a started plan's map expires with its contract, so an executing plan normally has no map after a few minutes.
- `test:db-local` cannot run on the task-local PostgreSQL 17 server: its guard refuses because `2490_destructive_privilege_boundary.sql` (PostgreSQL 17's MAINTAIN privilege) replays cleanly there while it is listed as unreplayable for CI's PostgreSQL 16. That tier is CI-only evidence.

## Requirement-by-requirement verification state

| Requirement | Current implementation record | Verification state |
| --- | --- | --- |
| L1 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L4 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L5 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L6 | BUILT (cross-surface migrated evidence delivered; independent verification and production activation pending) | Original acceptance not yet independently closed in production. |
| L11 | BUILT (owned Trips flight/terminal context and canonical invalidation tested; licensed automatic feed, final verification and owner press pending) | Original acceptance not yet independently closed in production. |
| L12 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L14 | BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending) | Original acceptance not yet independently closed in production. |
| L15 | BUILT (executable lifecycle, client path and hardened rollback tests delivered; final aggregate and production press pending) | Original acceptance not yet independently closed in production. |
| L17 | BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending) | Original acceptance not yet independently closed in production. |
| L20 | VERIFIED PASS (production-verified 2026-10-22 after release 9d3dc5d0; writer reachable, 0 rows observed) | Closed in production 2026-10-22. Implementation, activation and external evidence are in the final section; census-layover §81 grades it C. |
| L21 | BUILT (lane B1-F; independent verification pending; W until the press) | Original acceptance not yet independently closed in production. |
| L26 | BUILT (canonical snapshot and history batch; independent verification and production press pending) | Original acceptance not yet independently closed in production. |
| L31 | BLOCKED-EXTERNAL (producer feed + LAYOVER_EVENT_PRODUCER_SECRET; technical work complete) | Original acceptance not yet independently closed in production. |
| L33 | BUILT (lane B1-F; independent verification pending; W until the press). ABANDONED has no writer (no §5 edge) | Original acceptance not yet independently closed in production. |
| L35 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L36 | BUILT (pressed in production 2026-10-22; production verification found that HIGH has no producer) | Not closed. HIGH is never produced on any stored risk band (owner question OQ-L36-1). census-layover §81 keeps W. |
| L37 | BUILT (pressed in production 2026-10-22; production verification found that no stored decision reaches MEDIUM or HIGH) | Not closed. Every stored decision is LOW or INSUFFICIENT (owner question OQ-L37-1). census-layover §81 keeps W. |
| L38 | BUILT (canonical snapshot and history batch; independent verification and production press pending) | Original acceptance not yet independently closed in production. |
| L39 | BUILT (traveller lifecycle gaps repaired with migrated proof; independent verification and production press pending; automatic observations require approved feed) | Original acceptance not yet independently closed in production. |
| L40 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L41 | BLOCKED-EXTERNAL (Apple Time Sensitive capability, signed device build, PUSH_IOS_TIME_SENSITIVE_ENTITLED; technical work complete) | Original acceptance not yet independently closed in production. |
| L44 | BUILT (canonical snapshot and history batch; independent verification and production press pending) | Original acceptance not yet independently closed in production. |
| L46 | BUILT (sourced stage and joint-journey timing reaches routing and execution; reviewed real data, final verification and production press pending) | Original acceptance not yet independently closed in production. |
| L48 | BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending) | Original acceptance not yet independently closed in production. |
| L50 | BUILT (visible unavailable cards and refusal paths tested on migrated schema; independent verification and press pending) | Original acceptance not yet independently closed in production. |
| L54 | BUILT (sourced stage and joint-journey timing reaches routing and execution; reviewed real data, final verification and production press pending) | Original acceptance not yet independently closed in production. |
| L55 | BUILT (sourced stage and joint-journey timing reaches routing and execution; reviewed real data, final verification and production press pending) | Original acceptance not yet independently closed in production. |
| L56 | BUILT (traveller current-position preview delivered; native-device evidence and the L81 world-condition feed remain external) | Original acceptance not yet independently closed in production. |
| L58 | BUILT (complete policy projection and replay evidence delivered; independent verification and press pending) | Original acceptance not yet independently closed in production. |
| L60 | BUILT (lane B1-R1; independent verification pending; W until the Routes press) | Original acceptance not yet independently closed in production. |
| L61 | IN PROGRESS (continuous WALK implementation tested; future DRIVE coverage unsupported and external provider validation pending) | Original acceptance not yet independently closed in production. |
| L63 | BUILT (lane B1-R1; independent verification pending; W until the Routes press) | Original acceptance not yet independently closed in production. |
| L65 | BUILT (lane B1-R1; independent verification pending; W until the Routes press) | Original acceptance not yet independently closed in production. |
| L66 | BUILT (lane B1-R1; independent verification pending; W until the Routes press) | Original acceptance not yet independently closed in production. |
| L67 | BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending) | Original acceptance not yet independently closed in production. |
| L68 | BUILT (lane B1-R1; independent verification pending; W until the Routes press) | Original acceptance not yet independently closed in production. |
| L69 | BUILT (lane B1-R1; independent verification pending; W until the Routes press) | Original acceptance not yet independently closed in production. |
| L70 | BUILT (transport and sourced activity commitment integrated and locally tested; source population, final verification and production press pending) | Original acceptance not yet independently closed in production. |
| L71 | BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending) | Original acceptance not yet independently closed in production. |
| L73 | IN PROGRESS (offline contract readiness implemented; full offline navigation requirement remains open) | Original acceptance not yet independently closed in production. |
| L74 | BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending) | Original acceptance not yet independently closed in production. |
| L76 | BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending) | Original acceptance not yet independently closed in production. |
| L77 | BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending) | Original acceptance not yet independently closed in production. |
| L78 | BUILT (sourced producers, UI, migrated ranking and rollback evidence; independent acceptance and production activation pending) | Original acceptance not yet independently closed in production. |
| L79 | BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented) | Original acceptance not yet independently closed in production. |
| L80 | BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented) | Original acceptance not yet independently closed in production. |
| L81 | BLOCKED-EXTERNAL (licensed official/operator live feed endpoint and credentials; crowd evidence alone does not satisfy the whole fast-live requirement) | Original acceptance not yet independently closed in production. |
| L82 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L83 | BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending) | Original acceptance not yet independently closed in production. |
| L84 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L85 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L86 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L87 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L88 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L89 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L92 | BUILT (pressed-path defect fixed by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L93 | BUILT (pressed-path defect fixed by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L94 | BUILT (incremental derivation and poison resistance tested; independent verification and press pending) | Original acceptance not yet independently closed in production. |
| L97 | BUILT (canonical snapshot and history batch; independent verification and production press pending) | Original acceptance not yet independently closed in production. |
| L100 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L102 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L103 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L104 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L105 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L106 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L107 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L108 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L109 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L110 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L111 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L112 | BUILT (explicit authorized recheck execution, database and client evidence; independent acceptance and production press pending) | Original acceptance not yet independently closed in production. |
| L113 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L115 | BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending) | Original acceptance not yet independently closed in production. |
| L116 | BUILT (server-owned geographic display and persistent cache tested; independent acceptance and applicable production/device evidence pending) | Original acceptance not yet independently closed in production. |
| L117 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L118 | BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending) | Original acceptance not yet independently closed in production. |
| L119 | BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending) | Original acceptance not yet independently closed in production. |
| L120 | BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented) | Original acceptance not yet independently closed in production. |
| L121 | BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending) | Original acceptance not yet independently closed in production. |
| L122 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L125 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L127 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L128 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L130 | BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending) | Original acceptance not yet independently closed in production. |
| L134 | BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending) | Original acceptance not yet independently closed in production. |
| L135 | BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending) | Original acceptance not yet independently closed in production. |
| L137 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L139 | BLOCKED-EXTERNAL (actual shared-ride provider/product contract; unavailable is not a completed opt-in ride) | Original acceptance not yet independently closed in production. |
| L143 | BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented) | Original acceptance not yet independently closed in production. |
| L144 | BUILT (crew and booked Buddy authorization, delivery and client paths tested locally; final aggregate and production verification pending) | Original acceptance not yet independently closed in production. |
| L147 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L151 | BUILT (server-owned geographic display and persistent cache tested; independent acceptance and applicable production/device evidence pending) | Original acceptance not yet independently closed in production. |
| L154 | BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending) | Original acceptance not yet independently closed in production. |
| L155 | BLOCKED-EXTERNAL (localization and cache/UI tests delivered; actual qualified language review remains required) | Original acceptance not yet independently closed in production. |
| L157 | BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending) | Original acceptance not yet independently closed in production. |
| L163 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L172 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L174 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L175 | BUILT (independent local shared-evaluation proof passed; real PostgreSQL CI and production activation pending) | Original acceptance not yet independently closed in production. |
| L176 | BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending) | Original acceptance not yet independently closed in production. |
| L178 | BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending) | Original acceptance not yet independently closed in production. |
| L180 | BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending) | Original acceptance not yet independently closed in production. |
| L181 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L182 | BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending) | Original acceptance not yet independently closed in production. |
| L183 | BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending) | Original acceptance not yet independently closed in production. |
| L187 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L189 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L191 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L192 | BUILT (independent migrated vocabulary/RLS proof passed; final PostgreSQL CI and production verification pending) | Original acceptance not yet independently closed in production. |
| L194 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L195 | VERIFIED PASS (production-verified 2026-10-22 after release 9d3dc5d0; writer reachable, 0 rows observed) | Closed in production 2026-10-22. Implementation, activation and external evidence are in the final section; census-layover §81 grades it C. |
| L196 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L197 | VERIFIED PASS (production-verified 2026-10-22 after release 9d3dc5d0; writer reachable, 0 rows observed) | Closed in production 2026-10-22. Implementation, activation and external evidence are in the final section; census-layover §81 grades it C. |
| L198 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L199 | VERIFIED PASS (production-verified 2026-10-22 after release 9d3dc5d0; writer reachable, 0 rows observed) | Closed in production 2026-10-22. Implementation, activation and external evidence are in the final section; census-layover §81 grades it C. |
| L200 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L202 | BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending) | Original acceptance not yet independently closed in production. |
| L204 | BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending) | Original acceptance not yet independently closed in production. |
| L205 | BUILT (independent service-boundary, actor-scope and deletion proofs passed; final PostgreSQL/CI and production activation pending) | Original acceptance not yet independently closed in production. |
| L206 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L207 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L208 | BUILT (operational metrics, protected export, scheduler and alerts pass local tests; independent and deployment verification pending) | Original acceptance not yet independently closed in production. |
| L212 | BUILT (operational metrics, protected export, scheduler and alerts pass local tests; independent and deployment verification pending) | Original acceptance not yet independently closed in production. |
| L214 | BUILT (operational metrics, protected export, scheduler and alerts pass local tests; independent and deployment verification pending) | Original acceptance not yet independently closed in production. |
| L215 | BUILT (operational metrics, protected export, scheduler and alerts pass local tests; independent and deployment verification pending) | Original acceptance not yet independently closed in production. |
| L216 | BUILT (operational metrics, protected export, scheduler and alerts pass local tests; independent and deployment verification pending) | Original acceptance not yet independently closed in production. |
| L220 | BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented) | Original acceptance not yet independently closed in production. |
| L221 | BUILT (routed abort and certified linked Safe Return implemented; independent acceptance and provider/production evidence pending) | Original acceptance not yet independently closed in production. |
| L223 | BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented) | Original acceptance not yet independently closed in production. |
| L227 | BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending) | Original acceptance not yet independently closed in production. |
| L228 | BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending) | Original acceptance not yet independently closed in production. |
| L233 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L236 | IN PROGRESS (local schema/query evidence complete at recorded stage; real PostgreSQL CI and full-path independent verification pending) | Original acceptance not yet independently closed in production. |
| L238 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L239 | BUILT (lane B1-F; independent verification pending; W until the press) | Original acceptance not yet independently closed in production. |
| L240 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L241 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L242 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L243 | BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending) | Original acceptance not yet independently closed in production. |
| L246 | BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending) | Original acceptance not yet independently closed in production. |
| L247 | BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending) | Original acceptance not yet independently closed in production. |
| L249 | BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending) | Original acceptance not yet independently closed in production. |
| L251 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L252 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L254 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L257 | BUILT (pressed-path defect fixed by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L259 | BUILT (atomic route dependency, durable bounded fanout and retry proved on PostgreSQL 17; production activation pending) | Original acceptance not yet independently closed in production. |
| L260 | BUILT (lane B1-R1; independent verification pending; W until the Routes press) | Original acceptance not yet independently closed in production. |
| L263 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L264 | BUILT (canonical snapshot and history batch; independent verification and production press pending) | Original acceptance not yet independently closed in production. |
| L267 | BUILT (lane B1-F; independent verification pending; W until the press) | Original acceptance not yet independently closed in production. |
| L268 | BUILT (assistant safety repairs tested; independent re-verification and production press pending) | Original acceptance not yet independently closed in production. |
| L269 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L270 | IN PROGRESS (route, between-stop and sourced airport-layout paths built; full indoor twin and device evidence remain open) | Original acceptance not yet independently closed in production. |
| L272 | BUILT (routed abort and certified linked Safe Return implemented; independent acceptance and provider/production evidence pending) | Original acceptance not yet independently closed in production. |
| L273 | BUILT (specialist product path and migrated boundaries tested; real verification/payment configuration and production acceptance pending) | Original acceptance not yet independently closed in production. |
| L276 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |
| L281 | BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending) | Original acceptance not yet independently closed in production. |
| L282 | BUILT (lane B1-R1; independent verification pending; W until the Routes press) | Original acceptance not yet independently closed in production. |
| L285 | BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending) | Original acceptance not yet independently closed in production. |
| L286 | BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending) | Original acceptance not yet independently closed in production. |
| L287 | BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending) | Original acceptance not yet independently closed in production. |
| L294 | BUILT (all four legacy readers converted, no reader exemptions; final independent acceptance and production press pending) | Original acceptance not yet independently closed in production. |
| L295 | IN PROGRESS (local schema/query evidence complete at recorded stage; real PostgreSQL CI and full-path independent verification pending) | Original acceptance not yet independently closed in production. |
| L296 | BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press) | Original acceptance not yet independently closed in production. |

## Independent review follow-on, 2026-10-19

L144 now includes the booked Buddy path:12 migrated cases,37 client cases,111 neighbors and7 killed mutations. L205 review reproduced stale actor headers on a reused service builder and proved the repair with36 audit/retention cases, including23 foreign HTTP probes, concurrent actors and real account erasure. L15 rollback hardening is delivered in the16-case3898/3899 combined proof. These are local implementation findings, not production acceptance.

Real PostgreSQL verification exposed a test-harness transaction-boundary weakness, IPv6 connection handling and overly broad missing-migration exclusions. Corrections and falsifying tests are in progress. PostgreSQL17.11/PostGIS3.6.4 is installed in an isolated loopback test environment; no successful full PostgreSQL replay is claimed yet.

## Read-only staging assessment, 2026-10-19

The beta project is healthy PostgreSQL17.11 with an existing partial schema; canonical Layover tables exist but objective facts do not. The established beta status check reports failed bootstrap/configuration runs, signup still open, expected API404, and6/7 read-only smoke checks failing. Hosted end-to-end verification is therefore not complete. Exact results and next steps are in the activation packet; no hosted data or configuration was changed.

## PostgreSQL harness acceptance, 2026-10-19

The repaired driver passed4/4 actual PostgreSQL17 smoke cases with zero skips while explicitly omitting only the in-progress3908 migration. This proves isolated clones, valid and aborted outer-transaction refusal, rollback/context restoration, concurrent cold-template role initialization,2700 dependency closure and the3826–3828 absent variant. Removing the transaction guard in an isolated driver copy reproduced and failed on the accidental commit. Nine migrated proof files now allow either isolated database engine instead of silently excluding PostgreSQL. Full inclusive3908 replay and the feature suites remain pending.

## Sourced timing and flight terminal continuation, 2026-10-19

Sourced stage/joint-journey timing and activity commitment are delivered with75 focused API tests,10 terminal/replay cases,21 migrated workflow neighbors, both complete rollback cases,4 client cases and10 killed safety mutations. Terminal source projection separately passes2 PGlite cases and5 PostgreSQL17 terminal/harness cases. These cover real source applicability and canonical invalidation, not live source population or production acceptance. Traveller current-position planning and between-stop map geometry remain active engineering work.

## Production verification after release 9d3dc5d0, 2026-10-22

Two independent verifiers agreed on everything below. They read production `ajrurzioarfkagpuxfnb` read-only: catalog and ledger queries, the 3620 postcondition re-run, and refusal probes inside `BEGIN … ROLLBACK`. They also probed rumazi.com unauthenticated. Their evidence (evidence.md, with a pre-deploy and a post-deploy section, and the 296-row classification.tsv) is in the lead's session scratchpad and is not committed. The census grades are in `docs/architecture/census-layover.md` §81.

**Production activation, common to every row below:**
- **Release.** `9d3dc5d0` has been live on rumazi.com since 2026-10-22T04:39Z. `/api/healthz` reports `X-Portava-Build sha256:3d6f0dbf…dc644`. The iOS manifest is dated 2026-10-22T04:26:45Z, and its bundle carries `LANDSIDE_EXIT`, `/observations`, `submissionToken`, `layover-end` and `rumazi.com`.
- **Migrations,** from production's own ledger (779 rows, the last applied 2026-10-21 17:49:13Z):
  - 0127 (2026-09-15, backfilled) and 2860 (2026-09-16);
  - on 2026-10-21: 2700 (17:03:06), 2992 (17:08:08), 3513 (17:22:52), 3620 (17:23:46), 3623 (17:24:14), 3792 (17:33:22), 3900 (17:36:10), 3827/3828 (17:44:55/17:45:05), 3871 (17:45:39), 3873 (17:46:07) and 3896 (17:48:19).
- **Flags.**
  - Turned ON between 04:40:37Z and 04:42:37Z through `toggle_feature_flag_with_audit`: `layover_decision_persistence_enabled`, `layover_recommendation_snapshot_enabled`, `layover_stable_recommendation_ids_enabled`, `layover_presence_ladder_enabled`, `layover_map_bands_enabled`, `layover_map_budget_chips_enabled`, `layover_safe_return_status_enabled` and `layover_discovery_mode_enabled`.
  - Already TRUE: `layover_crowd_reports_enabled` (since 2026-10-21), `airport_mode_enabled` and `layover_safety_engine_enabled`.
- **Routes.** Unauthenticated probes answer 401 on `overview`, `safety`, `checkpoints` (GET and POST), `DELETE /:id`, `observations`, `recommendations` and `decisions/replay`. A nonexistent path answers 404, so a 401 means the route is mounted.
- **CI.** Run 39693275815 on `9d3dc5d0` is green, including the local-db job on PostgreSQL 16 / PostGIS 3.4 (`test:db-local`), which runs the pressed suites.

**External evidence, common to every row below:** no traveller has used Layover since the deploy. `layover_certified_computations`, `layover_time_budgets`, `layover_return_plans`, `layover_checkpoints`, `layover_outcomes` and `airport_fact_observations` each hold 0 rows. `layover_sessions` holds 5 rows, none active, the newest from 2026-08-09. So each pass below is "writer reachable", not "rows observed". No signed-in journey was run.

### Rows production-verified

| Row | Implementation (read at `9d3dc5d0`) | Production activation | External evidence | Result |
| --- | --- | --- | --- | --- |
| L199 | 3620's postcondition block, and the authorization contract evaluator enforced in CI by `check:authorization-contract` | 3620 applied 2026-10-21 17:23:46Z; no flag | The postconditions re-run on the production catalog: 86 of 86 held. The contract evaluated against production's grants and policies: 0 violations, with a mutated-copy control reporting 2. `authenticated` holds SELECT only and `anon` holds nothing on every layover table. No traffic is needed. | **VERIFIED PASS** (census W → C) |
| L20 | The parent immutability trigger (3896); child immutability triggers (2992); version trigger and unique `(session_id, snapshot_version)` (3623); writer `persistDecision` via `evaluate()` from GET /overview and GET /safety | 2700, 2992, 3623, 3792 and 3896 applied; persistence ON 04:40:37Z; both routes 401 | All four triggers enabled on production; 0 rows | **VERIFIED PASS**, writer reachable (census W → C) |
| L195 | Recommendations written by GET /recommendations; outcomes by `recordLayoverOutcome` on DELETE /airport/sessions/:id | 0127 and 2992 applied; safety engine TRUE; persistence ON; DELETE /:id 401 | 30 recommendation rows (written before the deploy); 0 outcome rows | **VERIFIED PASS**, writer reachable (census W → C) |
| L197 | `airport_fact_observations` (2860) with TTL, provenance, fact-class and submission-token constraints; writer POST /observations behind the crowd gate | 2860 and 3513 applied; `layover_crowd_reports_enabled` TRUE; POST /observations 401 | 0 rows | **VERIFIED PASS**, writer reachable (census W → C) |
| L30 (outside the 165) | `layover_checkpoints` (2992); writer `recordTravellerCheckpoint` via POST /checkpoints, traveller-reported only | 2992 applied; `airport_mode_enabled` TRUE; persistence ON; POST /checkpoints 401 (404 on the old fork) | 0 rows | Census N → C, writer reachable |

### Rows moved N → W (outside the 165)

Their storage is applied and written. But the members their requirement enumerates are never produced. The census grades that `W` (§26.2's member rule; L116's precedent).
- **L23 `layover_time_budgets`.** 8 of the 11 time terms are NULL by construction (`LayoverDecisionStore.ts` `timeBudgetRowFor`):
  - seven are literal nulls;
  - `outbound_min` is NULL because no production path certifies a landside probe.
- **L24 `layover_return_plans`.** `latest_activity_departure_at` is always NULL, and `recommended_return_by` equals `hard_return_by` by construction (`returnPlanRowFor`).
- **L32 `layover_outcomes`.** `completed_experience`, `met_people_count`, `comfort_rating` and `plan_change_reason` are always NULL (`LayoverOutcomeStore.ts` `layoverOutcomeRow`). `anonymization_state` has no writer; only 2992's default applies.

### Findings that need an owner ruling (rows stay W)

- **L36 `RiskBand`.** HIGH has no producer.
  - `riskBandFor` returns UNSAFE, LOW, MODERATE or null.
  - `classifyCard` sits behind `layover_recommendation_status_enabled`, which is FALSE, and yields no HIGH either.
  - Owner question OQ-L36-1.
- **L37 `ConfidenceBand`.** Every stored decision is LOW or INSUFFICIENT.
  - The decision's confidence is the minimum over a set that always contains the constant-LOW time-of-day and exit-delay terms (`LayoverFeasibility.ts` `certifyFeasibility`).
  - So MEDIUM and HIGH are never produced on a decision. MEDIUM appears only on single estimates (a routed source, a verified airport, live conditions), and production has none of those today.
  - A traveller checkpoint is stored at the constant MEDIUM.
  - Owner question OQ-L37-1.

### Unchanged

- **L198:** catalog PASS, with all five index families on production. Still conditional, because the fanout index's consumers are behind FALSE flags. Owner question OQ-L198-1.
- **L25** (outside the 165) fails as worded: no `safe_envelope_ref` or `candidate_set_version` column exists.
- **L192** fails as worded: production has no PostgreSQL enum types. TEXT plus CHECK follows the owner's directive, but the row names enum types.

### Not claimed, stated

- No row here rests on an observed production row.
- The repository's committed production snapshot (2026-09-22) and `production-applied-migrations.json` were not refreshed. `layoverCensusPins.test.ts` still pins the crowd-report channel CLOSED against them. It will go red when they are refreshed, and L181, L197 and L82 must be re-derived then. L197 is re-derived in census §81.
- Other rows whose press is now done were not re-verified and keep their entries above. These include the "C on the press of 3513" family (L84 to L89, L181, L251, L252) and the A rows that need a signed-in traveller.
- Census headline after §81: 86 C / 164 W / 46 N / 0 X over 296 (CORRECT 29.1 %).
