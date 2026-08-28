# Presence Network — domain model (Phase 0)

**Status:** design artifact. No tables created, no feature built, no `journey_*`
dependency taken. Spec §56 Phase 0 deliverable.

**Companion:** `00-integration-report.md` (the §74 report). Read that first — it
establishes what already exists. This document only covers the entities.

---

## The rule this model exists to enforce

> §2.2 — *"Never store an inferred location as though it were a raw fact."*

Most of the design below follows from taking that literally. An observation, an
estimate, and a prediction are **different types with different lifetimes and
different permissions**, not one row with a confidence column. Where the spec's
suggested entity would have collapsed that distinction, this model splits it;
where Portava already has a primitive, this model does not invent a second one.

---

## What should NOT get its own table

The spec's prime directive is "do not introduce duplicate systems where
equivalent primitives already exist" (§1, §24). These entities are **already
solved** in Portava and must be referenced, not rebuilt:

| Spec entity | Existing Portava primitive | Note |
|---|---|---|
| `experience_edge` | `compass_graph_edges` | Ships, populated, rebuilt daily |
| `PresenceIntent` (§41) | `memory_projections` (`memory_type='intent'`) | `record_intent_memory` already enforces ephemeral + clamped TTL. Adding `presence_intents` would be a second, weaker intent store. |
| Confidence model | `lib/confidenceScore.ts` | Weighted, replayable; **presence already carries the largest single weight** |
| Aggregate privacy threshold | `lib/privacyGate.ts` | k-anonymity, already used by intel |
| Block / circle predicates | `authz.is_blocked`, `authz.in_accepted_circle`, `viewer_is_blocked` | Relocated to `authz` by 2182 |
| Append-only enforcement | `public.intel_append_only()` | Shared trigger; note it blocks DELETE too (see the memory system's 2190 for why that matters) |
| Retention job pattern | `intelRetentionScheduler` / `journey_retention_health` | House scheduler shape |
| Erasure on account deletion | `AccountDeletionService` + an `erase_*_for_actor` RPC | **Must be explicit — see below** |

### The observation ledger is an open question, not a gap

`journey_observations` already exists on production with ~80% of
`PresenceObservation`: `lat/lng/accuracy_m/speed_mps/heading_deg`, `world_ref`,
`consent_scope`, `trust_class`, `idempotency_key`, `expires_at`, and
`quality_score/class/reasons`. It is empty, hardened (no `anon`/`authenticated`
grants, RLS forced, zero policies) and **deliberately gated** by a workstream that
chose to block it pending independent tester opt-in.

**Adopt-or-retire is an ownership decision, not an engineering one.** Until it is
made, this model defines the *shape* a presence observation must have and does not
bind to a table.

---

## Entities

### PresenceSession
A temporary physical-world context. **Must expire** (§2.4) — there is no
indefinite session.

- `session_type`: `event | trip | crew | bump | crowd | safety | ad_hoc`
- binds optionally to an existing container (`event_id`, `trip_id`)
- `expires_at` **NOT NULL** — the constraint, not a convention
- `location_precision_policy` — the ceiling for everything derived in this session
- `privacy_mode`, `relay_enabled`, `offline_enabled`

**Reconciliation required before building:** `location_sessions` already exists
and already carries `journey_purpose` with a CHECK that forces a finite
`expires_at` for journey sessions. `compass_live_sessions` separately models "a
temporary session with rolling context". A third session table would be the
duplication the spec forbids.

### PresenceMembership
Who may participate, and at what permission. **Joining an event must not imply
joining a precise-location circle** (§5) — attendance and location consent are
separate grants, and the model keeps them in separate tables so they cannot be
conflated by a join.

- `role`: `organizer | navigator | safety_lead | member | buddy`
- separate `location_permission`, `bump_permission`, `relay_permission`,
  `safety_permission` — one flag per capability, never one "sharing" boolean
- `expires_at` — membership expiry is independent of session expiry

### Ephemeral identity (§6)
Rotating, short-lived, unlinkable by unauthorized observers, replay-resistant.

**Non-negotiable:** no persistent user id, email, handle or profile id may ever
appear in a broadcast. The wire carries `ephemeral_id` only; resolution is
server-side and scoped to authorized session participants.

`expo-secure-store` already exists for the key material; `localMessageDb`'s
SQLCipher key lifecycle is the precedent to copy.

### PresenceObservation — a RAW REPORT
What a sensor or peer said. **Never a conclusion.** Deliberately has no
`position` field for a derived location: a position the system computed is an
estimate, not an observation.

- `subject_ephemeral_id`, optional `observer_ephemeral_id` (present when this
  device observed someone else)
- `source`: `gps | ble_direct | ble_relay | peer | venue_anchor | user_checkin |
  event_qr | wifi_context | motion | server_sync`
- `observed_at` (device clock — **must be clamped at ingest**, cf.
  `clampObservedAt` in `intelContracts.ts`) and `received_at` (server clock)
- coarse `proximity` bucket, never a decimal metre reading — §14: RSSI is too
  noisy to justify one
- `expires_at` **NOT NULL** — §53: identifiable presence data is short-retention
  by default
- append-oriented: corrections are new rows

### PresenceEstimate — a DERIVED CONCLUSION
Separate type, separate lifetime, recomputable.

- `state`: `precise | nearby | relayed | recent | inferred | predicted |
  last_known | unknown`
- `confidence` and `freshness` are **separate scalars**. Collapsing them is
  precisely how a stale pin becomes a live one: a highly-confident reading can be
  very old.
- `precision` — the ceiling after policy, never above the session's policy

Only `precise | nearby | relayed` may be rendered as a current position. The
other five are history or a guess and must be visually distinct (§16).

### PresenceEncounter (Bump substrate)
A mutually-eligible crossed path. Eligibility is **an intersection, never a
union**: if A is `everyone` and B is `circle`, and A is outside B's circle, there
is no encounter (§25). The narrowest preference always wins.

Blocks override everything (§44) — enforced with `authz.is_blocked`, server-side,
never client-filtered.

### PresencePermission / precision policy (§52)
`none | presence_only | venue | zone | approximate | nearby | precise`

One shared resolver, applied server-side per viewer. Per-feature ceilings:
crowd intelligence `presence_only`; bump `zone`; crew `approximate|precise` by
consent; SOS temporary `precise` only if explicitly permitted.

Implemented in `presence/domain/types.ts` as a **narrowing-only** combinator —
there is deliberately no widening helper, because a widening helper is how
precision leaks get written.

---

## Lifecycles

```
observation ──▶ (fusion) ──▶ estimate ──▶ (policy) ──▶ projection ──▶ feature
     │                            │                                      │
   expires                    recomputed                            never cached
   (TTL)                      (not stored as fact)                   above policy
```

**Retention by class** (§53), shortest by default:

| Class | Examples | Behaviour |
|---|---|---|
| Ephemeral | current intent, live venue state | minutes–hours, hard TTL |
| Short-lived | recent tap/search context | days |
| Trip-context | trip planning state | trip duration + bounded grace |
| Durable fact | verified trip, stamp | canonical lifecycle / user deletion |
| Derived preference | inferred interest | recompute / decay, user-resettable |
| Historical contribution | past intel contribution | policy retention; **never presented as current state** |

---

## Deletion — the mistake not to repeat

The memory system assumed `auth.users → profiles → … ON DELETE CASCADE` and was
certified on CI. **Production's `public.profiles` has no foreign key to
`auth.users`**, and `AccountDeletionService` keeps an *anonymised tombstone
profile* rather than deleting the row — so the cascade could never fire there.

**Every presence table must therefore:**
1. be registered in `deletionDispositions.ts`, and
2. be purged by an **explicit** step in `AccountDeletionService` (an
   `erase_presence_for_user`-style SECURITY DEFINER RPC, mirroring
   `erase_intel_for_actor` / `erase_memory_for_user`), and
3. have that step be **fatal** — leaving identifiable presence data behind after a
   deletion request is a privacy failure, not a warning.

Do not rely on a foreign-key cascade for any of it.

---

## Authorization rules every presence function must follow

Learned the hard way from 2182 and re-learned in 2190:

1. `REVOKE ALL ... FROM PUBLIC, anon, authenticated` — Supabase's default
   privileges grant EXECUTE to `anon` **and** `authenticated` explicitly, so
   revoking from `PUBLIC` alone is insufficient.
2. **Any `DROP`/`CREATE` re-grants those defaults.** A recreated function is a new
   object with a new ACL. Re-revoke every time.
3. Pin `search_path`.
4. Derive the caller from `auth.uid()` — never accept identity as a parameter on
   anything reachable by a client.
5. Internal tables: RLS enabled, **zero policies**, `service_role` grants only.
6. Assert the **grant** in tests, not just the rows — under RLS an empty result is
   indistinguishable from a denial, which is exactly how a mis-grant hides.
