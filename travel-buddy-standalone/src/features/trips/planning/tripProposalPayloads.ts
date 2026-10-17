/**
 * §9.3 — a crew proposal with its decision rule, as the CREATE_PROPOSAL the
 * product sends straight to POST /trips/:tripId/commands (census-trips TR154
 * `decisionRule`; populates TR88 `trip_proposals`).
 *
 * WHY NOT /replan
 * ===============
 * The replan route creates proposals only under `trip_kernel_enabled`, which is
 * seeded FALSE, so on every deployment the product could vote on and decide a
 * proposal (TripBallotsCard) but never make one. The commands endpoint issues
 * CREATE_PROPOSAL whatever that flag says, and validates §9.3's payload fields
 * at its door (TripProposalContract.proposalCommandPayload, TR153).
 *
 * THE PAYLOAD
 * ===========
 *   CREATE_PROPOSAL {
 *     proposal_type,   2763's vocabulary — only the three offered below
 *     decision_rule,   2774's four rules; always sent, never left to the column
 *                      default, so the rule the person saw is the rule stored
 *     payload_json: { title, rationale?, impact_summary? }
 *   }
 * `title` is what the ballot shows (tripBallots.proposalTitle reads it). The two
 * §9.3 fields go under the contract's canonical keys and are omitted, not
 * nulled, when not given (an absent key is "not recorded").
 *
 * WHICH TYPES ARE OFFERED, AND WHY ONLY THESE
 * ===========================================
 * ACCEPT_PROPOSAL APPLIES add_plan / move_plan / cancel_plan to
 * `trip_plan_items` inside the kernel (2775). Plan writes have a legacy route
 * and a flag-gated cutover, and that route also enforces the trip's
 * plan-edit permission; an accepted proposal would write the plan around both.
 * So the composer offers only the types whose acceptance records the crew's
 * decision and changes nothing by itself (2775: NOT_APPLICABLE) —
 * `stage_change`, `add_commitment` and `other` — and says so on screen.
 *
 * Pure: imports nothing.
 */

/** 2763 `trip_proposals_type_known` values the composer offers; each has no canonical effect on acceptance (2775). */
export const OFFERED_PROPOSAL_TYPES = ['stage_change', 'add_commitment', 'other'] as const;
export type OfferedProposalType = (typeof OFFERED_PROPOSAL_TYPES)[number];

/** 2774 `trip_proposals_decision_rule_known`, in that order. */
export const DECISION_RULES = ['host', 'majority', 'unanimous', 'anyone'] as const;
export type DecisionRule = (typeof DECISION_RULES)[number];

export const PROPOSAL_TITLE_MAX = 120;
export const PROPOSAL_TEXT_MAX = 500;

export interface ProposalInput {
  proposalType: string;
  decisionRule: string;
  title: string;
  rationale?: string | null;
  impactSummary?: string | null;
}

export type ProposalReason = 'LOCAL_INVALID' | 'LOCAL_NO_TITLE' | 'LOCAL_TOO_LONG';

export type ProposalCommand =
  | { ok: true; type: 'CREATE_PROPOSAL'; payload: Record<string, unknown> }
  | { ok: false; reason: ProposalReason };

const oneOf = (list: readonly string[], v: string) => list.includes(v);

export function proposalCommand(input: ProposalInput): ProposalCommand {
  if (!oneOf(OFFERED_PROPOSAL_TYPES, input.proposalType) || !oneOf(DECISION_RULES, input.decisionRule)) {
    return { ok: false, reason: 'LOCAL_INVALID' };
  }
  const title = (input.title ?? '').trim();
  if (!title) return { ok: false, reason: 'LOCAL_NO_TITLE' };
  const rationale = (input.rationale ?? '').trim();
  const impact = (input.impactSummary ?? '').trim();
  if (title.length > PROPOSAL_TITLE_MAX || rationale.length > PROPOSAL_TEXT_MAX || impact.length > PROPOSAL_TEXT_MAX) {
    return { ok: false, reason: 'LOCAL_TOO_LONG' };
  }
  return {
    ok: true,
    type: 'CREATE_PROPOSAL',
    payload: {
      proposal_type: input.proposalType,
      decision_rule: input.decisionRule,
      payload_json: { title, ...(rationale ? { rationale } : {}), ...(impact ? { impact_summary: impact } : {}) },
    },
  };
}
