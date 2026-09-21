# Input Intelligence — deployment and verification handoff

**Written 2026-09-21 against merged `main` at `857ad9fb9`** (PR #520 squash),
plus the follow-up corrections on `claude/portava-continuation-uqta94`.

This document exists because **this environment cannot reach the deployment.**
Both Supabase REST endpoints and `portava.replit.app` answer **403 to CONNECT**
at the agent egress gateway; only the Supabase **Management API** reaches the
databases. That is a HANDOFF REQUIREMENT, not a project-wide impossibility —
everything below is runnable by an operator who has a browser and a shell.

Every line is labelled **VERIFIED** (a query was run or a file was read, and its
result is quoted) or **FOR THE OPERATOR** (cannot be done from here).

---

## 1. What to deploy

| | |
|---|---|
| Commit | **`857ad9fb9`** — "G340 and G344 close: the client reads the policy authority, and the local table is gone (#520)" |
| Follow-ups | `9c502ff99` on `claude/portava-continuation-uqta94` (record corrections only; no runtime code) |
| CI at that commit | **VERIFIED** — all five workflow runs concluded `success` (CI, CI (live DB), Unwired; push and pull_request) |
| Deployment target | Replit **autoscale**, per `.replit:5#deploymentTarget` |

**VERIFIED:** no GitHub workflow deploys this app. `ci.yml`, `live-db.yml`,
`clean-build-proof.yml` and `unwired-checks.yml` all carry `contents: read` and
none has a deploy step. Deployment is a manual action in the Replit UI.

---

## 2. Prerequisites — state before you deploy

### 2.1 Migration 2970 — RESOLVED 2026-09-21, no longer blocking

**VERIFIED.** This was a live ordering hazard and it has been fixed. It is
recorded here because the previous readiness document still described it as
outstanding and named only one of its four readers.

`stamp_definitions.evidences_presence` is now present on production:

```
column_present=1  nullable=NO  n_true=13  n_false=47  over_claimers=0
```

Before the apply the column was ABSENT while **four unconditional readers** of
it were already merged on `main`:

| reader | reports failure? |
|---|---|
| `services/passport/PassportMapService.ts:444` | yes — sets `readFailed: true` |
| `services/passport/SharedContextService.ts:152` | **no — silently zero** |
| `compass/CompassGraphEngine.ts:681` | **no — silently zero** |
| `lib/stamps/criteria/metrics.ts:93` | **no — silently zero** |

A PostgREST rejection **resolves** rather than throws, so a `try/catch` does not
catch it. `readFailed` is read by nothing in `travel-buddy-standalone/src`.

**FOR THE OPERATOR — one thing still unknown.** Whether the running deployment
had already been rebuilt from `main` since PR #482. If it had, travellers have
been seeing zeroed Passport stats with no error state, and presence-based stamps
(`city_explorer`, `globe_trotter_*`) have not been awarded, because
`metrics.ts` `cities_visited`/`countries_visited` returned 0. **Read the
deployment's commit in the Replit Deployments UI to settle this.** If it was
already deployed, consider whether any stamp backfill is owed.

### 2.2 Secrets — presence only, never values

**FOR THE OPERATOR.** `artifacts/api-server/src/lib/envValidation.ts:9` enforces
four keys with `process.exit(1)` on a miss:

```
PORT   SUPABASE_URL   SUPABASE_SERVICE_ROLE_KEY   SESSION_SECRET
```

Verify PRESENCE without printing values. In the Replit shell:

```bash
for k in PORT SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SESSION_SECRET; do
  v="${!k}"
  if [ -z "$v" ]; then echo "$k MISSING"
  else printf '%s present len=%s sha256=%s\n' "$k" "${#v}" \
         "$(printf '%s' "$v" | sha256sum | cut -c1-8)"; fi
done
```

Length and an 8-char hash prefix are enough to confirm presence and to compare
against a known-good value later. **Do not echo a secret, do not paste one into
a chat, an issue, or this document.** If a value has to be compared across
environments, compare the hash prefix.

**VERIFIED that this cannot be checked from here** and must not be inferred:
`.replit:11` states that settings configured in the Replit UI override the file,
and nothing in this repository can read what the UI holds.

### 2.3 Build and run commands

**FOR THE OPERATOR.** `.replit` asks for:

```
build: bash scripts/build-production.sh
run:   pnpm --filter @workspace/api-server run start
```

Confirm the Deployments UI actually holds these. `.replit` itself says it is
best-effort and the UI wins.

---

## 3. Verification after deploy, in order

Each step says what to run, what a PASS looks like, and what a FAIL means.
**Run them in order — a later step assumes the earlier one passed.**

### 3.1 Boot

**PASS:** the service answers at all and the logs carry no
`envValidation` exit. **FAIL:** a missing required key — go back to §2.2.

### 3.2 Policy handshake (G340's whole point)

`GET /input-assistance/policies`, authenticated. **VERIFIED from the route
source** (`routes/inputAssistance.ts:133`): auth required, rate limit 30 per
60 s per user, handler touches no database, `telemetryPolicy` deliberately not
served.

**PASS:**
- HTTP 200 with a body carrying `policyVersion` and 29 contexts.
- `policyVersion` equals **`input-2026-08`** (`lib/inputAssistance/policyRegistry.ts:36#POLICY_VERSION`).
- `display_name`'s policy has `mode: 'no_assistance'` — **this is the owner
  decision and must not regress.** If `display_name` comes back with
  `mode: 'search'` and `entityTypes: ['user']`, STOP: that is a people-search
  mounted on a profile-edit field.
- `telemetryPolicy` is ABSENT from every context.

**FAIL / 401:** the client will fall back to the conservative policy, which
grants nothing — the field goes unassisted rather than wrongly assisted. That is
the designed failure and is safe, but it means G340 is not actually working.

### 3.3 City-picker selection — the end-to-end path

**FOR THE OPERATOR, on a device or simulator.**

1. Open a screen with a city field and type three characters of a known city.
2. **PASS:** suggestions appear, and selecting one fills the field with the
   canonical city.
3. **PASS:** the field's policy came from the server — confirm by checking the
   request to `/input-assistance/policies` fired at app start.

**Then the negative control, which matters more:** put the device in airplane
mode and repeat. For a context the authority marks `server_required`, retained
rows must be **dropped**, not shown. `hooks/useInputAssistance.ts#mayRetain`
enforces this via `contexts/policyFallback.ts#offlineSurfaceAllowed`.
**FAIL:** if stale suggestions are still displayed offline for a
`server_required` field, §32 is not being enforced on the device and G13/G350
must not be closed.

### 3.4 Telemetry round trip

**VERIFIED:** migration 2950 is applied to production — the table exists and all
nine constraints are present, including `iate_event_name_known` carrying all
fourteen event names, read back from `pg_constraint`.

**VERIFIED:** the table holds **ZERO rows** — `count(*) = 0`, no earliest, no
latest, zero distinct event names. Nothing is emitting yet.

**FOR THE OPERATOR.** After deploy and after §4's flag is on, exercise a field,
then:

```sql
SELECT event_name, count(*), min(received_at), max(received_at)
FROM public.input_assistance_telemetry_events
GROUP BY event_name ORDER BY 2 DESC;
```

**PASS:** rows appear with recognised `event_name` values.
**PRIVACY CHECK, run it every time:** the table carries **no account or user id
column by design** (VERIFIED: columns are `id, session_id, request_id,
event_name, context, field_id, policy_version, occurred_at, received_at,
props`). Confirm `props` contains no raw typed text — migration 2950's
`iate_props_no_raw_text` CHECK refuses thirteen forbidden keys, but verify the
refusal is actually firing rather than trusting it.

### 3.5 Latency measurement

**VERIFIED:** a harness exists and has **never been run** —
`artifacts/api-server/src/scripts/measureInputAssistanceLatency.ts`, protocol and
ledger in `docs/architecture/input-intelligence-performance-protocol.md`. Every
ledger row reads **NOT RUN**. A harness is not a number.

**FOR THE OPERATOR:** run §2–§3 of that protocol against the deployment. It
refuses to print a percentile below 60 successful samples and paces itself at
70 req/min under the route's 90/min ceiling. It reports round-trip and the
server's own `serverMs` **separately** — the difference is the network and
neither side can measure it alone.

**Render cost is deliberately refused, not approximated** — it is overlay frame
timing on real hardware and belongs with the device rows, which stay **NOT RUN**
until someone runs them on handsets.

---

## 4. Flag enablement — only after §3 passes

**VERIFIED, production `feature_flags` as of 2026-09-21:**

| flag | state | note |
|---|---|---|
| `wall_input_intelligence_enabled` | **false** | the Input Intelligence surface gate |
| `map_telemetry_enabled` | false | outward-facing; see §5 |
| `locate_friends_enabled` | false | outward-facing; see §5 |
| `map_projection_enabled` | **NO ROW AT ALL** | see §5 |
| `passport_stamps_enabled` | true | already live; §2.1's route |

**FOR THE OPERATOR.** Enable `wall_input_intelligence_enabled` through the
**supported path** — `toggle_feature_flag_with_audit`, which writes an audit
row. Do not UPDATE the table directly; that bypasses the audit trail the
Trust lane depends on.

**Preserve these three properties while enabling, and verify each AFTER:**

1. **Consent.** Enabling assistance must not enable personalization for anyone
   who has not granted it. `allowPersonalization` is served per context and the
   server-side gate at `lib/inputAssistance/personalization.ts:473` fail-closes
   on `privacyClass`. Verify a user without consent gets no memory-derived
   suggestions.
2. **Location privacy.** `privacyClass` gates whether a field's suggestions may
   enter the process-global cache and whether raw text may be sent. Verify a
   `sensitive_location` context (e.g. Hidden Gem name) is NOT cached and NOT
   logged with raw text.
3. **Rollback capability.** Confirm the flag can be turned OFF and that turning
   it off actually stops the behaviour — test the off-switch before you need it.

---

## 5. What is NOT part of this deploy, and must not be silently enabled

- **`map_projection_enabled` has NO ROW.** **VERIFIED:** `feature_flags` holds
  199 rows and none is `map_projection_enabled`. Migration 2201 would create it
  (disabled). 2201 *has* a ledger row — but it is a **backfill** row whose own
  notes say, verbatim: *"Asserts only that this filename existed in
  src/migrations/ when 2254 ran. NOT evidence that it was applied to this
  database; nothing verified that it was."* `checksum` is the literal string
  `backfill`. **The platform refusal on this chain stands and must not be
  bypassed.** Use the supported approval or operator path.
- **`map_telemetry_enabled` and `locate_friends_enabled` stay OFF.** Enabling
  production telemetry collection is outward-facing and privacy-affecting, and
  unverified activation is not completion.
- **Hardware-only checks stay NOT RUN** until an operator performs them on real
  handsets: G327 (keyboard occlusion), G328 (dynamic type), G354's render cost,
  and the a11y device protocol in
  `docs/architecture/input-assistance-a11y-device-protocol.md`. **Do not mark
  any of these passed on the strength of a component test.**

---

## 6. Rollback conditions — decide these BEFORE you deploy

Roll back **immediately**, without debating, if any of these appear:

| condition | why it is a rollback and not a fix-forward |
|---|---|
| Passport stats return zeros for users with stamps | §2.1's failure mode. The client shows no error, so users see a silently wrong number about their own travel. |
| `display_name` offers other people's names | The owner decision in §3.2 regressed. This is a privacy surface, not a UX bug. |
| Telemetry rows carry raw typed text, or any account/user id | 2950's privacy postconditions are being violated in production. Stop collecting first, investigate second. |
| Suggestions shown offline for a `server_required` field | §32 is not enforced on the device; stale data is being presented as live. |
| P95 suggestion latency exceeds the protocol's stated ceiling | Degrades every text field in the app. |

**Rollback is two independent actions, and the order matters:**

1. **Turn the flag off first** (`wall_input_intelligence_enabled` → false via
   the audited toggle). This is instant and reverses the user-visible surface.
2. **Redeploy the previous commit** only if the flag-off does not stop it.

**Migration 2970 does NOT need reverting** in any of these scenarios. It is
additive (`ADD COLUMN IF NOT EXISTS`, `NOT NULL DEFAULT false`) and the previous
build does not read the column, so it is safe in both deploy orders. Reverting
it would re-open §2.1's hazard.

---

## 7. What this document does not cover

- **It is not a claim that the deploy will succeed.** Nothing here was executed
  against the deployment.
- **It does not certify the 281 C verdicts.** Those are graded against code and
  CI, not against a running system.
- **`static_dictionary` ships no artifact yet**, so offline surfaces the policy
  licenses still return nothing. That is an implementation gap, not an
  operational one, and it is being worked separately.
