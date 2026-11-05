# Keeping the background jobs running

As of 2026-11-04. The API process starts 69 schedulers (`artifacts/api-server/src/index.ts`,
counted by `artifacts/api-server/src/lib/schedulerCoverage.ts`). Every one is a timer inside that
process. Production runs the process on Replit Autoscale, which stops a container after about
fifteen idle minutes, and a stopped container runs no timer. So whenever nobody is using
rumazi.com, nothing in the background runs: Safe Return does not escalate a missed check-in, push
retries wait, story retention does not purge, and so on until the next visitor wakes the app.

## What a GitHub schedule can and cannot do

It cannot keep the app awake. Measured on this repository:

| Workflow | Asked for | What GitHub delivered |
| --- | --- | --- |
| `story-retention.yml` | hourly at :23 | 154 runs from 2026-10-03 to 2026-11-04, 4.8 a day, gaps of 1.9 to 10.7 hours (median 5.0) |
| `live-db.yml` | daily 06:17 | started 4.4 to 9.6 hours late |
| `clean-build-proof.yml` | daily 03:47 | started 4.3 to 7.9 hours late |

A schedule that misses by hours cannot beat a fifteen-minute idle timeout. GitHub can still be the
alarm: `.github/workflows/scheduler-health.yml` asks `/api/healthz/schedulers` every three hours and
fails (which emails the owner) when the answer is 503. On Autoscale each run that finds the app
asleep keeps one instance up for its fifteen idle minutes, which is billed: at most about $1.40 a
month at 0.5 vCPU and 1 GB if GitHub delivered every run. Each wake also lets the jobs run for a
quarter of an hour, which helps but is not a schedule: GitHub's gaps are hours long and irregular.
Disable the workflow from the Actions tab to stop both.

## The decision (2026-11-04)

Production stays on Autoscale for now: no new hosting spend without the owner's yes. A Reserved
VM is still the recommended upgrade, at $15 a month, and the steps are below. Until then a stop is
expected after every quiet spell, so the heartbeat discloses it instead of alarming on it (see
"How to tell whether the jobs were running").

## The options

Prices from [Replit's deployment pricing](https://docs.replit.com/billing/deployment-pricing),
read 2026-11-04.

| Option | Cost | Jobs keep running | Jobs can run twice |
| --- | --- | --- | --- |
| Reserved VM (recommended) | $15/month (shared 0.5 vCPU, 2 GB) or $35/month (1 vCPU, 4 GB) | yes, always on | no, one machine |
| Autoscale plus an external 5-minute pinger (UptimeRobot, cron-job.org, or Supabase pg_cron with pg_net) | Autoscale bills an always-awake instance: about $17/month at 0.5 vCPU and 1 GB, $34 at 1 vCPU and 2 GB, plus $2 base | yes, while the pinger works | yes, when Autoscale adds instances under load |
| Leave Autoscale as it is | lowest | only while someone is using the app | yes, under load |

The Autoscale figures assume one instance awake all month at Replit's rates (18 compute units per
vCPU-second, 2 per GB-second, $0.60 per million units). Most schedulers have no lease, so two
instances run two copies of each pass: the 2026-11-04 launch audit found a lease, lock or
job_health write in 16 of 73 scheduler modules.

**Switching to a Reserved VM** is done in the Replit app "port": in its publishing settings, change
the deployment type to Reserved VM, pick the machine, add the secret `PORTAVA_ALWAYS_ON` with the
value `true`, and publish. Then confirm rumazi.com is still attached under the
deployment's domains and that `https://rumazi.com/api/healthz` answers 200. The `[deployment]`
block in `.replit` says the UI setting wins over the file, so update `deploymentTarget` there to
match afterwards.

## How to tell whether the jobs were running

`GET /api/healthz/schedulers` now carries a `schedulerHeartbeat` job
(`artifacts/api-server/src/lib/schedulerHeartbeat.ts`). Every running instance writes the
`job_health` row `scheduler_heartbeat` once a minute. A new process reads that row before writing
it, so the time since the last beat is the time no scheduler ran anywhere; a beat that fires long
after the previous one means a frozen container. A stop longer than ten minutes is measured either
way. What happens next depends on `PORTAVA_ALWAYS_ON`:

| `PORTAVA_ALWAYS_ON` | A stop is | Log | Sentry | `/api/healthz/schedulers` |
| --- | --- | --- | --- | --- |
| unset (Autoscale, today) | expected | warn | no | 200; the stop is named in the heartbeat's `detail` |
| `true` (Reserved VM) | an incident | error | yes, when `SENTRY_DSN` is set | 503 for thirty minutes after the stop ends |

On an always-on host the probe that finds a stop is the first thing that can learn the jobs were
stopped, so it gets a 503 and not a 200. On Autoscale the same answer would fire on every quiet
spell, and an alarm that always fires gets muted along with the real failures. Either way a job
that is failing or stale while the app is up still answers 503.

What it does not show: whether one particular scheduler's loop has died while the process runs.
45 of the 69 schedulers still report nothing of their own (`coverage.unobservable` in the same
response lists them).

## Story retention needs one secret

`story-retention.yml` has failed every run since 2026-10-03 because the repository has no
`CLEANUP_ADMIN_SECRET` secret and no `PORTAVA_APP_BASE_URL` variable. The URL now defaults to
`https://rumazi.com`. The secret has to be set by the owner, with the same value in two places:

1. Replit app "port", Secrets: `CLEANUP_ADMIN_SECRET` (any long random string, for example the
   output of `openssl rand -hex 32`). If it already exists, reuse its value.
2. GitHub, portava/portava.app, Settings, Secrets and variables, Actions, New repository secret:
   `CLEANUP_ADMIN_SECRET` with the same value.

The Replit secret takes effect on the next publish.
