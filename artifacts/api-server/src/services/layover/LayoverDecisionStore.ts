/**
 * LayoverDecisionStore — the persistence half of §20's decision record and of
 * §4's `layover_time_budgets` and `layover_return_plans`.
 *
 * ── THREE OF MIGRATION 2992'S FIVE TABLES HAVE NO WRITER, AND THAT IS STATED
 *    HERE RATHER THAN LEFT TO BE DISCOVERED ─────────────────────────────────
 * 2992 creates `layover_constraints` (L22), `layover_checkpoints` (L30) and
 * `layover_outcomes` (L32). NOTHING IN THIS MODULE WRITES ANY OF THEM, and
 * nothing anywhere else does either.
 *
 * That is not an oversight, it is what those three rows actually need. Each is
 * fed by an INPUT this tree does not have:
 *
 *   `layover_constraints`  L22's eleven fields are DECLARED by the traveller —
 *                          terminals, baggage mode, entry permission. There is
 *                          no surface that asks, and §12.1's clarifying-question
 *                          loop (L114) is itself NOT-BUILT. A writer would have
 *                          nothing but defaults to store.
 *   `layover_checkpoints`  L30 needs an observation. L173's `recordCheckpoint`
 *                          has no caller and no route.
 *   `layover_outcomes`     L32 needs a session to COMPLETE, and `status =
 *                          'completed'` still has no writer (L33). An outcome
 *                          row written for a session nothing ever completes
 *                          would be a row about an event that did not happen.
 *
 * So the tables exist and are empty, deliberately, the same way 2700 shipped
 * its table without a writer and said so. A table with no writer is visible to
 * `check:writerless-reads`; a table with a writer that invents its contents is
 * not visible to anything.
 *
 * ── WHAT WAS ALREADY BUILT, AND WHAT WAS MISSING ────────────────────────────
 * Almost all of it was built. `services/airport/LayoverFeasibility.ts` produces
 * one `LayoverFeasibilityRecord` per session per instant and
 * `replayFeasibility(record.inputs)` reproduces it deep-equal;
 * `services/airport/layoverLedger.ts` projects that onto a §20 `DecisionRecord`
 * with `inputFacts[]`, `sourceRefs[]` and `rulesApplied[]`, mints the snapshot
 * identity with `snapshotIdFor`, decides bounded retention with
 * `compactLedger` and refuses a rewrite with `assertSnapshotImmutable`.
 *
 * NONE OF IT HAD A CALLER. Before this module, `ledgerRowFor` was imported by
 * exactly one file and that file was its own test; `compactLedger`'s header
 * says so in as many words — *"The DELETE is a caller's business and there is
 * no caller yet."* census-layover scores the consequences across L5 ("Nothing
 * can be replayed"), L95 ("Create a new immutable snapshot" — `(L25)`), L190
 * ("No snapshots"), L206/L207 and L209 ("Nothing is certified to count").
 *
 * So this module adds no arithmetic and no judgement. It is a writer and three
 * readers. Every number it stores is read off a record the engine certified,
 * and the one derivation it performs — `riskBandFor` — is a RELABELLING with no
 * threshold of its own, argued below.
 *
 * ── THE FLAG IS LOAD-BEARING, NOT CEREMONY ──────────────────────────────────
 * supabase-js sends EVERY key of an insert payload, so a writer that names a
 * column fails the whole statement on any database that has not run migration
 * 2992. That is the hazard migration 2700's header records and migration 2410
 * gates behind a flag, and it is why nothing here writes until
 * `layover_decision_persistence_enabled` is TRUE.
 *
 * `isFlagEnabled` reads an ABSENT row as FALSE (`lib/featureFlags.ts`), so the
 * flag needs no seeding migration and a database that has never heard of it is
 * a database this module does not write to. 2992 seeds nothing for exactly
 * that reason.
 *
 * A DISABLED FLAG IS A REFUSAL, NOT A SUCCESS. `persistDecision` returns
 * `{ ok: false, reason: "persistence_disabled" }` rather than a cheerful
 * no-op, because a caller that cannot tell "stored" from "deliberately not
 * stored" will report a snapshot id nothing can resolve.
 *
 * ── EVERY READ REFUSES RATHER THAN RETURNING AN EMPTY HISTORY ───────────────
 * The same rule `LayoverCrewStore` states and census §23.1 found broken four
 * times on this domain: supabase-js RESOLVES on a database error, so an
 * unguarded read turns an outage into a confident statement about the world.
 *
 * It is worse for a decision record than for a list. "Nothing certified this"
 * and "we could not read what certified this" produce the same screen, and the
 * traveller who believes the first one is being told their deadline came from
 * nowhere. None of the reads below returns `[]` or `null` on an error.
 *
 * ── A PARTIAL WRITE IS `write_unconfirmed`, NEVER SUCCESS ───────────────────
 * One decision is four rows across three tables: the computation, its time
 * budget, its return plan and (when the caller states one) its constraint set.
 * There is no transaction across a PostgREST client, so the ORDER is the whole
 * design, and it is the same ordering `services/highlights/highlightSources.ts`
 * uses: the failure that can still be undone happens first.
 *
 *   1. the PARENT computation, whose unique index on (session_id, input_hash)
 *      is what makes a double-tapped dashboard one row and not two;
 *   2. then the children, which are meaningless without it.
 *
 * A child that fails leaves a parent with no budget — legible, because the
 * reader returns `null` for a missing child and the result says
 * `write_unconfirmed`. The reverse order would leave a budget citing a
 * computation that does not exist, which nothing could detect.
 *
 * ── STORAGE ─────────────────────────────────────────────────────────────────
 * `layover_certified_computations` (migration 2700, plus 2992's five §20
 * columns), and `layover_time_budgets` / `layover_return_plans` (2992). Those
 * three are the only tables this module touches; see the note above about the
 * other two 2992 creates.
 *
 * NEITHER MIGRATION IS APPLIED TO PRODUCTION at the time of writing. 2700 does
 * not appear in `src/lib/capability/production-applied-migrations.json` and
 * 2992 was authored on this branch. 2992's header states the exact deployment
 * sequence; this module is step 5's precondition, not its trigger, and it
 * applies nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import {
  decisionRecordFor,
  ledgerRowFor,
  snapshotIdFor,
  assertSnapshotImmutable,
  LAYOVER_LEDGER_VERSION,
  type DecisionRecord,
} from "../../services/airport/layoverLedger.js";
import {
  replayFeasibility,
  type FeasibilityInputs,
  type LayoverFeasibilityRecord,
} from "../../services/airport/LayoverFeasibility.js";

const logger = rootLogger.child({ service: "LayoverDecisionStore" });

/**
 * NOTE FOR ANYONE TIDYING THIS UP: the `.from(...)` call sites below write the
 * table name as a STRING LITERAL rather than using these constants, and
 * replacing them with the constants would be a regression.
 *
 * `check:write-path-columns` resolves a write site only when it can see
 * `.from("<literal>")` in the AST. `.from(CONSTANT)` is a `dynamic table name`
 * blind spot: the check cannot tell which table the payload belongs to, so it
 * cannot diff those columns against the live schema — which is the whole
 * failure class it exists to catch, and the exact failure class this module
 * would hit first, because its columns are the ones 2992 has not applied.
 * These stay exported because the tests import them.
 */
