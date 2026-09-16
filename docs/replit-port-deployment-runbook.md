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
