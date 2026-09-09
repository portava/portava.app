/**
 * §10 presence — the client for `GET /trips/:tripId/presence` and the two
 * commands that write it.
 *
 * WHAT THE SERVER HAS ALREADY DECIDED, AND WHY THIS FILE DOES NOT RE-DECIDE IT
 * ===========================================================================
 * §10.2 names four freshness states and one rule: the map must never draw a
 * stale location as if it were current. The database computes the freshness
 * label from the same clock the expiry uses, and the route turns it into
 * `isCurrent` once. This client passes both through and does NOT recompute
 * either from `observedAt` — a device clock that is minutes fast would make a
 * stale row look live, which is precisely the failure the rule is about.
 * `asOf` is the server's clock, for anything that needs to render an age.
 *
 * EXPIRED ROWS ARRIVE, AND THAT IS DELIBERATE
 * ===========================================
 * The server does not filter them, because "we know where they were an hour
 * ago" and "we have never known where they are" are different facts and §10.4
 * needs the first. `noPresence` is the second, and it is a separate list — not
 * an `unknown` presence state, which is a thing a traveller can actually
 * report.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken } from './apiToken.ts';
import { issueTripCommand, type TripCommandResult } from './tripCommands.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

/**
 * §10.1's eight presence states, lowercased exactly as migration 2767's
 * `trip_presence_state_known` CHECK spells them. A ninth value is a 23514 from
 * the database, so this list is the contract and not a suggestion.
 */
export const PRESENCE_STATES = [
  'available', 'free', 'getting_ready', 'transiting', 'at_plan', 'resting', 'returning', 'offline',
] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

/** §10.3 provenance, from 2767's `trip_presence_source_known`. */
export const PRESENCE_SOURCES = [
  'geofence', 'significant_change', 'navigation', 'checkpoint', 'explicit',
] as const;
export type PresenceSource = (typeof PRESENCE_SOURCES)[number];

/** §10.2's freshness ladder, worst last. */
export const PRESENCE_FRESHNESS = ['live', 'recent', 'last_known', 'offline'] as const;
export type PresenceFreshness = (typeof PRESENCE_FRESHNESS)[number];

export interface PresenceEntry {
  userId: string;
  state: string;
  visibility: string;
  /** How it was observed. NULL means we do not know — not "self reported". */
  source: string | null;
  confidence: number | null;
  observedAt: string;
  expiresAt: string;
  freshness: string;
  expired: boolean;
  observedSecondsAgo: number;
  /** §10.2's decision, made by the server. Do not recompute it here. */
  isCurrent: boolean;
}

export interface PresenceBoard {
  tripId: string;
  /** The SERVER's clock at read time. */
  asOf: string;
  presence: PresenceEntry[];
  /** Accepted crew never observed at all. Not an 'unknown' state. */
  noPresence: string[];
}

export type PresenceRead =
  | { state: 'ok'; board: PresenceBoard }
  | { state: 'off' }
  | { state: 'unavailable'; detail: string };

export async function fetchTripPresence(tripId: string): Promise<PresenceRead> {
  if (!isSupabaseConfigured || !apiBase()) return { state: 'off' };
  const token = await freshToken();
  if (!token) return { state: 'off' };
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/presence`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      if (res.status === 404 && body?.error === 'feature_disabled') return { state: 'off' };
      return { state: 'unavailable', detail: `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => null) as PresenceBoard | null;
    if (!body || !Array.isArray(body.presence) || !Array.isArray(body.noPresence)) {
      // An empty board and an unreadable one are opposite claims. Only a body
      // that actually carries both lists may be reported as a board.
      return { state: 'unavailable', detail: 'unreadable response' };
    }
    return { state: 'ok', board: body };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

/**
 * Report where you are. Self-only — the kernel refuses a SET_PRESENCE naming
 * anyone else with TRIP_PRESENCE_NOT_SELF, so there is no user_id to pass.
 *
 * `idempotencyKey` is the caller's, as everywhere: a retry of the SAME
 * observation must not become a second one. Note that a retry which the kernel
 * finds STALE returns ok with `applied: false` and reason STALE_OBSERVATION —
 * that is a success, not a failure. A well-behaved retry caused it.
 */
export async function setMyPresence(
  tripId: string,
  args: {
    state: PresenceState;
    idempotencyKey: string;
    observedAt?: string;
    /** One of expiresAt or ttlSeconds is REQUIRED by the kernel: §10.1 presence
     *  has a TTL, and a row without one never goes stale. */
    expiresAt?: string;
    ttlSeconds?: number;
    visibility?: 'crew' | 'participants' | 'private';
    source?: PresenceSource;
    confidence?: number;
  },
): Promise<TripCommandResult> {
  if (args.expiresAt === undefined && args.ttlSeconds === undefined) {
    // Refused here rather than sent: the kernel rejects it with a reason the
    // caller would have to decode, and the actual mistake is upstream.
    return {
      ok: false, kind: 'unavailable',
      detail: 'expiresAt or ttlSeconds is required — presence without a TTL never goes stale',
    };
  }
  return issueTripCommand(tripId, {
    type: 'SET_PRESENCE',
    idempotencyKey: args.idempotencyKey,
    payload: {
      presence_state: args.state,
      observed_at: args.observedAt ?? new Date().toISOString(),
      ...(args.expiresAt ? { expires_at: args.expiresAt } : {}),
      ...(args.ttlSeconds !== undefined ? { ttl_seconds: args.ttlSeconds } : {}),
      ...(args.visibility ? { visibility: args.visibility } : {}),
      ...(args.source ? { source: args.source } : {}),
      ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
    },
  });
}

/** Stop reporting. Also self-only. */
export async function clearMyPresence(tripId: string, idempotencyKey: string): Promise<TripCommandResult> {
  return issueTripCommand(tripId, { type: 'CLEAR_PRESENCE', idempotencyKey, payload: {} });
}

/**
 * Was this command applied? A SET_PRESENCE that the kernel judged STALE
 * succeeds and changes nothing, so `ok` alone does not mean the row moved.
 */
export function commandWasApplied(r: TripCommandResult): boolean {
  if (!r.ok) return false;
  const applied = (r.result as { applied?: unknown } | null)?.applied;
  return applied === undefined ? true : applied === true;
}

/** Human phrasing for a freshness label. Never reassuring about a stale one. */
export function freshnessLabel(entry: PresenceEntry): string {
  switch (entry.freshness) {
    case 'live':       return 'Live';
    case 'recent':     return 'Recent';
    case 'last_known': return 'Last known';
    case 'offline':    return 'Offline';
    default:           return 'Unknown';
  }
}
