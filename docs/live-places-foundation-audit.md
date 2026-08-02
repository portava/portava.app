# Live Places foundation audit

**Status:** Baseline complete for later implementation phases.  
**Audit scope:** Existing Portava systems only; no Place Days, Shared Moments,
Recaps, user-facing surfaces, data contracts, or production flags were created
or changed by this audit.

## Decision

Live Places is an extension of the existing canonical-place and social-content
platform. Later phases must **extend, not replace**, canonical Places, Living
Destination Pages, canonical post tagging, coverage buckets, Compass, maps,
Pulse, Media, Passport, Discovery, Telegraph, Trips, Events, and the post
APIs. A new Live Places table or endpoint must reference a canonical place and
link to existing content instead of copying place or post data.

| Architecture area | Verified reusable foundation | Confirmed gap / owner |
| --- | --- | --- |
| Canonical Places | `places`, `external_place_references`, conservative resolution, source attribution, freshness, and lossless merge/unmerge are established. The canonical read follows a merged ID to its survivor. | No place-local IANA timezone, sensitive-place precision policy, immutable source history, or full place version/archive model. Establish these before any time-bound place domain relies on them. |
| Living Destination Pages | Public living payload, sparse mode, timeline slices, directions, weather, best-of, AI summary, SWR cache, invalidation queue, and client page components already exist. | Current aggregates read active posts directly and do not demonstrate viewer block/private-account filtering. Do not use them as a source for a viewer-specific Live Places feed until eligibility filtering is added. |
| Canonical post/media tagging | `posts.canonical_place_id`, `post_media.canonical_place_id`, automatic post resolution, bucket classification, and mismatch reports are in place. | Canonical link is mutable and mismatch resolution can clear it. New derived records must retain the source post ID and derive, rather than own or overwrite, canonical tags. |
| Coverage buckets | Ten canonical buckets, idempotency ledger, atomic counter increment, thin-bucket query, and coverage-aware media ranking exist. | Buckets are content coverage, not Place Day/Shared Moment/Recap state. Do not introduce another bucket taxonomy for the same purpose. |
| Compass and maps | Compass routes/services and the map entity/store layers are present. Traveler positions are coarsened server-side with opt-in, freshness, blocks, and location-sharing safeguards. | The traveler coarsening policy does not govern canonical place coordinates. Treat canonical-place precision as a separate policy decision. |
| Pulse, Media, Passport, Discovery, Telegraph | Existing route/service/component families provide feeds, media eligibility, passport history, discovery/search, and conversation/assistant surfaces. | These are integration surfaces, not replacement targets. Each phase must use the existing service/API boundary rather than create parallel feeds or chat/messaging stores. |
| Trips and Events | Existing trips, plan items, readiness/reservations, events, and add-to-plan routes already model itinerary relationships. | A future Live Places action may link into a trip/event; it must not duplicate trip plans or event attendance state. |
| Post APIs | Existing post creation, delayed publication, location verification, privacy labels, media readiness and moderation paths are established. | No new source-content mutation is justified by Live Places. Derived domains must have their own lifecycle rows. |

## Reuse boundary by following phase

### Phase 1 — Place Days foundation

Own only the new Place Day domain: a canonical-place foreign key, an explicit
place-local calendar boundary, source post references, and lifecycle state. It
must reuse the canonical resolver, post/media IDs, eligibility policy, existing
trip/event links, and the feature-flag infrastructure. It must not copy
`places`, `posts`, coverage buckets, Passport memories, or trip-plan items.

**Completion gate**

- A valid canonical place, IANA timezone/DST rule, and flag dependency are
  required before writes.
- Source posts are eligible for the requesting viewer and remain unchanged.
- Tests cover merged-place resolution, place-local midnight/DST, missing or
  disabled flags, private/blocked source content, idempotency, and archival.

### Phase 2 — Shared Moments

Own only the relationship/grouping records that reference Place Days and
existing posts/media. Reuse Telegraph for any conversation entry point,
existing social graph/block guards for participants, and existing media
eligibility instead of creating a second social feed or media pipeline.

**Completion gate**

- A moment is derived from eligible source content and has no authority to edit
  a source post, its privacy, or its canonical place.
- Participant membership and all read/write checks are RLS-backed and repeated
  in service-role API code.
- Tests cover both block directions, private authors, removal/deletion of a
  source post, and viewer-specific output.

### Phase 3 — Recaps

Own only a versioned recap artifact derived from eligible Place Days/Shared
Moments. Reuse Passport for saved travel history, Media for rendering/selection,
Compass for recommendations, and existing post content rather than copying
their state.

**Completion gate**

- Recap provenance records the source IDs and generation version; regeneration
  creates a new version rather than silently changing a published artifact.
