/**
 * discoveryEcosystemBounds — the ADJUST half of `06` §8's Ecosystem Governor
 * (census-discovery DV-80, §84, lane W10-R1). `06` §8: "Governor adjusts policy
 * bounds, not individual user outcomes directly."
 *
 * D-2, DECIDED (D-W10-R1-15):
 *   - WHICH bounds: four, each a named constant a serve path already reads,
 *     each moved only inside a range the tree already rules. Nothing else.
 *   - HOW: a PROPOSAL, never an application. `proposePolicyBounds` is pure; it
 *     reads a monitor report and returns what an admin would change and why
 *     (`11` §8's "trend integrity review"). No code here writes a flag, a row
 *     or a constant, and nothing on a serve path imports this module.
 *   - WHEN: only on a MEASURED monitor over at least TREND_V2_MIN_EXPOSURES
 *     (the same statistical floor as a trend reading, D-W10-R1-2), outside its
 *     band. Never per user: every bound is page- or corpus-wide.
 *
 *   monitor                   band (propose when)            bound                           range           step
 *   concentration (HHI)       > 0.25 — the "highly           MAX_PER_CONTRIBUTOR_PER_PAGE    [1, 2]          −1
 *                             concentrated" line of the        (lib/discoveryTrailHealth)
 *                             2010 US merger guidelines
 *   new-creator success       < 0.5 — fewer than half of      GOVERNOR_BUDGET_MIN_PCT         [15, 25] %      +5
 *                             served new creators converted    (services/ranking/FeedSlotAllocator;
 *                                                               the ruled 15–25 % band)
 *   repeated recommendations  > 0.5 — most exposures repeat   the seen-set window             [24 h, 7 d]     ×2
 *                                                               (lib/discoveryPde SEEN_WINDOW_MS)
 *   Trail freshness           < 0.5 mean content freshness   TRAIL_EXPLORATION_SLOT_PCT      [15, 25] %      +5
 *                                                               (lib/discoveryTrailHealth)
 *
 * The other four monitors move no bound, and say why: spam is moderation, not
 * ranking; stale content is answered by the lifecycle and the rediscovery
 * retest (DV-28, DV-31); hidden-gem exposure has no ruled target share;
 * duplicate saturation is a defect to fix, not a bound to tune.
 *
 * The bands are the lane's decision and are the owner's to overrule; the
 * majority lines (0.5) are the least-arbitrary line a share has.
 */
import { MAX_PER_CONTRIBUTOR_PER_PAGE, TRAIL_EXPLORATION_SLOT_PCT } from "./discoveryTrailHealth.js";
import { GOVERNOR_BUDGET_MIN_PCT, GOVERNOR_BUDGET_MAX_PCT } from "../services/ranking/FeedSlotAllocator.js";
import { TREND_V2_MIN_EXPOSURES } from "./discoveryTrendNormalised.js";
import type { EcosystemReport, MonitorReading } from "./discoveryEcosystemGovernor.js";

const HOUR = 3_600_000;
/** lib/discoveryPde's SEEN_WINDOW_MS (not exported there); pinned equal by a source test. */
export const SEEN_WINDOW_MS_NOW = 24 * HOUR;

export interface BoundRule {
  monitor: string;
  bound: string;
  source: string;
  current: number;
  min: number;
  max: number;
  /** Proposed value from the current one, clamped to [min, max]. */
  step: (current: number) => number;
  outside: (value: number) => boolean;
  band: string;
}

export const POLICY_BOUND_RULES: readonly BoundRule[] = [
  { monitor: "concentration", bound: "MAX_PER_CONTRIBUTOR_PER_PAGE", source: "lib/discoveryTrailHealth.ts",
    current: MAX_PER_CONTRIBUTOR_PER_PAGE, min: 1, max: MAX_PER_CONTRIBUTOR_PER_PAGE, step: (c) => c - 1, outside: (v) => v > 0.25, band: "HHI ≤ 0.25" },
  { monitor: "new_creator_success", bound: "GOVERNOR_BUDGET_MIN_PCT", source: "services/ranking/FeedSlotAllocator.ts",
    current: GOVERNOR_BUDGET_MIN_PCT, min: GOVERNOR_BUDGET_MIN_PCT, max: GOVERNOR_BUDGET_MAX_PCT, step: (c) => c + 5, outside: (v) => v < 0.5, band: "≥ 0.5" },
  { monitor: "repeated_recommendations", bound: "SEEN_WINDOW_MS", source: "lib/discoveryPde.ts",
    current: SEEN_WINDOW_MS_NOW, min: 24 * HOUR, max: 7 * 24 * HOUR, step: (c) => c * 2, outside: (v) => v > 0.5, band: "≤ 0.5" },
  { monitor: "trail_freshness", bound: "TRAIL_EXPLORATION_SLOT_PCT", source: "lib/discoveryTrailHealth.ts",
    current: TRAIL_EXPLORATION_SLOT_PCT, min: 15, max: 25, step: (c) => c + 5, outside: (v) => v < 0.5, band: "≥ 0.5" },
];

/** Monitors that move no bound, and why (D-W10-R1-15). */
export const MONITORS_WITHOUT_BOUND: Readonly<Record<string, string>> = {
  spam_rate: "moderation, not a ranking bound",
  stale_content: "answered by the 03 §4 lifecycle and the rediscovery retest (DV-28, DV-31), not a bound",
  hidden_gem_exposure: "no target share is ruled for hidden gems",
  duplicate_saturation: "a defect to fix, not a bound to tune",
};

export interface BoundProposal {
  monitor: string;
  bound: string;
  source: string;
  current: number;
  proposed: number;
  range: [number, number];
  value: number;
  sample: number;
  band: string;
  /** Always "proposal": an admin applies it, nothing here does. */
  kind: "proposal";
}

/** Pure: the report → what an admin would change. Empty when every monitor is in band or unmeasured. */
export function proposePolicyBounds(report: EcosystemReport): BoundProposal[] {
  const out: BoundProposal[] = [];
  for (const rule of POLICY_BOUND_RULES) {
    const m = report.monitors.find((x) => x.id === rule.monitor);
    const r: MonitorReading | undefined = m?.reading;
    if (!r || r.state !== "measured" || r.sample < TREND_V2_MIN_EXPOSURES || !rule.outside(r.value)) continue;
    const proposed = Math.min(rule.max, Math.max(rule.min, rule.step(rule.current)));
    if (proposed === rule.current) continue;   // already at the edge of its range: nothing to propose
    out.push({ monitor: rule.monitor, bound: rule.bound, source: rule.source, current: rule.current, proposed,
      range: [rule.min, rule.max], value: r.value, sample: r.sample, band: rule.band, kind: "proposal" });
  }
  return out;
}
