/**
 * layoverRankingMode — census-layover L78's objective (`layoverObjective.ts`)
 * behind L242's rollout mode (`lib/layoverRolloutMode.ts`), at the one place a
 * layover card's order is decided: `generateRecommendations`, after
 * `rankActivities`.
 *
 *   legacy (the seed 3784, and EVERY failure)
 *       Nothing is computed. `served` IS the list it was given — the same array
 *       — and the audit event gains no key, so the rows, the cards and the
 *       event are byte-identical to the code before this file existed.
 *   shadow
 *       The objective order is computed BESIDE the live one and compared.
 *       `served` is still the legacy list — the same array, so nothing the
 *       objective produced can reach a row, a card or a response. The
 *       comparison is COUNTED: an in-process counter, ONE structured
 *       `layover_ranking_divergence` line when the two orders differ, and a
 *       counts-only tally in the `recommendation_generated` audit event
 *       (`metadata.ranking`) that `GET /api/admin/layover/metrics` folds per
 *       window. No card, title, key or order is stored or logged.
 *   on
 *       The objective order is served. It is a permutation of the legacy list
 *       within each safety rating (`orderWithinRatings`), so the set of cards,
 *       every rating, every deadline and every buffer are exactly legacy's; only
 *       `sort_order` within a rating can differ. The same tally is written.
 *
 * NEVER THROWS. A throw anywhere in the comparison serves legacy, counts a
 * failure and writes `{ failed: true }` — so a window can never claim a
 * generation was compared when it was not.
 *
 * The mode is per traveller: a non-legacy mode applies only inside the
 * configured cohort (`layoverModeFor`); everyone else gets legacy.
 */
import { logger as rootLogger } from "../../lib/logger.js";
import {
  LAYOVER_RANKING_MODE_FLAG,
  layoverModeFor,
  resolveLayoverRolloutMode,
  type LayoverModeReason,
} from "../../lib/layoverRolloutMode.js";
import {
  LAYOVER_OBJECTIVE_VERSION,
  OBJECTIVE_TERMS,
  orderWithinRatings,
  type ObjectiveCard,
  type ObjectiveLiveReading,
  type ObjectiveTerm,
} from "./layoverObjective.js";

const logger = rootLogger.child({ service: "layoverRankingMode" }); export { logger as _rankingModeLogger }; // tests only: the log-once pin

/** What one non-legacy generation stores under `metadata.ranking`. Counts only. */
export type RankingTally =
  | {
      objectiveVersion: string;
      mode: "shadow" | "on";
      /** Cards compared — every card the request ranked. */
      compared: number;
      /** Cards whose position differs between the legacy and the objective order. */
      moved: number;
      topChanged: boolean;
      /** Per term, on how many cards it was KNOWN (the rest contributed 0). */
      knownByTerm: Record<ObjectiveTerm, number>;
      /** The objective's own self-check refused, so legacy was served. Never true in practice; counted if it is. */
      refused: boolean;
    }
  | { objectiveVersion: string; mode: "shadow" | "on"; failed: true };

export interface RankingModeOutcome<T> {
  /** What the generator writes and serves, in this order. Legacy / shadow / any failure: the input array itself. */
  served: T[];
  /** Spread into the audit event's metadata: `{}` on legacy, `{ ranking }` otherwise. */
  event: { ranking?: RankingTally };
  mode: "legacy" | "shadow" | "on";
  reason: LayoverModeReason | "cohort_excluded";
}

interface RankingCounters {
  generations: { legacy: number; shadow: number; on: number };
  compared: number;
  divergent: number;
  moved: number;
  failures: number;
}

const counters: RankingCounters = { generations: { legacy: 0, shadow: 0, on: 0 }, compared: 0, divergent: 0, moved: 0, failures: 0 };

/** Since this process started. A snapshot; never the live object. */
export function layoverRankingCounters(): RankingCounters {
  return { ...counters, generations: { ...counters.generations } };
}

/** Tests only. */
export function _resetLayoverRankingCounters(): void {
  counters.generations = { legacy: 0, shadow: 0, on: 0 };
  counters.compared = 0;
  counters.divergent = 0;
  counters.moved = 0;
  counters.failures = 0;
}

/**
 * Decide the served order for one generation. Called ONCE per generation by
 * `generateRecommendations`, on the list `rankActivities` returned.
 */
