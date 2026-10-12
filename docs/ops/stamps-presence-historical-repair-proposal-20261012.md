# Stamps: historical-data repair proposal for planning / contribution stamps (OD-1012-STAMP-4)

**Status: PROPOSAL ONLY.** No database has been read or written to prepare this document. No production record has been changed, and no trust score has been recalculated. Every statement below about which rows exist describes the shape of the data that the code could have written. None of it is a count. The counting queries in §3 have not been run anywhere.

Owner ruling OD-1012-STAMP-4 (2026-10-12): "Prepare a separate, scoped historical-data repair proposal. Do not modify production records or retroactively recalculate trust without review and approval."

## 1. What changed going forward, and why history is separate

Since branch `claude/wave-w-stamps-bdod`, StampAwardEngine classifies every award against one fail-closed registry: `PRESENCE_STAMP_SLUGS`, which is the presence-TRUE block of migration 2970 verbatim (`artifacts/api-server/src/services/passport/nonPresenceStampAwards.ts:88#export const PRESENCE_STAMP_SLUGS`). For any slug outside that registry, including slugs nobody has classified, the engine now:

- stores no `city` / `country` / `lat` / `lng` on the `user_stamps` row, on every award path. That covers the admin and internal endpoints and the criteria engine (`artifacts/api-server/src/services/passport/StampAwardEngine.ts:241#const evidencesPresence = isPresenceStamp(definitionSlug);`).
- fires no `STAMP_VERIFIED` trust event (+3 `passport_authenticity`) (`artifacts/api-server/src/services/passport/StampAwardEngine.ts:791#if (evidencesPresence) void recordStampVerifiedTrustEvent`).

Rows written before that change are untouched. Two kinds of historical residue can exist.

## 2. Scope: exactly which rows

### 2a. Place residue on non-presence stamps (`public.user_stamps`)

A row is in scope when **both** of the following hold:

- its definition is not one of the 13 presence slugs: `first_trip_completed`, `long_haul`, `weekend_wanderer`, `international_voyager`, `solo_traveler`, `group_tripper`, `good_host`, `road_warrior`, `frequent_flyer`, `city_explorer`, `world_citizen`, `globe_trotter_5`, `globe_trotter_10`.
- at least one of `city`, `country`, `lat`, `lng` is NOT NULL.

These are the known writers that produced such rows before the fix:

| slug | writer (before the fix) | place it attached |
| --- | --- | --- |
| `first_trip_created`, `trip_planner` | `POST /api/trips` at creation, before §BD (census-highlights-memories) | trip destination |
| `hidden_gem_explorer` | admin approval of a gem, before §BD | the gem's city/country, credited to the submitter |
| `first_postcard` | `POST /api/posts`, not gated on `stampEligible`, before §BD | user-entered postcard city |
| any slug | `POST /admin/stamps/award` / internal `POST /stamps/award` with `city`/`country` (`lat`/`lng` on the internal one) | whatever the caller passed |

Related columns on the same row:

- `catalog_id`: an award that carried a city was linked to a **city** catalog entry (`resolveOrEnqueue`), which can include city artwork. A row with its place removed should instead point at the definition-scoped entry (`definition:{slug}`, `resolveOrEnqueueForDefinition`). If this column is not handled, nulling the place still leaves the city's artwork on the stamp.
- `country` may have been **backfilled by geocoding** after the insert. It is in scope like any other `country`.

Out of scope for 2a:

- `stamp_award_events.criteria_snapshot` / `user_stamps.metadata` (no place columns; `place_contributor` carries a `placeId` in metadata, which names the contributed place, not a visit).
- `passport_telemetry_events` payloads (telemetry retention is its own policy).
- Notifications already delivered with a city in their text (history of what was sent).

### 2b. Verified-travel trust credit already granted for non-presence stamps (`public.trust_events`)

A row is in scope when `event_type = 'stamp_verified'`, `source_type = 'passport'`, and `source_id` is the id of a `user_stamps` row whose definition is not a presence slug. This applies **whether or not that stamp carried a place**: the defect was the credit itself. Each such row added +3 `passport_authenticity` to the stamp owner's `trust_profiles` the next time maintenance recalculated it.

## 3. Read-only counting queries (not run; for the reviewer)

These are `SELECT` statements only. Run them in a read-only transaction against the database under review.