- An expired, archived, hidden, or no-longer-eligible source is excluded on
  every read/regeneration.
- Tests cover provenance, versioning, archival, source removal, and privacy.

### Phase 4 — rollout and integrations

Own controlled exposure only: flag hierarchy, operational checks, client
entry-point gating, and integrations into existing surfaces. It must not enable
new Live Places flags in production as part of implementation.

**Completion gate**

- All prerequisite migrations and server/client contracts are present before a
  child flag can be enabled.
- A disabled or unknown flag hides client entry points and rejects server
  writes/reads where appropriate.
- Admin toggles are audited, and staged rollout has explicit rollback
  instructions and observability.

**Operating procedure**

The API/platform operator owns flag changes. Enable only one dependency level
at a time in a non-production environment; inspect API error rates, flagged
route outcomes, queue failures, and privacy/moderation events before advancing.
To roll back, disable the child flag first, then the master
`live_places_enabled` through the audited admin endpoint. Do not roll back a
schema migration or delete derived records as part of an incident response;
retain them for investigation and use the feature gate to stop exposure.

## Feature-flag contract and rollout hierarchy

### Verified contract

The live `feature_flags` REST contract was queried on **2026-08-02** through
the configured Supabase service client:

- `feature_flags` accepts the server/client projections used here:
  `flag`, `enabled`, and `description`.
- `external_places_enabled` exists and was enabled at audit time.
- No `live_places_*` rows existed at audit time.
- `feature_flag_audit_log` is reachable and empty at audit time; the
  schema/migration establishes an audit trail for admin toggles.

The migration chain defines the durable table contract:
`flag text primary key`, `enabled boolean not null default false`,
`description text`, and `updated_at timestamptz`; `metadata jsonb` was added
later for parameterized emergency flags. The key is **`flag`, never `key`**.

`isFlagEnabled` deliberately returns `false` on database failures. For a
positive feature gate, that is fail-closed (the feature stays hidden or
unavailable). `getFlagRow` similarly returns `null`. The public client context
is also fail-soft:
unknown/fetch-failed flags return `false`, preserving prior flags during a
transient refresh failure. The public listing endpoint exposes only boolean
flags; metadata is not a client contract.

The admin API is the sole operator path:

- `GET /api/admin/feature-flags`
- `PATCH /api/admin/feature-flags/:flag`
- `GET /api/admin/feature-flags/:flag/history`

Admin mutation uses the audited RPC. Do not write feature flags from mobile
clients, direct client-side Supabase calls, or application migrations that
overwrite an operator choice.

### Required hierarchy

Seed all new rows disabled and use this dependency chain:

```text
external_places_enabled
  └─ live_places_enabled
      ├─ live_places_place_days_enabled
      ├─ live_places_shared_moments_enabled
      │   └─ requires live_places_place_days_enabled
      └─ live_places_recaps_enabled
          └─ requires live_places_place_days_enabled
```

`live_places_enabled` is the master kill switch. A child is effective only
when the master, `external_places_enabled`, and every listed prerequisite are
true. Flags must be evaluated by the server at the write/read boundary; a
mobile check only controls presentation. Phase 4 should add the flags and
tests atomically after the owning domains exist, then enable them only through
the audited admin route and a staged environment-specific rollout.

## Safeguards that every phase must preserve

### Identity and source content

- Use `canonical_place_id` and resolve merge groups to the survivor. Never
  create a parallel place identity or rely on display name/coordinates as an
  identity key.
- Canonical provider references are public reference data with attribution and
  freshness. Do not erase provider provenance, fabricate a source, or turn a
  provider refresh into a destructive source-content update.
- New domains are derived records: retain source IDs, never mutate post
  visibility, media, canonical tag, location privacy, Passport state, or trip
  plan state. A source deletion/hide/moderation change must remove it from the
  derived output.

### Time, place, and location privacy

- `localTime.ts` resolves a **traveler** clock (explicit offset, then stored
  traveler timezone, then UTC). It is not a place-local calendar service.
- Canonical places currently have no timezone/tzid. Before Place Days or a
  recap uses “today,” day boundaries, opening windows, or seasons, introduce a
  validated IANA timezone tied to the canonical place and test DST transitions.
  Never substitute server time, client offset, or UTC as a silent place-local
  fallback.
- Existing traveler map coarsening must remain in its server-side choke point.
  Do not expose raw traveler positions through a Live Places payload. Canonical
  venue coordinates are currently exact; define a separate sensitive-place
  policy before exposing or deriving from sensitive venues.

### Eligibility, privacy, and RLS

- Reuse `filterEligibleMediaCandidates` for media-facing candidate selection:
  it enforces two-way blocks fail-closed, mutes, creator status, active and
  publish timing, visibility, moderation, expiration, ready media, and
  geo/age restrictions.