export async function applyLayoverRankingMode<T extends ObjectiveCard>(
  db: unknown,
  session: { id: string; userId: string | null | undefined },
  ranked: T[],
  // NoInfer: T is the RANKED card type, taken from `ranked` alone; `keyOf` only has to accept it.
  ctx: { keyOf: (card: NoInfer<T>) => string; live?: ReadonlyMap<string, ObjectiveLiveReading> },
): Promise<RankingModeOutcome<T>> {
  const resolved = await resolveLayoverRolloutMode(db, "ranking_objective");
  const forUser = layoverModeFor(resolved, session.userId);
  if (forUser.mode === "legacy") {
    counters.generations.legacy += 1;
    return {
      served: ranked,
      event: {},
      mode: "legacy",
      reason: resolved.mode !== "legacy" ? "cohort_excluded" : resolved.reason,
    };
  }
  const mode = forUser.mode;
  counters.generations[mode] += 1;
  try {
    const order = orderWithinRatings(ranked, ctx);
    const tally: RankingTally = {
      objectiveVersion: LAYOVER_OBJECTIVE_VERSION,
      mode,
      compared: ranked.length,
      moved: order.moved,
      topChanged: order.topChanged,
      knownByTerm: order.knownByTerm,
      refused: order.refused !== null,
    };
    counters.compared += ranked.length;
    counters.moved += order.moved;
    if (order.moved > 0) {
      counters.divergent += 1;
      logger.info(
        {
          metric: "layover_ranking_divergence",
          flag: LAYOVER_RANKING_MODE_FLAG,
          objectiveVersion: LAYOVER_OBJECTIVE_VERSION,
          mode,
          sessionId: session.id,
          compared: ranked.length,
          moved: order.moved,
          topChanged: order.topChanged,
        },
        "layover_ranking_divergence",
      );
    }
    if (order.refused !== null) {
      counters.failures += 1;
      logger.warn({ metric: "layover_ranking_refused", sessionId: session.id, reason: order.refused }, "layover objective order refused by its own self-check — legacy served");
    }
    // SHADOW serves the input array itself: the objective's order exists only in the tally above.
    return { served: mode === "on" && order.refused === null ? order.served : ranked, event: { ranking: tally }, mode, reason: resolved.reason };
  } catch (err) {
    counters.failures += 1;
    logger.warn(
      { metric: "layover_ranking_failed", sessionId: session.id, mode, err: err instanceof Error ? err.message : String(err) },
      "layover objective ranking failed — legacy order served, this generation is uncompared",
    );
    return { served: ranked, event: { ranking: { objectiveVersion: LAYOVER_OBJECTIVE_VERSION, mode, failed: true } }, mode, reason: resolved.reason };
  }
}

// ── the window the admin route reports ───────────────────────────────────────

export interface LayoverRankingWindow {
  /** `recommendation_generated` events read in the window. */
  generations: number;
  /** No `ranking` key: legacy (the seed), a traveller outside the cohort, or written before this existed. */
  legacy: number;
  /** Readable tallies, by mode. */
  shadow: number;
  on: number;
  /** A tally that does not parse, or a generation whose comparison failed. */
  malformed: number;
  /** Over the readable tallies. */
  compared: number;
  divergent: number;
  moved: number;
  topChanged: number;
  refused: number;
  /** Per term, on how many compared cards it was KNOWN. */
  knownByTerm: Record<ObjectiveTerm, number>;
  truncated: boolean;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * Fold the `metadata` of a window's `recommendation_generated` events into the
 * divergence report. A tally is accepted only when its mode is shadow / on,
 * every count is a non-negative integer, `moved <= compared`, and every
 * `knownByTerm` key is a term with a count `<= compared`. Anything else — and a
 * `failed` tally — is MALFORMED and reported, never silently skipped.
 */
export function layoverRankingWindow(metadatas: readonly unknown[], truncated: boolean): LayoverRankingWindow {
  const knownByTerm = Object.fromEntries(OBJECTIVE_TERMS.map((t) => [t, 0])) as Record<ObjectiveTerm, number>;
  const w: LayoverRankingWindow = {
    generations: metadatas.length, legacy: 0, shadow: 0, on: 0, malformed: 0,
    compared: 0, divergent: 0, moved: 0, topChanged: 0, refused: 0, knownByTerm, truncated,
  };
  for (const m of metadatas) {
    const tally = m !== null && typeof m === "object" ? (m as Record<string, unknown>).ranking : undefined;
    if (tally === undefined) { w.legacy += 1; continue; }
    if (tally === null || typeof tally !== "object" || Array.isArray(tally)) { w.malformed += 1; continue; }
    const t = tally as Record<string, unknown>;
    const kt = t.knownByTerm;
    const wellFormed =
      t.failed === undefined &&
      (t.mode === "shadow" || t.mode === "on") &&
      isCount(t.compared) && isCount(t.moved) && t.moved <= t.compared &&
      typeof t.topChanged === "boolean" && typeof t.refused === "boolean" &&
      kt !== null && typeof kt === "object" && !Array.isArray(kt) &&
      Object.entries(kt as Record<string, unknown>).every(([k, n]) => (OBJECTIVE_TERMS as readonly string[]).includes(k) && isCount(n) && n <= (t.compared as number));
    if (!wellFormed) { w.malformed += 1; continue; }
    if (t.mode === "shadow") w.shadow += 1; else w.on += 1;
    w.compared += t.compared as number;
    w.moved += t.moved as number;
    if ((t.moved as number) > 0) w.divergent += 1;
    if (t.topChanged === true) w.topChanged += 1;
    if (t.refused === true) w.refused += 1;
    for (const [k, n] of Object.entries(kt as Record<string, number>)) knownByTerm[k as ObjectiveTerm] += n;
  }
  return w;
}
