/**
 * discoveryLayoverGems — the Hidden Gems layover filter, reading the CERTIFIED
 * window instead of the one the client typed.
 *
 * census-discovery A13 (Layover `:66` — *"All surfaces consume the same
 * certified LayoverSnapshot / RecommendationContract; no duplicate time-budget
 * logic"*) and A14 (Layover §25 `:753` — *"Discovery: Only show experiences
 * from certified action universe in Layover mode"*), §56.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `GET /hidden-gems/layover-safe` is the surface the layover dashboard's
 * `LayoverDiscoveryCard` calls — the only Layover-mode Discovery surface a
 * traveller in an airport session is actually shown — and it took the window
 * from `?availableMinutes=`. The client sends the server's own
 * `window.usableMinutes`, read when the overview loaded, so on a healthy screen
 * the number is right at the moment it is fetched and wrong afterwards: the
 * window only ever shrinks, and nothing re-derived it. Anyone can also send a
 * larger one. `GET /hidden-gems?layoverSafe=1&availableMinutes=` had the same
 * shape. Both compared a gem's `minimum_layover_minutes` against a figure the
 * certified snapshot never saw — the second time-budget answer §2.1 forbids.
 *
 * ── WHAT THIS FILE DECIDES, AND WHAT IT DOES NOT ────────────────────────────
 * It decides only WHERE THE MINUTES COME FROM, in three answers:
 *
 *   certified  the caller is in a live layover. The window is
 *              `snapshot.usableMinutes` from `certifiedLayoverSnapshot` — the
 *              Layover domain's one door — and the query figure is IGNORED: it
 *              can neither widen nor narrow a certified window.
 *   stated     the caller is in NO layover (anonymous, or signed in with no
 *              live session: `no_live_layover_session`, an ANSWER). There is no
 *              certified window to read, so this is not Layover mode; the query
 *              figure is the caller's hypothetical ("How long is your
 *              layover?" on the Gems screen) and is used exactly as before.
 *   refused    the snapshot could not be READ (`isDegradedRefusal`). The route
 *              withholds — `503 degraded_unavailable` — and NEVER falls back to
 *              the query figure: "we could not read your layover" is not "you
 *              are not in one", and only the second licenses an uncertified list.
 *
 * It contains no time arithmetic. The one comparison — a gem's stated minimum
 * against the window — is the route's existing filter, now fed the certified
 * figure. There is no buffer, no deadline and no clock here.
 *
 * ── AND IN LAYOVER MODE, THE CERTIFIED ACTION UNIVERSE ───────────────────────
 * When `layover_discovery_mode_enabled` is on (the flag the Layover lane
 * published, seeded FALSE by 2971), the gems a certified caller would be served
 * go through `discoveryLayoverGate` — the same gate `/discovery`,
 * `/discovery/feed` and `/discovery/community` use — with THIS request's
 * snapshot, so one request is certified once. On this tree that admits only a
 * gem the traveller has put in their own layover plan with stated terms; every
 * other gem is withheld and NAMED (`layover.excluded`) with the contract's own
 * state. Flag off or absent: the gate is an identity and the served list is the
 * minutes-filtered one, unchanged in shape except for the two additive keys
 * `certifiedWindowKeys` names.
 */
import {
  certifiedLayoverSnapshot,
  isDegradedRefusal,
  type LayoverSnapshotRefusal,
  type LayoverSnapshotResult,
} from "../services/airport/LayoverSnapshot.js";
import {
  discoveryLayoverGate,
  serveUnderLayoverGate,
  type DiscoveryLayoverSummary,
} from "./discoveryLayoverMode.js";
import type { TimeableCandidate } from "./discoveryLayoverTiming.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ module: "discoveryLayoverGems" });

/** The sentence a traveller sees when their layover could not be read. */
export const LAYOVER_WINDOW_UNREADABLE_MESSAGE =
  "We could not read your layover right now, so layover-safe places are withheld rather than guessed. Please try again shortly.";

/** The sentence a traveller sees when Layover mode could not decide what to show. */
export const LAYOVER_MODE_UNDECIDED_MESSAGE =
  "We could not check these places against your layover right now, so they are withheld rather than guessed. Please try again shortly.";