- Reuse `excludePrivateAuthorPosts` after block filtering for ordinary post
  surfaces. Its profile lookup is availability-oriented fail-open, but follows
  lookup is fail-closed; assess the caller’s audience before relying on it.
- The Living Destination Page currently queries with a service-role client and
  selects active posts without these viewer-specific filters. Do not treat its
  aggregate as privacy-safe source content until that is corrected in the
  owning phase.
- RLS is defense in depth, not a substitute for service-role authorization.
  The API service role bypasses RLS. Every service-role read/write must enforce
  participant, block, privacy, and visibility checks in code; tables carrying
  user-derived Live Places data need explicit RLS policies for direct access.

### Lifecycle, versioning, and archival

- Preserve existing canonical status and merge semantics. Do not delete a
  duplicate place just because it has merged.
- The living cache/queue already has SWR and a queue version token. New
  materialized data needs an explicit schema/version marker and invalidation
  rule rather than assuming cache freshness proves semantic compatibility.
- New domains must define draft/published/hidden/archived states, immutable
  provenance, retention, and read behavior for deleted/hidden/moderated source
  content. Existing place status and field freshness are insufficient for a
  derived-content archive.

## Ownership, migration order, and risks

| Item | Owner phase | Requirement |
| --- | --- | --- |
| Canonical place timezone and sensitive-place policy | Phase 1 prerequisite | Add only after live schema verification; backfill/unknown behavior must be explicit. |
| Place Day domain tables, RLS, provenance, lifecycle | Phase 1 | Reference canonical place and existing source IDs; no copied posts/places. |
| Shared Moment relationships and participant access | Phase 2 | Depend on Place Days; retain source references and explicit RLS. |
| Recap versions, archival and regeneration rules | Phase 3 | Depend on prior domains; retain provenance/version records. |
| Live Places flag rows, server gates, client gates and operational rollout | Phase 4 | Depend on deployed migrations and passing contract tests; initially disabled. |

Main risks are schema drift between migrations and live Supabase, service-role
privacy bypasses, source-content leakage through cached aggregates, incorrect
place day boundaries around DST, merge/redirect inconsistency, and a flag
rolled out before its migration or client/server gate exists.

## Inventory and verification

### Reused files and systems

- Canonical identity/resolution: `artifacts/api-server/src/routes/placesCanonical.ts`,
  `artifacts/api-server/src/lib/places/placeResolve.ts`, migration
  `artifacts/api-server/src/migrations/2028_canonical_places.sql`.
- Living page/caching/collections:
  `artifacts/api-server/src/routes/placeLiving.ts`,
  `artifacts/api-server/src/lib/places/placeCollections.ts`,
  `artifacts/api-server/src/lib/places/placeCollectionsWorker.ts`,
  `artifacts/api-server/src/lib/places/placeAiSummary.ts`, migrations
  `artifacts/api-server/src/migrations/2047_place_living_cache.sql` and
  `2050_place_cache_queue_worker_cols.sql`.
- Content linkage/coverage: migrations
  `artifacts/api-server/src/migrations/2045_posts_canonical_place_id.sql` and
  `artifacts/api-server/src/migrations/2048_place_coverage_buckets.sql`;
  `artifacts/api-server/src/routes/posts.ts`,
  `artifacts/api-server/src/routes/mediaFeed.ts`, and
  `artifacts/api-server/src/lib/mediaEligibility.ts`.
- Privacy/time/maps: `artifacts/api-server/src/lib/privacyFilter.ts`,
  `artifacts/api-server/src/lib/localTime.ts`,
  `artifacts/api-server/src/lib/mapTravelers.ts`, migration
  `artifacts/api-server/src/migrations/0195_rls_privacy_baseline.sql`.
- Flag transport/operations: `artifacts/api-server/src/lib/featureFlags.ts`,
  `artifacts/api-server/src/routes/featureFlags.ts`,
  `artifacts/api-server/src/routes/admin.ts`, migrations
  `artifacts/api-server/src/migrations/0037_feature_flags.sql`,
  `artifacts/api-server/src/migrations/0065_phase7_safety.sql`,
  `artifacts/api-server/src/migrations/0118_feature_flag_audit_log.sql`, and
  `artifacts/api-server/src/migrations/0119_toggle_flag_atomic.sql`; mobile
  `artifacts/travel-buddy/src/context/FeatureFlagsContext.tsx`,
  `artifacts/travel-buddy/src/screens/admin/featureFlags.machine.ts`, and
  `artifacts/travel-buddy/app/admin/feature-flags.tsx`.