export const CERTIFIED_COMPUTATION_TABLE = "layover_certified_computations";
export const TIME_BUDGET_TABLE = "layover_time_budgets";
export const RETURN_PLAN_TABLE = "layover_return_plans";

/** FALSE by absence. See the header. */
export const DECISION_PERSISTENCE_FLAG = "layover_decision_persistence_enabled";

/**
 * PostgreSQL's unique-violation SQLSTATE. A collision on
 * (session_id, input_hash) means the identical computation is already stored,
 * which is the unique index doing its job and is SUCCESS, not failure.
 */
const UNIQUE_VIOLATION = "23505";

// ── the risk band ────────────────────────────────────────────────────────────

export const RISK_BANDS = ["LOW", "MODERATE", "HIGH", "UNSAFE"] as const;
export type RiskBand = (typeof RISK_BANDS)[number];

/**
 * §4.1 L36 `RiskBand`, from the engine's own published figures.
 *
 * ── THIS IS A RELABELLING AND NOT A SECOND SAFETY ANSWER ────────────────────
 * It introduces NO threshold, reads NO clock and performs NO arithmetic. Every
 * branch returns a constant chosen by a value `certifyFeasibility` already
 * published. That matters because census L1/L2 score a second feasibility
 * judgement as a defect wherever it appears, and §29.1 declined to build one on
 * an endpoint for the same reason.
 *
 * ── `null` MEANS NOT ASSESSED, AND IT IS THE POINT OF THIS FUNCTION ─────────
 * L36's divergence is exact: the tree's fourth `SafetyRating` value,
 * `airport_only`, *"encodes a user PREFERENCE, not a risk level"*. The engine
 * agrees — `stay_airside` is returned from `if (!session.wantsToLeave)` and
 * from nowhere else (`LayoverSafetyEngine.ts`), BEFORE any window is consulted.
 * A traveller who ticked "I'll stay at the airport" is not in a low-risk
 * layover; they are in a layover nobody assessed for leaving.
 *
 * All FOUR of the spec's bands are ASSESSMENTS. None of them means "nobody
 * looked". So this function returns `null` for that case and
 * `layover_return_plans.risk_band` is nullable to hold it.
 *
 * AN EARLIER DRAFT READ `windowOnly.rating` HERE INSTEAD, on the reasoning
 * that it is *"the session's answer WITH NO JOURNEY IN IT"* and therefore
 * preference-free. THAT WAS WRONG AND A MUTATION FOUND IT: `windowOnly.rating`
 * is `airport_only` for EVERY `stay_airside` session — measured at 2h, 3h, 4h,
 * 6h, 9h and 14h — because the preference is applied before that rating too.
 * The branch was dead, it always produced one constant, and a mutation
 * replacing the whole lookup with that constant kept the suite green. Recorded
 * rather than quietly rewritten, because "read the preference-free rating"
 * sounds correct and is the obvious thing for the next person to try.
 *
 * ── WHY A TEMPORAL CONFLICT IS `UNSAFE` EVEN FOR A STAY-AIRSIDE TRAVELLER ───
 * `temporalConflict` is non-null exactly when there is NO WINDOW AT ALL: the
 * buffers (or the cutoff itself) leave nothing, and `shortfallMinutes` says by
 * how much. That arithmetic does not consult `wantsToLeave` at any point, so it
 * IS an assessment and it applies to everyone. It is checked first for that
 * reason: a traveller with no window is in trouble whatever they ticked, and
 * UNSAFE is the only band whose consequence (block) is correct for it.
 */
