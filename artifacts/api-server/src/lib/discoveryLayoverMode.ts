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
 *   1. the flag       FALSE BY ABSENCE, REFUSED BY SILENCE.
 *                     `LAYOVER_DISCOVERY_MODE_FLAG` is published by the Layover
 *                     lane so two lanes cannot spell it differently, and it is
 *                     read through `readFlagState`
 *                     (lib/capability/schemaCapability.ts), which keeps FOUR
 *                     answers apart where `isFlagEnabled` keeps two.
 *                     An ABSENT row is an answer — nobody enabled this —
 *                     so the mode is off, ordinary Discovery runs and this
 *                     module adds not one key to the response. An UNREADABLE
 *                     `feature_flags` is NOT an answer, and must not become
 *                     one: see "AND WHY AN UNREADABLE FLAG MAY NOT MEAN OFF".
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
 *
 * ── AND WHY AN UNREADABLE FLAG MAY NOT MEAN OFF ─────────────────────────────
 * This module used to read the flag through `isFlagEnabled`, which answers
 * `false` for a missing row AND for a `feature_flags` that could not be read,
 * and treated `false` as OFF — so an unreadable flags table served the
 * ORDINARY, UNGATED list.
 *
 * That is backwards for a RESTRICTION. For a flag that ADDS something,
 * fail-closed is "off" and the two cases genuinely collapse. This flag
 * WITHHOLDS places a traveller cannot get back from, so "we could not read the
 * flag" turning into "the restriction does not apply" is a guard that
 * disengages exactly when the database is least healthy — the same inversion
 * `isKillSwitchEngaged` was written for, and the same rule the FAILED READ arm
 * above already applies to `layover_sessions` and `layover_plan_stops`: an
 * unreadable read must never produce a settled claim about the world.
 *
 * The answer is the one this module already has a shape for — the refusal
 * envelope, `coverage: "nothing"`, `failedSources: ["feature_flags"]`. It was
 * chosen over the other fail-closed option, serving an EMPTY gated list,
 * because an empty list is byte-identical to "we looked and nothing fits",
 * which is the masquerade owner ruling D11 forbids and the whole reason the
 * three states above are given three shapes. Serving the ungated list was never
 * on the table.
 *
 * AND IT IS SCOPED TO THE TRAVELLERS IT IS ABOUT. The refusal is decided AFTER
 * the snapshot read, not at the flag read. A traveller with NO live layover is
 * outside this restriction whatever the flag says — the snapshot's
 * `no_live_layover_session` is an ANSWER, exactly as in the section above — so
 * they get ordinary Discovery and an unreadable `feature_flags` costs them
 * nothing. What is refused is precisely the set an ungated list would have been
 * wrong for: a traveller who IS in a live layover and about whom we cannot say
 * whether the restriction is switched on. Refusing at the flag read instead
 * would have blanked Discovery for every signed-in caller on any hiccup of
 * `feature_flags`, and withholding from people a rule was never about is not a
 * stricter rule, it is a wider outage.
 *
 * NO NEW READER WAS WRITTEN FOR THIS. `lib/featureFlags.ts` has four shared
 * readers and not one of them can answer the question: `isFlagEnabled` and
 * `isLivePlacesCapabilityEnabled` collapse absent and unreadable into `false`,
 * `getFlagRow` collapses both into `null`, and `isKillSwitchEngaged` hard-codes
 * the opposite direction for a different kind of flag. The four-valued reader
 * ALREADY EXISTS one directory over — `lib/capability/schemaCapability.ts`'s
 * `readFlagState`, which answers `on` / `off` / `absent` / `unreadable` and
 * binds the error to get there — and a second copy of it under a new name in
 * featureFlags.ts is precisely what census L6 forbids. It is imported, not
 * re-spelled, and `scripts/check-flag-polarity.mjs` now carries it in its
 * reader vocabulary so the call site is VISIBLE to the polarity rule rather
 * than unseen.
 */
import { readFlagState } from "./capability/schemaCapability.js";
import { discoveryRefusal, type DiscoveryRefusal } from "./discoveryRefusal.js";
import { statedLayoverTimings, type StatedTerm, type TimeableCandidate } from "./discoveryLayoverTiming.js";
import type { TravelTimeProvider } from "../domain/trips/contracts/TravelTimeProvider.js";
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
  /**
   * `feature_flags` could not be read, so whether the restriction applies is
   * UNKNOWN — and an unknown restriction is not a lifted one.
   */
  flag: "layover_flag_unreadable",
} as const;