/** The value of `minutesSource` on a certified serve. Spelled once. */
export const CERTIFIED_MINUTES_SOURCE = "certified_layover_snapshot";

export type LayoverGemWindow =
  /** No live layover. Not Layover mode: the caller's own figure is a hypothetical. */
  | { kind: "stated" }
  /** A live, certified layover. The snapshot's minutes, and nothing the client said. */
  | {
      kind: "certified";
      minutes: number;
      snapshotId: string;
      /** THIS request's snapshot, handed to the Layover-mode gate so it is not read twice. */
      read: Extract<LayoverSnapshotResult, { ok: true }>;
    }
  /** The snapshot could not be read. Withhold; never fall back to the query. */
  | { kind: "refused"; reason: LayoverSnapshotRefusal; message: string };

const STATED: LayoverGemWindow = { kind: "stated" };

/**
 * Where this request's layover minutes come from.
 *
 * `callerId` null (anonymous) is an ANSWER — no traveller, no session, no
 * layover — exactly as `discoveryLayoverGate` treats it.
 */
export async function layoverGemWindow(sc: any, callerId: string | null): Promise<LayoverGemWindow> {
  if (!sc || !callerId) return STATED;
  let read: LayoverSnapshotResult;
  try {
    read = await certifiedLayoverSnapshot(sc, callerId);
  } catch (err) {
    // The door binds its own read errors; a THROW is something else going
    // wrong on the way to the same question, and it gets the same answer.
    logger.warn({ err }, "layover gems: certified snapshot threw — withholding rather than using the query figure");
    return { kind: "refused", reason: "layover_sessions_unreadable", message: "certified snapshot threw" };
  }
  if (!read.ok) {
    return isDegradedRefusal(read.reason)
      ? { kind: "refused", reason: read.reason, message: read.message }
      : STATED;
  }
  return { kind: "certified", minutes: read.snapshot.usableMinutes, snapshotId: read.snapshot.snapshotId, read };
}

export type LayoverModeGems<T> =
  | { ok: true; gems: T[]; summary: DiscoveryLayoverSummary | null }
  | { ok: false; message: string };

/**
 * Reduce a served gem page to what Layover mode admits.
 *
 * An identity unless the window is CERTIFIED — a caller in no layover is not in
 * Layover mode — and, inside `discoveryLayoverGate`, unless the mode flag is on.
 * NEVER THROWS: a throw here would reach the route's `catch`, which answers
 * `db_error`; a failure to decide is a refusal, the same answer a failed read
 * gets, never the ungated list.
 */
export async function gemsUnderLayoverMode<T extends TimeableCandidate>(
  sc: any,
  callerId: string | null,
  window: LayoverGemWindow | null,
  gems: T[],
  route: string,
): Promise<LayoverModeGems<T>> {
  if (!window || window.kind !== "certified" || gems.length === 0) {
    return { ok: true, gems, summary: null };
  }
  try {
    const gate = await discoveryLayoverGate(sc, callerId, gems, route, { snapshotRead: window.read });
    if (!gate.ok) {
      logger.warn({ route, refusal: gate.refusal }, "layover gems: Layover-mode gate refused — withholding");
      return { ok: false, message: LAYOVER_MODE_UNDECIDED_MESSAGE };
    }
    return { ok: true, gems: serveUnderLayoverGate(gate, gems), summary: gate.summary };
  } catch (err) {
    logger.warn({ err, route }, "layover gems: Layover-mode gate threw — withholding rather than serving ungated");
    return { ok: false, message: LAYOVER_MODE_UNDECIDED_MESSAGE };
  }
}

/**
 * The keys a CERTIFIED serve adds to its body, and only a certified one.
 *
 * A stated (not-in-a-layover) serve gets `{}`, so its body is byte-identical to
 * what the route sent before this file existed.
 */
export function certifiedWindowKeys(
  window: LayoverGemWindow | null,
  summary: DiscoveryLayoverSummary | null,
): Record<string, unknown> {
  if (!window || window.kind !== "certified") return {};
  return {
    minutesSource: CERTIFIED_MINUTES_SOURCE,
    snapshotId: window.snapshotId,
    ...(summary ? { layover: summary } : {}),
  };
}
