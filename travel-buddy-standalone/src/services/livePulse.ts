/**
 * Live Pulse service — typed fetch helpers for GET /api/pulse/live.
 *
 * Session-scoped dismiss list is stored in module-level memory (not persisted
 * to DB for beta) so dismissed cards don't reappear within the same session.
 */
import { freshToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LivePulseItemType =
  | 'event'
  | 'trip'
  | 'trip_request'
  | 'buddy_request'
  | 'available_buddy'
  | 'hidden_gem'
  | 'compass'
  | 'circle'
  | 'safe_return';

export type LivePulseStatusLabel =
  | 'Starting Soon'
  | 'Ongoing'
  | 'Ends Soon'
  | 'Tonight'
  | 'Tomorrow'
  | 'Upcoming'
  | 'Action Needed'
  | 'My Plan';

export interface LivePulseItem {
  id: string;
  item_type: LivePulseItemType;
  item_id: string;
  status_label: LivePulseStatusLabel;
  title: string;
  subtitle: string | null;
  city: string | null;
  starts_at: string | null;
  ends_at: string | null;
  people_count: number | null;
  user_relationship: 'host' | 'joined' | 'saved' | 'pending' | 'available' | null;
  primary_action: { label: string; type: string } | null;
  secondary_action: { label: string; type: string } | null;
  reason_labels: string[];
  expires_at: string | null;
  is_joinable: boolean;
}

export type LivePulseContext =
  | 'nearMe'
  | 'currentCity'
  | 'tripCity'
  | 'savedCity'
  | 'specificTrip'
  | 'myPlans';

export interface GetLivePulseParams {
  context?: LivePulseContext;
  lat?: number | null;
  lng?: number | null;
  citySlug?: string | null;
}

// ── Session-scoped dismiss store ──────────────────────────────────────────────

const _dismissed = new Set<string>();

/**
 * Mark a card as dismissed for the current session.
 * Dismissed cards are excluded by isLivePulseDismissed() and by useLivePulse.
 */
export function dismissLivePulseItem(id: string): void {
  _dismissed.add(id);
}

/** Check whether a card has been dismissed this session. */
export function isLivePulseDismissed(id: string): boolean {
  return _dismissed.has(id);
}

/** Cards that are dismissible (editorial / discovery type; never safety). */
export function isLivePulseDismissible(item: LivePulseItem): boolean {
  if (item.item_type === 'safe_return') return false;
  return (
    item.item_type === 'hidden_gem' ||
    item.item_type === 'compass' ||
    item.item_type === 'available_buddy'
  );
}

/** Clear the entire dismiss store (e.g. on sign-out). */
export function clearDismissedItems(): void {
  _dismissed.clear();
}

// ── API call ──────────────────────────────────────────────────────────────────

export async function getLivePulseItems(
  params: GetLivePulseParams = {},
): Promise<{ ok: true; items: LivePulseItem[] } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  const qs = new URLSearchParams();
  if (params.context)  qs.set('context', params.context);
  if (params.lat != null) qs.set('lat', String(params.lat));
  if (params.lng != null) qs.set('lng', String(params.lng));
  if (params.citySlug) qs.set('citySlug', params.citySlug);

  try {
    const res = await fetch(`${base}/api/pulse/live?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { ok: false, error: (body.message as string) ?? `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { items: LivePulseItem[] };
    return { ok: true, items: data.items ?? [] };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}