/** One place the certified universe withheld, and the reason it gave. */
export interface WithheldAction {
  id: string;
  /** `BLOCKED` · `CLOSED` · `UNMEASURED` — the contract's own vocabulary. */
  state: ActionAdmission;
  reason: string;
  /**
   * The PROVENANCE of the two time terms, per term.
   *
   * ADDITIVE, and present on every withheld entry rather than only on the
   * `UNMEASURED` ones, because the three states are decided by a contract this
   * module does not own and a key that appears only for some of them is a key
   * whose presence a client would have to reverse-engineer.
   *
   * It exists because `UNMEASURED` on its own collapses at least four different
   * situations — no routed provider, no stop for this place, a stop whose
   * landside travel is the column's NOT-NULL zero, and an id that has no
   * layover subject at all — into one word. Absence of evidence must not read
   * as evidence of absence, and two different absences must not read alike.
   * `lib/discoveryLayoverTiming.ts` keeps them apart; this carries them out.
   */
  terms: { travel: StatedTerm; returnTravel: StatedTerm; activity: StatedTerm };
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
  /**
   * OPTIONAL, and it exists for ONE reason: the travel-time port is the only
   * thing on this tree that can tell the two legs of a journey apart, and
   * nothing here produces a routed one. Omitted — which is every call site in
   * `routes/discovery.ts` — the resolver uses
   * `LAYOVER_TRAVEL_TIME_PROVIDER`, exactly as before this parameter existed.
   * It is NOT a seam for changing the gate's answer: it changes who is asked,
   * and the contract still refuses on absence.
   */
  opts: { provider?: TravelTimeProvider } = {},
): Promise<DiscoveryLayoverGate> {
  if (!sc || !userId) return OFF;
  const flag = await readFlagState(sc, LAYOVER_DISCOVERY_MODE_FLAG);
  // `off` and `absent` are ANSWERS — a row saying no, and nobody having said
  // anything. Both mean the restriction does not exist, for anybody, and the
  // surface serves exactly what it served before. `unreadable` is NOT an answer
  // and deliberately does not return here; see below.
  if (flag === "off" || flag === "absent") return OFF;

  // Reached with the flag ON *or* UNREADABLE. In both cases the traveller has
  // to be looked at before anything can be served, because whether the
  // restriction could apply at all is a fact about THEM, not about the flag.
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

  // THIS TRAVELLER IS IN A LIVE LAYOVER, and we could not read whether the
  // restriction is switched on. NOT `return OFF`: for a restriction, an
  // unreadable flag resolving to "it does not apply" is a guard that disengages
  // on exactly the unhealthy database it was meant to survive.
  //
  // It is decided HERE, after the snapshot, and not at the flag read, ON
  // PURPOSE. Refusing at the flag read would blank Discovery for every
  // signed-in caller the moment `feature_flags` hiccups — including the vast
  // majority who are not in a layover at all and whom this restriction could
  // never have applied to. A guard that withholds from people it was never
  // about is not a stricter guard; it is a wider outage. The set that is
  // refused here is exactly the set an ungated list would have been wrong for.
  if (flag === "unreadable") {
    return {
      ok: false,
      active: false,
      admittedIds: null,
      summary: null,
      refusal: discoveryRefusal(
        "transient_db", LAYOVER_MODE_REFUSAL_CODES.flag, route, "nothing", ["feature_flags"],
      ),
    };
  }

  const timing = await statedLayoverTimings(sc, snapshot.sessionId, candidates, {
    // The snapshot's OWN centre and the record's OWN instant. A second clock
    // here would time the journey from a different moment than the window it
    // is measured against.
    centre: snapshot.envelope ? snapshot.envelope.centre : null,
    departAt: new Date(snapshot.certifiedRecord.inputs.nowMs),
    provider: opts.provider,
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
        // §12.1's *"return (future conditions, not symmetric)"*. `null` here is
        // the common answer and leaves `candidateFits` charging the outbound
        // twice — the number this surface served before the term existed.
        returnTravelTimeMin: t ? t.returnTravelTimeMin : null,
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
          terms: termsFor(timing.byId.get(a.id)),
        })),
    },
  };
}

/**
 * The per-term provenance for one withheld id.
 *
 * The fallback arm is reachable only if the certified universe named an id the
 * timing map has no entry for, which the call above makes impossible — the two
 * lists are built from the same `candidates`. It is written out anyway, and it
 * says NOTHING it does not know: `unmeasured`, no absence reason, no port
 * reason. An `??`-ed empty object would be a shape a client could not read, and
 * a fabricated reason here would be the exact defect this key exists to close.
 */
function termsFor(
  t: { travel: StatedTerm; returnTravel: StatedTerm; activity: StatedTerm } | undefined,
): { travel: StatedTerm; returnTravel: StatedTerm; activity: StatedTerm } {
  const unknown: StatedTerm = { value: null, source: "unmeasured", absence: null, portReason: null };
  return t
    ? { travel: t.travel, returnTravel: t.returnTravel, activity: t.activity }
    : { travel: unknown, returnTravel: unknown, activity: unknown };
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
