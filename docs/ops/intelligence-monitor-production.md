# Production intelligence monitor

Installed 2026-11-13 on `travel-buddy`, project `ajrurzioarfkagpuxfnb`, under the user's explicit instruction to create production monitoring. The initial six-system installation is recorded below; the final section documents the current thirteen-system expansion.

[Open the current production dashboard](https://supabase.com/dashboard/project/ajrurzioarfkagpuxfnb/explorer/notebook/419cde07-aa4c-426d-8760-550135f97fca).

## What is live

- Private schema `intelligence_monitor`, aggregate `snapshots`, and three invoker functions: `state_for`, `measure`, `collect`.
- `intelligence-system-monitor-hourly`: active, schedule `7 * * * *` (seven minutes after each hour, UTC). Each collection covers the preceding 24 hours ending at the hour. Repeating a collection in the same hour reuses that batch.
- Six aggregate rows per collection, 90-day retention. No raw prompts, account ids, contributor tokens, coordinates or media are copied into the monitor. It does not generate test accounts, model calls, posts, saves or recommendations.
- Admin notebook with six-system overview, detailed metrics, Input latency trend, state-change history and scheduler status. Refresh by running its cells. No external alerts or messages are sent.
- Operational badges remain distinct from effectiveness: `observed`, `needs_attention`, `no_data`, `disabled`, `unreadable`. The dashboard also detects stale collection. Effectiveness is always `unverified`; traffic does not earn A++.

The deployed migration ledger version is `20261113112713`, name `intelligence_system_monitor`. The identical local SQL is `artifacts/api-server/src/migrations/4026_intelligence_system_monitor.sql`, created with Supabase CLI 2.121.0; the management API assigned its apply timestamp. Do not replay it under the local timestamp. The saved notebook's source is `docs/ops/intelligence-monitor.notebook.json`.

## Verification

- Local PostgreSQL could not initialize because the host exhausted shared-memory resources. The same schema, fixtures and assertions passed in an isolated in-memory PGlite 0.5.16 database instead. The embedded run excludes only hosted `pg_cron` installation/scheduling; those were inspected in production separately.
- Tests cover deny-by-default access, invoker functions, state semantics, same-hour idempotency, six-system collection, raw-key exclusion, duplicate telemetry, malformed and degraded timing, percentile calculation and isolation of a missing source table.
- The non-destructive SQL checks passed in production. Initial committed batch: `851ae35a-3276-48f2-82c9-892bd7f30819`, collected at `2026-11-13T11:27:38.295631Z`, window ending `2026-11-13T11:00:00Z`.
- All **10 saved dashboard query cells** executed successfully.
- Feature-flag fingerprint before and after: `297e0d43776e23eadd52b27997085583`; no serving flag was changed.
- Supabase health advisor: no findings. The monitor's only security-advisor entry is informational `rls_enabled_no_policy`: intentional for this private, admin-only table. Schema, table and function privileges are revoked from `anon`, `authenticated` and `service_role`, and access assertions passed. No application role is intended to read this table. [Advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
- Scheduling was active with the correct hourly expression when checked; **the first scheduled execution had not yet occurred**. Manual collection success is not recorded as a scheduled success. The notebook's scheduler cell shows this explicitly and will display the actual scheduled result.

Automatic approval review rejected a persistent CI rehearsal as outside the production authorization. No CI changes were made. It also rejected temporarily shortening the production job to one minute for a scheduling test because of the increased workload; the hourly schedule was unchanged. Local rehearsal and production manual verification supplied the available evidence without bypassing either rejection.

## First measurements

For the initial 24-hour window:

| System | Observed state | Evidence |
| --- | --- | --- |
| Compass | No data | No persisted user turns in this window; this does not establish an outage or success. |
| Sensing | Disabled | Publication is off; no publications or anonymous contributions. Consent and rollout switches remain unchanged. |
| Community information | Observed | One received observation; no current eligible snapshots. Insufficient evidence for reliability. |
| Personalized media | Observed | One newly created asset, ready; no failed or stalled assets in this creation window. This does not measure playback or ranking quality. |
| Discovery | Observed | 427 item impressions, one tap, one save; no diagnostic timing samples. These are event counts, not a causal conversion rate. |
| Input | Observed | One completed request and one valid timing sample. P95 stays null below 60 samples. |

Provisional implementation grades: **Discovery B**, **Input B+**. The current local review ran 236 focused regression tests across 11 files with zero failures. Discovery's loading/coverage reliability and Input's prefill/device latency still need live effectiveness evidence. Neither local tests nor these sparse production counters certify A++.

The earlier app fixes remain local code changes; installing this database monitor did not deploy the application or run an iPhone build.

## Run the checks again

On a host with working native PostgreSQL tools:

```sh
bash scripts/test-intelligence-monitor.sh
```

Embedded alternative used for this rehearsal (dependency stays outside the app):

```sh
npm install --prefix /private/tmp/portava-monitor-validation --ignore-scripts --no-audit --no-fund --save-exact @electric-sql/pglite@0.5.16
node scripts/test-intelligence-monitor.mjs /private/tmp/portava-monitor-validation/node_modules/@electric-sql/pglite/dist/index.js
```

`supabase/tests/intelligence_system_monitor.sql` contains post-deployment assertions. The `.fixture.sql` and `.fixture-checks.sql` files are **local throwaway database only**; never run them against production.

## Disable and diagnose

To stop only this collector while preserving its history:

```sql
select cron.alter_job(jobid, active := false)
from cron.job where jobname = 'intelligence-system-monitor-hourly';
```

The notebook's scheduler cell reads `cron.job_run_details`. A failed job or collection older than 90 minutes is visible separately from a system with no traffic. The collector's own source failures record only SQLSTATE, never SQL error messages that might contain private values. The scheduled command has a 20-second statement timeout and two-second lock timeout.

Do not disable `pg_cron` globally: other jobs may use it in the future. Do not loosen RLS or application grants to make this dashboard public. Additional user-facing monitoring belongs behind the existing admin authorization boundary.

## Whole-system expansion — 2026-11-13

The monitor now includes Wall, Map, Trips, Events, Highlights, Moments and Stamps,
for thirteen systems total. The expanded dashboard is:
https://supabase.com/dashboard/project/ajrurzioarfkagpuxfnb/explorer/notebook/419cde07-aa4c-426d-8760-550135f97fca

Migration source: `20261113120000_whole_system_monitor.sql`; deployed ledger
version **20261113120534**, name `whole_system_monitor`. The collector adds missing
systems to an existing hourly batch without replacing previous observations.
All source reads, private permissions, explicit unverified effectiveness and
90-day retention remain intact. The cron schedule is unchanged (`7 * * * *`).

Validation: embedded PostgreSQL tested the same-hour six-to-thirteen upgrade,
invalid-date detection, idempotency, payload exclusion and function permissions.
Production collection returned all thirteen systems; all seventeen dashboard
query cells succeeded. The first scheduled job succeeded at
`2026-11-13T12:07:00.214522Z`–`2026-11-13T12:07:00.221735Z`, reusing the already
collected hourly batch. Serving-flag fingerprint remains
`297e0d43776e23eadd52b27997085583`.

The original six-system notebook remains. An intermediate duplicate notebook
`d3e05ac5-7c28-43fe-909d-422af43d9128` also remains: automatic approval review
rejected its irreversible deletion. Use the completed dashboard above; its
summary includes all thirteen rows. No deletion workaround was attempted.

The final security-advisor check is not an application-wide clean bill of health.
Outside the monitor it reports ten functions with mutable search paths, three
extensions in `public`, seventeen anonymous-role and twenty-four authenticated-role
security-definer execution findings. These objects were not introduced or changed
by the monitoring migrations; intentional RPC exposure must be checked individually.
The sole RLS-disabled public table is PostGIS's `spatial_ref_sys`, readable by both
application roles. No blanket production permission changes were made. The private
monitor retains its intentional RLS-without-policies informational finding and
verified revoked schema/function privileges.
