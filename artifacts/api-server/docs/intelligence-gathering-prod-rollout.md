# Intelligence Gathering — production rollout runbook (25 Aug 2026)

Owner-pressed. This is the sequence to take the completed IG subsystem to
production. **Nothing here has been applied to production.** The whole intel
stack is currently *absent* from prod; CI is fully staged, enabled, and proven.

## Where things stand

**Built + merged to `main`:** IG-01 contracts, IG-02 storage, IG-03 capture,
IG-04 projection/privacy/confidence, IG-05 read path, IG-06 trail follow-up,
IG-07 Compass k=1 gate (⚠ see below), IG-08 coverage, IG-09 limited-live,
IG-10 internal QIU/API. Rewards internal is PR #136 (merges when green).

**CI (`hwokxgbmezheskbzskfr`) — staged, enabled, proven (2026-08-25):**
- Migrations `2165`–`2170` applied; `intel_mission_candidates` and
  `intel_reward_ledger` tables live (RLS deny-default, service_role-only grants,
  DB `CHECK cash_amount = 0`).
- Four flags **enabled**: `intel_capture_quick_signal`, `intel_trail_followup`,
  `intel_missions`, `intel_rewards`. The rest are deliberately **off**.
- Proven end-to-end: a well-formed mission and a reward row insert; both cash
  `CHECK`s reject `cash_amount = 5`; test rows cleaned up.

**Production (`ajrurzioarfkagpuxfnb`) — nothing intel is present:**
`intel_observations` / `intel_mission_candidates` / `intel_reward_ledger` do not
exist, there are **zero** intel flags, `places` is empty, and the migration
ledger tops out at the 2026-08-25 security rollout. So "enable on prod" is a full
rollout of the intel chain, not a flag flip.

## Rollout sequence (apply through the normal migration chain; owner presses)

1. **Apply the intel migration chain, in order**, verifying each is not already
   present first: `2128` (contracts), `2130` (storage), `2131` (live-label flag),
   `2132` (projection flag), `2133` (retention), `2165` (capture flag), `2166`
   (trail flag), `2167` (missions table + flag), `2168` (limited-live flags),
   `2169` (compass rhythm flag), `2170` (reward ledger + flag). **Every one seeds
   its flag OFF.** Each carries a `DO $$ … RAISE EXCEPTION` postcondition, so a
   failed apply rolls itself back.
2. **Verify the applied state** (mirrors the CI checks):
   - tables exist with RLS enabled and **no** `anon`/`authenticated` grants;
   - `intel_mission_candidates` and `intel_reward_ledger` carry the
     `cash_amount = 0` CHECK;
   - all intel flags present and **false**.
3. **Enable the four dependency-satisfied flags** (flip to `true`):
   `intel_capture_quick_signal`, `intel_trail_followup`, `intel_missions`,
   `intel_rewards`. These are production-safe now: capture fails closed to
   `unknown_subject` until `places` is backfilled; missions and rewards are
   internal, admin-only, and non-cash.
4. **Leave these OFF** — each is a retained gate, not a rollout blocker:
   - `intel_limited_live` — no public Live labels until a scope clears the §26
     density gate (a human-review promotion). Density does not exist yet.
   - `disable_intel_live_labels` — the emergency kill switch; off = not engaged.
   - `intel_compass_rhythm_actor_gate` — ⚠ **IG-07, needs review** (below).
   - `intel_live_label_crowd`, `intel_claim_projection_crowd` — the live-label
     read/projection; nothing to project until capture produces claims.
   - the cash pool and external-API switches are **not built** and stay under
     owner control (no external credential is issued).

## Dependencies for full function (parallel, not blockers to enabling)

- **`places` backfill** (Replit workstream) — capture writes nothing to a real
  place until `public.places` is populated for the pilot city; the source table
  `fsq_places` is empty, so an FSQ ingest (Foursquare key + pilot-city decision)
  must run first. Until then capture is enabled but inert (fails closed).
- **Mobile capture UI** (travel-buddy-standalone) — the Quick Signal / Moment /
  Trail surfaces that call the capture endpoints.

## ⚠ IG-07 Compass rhythm — review before enabling

`intel_compass_rhythm_actor_gate` stays **off**. Deploying the code already
closes the k=1 leak (the time-sliced rhythm line is suppressed; Compass falls
back to the city-wide summary). **Enabling** the flag re-emits the line only for
slices with ≥ `COMPASS_RHYTHM_K` (5) distinct contributors — but that count is
not recorded yet. Enabling therefore needs (a) a graph-build change to record a
per-slice distinct-actor count, (b) a graph rebuild, and (c) explicit owner
review. Do not flip it on blind.

## Financial + external boundaries (retained regardless of user count)

Cash transfer and external/commercial API access are **separate switches held
under owner control** and are **not built**: no money moves (`cash_amount = 0`
enforced by the DB on both financial tables), and there is no external,
unauthenticated, or generally accessible API surface — only admin-gated internal
endpoints. These are financial-control / security boundaries, not
"protect-existing-users" gates.
