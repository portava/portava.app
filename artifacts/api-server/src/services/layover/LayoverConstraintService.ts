/**
 * LayoverConstraintService — spec §18 `LayoverSessionService.updateConstraint
 * (sessionId, patch)` (census L172), and the read that goes with it.
 *
 * `LayoverConstraints.ts` says what a declared set means. `LayoverConstraintStore.ts`
 * reads and appends rows. This module is the ONE act a traveller performs:
 * "this is how my bags and my connection work", certified and recorded.
 *
 * ── TWO STORAGE POSTURES, AND THE SECOND IS NOT A FAILURE ───────────────────
 *   versioned              `layover_constraints_enabled` is ON (2992 applied).
 *                          The declaration is appended as a new immutable
 *                          version, naming the snapshot it was certified under.
 *   session_booleans_only  the flag is OFF. `layover_constraints` is not
 *                          touched. The baggage mode is kept as the
 *                          CONSERVATIVE `checked_bags` boolean on the session,
 *                          so the arithmetic is right today, on the schema that
 *                          exists today: a traveller who says "not sure" is
 *                          charged for collecting and re-checking. What cannot
 *                          be kept — the four-way answer itself, the re-check
 *                          and the airport change — is NAMED in `unsaved`, not
 *                          dropped quietly.
 *
 * ── ONE CERTIFICATION PER DECLARATION ───────────────────────────────────────
 * The record returned is the record the stored version cites (`snapshot_id`),
 * computed once, from the session as it stands AFTER the declaration. The
 * route publishes that same record; it does not certify again.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import type { AirportProfile } from "../airport/AirportProfileService.js";
import type { EntryEligibility } from "../airport/layoverEntryGate.js";
import {
  certificationHeader,
  certifySessionFeasibility,
  type LayoverFeasibilityRecord,
} from "../airport/LayoverFeasibility.js";
import { snapshotIdFor } from "../airport/layoverLedger.js";
import { consumerLayoverRecord } from "../airport/LayoverSnapshot.js";
import { syncSessionBaggage, type LayoverSession } from "../airport/LayoverSessionService.js";
import {
  DECLARABLE_FIELDS,
  baggageChargesBags,
  constraintQuestion,
  entryPermissionStateOf,
  layoverStateOf,
  nextConstraintSet,
  patchStatesAnything,
  type ConstraintPatch,
  type DeclarableField,
  type LayoverConstraintSet,
  type LayoverState,
  type SessionConstraintContext,
} from "../airport/LayoverConstraints.js";
import {
  insertConstraintVersion,
  readConstraintFlags,
  readLatestConstraints,
} from "./LayoverConstraintStore.js";

const logger = rootLogger.child({ service: "LayoverConstraintService" });

export type ConstraintStorage = "versioned" | "session_booleans_only";

export type DeclareRefusal =
  /** The patch names no field. */
  | "nothing_declared"
  /** Storage is off and the patch names only fields a boolean cannot hold. */
  | "nothing_storable"
  /** The session is not `active`. */
  | "session_closed"
  /** The latest declared set could not be read, so there is nothing to lay the patch over. */
  | "constraints_unreadable"
  /** The database refused the write. */
  | "write_failed";

export type DeclareOutcome =
  | {
      ok: true;
      stored: "versioned";
      session: LayoverSession;
      set: LayoverConstraintSet;
      record: LayoverFeasibilityRecord;
      /** FALSE when the version was stored and the `checked_bags` mirror was not. */
      sessionSynced: boolean;
      unsaved: DeclarableField[];
    }
  | {
      ok: true;
      stored: "session_booleans_only";
      session: LayoverSession;
      set: null;
      record: LayoverFeasibilityRecord;
      sessionSynced: true;
      /** Fields in the patch that this posture cannot keep. */
      unsaved: DeclarableField[];
    }
  | { ok: false; reason: DeclareRefusal; message: string; retryable: boolean };

const REFUSAL: Record<DeclareRefusal, { message: string; retryable: boolean }> = {
  nothing_declared: { message: "Say at least one thing about your bags or your connection.", retryable: false },
  nothing_storable: {
    message: "Only your bag details can be saved right now. Whether you re-check in or change airports can't be kept yet.",
    retryable: false,
  },
  session_closed: { message: "This layover is no longer active, so its details can't be changed.", retryable: false },
  constraints_unreadable: { message: "Your bag and connection details could not be loaded. Please try again.", retryable: true },
  write_failed: { message: "Your bag and connection details could not be saved. Please try again.", retryable: true },
};

