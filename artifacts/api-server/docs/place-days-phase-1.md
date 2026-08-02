# Place Days — Phase 1 implementation report

## Scope delivered

Place Days add one canonical, timezone-correct local calendar-day anchor for
each canonical place. They reference existing posts and media at read time;
they do not duplicate content, create a check-in, alter visibility, or replace
the Living Destination Page timeline.

## Reused systems

- Canonical `places` and merged-place resolution.
- The coordinate/city IANA timezone resolver used by Compass.
- Existing post canonicalization, delayed-publish gate, private-account filter,
  and bidirectional block filter.
- Existing server scheduler startup pattern and mobile canonical place screen.

## New data and lifecycle

`place_days` has a unique `(place_id, local_date)` constraint, an IANA
timezone snapshot, and `active → closing → archived` timestamps. Creation is
an insert-on-conflict-do-nothing upsert, so concurrent eligible activity makes
at most one row. A lifecycle worker closes the prior local day and archives
only after its closing grace day.

The table is service-role-only under RLS. Client access goes through guarded
routes because activity visibility must be evaluated for the requesting viewer.

## API surface

- `GET /api/places/:id/place-days?date=YYYY-MM-DD`
- `GET /api/places/:id/place-days/:date/feed?cursor=&limit=`

Both require authentication and both `external_places_enabled` and
`place_days_enabled`. Feed rows preserve source posts and apply source status,
delayed-publish, public visibility, private-account follow, and bidirectional
block rules. A Place Day itself materializes only after a public, active,
published source post becomes canonically place-linked, so ineligible activity
cannot reveal a day anchor. Empty dates are returned honestly.

## Mobile

When both flags are enabled, the Living Destination Page shows “Today at this
place.” The screen supports day navigation only to materialized days, displays
place-local times, and has explicit no-day/no-visible-content states.

## Migration and operations

`2063_place_days_foundation.sql` is pending live application. Apply it through
the Supabase Management API, then verify the unique constraint, indexes, RLS
policy, and seeded disabled flag before enabling. The schema audit temporarily
baselines only the pending `place_days` table and must have that baseline
removed after verification. Enable `external_places_enabled` first; then
enable `place_days_enabled`. Watch lifecycle-worker warnings and preserve the
canonical-place migration dependency.

## Phase 2 gate: Shared Moments

Shared Moments may build atop Place Day only after Place Day creation,
lifecycle, viewer filtering, timezone behavior, and operational monitoring are
confirmed in production. It must not reuse this foundation to infer exact
location, automatic presence, membership, chat, or recap behavior.