/**
 * travelerState — pure helpers for the §5 Current Traveler State chip.
 *
 * §31: "Explicitly expire Availability, temporary intent, Open to Plans …
 * Never render stale Availability as current." The server already filters
 * expired state out of the projection, but a projection can sit in memory or
 * in the client cache past its `expiresAt`, so the CLIENT re-checks expiry on
 * every read (`resolveTravelerStateForRender`) and the chip schedules its own
 * lapse (`msUntilTravelerStateExpiry`). These are pure so the policy is
 * testable without a clock or a renderer.
 */
import type { TravelerStateKind, TravelerStateView } from '../services/passportProjection.ts';

/** Epoch ms of `expiresAt`, or null when the state does not expire / is unparseable. */
export function travelerStateExpiryMs(state: Pick<TravelerStateView, 'expiresAt'>): number | null {
  if (!state.expiresAt) return null;
  const t = Date.parse(state.expiresAt);
  return Number.isFinite(t) ? t : null;
}

/** §31: a state is expired once now >= expiresAt. A state without expiry never is. */
export function isTravelerStateExpired(
  state: Pick<TravelerStateView, 'expiresAt'> | null | undefined,
  nowMs: number,
): boolean {
  if (!state) return false;
  const exp = travelerStateExpiryMs(state);
  return exp !== null && nowMs >= exp;
}

/**
 * The state to render as CURRENT, or null when there is none or it has lapsed.
 * Expiry-on-read: the caller never has to remember to check.
 */
export function resolveTravelerStateForRender(
  state: TravelerStateView | null | undefined,
  nowMs: number,
): TravelerStateView | null {
  if (!state) return null;
  return isTravelerStateExpired(state, nowMs) ? null : state;
}

/**
 * Delay until a currently-valid state lapses (>= 1 ms), or null when it has no
 * expiry or is already expired. Capped so it can be handed to setTimeout.
 */
const MAX_TIMER_MS = 2_147_483_647;
export function msUntilTravelerStateExpiry(
  state: TravelerStateView | null | undefined,
  nowMs: number,
): number | null {
  if (!state) return null;
  const exp = travelerStateExpiryMs(state);
  if (exp === null || nowMs >= exp) return null;
  return Math.min(MAX_TIMER_MS, Math.max(1, exp - nowMs));
}

/**
 * Visual tone per kind (§27: blue/teal for availability + social context,
 * green for positive/open states). Colour is never the ONLY indicator — the
 * chip always renders the label text and an icon (§27 "pair it with text").
 */
export type TravelerStateTone = 'social' | 'positive' | 'muted';

export function travelerStateTone(kind: TravelerStateKind): TravelerStateTone {
  switch (kind) {
    case 'open_to_plans':
      return 'positive';
    case 'unavailable':
    case 'home':
      return 'muted';
    default:
      return 'social';
  }
}

/** Stable identity of a state instance — used to emit availability_expired once per lapse. */
export function travelerStateKey(state: TravelerStateView): string {
  return `${state.state}|${state.city ?? ''}|${state.validFrom ?? ''}|${state.expiresAt ?? ''}`;
}
