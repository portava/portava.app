/**
 * discoveryLayoverMode — Discovery's Layover mode, in one place.
 *
 * census-discovery A14 / census-layover §25 L269: *"Discovery — only show
 * experiences from the certified action universe in Layover mode."*
 *
 * ── WHAT THIS IS, AND WHAT IT IS CAREFUL NOT TO BE ──────────────────────────
 * It contains NO time-budget arithmetic. Not a buffer, not a threshold, not a
 * deadline. Every decision below is read off the Layover lane's published
 * contract (`services/airport/LayoverSnapshot.ts`), which is the whole point of
 * that contract existing: census L6 forbids the second copy, and before the
 * contract the only way Discovery could have gated on the certified window was
 * to build its own session loader and its own minute maths.
 *
 * Four things happen here and nothing else:
 *
 *   1. the flag       FALSE BY ABSENCE. `LAYOVER_DISCOVERY_MODE_FLAG` is
 *                     published by the Layover lane so two lanes cannot spell
 *                     it differently, and `isFlagEnabled` answers false for a
 *                     missing row AND for an unreadable `feature_flags`
 *                     (lib/featureFlags.ts). Off ⇒ ordinary Discovery, and this
 *                     module adds not one key to the response.
 *   2. the snapshot   `certifiedLayoverSnapshot`. Its refusals are TWO KINDS
 *                     and they are not interchangeable — see below.
 *   3. the terms      `lib/discoveryLayoverTiming.ts`, which is where the
 *                     `travelTimeMin` / `activityTimeMin` question is answered
 *                     without inventing a minute. Read its header first.
 *   4. the universe   `certifiedActionUniverse`. `admittedIds` is the ONLY list
 *                     §25 L269 permits a Layover-mode surface to show.
 *
 * ── THE THREE STATES, AND WHY THEY MUST NOT COLLAPSE ────────────────────────
 * A gated surface has three ways to show a traveller fewer places, and they
 * mean completely different things. On the wire they are trivially confusable
 * — all three produce a shorter list — so each is given its own shape:
 *
 *   UNAVAILABLE MEASUREMENT  We looked. Nobody has stated how long this place
 *     takes, so it cannot be certified against the window. Not admitted, not an
 *     error: a `200` with no `refusal`, and the id named under
 *     `layover.excluded` with state `UNMEASURED`. On this tree, where no routed
 *     travel-time provider is configured, this is the COMMON case and saying so
 *     plainly is the honest answer.
 *
 *   FAILED READ  We could not look. `layover_sessions` or `airport_profiles`
 *     did not answer (`isDegradedRefusal` — the Layover lane's own name for
 *     "we were not in a position to say"), or `layover_plan_stops` did not.
 *     THIS MUST NOT BECOME "nothing was admitted". Left unguarded it would:
 *     a failed timing read leaves every term null, every candidate lands in
 *     UNMEASURED, and the body is byte-identical to a city nobody has measured.
 *     It carries Discovery's own refusal envelope instead — `transient_db`,
 *     `coverage: "nothing"`, HTTP unchanged at 200 — which is the vocabulary
 *     `routes/discovery.ts` already refuses in on four serve paths, and which
 *     keeps the response out of the exposure denominator.
 *
 *   GENUINELY INELIGIBLE  Measured, and the certified universe refused it:
 *     either the §8 envelope PROVED it out of reach at the straight-line lower
 *     bound (`BLOCKED`), or this session may not go landside at all (`CLOSED`).
 *     A `200` with no `refusal`, named under `layover.excluded` with its own
 *     state and the contract's own reason string.
 *
 * ── AND WHY A DEGRADED SNAPSHOT MAY NOT FALL BACK TO ORDINARY DISCOVERY ─────
 * Because "we could not read your layover" and "you are not in a layover" are
 * different sentences, and only the second one licenses an ungated list. The
 * published contract says so in as many words — *"a consumer that cannot get a
 * snapshot MUST NOT fall back to an ungated list"* — and `isDegradedRefusal` is
 * the predicate it publishes for telling the two apart. `session_not_found` and
 * `no_live_layover_session` are ANSWERS: the statement ran and matched nothing,
 * so there is no layover, so Layover mode does not apply and the surface serves
 * exactly what it served before.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { discoveryRefusal, type DiscoveryRefusal } from "./discoveryRefusal.js";
import { statedLayoverTimings, type TimeableCandidate } from "./discoveryLayoverTiming.js";
import {
  LAYOVER_DISCOVERY_MODE_FLAG,
  certifiedActionUniverse,
  certifiedLayoverSnapshot,
  isDegradedRefusal,
  type ActionAdmission,
} from "../services/airport/LayoverSnapshot.js";

/** The two refusal codes this mode can emit, spelled once. */
export const LAYOVER_MODE_REFUSAL_CODES = {
  /** The certified snapshot could not be read. */
  snapshot: "layover_snapshot_unreadable",
  /** The traveller's own plan could not be read, so nothing could be timed. */
  timing: "layover_timing_unreadable",
} as const;

/** One place the certified universe withheld, and the reason it gave. */
export interface WithheldAction {
  id: string;
  /** `BLOCKED` · `CLOSED` · `UNMEASURED` — the contract's own vocabulary. */
  state: ActionAdmission;
  reason: string;
}

/**
 * The additive envelope key a Layover-mode serve carries.
 *
 * ADDITIVE, and present ONLY when the mode is active: a client that has never
 * heard of it ignores it, and a healthy ordinary serve is byte-identical to
 * what it was before this row existed.
 */
