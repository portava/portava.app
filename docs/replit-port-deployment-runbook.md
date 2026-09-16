# Deployment runbook — the Replit Media/Map/Sensing port

Merged, database-applied, deployed and runtime-verified are FOUR SEPARATE
STATES. This file covers the second one and never claims the others.

## What actually needs applying to production

Of the imported migrations, most need NOTHING applied — their DDL is already in
production, put there by the out-of-band writer before this repository saw it.
Applying them again is not the goal; recording them is.

| file | production action |
|---|---|
| 2951, 2952, 2953, 2954 | **ledger row only.** DDL already present. |
| 2956, 2957, 2958 | **ledger row only.** DDL already present. |
| **2955** media write boundary | **APPLY.** Not present anywhere but CI. |
| **2961** safety.constraint | **APPLY.** Not present anywhere but CI. |
| 2959 (if the Map lane creates it) | APPLY — new tables, nothing exists yet. |
| 2960 (if the Map lane creates it) | **DO NOT APPLY.** Its target tables `map_telemetry_events` / `map_telemetry_drops` DO NOT EXIST in production. CI only. |

So the production apply set is small: **2955 and 2961**, plus 2959 if it
materialises. Both have been rehearsed on portava-ci.

## Prerequisite state, read from production on 2026-09-16

    client (anon+authenticated) INSERT/UPDATE/DELETE grants
      on the three media tables ............................. 18
    client SELECT grants on the same ........................ 6
    service_role INSERT/UPDATE/DELETE on the same ........... 9
    freshness_policies rows ................................. 17
    media_assets rows ....................................... 8
    media_asset_lifecycle_events rows ....................... 0
    media_processing_attempts rows .......................... 0

This is IDENTICAL to CI's pre-state on the grant counts, which is why both
migrations' postcondition blocks will evaluate the same way there. 2955 takes
18 -> 0 and must leave 6 and 9 untouched. 2961 takes freshness_policies 17 -> 18.

Re-read these counts immediately before applying. If any differs, STOP: the
out-of-band writer has moved again and the apply is no longer the rehearsed one.

## Recovery

Both migrations are reversible with a single statement, and neither destroys
data — 2955 changes only privileges, 2961 only inserts one row.

2955 rollback (restores the exact pre-state, 18 client write grants):

    GRANT INSERT, UPDATE, DELETE ON public.media_assets                 TO anon, authenticated;
    GRANT INSERT, UPDATE, DELETE ON public.media_processing_attempts    TO anon, authenticated;
    GRANT INSERT, UPDATE, DELETE ON public.media_asset_lifecycle_events TO anon, authenticated;

2961 rollback:

    DELETE FROM public.freshness_policies WHERE claim_type = 'safety.constraint';

Neither rollback is expected to be needed, and neither should be run casually:
re-granting restores a privilege the port exists to remove. Both are written down
because a migration whose reversal has not been written down is not ready to
apply, not because reversal is anticipated.

Row counts to re-check AFTER applying, to show nothing was destroyed:
media_assets still 8, lifecycle still 0, attempts still 0, freshness_policies 18.

## What is NOT covered here

- The CI production guard is not bypassed. The repository's applier refuses
  production by design; production applies go through the authorized path.
- Ledger rows record a CHECKSUM, so they are written against the fixed final
  checkout, never against a tree that can still change.
- Nothing here asserts the port is deployed or runtime-verified. Those are
  separate steps with separate evidence.

## A wider finding this port surfaced but did NOT fix

2202's absence from production was not a one-off. It is one instance of a class,
and the class is large.

Measured on 2026-09-16 by extracting every `CREATE TABLE` from the 569 numbered
migrations (with comments stripped — an unstripped pass produced nine false
positives from `CREATE TABLE` appearing in header prose) and diffing against
production's live table list:

    tables really created by numbered migrations ....... 384
    of those, ABSENT from production .................... 68
    migrations implicated ............................... 41

Some are expected: `0050_rent_a_buddy.sql`'s nine `buddy_*` tables were
superseded by the `rent_buddy_*` set that production does have, and one match
(`2273`) is a `RETURNS TABLE` clause rather than a real table. The rest are not
explained that way. Among them:

    2910_discovery_trails.sql ...................... 6 tables
    2763_trip_presence_proposals_snapshots_outcomes  4 tables
    2811_telegraph_message_side_tables.sql ......... 4 tables
    2762_trip_goals_decisions_risks.sql ............ 3 tables
    2217_protected_locations.sql ................... protected_zones
    2287_passport_telemetry_events.sql ............. passport_telemetry_events
    2308_wall_telemetry_events.sql ................. wall_telemetry_events
    2950_input_assistance_telemetry_events.sql ..... input_assistance_telemetry_events

`checkProductionDrift.ts` already classifies 60 objects as "unapplied" across 40
entries, so a good part of this is known and tracked — including `protected_zones`,
whose note says the deny-by-default RLS pattern every new migration is told to
copy "has no production instance to compare against", and the three other
telemetry tables, each with the same "writer exists, storage does not" shape that
2202 had.

WHY THIS IS REPORTED RATHER THAN REPAIRED HERE. Applying 41 migrations to
production is not this port's scope, it is not rehearsed, and several of them
create tables whose writers are behind flags whose posture would need deciding
one at a time. 2202 and 2222 were applied because 2960 concretely depends on
them and the dependency was the thing blocking a deliverable. The rest need
their own pass, with the same treatment: rehearse on CI, check the flag posture,
apply in dependency order, verify data before and after.

THE TRANSFERABLE LESSON, worth more than the list. A `schema_migration_ledger`
row with `applied_by='backfill'` asserts that the FILENAME existed when 2254 ran
— never that the file ran. Reading such a row as "applied" is what let 2202 look
deployed for as long as it did, and `routes/mapTelemetry.ts` returning 200 with
`accepted: 0` on a failed insert is what kept it invisible from the outside. Any
audit of what is deployed must treat a backfill row as *no information* and go to
the live schema instead.
