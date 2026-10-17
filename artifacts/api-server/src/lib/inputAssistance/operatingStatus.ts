/**
 * Operating status on a suggestion row — §20 "Closed or unavailable where
 * current operating status is relevant" (census G123) and §28 "Open/closed or
 * availability state where valid" (census G177).
 *
 * WHAT IS A VALID SOURCE, AND WHAT IS NOT. A state may only be shown or used
 * when something in the system WRITES it and keeps it current. Two do:
 *
 *   1. EVENTS — `events.state`. The RSVP capacity writer moves an event between
 *      `open`, `full` and `waitlist` as people join and leave
 *      (lib/stateMachines/registry.ts names the writer), and the event search
 *      already reads the column (`metadata.status`). `full` and `waitlist` are
 *      therefore current availability facts. `started` and `completed` are NOT:
 *      the start transition is owner-blocked and completion is reachable only
 *      from `started`, so a stored `started`/`completed` is not evidence of
 *      anything happening now. They project nothing. (A past event is already
 *      demoted by §15 Staleness, rankingSignals.staleness.)
 *
 *   2. PLACES — a Live Intelligence `closure.state` claim, read through the
 *      gated `readLiveClaimEnvelopes` (flag chain, kill switch, pilot switch,
 *      per-scope promotion, k-anonymity, expiry). intelContracts rules
 *      `closure.state` NEVER a live label, so it is used for ranking only and is
 *      never shown. A `discovery_places` row has no hours column, and FSQ's
 *      `open_now` is a static ingest-time value (lead ruling D-67), so there is
 *      no open/closed state for a place that may be DISPLAYED — a place row
 *      shows none, which is what "where valid" requires.
 *
 * WHERE THE STATE IS RELEVANT. Global search is where a person looks for
 * somewhere to go or something to join, so a shut place or a full event is
 * demoted there. In a venue picker for a future event, a 6-hour closure is not
 * the point; in a Telegraph message, a full event is still worth sharing. Those
 * fields show availability (events) but demote nothing.
 *
 * DEMOTION, NEVER REMOVAL. §20 says "remove or demote"; the evidence here is a
 * capacity count or a crowd report, so the row stays reachable by name.
 */
import type { InputContext } from './types';
import type { LiveClaimEnvelope } from '../liveClaimRead';

/** The fields where the CURRENT operating state of a candidate is the point. */
export const OPERATING_STATUS_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>(['global_search']);

// ── Events (§28 G177 display, §20 G123 demotion) ──────────────────────────────

/** The event availability states a writer keeps current. */
export type EventAvailability = 'full' | 'waitlist';

/** An event row's current availability, or null when it has none to state. */
export function eventAvailability(r: { type: string; metadata?: Record<string, unknown> | null }): EventAvailability | null {
  if (r.type !== 'events') return null;
  const state = r.metadata?.status;
  return state === 'full' || state === 'waitlist' ? state : null;
}

/**
 * True when an event row is unavailable to THIS viewer in a field where that
 * matters: it is full (no waitlist), and the viewer is not already going.
 */
export function eventUnavailable(
  r: { type: string; metadata?: Record<string, unknown> | null; actionState?: Record<string, unknown> | null },
  context: InputContext,
): boolean {
  if (!OPERATING_STATUS_CONTEXTS.has(context)) return false;
  if (eventAvailability(r) !== 'full') return false;
  return r.actionState?.isAttending !== true;
}

// ── Places (§20 G123 demotion only) ───────────────────────────────────────────

export const CLOSURE_CLAIM_TYPE = 'closure.state';

/**
 * The closure values that state the CURRENT operating state as shut.
 * `permanently_closed` is deliberately absent: intelContracts'
 * STRUCTURAL_CLOSURE_STATES says it is never acted on from this capture path
 * alone. `open` is not shut.
 */
export const CURRENT_CLOSURE_STATES: ReadonlySet<string> = new Set(['temporarily_closed', 'closed_for_private_event']);

function closureValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { state?: unknown }).state === 'string') {
    return (value as { state: string }).state;
  }
  return null;
}

/**
 * Does the BEST current closure claim say the place is shut now? The envelopes
 * arrive best-first (liveClaimRead's order), so the first closure envelope
 * decides; a materially conflicted one ("Reports differ") decides nothing.
 */
export function closedNow(envelopes: readonly LiveClaimEnvelope[]): boolean {
  for (const e of envelopes) {
    if (e.claimType !== CLOSURE_CLAIM_TYPE) continue;
    if (e.conflictState === 'material') return false;
    const state = closureValue(e.value);
    return state !== null && CURRENT_CLOSURE_STATES.has(state);
  }
  return false;
}
