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

## W10-T — Trails product rules and admin actions

Lane W10-T (census-discovery §86), branch `disc-w10-t-trails`, cut from `a658174a4`. Migrations 3485–3488. Every entry below is implemented and tested on the branch; nothing is applied outside the local PostgreSQL 16 harness, and no flag is on anywhere.

### D-W10T-1 — What goes behind a flag, and what is a product rule

- **The question.** The lane brief: "This is ranking machinery: the hold is lifted, so put it behind a flag seeded FALSE" (DV-22), and "Health orders the Trail's own modules, behind a flag" (DC-05).
- **Options considered.** (a) Flag everything this lane builds: the §10 caps and the attach rule would stay off, and DV-13/DV-23/DC-20 would stay unenforced. (b) Flag nothing: the owner's condition for lifting the hold is broken. (c) Flag what re-selects or reorders a page from behavioural readings; ship the §10/§4/§15 rules and the admin door unflagged.
- **Decision and rationale.** (c). Two flags, seeded FALSE by 3485: `discovery_trail_exploration_enabled` (§7 content moves, §8 horizon and the `hidden_gems` module, §9 rotation, the Trail's own serve count) and `discovery_trail_health_order_enabled` (§11 order). The §10 diversity rules (DV-13, DV-23) are the same kind of rule the earlier lanes shipped unflagged (the creator and place caps); the attach rule (DC-20) is authorisation (`11` §10); the admin actions change nothing until an admin acts.
- **Reversibility.** Both flags are rows. OFF stops every flagged behaviour: absent and FALSE serve the same bytes and nothing is counted or written (pinned, G0). OFF is NOT the pre-§86 output, because the unflagged §10 rules (D-W10T-2, -4, -5, -15, -16) apply either way; those revert only with the commit.
- **Where it is implemented.** `artifacts/api-server/src/migrations/3485_discovery_trail_exploration_flags.sql`; `services/trails/trailExploration.ts` (`readTrailRankingFlags`); pinned by `src/test/discoveryTrailExploration.test.ts` G0 and `src/test/db/trailsModeration.db.test.ts` W1, W8.

### D-W10T-2 — DV-13: the one-creator bound (D-1 Q3)

- **The question.** §51.10 Q3: "Is the one-creator bound per spotlight module or across the whole Trail page, and at what share? The code's 2 per module per page was not set by the spec or by you."
- **Options considered.** (a) Per module only (2): one creator can hold two slots in each of four modules and trending, i.e. up to eight distinct items on one page. (b) An absolute page cap (2): a small or single-author Trail is emptied. (c) Both: keep 2 per module, and bound a creator across the whole page to a share of its distinct items with a floor.
- **Decision and rationale.** (c). A creator may hold at most max(2, ⌊⅓ × distinct items on the page⌋) distinct items across the union of the page's modules; the per-module cap of 2 stays. At one third, two thirds of the page is somebody else's — the minimum that "never let one creator … dominate" (`02` §10) can mean. Trimmed from the tail, to a fixed point; the same content in two modules counts once; a creator-less item is never trimmed. The earlier lane's 2-per-module is kept as the per-spotlight rule, recorded here as decided.
- **Reversibility.** Constants `TRAIL_PAGE_CREATOR_SHARE` and `MAX_PER_CONTRIBUTOR_PER_PAGE`; nothing stored.
- **Where it is implemented.** `lib/discoveryTrailHealth.ts` (`creatorPageBoundRemovals`); `services/trails/TrailService.ts` (`boundCreatorsAcrossPage`). Tests: `discoveryTrailProductRules.test.ts` R4, S5; `db/trailsService.db.test.ts` H2 still holds.

### D-W10T-3 — DC-04 / DV-21: what moves §7's states, and who runs §15's moves (D-1 Q4)

- **The question.** §51.10 Q4: "What moves in-Trail content between §7's six states, and who runs §15's moderation moves (`needs_update`, `stale`, `archived`)?"
- **Options considered.** Content: (a) time alone (ages content regardless of response); (b) moderation alone (does not scale, and §9 is explicitly internal and automatic); (c) §9's own steps — evaluate the normalised response, expand or taper, retest — plus §8's horizon. Trail: (a) automatic staleness from a content-age rule (no spec threshold); (b) moderation (§15 lists "mark stale" among moderation ACTIONS).
- **Decision and rationale.** Content: (c), behind `discovery_trail_exploration_enabled`. On measured response (Discovery-surface `rank_events`, the rows whose outcomes are recorded) with §9's existing thresholds (`TRAIL_EXPOSURE_MIN_EVIDENCE` 25, `TRAIL_EXPOSURE_EXPAND_RATE` 0.05): just_arrived/rediscovered → archived_from_active_rotation on taper; → growing on expand at the exploration ceiling (500) or when §8's 7-day horizon passes; growing → archived on taper, → featured on expand sustained 7 more days; featured → growing on taper, → evergreen on expand at 30 days a member and 7 in state; evergreen → archived on taper; archived → rediscovered on expand after a 7-day rest (§9 step 5). A duration that cannot be read (3486 absent) makes no time-based move. Decided at read time, served from the decided state, persisted by compare-and-set under 3381. Trail lifecycle: (b), admin moves through one audited function (needs_update, stale, reactivation, archive); `proposed → active` on first content stays as built. Local Picks' source: `02` §5's "Portava-curated catalog" — an audited admin curate action is the one writer of `source = 'curated'`, over content verified public.
- **Reversibility.** Flag OFF stops every content move; states already moved stay (they are §7 states the relation admits; an admin can see them). Admin moves are audited and reversible within 3381's relation (archive is terminal by §7's own design).
- **Where it is implemented.** `services/trails/trailExploration.ts` (`decideContentTransition`, `persistContentTransitions`); `services/trails/TrailService.ts` (`trailModulesExplored`); 3486 (`trail_admin_move_lifecycle`, `trail_admin_curate`, the state stamp trigger); `routes/adminTrails.ts`. Tests: `discoveryTrailExploration.test.ts` L1, L3, L4; `db/trailsModeration.db.test.ts` W2, W8, W10.