function refuse(reason: DeclareRefusal): DeclareOutcome {
  return { ok: false, reason, ...REFUSAL[reason] };
}

/** How many times a version collision is retried before it is reported. */
const VERSION_ATTEMPTS = 2;

/**
 * Declare (or re-declare) the traveller's constraints for one session.
 *
 * The caller has already established that `session` is the requester's own.
 */
export async function declareLayoverConstraints(
  db: SupabaseClient,
  args: {
    session: LayoverSession;
    airport: AirportProfile;
    patch: ConstraintPatch;
    nowMs: number;
    /** The traveller's own corridor, as the route resolved it. */
    entry: EntryEligibility | null;
  },
): Promise<DeclareOutcome> {
  const { session, airport, patch, nowMs, entry } = args;
  if (!patchStatesAnything(patch)) return refuse("nothing_declared");
  if (session.status !== "active") return refuse("session_closed");

  const flags = await readConstraintFlags(db);
  const stated = DECLARABLE_FIELDS.filter((f) => patch[f] !== undefined);

  // ── flag OFF: the conservative boolean, on the schema that exists ──────────
  if (!flags.storage) {
    if (patch.baggageMode === undefined) return refuse("nothing_storable");
    const synced = await syncSessionBaggage(db, session.id, session.userId, baggageChargesBags(patch.baggageMode), {
      kind: "constraints_declared",
      stored: "session_booleans_only",
      baggageMode: patch.baggageMode,
    });
    if (!synced.ok) return refuse("write_failed");
    if (!synced.session) return refuse("session_closed");
    return {
      ok: true,
      stored: "session_booleans_only",
      session: synced.session,
      set: null,
      // Through the snapshot door first, like every other consumer; the inline
      // certification is the legacy arm (layoverSnapshotConsumers.test.ts, C1).
      record: (await consumerLayoverRecord(db, airport, synced.session, nowMs)) ?? certifySessionFeasibility(airport, synced.session, { nowMs, entry }),
      sessionSynced: true,
      unsaved: stated.filter((f) => f !== "baggageMode"),
    };
  }

  // ── flag ON: append a version ──────────────────────────────────────────────
  for (let attempt = 1; attempt <= VERSION_ATTEMPTS; attempt += 1) {
    const latest = await readLatestConstraints(db, session.id);
    // NOT "undeclared". Laying a patch over a set that could not be read would
    // silently reset every field the patch does not name.
    if (latest.state === "unreadable") return refuse("constraints_unreadable");

    const set = nextConstraintSet(latest.state === "declared" ? latest.set : null, patch);
    const context: SessionConstraintContext = {
      read: "declared",
      set,
      entryForbidsLandside: flags.entryForbidsLandside,
    };
    // Certified against the session as it will stand once the mirror below is
    // written, so the record published here is the record a later read
    // recomputes.
    const declaredSession: LayoverSession = {
      ...session,
      checkedBags: baggageChargesBags(set.baggageMode),
      constraints: context,
    };
    // Asked of the snapshot door first (it certifies the session it is HANDED
    // and reads no session row), with the inline call as the legacy arm.
    const record = (await consumerLayoverRecord(db, airport, declaredSession, nowMs)) ?? certifySessionFeasibility(airport, declaredSession, { nowMs, entry });

    const inserted = await insertConstraintVersion(db, {
      sessionId: session.id,
      set,
      snapshotId: snapshotIdFor(session.id, record.inputHash),
      entryPermissionState: entryPermissionStateOf(entry),
      criticalUnknowns: record.landsideGate.criticalUnknowns,
    });
    if (!inserted.ok) {
      if (inserted.reason === "version_conflict" && attempt < VERSION_ATTEMPTS) continue;
      return refuse("write_failed");
    }

    const synced = await syncSessionBaggage(db, session.id, session.userId, declaredSession.checkedBags, {
      kind: "constraints_declared",
      stored: "versioned",
      version: set.version,
      baggageMode: set.baggageMode,
      recheckRequired: set.recheckRequired,
      airportChangeRequired: set.airportChangeRequired,
    });
    // The version IS stored and governs the engine while the flag is on, so a
    // failed mirror is reported rather than turned into a failed declaration:
    // telling the traveller "not saved" would invite a second, duplicate
    // version of something that was in fact kept.
    const sessionSynced = synced.ok && synced.session !== null;
    if (!sessionSynced) {
      logger.warn({ sessionId: session.id, version: set.version }, "layover constraints stored; checked_bags mirror not written");
    }
    return {
      ok: true,
      stored: "versioned",
      session: sessionSynced && synced.ok && synced.session
        ? { ...synced.session, constraints: { ...context, set: inserted.set } }
        : { ...declaredSession, constraints: { ...context, set: inserted.set } },
      set: inserted.set,
      record,
      sessionSynced,
      unsaved: [],
    };
  }
  return refuse("write_failed");
}

