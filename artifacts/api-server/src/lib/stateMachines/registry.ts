/**
 * The state-machine registry — every lifecycle state this server models, and
 * the writer that can actually put a row into it.
 *
 * ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────────
 * A STATE WITH NO REACHABLE WRITER. `events.state` has a `started` member. The
 * enum has it, migration 2033's RLS policy names it, two Passport services list
 * it in LIVE_EVENT_STATES, and THREE routes require it:
 *
 *   POST /events/:id/complete        state === 'started'
 *   POST /events/:id/attendance/:u   state IN (started, completed)
 *   POST /events/:id/noshow/:u       state IN (started, completed)
 *
 * Nothing has ever written it. Production, measured 2026-09-07: 97 `open`
 * events (96 already past `starts_at`), 7 `completed`, **0 `started`**, and
 * **0 rows in `event_activity_log`** — no event there has ever passed through a
 * transitioning route at all. The 7 completed rows were INSERTED completed by
 * `src/scripts/seed-demo-profile.ts`; every one has `created_at == updated_at`
 * to the microsecond and no activity row. So `POST /complete` has never
 * succeeded on production, and it cannot: its gate is a state nothing reaches.
 *
 * Every piece type-checks. Every test passes. The enum label is valid, the
 * routes are wired, the RLS policy admits it. Nothing fails, so nothing says so.
 *
 * ── WHY A REGISTRY AND NOT AN ENUM SCANNER ───────────────────────────────────
 * A blind scan over every enum in this schema reports hundreds of states, most
 * of them fine, and the noise gets it disabled inside a week. Worse, it cannot
 * tell the three cases apart that matter, and they look identical from the
 * outside:
 *
 *   * a state nobody wrote BECAUSE A PERSON OWES A DECISION (`events.started`);
 *   * a state only an operator can cause (`trust_events.confirmed`);
 *   * a state whose writer is built, correct, and switched OFF on purpose
 *     (`intel_live_promoted_scopes` promotion, flag seeded FALSE by 2430);
 *   * a state that is vocabulary and nothing else (`intel_claims.retracted`).
 *
 * Only the FIRST is a thing to build, and it is not engineering's to build.
 * So the registry states which of the four each state is, WITH ITS EVIDENCE,
 * and `src/scripts/checkStateMachineWriters.ts` verifies every claim against
 * the tree: the writer file exists and contains the write; the declared states
 * are exactly the schema's states, in both directions, so a new enum label
 * cannot be added without being classified; an OWNER_BLOCKED state's decision
 * is named in a doc that exists; a HOLD state's flag is really seeded FALSE by
 * the migration that is cited.
 *
 * ── CLASSIFICATIONS ──────────────────────────────────────────────────────────
 *   REACHABLE       an ordinary user action or a running scheduler reaches it.
 *   OWNER_BLOCKED   no reachable writer, and the reason is a PRODUCT decision a
 *                   named person has not taken. Requires `ownerDecision`. This
 *                   is NOT satisfied by implementing the writer — see the pin
 *                   in the checker.
 *   OPS_DRIVEN      only an operator/admin surface reaches it. Legitimate; the
 *                   entry must name the surface.
 *   HOLD            the writer exists and is correct, and is deliberately
 *                   switched off behind a flag seeded FALSE. Requires the flag
 *                   and the migration that seeds it.
 *   DECLARED_UNUSED declared vocabulary with no producer AND no consumer that
 *                   is starved by its absence. Removing it is a schema
 *                   decision. The entry must name who mentions it and why they
 *                   are not starved.
 *   MISSING_WRITER  no producer, and a consumer IS starved. THE DEFECT. The
 *                   checker FAILS on it. It is a classification, not an
 *                   exemption: writing it down is how you report the finding,
 *                   not how you silence it.
 *
 * ── WHAT P11 ADDED, AND WHAT IT TAUGHT ───────────────────────────────────────
 * Three machines: RAB_BOOKING_STATUS (14 states), SAFE_RETURN_SESSION_STATUS
 * (5) and SAFE_RETURN_LIVE_SHARE_STATUS (3). Two things had to change to
 * register them honestly rather than plausibly.
 *
 * FIRST, a flag seeded FALSE is not a flag that IS false. Read only the code,
 * Safe Return looks exactly like a HOLD: every route refuses unless
 * `safe_return_enabled` is on, and both migrations that seed it seed it FALSE.
 * The 2026-09-08 production snapshot says it is TRUE, and the flag matrix
 * records it as an ON flag whose missing schema 2219 supplied. Five HOLD states
 * there would have been a tidy, checkable, false report. Rent-a-Buddy is the
 * mirror image: `rent_buddy_enabled` is seeded FALSE by 2210 AND measured FALSE
 * in the same snapshot, so its user paths really are held. Where the two
 * disagree, the measurement wins, and the entry says which measurement.
 *
 * SECOND, some rows are created in a state by the SCHEMA. `createSession`
 * inserts a `safe_return_sessions` row without mentioning `status`; the row is
 * `pending` because the column says so. The evidence rule ("cite a line naming
 * the state") could only have been satisfied there by quoting a DOCBLOCK — a
 * comment offered as proof of a write, which is the substitution this whole
 * lane exists to refuse. `StateWriter.columnDefault` says so out loud instead,
 * and the checker verifies the DEFAULT inside the right CREATE TABLE.
 *
 * ── WHAT IS NOT REGISTERED, AND WHY ──────────────────────────────────────────
 * MEDIA (`media_assets.moderation_status`) is deliberately absent. Its state
 * set is not stable: migration 0191 shipped
 *   pending | approved | flagged | rejected
 * and 2250/2470 replace that CHECK with
 *   processing | active | limited | rejected | removed | owner_deleted
 *   + pending | approved | flagged (legacy rows)
 * Neither 2250 nor 2470 is applied — both are `blocked_by_owner_decision:
 * MEDIA_CANONICAL_FLAG` (docs/architecture/migration-disposition-ledger.md),
 * because `media_canonical_enabled` is TRUE in production while the canonical
 * columns are absent. Until that decision is taken there is no single answer to
 * "what are the media states", so a registry entry would have to pick one of
 * two schemas and would be wrong in one deployment or the other. Registering it
 * would mean inventing the answer to an open owner decision, which is the
 * failure mode this whole lane exists to avoid.
 */

/** How a state was judged. See the header. */
export type StateClassification =
  | "REACHABLE"
  | "OWNER_BLOCKED"
  | "OPS_DRIVEN"
  | "HOLD"
  | "MISSING_WRITER"
  | "DECLARED_UNUSED";

/**
 * Ranked most-reachable first. A state's classification must equal the
 * classification of its most reachable incoming transition — you cannot call a
 * state REACHABLE when the only thing that writes it is an admin console.
 */
export const CLASSIFICATION_RANK: Record<StateClassification, number> = {
  REACHABLE: 0,
  OPS_DRIVEN: 1,
  HOLD: 2,
  OWNER_BLOCKED: 3,
  MISSING_WRITER: 4,
  DECLARED_UNUSED: 5,
};

/**
 * Where the state vocabulary is DEFINED, so the registry can be checked against
 * it rather than believed.
 *
 *   pgEnum    CREATE TYPE <symbol> AS ENUM ('a','b',…)
 *   sqlCheck  a CHECK (col IN ('a','b',…)); `anchor` locates it (a constraint
 *             name, or the opening of the CHECK) and the first `IN (…)` after
 *             the anchor is the list. The anchor must occur EXACTLY ONCE.
 *   derived   there is no state column: the state is computed from timestamps
 *             (promoted / withdrawn / expired). `columns` are the columns the
 *             derivation reads and must all exist in `file`.
 */
export type StateVocabulary =
  | { kind: "pgEnum"; file: string; symbol: string }
  | { kind: "sqlCheck"; file: string; anchor: string }
  | {
      kind: "derived";
      file: string;
      columns: readonly string[];
      derivation: string;
      /**
       * Functions that turn the columns into the state, for machines whose state
       * NAMES appear nowhere in the code.
       *
       * A consumer of `trust_restrictions.active` cannot mention "active" — the
       * state IS `lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())`
       * — and services/interactionPermissions.ts, which is the enforcement point
       * for the whole lifecycle, names it only in two unrelated comments. Under a
       * name-matching consumer rule that file reads as "not a consumer", which is
       * false: it calls getRestrictionState and refuses the interaction on the
       * answer. So a derived machine names its accessors, the checker proves each
       * one is DEFINED in one of the machine's own writer files, and a consumer
       * may prove itself by calling one instead of by spelling a label that does
       * not exist.
       */
      accessors?: readonly string[];
    };

/** A TS constant that mirrors the SQL vocabulary; drift between them is a bug. */
export type VocabularyMirror = { file: string; symbol: string };

