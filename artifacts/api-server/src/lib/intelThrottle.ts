/**
 * Intelligence Gathering — prompt throttle (IG-03, spec §6 "Prompt throttling").
 *
 * Pure decision function. No I/O, no new table: the "recent prompt" signal is
 * derived from recent intel_observations for the subject (the append-only
 * capture rows), honouring the spec's "no duplicate truth store" rule.
 *
 * The four §6 rules, in priority order:
 *   1. A user pause (session / category / permanent) suppresses everything.
 *   2. Safe Return or emergency state suppresses the exit/any unsolicited prompt.
 *   3. At most ONE unsolicited prompt per active experience per 45 minutes.
 *   4. Prompt only when the requested claim family lacks fresh qualifying
 *      evidence (or a follow-up is explicitly required).
 */

export const PROMPT_THROTTLE_WINDOW_MS = 45 * 60_000;

export interface ThrottleState {
  paused?: boolean;
  safeReturnActive?: boolean;
  emergencyActive?: boolean;
  /** An explicit follow-up request bypasses the fresh-evidence gate (still throttled + safety-gated). */
  followupRequired?: boolean;
}

export interface RecentObservation {
  subjectId: string;
  observedAt: string | number | Date;
}

export type ThrottleReason =
  | "ok"
  | "paused"
  | "safety_state"
  | "throttled"
  | "fresh_evidence_exists";

function toMs(t: string | number | Date): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  return new Date(t).getTime();
}

/**
 * Decide whether an unsolicited prompt may be shown for `subjectId`.
 * Fail-closed on the safety rules; a malformed timestamp is treated as inside the
 * window (suppress), never outside it.
 */
export function shouldPrompt(args: {
  subjectId: string;
  recentObservations: readonly RecentObservation[];
  hasFreshQualifyingEvidence: boolean;
  now?: string | number | Date;
  state?: ThrottleState;
}): { prompt: boolean; reason: ThrottleReason } {
  const state = args.state ?? {};
  if (state.paused) return { prompt: false, reason: "paused" };
  if (state.safeReturnActive || state.emergencyActive) return { prompt: false, reason: "safety_state" };

  const now = toMs(args.now ?? Date.now());
  const throttled = args.recentObservations.some((o) => {
    if (o.subjectId !== args.subjectId) return false;
    const t = toMs(o.observedAt);
    if (!Number.isFinite(t)) return true; // fail-closed: unknown time counts as recent
    return now - t < PROMPT_THROTTLE_WINDOW_MS;
  });
  if (throttled) return { prompt: false, reason: "throttled" };

  if (args.hasFreshQualifyingEvidence && !state.followupRequired) {
    return { prompt: false, reason: "fresh_evidence_exists" };
  }
  return { prompt: true, reason: "ok" };
}
