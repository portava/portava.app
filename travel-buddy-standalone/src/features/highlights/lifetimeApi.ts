/**
 * §4 / §5 / §12 — Highlight lifetime classes and pinning, client side.
 *
 * Highlights/Memories Development Architecture Spec v1 §4 (the five
 * HighlightLifetime values), §12 (their behaviour, and "pinned/manual order
 * always outranks automatic ordering") and §5 (the lifecycle, which includes
 * PINNED).
 *
 * Census H94–H98 and H142/H143. Migration 2723 put `lifetime_class`,
 * `lifecycle_state` and `pinned_at` on `public.highlights` and was applied on
 * 2026-09-15; what did not exist was any writer or any surface. This module is
 * the client half of both.
 *
 * ── THE CLASS LIST COMES FROM THE SERVER ───────────────────────────────────
 * §12's five classes carry the spec's own words for what each one does, and the
 * server sends them with the row. A client that retyped them would drift from
 * the spec silently — and, more importantly, would offer PERMANENT on a
 * deployment that cannot store it. `mayNotBeStorable` is how the server says so
 * without claiming a nullability nothing can probe; a create that is refused
 * reports `feature_disabled` and the screen says which.
 */
import { isSupabaseConfigured } from '../../lib/supabase.ts';
import { freshToken as freshApiToken } from '../../services/apiToken.ts';

export type HighlightLifetimeClass = 'LIVE' | 'DAY' | 'TRIP' | 'SEASONAL' | 'PERMANENT';

export interface LifetimeClassOption {
  cls: HighlightLifetimeClass;
  /** §12's own example, e.g. "Day 4 in Da Nang". */
  example: string;
  /** §12's own sentence about what the class does. */
  defaultBehavior: string;
  /** PERMANENT needs migration 2975's nullable expires_at; nothing can probe it. */
  mayNotBeStorable: boolean;
}

export interface LifetimeClassesView {
  /** False when migration 2723 has not landed: no class is storable at all. */
  deployed: boolean;
  classes: LifetimeClassOption[];
  reason: string | null;
}

export type LifetimeResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'not_available' | 'not_found' | 'unavailable' | 'unauthenticated'; detail: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function request<T>(path: string, method: string): Promise<LifetimeResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, kind: 'unavailable', detail: 'Backend not configured' };
  }
  const token = await freshApiToken();
  if (!token) return { ok: false, kind: 'unauthenticated', detail: 'Not signed in' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, data: body as T };
    // `feature_disabled` is PERMANENT on this deployment and must not be
    // offered a retry; everything else is transient or the caller's fault.
    if (body?.error === 'feature_disabled') {
      return { ok: false, kind: 'not_available', detail: body?.message ?? 'Not available on this version.' };
    }
    if (res.status === 404) return { ok: false, kind: 'not_found', detail: body?.message ?? 'Highlight not found' };
    return { ok: false, kind: 'unavailable', detail: body?.message ?? `API ${res.status}` };
  } catch (e) {
    return { ok: false, kind: 'unavailable', detail: e instanceof Error ? e.message : 'Unknown error' };
  }
}

/** §12's five, in the spec's words, with what this deployment can hold. */
export async function fetchLifetimeClasses(): Promise<LifetimeResult<LifetimeClassesView>> {
  return request<LifetimeClassesView>('/api/highlights/lifetime-classes', 'GET');
}

/** §12 manual_pin. */
export async function pinHighlight(highlightId: string): Promise<LifetimeResult<{ id: string; pinnedAt: string }>> {
  return request(`/api/highlights/${highlightId}/pin`, 'POST');
}

/** §17 UNPIN_HIGHLIGHT. A pin a user cannot undo is a trap, not curation. */
export async function unpinHighlight(highlightId: string): Promise<LifetimeResult<{ id: string; pinnedAt: null }>> {
  return request(`/api/highlights/${highlightId}/pin`, 'DELETE');
}