export function riskBandFor(record: LayoverFeasibilityRecord): RiskBand | null {
  // Assessed from the window, which never reads the preference. First, so it
  // cannot be masked by the `null` below.
  if (record.envelope.temporalConflict !== null) return "UNSAFE";

  switch (record.verdict) {
    case "yes":
      return "LOW";
    case "tight":
      return "MODERATE";
    // ADDED AT INTEGRATION, 2026-09-23. `entry_unverified` reached this union
    // from the entry gate (census-layover §45) while this function was being
    // written in another lane, so neither lane ever saw the pair. The compiler
    // caught it on the merge: the switch stopped being exhaustive.
    //
    // MODERATE, which is the band `tight` gets, because that is the tier the
    // two surfaces that already rule on this verdict put it in, and they say so
    // in as many words — `LayoverFeasibility.ts`'s VERDICT_CEILING maps it to
    // `possible_but_risky` "the same band `LayoverCompassService.riskBand`
    // gives it, so the two surfaces agree by construction rather than by
    // coincidence", and `LayoverCompassService.riskBand` maps it likewise as
    // "the risky band, not the refused one". This is the third surface; it
    // agrees by construction too.
    //
    // NOT `UNSAFE`: that band's consequence is BLOCKED (L50's invariant below),
    // and `LayoverSnapshot`'s exhaustive `forbidden` test rules deliberately
    // that `entry_unverified` is NOT forbidden — "we could not check" is not
    // "you may not go", and every corridor is unconfirmed until one is curated.
    // NOT `null`: that slot is for `stay_airside`, which is a PREFERENCE and
    // therefore not assessed at all. An unconfirmed border IS an assessment.
    case "entry_unverified":
      return "MODERATE";
    case "no":
      return "UNSAFE";
    case "stay_airside":
      // NOT ASSESSED. See above. Returning a band here would put a preference
      // in the risk column and make L50's invariant (`risk_band == UNSAFE =>
      // status = BLOCKED`) fire on a tick-box.
      return null;
  }
}

// ── rows ─────────────────────────────────────────────────────────────────────

