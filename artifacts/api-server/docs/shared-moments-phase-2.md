# Shared Moments — Phase 2 implementation report

## Scope delivered

Shared Moments are an explicit, consent-based layer over completed Place Days,
canonical places, and accepted trip contexts. A Moment stores references only:
it never copies posts, media, passport memories, attendance, GPS, or Compass
profile context. Every participant is represented by a membership record and
every source contribution is explicitly submitted then approved.

## Reused systems

- Live Places and Place Days feature gating and canonical context IDs.
- Existing authenticated API, service-role-only RLS route pattern, bidirectional
  block filter, private-account follow filter, and delayed-public-post rules.
- Existing post/media IDs as references, rather than a duplicate media pipeline.
- Existing mobile Place Day entry point, feature-flag context, typed API service,
  and shared design tokens.
- Existing group-chat capability only as a status boundary. No Moment thread is
  created or claimed until the separate chat capability is explicitly ready.

## Data model and lifecycle

Migration `2064_shared_moments_foundation.sql` adds:

- `shared_moments`: owner, optional Place Day/place/trip context, title,
  join policy, and `active → archived` lifecycle.
- `shared_moment_memberships`: invitation/response/leave/removal state and
  `owner`, `manager`, or `member` role. A unique moment/user constraint makes
  invitation writes idempotent.
- `shared_moment_contributions`: contributor-owned post/media references or
  standalone caption, with `pending → approved|removed` consent lifecycle.
- `shared_moment_suggestions`: separately persisted, clearly typed Compass or
  clustering offers; offers never imply membership or content action.
- append-only `shared_moment_audit_events`.

All new tables have indexes and RLS enabled with a service-role-only policy.
Clients cannot bypass the API’s membership, block, source-privacy, and lifecycle
checks through a direct table connection.

## API surface

- `GET|POST /api/shared-moments`
- `GET|PATCH /api/shared-moments/:id`
- `POST /api/shared-moments/:id/invites`
- `POST /api/shared-moments/:id/request`
- `POST /api/shared-moments/:id/respond`
- `POST /api/shared-moments/:id/requests/:userId/respond`
- `POST /api/shared-moments/:id/leave`
- `POST /api/shared-moments/:id/contributions`
- `POST /api/shared-moments/:id/contributions/:contributionId/approve`
- `DELETE /api/shared-moments/:id/contributions/:contributionId`
- `GET /api/shared-moments/:id/feed?cursor=&limit=`
- `GET /api/shared-moments/suggestions/mine`

All APIs require `external_places_enabled`, `place_days_enabled`, and
`shared_moments_enabled`. Compass and clustering offers also require their
respective dedicated flags. The feed exposes only approved contributions,
filters both block directions, enforces private-account follow visibility, and
only renders source-post media that remains public, active, and published.
Delayed-public posts stay hidden until their scheduled `publish_at` time has
passed, even when the contribution itself is already approved.
Contributors can reference only their own post or media asset.

## Mobile

The Place Day now shows a feature-gated Shared Moments entry. The list/create
screen makes the consent boundary visible, and the detail screen displays only
approved contributions plus an honest chat-available/chat-unavailable state.
The typed service layer owns all Moment API calls and returns `null` safely on
unavailable, unauthenticated, or failed responses.

## Validation and operational risks

- Typechecks pass for both API and mobile packages, including route-registry and
  import guards.
- `sharedMoments.test.ts` verifies the three mandatory feature gates, the
  explicit membership-state contract, composite-cursor traversal and validation,
  and contribution approval transition/idempotency behavior.
- Feed pagination uses an encoded `createdAt|id` keyset cursor matching the
  `created_at DESC, id DESC` ordering; approval audits are emitted only after a
  pending contribution row is actually transitioned.
- The migration is pending application through the Supabase Management API.
  Before enabling, verify the indexes, RLS policies, foreign keys, and seeded
  flags in the live schema. Enable Live Places first, then Place Days, then
  Shared Moments; enable suggestions/chat only after their dependent capability
  is operationally verified.
- The write-path schema guard explicitly baselines this pending migration. It
  must be removed after live-schema verification, so an unapplied migration
  cannot be mistaken for a feature that is ready to enable.
- Existing group-chat schemas do not support a Moment thread type, so this
  phase intentionally exposes “unavailable” rather than misrepresenting chat
  as working.