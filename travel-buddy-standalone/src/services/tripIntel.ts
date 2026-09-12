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

/**
 * Trips spec §8: readiness is an EXPLANATORY projection, not a gamified truth
 * score. The server builds this from the same items the counts come from
 * (api-server lib/tripReadiness.ts explainReadiness); a surface renders THIS.
 * Optional on the wire only because an older server may not send it.
 */
export interface ReadinessExplanation {
  /** One sentence: what stands between the trip and ready. Never a number out of 100. */
  headline: string;
  byCategory: {
    category: string;
    status: 'ready' | 'action_needed' | 'incomplete' | 'unknown';
    /** The worst item's own words, or "Nothing outstanding" / "Could not be checked". */
    because: string;
    nextAction: { title: string; detail: string | null; dueAt: string | null; actionRef: Record<string, unknown> | null } | null;
  }[];
  /** Categories that could be checked, and of those, the ready ones. A count — not a percentage. */
  measured: number;
  ready: number;
}

export interface ReadinessSummary {
  computedAt: string;
  /** §8 first. */
  explanation?: ReadinessExplanation;
  /**
   * Percent of the MEASURED categories that are ready — null when none could
   * be measured. Mirrors api-server/src/lib/tripReadiness.ts: a category with
   * status `unknown` is excluded from the fraction rather than counted as
   * ready, so an unreadable source can no longer raise a trip's score.
   *
   * NOT RENDERED. It is the server's snapshot count (census-trips TR142:
   * readiness is explanatory); no card, ring or header shows it as a gauge.
   */
  score: number | null;
  /** Score from the previous snapshot (e.g. yesterday). Null when no prior data exists. */
  previousScore: number | null;
  counts: Record<string, number>;
  /** The categories `score` does not cover, because their status is unknown. */
  unmeasuredCategories: string[];
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

export type CostEstimate =
  | {
      available: false;
      reason: string;
      disclaimer?: string;
    }
  | {
      available: true;
      days: number;
      tier: string;
      currency: string;
      scope?: string;
      perDay: { low: number; mid: number; high: number };
      total: { low: number; mid: number; high: number };
      breakdown?: Array<{ category: string; perDay: number; source_note?: string | null }>;
      assumptions: string[];
      confidence: string;
      lastVerifiedAt: string | null;
      disclaimer: string;
    };

export interface SandboxResult {
  available: false;
  reason: string;
}

export interface SandboxResultAvailable {
  available: true;
  days: number;
  dailySpend: { low: number; mid: number; high: number };
  total: { low: number; mid: number; high: number } | null;
  budget: { totalBudget: number; budgetDelta: number; effectiveBudget: number } | null;
  fitsBudget: boolean | null;
  gap: number | null;
  suggestions: Array<{ type: string; category?: string; estimatedSavings: number; note: string }>;
  protectedCategories: string[];
  notes: string[];
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

/**
 * The three states a readiness read can be in.
 *
 * WHY THIS IS NOT `ReadinessSummary | null`
 * =========================================
 * It was, and `null` meant both "the readiness feature is not available here"
 * and "the request failed". TripReadinessCard's own comment said so out loud —
 * "network/unexpected error → treat same as feature flag off" — and rendered
 * nothing for both. So did app/trip/[id].tsx, which then fell back to
 * `trips.progress`, a column nothing writes, and painted a 0% progress ring.
 *
 * A readiness summary is a RISK REPORT: it is where "you have no visa", "your
 * stay is unbooked" comes from. A risk report that could not be read is not a
 * report with no risks in it, and a progress ring is not entitled to a number
 * derived from a read that did not answer. `unavailable` is that third state
 * and every consumer has to handle it separately from `off`.
 */
export type ReadinessRead =
  | { state: 'ok'; summary: ReadinessSummary }
  /** The feature is not available here — not configured, or flagged off
   *  server-side. Nothing was measured and nothing is claimed. */
  | { state: 'off' }
  /** The read FAILED. Distinct from `off`: readiness may well have findings
   *  and we could not see them. */
  | { state: 'unavailable'; detail: string };

export async function fetchTripReadiness(tripId: string, refresh = false): Promise<ReadinessRead> {
  if (!isSupabaseConfigured || !apiBase()) return { state: 'off' };
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/readiness${refresh ? '?refresh=1' : ''}`);
    if (!res.ok) {
      // Only the server SAYING the feature is disabled counts as `off`. Every
      // other non-ok status — 500, 503, a gateway page, an auth failure — is a
      // read that did not answer, and used to be indistinguishable from it.
      const body = await res.json().catch(() => null) as { error?: string } | null;
      if (res.status === 404 && body?.error === 'feature_disabled') return { state: 'off' };
      return { state: 'unavailable', detail: `HTTP ${res.status}` };
    }
    const summary = await res.json().catch(() => null) as ReadinessSummary | null;
    if (!summary || !Array.isArray(summary.items)) {
      return { state: 'unavailable', detail: 'unreadable response' };
    }
    return { state: 'ok', summary };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
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
  arrivals: Array<{ userId: string; handle?: string | null; arrival: { time: string; label: string } | null }>;
  note?: string;
} | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/arrival-board`);
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    // Backend returns { board: [...], note } — normalise to { arrivals: [...], note }.
    const arrivals = (json.arrivals ?? json.board ?? []) as Array<{
      userId: string;
      arrival: { time: string; label: string } | null;
    }>;
    return { arrivals, note: json.note as string | undefined };
  } catch {
    return null;
  }
}

