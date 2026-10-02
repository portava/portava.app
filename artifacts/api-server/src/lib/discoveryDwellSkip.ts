/**
 * discoveryDwellSkip — `04` §4's `immediate_skip`, derived DOWNSTREAM from the
 * dwell rows (census-discovery DV-78, §82, register D-W10-O-7).
 *
 * THE REQUIREMENT
 * ===============
 * `04` §4 lists `immediate_skip` first among the Negative events and gives no
 * threshold. `04` §8: "Sequence features should be derived downstream rather
 * than hard-coded into clients." So nothing new is collected or sent: a skip is
 * READ from what the dwell writer (lib/discoveryDwell.ts) already records, and
 * this module is pure — it has no client, no flag read and no write.
 *
 * THE DEFINITION (decided)
 * ========================
 * A Discovery exposure is an IMMEDIATE SKIP when
 *   - its detail sheet was opened and nothing stronger happened (the exposure's
 *     furthest outcome is `tap`: a save, trip add or anything above it is
 *     engagement, never a skip), AND
 *   - the FOREGROUND dwell recorded on it — active + passive_foreground, summed
 *     over every emission bound to it (backgrounding splits one view into two
 *     emissions) — is below IMMEDIATE_SKIP_MAX_FOREGROUND_MS.
 * Idle dwell (backgrounded, screen off) is not time spent looking, so it never
 * lengthens a view.
 *
 * WHY 2 SECONDS. The sheet's opening animation is a few hundred milliseconds,
 * and reading a place's name and first line takes about a second more. Under
 * two seconds of foreground time the viewer opened the sheet and left before
 * reading it. The value is a named constant and the register records it.
 *
 * WHY ONLY THE SHEET. The Discovery list reports no viewability, so a card
 * scrolled past cannot be timed. Card-level timing is itself dwell collection on
 * the card (§55.10 Q4), which rides the same consent (B-1).
 *
 * WHAT IT IS NOT. Not an interest signal and not a ranking input: no ranker
 * reads it (src/test/discoveryDwellSkip.test.ts S4). It exists only where dwell
 * exists, and dwell exists only once the owner consents to collecting it
 * (`discovery_dwell_telemetry_enabled`, 3395, seeded FALSE; register
 * D-W10-O-9). Until then every figure here is UNOBSERVED, never 0.
 */
import { armOf } from "./discoveryOutcomeReport.js";
import { exposureIdsOf, featuresOf, traceRowKind, type TraceRankEventRow } from "./discoveryTraceCoverage.js";

/** Below this much foreground dwell, an opened-and-left exposure is an immediate skip. */
export const IMMEDIATE_SKIP_MAX_FOREGROUND_MS = 2_000;

const FOREGROUND_KINDS = new Set(["active", "passive_foreground"]);

export type ImmediateSkipFigure =
  | { observed: true; exposuresWithDwell: number; skips: number; share: number }
  | { observed: false; reason: string };

export interface ImmediateSkipReport {
  arms: { pde: ImmediateSkipFigure; legacy: ImmediateSkipFigure };
  threshold: { maxForegroundMs: number };
}

const UNOBSERVED = "no dwell row in this corpus: dwell is collected only when discovery_dwell_telemetry_enabled (3395) is on, which waits on the owner's consent (B-1, register D-W10-O-9)";

/** Is this one exposure an immediate skip, given its summed foreground dwell? Pure. */
export function isImmediateSkip(furthestOutcome: unknown, foregroundMs: number): boolean {
  return furthestOutcome === "tap" && foregroundMs < IMMEDIATE_SKIP_MAX_FOREGROUND_MS;
}

/** Per arm, over the exposures that carry dwell. Pure. */
export function buildImmediateSkipReport(rows: readonly TraceRankEventRow[]): ImmediateSkipReport {
  const foreground = new Map<string, number>();
  const hasDwell = new Set<string>();
  for (const r of rows) {
    if (traceRowKind(r) !== "attention") continue;
    const id = featuresOf(r)["recommendationId"];
    if (typeof id !== "string") continue;
    hasDwell.add(id);
    const ms = typeof r.dwell_ms === "number" && Number.isFinite(r.dwell_ms) && r.dwell_ms > 0 ? r.dwell_ms : 0;
    if (FOREGROUND_KINDS.has(String(r.dwell_kind))) foreground.set(id, (foreground.get(id) ?? 0) + ms);
  }
  const tally = { pde: { n: 0, skips: 0 }, legacy: { n: 0, skips: 0 } };
  for (const r of rows) {
    if (traceRowKind(r) !== "exposure") continue;
    const arm = armOf(r);
    if (arm !== "pde" && arm !== "legacy") continue;
    const id = exposureIdsOf(r).find((x) => hasDwell.has(x));
    if (!id) continue;
    tally[arm].n += 1;
    if (isImmediateSkip(r.outcome, foreground.get(id) ?? 0)) tally[arm].skips += 1;
  }
  const fig = (t: { n: number; skips: number }): ImmediateSkipFigure =>
    t.n === 0 ? { observed: false, reason: UNOBSERVED } : { observed: true, exposuresWithDwell: t.n, skips: t.skips, share: t.skips / t.n };
  return { arms: { pde: fig(tally.pde), legacy: fig(tally.legacy) }, threshold: { maxForegroundMs: IMMEDIATE_SKIP_MAX_FOREGROUND_MS } };
}