/** What the plan read said about landside stops. */
export type LandsidePlanRead = { ok: true; hasLandsidePlan: boolean } | { ok: false };

/** Is a stop OUTSIDE the airport on this session's plan? */
export async function readLandsidePlan(db: SupabaseClient, sessionId: string): Promise<LandsidePlanRead> {
  const { data, error } = await db
    .from("layover_plan_stops")
    .select("id, inside_airport")
    .eq("session_id", sessionId)
    .limit(50);
  if (error) {
    logger.warn({ err: error, sessionId }, "layover plan stops unreadable — the lifecycle state is withheld rather than guessed");
    return { ok: false };
  }
  return { ok: true, hasLandsidePlan: ((data ?? []) as Array<{ inside_airport?: boolean }>).some((s) => s.inside_airport !== true) };
}

/** The body of GET and PUT `/airport/sessions/:id/constraints`. */
export interface ConstraintsPayload {
  ok: true;
  storage: ConstraintStorage;
  /** The fields this posture can keep. The client offers a control for each and no other. */
  declarable: DeclarableField[];
  /** The declared set, or null when nothing is declared (or nothing can be). */
  constraints: LayoverConstraintSet | null;
  /** What the arithmetic is charging right now, whichever source it came from. */
  baggageCharged: boolean;
  landsideGate: LayoverFeasibilityRecord["landsideGate"];
  /** §4.1 state, or null with a reason when the plan could not be read. */
  layoverState: LayoverState | null;
  layoverStateUnavailableReason: "plan_unreadable" | null;
  /** §12.1 — the one question worth asking, or null. */
  question: ReturnType<typeof constraintQuestion>;
  verdict: LayoverFeasibilityRecord["verdict"];
  confidence: LayoverFeasibilityRecord["confidence"];
  reasonCodes: LayoverFeasibilityRecord["reasonCodes"];
  certification: ReturnType<typeof certificationHeader>;
  snapshotId: string;
}

/**
 * Project a session and its certified record onto the wire shape.
 *
 * Pure. `storage` is read off the session's own context, which is what the
 * record was certified with — never off a second flag read that could disagree.
 */
export function constraintsPayload(args: {
  session: LayoverSession;
  record: LayoverFeasibilityRecord;
  plan: LandsidePlanRead;
}): ConstraintsPayload {
  const { session, record, plan } = args;
  const ctx = session.constraints;
  const versioned = ctx !== undefined && ctx.read !== "storage_off";
  return {
    ok: true,
    storage: versioned ? "versioned" : "session_booleans_only",
    declarable: versioned ? [...DECLARABLE_FIELDS] : ["baggageMode"],
    constraints: ctx?.read === "declared" ? ctx.set : null,
    baggageCharged: bagsCharged(record),
    landsideGate: record.landsideGate,
    layoverState: plan.ok ? layoverStateOf(record, session.status, plan.hasLandsidePlan) : null,
    layoverStateUnavailableReason: plan.ok ? null : "plan_unreadable",
    question: constraintQuestion(record.landsideGate),
    verdict: record.verdict,
    confidence: record.confidence,
    reasonCodes: record.reasonCodes,
    certification: certificationHeader(record),
    snapshotId: snapshotIdFor(session.id, record.inputHash),
  };
}

/**
 * Whether the bag terms are in THIS record. Read off the record's own named
 * inputs: the declared mode when there is one, the session's boolean otherwise
 * — the same two sources `engineSession` chooses between.
 */
function bagsCharged(record: LayoverFeasibilityRecord): boolean {
  const c = record.inputs.constraints;
  return c ? baggageChargesBags(c.baggageMode) : record.inputs.session.checkedBags;
}
