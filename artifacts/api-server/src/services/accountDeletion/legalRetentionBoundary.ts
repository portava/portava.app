/**
 * The legal-retention boundary: the line a deletion plan may not cross without
 * an explicit, recorded authority.
 *
 * ── WHAT A BOUNDARY IS FOR ──────────────────────────────────────────────────
 * Not to keep data. To make crossing DELIBERATE. Three of the rules below
 * forbid an erasure that would destroy somebody else's protection or the
 * evidence that the deletion itself happened; the fourth requires that a policy
 * erasing money, safety or consent evidence SAYS SO, in the entry, with a named
 * authority. A plan that crosses the boundary is REFUSED at plan time — the
 * executor never sees it — because a boundary enforced at execution time is a
 * boundary that has already been half-crossed.
 *
 * These rules are about PROCESS, not about which fate is right. None of them
 * decides D6: a policy can still erase a safety record, it just has to say that
 * it is doing so and who authorised it.
 */
import type { DeletionGraphNode } from "../../lib/deletion/types.js";
import type { PolicyFate, PolicyEntry } from "./policy.js";

export interface BoundaryViolation {
  table: string;
  fate: PolicyFate;
  rule: string;
  detail: string;
  /**
   * Where the fate that crosses the line came from. "manifest" means the
   * SHIPPED behaviour crosses it: lib/deletionDispositions.ts justifies those
   * erasures in prose comments, but prose is not an acknowledgement a machine
   * can check, so they are reported rather than exempted. Exempting them would
   * make the boundary a rule that only applies to new decisions, which is the
   * opposite of what a boundary is for.
   */
  source: "policy" | "manifest";
}

export const BOUNDARY_RULES = {
  DELETION_RECEIPT: "a deletion's own receipt cannot be erased by that deletion",
  DECIDED_RETENTION: "a table already RETAINED_WITH_REASON cannot be erased without withdrawing the written reason",
  RETENTION_SIGNAL: "erasing financial / safety / legal-evidence rows requires an explicit overridesRetentionSignal acknowledgement",
  GUARDED_APPEND_ONLY: "an append-only table cannot be deleted outside a declared erasure",
} as const;

/**
 * Check ONE resolved action against the boundary. Returns every violation, not
 * the first: a plan that is stopped by two rules should say so once.
 */
export function checkBoundary(
  node: DeletionGraphNode,
  fate: PolicyFate,
  entry: PolicyEntry | undefined,
): BoundaryViolation[] {
  const out: BoundaryViolation[] = [];
  const source: BoundaryViolation["source"] = entry ? "policy" : "manifest";

  if (node.statedFate === "DELETION_FLOW" && fate === "DELETE") {
    out.push({
      table: node.table, fate, source, rule: BOUNDARY_RULES.DELETION_RECEIPT,
      detail: "this table records that the deletion happened; erasing it destroys the only proof the user's request was honoured",
    });
  }

  if (node.statedFate === "RETAINED_WITH_REASON" && fate !== "RETAIN") {
    out.push({
      table: node.table, fate, source, rule: BOUNDARY_RULES.DECIDED_RETENTION,
      detail: "the manifest carries a written retention reason for this table; changing its fate means withdrawing that reason in the same change",
    });
  }

  const retentionSignals = node.signals
    .filter((s) => s.key === "financial" || s.key === "moderationSafety" || s.key === "legalEvidence")
    .map((s) => `${s.key} (${s.evidence.join(", ")})`);
  if (fate !== "RETAIN" && retentionSignals.length > 0 && !entry?.overridesRetentionSignal) {
    out.push({
      table: node.table, fate, source, rule: BOUNDARY_RULES.RETENTION_SIGNAL,
      detail:
        `${fate} would remove or sever ${retentionSignals.join("; ")}. ` +
        "Set overridesRetentionSignal: true on the policy entry, with the authority that decided it, to cross this line on purpose.",
    });
  }

  if (fate === "DELETE" && node.guardTriggers.length > 0 && node.propagation.DELETE.mechanism !== "REQUIRES_DECLARED_ERASURE") {
    out.push({
      table: node.table, fate, source, rule: BOUNDARY_RULES.GUARDED_APPEND_ONLY,
      detail: `append-only guard trigger(s) ${node.guardTriggers.join(", ")} will refuse this DELETE outside a declared erasure`,
    });
  }

  return out;
}