/**
 * The thing that can put a row into a state.
 *
 * `evidence` is a list of literal substrings that must ALL appear in `file`.
 * At least one of them must contain the target state's name, so an entry
 * cannot point at unrelated code and call it a writer. When the write happens
 * inside a SQL function, `via` names it and `sqlFile` is the migration that
 * defines it — the SQL file must contain both the function name and the state
 * literal, because a TS caller of an RPC contains neither.
 */
export type StateWriter = {
  /** Path under artifacts/api-server/src. */
  file: string;
  evidence: readonly string[];
  /** SQL function that performs the write on the caller's behalf. */
  via?: string;
  /** Path under artifacts/api-server that defines `via`. */
  sqlFile?: string;
  /**
   * The row is CREATED in this state by the column's DDL DEFAULT, not by any
   * literal in the writer.
   *
   * `SafeReturnService.createSession` inserts a `safe_return_sessions` row
   * without ever naming `status`; the row is `pending` because
   * `status TEXT NOT NULL DEFAULT 'pending'` says so. The ordinary rule —
   * evidence must name the state — cannot be met honestly, and the only text in
   * that file naming "pending" is a docblock, so obeying the rule would mean
   * citing a COMMENT as proof of a write. That is precisely the defect this
   * whole lane is about, so the modelling is made explicit instead: the writer
   * shows it inserts into the table, and `file` must give `column` that DEFAULT
   * inside the CREATE TABLE for THIS storage.
   */
  columnDefault?: {
    /** Path under artifacts/api-server holding the CREATE TABLE. */
    file: string;
    column: string;
  };
};

export type StateTransition = {
  /**
   * Source states. Empty = the writer does not read a prior state: either the row
   * is CREATED in the target state, or the writer recomputes the whole row from
   * scratch (TRUST_PROFILE_PUBLIC_LEVEL) so any prior label is equally a source.
   */
  from: readonly string[];
  to: string;
  classification: StateClassification;
  writer: StateWriter;
  /** For time-driven transitions: the entry point that starts the scheduler. */
  scheduler?: { starts: string; from: string };
  /** Required for every classification except REACHABLE. */
  reason?: string;
};

export type OwnerDecision = {
  /** The decision's id as it appears in the docs, e.g. EVENT_START_TRANSITION. */
  id: string;
  /** Docs (repo-relative) that record it. Each must exist and name the id. */
  docs: readonly string[];
  /** What the person actually has to decide. */
  question: string;
};

export type HoldGate = {
  flag: string;
  /** Migration (api-server-relative) that seeds the flag FALSE. */
  seededFalseIn: string;
  /** File under src/ that READS the flag. */
  readBy: string;
};

export type MachineState = {
  name: string;
  classification: StateClassification;
  /** No transition leaves this state. */
  terminal?: boolean;
  /** Reachable only by a human operator through an ops/admin surface. */
  manual?: boolean;
  /** Required unless REACHABLE. Must be substantive, not "nobody writes it". */
  reason?: string;
  ownerDecision?: OwnerDecision;
  hold?: HoldGate;
  /**
   * Files (under src/) that CONSUME this state. Required for OWNER_BLOCKED,
   * DECLARED_UNUSED and MISSING_WRITER: it is the difference between "a gate
   * nobody can open" and "a label nobody uses". Each must exist and mention
   * the state.
   */
  consumers?: readonly string[];
};

export type StateMachineEntry = {
  key: string;
  /** Table (or model) the state lives on. */
  storage: string;
  /** Column, or "(derived)" for a computed lifecycle. */
  field: string;
  vocabulary: StateVocabulary;
  mirror?: VocabularyMirror;
  states: readonly MachineState[];
  transitions: readonly StateTransition[];
  /** Why this machine is in the registry at all. */
  note?: string;
};