```sql
BEGIN READ ONLY;

-- 2a: non-presence stamps carrying a place, by slug
SELECT d.slug,
       count(*)                                        AS rows_with_place,
       count(*) FILTER (WHERE us.is_revoked)           AS of_which_revoked,
       count(*) FILTER (WHERE us.catalog_id IS NOT NULL) AS with_catalog_link,
       count(DISTINCT us.user_id)                      AS users
FROM public.user_stamps us
JOIN public.stamp_definitions d ON d.id = us.stamp_definition_id
WHERE d.slug <> ALL (ARRAY[
        'first_trip_completed','long_haul','weekend_wanderer','international_voyager',
        'solo_traveler','group_tripper','good_host','road_warrior','frequent_flyer',
        'city_explorer','world_citizen','globe_trotter_5','globe_trotter_10'])
  AND (us.city IS NOT NULL OR us.country IS NOT NULL OR us.lat IS NOT NULL OR us.lng IS NOT NULL)
GROUP BY d.slug
ORDER BY rows_with_place DESC;

-- 2a cross-check: does the live column agree with the code registry? (expects 0 rows)
SELECT d.slug, d.evidences_presence
FROM public.stamp_definitions d
WHERE d.evidences_presence IS DISTINCT FROM (d.slug = ANY (ARRAY[
        'first_trip_completed','long_haul','weekend_wanderer','international_voyager',
        'solo_traveler','group_tripper','good_host','road_warrior','frequent_flyer',
        'city_explorer','world_citizen','globe_trotter_5','globe_trotter_10']));

-- 2b: verified-travel trust credit granted for non-presence stamps
SELECT d.slug,
       te.status,
       count(*)                  AS events,
       sum(te.delta)             AS total_delta,
       count(DISTINCT te.user_id) AS users
FROM public.trust_events te
JOIN public.user_stamps us        ON us.id::text = te.source_id
JOIN public.stamp_definitions d   ON d.id = us.stamp_definition_id
WHERE te.event_type = 'stamp_verified'
  AND te.source_type = 'passport'
  AND d.slug <> ALL (ARRAY[
        'first_trip_completed','long_haul','weekend_wanderer','international_voyager',
        'solo_traveler','group_tripper','good_host','road_warrior','frequent_flyer',
        'city_explorer','world_citizen','globe_trotter_5','globe_trotter_10'])
GROUP BY d.slug, te.status
ORDER BY events DESC;

-- 2b: stamp_verified events whose stamp row no longer exists (cannot be classified; report, do not act)
SELECT count(*) AS orphan_stamp_verified
FROM public.trust_events te
LEFT JOIN public.user_stamps us ON us.id::text = te.source_id
WHERE te.event_type = 'stamp_verified' AND te.source_type = 'passport' AND us.id IS NULL;

ROLLBACK;
```

## 4. Options (for the owner; none is chosen here)

### Place residue (2a)

- **P0: Leave the rows.** The four readers that filter by `evidences_presence` (Passport stats, shared-context cities, the criteria metrics and the Compass graph) already ignore these places. The other read sites that §K.4 counted were not all re-read, so a place could still be shown as somewhere the traveller has been. That is why census row H4 stays W while these rows exist.
- **P1: Null the place on the in-scope rows,** in one transaction, after taking a snapshot:
  1. `CREATE TABLE ops_backup.user_stamps_place_20261012 AS SELECT id, city, country, lat, lng, catalog_id FROM public.user_stamps WHERE <2a predicate>;` (a schema with no client grants).
  2. `UPDATE public.user_stamps SET city = NULL, country = NULL, lat = NULL, lng = NULL WHERE id IN (SELECT id FROM ops_backup.user_stamps_place_20261012);`
  3. Re-link `catalog_id` to the definition-scoped entry. The safe route is the existing reconciliation path, `resolveOrEnqueueForDefinition` per row, run from a script, not hand-written SQL.
  4. Postcondition: the 2a counting query returns 0 rows.
- **P2: P1 for the four known planning/contribution slugs only,** leaving rows of other slugs that an admin awarded with a place to case-by-case review. This is narrower, but it leaves admin attestations in place.

### Trust credit (2b), explicitly NOT done here

- **T0: Leave the events.** New awards earn nothing. Credit already granted stays in the score until decay ages it out.
- **T1: Set `status = 'dismissed'` on the in-scope `stamp_verified` events** (the status the CHECK constraint already allows, and one that `TrustScoreService` does not count). Then let maintenance recalculate the affected users. **This is a retroactive trust recalculation and needs the owner's explicit approval.** Snapshot first, as `(id, status, reviewed_by, reviewed_at)`.
- **T2: Write compensating negative events** instead of editing history. This needs a new trust event type, which is a vocabulary change in `TRUST_EVENT_TYPES` plus its migration. Not recommended without a policy decision.

## 5. Rollback

- P1/P2: `UPDATE public.user_stamps us SET city = b.city, country = b.country, lat = b.lat, lng = b.lng, catalog_id = b.catalog_id FROM ops_backup.user_stamps_place_20261012 b WHERE b.id = us.id;` This is lossless for every column the repair touched. Drop the backup table only after the owner signs off.
- T1: restore `status`, `reviewed_by` and `reviewed_at` from their snapshot, then let maintenance recalculate.
- Code: reverting the engine change re-opens the forward defect. That is independent of any data repair.

## 6. What a reviewer must decide

1. Which database: production only, or beta / CI as well (where every row is a fixture).
2. P0, P1 or P2 for place residue.
3. T0, T1 or T2 for trust credit. Anything other than T0 is a retroactive trust recalculation and needs the owner's approval.
4. Who runs the press. Per the standing final-trigger preference, the owner presses the last confirmation on any production write.
