/**
 * The Memory episode lifecycle — AS DATA.
 *
 * The Highlights/Memories spec names one state machine for a Memory:
 *
 *     CANDIDATE ──▶ CONFIRMED ──▶ ACTIVE ──▶ ARCHIVED
 *         │             │            │           │
 *         └──────┬──────┴────────────┴───────────┘
 *                ▼
 *        MERGED · REJECTED · DELETED
 *
 * WHY THIS IS A TABLE AND NOT A SWITCH
 * ------------------------------------
 * A lifecycle written as conditionals is a lifecycle nobody can read, audit, or
 * diff. Every `if (state === "active" && next === "archived")` is a rule hidden
 * inside a function, and the set of rules only exists in someone's head. The
 * transitions below ARE the specification: the legal set is enumerable, the
 * illegal set is its complement, and a reviewer can check the machine against
 * the spec by reading one object. `canTransition` does nothing but look the
 * answer up.
 *
 * This module is PURE. It touches no database, no clock, no client, and it is
 * imported by nothing in a live path — the provenance spine (migration 2320) has
 * no writer yet. It is the contract a future writer will be held to.
 */

/**
 * The seven states, in the order the spec lists them: the four-step happy path
 * first, then the three exits.
 */
export const EPISODE_STATES = [
  "candidate",
  "confirmed",
  "active",
  "archived",
  "merged",
  "rejected",
  "deleted",
] as const;

export type EpisodeState = (typeof EPISODE_STATES)[number];

/**
 * States from which nothing may leave. A terminal state is terminal because the
 * episode is gone (`deleted`), disowned (`rejected`), or has surrendered its
 * identity to another episode (`merged`) — in each case there is no longer an
 * episode here to move.
 *
 * `archived` is deliberately NOT terminal: archiving is a shelf, not a grave,
 * and the spec allows an archived Memory to be brought back.
 */
export const TERMINAL_EPISODE_STATES: ReadonlySet<EpisodeState> = new Set<EpisodeState>([
  "merged",
  "rejected",
  "deleted",
]);

/**
 * States in which an episode has not yet been assessed for significance, and
 * therefore is not yet Memory. Mirrors migration 2320's
 * memory_episodes_eligibility_check: a row may sit in one of these without a
 * significance score, and may not leave for anything except another one of
 * these without acquiring one.
 *
 * `rejected` and `deleted` are here because they are EXITS: an episode must be
 * discardable without first being scored.
 */
export const UNSCORED_EPISODE_STATES: ReadonlySet<EpisodeState> = new Set<EpisodeState>([
  "candidate",
  "rejected",
  "deleted",
]);

/**
 * THE MACHINE. One entry per state; the array is every state that state may
 * legally move to. Anything absent is illegal — including a self-transition,
 * which is deliberately excluded everywhere: re-asserting a state is not a
 * transition and must not be recorded as one.
 */
export const EPISODE_TRANSITIONS: Readonly<Record<EpisodeState, readonly EpisodeState[]>> = {
  // A detected candidate. Everything a detector writes lands here.
  candidate: ["confirmed", "merged", "rejected", "deleted"],
  // Corroborated: evidence supports it and significance has been assessed. It
  // may still be found to be a duplicate of another episode.
  confirmed: ["active", "merged", "rejected", "deleted"],
  // Live Memory — the only state a surface may draw from.
  active: ["archived", "merged", "rejected", "deleted"],
  // Shelved, not destroyed. May return to active.
  archived: ["active", "merged", "deleted"],
  // Terminal: identity surrendered to the survivor named by merged_into_id.
  merged: [],
  // Terminal: assessed and declined. Kept as a tombstone so the same signals do
  // not re-detect it forever.
  rejected: [],
  // Terminal.
  deleted: [],
} as const;

/** Type guard: is this arbitrary value one of the seven states? */
export function isEpisodeState(value: unknown): value is EpisodeState {
  return typeof value === "string" && (EPISODE_STATES as readonly string[]).includes(value);
}

/** The state every episode starts in. Matches the column DEFAULT in 2320. */
export const INITIAL_EPISODE_STATE: EpisodeState = "candidate";

/** Why a transition was refused. Discriminated so a caller can react, not just log. */
export type TransitionRefusal =
  | { readonly ok: false; readonly reason: "unknown_from"; readonly detail: string }
  | { readonly ok: false; readonly reason: "unknown_to"; readonly detail: string }
  | { readonly ok: false; readonly reason: "terminal"; readonly detail: string }
  | { readonly ok: false; readonly reason: "not_permitted"; readonly detail: string }
  | { readonly ok: false; readonly reason: "self_transition"; readonly detail: string }
  | { readonly ok: false; readonly reason: "merge_needs_survivor"; readonly detail: string }
  | { readonly ok: false; readonly reason: "not_significant"; readonly detail: string };

export type TransitionDecision = { readonly ok: true } | TransitionRefusal;

/** What the machine needs to know about the episode beyond its current state. */
export interface TransitionContext {
  /** The significance score, if one has been assessed. */
  readonly significance?: number | null;
  /** How significance was established, if it has been. */
  readonly significanceBasis?: string | null;
  /** The surviving episode id, required when moving to `merged`. */
  readonly mergedIntoId?: string | null;
}

/**
 * Decide whether `from -> to` is legal, and say why not when it is not.
 *
 * The order of the checks is the order of the reasons: an unknown state is not
 * a "not permitted" transition, and a merge without a survivor is not a
 * vocabulary problem. Callers that only need a boolean use `canTransition`.
 */
export function decideTransition(
  from: unknown,
  to: unknown,
  ctx: TransitionContext = {},
): TransitionDecision {
  if (!isEpisodeState(from)) {
    return { ok: false, reason: "unknown_from", detail: `not an episode state: ${String(from)}` };
  }
  if (!isEpisodeState(to)) {
    return { ok: false, reason: "unknown_to", detail: `not an episode state: ${String(to)}` };
  }
  if (from === to) {
    return { ok: false, reason: "self_transition", detail: `${from} -> ${to} is not a transition` };
  }
  if (TERMINAL_EPISODE_STATES.has(from)) {
    return { ok: false, reason: "terminal", detail: `${from} is terminal; nothing may leave it` };
  }
  if (!EPISODE_TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: "not_permitted", detail: `${from} -> ${to} is not in the machine` };
  }
  if (to === "merged" && !ctx.mergedIntoId) {
    return {
      ok: false,
      reason: "merge_needs_survivor",
      detail: "a merge must name the episode it merged into",
    };
  }
  // The eligibility gate, restated in TS so a caller learns WHY before the
  // database refuses. Migration 2320's memory_episodes_eligibility_check is the
  // enforcement; this is the explanation. Raw sensing does not become Memory.
  if (!UNSCORED_EPISODE_STATES.has(to)) {
    const scored =
      typeof ctx.significance === "number" &&
      Number.isFinite(ctx.significance) &&
      typeof ctx.significanceBasis === "string" &&
      ctx.significanceBasis.length > 0;
    if (!scored) {
      return {
        ok: false,
        reason: "not_significant",
        detail: `${to} requires both a significance score and a significance basis; a signal is not a Memory`,
      };
    }
  }
  return { ok: true };
}

/** Boolean form of {@link decideTransition}. */
export function canTransition(from: unknown, to: unknown, ctx: TransitionContext = {}): boolean {
  return decideTransition(from, to, ctx).ok;
}

/** Every state reachable from `from` in one legal step, ignoring context gates. */
export function nextStates(from: EpisodeState): readonly EpisodeState[] {
  return EPISODE_TRANSITIONS[from];
}