export const STATE_MACHINES: readonly StateMachineEntry[] = [
  // ══════════════════════════════════════════════════════════════════════════
  // EVENTS — the founding case
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: "EVENTS_STATE",
    storage: "events",
    field: "state",
    vocabulary: { kind: "pgEnum", file: "baseline/20260819_baseline_structure.sql", symbol: "public.event_state" },
    note:
      "PATCH /events/:id additionally accepts a raw `state` from the body (UpdateEventSchema, " +
      "routes/events.ts:631, enum draft|open|started|completed|cancelled|archived) and writes it with NO " +
      "transition guard (:2334). It is host-only. That path is a recorded defect, not a lifecycle writer: " +
      "no client in the repository sends it, and production's empty event_activity_log says nobody ever " +
      "has. It is deliberately NOT registered as a transition — treating an unguarded free-transition as " +
      "the writer of `started` would let this registry report the gap as closed while every measured fact " +
      "says it is open. See docs/architecture/event-lifecycle-started-transition.md §1.",
    states: [
      { name: "draft", classification: "REACHABLE" },
      { name: "open", classification: "REACHABLE" },
      { name: "full", classification: "REACHABLE" },
      { name: "waitlist", classification: "REACHABLE" },
      {
        name: "started",
        classification: "OWNER_BLOCKED",
        reason:
          "Nothing has ever written it. Production 2026-09-07: 97 open (96 past starts_at), 7 completed, 0 " +
          "started, 0 rows in event_activity_log. lib/eventLifecycle.ts implements the DERIVED rule " +
          "(open|full|waitlist + starts_at <= now => started) and is started from index.ts, but it is gated " +
          "on event_start_transition_enabled, which migration 2600 seeds FALSE and which no one has flipped. " +
          "The flag is not a rollout step: flipping it CHOOSES option (a) of an unresolved product decision.",
        ownerDecision: {
          id: "EVENT_START_TRANSITION",
          docs: [
            "docs/architecture/event-lifecycle-started-transition.md",
            "docs/architecture/blocker-ledger.md",
          ],
          question:
            "Does an event become `started` because its start time passed (derived), or only because its " +
            "host said so (host-initiated), or both? They differ for real people: under derived, an event " +
            "nobody attended still starts and can be completed; under host-initiated, a host who forgets " +
            "can never complete the event, no attendance or no-show can ever be marked, and neither the " +
            "host's event_hosted nor the attendees' event_attended trust ever accrues.",
        },
        consumers: [
          "routes/events.ts",
          "services/passport/PassportProjectionService.ts",
          "services/trust/TrustEventService.ts",
        ],
      },
      {
        name: "completed",
        classification: "OWNER_BLOCKED",
        reason:
          "POST /events/:id/complete is the only guarded writer and it refuses unless state === 'started' " +
          "(routes/events.ts:4636). `started` is itself OWNER_BLOCKED, so completion is unreachable through " +
          "the API for exactly as long as EVENT_START_TRANSITION is unresolved — this state's blocker is " +
          "the same person's same decision, one hop downstream. Production holds 7 completed events and " +
          "none of them transitioned: seed-demo-profile.ts INSERTS them completed (`isPast ? 'completed'`), " +
          "and all 7 have created_at == updated_at and no activity row.",
        ownerDecision: {
          id: "EVENT_START_TRANSITION",
          docs: [
            "docs/architecture/event-lifecycle-started-transition.md",
            "docs/architecture/blocker-ledger.md",
          ],
          question:
            "The same decision. Its second half is recorded and equally untaken: should an event whose " +
            "ends_at has passed auto-complete, and if so does that fire POST /complete's trust events, " +
            "stamps and review pushes, or none of them? 94 of the 97 open production events are already " +
            "past ends_at.",
        },
        consumers: ["routes/events.ts"],
      },
      { name: "cancelled", classification: "REACHABLE" },
      { name: "archived", classification: "REACHABLE", terminal: true },
    ],
    transitions: [
      {
        from: [],
        to: "draft",
        classification: "REACHABLE",
        writer: { file: "routes/events.ts", evidence: ['const initialState = b.publishNow ? "open" : "draft";'] },
      },
      {
        from: [],
        to: "open",
        classification: "REACHABLE",
        writer: { file: "routes/events.ts", evidence: ['state:            "open",'] },
      },
      {
        from: ["draft"],
        to: "open",
        classification: "REACHABLE",
        writer: { file: "routes/events.ts", evidence: ['.update({ state: "open", updated_at: new Date().toISOString() })'] },
      },
      {
        from: ["open", "waitlist"],
        to: "full",
        classification: "REACHABLE",
        writer: {
          file: "routes/events.ts",
          evidence: ['newState = (ev as any).waitlist_enabled ? "waitlist" : "full";', 'await sc.from("events").update({ state: newState'],
        },
      },
      {
        from: ["open", "full"],
        to: "waitlist",
        classification: "REACHABLE",
        writer: {
          file: "routes/events.ts",
          evidence: ['newState = (ev as any).waitlist_enabled ? "waitlist" : "full";', 'await sc.from("events").update({ state: newState'],
        },
      },
      {
        from: ["full", "waitlist"],
        to: "open",
        classification: "REACHABLE",
        writer: { file: "routes/events.ts", evidence: ['newState = "open";'] },
      },
      {
        from: ["open", "full", "waitlist"],
        to: "started",
        classification: "OWNER_BLOCKED",
        writer: {
          file: "lib/eventLifecycle.ts",
          evidence: [
            'export const EVENT_STARTED_STATE = "started";',
            ".update({ state: EVENT_STARTED_STATE, updated_at: nowIso })",
          ],
        },
        scheduler: { starts: "startEventLifecycleScheduler", from: "index.ts" },
        reason:
          "The writer is BUILT and STARTED, and still writes nothing: runEventStartPass returns before its " +
          "read when event_start_transition_enabled is off, and 2600 seeds it FALSE. This is not a HOLD — " +
          "a hold is a switch someone may flip when convenient. Flipping this one TAKES the " +
          "EVENT_START_TRANSITION decision (option (a), derived) on the owner's behalf, and its first pass " +
          "on production would move 96 events for 3 hosts.",
      },
      {
        from: ["started"],
        to: "completed",
        classification: "OWNER_BLOCKED",
        writer: {
          file: "routes/events.ts",
          evidence: [
            'if ((ev as any).state !== "started") {',
            '.update({ state: "completed", updated_at: new Date().toISOString() })',
          ],
        },
        reason:
          "The route exists, is host-gated and is correct; its precondition is a state that no reachable " +
          "writer produces. A transition out of an unreachable state is unreachable, however healthy the " +
          "code looks — this is the shape that made the defect invisible for so long.",
      },
      {
        from: ["draft", "open", "full", "waitlist", "started", "completed"],
        to: "cancelled",
        classification: "REACHABLE",
        writer: { file: "routes/events.ts", evidence: ['.update({ state: "cancelled", updated_at: new Date().toISOString() })'] },
      },
      {
        from: ["open", "full", "waitlist"],
        to: "draft",
        classification: "REACHABLE",
        writer: { file: "routes/events.ts", evidence: ['.update({ state: "draft", updated_at: new Date().toISOString() })'] },
      },
      {
        from: ["draft", "open", "full", "waitlist", "started", "completed", "cancelled"],
        to: "archived",
        classification: "REACHABLE",
        writer: { file: "routes/events.ts", evidence: ['.update({ state: "archived", updated_at: new Date().toISOString() })'] },
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TRIPS — the counter-example: every state of a same-shaped machine reachable
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: "TRIPS_STATUS",
    storage: "trips",
    field: "status",
    vocabulary: { kind: "pgEnum", file: "baseline/20260819_baseline_structure.sql", symbol: "public.trip_status" },
    note:
      "Registered as the CONTROL for events. Same shape — a lifecycle enum on a user-owned row, with " +
      "terminal states and time-driven middle states — and every member has a writer, which is what makes " +
      "`events.started` a defect rather than a house style. The difference is where the clock lives: trips " +
      "derive draft/upcoming/active/completed from dates inside computeTripStatus on every create and " +
      "PATCH, so no scheduler is needed and no state is stranded. (The cost of that design is staleness, " +
      "not unreachability: an untouched trip keeps the status it was last written with.)",
    states: [
      { name: "draft", classification: "REACHABLE" },
      { name: "planning", classification: "REACHABLE" },
      { name: "upcoming", classification: "REACHABLE" },
      { name: "active", classification: "REACHABLE" },
      { name: "completed", classification: "REACHABLE" },
      { name: "cancelled", classification: "REACHABLE" },
      { name: "archived", classification: "REACHABLE", terminal: true },
    ],
    transitions: [
      {
        from: [],
        to: "planning",
        classification: "REACHABLE",
        writer: { file: "lib/tripStatus.ts", evidence: ['return "planning";'] },
      },
      {
        from: ["planning", "upcoming", "active", "completed"],
        to: "draft",
        classification: "REACHABLE",
        writer: { file: "lib/tripStatus.ts", evidence: ['if (!title || !destinationCity) return "draft";'] },
      },
      {
        from: ["draft", "planning", "active", "completed"],
        to: "upcoming",
        classification: "REACHABLE",
        writer: { file: "lib/tripStatus.ts", evidence: ['if (today < start)        return "upcoming";'] },
      },
      {
        from: ["draft", "planning", "upcoming"],
        to: "active",
        classification: "REACHABLE",
        writer: { file: "lib/tripStatus.ts", evidence: ['if (!end || today <= end) return "active";'] },
      },
      {
        from: ["draft", "planning", "upcoming", "active"],
        to: "completed",
        classification: "REACHABLE",
        writer: { file: "routes/trips-expansion.ts", evidence: ['.update({ status: "completed", updated_at: new Date().toISOString() })'] },
      },
      {
        from: ["draft", "planning", "upcoming", "active", "completed"],
        to: "cancelled",
        classification: "REACHABLE",
        writer: { file: "routes/trips-expansion.ts", evidence: ['.update({ status: "cancelled", updated_at: new Date().toISOString() })'] },
      },
      {
        from: ["draft", "planning", "upcoming", "active", "completed", "cancelled"],
        to: "archived",
        classification: "REACHABLE",
        writer: { file: "routes/trips-expansion.ts", evidence: ['.update({ status: "archived", updated_at: new Date().toISOString() })'] },
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // INTEL CLAIMS — three states produced, four that are vocabulary only
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: "INTEL_CLAIMS_STATUS",
    storage: "intel_claims",
    field: "status",
    vocabulary: { kind: "sqlCheck", file: "src/migrations/2130_intel_storage.sql", anchor: "CONSTRAINT intel_claims_status_check" },
    mirror: { file: "lib/intelContracts.ts", symbol: "CLAIM_STATUSES" },
    note:
      "The table holds 0 rows in production (docs/architecture/blocker-ledger.md P4), which is an OPS_DATA " +
      "blocker on geo_zones and observations, NOT a writer defect: candidate/active/superseded each have a " +
      "live producer that would run the moment observations flow. The finding here is the other four " +
      "members of the CHECK, which no producer anywhere writes.",
    states: [
      { name: "candidate", classification: "REACHABLE" },
      { name: "active", classification: "REACHABLE" },
      { name: "superseded", classification: "REACHABLE", terminal: true },
      {
        name: "conflicting",
        classification: "DECLARED_UNUSED",
        reason:
          "No producer in TS, SQL, trigger or function. It is READ — LIVE_ELIGIBLE_CLAIM_STATUSES admits it, " +
          "2174's one-live-per-key partial unique index covers it, and the aggregator applies a conflict " +
          "penalty on it — but no consumer is starved, because conflict is modelled at PROJECTION time, not " +
          "on the claim: intelProjectionAggregator.ts:527 computes `conflicting` as " +
          "`claim.status === 'conflicting' || cohortConflicting || conflict.state === 'material'`, and the " +
          "two other disjuncts are produced on every pass. The stored status is a third input that the " +
          "design never fills; the filters that admit it would serve a hand-set row correctly.",
        consumers: ["lib/intelContracts.ts", "lib/intelProjectionAggregator.ts", "lib/intelCoverageScheduler.ts"],
      },
      {
        name: "expired",
        classification: "DECLARED_UNUSED",
        terminal: true,
        reason:
          "Expiry is modelled by TIMESTAMPS, not by this label: every claim carries expires_at and " +
          "hard_expires_at, every reader filters on them, and intelProjectionScheduler expires the derived " +
          "SNAPSHOT (privacy_eligible=false, expires_at=now) rather than restating expiry on the claim. " +
          "Nothing anywhere queries status='expired', so no consumer is starved by its absence; the label " +
          "is a second, unused spelling of a fact the timestamps already carry.",
        consumers: ["lib/intelContracts.ts"],
      },
      {
        name: "retracted",
        classification: "DECLARED_UNUSED",
        terminal: true,
        reason:
          "Retraction is modelled UPSTREAM of the claim: a contributor withdraws consent " +
          "(intel_contribution_consent.withdrawn_at, which the promotion function joins on) or the " +
          "observation is moderated away (intel_observations.moderation_state). Neither propagates a label " +
          "onto the claim. Its one consumer, the pattern-invalidation pass, reads " +
          "['retracted','superseded','rejected'] together and IS satisfied — `superseded` is written by " +
          "correctClaim on every correction — so the feature works and this member adds nothing.",
        consumers: ["lib/intelPatternLearning.ts", "lib/intelPatternScheduler.ts"],
      },
      {
        name: "rejected",
        classification: "DECLARED_UNUSED",
        terminal: true,
        reason:
          "Same shape as `retracted`: rejection lives on the OBSERVATION " +
          "(intel_observations.moderation_state IN ('restricted','blocked','removed')) and gates promotion " +
          "there — system_promote_admissible_intel_claims only promotes 'pending'/'allowed' observations, " +
          "so a rejected observation never becomes a claim that would need this label. The " +
          "pattern-invalidation consumer that names it is satisfied by `superseded`.",
        consumers: ["lib/intelPatternLearning.ts", "lib/intelPatternScheduler.ts"],
      },
    ],
    transitions: [
      {
        from: [],
        to: "candidate",
        classification: "REACHABLE",
        writer: { file: "services/intel/IntelCaptureService.ts", evidence: ['status: "candidate",', '.from("intel_claims").insert(claim)'] },
      },
      {
        from: [],
        to: "active",
        classification: "REACHABLE",
        writer: {
          file: "lib/intelPromotionScheduler.ts",
          evidence: ['db.rpc("system_promote_admissible_intel_claims")'],
          via: "system_promote_admissible_intel_claims",
          sqlFile: "src/migrations/2174_intel_system_claim_promotion.sql",
        },
        scheduler: { starts: "startIntelPromotionScheduler", from: "index.ts" },
      },
      {
        from: ["candidate"],
        to: "active",
        classification: "OPS_DRIVEN",
        writer: { file: "services/intel/IntelCaptureService.ts", evidence: ['.update({ status: "active", promotion_source: "admin" })'] },
        reason:
          "approveClaim is the ADMIN path (routes/intel.ts gates it behind requireAdmin) and records " +
          "promotion_source='admin' for provenance parity with the autonomous one. It is a second, " +
          "operator-driven route into a state the scheduler already reaches on its own.",
      },
      {
        from: ["candidate", "active", "conflicting"],
        to: "superseded",
        classification: "REACHABLE",
        writer: { file: "services/intel/IntelCaptureService.ts", evidence: ['.update({ status: "superseded" })'] },
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // INTEL LIVE PROMOTED SCOPES — a complete writer, deliberately switched off
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: "INTEL_LIVE_SCOPE_LIFECYCLE",
    storage: "intel_live_promoted_scopes",
    field: "(derived: promoted_at / expires_at / withdrawn_at)",
    vocabulary: {
      kind: "derived",
      file: "src/migrations/2430_intel_live_scope_promotion_writer.sql",
      columns: ["expires_at", "withdrawn_at", "promoted_via"],
      derivation:
        "withdrawn_at IS NOT NULL => withdrawn; expires_at <= now() => expired (and the sweep then marks it " +
        "withdrawn('expired'), so the row states what the read path already infers); otherwise promoted. " +
        "There is no status column: the read path (lib/liveClaimRead.ts) applies exactly this rule, and " +
        "keeping the row after withdrawal is what makes the allowlist its own audit trail of what was live.",
    },
    note:
      "Registered because it is the clean contrast with events.started: same 'nothing is in this state', " +
      "opposite cause. 2179 created the table saying 'promote a scope by inserting a row' and nothing ever " +
      "did — checkWriterlessReads.ts carried it as a human-curated allowlist until 2430 built the writer. " +
      "The writer now exists end to end (SQL functions, service, admin routes) and is off behind TWO flags " +
      "seeded FALSE. That is a HOLD, not a gap: nothing is owed by engineering, and turning it on promotes " +
      "nothing by itself — a promotion is a human decision recorded with evidence and a review horizon.",
    states: [
      {
        name: "promoted",
        classification: "HOLD",
        reason:
          "The write path is complete: system_promote_intel_live_scope (2430), lib/intelLiveScopePromotion." +
          "promoteLiveScope, and POST /admin/intel/live-scopes/promote. It performs NO write while " +
          "intel_live_scope_promotion_enabled is off — the service returns {skipped:true, reason:'disabled'} " +
          "before any RPC — and 2430 seeds that flag FALSE. The admin surface has its own FALSE flag (2570). " +
          "The table is empty in production, which starves every readLiveClaims consumer; that is an ops " +
          "decision about WHICH scope to promote on what evidence, not a missing lane.",
        hold: {
          flag: "intel_live_scope_promotion_enabled",
          seededFalseIn: "src/migrations/2430_intel_live_scope_promotion_writer.sql",
          readBy: "lib/intelLiveScopePromotion.ts",
        },
      },
      {
        name: "withdrawn",
        classification: "HOLD",
        terminal: true,
        reason:
          "system_withdraw_intel_live_scope + withdrawLiveScope + POST /admin/intel/live-scopes/withdraw, " +
          "behind the same flag and the same admin-surface flag. Unreachable today only because nothing has " +
          "been promoted yet — you cannot withdraw a scope that was never live — and because the flag that " +
          "gates the writer is seeded FALSE.",
        hold: {
          flag: "intel_live_scope_promotion_enabled",
          seededFalseIn: "src/migrations/2430_intel_live_scope_promotion_writer.sql",
          readBy: "lib/intelLiveScopePromotion.ts",
        },
      },
      {
        name: "expired",
        classification: "HOLD",
        terminal: true,
        reason:
          "Time-driven: runLiveScopeExpiryPass runs on every intelPromotionScheduler tick and calls " +
          "system_expire_intel_live_scopes, which marks each promoted scope past its review horizon as " +
          "withdrawn('expired'). The scheduler IS started from index.ts, so unlike the events case the pass " +
          "genuinely runs; it returns before the RPC while the flag is off, and has nothing to expire while " +
          "nothing is promoted.",
        hold: {
          flag: "intel_live_scope_promotion_enabled",
          seededFalseIn: "src/migrations/2430_intel_live_scope_promotion_writer.sql",
          readBy: "lib/intelLiveScopePromotion.ts",
        },
      },
    ],
    transitions: [
      {
        from: [],
        to: "promoted",
        classification: "HOLD",
        writer: {
          file: "lib/intelLiveScopePromotion.ts",
          evidence: ['db.rpc("system_promote_intel_live_scope"'],
          via: "system_promote_intel_live_scope",
          sqlFile: "src/migrations/2430_intel_live_scope_promotion_writer.sql",
        },
        reason:
          "Gated on intel_live_scope_promotion_enabled (seeded FALSE by 2430) and reachable only through the " +
          "admin surface, which carries its own FALSE flag from 2570. Both are owner switches; neither " +
          "promotes anything on its own.",
      },
      {
        from: ["promoted"],
        to: "withdrawn",
        classification: "HOLD",
        writer: {
          file: "lib/intelLiveScopePromotion.ts",
          evidence: ['db.rpc("system_withdraw_intel_live_scope"'],
          via: "system_withdraw_intel_live_scope",
          sqlFile: "src/migrations/2430_intel_live_scope_promotion_writer.sql",
        },
        reason:
          "Same flag gate as promotion. The row is KEPT on withdrawal by design, so the allowlist doubles " +
          "as the record of everything that was ever live and why it stopped being live.",
      },
      {
        from: ["promoted"],
        to: "expired",
        classification: "HOLD",
        writer: {
          file: "lib/intelLiveScopePromotion.ts",
          evidence: ['db.rpc("system_expire_intel_live_scopes"'],
          via: "system_expire_intel_live_scopes",
          sqlFile: "src/migrations/2430_intel_live_scope_promotion_writer.sql",
        },
        scheduler: { starts: "startIntelPromotionScheduler", from: "index.ts" },
        reason:
          "Time-driven sweep on the promotion scheduler's tick, gated on the same FALSE-seeded flag. The " +
          "read path already treats an expired row as not promoted, so the sweep makes the row agree with " +
          "the enforcement rather than changing what is served.",
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TRUST EVENTS — adjudication, half automatic and half operator-driven
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: "TRUST_EVENTS_STATUS",
    storage: "trust_events",
    field: "status",
    vocabulary: { kind: "sqlCheck", file: "migrations/0043_trust_engine.sql", anchor: "CHECK (status IN ('applied'" },
    note:
      "trust_events holds 5 rows in production and 56 of 58 users have no trust_profiles row " +
      "(docs/architecture/blocker-ledger.md P4). That is an emitter-coverage problem — 13 of 31 declared " +
      "event types are unproduced — and belongs to the trust-vocabulary census, not here. What this entry " +
      "asserts is narrower and checkable: every member of the status CHECK has a writer, and the two that " +
      "only an admin can cause are declared as such rather than passing for ordinary flow.",
    states: [
      { name: "applied", classification: "REACHABLE" },
      { name: "pending_review", classification: "REACHABLE" },
      {
        name: "confirmed",
        classification: "OPS_DRIVEN",
        manual: true,
        reason:
          "Only TrustAdminService.confirmEvent writes it, reachable only through POST " +
          "/admin/trust/events/:eventId/confirm (routes/trust-admin.ts, admin-gated). Correctly manual: " +
          "confirming applies caps, sets probation for severe events and recalculates the score, so it is " +
          "an adjudication a person makes, not a state the system should reach on its own.",
        consumers: ["services/trust/TrustScoreService.ts"],
      },
      {
        name: "dismissed",
        classification: "OPS_DRIVEN",
        terminal: true,
        manual: true,
        reason:
          "Two admin writers: dismissEvent (POST /admin/trust/events/:eventId/dismiss, the mirror of " +
          "confirm) and revokeModerationTrustConsequences, which dismisses every moderation-sourced event " +
          "in bulk when an account is restored. Nothing READS the literal 'dismissed' anywhere: the state " +
          "acts by EXCLUSION, because the scoring window selects `.in(\'status\', [\'applied\',\'confirmed\'])`. " +
          "That is why it has no consumer list — the absence is the mechanism.",
      },
    ],
    transitions: [
      {
        from: [],
        to: "applied",
        classification: "REACHABLE",
        writer: {
          file: "services/trust/TrustEventService.ts",
          evidence: ['(severity === "serious" || severity === "severe") ? "pending_review" : "applied";', '.from("trust_events")'],
        },
      },
      {
        from: [],
        to: "pending_review",
        classification: "REACHABLE",
        writer: {
          file: "services/trust/TrustEventService.ts",
          evidence: ['(severity === "serious" || severity === "severe") ? "pending_review" : "applied";', '.from("trust_events")'],
        },
      },
      {
        from: ["pending_review"],
        to: "confirmed",
        classification: "OPS_DRIVEN",
        writer: {
          file: "services/trust/TrustAdminService.ts",
          evidence: ['.update({ status: "confirmed", reviewed_by: adminId', '.eq("status", "pending_review")'],
        },
        reason:
          "Admin-only adjudication through routes/trust-admin.ts. Deliberately not automatic: it applies " +
          "caps, may set a 30-day probation and recalculates the user's score.",
      },
      {
        from: ["applied", "confirmed", "pending_review"],
        to: "dismissed",
        classification: "OPS_DRIVEN",
        writer: {
          file: "services/trust/TrustAdminService.ts",
          evidence: [
            "export async function revokeModerationTrustConsequences(",
            '.update({ status: "dismissed", reviewed_by: adminId',
          ],
        },
        reason:
          "The moderation-reversal path: when an admin restores an account, every moderation-sourced trust " +
          "event it carries is dismissed in bulk, its caps are lifted and probation is cleared, so a " +
          "reversed finding stops costing the user. Admin-only by construction and deliberately " +
          "non-throwing — a restore must not be blocked by trust bookkeeping.",
      },
      {
        from: ["pending_review"],
        to: "dismissed",
        classification: "OPS_DRIVEN",
        writer: {
          file: "services/trust/TrustAdminService.ts",
          evidence: ['.update({ status: "dismissed", reviewed_by: adminId', '.eq("status", "pending_review")'],
        },
        reason:
          "Admin-only adjudication through routes/trust-admin.ts, the mirror of confirm. A dismissed event " +
          "stays in the ledger as evidence and stops counting toward the score.",
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TRUST RESTRICTIONS — a derived lifecycle whose expiry sweep had no caller
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: "TRUST_RESTRICTION_LIFECYCLE",
    storage: "trust_restrictions",
    field: "(derived: lifted_at / expires_at)",
    vocabulary: {
      kind: "derived",
      file: "migrations/0043_trust_engine.sql",
      columns: ["lifted_at", "expires_at"],
      derivation:
        "lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now()) => active (enforced); " +
        "lifted_at IS NOT NULL with a lifted_by => lifted by an admin; lifted_at set by the sweep with no " +
        "lifted_by => expired. Enforcement reads the timestamps directly (getRestrictionState, " +
        "services/interactionPermissions.ts), which is why an expired row was never ENFORCED past its date " +
        "even before the sweep had a caller — it just kept showing as active in the admin view.",
      accessors: ["getRestrictionState"],
    },
    note:
      "Registered because it is the near-miss version of this defect and shows the check has teeth beyond " +
      "enums: expireOldRestrictions carried the comment 'call from cleanup job' and had NO caller, so the " +
      "`expired` state existed in the model and no writer produced it. lib/trustMaintenanceScheduler.ts now " +
      "calls it on every pass and is started from index.ts. If that call is removed, `expired` becomes " +
      "unreachable again and this entry's scheduler rule fails.",
    states: [
      {
        name: "active",
        classification: "OPS_DRIVEN",
        manual: true,
        reason:
          "applyRestriction has exactly one caller — TrustAdminService.adminApplyRestriction, behind POST " +
          "/admin/trust/users/:userId/restrict. No automatic path restricts a user: the trust engine lowers " +
          "scores and applies CAPS on its own, but a behavioural restriction (hosting, messaging, " +
          "private_plan_access, location_plan_join) is always an admin action with a logged reason.",
        consumers: ["services/trust/TrustRestrictionService.ts", "services/interactionPermissions.ts"],
      },
      {
        name: "lifted",
        classification: "OPS_DRIVEN",
        terminal: true,
        manual: true,
        reason:
          "liftRestriction / liftRestrictionsByType, reached from TrustAdminService.adminLiftRestriction " +
          "(POST /admin/trust/restrictions/:id/remove). Records lifted_by, which is what distinguishes an " +
          "admin lift from the sweep's expiry in the same column.",
        consumers: ["services/trust/TrustRestrictionService.ts"],
      },
      {
        name: "expired",
        classification: "REACHABLE",
        terminal: true,
      },
    ],
    transitions: [
      {
        from: [],
        to: "active",
        classification: "OPS_DRIVEN",
        writer: {
          file: "services/trust/TrustRestrictionService.ts",
          evidence: [
            '.from("trust_restrictions")',
            "export async function applyRestriction(",
            "expires_at:       input.expiresAt ?? null,",
          ],
        },
        reason:
          "Created only by an admin action through TrustAdminService.adminApplyRestriction, which also " +
          "writes a trust_admin_actions row with the reason. There is deliberately no automatic restrictor.",
      },
      {
        from: ["active"],
        to: "lifted",
        classification: "OPS_DRIVEN",
        writer: {
          file: "services/trust/TrustRestrictionService.ts",
          evidence: ['.update({ lifted_at: new Date().toISOString(), lifted_by: liftedBy })'],
        },
        reason:
          "Admin lift through POST /admin/trust/restrictions/:id/remove. Conditional on `.is('lifted_at', " +
          "null)` so a second lift of the same restriction changes nothing.",
      },
      {
        from: ["active"],
        to: "expired",
        classification: "REACHABLE",
        writer: {
          file: "services/trust/TrustRestrictionService.ts",
          evidence: ["export async function expireOldRestrictions(", '.lt("expires_at", new Date().toISOString())'],
        },
        scheduler: { starts: "startTrustMaintenanceScheduler", from: "index.ts" },
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TRUST PROFILES — a derived label, and the state that could not exist
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: "TRUST_PROFILE_PUBLIC_LEVEL",
    storage: "trust_profiles",
    field: "public_level",
    vocabulary: { kind: "sqlCheck", file: "migrations/0043_trust_engine.sql", anchor: "CHECK (public_level IN" },
    note:
      "The inverse failure of this registry's subject, and the reason vocabulary parity is enforced in BOTH " +
      "directions: CompassNotificationEngine used to branch on public_level === 'suspended', a value the " +
      "CHECK has never admitted, so the branch could never run. A state that the schema does not have is as " +
      "invisible as a state that nothing writes. Every one of the six labels here is produced by " +
      "scoreToLevel and persisted by recalculateTrustScore, so the machine itself is sound; that only 2 of " +
      "58 production users have a row at all is the emitter-coverage blocker, not a missing writer. Every transition here carries an empty `from`, and that is the truth about the writer rather than a shortcut: recalculateTrustScore rebuilds the whole row from the event ledger and upserts it without reading the previous public_level, so one recalculation can move a user between any two labels in either direction.",
    states: [
      { name: "new_traveler", classification: "REACHABLE" },
      { name: "building_trust", classification: "REACHABLE" },
      { name: "reliable_traveler", classification: "REACHABLE" },
      { name: "trusted_traveler", classification: "REACHABLE" },
      { name: "highly_trusted", classification: "REACHABLE" },
      { name: "city_trusted", classification: "REACHABLE" },
    ],
    transitions: [
      {
        from: [],
        to: "new_traveler",
        classification: "REACHABLE",
        writer: { file: "services/trust/TrustScoreService.ts", evidence: ['return "new_traveler";', '.from("trust_profiles").upsert({'] },
      },
      {
        from: [],
        to: "building_trust",
        classification: "REACHABLE",
        writer: { file: "services/trust/TrustScoreService.ts", evidence: ['if (score >= s.level_building_trust) return "building_trust";'] },
      },
      {
        from: [],
        to: "reliable_traveler",
        classification: "REACHABLE",
        writer: { file: "services/trust/TrustScoreService.ts", evidence: ['if (score >= s.level_reliable)       return "reliable_traveler";'] },
      },
      {
        from: [],
        to: "trusted_traveler",
        classification: "REACHABLE",
        writer: { file: "services/trust/TrustScoreService.ts", evidence: ['if (score >= s.level_trusted)        return "trusted_traveler";'] },
      },
      {
        from: [],
        to: "highly_trusted",
        classification: "REACHABLE",
        writer: { file: "services/trust/TrustScoreService.ts", evidence: ['if (score >= s.level_highly_trusted) return "highly_trusted";'] },
      },
      {
        from: [],
        to: "city_trusted",
        classification: "REACHABLE",
        writer: { file: "services/trust/TrustScoreService.ts", evidence: ['if (score >= s.level_city_trusted)   return "city_trusted";'] },
      },
    ],
  },
  // ══════════════════════════════════════════════════════════════════════════
  // RENT-A-BUDDY BOOKINGS — a lifecycle held OFF at the door, swept from inside
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: "RAB_BOOKING_STATUS",
    storage: "rent_buddy_bookings",
    field: "status",
    vocabulary: {
      kind: "pgEnum",
      file: "baseline/20260819_baseline_structure.sql",
      symbol: "public.rent_buddy_booking_status",
    },
    note:
      "Fourteen states, and the thing that makes them classifiable is a MEASUREMENT rather than a reading " +
      "of the code: `rent_buddy_enabled` is FALSE in production " +
      "(lib/capability/snapshots/20260908-production-schema.json, captured 2026-09-08, watermark " +
      "20260908073559). Migration 2210 forces it FALSE and says why — 0090 had forced it TRUE, so every " +
      "clean run and every restore left the master switch ON for a feature that is not launch-ready. So " +
      "every USER path into this lifecycle is a HOLD, not a gap: the writers are built, correct and " +
      "switched off by an owner's deliberate default.\n" +
      "\n" +
      "The interesting half is that the machine is NOT inert. rentBuddyRequestSweeper's phases 1-3 are " +
      "documented as ungated on purpose ('they govern already-created bookings and stay ungated as " +
      "before' — lib/rentBuddyRequestSweeper.ts:39-41) and the sweeper IS started from index.ts, so " +
      "`expired`, `completed` and `disputed` have a writer that runs today over whatever rows the period " +
      "when 0090 had the flag TRUE left behind. Those three are REACHABLE and the rest are HOLD, and " +
      "that difference is the entire point of classifying by the WRITER'S OWN gate rather than by whether " +
      "a row happens to exist: 'nothing is in this state' has four different causes here and they need " +
      "four different people.\n" +
      "\n" +
      "Two states are neither. `cancelled` is written ONLY by admin dispute resolution " +
      "(rentABuddySpec.ts, `profiles.role === 'admin'`), which is exempt from the master switch by design " +
      "— an admin queue that hides its rows cannot moderate them — so it is OPS_DRIVEN. `confirmed` has " +
      "no producer anywhere and is DECLARED_UNUSED: lib/rentBuddyBookingStatus.ts already records that " +
      "the accept route writes `scheduled`, and rentABuddy.ts:4463 records a counter that sat pinned at " +
      "zero because it filtered on `confirmed`. Deleting it is a schema decision about rows that may " +
      "already carry it, not a code change.",
    states: [
      {
        name: "requested",
        classification: "HOLD",
        reason:
          "The canonical creation route POST /rent-a-buddy/bookings writes it, and every creation path " +
          "clears the master switch first — three call requireRentBuddyEnabled directly, the other two " +
          "reach it as step 1 of checkRentBuddyAccess (rentABuddyRollout.ts:242). 2210 seeds " +
          "rent_buddy_enabled FALSE and the production snapshot measures it FALSE, so no new booking is " +
          "created at all while the switch is off. Nothing is owed by engineering; the flag is an owner's " +
          "launch decision gated on KYC, payments, safety and moderation being ready.",
        hold: {
          flag: "rent_buddy_enabled",
          seededFalseIn: "src/migrations/2210_rent_buddy_default_off.sql",
          readBy: "routes/rentABuddy.ts",
        },
      },
      {
        name: "pending",
        classification: "HOLD",
        reason:
          "The second, older creation label. migrations/0113_rent_buddy_lifecycle_fixes.sql:17-21 says the " +
          "spec requires `requested` on creation and that `pending` is kept for backward compatibility, " +
          "and four creation paths (offer-accept, package-book, the spec request route, rebook) still " +
          "write it. All of them are behind the same master switch, measured FALSE in production, so this " +
          "is the same hold as `requested` and not a separate one.",
        hold: {
          flag: "rent_buddy_enabled",
          seededFalseIn: "src/migrations/2210_rent_buddy_default_off.sql",
          readBy: "routes/rentABuddy.ts",
        },
      },
      {
        name: "scheduled",
        classification: "HOLD",
        reason:
          "Written by the buddy's accept route, which takes requireRentBuddyEnabled. It is the POST-ACCEPT " +
          "half of the mismatch lib/rentBuddyBookingStatus.ts documents: guards used to list `confirmed` " +
          "here, which no route writes, so a booking that HAD been accepted still failed every " +
          "accepted-state test. The state is sound; only the switch holds it.",
        hold: {
          flag: "rent_buddy_enabled",
          seededFalseIn: "src/migrations/2210_rent_buddy_default_off.sql",
          readBy: "routes/rentABuddy.ts",
        },
      },
      {
        name: "confirmed",
        classification: "DECLARED_UNUSED",
        reason:
          "No producer in TS, in SQL or in a trigger: the accept route writes `scheduled`, and " +
          "rentABuddy.ts:4463 carries the epitaph — a buddy dashboard counter filtered on " +
          "`.eq(\"status\",\"confirmed\")` and was therefore pinned at 0 for every buddy, forever. It is " +
          "READ in five places, and not one of them is starved, because every set that admits it also " +
          "admits `scheduled`, which IS written: ACCEPTED_STATUSES, THREAD_ALLOWED_STATUSES, the wall's " +
          "ENGAGED_BOOKING_STATUSES (with in_progress/completed), PassportProjectionService's relationship " +
          "probe (with completed/in_progress) and interactionPermissions' pre-booking window (with " +
          "requested/pending/scheduled). It is retained deliberately for rows that may already carry it — " +
          "removing the label is a schema decision about existing data, not an engineering task.",
        consumers: [
          "lib/rentBuddyBookingStatus.ts",
          "routes/rentABuddy.ts",
          "services/wall/WallCandidateLoaders.ts",
          "services/passport/PassportProjectionService.ts",
          "services/interactionPermissions.ts",
        ],
      },
      {
        name: "in_progress",
        classification: "HOLD",
        reason:
          "The buddy starts the session (POST /rent-a-buddy/bookings/:id/start), behind " +
          "requireRentBuddyEnabled, and only from `confirmed`/`scheduled` — both of which are themselves " +
          "behind the same switch. Held, not missing: the route is complete and refuses correctly.",
        hold: {
          flag: "rent_buddy_enabled",
          seededFalseIn: "src/migrations/2210_rent_buddy_default_off.sql",
          readBy: "routes/rentABuddy.ts",
        },
      },
      {
        name: "completed_pending_traveler_confirmation",
        classification: "HOLD",
        reason:
          "Written when the BUDDY marks the session complete, which opens a 24-hour dispute window before " +
          "the money settles. Behind requireRentBuddyEnabled. The state is the reason the sweeper's phase " +
          "2 exists at all, and lib/rentBuddyBookingStatus.ts records that THREAD_ALLOWED_STATUSES used to " +
          "omit it — the two parties were refused a chat thread at exactly the moment they most needed one.",
        hold: {
          flag: "rent_buddy_enabled",
          seededFalseIn: "src/migrations/2210_rent_buddy_default_off.sql",
          readBy: "routes/rentABuddy.ts",
        },
      },
      { name: "completed", classification: "REACHABLE", terminal: true },
      { name: "expired", classification: "REACHABLE", terminal: true },
      {
        name: "declined",
        classification: "HOLD",
        terminal: true,
        reason:
          "The buddy's refusal of a request, from `requested`/`pending` only, behind " +
          "requireRentBuddyEnabled. Terminal by design — a declined request is re-made, not revived — and " +
          "held only by the master switch measured FALSE in production.",
        hold: {
          flag: "rent_buddy_enabled",
          seededFalseIn: "src/migrations/2210_rent_buddy_default_off.sql",
          readBy: "routes/rentABuddy.ts",
        },
      },
      {
        name: "cancelled",
        classification: "OPS_DRIVEN",
        terminal: true,
        manual: true,
        reason:
          "Bare `cancelled` is NOT what the cancel route writes — that writes `cancelled_by_traveler` or " +
          "`cancelled_by_buddy`. Its one producer is admin dispute resolution in rentABuddySpec.ts " +
          "(`favorTraveler === true ? \"cancelled\" : \"completed\"`, behind a profiles.role admin check), " +
          "which is deliberately exempt from the master switch because an admin queue that hides its rows " +
          "cannot moderate them. rentABuddyRollout.ts:50-57 records what that distinction cost: the " +
          "cancel-rate metric counted only bare `cancelled`, so it read ~zero and the graduation gate was " +
          "falsely lenient.",
      },
      {
        name: "cancelled_by_traveler",
        classification: "HOLD",
        terminal: true,
        reason:
          "Written by POST /rent-a-buddy/bookings/:id/cancel when the traveller is the actor, behind " +
          "requireRentBuddyEnabled. Kept distinct from the buddy's label on purpose: the two carry " +
          "different trust events and only the buddy's counts against buddy reliability, so collapsing " +
          "them would charge people for something they did not do.",
        hold: {
          flag: "rent_buddy_enabled",
          seededFalseIn: "src/migrations/2210_rent_buddy_default_off.sql",
          readBy: "routes/rentABuddy.ts",
        },
      },
      {
        name: "cancelled_by_buddy",
        classification: "HOLD",
        terminal: true,
        reason:
          "The same route with the buddy as actor; additionally increments the buddy's cancel_count. " +
          "Behind requireRentBuddyEnabled, which the production snapshot measures FALSE — so like its " +
          "sibling it is switched off, not unwritten.",
        hold: {
          flag: "rent_buddy_enabled",
          seededFalseIn: "src/migrations/2210_rent_buddy_default_off.sql",
          readBy: "routes/rentABuddy.ts",
        },
      },
      { name: "disputed", classification: "REACHABLE" },
      {
        name: "no_show_pending",
        classification: "HOLD",
        reason:
          "A reported no-show inside its two-hour grace period, written by the no-show routes in both " +
          "rentABuddy.ts and rentABuddySpec.ts, each behind requireRentBuddyEnabled. It is the only state " +
          "here whose EXIT is automatic — the sweeper escalates it to `disputed` — so a hold on the " +
          "entrance is what keeps the ungated exit with nothing to do.",
        hold: {
          flag: "rent_buddy_enabled",
          seededFalseIn: "src/migrations/2210_rent_buddy_default_off.sql",
          readBy: "routes/rentABuddy.ts",
        },
      },
    ],
    transitions: [
      {
        from: [],
        to: "requested",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddy.ts",
          evidence: [
            'status: "requested",\n      safety_status: "normal",',
            'to_status: "requested",',
          ],
        },
        reason:
          "POST /rent-a-buddy/bookings, gated by requireRentBuddyEnabled on `rent_buddy_enabled`, which " +
          "2210 seeds FALSE and the 2026-09-08 production snapshot measures FALSE. The route is complete " +
          "and writes a booking event; it simply never runs while the lane is dark.",
      },
      {
        from: [],
        to: "pending",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddyMarketplace.ts",
          evidence: ['.from("rent_buddy_bookings")', 'status: "pending",\n      offer_id: offerId,'],
        },
        reason:
          "POST /rent-a-buddy/offers/:offerId/accept creates the booking from an accepted offer. It takes " +
          "the master switch through checkRentBuddyAccess step 1 rather than requireRentBuddyEnabled " +
          "directly, which is the same gate on the same flag — the comment at rentABuddyMarketplace.ts:" +
          "1184-1191 records that this path previously had NO gates at all.",
      },
      {
        from: ["requested", "pending"],
        to: "scheduled",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddy.ts",
          evidence: ['.update({ status: "scheduled", confirmed_at: now, updated_at: now })'],
        },
        reason:
          "The buddy's accept, behind requireRentBuddyEnabled. Refuses anything but requested/pending and " +
          "refuses a request past its 48-hour expires_at, so it cannot resurrect an expired one.",
      },
      {
        from: ["requested", "pending"],
        to: "declined",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddy.ts",
          evidence: ['.update({ status: "declined", decline_reason: decline_reason ?? null, updated_at: now })'],
        },
        reason:
          "The buddy's refusal, behind requireRentBuddyEnabled, from requested/pending only. Also records " +
          "the responsiveness signal — a decline answers the traveller just as an accept does.",
      },
      {
        from: ["requested", "pending"],
        to: "expired",
        classification: "REACHABLE",
        writer: {
          file: "lib/rentBuddyRequestSweeper.ts",
          evidence: [
            '.update({ status: "expired", updated_at: now })\n      .in("id", ids)\n' +
              '      .in("status", [...AWAITING_BUDDY_STATUSES])',
          ],
        },
        scheduler: { starts: "startBuddyRequestSweeper", from: "index.ts" },
      },
      {
        from: ["scheduled", "confirmed"],
        to: "in_progress",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddy.ts",
          evidence: ['.update({ status: "in_progress", started_at: now, updated_at: now })'],
        },
        reason:
          "The buddy confirms the meetup started, behind requireRentBuddyEnabled. `confirmed` is listed as " +
          "a source because the route really does admit it for legacy rows, even though nothing writes it " +
          "any more — the guard and the producer disagree, and this records which side is which.",
      },
      {
        from: ["in_progress"],
        to: "completed_pending_traveler_confirmation",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddy.ts",
          evidence: ['const finalStatus = isBuddyCompleting ? "completed_pending_traveler_confirmation" : "completed";'],
        },
        reason:
          "POST /rent-a-buddy/bookings/:id/complete when the BUDDY is completing, behind " +
          "requireRentBuddyEnabled; opens the 24-hour dispute window. Held by the master switch, like " +
          "every other party-driven transition in this lane.",
      },
      {
        from: ["in_progress"],
        to: "completed",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddy.ts",
          evidence: ['const finalStatus = isBuddyCompleting ? "completed_pending_traveler_confirmation" : "completed";'],
        },
        reason:
          "The same statement's other branch: a TRAVELLER completing goes straight to `completed` with no " +
          "dispute window, which is the backward-compatible path. Behind requireRentBuddyEnabled.",
      },
      {
        from: ["completed_pending_traveler_confirmation"],
        to: "completed",
        classification: "REACHABLE",
        writer: {
          file: "lib/rentBuddyRequestSweeper.ts",
          evidence: [
            '.update({ status: "completed", updated_at: now })',
            '.eq("status", "completed_pending_traveler_confirmation")',
          ],
        },
        scheduler: { starts: "startBuddyRequestSweeper", from: "index.ts" },
      },
      {
        from: ["completed_pending_traveler_confirmation"],
        to: "completed",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddy.ts",
          evidence: ['.update({ status: "completed", updated_at: now })', 'event: "traveler_confirmed",'],
        },
        reason:
          "POST /rent-a-buddy/bookings/:id/traveler-confirm — the traveller closing the dispute window " +
          "early — behind requireRentBuddyEnabled. Registered alongside the sweeper's ungated route into " +
          "the same state precisely because they have different gates: the state is REACHABLE on the " +
          "strength of the sweeper, and this transition is not.",
      },
      {
        from: ["requested", "pending", "scheduled", "confirmed"],
        to: "cancelled_by_traveler",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddy.ts",
          evidence: ['const cancelStatus = isTravelerCancel ? "cancelled_by_traveler" : "cancelled_by_buddy";'],
        },
        reason:
          "POST /rent-a-buddy/bookings/:id/cancel with the traveller as actor, behind " +
          "requireRentBuddyEnabled. Its from-set is CANCELLABLE_STATUSES, which had to be widened to " +
          "include `requested` — until then the booking the canonical route creates could not be " +
          "cancelled by either party until the buddy had accepted it.",
      },
      {
        from: ["requested", "pending", "scheduled", "confirmed"],
        to: "cancelled_by_buddy",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddy.ts",
          evidence: ['const cancelStatus = isTravelerCancel ? "cancelled_by_traveler" : "cancelled_by_buddy";'],
        },
        reason:
          "The same route with the buddy as actor, behind requireRentBuddyEnabled; additionally " +
          "increments the buddy's cancel_count, which is why the two labels are not one label.",
      },
      {
        from: ["scheduled", "confirmed", "in_progress"],
        to: "no_show_pending",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddy.ts",
          evidence: ['.update({ status: "no_show_pending", no_show_grace_expires_at: graceExpiry, updated_at: now })'],
        },
        reason:
          "Either party reports a no-show, behind requireRentBuddyEnabled; enters a two-hour grace period " +
          "rather than opening a dispute at once, so the other party can answer first. Mirrored by the " +
          "same guard in rentABuddySpec.ts.",
      },
      {
        from: ["no_show_pending"],
        to: "disputed",
        classification: "REACHABLE",
        writer: {
          file: "lib/rentBuddyRequestSweeper.ts",
          evidence: ['.update({ status: "disputed", updated_at: now })', '.eq("status", "no_show_pending")'],
        },
        scheduler: { starts: "startBuddyRequestSweeper", from: "index.ts" },
      },
      {
        from: ["in_progress", "completed_pending_traveler_confirmation"],
        to: "disputed",
        classification: "HOLD",
        writer: {
          file: "routes/rentABuddy.ts",
          evidence: ['.update({ status: "disputed", updated_at: now })', 'event: "dispute_opened",'],
        },
        reason:
          "Either party files a dispute, behind requireRentBuddyEnabled. Deliberately refuses `completed` " +
          "and the cancelled labels — disputing a terminal booking would corrupt the final state — and " +
          "refuses once the dispute window on a completed_pending_traveler_confirmation booking has closed.",
      },
      {
        from: ["disputed"],
        to: "cancelled",
        classification: "OPS_DRIVEN",
        writer: {
          file: "routes/rentABuddySpec.ts",
          evidence: [
            'const newBookingStatus = favorTraveler === true ? "cancelled" : "completed";',
            ".update({ status: newBookingStatus, updated_at: new Date().toISOString() })",
          ],
        },
        reason:
          "Admin dispute resolution in favour of the traveller. Gated on profiles.role === 'admin' and " +
          "exempt from the master switch by the lane's stated rule — an admin queue that hides its rows " +
          "cannot moderate them, and disputes outlive a flag flip. It also compensates the buddy's " +
          "completed_count, but only when the booking really passed through mark-complete.",
      },
      {
        from: ["disputed"],
        to: "completed",
        classification: "OPS_DRIVEN",
        writer: {
          file: "routes/rentABuddySpec.ts",
          evidence: [
            'const newBookingStatus = favorTraveler === true ? "cancelled" : "completed";',
            ".update({ status: newBookingStatus, updated_at: new Date().toISOString() })",
          ],
        },
        reason:
          "The same admin adjudication resolving against the traveller. Registered separately from the " +
          "sweeper's route into `completed` because they are different powers: this one is a person's " +
          "decision on a contested booking, the sweeper's is a clock running out.",
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SAFE RETURN SESSIONS — the counter-measurement: a flag the SNAPSHOT says is ON
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: "SAFE_RETURN_SESSION_STATUS",
    storage: "safe_return_sessions",
    field: "status",
    vocabulary: {
      kind: "sqlCheck",
      file: "src/migrations/0167_safety_ddl_reconcile.sql",
      anchor: "CHECK (status IN ('pending', 'active', 'safe'",
    },
    note:
      "Registered as the CORRECTION this registry has to be able to make. Read only the code, this looks " +
      "exactly like the Rent-a-Buddy hold: every route in routes/safeReturn.ts refuses unless " +
      "`safe_return_enabled` is on, and BOTH migrations that seed that flag " +
      "(src/migrations/0037_feature_flags.sql:46, src/migrations/0166_feature_flags_reconcile.sql:16) " +
      "seed it FALSE. Classifying from that alone gives five HOLD states and a false report. The " +
      "production snapshot says otherwise: `safe_return_enabled` is TRUE " +
      "(lib/capability/snapshots/20260908-production-schema.json), and " +
      "docs/architecture/on-and-dead-flag-matrix.md carries it as an ON flag retired from the ON-and-dead " +
      "list on 2026-09-08 when 2219 supplied its missing schema. A seeded default is what a fresh " +
      "database starts with, not what production is; ON CONFLICT DO NOTHING means an operator's later " +
      "enable is exactly what those migrations are written to preserve. So every state here is " +
      "REACHABLE, and HOLD would have been the tidier-looking lie.\n" +
      "\n" +
      "The class-B defect the same page records — routes/safeReturn.ts reaching " +
      "PassportProjectionService's locate-friends read without gating on `locate_friends_enabled` — is " +
      "real and still owed, but it is a read crossing a feature boundary, not a state with no writer, so " +
      "it is not this registry's finding to carry.",
    states: [
      { name: "pending", classification: "REACHABLE" },
      { name: "active", classification: "REACHABLE" },
      { name: "safe", classification: "REACHABLE", terminal: true },
      { name: "missed", classification: "REACHABLE" },
      { name: "cancelled", classification: "REACHABLE", terminal: true },
    ],
    transitions: [
      {
        from: [],
        to: "pending",
        classification: "REACHABLE",
        writer: {
          file: "services/safeReturn/SafeReturnService.ts",
          evidence: [
            '.from("safe_return_sessions")\n      .insert({',
            "export async function createSession(",
          ],
          columnDefault: { file: "src/migrations/0167_safety_ddl_reconcile.sql", column: "status" },
        },
      },
      {
        from: ["pending"],
        to: "active",
        classification: "REACHABLE",
        writer: {
          file: "services/safeReturn/SafeReturnService.ts",
          evidence: ['.update({ status: "active", timer_start_at: now, updated_at: now })'],
        },
      },
      {
        from: ["active", "missed"],
        to: "active",
        classification: "REACHABLE",
        writer: {
          file: "services/safeReturn/SafeReturnService.ts",
          evidence: ['.update({ timer_end_at: newEnd, status: "active", updated_at: now })'],
        },
      },
      {
        from: ["pending", "active", "missed"],
        to: "safe",
        classification: "REACHABLE",
        writer: {
          file: "services/safeReturn/SafeReturnService.ts",
          evidence: ['status: "safe",', '.in("status", ["active", "missed", "pending"])'],
        },
      },
      {
        from: ["pending", "active"],
        to: "cancelled",
        classification: "REACHABLE",
        writer: {
          file: "services/safeReturn/SafeReturnService.ts",
          evidence: ['.update({ status: "cancelled", closed_at: now, updated_at: now })'],
        },
      },
      {
        from: ["active"],
        to: "missed",
        classification: "REACHABLE",
        writer: {
          file: "services/safeReturn/SafeReturnService.ts",
          evidence: ['.update({ status: "missed", last_prompt_at: now, updated_at: now })'],
        },
        scheduler: { starts: "startSafeReturnScheduler", from: "index.ts" },
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SAFE RETURN LIVE SHARES — three states, one of them written by the schema
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: "SAFE_RETURN_LIVE_SHARE_STATUS",
    storage: "safe_return_live_shares",
    field: "status",
    vocabulary: {
      kind: "sqlCheck",
      file: "src/migrations/0167_safety_ddl_reconcile.sql",
      anchor: "CHECK (status IN ('active', 'stopped'",
    },
    note:
      "Small, complete, and worth registering for one reason: `active` is written by NOBODY in " +
      "TypeScript. startShare inserts session_id, user_id, the recipient and expires_at, and the row is " +
      "`active` because the column says so. The only text in that service naming 'active' as the initial " +
      "state is a comment — so the ordinary evidence rule ('cite a line that names the state') can be " +
      "satisfied here ONLY by citing prose, which is precisely the substitution this whole lane exists " +
      "to refuse. The registry says `columnDefault` instead and the checker verifies the DEFAULT inside " +
      "the right CREATE TABLE, which matters here because `DEFAULT 'active'` on a `status` column occurs " +
      "twice in 0167 and the file-wide match would let either table vouch for the other. Both flags " +
      "involved (`safe_return_enabled`, `safe_return_live_share_enabled`) are measured TRUE in the " +
      "2026-09-08 production snapshot, so all three states are genuinely reachable.",
    states: [
      { name: "active", classification: "REACHABLE" },
      { name: "stopped", classification: "REACHABLE", terminal: true },
      { name: "expired", classification: "REACHABLE", terminal: true },
    ],
    transitions: [
      {
        from: [],
        to: "active",
        classification: "REACHABLE",
        writer: {
          file: "services/safeReturn/SafeReturnLiveShareService.ts",
          evidence: [
            '.from("safe_return_live_shares")\n      .insert({',
            "export async function startShare(",
          ],
          columnDefault: { file: "src/migrations/0167_safety_ddl_reconcile.sql", column: "status" },
        },
      },
      {
        from: ["active"],
        to: "stopped",
        classification: "REACHABLE",
        writer: {
          file: "services/safeReturn/SafeReturnLiveShareService.ts",
          evidence: ['.update({ status: "stopped", stopped_at: now })'],
        },
      },
      {
        from: ["active"],
        to: "expired",
        classification: "REACHABLE",
        writer: {
          file: "services/safeReturn/SafeReturnLiveShareService.ts",
          evidence: ['.update({ status: "expired" })'],
        },
        scheduler: { starts: "startSafeReturnScheduler", from: "index.ts" },
      },
    ],
  },
];

export function machineFor(storage: string, field: string): StateMachineEntry | null {
  return STATE_MACHINES.find((m) => m.storage === storage && m.field === field) ?? null;
}

/** Terminal / manual / owner-blocked / hold, as the report prints them. */
export function summarize(m: StateMachineEntry): {
  terminal: string[];
  manual: string[];
  ownerBlocked: string[];
  hold: string[];
} {
  return {
    terminal: m.states.filter((s) => s.terminal).map((s) => s.name),
    manual: m.states.filter((s) => s.manual).map((s) => s.name),
    ownerBlocked: m.states.filter((s) => s.classification === "OWNER_BLOCKED").map((s) => s.name),
    hold: m.states.filter((s) => s.classification === "HOLD").map((s) => s.name),
  };
}