/**
 * The FULL insert payload for `layover_certified_computations`, post-2992.
 *
 * `ledgerRowFor` is deliberately NOT changed and NOT replaced. Its own header
 * explains why it omits five columns — *"naming a column the database does not
 * have fails the whole insert"* — and its test asserts that omission, which is
 * what stops someone "completing" it and breaking every write on a pre-2992
 * database. That test still passes and must.
 *
 * So there are two payloads and the FLAG chooses between them: the narrow one
 * for a database that has not run 2992 (which, because the flag is off there,
 * is never sent at all), and this one, which is only ever built inside a
 * flag-true branch.
 */
export function certifiedComputationRowFor(
  userId: string,
  sessionId: string,
  record: LayoverFeasibilityRecord,
): Record<string, unknown> {
  const decision = decisionRecordFor(sessionId, record);
  return {
    ...ledgerRowFor(userId, sessionId, record),
    snapshot_id: decision.snapshotId,
    input_facts: decision.inputFacts,
    source_refs: decision.sourceRefs,
    rules_applied: decision.rulesApplied,
    ledger_version: LAYOVER_LEDGER_VERSION,
  };
}

/**
 * §4 L23 `layover_time_budgets`.
 *
 * ── A NULL IS A MEASUREMENT AND A ZERO IS A CLAIM ───────────────────────────
 * Five of the eleven ladder terms are NULL here and that is the point. census
 * L46 records that this tree lumps deplane + immigration + baggage + exit
 * friction into ONE `estimateExitDelay`, that the base buffer covers security
 * AND boarding, and that `traffic_extra_min` covers transfer AND contingency.
 *
 * Writing `0` into `deplane_min` would record that somebody looked at
 * deplaning and found it instant. Nobody looked. 2992 makes the ten ladder
 * columns nullable for this reason and its comment says so; this function is
 * the writer that honours it.
 *
 * The terms that ARE written are each read off `record.deadline.breakdown`,
 * which is the engine's own per-term breakdown, and the total is written
 * separately rather than re-added here — a reader must never have to sum a
 * ladder half of whose terms are NULL.
 */
export function timeBudgetRowFor(
  snapshotId: string,
  sessionId: string,
  record: LayoverFeasibilityRecord,
): Record<string, unknown> {
  const b = record.deadline.breakdown;
  return {
    snapshot_id: snapshotId,
    session_id: sessionId,
    scheduled_minutes: record.envelope.totalMinutes,

    // NOT MODELLED SEPARATELY by this engine. See above.
    deplane_min: null,
    immigration_min: null,
    baggage_min: null,
    // The LUMP. `exitDelayMin` is deplane+immigration+baggage+exit friction as
    // one figure, and it is stored in the one column whose name it matches
    // rather than divided four ways by a rule nobody measured.
    exit_min: record.envelope.exitDelayMin,

    // Outbound is per-candidate, so it exists only when a landside probe named
    // one. `null` when no probe was supplied — not `0`, which would say the
    // journey out is instant.
    outbound_min: record.estimates.outboundTravel?.valueMinutes ?? null,
    // §8.1 L72. The engine's return-transport term, which is the only one whose
    // value moves with WHEN the traveller must be back. Stored in its own
    // column so the day it stops equalling the outbound constant is visible.
    return_min: b.returnTransportExtra ?? null,

    // Security and boarding are BOTH inside `baseBuffer` (L46). Splitting it
    // here would invent the split.
    security_min: null,
    transfer_min: null,
    contingency_min: null,
    boarding_min: null,

    total_buffer_min: b.totalBuffer,
    usable_minutes: record.envelope.usableMinutes,
    buffer_percentile: record.inputs.bufferPercentile,
    computed_at: record.computedAt,
  };
}

/**
 * §4 L24 `layover_return_plans`.
 *
 * `recommended_return_by` is the engine's `hardReturnTime` and NOT a softer
 * figure invented here. This tree publishes ONE deadline — that is L1's whole
 * requirement and `9c26efba` closed the duplicate-buffer defect that came from
 * having two — so the recommended return equals the hard return until
 * something upstream certifies a genuinely earlier one. The column exists
 * because the spec names it; storing the hard return in it is honest, and
 * 2992's CHECK (`recommended <= hard`) holds trivially rather than by luck.
 */
