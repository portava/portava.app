/**
 * tripIntel.ts — client for the Trip Brain wave endpoints (2026-07-23):
 * readiness, next best action, arrival board, budget intelligence,
 * reservations import, and NL trip drafts.
 *
 * All functions fail soft (null / empty) when the API base is unconfigured or
 * the feature flag is off server-side (404 feature_disabled) so surfaces can
 * render their existing empty states unchanged.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshApiToken();
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReadinessItem {
  category: string;
  status: 'ready' | 'action_needed' | 'incomplete' | 'unknown';
  severity: 'normal' | 'critical';
  title: string;
  detail: string | null;
  dueAt: string | null;
  actionRef: Record<string, unknown> | null;
}

export interface ReadinessSummary {
  computedAt: string;
  score: number;
  counts: Record<string, number>;
  criticalItems: ReadinessItem[];
  categories: Record<string, string>;
  items: ReadinessItem[];
}

export interface NextBestAction {
  primary: {
    title: string;
    detail: string | null;
    category: string;
    severity: string;
    dueAt: string | null;
    actionRef: Record<string, unknown> | null;
  } | null;
  alternatives: NextBestAction['primary'][];
  message?: string;
  computedAt: string;
}

export interface CostEstimate {
  available: boolean;
  reason?: string;
  disclaimer?: string;
  days?: number;
  tier?: string;
  currency?: string;
  perDay?: { low: number; mid: number; high: number };
  total?: { low: number; mid: number; high: number };
  breakdown?: Array<{ category: string; perDay: number; source_note?: string | null }>;
  assumptions?: string[];
  confidence?: string;
  lastVerifiedAt?: string | null;
}

export interface TripReservation {
  id: string;
  type: 'flight' | 'stay' | 'activity' | 'transport' | 'other';
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  locationName: string | null;
  confirmationRef: string | null;
  cancellationDeadlineAt: string | null;
  status: 'pending_confirm' | 'confirmed' | 'dismissed';
  extractionConfidence: number | null;
}

// ── Readiness / NBA / arrival board ──────────────────────────────────────────

export async function fetchTripReadiness(tripId: string, refresh = false): Promise<ReadinessSummary | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/readiness${refresh ? '?refresh=1' : ''}`);
    if (!res.ok) return null; // 404 feature_disabled → honest null
    return (await res.json()) as ReadinessSummary;
  } catch {
    return null;
  }
}

export async function fetchNextBestAction(tripId: string): Promise<NextBestAction | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/next-best-action`);
    if (!res.ok) return null;
    return (await res.json()) as NextBestAction;
  } catch {
    return null;
  }
}

export async function fetchArrivalBoard(tripId: string): Promise<{
  arrivals: Array<{ userId: string; arrival: { time: string; label: string } | null }>;
  note?: string;
} | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/arrival-board`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Budget intelligence ──────────────────────────────────────────────────────

export async function fetchCostEstimate(tripId: string, tier?: string): Promise<CostEstimate | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const qs = tier ? `?tier=${encodeURIComponent(tier)}` : '';
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/cost-estimate${qs}`);
    if (!res.ok) return null;
    return (await res.json()) as CostEstimate;
  } catch {
    return null;
  }
}

export async function runBudgetSandbox(
  tripId: string,
  whatIf: {
    extraDays?: number;
    dailySpendOverride?: number;
    budgetDelta?: number;
    protectedCategories?: string[];
  },
): Promise<Record<string, unknown> | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/budget/sandbox`, {
      method: 'POST',
      body: JSON.stringify(whatIf),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Reservations ─────────────────────────────────────────────────────────────

export async function listReservations(tripId: string, status?: string): Promise<TripReservation[]> {
  if (!isSupabaseConfigured || !apiBase()) return [];
  try {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/reservations${qs}`);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.reservations ?? []) as TripReservation[];
  } catch {
    return [];
  }
}

export async function importReservations(tripId: string, text: string): Promise<{
  reservations: TripReservation[];
  error?: string;
} | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/reservations/import`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function confirmReservation(
  tripId: string,
  reservationId: string,
  addToPlan = false,
): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase()) return false;
  try {
    const res = await authedFetch(
      `${apiBase()}/api/trips/${tripId}/reservations/${reservationId}/confirm`,
      { method: 'POST', body: JSON.stringify({ addToPlan }) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function dismissReservation(tripId: string, reservationId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase()) return false;
  try {
    const res = await authedFetch(
      `${apiBase()}/api/trips/${tripId}/reservations/${reservationId}/dismiss`,
      { method: 'POST' },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ── NL trip draft ────────────────────────────────────────────────────────────

export async function draftTripFromText(text: string): Promise<{
  draft: Record<string, unknown>;
  confirmed: false;
  message: string;
} | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/draft-from-text`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