### D-W10T-4 — DV-23: §10's five clauses (D-1 Q7)

- **The question.** §51.10 Q7: "Does §10's 'preserve access through more from this place' require a route that returns the held-back items, or is the place's own page that access?" and §51.6's FAILs on media, viewpoints, content similarity and venue linking.
- **Options considered.** For access: (a) the place page (it does not list the Trail's held-back posts); (b) a Trail route returning them. For viewpoint: (a) sentiment/stance (no such signal exists); (b) the same person's repeated take on the same place. For similarity: (a) an embedding (none on the Discovery path, and it would fail open); (b) the token-set similarity §5 CHECK 1 already uses.
- **Decision and rationale.** Access (b): `GET /v1/discovery/trails/:id/places/:placeId/more` returns, per module, exactly the members that module counted, from one computation. Viewpoint (b): at most one item per (creator, place) per module. Similarity (b): a post whose text is ≥ 0.8 token-set similar (at least 3 tokens) to one already on the page is held back, and counted for its place. Venue link: a post's canonical `places` row and a `discovery_places` member are one venue when their normalised names match and they are within 1.5 km — `lib/canonicalLocations.matchCanonical`'s own venue rule, reused. Media: D-W10T-5.
- **Reversibility.** Pure rules; nothing stored.
- **Where it is implemented.** `lib/discoveryTrailHealth.ts` (`diversifyTrailModule`); `services/trails/TrailService.ts` (`readMemberGeography`, `linkVenueClusters`, `moreFromThisPlace`); `routes/trails.ts`. Tests: `discoveryTrailProductRules.test.ts` R5–R7, S1, S4.

### D-W10T-5 — E-11: media diversity and "stale" content

- **The question.** §69.1 E-11: "stale content and media diversity".
- **Options considered.** Media: (a) a hard cap per type (empties a page of one type); (b) off (§51.6 FAIL); (c) a work-conserving share. Stale: (a) age alone (≥ 90 days) — makes evergreen content "stale" by definition; (b) out of rotation, or old and not durable.
- **Decision and rationale.** Media (c): a post's own media kind (`primary_media_type`, else `media_type`, else text) or the member's type; one kind may hold at most half of a module page while another kind waits; a page that would stay short is refilled from the held items. Stale (b): archived_from_active_rotation, or ≥ 90 days old and neither evergreen nor featured (`03` §3 "persistent usefulness"). One predicate serves §11's metric and the health order.
- **Reversibility.** Constants; `TRAIL_HEALTH_MODEL_VERSION` moved to `trail-health-v2`, so snapshots before and after are distinguishable.
- **Where it is implemented.** `lib/discoveryTrailHealth.ts` (`isTrailStaleObject`, `TRAIL_MEDIA_SHARE_PER_PAGE`). Tests: R1, R5.

### D-W10T-6 — DV-22: where a Trail's own serves go (D-1 Q2)

- **The question.** §51.10 Q2: "May a Trail module's own serves be written to `rank_events`, and under which surface? `discovery` is the only admitted fit, but it would feed Discovery's place momentum and make `trending_now` self-reinforcing; a `trail` surface needs a migration widening the surface CHECK."
- **Options considered.** (a) `rank_events` / `discovery`: self-reinforcing, and moves another surface's momentum. (b) A new `trail` surface: every `rank_events` reader would have to learn to exclude it. (c) A Trail-owned counter read only by §9's qualification.
- **Decision and rationale.** (c), 3487: per (Trail, member, UTC day) a count, no viewer id, no outcome. It counts toward §9 steps 1–2 (the 500 ceiling, the rotation order) and NOT toward step 3's rate, because a Trail page records no outcome and would drag every rate toward taper. Rotation: the page's reserved slots (20 %) go to the least-exposed qualified item, oldest first, so each page reaches further into the backlog; deterministic, no randomness. An unread count reserves nothing (`null`).
- **Reversibility.** Flag OFF: nothing is read or written. The table can be dropped by its rollback.
- **Where it is implemented.** 3487; `services/trails/trailExploration.ts` (`rotateExplorationSlots`, `recordTrailModuleExposures`). Tests: `discoveryTrailExploration.test.ts` L2, L5, L7; `db/trailsModeration.db.test.ts` W7, W8.

### D-W10T-7 — DC-05: the geographic cell, `new_creator_exposure`, and the health order (D-1 Q6)

- **The question.** §51.10 Q6: "What geographic cell defines `geographic_diversity`, and is `new_creator_exposure` meant to be an exposure share, rather than the membership share it is today?"
- **Options considered.** Cell: the Map's zoom-11 cell (~19.5 km: every member of a city Trail in one cell), a geohash, or the Map's own degree grid continued to neighbourhood scale. Denominator: every member (a route has no location, so never measured) or the located members. Exposure: membership share, or impressions.
- **Decision and rationale.** Cell: `lib/mapAggregation`'s degree grid at zoom 14 (0.02197°, ~2.4 km), from the member's PLACE coordinates (a place member's own row; a post's canonical place; an event's venue), never an author's GPS; server-side only. Measured over the members that have a cell; no cell at all stays null. `new_creator_exposure`: impressions (every surface, 30-day window) on the members of contributors whose first member in the Trail is under 30 days old, over impressions on every attributed member; null when unread or nothing attributed was shown. Health order (flag): inside every module, the members §11 counts against the Trail — stale objects, and the dominant contributor's members while `contributor_concentration` > ⅓ — are served after the others, each partition in the module's order; nothing is removed (§11 "not silently erase").
- **Reversibility.** Model version `trail-health-v2` / feature version `trail-member-rows-v2` mark the change on every snapshot. The order is a flag.
- **Where it is implemented.** `lib/discoveryTrailHealth.ts` (`trailGeoCell`, `newCreatorExposureShare`, `healthDemotedRowIds`); `services/trails/TrailService.ts` (`readMemberGeography`, `readMemberImpressions`). Tests: R2, R3, S2; L6; the two restated cases in `discoveryTrailModifier.test.ts`.

### D-W10T-8 — DV-24: who may declare §6's other edge kinds (D-1 Q1)

- **The question.** §51.10 Q1: "Who may declare two Trails `related`, `seasonal_variant`, `geographic_sub` or `experience_branch` — the proposer, the owner of either Trail, moderation only, or a system job — and must such an edge be reviewed before it is navigable?"
- **Options considered.** Moderation only (nothing gets declared); the owner of either Trail unreviewed (anyone can bolt their Trail onto a popular one); a system job (no rule to derive it from; `trail_relations` is read by no one, §61.6).
- **Decision and rationale.** The creator of either Trail may declare `parent`, `related`, `seasonal_variant`, `geographic_sub` or `experience_branch`. Declared by the creator of BOTH Trails it is navigable at once — the standing the proposer's own `child` edge already has. Declared by the creator of ONE, it is `pending` and navigable only after moderation accepts it (audited); moderation may also declare or reject outright. Anyone else is refused (403). `child` stays the proposal's.
- **Reversibility.** `review_state` per edge; rejecting hides it.
- **Where it is implemented.** 3486 (`trail_edges.review_state`, `trail_admin_review_edge`); `services/trails/TrailService.ts` (`declareTrailRelation`, `readUnacceptedEdges`); `routes/trails.ts`. Tests: S6; W5.

### D-W10T-9 — DC-20: who may attach, and whether a suggestion spends §4's budget (D-1 Q5)

- **The question.** §51.10 Q5: "Who may `attach` content to a Trail at the author's-statement confidence, and does a third party's `suggest` count against the content's §4 budget? Which table does a `place` member name (`discovery_places` or `places`), and what is an `itinerary`?"
- **Options considered.** Attach by anyone who can see the content (today: a stranger can take a post's one primary slot); by the owner only. Suggestions as memberships (spend the owner's budget) or as pending proposals.
- **Decision and rationale.** Attach at the statement confidence: only the content's owner — post author, event host, route owner, community-place submitter — and, for authorless content (a canonical place), the Trail's creator; anyone else is refused `not_content_owner`. A suggestion by the owner is a membership at the suggestion confidence, as before; by anyone else it is a PENDING row (3488) that spends no budget and is served by nothing until the owner accepts it (then it is attached as the owner, under §4's cap) or declines it. Without 3488 a stranger's suggestion fails closed (503). `place` names either table, as §61.4 found the read path already does. `itinerary` stays refused as unverifiable: it is not a member type until a table holds one.
- **Reversibility.** Rules in code; pending rows can be declined.
- **Where it is implemented.** 3488; `services/trails/TrailService.ts` (`routeLabelsByOwnership`, `listPendingSuggestions`, `decideSuggestion`); `services/trails/trailAttachIntegrity.ts` (`ownerIds`); `routes/trails.ts`. Tests: S7; W9.

### D-W10T-10 — E-5: Trail merge semantics

- **The question.** §69.1 E-5: "Trail merge"; `02` §15 "merge duplicate Trails"; `11` §8 "Trail merge".
- **Options considered.** Delete the source (loses history and breaks links); move members only (orphans follows, edges, children, reports); a full re-home with the source archived and pointing at the target.
- **Decision and rationale.** The last, in one audited transaction: the source's members move to the target, except content the target already holds, which is dropped (the target's label stands, so §4 is never charged twice) with its open reports re-homed onto the target's row; the source's open Trail-level reports are resolved `merged`; followers move (deduplicated); relationships are re-homed (a source↔target edge is dropped, never made a self-edge); children are re-parented; the source becomes `archived` with `merged_into_trail_id`; its health snapshots stay as history. Refused: the same Trail, an archived side, a target that descends from the source, an unknown Trail.
- **Reversibility.** Not automatically reversible (archive is terminal in §7). The audit row records every count; the source row and its history survive.
- **Where it is implemented.** 3486 (`trail_admin_merge`); `services/trails/trailAdmin.ts`; `routes/adminTrails.ts`. Tests: `adminTrailsRoutes.test.ts`; W3.

### D-W10T-11 — Trend integrity review

- **The question.** `11` §8 "trend integrity review" (DV-74), with `03` §12's anti-gaming.
- **Options considered.** A report only; or a verdict that can change what is published.
- **Decision and rationale.** Verdicts `confirmed`, `suspect`, `suppressed`, `cleared` on a Trail or a place, the newest in force, append-only, with the evidence the admin saw (the raw reading, which `11` §4 permits for admin diagnostics). `suppressed` on a Trail makes GET …/trending a measured `false` with no items; an unreadable review answers `null`, never a claim. Suppression of a PLACE is recorded but not yet read by the trend classifier: that file is the trending lane's, and the hunk is routed (§86.9).
- **Reversibility.** A later `cleared` lifts a suppression.
- **Where it is implemented.** 3486 (`trend_integrity_reviews`, `trend_integrity_review_record`); `services/trails/TrailService.ts` (`readTrendReviewVerdict`); `services/trails/trailAdmin.ts` (`trailTrendEvidence`). Tests: S8; W6.

### D-W10T-12 — B-5: non-public members in a Trail — **APPROVAL REQUIRED** (consent)

- **The question.** §64.9 Q1–Q3 and §61.12 Q4: should a Trail resolve relationships — friends for a friends-only event, invitees for an invite-only one, followers or trip members for a post, eligibility for a gated event — and serve such content to them?
- **Decided (routine, consistent with users' choices):** a Trail serves only content the viewer could already see, and never widens who sees it. The fail-closed §64 rule (a non-public member to its author, host, owner or accepted crew only) meets that rule and stays.
- **Why the rest is not decided here.** Serving a friends-only event or a followers-only post inside a public discovery space, even only to people who could open it elsewhere, is a new use of the author's content beyond the surface they chose it for. That is a consent question.
- **Options.** (A) Keep fail-closed (today). (B) Resolve each relationship exactly as the source surface does, per viewer. (C) As B, but only for content whose author has opted in ("show in Trails"), default off.
- **Recommended action.** Keep (A) in production. If widening is wanted, approve (C) with the opt-in defaulting to off; do not approve (B).
- **Consequence of approving (C).** A per-content opt-in field and the per-viewer relationship reads must be built; members widen only for opted-in content. **Of declining.** Nothing changes; non-public members stay their author's.
- **Recovery path.** The rule lives in `servableMembers` / `memberAccessFor`; reverting (C) is withdrawing the opt-in reader.

### D-W10T-13 — Production activation — **APPROVAL REQUIRED**

- **Recommended action.** Apply 3485, 3486, 3487 and 3488 (in that order, after 3381 and 3415) to `portava-ci`, then production. Keep both 3485 flags FALSE in production until a Trail exists there; then turn on `discovery_trail_exploration_enabled` first, and `discovery_trail_health_order_enabled` only after a week of `trail_member_exposures` rows shows the rotation reaching the backlog.
- **Consequence of approving.** Admin moderation, merge, curation, edge review and trend review become available; stranger suggestions stop failing closed; with the flags, Trail pages are served from §7 states.
- **Consequence of declining.** Admin Trail actions and relation declarations answer 503; a stranger's suggestion answers 503 (it never spends the owner's budget); the §10 rules and the attach rule still apply.
- **Recovery path.** The four rollbacks under `db/rollback/2026-09-28-348[5-8]-*`; the flags OFF stop every flagged behaviour (absent = FALSE, pinned); they do not restore pre-§86 output, because the unflagged §10 rules apply either way.

### D-W10T-14 — Retention of the three new stores — **APPROVAL REQUIRED** (retention)

- **What is stored.** `trail_member_exposures`: counts, no personal data; grows one row per served member per day. `discovery_admin_audit_events`: the acting admin's id is kept as a fact after that admin's erasure (as §52's `creator_ledger_audit_events`). `trail_content_suggestions`: who suggested what (SET NULL on the suggester's erasure; deleted with the owner).
- **Recommended action.** Prune `trail_member_exposures` rows older than 31 days daily (only 30 are read). Keep audit rows (moderation accountability, as §52/C-11). Delete decided suggestions 90 days after `decided_at`.
- **Consequence of approving.** A scheduled prune must be built; nothing read changes. **Of declining.** Rows accumulate; nothing served changes.
- **Recovery path.** None needed for declining; an approved prune is a job that can be stopped.

### D-W10T-15 — DV-23 follow-up: every list applies §10's five clauses, and nothing held back is unreachable

- **The question.** An independent verifier ran at `de2ae1ca0` and found two gaps. GET …/trending still used the old creator-and-place pass: no text, no media kind, no viewpoint, no venue link, and no access to what it held back. On /modules, items held by the per-module creator cap, and items removed by the DV-13 page bound, were neither counted nor listed; in one fixture the bound emptied a whole module and nothing listed the removed posts. D-W10T-4(b) promised access to what a page holds back.
- **Options considered.**
  - (a) Count only the place-clause items, and let the rest be "pagination". The creator cap and the page bound then silently hide content (§11: "not silently erase").
  - (b) Backfill the page bound from other creators. It changes what DV-13 bounds, and still leaves the per-module cap's items unreachable.
  - (c) Record every item any list holds back, whatever held it, under its place when it has one, and as unplaced otherwise, and make all of them reachable.
- **Decision and rationale.** (c), with four parts.
  - GET …/trending runs the same pass every module runs (`diversifyTrailModule`), over venue-linked clusters, with each post's text and media kind.
  - Every held item counts under its place. Trending serialises `moreFromThisPlace` only when it is non-empty, so a response with nothing held keeps its prior shape.
  - `GET …/places/:placeId/more` lists each module's held items for the place, and trending's under the key `trending`.
  - A new `GET /v1/discovery/trails/:id/more` lists everything held back, per list, by place and unplaced. An item with no place still has a door.
  - The page bound itself is unchanged (D-W10T-2); what it removes is recorded in the module that removed it.
- **Reversibility.** Code only; no migration, no flag. Reverting restores the earlier counts.
- **Where it is implemented.**
  - `lib/discoveryTrailHealth.ts`: `diversifyTrailModule`, including `heldBackUnplaced`.
  - `services/trails/TrailService.ts`: `trailTrending`, `boundCreatorsAcrossPage`, `moduleSaturationItem`, `heldBackLists`, `moreFromThisPlace`, `moreFromThisTrail`.
  - `routes/trails.ts`.
  - Tests: `discoveryTrailProductRules.test.ts` F1–F6, with G1–G3 and H pinning DV-13 and the wiring.

### D-W10T-16 — DV-23 round 2: past the page is held, not "pagination"

- **The question.** The verifier re-ran at `8dcbb5acc` and found that `diversifyTrailModule` stopped classifying once a page was full: "beyond the page is pagination, not suppression". No route paginates a module (/modules is fixed at 8 items, trending at 20), so items after the page filled were neither counted nor listed. Four posts about a place that arrived after the page filled vanished from "more from this place".
- **Options considered.**
  - (a) Real pagination: a cursor per module and per list. That is new client surface for every spotlight, and each page would need its own §10 pass.
  - (b) Keep classifying past the page: every candidate the page had no room for is held (`beyond_page`), counted under its place, or listed as unplaced.
- **Decision and rationale.** (b). A spotlight is a bounded page by design (`02` §8: "without creating a million-item chronological feed"). Access to the rest is §10's "more from this place", which the "more" routes already provide (D-W10T-15). It holds on /modules and on trending alike.
- **Reversibility.** Code only.
- **Where it is implemented.** `lib/discoveryTrailHealth.ts` `diversifyTrailModule`. Tests: `discoveryTrailProductRules.test.ts` J1 and J2.

### D-W10T-17 — DV-23 round 2: the 500-member window and clause 5

- **The question.** `readMembers` reads a Trail's newest 500 members. Members past 500 were never served or listed anywhere. How does "preserve access" hold for a larger Trail?
- **Options considered.**
  - (a) Raise the window: it moves the problem and makes every read heavier.
  - (b) An unbounded /more.
  - (c) A bounded page with a cursor.
- **Decision and rationale.** (c).
  - Every list, and the page it serves, is computed over the newest `TRAIL_MEMBER_WINDOW` (500) members, now in a total order: created_at, then id.
  - When the window is full, both "more" routes return `next`, an opaque cursor at the window's edge.
  - `?cursor=` returns one bounded page of up to `TRAIL_MORE_PAGE_SIZE` (200) older members, as the list `beyond_window`, by place and unplaced, with the cursor to the page after. It is keyset on (created_at, id), so a tie at the edge is neither repeated nor skipped.
  - A cursor page is the viewer's view (`servableMembers`), like every other read. A malformed cursor is 400.
- **Reversibility.** Code only; the cursor is opaque, so its format may change.
- **Where it is implemented.**
  - `services/trails/TrailService.ts`: `TRAIL_MEMBER_WINDOW`, `olderMembersPage`, `moreFromThisPlace` and `moreFromThisTrail`.
  - `routes/trails.ts`.
  - Tests: J4, and J3 for the viewer's view.