export function returnPlanRowFor(
  snapshotId: string,
  sessionId: string,
  record: LayoverFeasibilityRecord,
): Record<string, unknown> {
  const hard = record.deadline.hardReturnTime.toISOString();
  return {
    snapshot_id: snapshotId,
    session_id: sessionId,
    hard_return_by: hard,
    recommended_return_by: hard,
    // The latest instant a traveller may still be at an activity. The engine
    // publishes it only when a landside probe was assessed; `null` otherwise,
    // and never a guess.
    latest_activity_departure_at: null,
    risk_band: riskBandFor(record),
    confidence: record.confidence,
    reason_codes: [...record.reasonCodes],
    computed_at: record.computedAt,
  };
}

// ── the write ────────────────────────────────────────────────────────────────

export type PersistRefusal =
  /** The flag is off (or absent). An explicit refusal, never a silent no-op. */
  | "persistence_disabled"
  | "read_failed"
  | "write_failed"
  /** A different result would be stored under an id that already names one. */
  | "immutable_conflict";

export type PersistState =
  /** Parent and every child written. */
  | "recorded"
  /** The identical computation was already stored. The unique index said so. */
  | "already_recorded"
  /** The parent landed and at least one child did not. NEVER reported as success. */
  | "write_unconfirmed";

export interface PersistResult {
  ok: true;
  snapshotId: string;
  state: PersistState;
  /** Named so a caller can say WHICH half is missing, not merely that one is. */
  unwritten: Array<"time_budget" | "return_plan">;
}

export type PersistOutcome =
  | PersistResult
  | { ok: false; reason: PersistRefusal; message: string };

/**
 * Store one certified computation and its snapshot-scoped children.
 *
 * IDEMPOTENT BY THE UNIQUE INDEX, NOT BY A PRIOR READ. The index on
 * (session_id, input_hash) is the arbiter; a read-then-write would have a race
 * between the two and two dashboard loads in the same millisecond would write
 * two rows. A 23505 from the parent insert is `already_recorded` — success.
 *
 * NOT AN UPSERT, ANYWHERE. An upsert UPDATEs on conflict, and 2992 puts a
 * BEFORE UPDATE trigger on the child tables that raises. Reaching for `.upsert`
 * here would turn a benign double-tap into a 500 the day 2992 ships.
 */
