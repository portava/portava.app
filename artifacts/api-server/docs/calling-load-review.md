# Calling system — load considerations & operational limits (Phase 6)

Reviewed 2026-07-19 against the shipped implementation. All numbers come from
`CALL_CONFIG` in `src/lib/calls/callTypes.ts` — the single source of truth.

## Sweep cost

- Cadence: `SWEEP_INTERVAL_MS` = 30 s (first run after `SWEEP_STARTUP_DELAY_MS` = 20 s).
- Per sweep: **one** DB query (`listOpenSessions` — `call_sessions` filtered to
  `ringing|active`). Extra work only for sessions that need a transition
  (CAS update + history write + room teardown), so a quiet system costs one
  cheap indexed read every 30 s.
- Ghost healing adds **at most one LiveKit `listRooms([name])` probe per
  active session past `GHOST_ACTIVE_GRACE_MS` (2 min)** and only for `active`
  sessions — ringing sessions are never probed. Probe failures are ignored
  (fail-closed to "not a ghost"); the 4-hour cap remains the hard backstop, so
  a LiveKit API outage cannot end live calls or leave permanent actives.
- Overlapping sweeps (multi-instance or slow tick) are safe: every transition
  is a compare-and-set on the previous status; the loser is a no-op
  (verified in `callHardening.test.ts`).
- Scale guidance: cost is O(open sessions). With hundreds of simultaneous open
  calls this is still one small read + a handful of probes per tick. If open
  sessions ever reach thousands, batch the ghost probes with a single unfiltered
  `listRooms()` diff instead of per-room calls.

## Webhook volume

- LiveKit sends `participant_joined` / `participant_left` / `room_finished`
  per room. Volume is proportional to call activity (~3–10 events per direct
  call, more for group rooms with churn).
- Each webhook costs signature verification + one `getSessionByRoom` lookup;
  unknown rooms and unknown event names return immediately (safe no-ops), and
  unsigned payloads are rejected with 401 before any processing.
- Duplicate delivery is idempotent via the state machine's legal-transition
  table + CAS storage — no dedup table needed.

## Token minting

- Tokens are minted per authorized start/accept/join with
  `TOKEN_TTL_SECONDS` = 15 min TTL — pure local JWT signing, no LiveKit API
  call, negligible CPU. Expired tokens can't reconnect; the client re-joins
  through `/calls/:id/join`, which re-runs full Portava authorization.
- Room names are opaque (`pcall_` + 18 random bytes); possession of a name
  grants nothing without a minted token.

## Abuse / rate limits

- `MAX_STARTS_PER_HOUR` = 30 enforced twice: in-memory backstop
  (`checkRateLimit("call_start", …)`) before any DB work, and the engine's
  DB-authoritative `startsInLastHour` check.
- `REDIAL_COOLDOWN_MS` = 60 s after a decline — the deny happens before any
  signaling, so a declined caller cannot flood push notifications.
- Direct-start double-tap dedupe: a caller with an open direct session to the
  same callee/thread gets a grant into the existing session — no duplicate
  ring, push, or room.

## Hard duration cap

- `MAX_CALL_DURATION_MS` = 4 h bounds the cost of any single room; the sweep
  force-ends over-cap sessions (with room termination) even if both clients
  are gone.
