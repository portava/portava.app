# Build backlog

Non-blocking defects found while building. Append; do not reorder or delete.
Format: `- [lane] file:line — what is wrong, and what the user sees.`


- [hm] `artifacts/api-server/src/routes/highlights.ts:1081` — a §11 control that
  suppresses `public_projection` (KEEP_PRIVATE_FOREVER) evicts only the SETTER's
  Compass cache. Another viewer holding a cached page still sees the Highlight
  until their own entry expires. The user sets the control, gets a 200, and the
  person they were hiding it from can still see it for the life of that cache.
  Not fixed here: evicting every follower's cache is a fan-out design, not a
  one-line change.
- [hm] `artifacts/api-server/src/services/highlights/highlightResurfacing.ts:229`
  — `HIDE_TRIP` is storable and UNENFORCEABLE. `public.highlights` carries no
  trip reference (22 columns, snapshot `20260915`), so the feed withholds the
  owner's WHOLE proactive surface rather than one trip. `GET
  /highlights/resurfacing-controls` now names it in `unenforceableOnFeed` and the
  client renders the warning, so nobody is misled — but a user who turns it on
  loses more than they asked for. Census H90. Fixing it needs a trip column on
  `highlights` or a join table; both are owner decisions.
- [hm] `artifacts/api-server/src/services/memory/memorySearchService.ts:110` —
  SHARED_CREW is unreachable from `POST /memories/search`. `TripMemoryProjection`
  and `PeopleMemoryProjection` are derived per OWNER, so a crew-wide search must
  union one derivative per member and decide what a revoked or departed member's
  derivative means. Product decision; census H113's remaining ceiling.
- [hm] `artifacts/api-server/src/routes/highlights.ts` — the SQL expiry
  predicate is defence in depth only. Mutation C (replace `NOT_EXPIRED` with a
  predicate that matches everything) SURVIVED all 26 assertions in
  `highlightLifetimeAndPin.test.ts`, because `isHighlightActive` filters expired
  rows app-side on all three surfaces. The SQL filter is kept and is worth
  keeping — it bounds the fetched set and is the only guard a future read that
  forgets the app-side check would have — but no test currently fails if it
  regresses.
- [hm] `artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts:443`
  and `:457` — `SearchEmbedding` and `NarrativeDerivative` are `NOT_CONFIGURED`
  with honest reasons (no embedding backend, no narrator). `POST /memories/search`
  reports `semanticIndex: "none"` on every response so no client can imply
  otherwise. Census H171/H172; needs a backend decision, not code.
- [hm] `artifacts/api-server/src/routes/memories.ts:2599` — `GET
  /memories/:id`'s sibling reads in `routes/highlights.ts` still discard
  `viewedRows`, `avatar_url` and `profileRows` on the two proactive feeds
  (census §O.4's own "what this did NOT find"). Engagement and identity, not
  history, so they degrade rather than refuse — but the failure is still
  unlogged.
- [hm] §5 and §17 disagree about UNPIN. §5's lifecycle has no `PINNED → ACTIVE`
  edge, so a stored `lifecycle_state = 'PINNED'` could never be undone; §17's
  command list names `UNPIN_HIGHLIGHT`, which says it must be. `POST/DELETE
  /highlights/:id/pin` writes only `pinned_at` and derives PINNED from it, which
  sidesteps the contradiction without resolving it. An owner should say which
  half of the spec wins.