export async function persistDecision(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  record: LayoverFeasibilityRecord,
): Promise<PersistOutcome> {
  if (!(await isFlagEnabled(db, DECISION_PERSISTENCE_FLAG))) {
    return {
      ok: false,
      reason: "persistence_disabled",
      message:
        `${DECISION_PERSISTENCE_FLAG} is off. Migrations 2700 and 2992 must be applied and confirmed ` +
        "before it is turned on; until then this payload names columns the database does not have.",
    };
  }

  const snapshotId = snapshotIdFor(sessionId, record.inputHash);

  // ── the immutability check, BEFORE the write ──────────────────────────────
  // `assertSnapshotImmutable` names the field that differs; a unique-index
  // rejection does not. Both are needed: this one explains, the index enforces.
  const existing = await decisionBySnapshotId(db, snapshotId);
  if (!existing.ok) {
    return {
      ok: false,
      reason: "read_failed",
      message: "could not read the existing computation — refusing rather than overwriting what might be there",
    };
  }
  if (existing.value !== null) {
    try {
      assertSnapshotImmutable(existing.value, decisionRecordFor(sessionId, record));
    } catch (err) {
      logger.warn({ snapshotId, sessionId }, "refused to rewrite an immutable snapshot");
      return {
        ok: false,
        reason: "immutable_conflict",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return { ok: true, snapshotId, state: "already_recorded", unwritten: [] };
  }

  // ── 1. the parent ─────────────────────────────────────────────────────────
  const { error: parentErr } = await db
    .from("layover_certified_computations")
    .insert(certifiedComputationRowFor(userId, sessionId, record));

  let state: PersistState = "recorded";
  if (parentErr) {
    if (parentErr.code === UNIQUE_VIOLATION) {
      // The index did its job. The identical computation is already stored, so
      // its children are too, and re-writing them would hit the immutability
      // trigger.
      return { ok: true, snapshotId, state: "already_recorded", unwritten: [] };
    }
    logger.warn({ err: parentErr.message, sessionId, snapshotId }, "certified computation write failed");
    return {
      ok: false,
      reason: "write_failed",
      message: "the certified computation could not be stored; nothing was written",
    };
  }

  // ── 2. the children ───────────────────────────────────────────────────────
  // Each is meaningless without the parent, which is why they run second, and
  // a failure here is DISCLOSED rather than rolled back: there is no
  // transaction across this client, and deleting the parent to tidy up would
  // destroy the one row that is definitely correct.
  const unwritten: Array<"time_budget" | "return_plan"> = [];

  const { error: budgetErr } = await db
    .from("layover_time_budgets")
    .insert(timeBudgetRowFor(snapshotId, sessionId, record));
  if (budgetErr && budgetErr.code !== UNIQUE_VIOLATION) {
    logger.warn({ err: budgetErr.message, snapshotId }, "time budget write failed");
    unwritten.push("time_budget");
  }

  const { error: planErr } = await db
    .from("layover_return_plans")
    .insert(returnPlanRowFor(snapshotId, sessionId, record));
  if (planErr && planErr.code !== UNIQUE_VIOLATION) {
    logger.warn({ err: planErr.message, snapshotId }, "return plan write failed");
    unwritten.push("return_plan");
  }

  if (unwritten.length > 0) state = "write_unconfirmed";
  return { ok: true, snapshotId, state, unwritten };
}

// ── reads ────────────────────────────────────────────────────────────────────

type Fail = { ok: false; reason: "read_failed" };
export type DecisionRead<T> = { ok: true; value: T } | Fail;

const FAILED: Fail = { ok: false, reason: "read_failed" };

/**
 * The columns every read below selects. Named once so two reads cannot project
 * different shapes into the same `toDecisionRecord`.
 *
 * `inputs` is in this list and it is the load-bearing one — see below.
 */
const DECISION_COLUMNS =
  "session_id,snapshot_id,engine_version,input_hash,computed_at,inputs";

/**
 * Rebuild a §20 `DecisionRecord` from its row BY REPLAYING IT.
 *
 * ── WHY THIS REPLAYS INSTEAD OF READING THE TYPED COLUMNS ───────────────────
 * The obvious implementation maps `verdict`, `confidence`, `hard_return_time`,
 * `total_buffer_min` and `usable_minutes` straight off the row. It was written
 * that way first and it was wrong, for a reason worth keeping:
 *
 * `DecisionResult` has NINE members and the table has FIVE of them. `tier`,
 * `returnState`, `windowRating` and `shortfallMinutes` have no column. A
 * column-reading projection has to put something in those four, and the only
 * options are a lie (a plausible constant) or a `null` the type forbids — which
 * is what a cast would have papered over.
 *
 * `inputs` is stored precisely so that it never has to. Migration 2700's own
 * header: *"the full named input set: replay feeds this back"*, and
 * `replayFeasibility` IS `certifyFeasibility` — the same function, aliased —
 * so replaying a stored input set reproduces the whole record deep-equal, all
 * nine members included. `src/test/layoverFeasibilityRecord.test.ts` pins that
 * property.
 *
 * So the read is a REPLAY, the typed columns stay what they are for (predicates
 * and joins, per §4's implementation rule), and census L5's *"Nothing can be
 * replayed"* stops being true of a production path rather than of a test.
 *
 * Returns `null` when the stored inputs cannot be replayed — a corrupt or
 * schema-drifted row — which the caller reports as a failed read, never as an
 * absent record.
 */
function toDecisionRecord(r: Record<string, any>): DecisionRecord | null {
  try {
    const replayed = replayFeasibility(r.inputs as FeasibilityInputs);
    // The identity must survive the round trip. If it does not, the stored
    // inputs are not the inputs that produced the stored hash, and answering
    // with a record that disagrees with its own row would be worse than
    // refusing.
    if (replayed.inputHash !== r.input_hash) {
      logger.warn(
        { snapshotId: r.snapshot_id, stored: r.input_hash, replayed: replayed.inputHash },
        "stored inputs do not replay to the stored input hash — refusing the row",
      );
      return null;
    }
    return decisionRecordFor(r.session_id, replayed);
  } catch (err) {
    logger.warn(
      { snapshotId: r.snapshot_id, err: err instanceof Error ? err.message : String(err) },
      "stored computation could not be replayed — refusing the row",
    );
    return null;
  }
}

/**
 * One stored computation by its snapshot identity.
 *
 * `null` means MEASURED ABSENCE and is only ever returned from a read that
 * succeeded. A failed read is `ok: false` — never `null`, because "no
 * computation certified your deadline" and "we could not look" are different
 * sentences and only one of them is ever true.
 */
export async function decisionBySnapshotId(
  db: SupabaseClient,
  snapshotId: string,
): Promise<DecisionRead<DecisionRecord | null>> {
  const { data, error } = await db
    .from("layover_certified_computations")
    .select(DECISION_COLUMNS)
    .eq("snapshot_id", snapshotId)
    .maybeSingle();
  if (error) {
    logger.warn({ err: error.message, snapshotId }, "decision read failed — refusing rather than reporting no record");
    return FAILED;
  }
  if (!data) return { ok: true, value: null };
  const record = toDecisionRecord(data as Record<string, any>);
  // A row that will not replay is a read that did not work. Reporting `null`
  // here would say "nothing certified this" about a row that is sitting there.
  if (record === null) return FAILED;
  return { ok: true, value: record };
}

/** Newest first. Bounded, so one session cannot fan a read out without limit. */
export async function decisionsForSession(
  db: SupabaseClient,
  sessionId: string,
  limit = 20,
): Promise<DecisionRead<DecisionRecord[]>> {
  const { data, error } = await db
    .from("layover_certified_computations")
    .select(DECISION_COLUMNS)
    .eq("session_id", sessionId)
    .order("computed_at", { ascending: false })
    .limit(limit);
  if (error) {
    logger.warn({ err: error.message, sessionId }, "decision history read failed — refusing rather than serving an empty history");
    return FAILED;
  }
  const rows = data ?? [];
  const records = rows.map((r) => toDecisionRecord(r as Record<string, any>));
  // ONE UNREPLAYABLE ROW FAILS THE WHOLE READ, deliberately. Silently dropping
  // it would serve a history with a hole in it that nothing on screen could
  // distinguish from a history with nothing in it — the §23.1 defect, applied
  // to the record of what a traveller was told.
  if (records.some((r) => r === null)) {
    logger.warn({ sessionId }, "decision history contains a row that will not replay — refusing the whole history");
    return FAILED;
  }
  return { ok: true, value: records.filter((r): r is DecisionRecord => r !== null) };
}

// ── §11.1 step 6 / L190 — the diff ───────────────────────────────────────────

export interface DecisionDiff {
  previousSnapshotId: string;
  nextSnapshotId: string;
  /** Dotted `result.*` / top-level field names that differ. Sorted, so it is comparable. */
  changed: string[];
  /** Reason codes present in `next` and not in `previous`. */
  reasonCodesAdded: string[];
  reasonCodesRemoved: string[];
  /**
   * L98's gate: did the traveller's ACTIONABLE options change?
   *
   * TRUE only when the verdict, the risk-relevant confidence, the deadline or
   * the usable window moved. A changed `computedAt` alone is a clock ticking
   * and is not news; emitting an OpportunityEvent for it is the notification
   * spam L99 forbids.
   */
  materiallyChanged: boolean;
}

/**
 * §11.1 step 6 — diff the previous action universe against the new one.
 *
 * PURE. It takes two stored records and returns what moved; it reads no clock
 * and touches no database, so the same two records always diff the same way.
 * census L190 scores `LayoverDecisionService.diff(previousSnapshotId,
 * nextSnapshotId)` NOT-BUILT with the reason "No snapshots." — the ids resolve
 * through `decisionBySnapshotId` and the comparison is this function.
 */
export const MATERIAL_DIFF_FIELDS = [
  "result.verdict",
  "result.confidence",
  "result.hardReturnTime",
  "result.usableMinutes",
] as const;

export function diffDecisions(previous: DecisionRecord, next: DecisionRecord): DecisionDiff {
  const changed: string[] = [];

  for (const key of Object.keys(previous.result) as Array<keyof DecisionRecord["result"]>) {
    if (previous.result[key] !== next.result[key]) changed.push(`result.${String(key)}`);
  }
  if (previous.inputHash !== next.inputHash) changed.push("inputHash");
  if (previous.engineVersion !== next.engineVersion) changed.push("engineVersion");
  if (previous.computedAt !== next.computedAt) changed.push("computedAt");
  changed.sort();

  const prevCodes = new Set(previous.reasonCodes);
  const nextCodes = new Set(next.reasonCodes);

  return {
    previousSnapshotId: previous.snapshotId,
    nextSnapshotId: next.snapshotId,
    changed,
    reasonCodesAdded: next.reasonCodes.filter((c) => !prevCodes.has(c)).sort(),
    reasonCodesRemoved: previous.reasonCodes.filter((c) => !nextCodes.has(c)).sort(),
    materiallyChanged: MATERIAL_DIFF_FIELDS.some((f) => changed.includes(f)),
  };
}