// ── Manual budget (owner + co_host only) ────────────────────────────────────

export interface ManualBudget {
  tripId: string;
  currency: string | null;
  totalBudget: number | null;
  spent: number | null;
  breakdown: Record<string, number> | null;
  updatedAt: string | null;
}

export async function fetchManualBudget(tripId: string): Promise<ManualBudget | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/budget`);
    if (!res.ok) return null;
    const json = await res.json();
    const b = json.budget;
    if (!b) return null;
    return {
      tripId:      b.trip_id,
      currency:    b.currency ?? null,
      totalBudget: b.total_budget ?? null,
      spent:       b.spent ?? null,
      breakdown:   b.breakdown ?? null,
      updatedAt:   b.updated_at ?? null,
    };
  } catch {
    return null;
  }
}

export async function updateManualBudget(
  tripId: string,
  data: { currency?: string; totalBudget?: number | null; breakdown?: Record<string, number> },
): Promise<ManualBudget | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/budget`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const b = json.budget;
    if (!b) return null;
    return {
      tripId:      b.trip_id,
      currency:    b.currency ?? null,
      totalBudget: b.total_budget ?? null,
      spent:       b.spent ?? null,
      breakdown:   b.breakdown ?? null,
      updatedAt:   b.updated_at ?? null,
    };
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
    const json = await res.json();
    // Backend returns { estimate: EstimateResult, partySize: number }
    return (json.estimate ?? null) as CostEstimate | null;
  } catch {
    return null;
  }
}

/** FX-converted view of the estimate bands in the traveler's home currency. */
export interface CostEstimateConverted {
  currency: string;
  perDay: { low: number; mid: number; high: number };
  total: { low: number; mid: number; high: number };
  rateDate: string | null;
  /** Indicative-rate disclaimer — ALWAYS render alongside converted amounts. */
  disclaimer: string;
}

export interface CostEstimateResponse {
  estimate: CostEstimate | null;
  /** Present only when budget_fx_conversion_enabled + a home currency was passed. */
  converted: CostEstimateConverted | null;
}

/**
 * Cost estimate WITH an optional FX conversion to `homeCurrency` (ISO 4217).
 * Additive companion to fetchCostEstimate — the existing callers are unchanged.
 * `converted` is null unless the server flag is on and rates are available; the
 * source-currency `estimate` is always the authoritative figure.
 */
export async function fetchCostEstimateWithFx(
  tripId: string,
  homeCurrency?: string,
  tier?: string,
): Promise<CostEstimateResponse | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const params = new URLSearchParams();
    if (tier) params.set('tier', tier);
    if (homeCurrency) params.set('home', homeCurrency);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/cost-estimate${qs}`);
    if (!res.ok) return null;
    const json = await res.json();
    return {
      estimate: (json.estimate ?? null) as CostEstimate | null,
      converted: (json.converted ?? null) as CostEstimateConverted | null,
    };
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
): Promise<SandboxResult | SandboxResultAvailable | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/budget/sandbox`, {
      method: 'POST',
      body: JSON.stringify(whatIf),
    });
    if (!res.ok) return null;
    const json = await res.json();
    // Backend returns { sandbox: SandboxResult, estimate: EstimateResult }
    return (json.sandbox ?? null) as SandboxResult | SandboxResultAvailable | null;
  } catch {
    return null;
  }
}

// ── Reservations ─────────────────────────────────────────────────────────────

export async function listReservations(tripId: string, status?: string): Promise<TripReservation[] | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/reservations${qs}`);
    if (!res.ok) return null; // 404 feature_disabled or other error → honest null
    const json = await res.json();
    return (json.reservations ?? []) as TripReservation[];
  } catch {
    return null;
  }
}

export async function importReservations(
  tripId: string,
  text: string,
  signal?: AbortSignal,
): Promise<{
  reservations: TripReservation[];
  error?: string;
} | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/reservations/import`, {
      method: 'POST',
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
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
    if (!res.ok) {
      let serverMsg: string | undefined;
      try { serverMsg = ((await res.json()) as { error?: string }).error; } catch { /* ignore */ }
      throw new Error(serverMsg ?? 'service_error');
    }
    return await res.json();
  } catch (err) {
    throw err;
  }
}
