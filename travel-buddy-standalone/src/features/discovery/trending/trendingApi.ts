/**
 * Discovery Trending on the client (`11` §4; routes/discoveryTrending.ts).
 *
 * The owner's decision of 2026-10-04 put Trending in scope as a user-facing
 * feature. The four list actions — by location, for you, emerging (places and
 * Trails), and Local Pulse (areas) — sit behind `discovery_trending_api_enabled`
 * AND `discovery_trend_lists_enabled`, both seeded FALSE; until the owner turns
 * them on every call answers `off`, and the screen says Trending is not
 * available rather than showing an empty list.
 *
 * WHAT A LIST MAY SAY. The server discloses a state only above the k ≥ 15
 * traveller floor and outside protected zones (Q12), and carries no number
 * (`11` §4). The client shows the state and the server's own reason sentence;
 * it never computes or shows a count. `unavailable` (no snapshot yet, a stale
 * one, a city the run did not locate) is a stated condition, not "nothing is
 * trending".
 */
import { readDiscoveryJson, type ApiRead } from '../shared/discoveryApi.ts';

export const TRENDING_ACTIONS = ['places', 'for-you', 'emerging', 'areas'] as const;
export type TrendingAction = (typeof TRENDING_ACTIONS)[number];

export interface TrendReason { code: string; text: string; driver?: string }
export interface TrendingPlace { placeId: string; state: string; reason: TrendReason }
export interface TrendingArea { area: string; state: string; reason: TrendReason }
export interface TrendingTrail { trailId: string; state: string; reason: TrendReason }

export type TrendListUnavailable = 'no_snapshot' | 'stale_snapshot' | 'not_located';

export interface TrendingList {
  action: TrendingAction;
  destination: string;
  places: TrendingPlace[];
  areas: TrendingArea[];
  trails: TrendingTrail[];
  /** The list itself is a stated condition, not an empty result. */
  unavailable: TrendListUnavailable | null;
  /** Emerging only: the Trails half could not be read or is not deployed. */
  trailsUnavailable: string | null;
  /** For-you only: whether the viewer's own affinity ordered it. */
  basis: 'affinity' | 'none' | null;
}

/** A JSON object's fields, or an empty record — never `any`. */
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const isReason = (v: unknown): v is TrendReason => typeof rec(v).code === 'string' && typeof rec(v).text === 'string';
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

function valid(action: TrendingAction, raw: unknown): boolean {
  const b = rec(raw);
  if (typeof b.destination !== 'string') return false;
  if (b.unavailable !== null && b.unavailable !== undefined && typeof b.unavailable !== 'string') return false;
  if (action === 'areas') return Array.isArray(b.areas) && rows(b.areas).every((a) => typeof a.area === 'string' && isReason(a.reason));
  if (!Array.isArray(b.items) || !rows(b.items).every((i) => typeof i.placeId === 'string' && isReason(i.reason))) return false;
  if (action === 'emerging') return Array.isArray(b.trails) && rows(b.trails).every((t) => typeof t.trailId === 'string' && isReason(t.reason));
  return true;
}

export async function fetchTrending(action: TrendingAction, destination: string): Promise<ApiRead<TrendingList>> {
  const d = destination.trim();
  if (!d) return { state: 'unavailable', detail: 'Choose a city to see what is trending there.' };
  const r = await readDiscoveryJson<Record<string, unknown>>(
    `/api/v1/discovery/trending/${action}?destination=${encodeURIComponent(d)}`,
    (b) => valid(action, b),
  );
  if (r.state !== 'ok') return r;
  const b = r.data;
  return {
    state: 'ok',
    data: {
      action,
      destination: String(b.destination),
      places: action === 'areas' ? [] : rows(b.items).map((i) => ({ placeId: String(i.placeId), state: String(i.state), reason: i.reason as TrendReason })),
      areas: action === 'areas' ? rows(b.areas).map((a) => ({ area: String(a.area), state: String(a.state), reason: a.reason as TrendReason })) : [],
      trails: action === 'emerging' ? rows(b.trails).map((t) => ({ trailId: String(t.trailId), state: String(t.state), reason: t.reason as TrendReason })) : [],
      unavailable: (b.unavailable ?? null) as TrendListUnavailable | null,
      trailsUnavailable: action === 'emerging' && typeof b.trailsUnavailable === 'string' ? b.trailsUnavailable : null,
      basis: action === 'for-you' && (b.basis === 'affinity' || b.basis === 'none') ? b.basis : null,
    },
  };
}

/** The sentence for a list the server could not produce from a current run. */
export function unavailableCopy(u: TrendListUnavailable, destination: string): string {
  switch (u) {
    case 'no_snapshot': return `Trending isn't measured for ${destination} yet.`;
    case 'stale_snapshot': return `The trending reading for ${destination} is out of date, so it isn't shown.`;
    case 'not_located': return `We don't have a trending reading for ${destination}.`;
  }
}

/** The sentence for the whole read failing or being switched off. */
export function trendingReadCopy(r: Exclude<ApiRead<TrendingList>, { state: 'ok' }>): string {
  return r.state === 'off' ? "Trending isn't available yet." : `Trending couldn't be loaded — ${r.detail}.`;
}

export function stateLabel(state: string): string {
  switch (state) {
    case 'trending': return 'Trending';
    case 'emerging': return 'Emerging';
    case 'rediscovered': return 'Rediscovered';
    default: return state.charAt(0).toUpperCase() + state.slice(1);
  }
}

export const ACTION_LABEL: Record<TrendingAction, string> = {
  places: 'Popular now',
  'for-you': 'For you',
  emerging: 'Emerging',
  areas: 'Neighbourhoods',
};
