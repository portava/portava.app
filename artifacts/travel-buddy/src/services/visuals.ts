/**
 * Visuals service — typed wrappers over /api/visuals/*.
 *
 * Covers the generate → poll → accept flow for AI-generated event/place
 * header images.  Authorization is server-enforced; the client only passes
 * the entity identifiers and an optional style preference.
 */
import { freshToken as freshApiToken } from './apiToken.ts';
import { isSupabaseConfigured } from '../lib/supabase.ts';

const BASE = (() => {
  const domain = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  return domain.endsWith('/') ? domain.slice(0, -1) : domain;
})();

// ── Shared types ──────────────────────────────────────────────────────────────

export type VisualStatus =
  | 'queued'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'blocked'
  | 'replaced';

export type VisualEntityType = 'event' | 'place' | 'trip' | 'city_guide' | 'group' | 'content';

export type VisualPurpose =
  | 'event_header'
  | 'place_header'
  | 'trip_cover'
  | 'city_guide_cover'
  | 'group_cover'
  | 'generic_content_header';

/** Raw shape returned by GET /api/visuals/:id — DB column names preserved. */
export interface GeneratedVisual {
  id: string;
  entity_type: VisualEntityType;
  entity_id: string;
  purpose: VisualPurpose;
  status: VisualStatus;
  style: string | null;
  /** Hero-size image URL (source_image_url from the DB row). */
  source_image_url: string | null;
  hero_path: string | null;
  moderation_status: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface VisualApiResult<T = void> {
  ok: boolean;
  data?: T;
  message?: string;
}

// ── Auth helper ───────────────────────────────────────────────────────────────

async function freshToken(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    return freshApiToken();
  } catch {
    return null;
  }
}

async function apiCall<T>(
  path: string,
  options: RequestInit = {},
): Promise<VisualApiResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Not authenticated' };

  try {
    const r = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers ?? {}),
      },
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, message: json.message ?? json.error ?? `HTTP ${r.status}` };
    return { ok: true, data: json as T };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? 'Network error' };
  }
}

// ── API wrappers ──────────────────────────────────────────────────────────────

export interface GenerateVisualInput {
  entityType: VisualEntityType;
  entityId: string;
  purpose: VisualPurpose;
  style?: string;
  preferences?: {
    people?: 'auto' | 'people' | 'no_people';
    timeOfDay?: 'auto' | 'morning' | 'afternoon' | 'sunset' | 'evening' | 'night';
    renderMode?: 'realistic' | 'illustrated';
    mood?: string;
  };
}

export interface GenerateVisualResponse {
  id: string;
  status: VisualStatus;
  entityType: VisualEntityType;
  entityId: string;
  purpose: VisualPurpose;
  style: string | null;
  imageUrl: string | null;
}

/** Request a new AI-generated visual. Returns immediately; poll for completion. */
export async function generateVisual(
  input: GenerateVisualInput,
): Promise<VisualApiResult<GenerateVisualResponse>> {
  return apiCall<GenerateVisualResponse>('/api/visuals/generate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Poll the status of a visual by ID. */
export async function getVisual(
  visualId: string,
): Promise<VisualApiResult<{ visual: GeneratedVisual }>> {
  return apiCall<{ visual: GeneratedVisual }>(`/api/visuals/${visualId}`);
}

/** Accept the visual — applies it to the entity and marks it as the active header. */
export async function acceptVisual(
  visualId: string,
): Promise<VisualApiResult<{ ok: boolean }>> {
  return apiCall<{ ok: boolean }>(`/api/visuals/${visualId}/accept`, { method: 'POST' });
}

/** Regenerate: retire the current visual and queue a fresh one with the same settings. */
export async function regenerateVisual(
  visualId: string,
): Promise<VisualApiResult<{ id: string; status: VisualStatus }>> {
  return apiCall<{ id: string; status: VisualStatus }>(
    `/api/visuals/${visualId}/regenerate`,
    { method: 'POST' },
  );
}
