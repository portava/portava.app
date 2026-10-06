/**
 * §24 `resurfacing_suppression_violations` — "must be zero" — counted at the
 * last step of each PROACTIVE feed (census-highlights-memories H221, lane R
 * 2026-10-06).
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       §24 "Observability and Quality Metrics" names the metric and says it
 *       must be zero; §11 / §21 define what a suppression is.
 *
 * ── WHY THIS WAS NOT MEASURABLE, AND WHAT CHANGED ───────────────────────────
 * `services/memory/memoryKernelMetrics.ts` refused this name with the reason
 * that the proactive feeds live in `routes/highlights.ts`, "owned by another
 * lane", so a zero emitted from the memory module would be a claim about code
 * it never ran. The census row said the same and added that with 2720
 * unapplied the suppression set was `absent`. 2720 is applied, and the feeds
 * and this module are now one owner's, so the count is taken where the feed is
 * served rather than asserted from somewhere else.
 *
 * ── WHAT A VIOLATION IS ─────────────────────────────────────────────────────
 * A row a PROACTIVE feed is about to serve to a viewer who is not its owner,
 * for which `publicProjectionVerdict(..., "proactive_resurfacing", inputs)`
 * answers `suppressed` — i.e. a §11 control the owner (or, for a person-scoped
 * control, the viewer) stored says this row must not be resurfaced to them.
 * The feeds already filter on exactly that verdict earlier in the handler, so
 * on a correct handler the count is zero, which is the metric's whole point:
 * it is the instrument that would show a later stage (a re-rank, a pin
 * re-insertion, a merge of two pages) putting back a row the filter removed.
 *
 * ── IT ALSO ENFORCES ────────────────────────────────────────────────────────
 * A row counted as a violation is DROPPED, not merely logged. Counting a leak
 * and serving it anyway would make the metric a record of harm rather than a
 * guard against it; the cost of dropping is one Highlight a viewer does not
 * see, which is the direction §11 says to fail.
 *
 * ── EMITTED, NOT AGGREGATED ─────────────────────────────────────────────────
 * Per-process counters plus a structured log line carrying `metric`, the same
 * standard `memoryKernelMetrics.ts` and `lib/memoryPrivacyMetrics.ts` set:
 * there is no aggregator in this repository. That is census §K.2's `W`.
 */
import {
  publicProjectionVerdict,
  type ProjectionInputs,
} from "./highlightPublicProjection.js";

export const RESURFACING_SUPPRESSION_VIOLATIONS = "resurfacing_suppression_violations" as const;

interface AuditCounters {
  /** Non-owner rows examined at the serving step, across both feeds. */
  rowsChecked: number;
  /** Rows a stored §11 control said must not be resurfaced — must stay 0. */
  violations: number;
}

let counters: AuditCounters = { rowsChecked: 0, violations: 0 };

/** Test hook. */
export function _resetResurfacingSuppressionAudit(): void {
  counters = { rowsChecked: 0, violations: 0 };
}

export interface ResurfacingSuppressionSample {
  readonly metric: typeof RESURFACING_SUPPRESSION_VIOLATIONS;
  readonly violations: number;
  readonly rowsChecked: number;
}

/** A copy, never the live record. `violations` is a COUNT, not a rate: §24 says it must be zero. */
export function readResurfacingSuppressionAudit(): ResurfacingSuppressionSample {
  return { metric: RESURFACING_SUPPRESSION_VIOLATIONS, ...counters };
}

type Log = { error: (obj: unknown, msg: string) => void } | undefined;

/**
 * Examine the page a proactive feed is about to serve. Returns the page with
 * every violating row removed; counts every non-owner row checked and every
 * violation; logs each violation with the metric name, the highlight id and
 * the verdict's reason (ids and control names only — never a caption).
 *
 * `inputs` must be the SAME §10/§11 reads the handler filtered with: a second
 * read here could disagree with the first for reasons that are not violations
 * (a control written between the two reads) and would report noise as a leak.
 */
export function auditServedResurfacing<T extends { id: string; owner_id: string }>(
  rows: readonly T[],
  viewerId: string,
  inputs: ProjectionInputs,
  log: Log,
  where: string,
): T[] {
  const served: T[] = [];
  for (const h of rows) {
    if (h.owner_id === viewerId) { served.push(h); continue; }
    counters.rowsChecked += 1;
    const verdict = publicProjectionVerdict(h, viewerId, "proactive_resurfacing", inputs);
    if (!verdict.allow && verdict.kind === "suppressed") {
      counters.violations += 1;
      log?.error(
        { metric: RESURFACING_SUPPRESSION_VIOLATIONS, where, highlightId: h.id, reason: verdict.reason },
        "highlights: a suppressed Highlight reached the serving step of a proactive feed — dropped; §24 says this count must be zero",
      );
      continue;
    }
    served.push(h);
  }
  return served;
}
