/**
 * mapJourney service — the client half of §36 Phase 6's two trip-scoped
 * surfaces: the group decision and recovery.
 *
 *   GET  /api/map/journey/shortlist?tripId=…
 *   POST /api/map/journey/shortlist/:planItemId/vote
 *   GET  /api/map/journey/recovery?tripId=…
 *
 * The third Phase-6 capability, Along My Way, is NOT here: it is a `corridor=`
 * parameter on services/mapProjection, because on the server it is a filter
 * over the gateway's own answer rather than a surface of its own.
 *
 * §23 IS THE SERVER'S GUARANTEE, AND THIS FILE DOES NOT WEAKEN IT. A crew
 * member arrives as `{ userId, name, areaLabel, statusLabel }`. There is no
 * coordinate field on `JourneyCrewArea` and this module never adds one, never
 * merges a position in from another service, and never asks the crew-map
 * endpoint for one to pair with it.
 *
 * §37: `RecoveryEntry.evidence` is a DISCRIMINATED union. A `schedule` entry —
 * "its planned time has passed" — carries no claim reference, because it is a
 * fact about the plan and the clock, not an observation of the venue. A UI that
 * wanted to show a source for one would have to add a field that does not exist.
 *
 * FAIL-SOFT, like every §36 surface: `map_journey_intelligence_enabled` is off
 * by default and the endpoints answer `{ enabled: false }` with empty content.
 * `enabled: false` means "Phase 6 is off", never "your crew has decided
 * nothing" — the caller must not render an empty shortlist as an answer.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

// ── Shapes (mirroring lib/journeyGroupDecision + lib/journeyRecovery) ─────────

export type JourneyVote = 'accept' | 'decline';

/**
 * A crew member on the decision sheet. COARSE AREA LABEL ONLY (§23) — there is
 * deliberately no lat/lng and no nested position, so this type cannot carry one
 * however it is spread or serialized.
 */
export interface JourneyCrewArea {
  userId: string;
  name: string | null;
  areaLabel: string | null;
  statusLabel: string;
}

export interface JourneyTally {
  accepts: number;
  declines: number;
  pending: number;
  myVote: JourneyVote | null;
  readyToConfirm: boolean;
  blockedBy: 'declined' | 'awaiting_votes' | 'too_few_accepts' | null;
}

export interface JourneyShortlistItem {
  id: string;
  title: string;
  category: string | null;
  startsAt: string | null;
  /** A place NAME. The geometry belongs to the map gateway, not this sheet. */
  locationName: string | null;
  tally: JourneyTally;
}

export interface JourneyShortlist {
  enabled: boolean;
  items: JourneyShortlistItem[];
  crew: JourneyCrewArea[];
  eligibleVoters: number;
  /** Candidates beyond the server's cap that were not shown. */
  truncated: number;
  /** True when the crew map could not be read — labels are missing, not absent. */
  crewReadFailed?: boolean;
}

export type RecoveryReasonCode =
  | 'walk_in_denied'
  | 'queue_exceeds_tolerance'
  | 'packed_vs_quiet_intent'
  | 'closed_now'
  | 'window_missed';

export type RecoveryEvidence =
  | {
      kind: 'live';
      claimRef: string;
      claimType: string;
      sourceLabel: string;
      sourceText: string;
      observedAt: string;
      validUntil: string;
    }
  | { kind: 'schedule'; windowEndedAt: string };

export interface RecoveryEntry {
  stopId: string;
  stopTitle: string;
  reasonCode: RecoveryReasonCode;
  reason: string;
  evidence: RecoveryEvidence;
  alternativeId: string | null;
  alternativeTitle: string | null;
  alternativeRank: number | null;
}

export interface JourneyRecovery {
  enabled: boolean;
  entries: RecoveryEntry[];
  considered: number;
  /** Stops whose only live evidence did not clear the truth boundary. */
  weakEvidenceStops: number;
  generatedAt: string;
}

export type JourneyResult<T> = { ok: true; data: T } | { ok: false; error: string };

// ── Empty answers ────────────────────────────────────────────────────────────

function disabledShortlist(): JourneyShortlist {
  return { enabled: false, items: [], crew: [], eligibleVoters: 0, truncated: 0 };
}

function disabledRecovery(): JourneyRecovery {
  return {
    enabled: false,
    entries: [],
    considered: 0,
    weakEvidenceStops: 0,
    generatedAt: new Date().toISOString(),
  };
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await freshApiToken();
  return token ? { Authorization: `Bearer ${token}` } : null;
}

// ── GET the shortlist ────────────────────────────────────────────────────────

export async function fetchJourneyShortlist(
  tripId: string,
  signal?: AbortSignal,
): Promise<JourneyResult<JourneyShortlist>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: disabledShortlist() };
  const headers = await authHeaders();
  if (!headers) return { ok: false, error: 'Not authenticated' };

  try {
    const res = await fetch(
      `${apiBase()}/api/map/journey/shortlist?tripId=${encodeURIComponent(tripId)}`,
      { headers, signal },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: (body as any).message ?? `Request failed (${res.status})` };
    }
    const b = body as Partial<JourneyShortlist>;
    return {
      ok: true,
      data: {
        ...disabledShortlist(),
        ...b,
        // A malformed body must never read as an enabled-but-empty shortlist:
        // "nobody has suggested anything" and "we could not tell" are different
        // answers and only one of them is safe to show.
        enabled: b.enabled === true,
        items: Array.isArray(b.items) ? b.items : [],
        crew: Array.isArray(b.crew) ? b.crew : [],
      },
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, error: 'aborted' };
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}

// ── POST a vote ──────────────────────────────────────────────────────────────

export interface JourneyVoteResult {
  enabled: boolean;
  recorded: boolean;
  /** The item's fresh tally, or null when only the echo failed. */
  tally: JourneyTally | null;
}

export async function submitJourneyVote(
  tripId: string,
  planItemId: string,
  vote: JourneyVote,
): Promise<JourneyResult<JourneyVoteResult>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: true, data: { enabled: false, recorded: false, tally: null } };
  }
  const headers = await authHeaders();
  if (!headers) return { ok: false, error: 'Not authenticated' };

  try {
    const res = await fetch(
      `${apiBase()}/api/map/journey/shortlist/${encodeURIComponent(planItemId)}/vote`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId, vote }),
      },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: (body as any).message ?? `Request failed (${res.status})` };
    }
    const b = body as Partial<JourneyVoteResult>;
    return {
      ok: true,
      data: {
        enabled: b.enabled === true,
        // Only an explicit true counts. A vote the server did not confirm must
        // not be shown as cast.
        recorded: b.recorded === true,
        tally: b.tally ?? null,
      },
    };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}

// ── GET recovery ─────────────────────────────────────────────────────────────

export async function fetchJourneyRecovery(
  tripId: string,
  signal?: AbortSignal,
): Promise<JourneyResult<JourneyRecovery>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: disabledRecovery() };
  const headers = await authHeaders();
  if (!headers) return { ok: false, error: 'Not authenticated' };

  try {
    const res = await fetch(
      `${apiBase()}/api/map/journey/recovery?tripId=${encodeURIComponent(tripId)}`,
      { headers, signal },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: (body as any).message ?? `Request failed (${res.status})` };
    }
    const b = body as Partial<JourneyRecovery>;
    return {
      ok: true,
      data: {
        ...disabledRecovery(),
        ...b,
        enabled: b.enabled === true,
        entries: Array.isArray(b.entries) ? b.entries : [],
      },
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, error: 'aborted' };
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}