- Compass: `artifacts/api-server/src/routes/compass.ts`,
  `artifacts/api-server/src/routes/compassHome.ts`, `compassLive.ts`,
  `artifacts/api-server/src/routes/compassSense.ts`, `compassGraph.ts`,
  `compassAutopilot.ts`, and `compassOutcomes.ts`; mobile
  `artifacts/travel-buddy/src/services/compass.ts` and
  `artifacts/travel-buddy/src/components/compass/`.
- Maps: `artifacts/api-server/src/lib/mapTravelers.ts` and mobile
  `artifacts/travel-buddy/src/services/map.ts`,
  `artifacts/travel-buddy/src/hooks/useMapEntities.ts`,
  `artifacts/travel-buddy/src/stores/mapStore.tsx`, and
  `artifacts/travel-buddy/app/map/index.tsx`.
- Pulse/Media: `artifacts/api-server/src/routes/pulse.ts`,
  `artifacts/api-server/src/routes/mediaFeed.ts`, and `mediaFile.ts`; mobile
  `artifacts/travel-buddy/src/services/pulse.ts`,
  `artifacts/travel-buddy/src/services/media.ts`,
  `artifacts/travel-buddy/src/services/mediaFeed.ts`, and
  `artifacts/travel-buddy/src/stores/mediaStore.ts`.
- Passport/Discovery: `artifacts/api-server/src/routes/passport.ts`,
  `artifacts/api-server/src/routes/passportStamps.ts`, `discovery.ts`, and
  `discoverySearch.ts`; mobile
  `artifacts/travel-buddy/src/services/passportStamps.ts`,
  `artifacts/travel-buddy/src/services/discovery.ts`, and
  `artifacts/travel-buddy/src/components/passport/`.
- Telegraph/Trips/Events/posts: `artifacts/api-server/src/routes/telegraph.ts`,
  `artifacts/api-server/src/routes/telegraphChat.ts`, `telegraphCommands.ts`,
  `telegraphStream.ts`, `trips.ts`, `trips-expansion.ts`, `tripReadiness.ts`,
  `tripReservations.ts`, `events.ts`, `posts.ts`, and `postcards.ts`;
  mobile `artifacts/travel-buddy/src/services/telegraph.ts`,
  `artifacts/travel-buddy/src/services/trips.ts`,
  `artifacts/travel-buddy/src/services/events.ts`, and
  `artifacts/travel-buddy/src/services/posts.ts`.

### Reused API boundary

The following endpoints are examples of the existing extension points; later
phases must add relationships at these boundaries rather than build parallel
place, post, plan, or conversation APIs:

- Canonical place: `GET /api/places/canonical/:id`,
  `POST /api/admin/places/ingest`,
  `POST /api/admin/places/:id/merge`, and
  `POST /api/admin/places/:id/unmerge`.
- Living/coverage: `GET /api/places/:id/living`,
  `GET /api/places/:id/living/timeline`, and
  `GET /api/places/:id/thin-buckets`.
- Trip/event linking: `POST /api/places/:placeId/add-to-trip-plan` and the
  existing `/api/trips`, `/api/events`, and `/api/posts` route families.
- Flag delivery/operations: `GET /api/feature-flags`, the admin endpoints
  listed above, and `toggle_feature_flag_with_audit` from migration 0119.

### New or modified by this audit

- **New:** this report only.
- **Modified product code/migrations/APIs:** none.
- **Production flags:** none enabled, created, or changed.

### Existing validation evidence

- Unit/route tests cover canonical resolver/image rules
  (`artifacts/api-server/src/test/placeResolve.test.ts`), place collection queue
  ownership and invalidation
  (`artifacts/api-server/src/test/placeCollectionsWorker.test.ts`), feature-flag
  admin contracts (`artifacts/api-server/src/test/featureFlagsAdmin.test.ts`,
  `featureFlagAudit.test.ts`), and mobile Living Page fallback/timeline cache
  behavior (`artifacts/travel-buddy/app/place/__tests__` and
  `artifacts/travel-buddy/src/components/place/living/__tests__`).
- The existing baseline does **not** validate the new Phase 1–4 gates for
  place-local timezone/DST, Live Places RLS, derived-source removal,
  viewer-specific private/block filtering, archive retention, or the proposed
  hierarchy. Those tests are mandatory deliverables of the owning phase, not
  evidence that the gaps are already closed.
- Live Supabase REST verification on 2026-08-02 confirmed the queried flag
  table/rows and audit-log accessibility. The management API SQL endpoint
  returned HTTP 403 in this environment, so column/RLS verification is based on
  the applied migration chain plus live REST contract, not an information-schema
  query.
- This task changes documentation only; no runtime workflow restart or
  application test run is required. Follow-on phases must run their API and
  mobile validation suites, plus new privacy/timezone/RLS integration tests,
  before flag enablement.
