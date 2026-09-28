/**
 * The integrity-checks stage — `06` §1 stage 7, census-discovery §85 (lane
 * W10-R3), DC-11. Behind `discovery_integrity_stage_enabled` (3483, seeded
 * FALSE).
 *
 * THE DETECTOR IS NOT THIS LANE'S. DV-12's engagement-integrity detector is
 * built by lane W10-R2 in lib/portavaRank.ts or lib/ranking/*, files this lane
 * may not edit. This module is the STAGE: where in `rankForViewer` the detector
 * is called, what it is handed, what it may do to the page, and what is
 * recorded. At the branch point (`6d1e7090b`) no such detector exists
 * (neither `lib/ranking/` nor an integrity export in portavaRank.ts), so the
 * detector is RESOLVED, not imported:
 *
 *   registerEngagementIntegrityDetector(fn)   — the one-line wiring the
 *     integrator adds beside R2's export (the hook, recorded in §85 and the
 *     register as D-W10-R3-8);
 *   opts.integrityDetector on rankForViewer    — tests inject one.
 *
 * With the flag on and no detector registered the stage records
 * `detector_absent` and changes nothing, so "the stage ran and found nothing"
 * and "there was nothing to run" can never be confused.
 *
 * WHAT A VERDICT MAY DO. `06` §1 puts integrity AFTER diversity/exploration
 * and before serve. A verdict is per item:
 *   keep       nothing
 *   discount   the item moves below every item not discounted (stable) — a
 *              discount on evidence the detector judged inflated, never a
 *              penalty on a person (`01` §10); no reason code names it
 *   withhold   the item is not served on this page
 * A detector that throws, or returns null, is `detector_failed` and changes
 * nothing: an unavailable integrity check fails toward today's page, which is
 * what every other §85 stage does with an unreadable input.
 */

export type IntegrityAction = "keep" | "discount" | "withhold";

export interface IntegrityItem { id: string; savedCount: number | null; category: string | null }

/** DV-12's detector, as this stage calls it. */
export type EngagementIntegrityDetector = (
  sc: any, items: readonly IntegrityItem[], ctx: { viewerId: string; nowMs: number },
) => Promise<ReadonlyMap<string, IntegrityAction> | null>;

let registered: EngagementIntegrityDetector | null = null;

/** The wiring point for DV-12's detector (lane W10-R2). */
export function registerEngagementIntegrityDetector(d: EngagementIntegrityDetector | null): void {
  registered = d;
}

export function registeredEngagementIntegrityDetector(): EngagementIntegrityDetector | null {
  return registered;
}

export interface IntegrityReport {
  status: "applied" | "clean" | "detector_absent" | "detector_failed";
  discounted: number;
  withheld: number;
}

/** Pure: apply verdicts to an order. Withheld ids are removed; discounted ids sink, stably. */
export function applyIntegrityVerdicts(order: readonly string[], verdicts: ReadonlyMap<string, IntegrityAction>): { order: string[]; discounted: number; withheld: number } {
  const kept: string[] = []; const sunk: string[] = [];
  let withheld = 0;
  for (const id of order) {
    const v = verdicts.get(id) ?? "keep";
    if (v === "withhold") { withheld++; continue; }
    (v === "discount" ? sunk : kept).push(id);
  }
  return { order: [...kept, ...sunk], discounted: sunk.length, withheld };
}

export async function runIntegrityStage(
  detector: EngagementIntegrityDetector | null, sc: any, items: readonly IntegrityItem[], ctx: { viewerId: string; nowMs: number },
): Promise<{ verdicts: ReadonlyMap<string, IntegrityAction> | null; report: IntegrityReport }> {
  if (!detector) return { verdicts: null, report: { status: "detector_absent", discounted: 0, withheld: 0 } };
  try {
    const v = await detector(sc, items, ctx);
    if (!v) return { verdicts: null, report: { status: "detector_failed", discounted: 0, withheld: 0 } };
    return { verdicts: v, report: { status: "clean", discounted: 0, withheld: 0 } };
  } catch {
    return { verdicts: null, report: { status: "detector_failed", discounted: 0, withheld: 0 } };
  }
}