export interface DiscoveryLayoverSummary {
  active: true;
  contractVersion: string;
  snapshotId: string;
  sessionId: string;
  verdict: string;
  confidence: string;
  usableMinutes: number;
  hardReturnBy: string;
  landsideOpen: boolean;
  /** How many of the candidates read were admitted — i.e. served. */
  admitted: number;
  /** Every candidate that was NOT served, with the state that withheld it. */
  excluded: WithheldAction[];
}

export type DiscoveryLayoverGate =
  /** Layover mode does not apply. The surface serves exactly what it read. */
  | { ok: true; active: false; admittedIds: null; summary: null }
  /** Layover mode applies. Only `admittedIds` may be shown. */
  | { ok: true; active: true; admittedIds: ReadonlySet<string>; summary: DiscoveryLayoverSummary }
  /**
   * A read failed. The caller must send this refusal instead of a list.
   *
   * `active`/`admittedIds`/`summary` are present-and-null rather than absent so
   * that a call site can read `gate.summary` without first proving which arm it
   * holds — the refusal arm returns early, and a narrowing that has to survive
   * forty lines of unrelated code is a narrowing that eventually does not.
   */
  | { ok: false; refusal: DiscoveryRefusal; active: false; admittedIds: null; summary: null };

const OFF: DiscoveryLayoverGate = { ok: true, active: false, admittedIds: null, summary: null };

/**
 * Decide what a Discovery surface may show this traveller right now.
 *
 * `userId` is nullable because Discovery's community surface serves anonymous
 * callers: with no traveller there is no session, hence no layover, hence
 * nothing to gate on. That is an ANSWER and not a degradation.
 *
 * A caller wires it in three lines:
 *
 *   const gate = await discoveryLayoverGate(sc, viewerId, items, "GET /x");
 *   if (!gate.ok) { sendDiscoveryRefusal(res, emptyEnvelope, gate.refusal); return; }
 *   const served = serveUnderLayoverGate(gate, items);
 */
export async function discoveryLayoverGate(
  sc: any,
  userId: string | null,
  candidates: ReadonlyArray<TimeableCandidate>,
  route: string,
): Promise<DiscoveryLayoverGate> {
  if (!sc || !userId) return OFF;
  if (!(await isFlagEnabled(sc, LAYOVER_DISCOVERY_MODE_FLAG))) return OFF;

  const read = await certifiedLayoverSnapshot(sc, userId);
  if (!read.ok) {
    // The one branch that decides whether a shorter list is honest. See the
    // header: only the two DEGRADED reasons mean "we could not look".
    if (!isDegradedRefusal(read.reason)) return OFF;
    return {
      ok: false,
      active: false,
      admittedIds: null,
      summary: null,
      refusal: discoveryRefusal(
        "transient_db", LAYOVER_MODE_REFUSAL_CODES.snapshot, route, "nothing",
        [read.reason === "layover_sessions_unreadable" ? "layover_sessions" : "airport_profiles"],
      ),
    };
  }
  const snapshot = read.snapshot;

  const timing = await statedLayoverTimings(sc, snapshot.sessionId, candidates, {
    // The snapshot's OWN centre and the record's OWN instant. A second clock
    // here would time the journey from a different moment than the window it
    // is measured against.
    centre: snapshot.envelope ? snapshot.envelope.centre : null,
    departAt: new Date(snapshot.certifiedRecord.inputs.nowMs),
  });
  if (!timing.ok) {
    return {
      ok: false,
      active: false,
      admittedIds: null,
      summary: null,
      refusal: discoveryRefusal(
        "transient_db", LAYOVER_MODE_REFUSAL_CODES.timing, route, "nothing", ["layover_plan_stops"],
      ),
    };
  }

  const universe = await certifiedActionUniverse(
    snapshot,
    candidates.map((c) => {
      const t = timing.byId.get(c.id);
      return {
        id: c.id,
        lat: c.lat ?? null,
        lng: c.lng ?? null,
        insideAirport: t ? t.insideAirport : false,
        travelTimeMin: t ? t.travelTimeMin : null,
        activityTimeMin: t ? t.activityTimeMin : null,
      };
    }),
  );

  const admittedIds = new Set(universe.admittedIds);
  return {
    ok: true,
    active: true,
    admittedIds,
    summary: {
      active: true,
      contractVersion: universe.contractVersion,
      snapshotId: universe.snapshotId,
      sessionId: universe.sessionId,
      verdict: String(snapshot.verdict),
      confidence: String(snapshot.confidence),
      usableMinutes: snapshot.usableMinutes,
      hardReturnBy: snapshot.hardReturnBy,
      landsideOpen: snapshot.landsideOpen,
      admitted: admittedIds.size,
      excluded: universe.actions
        .filter((a) => !a.admitted)
        .map((a) => ({
          id: a.id,
          state: a.state,
          // The contract's own words. A withheld card that cannot say why is
          // the same silence this census keeps catching, one layer up.
          reason: a.reason ?? a.feasibility.reason ?? a.state,
        })),
    },
  };
}

/**
 * Reduce a page to what the gate admitted. A no-op when the mode is off, which
 * is what keeps an ordinary serve byte-identical.
 */
export function serveUnderLayoverGate<T extends { id: string }>(
  gate: DiscoveryLayoverGate,
  items: T[],
): T[] {
  if (!gate.ok || !gate.active) return items;
  return items.filter((i) => gate.admittedIds.has(i.id));
}
