/**
 * useVisualGeneration — shared hook for AI visual header generation.
 *
 * Encapsulates all API calls for:
 *   - POST /api/visuals/generate        (first-time request)
 *   - POST /api/visuals/:id/regenerate  (re-generate with same or new style)
 *   - POST /api/visuals/:id/accept      (mark accepted)
 *   - DELETE /api/visuals/:id           (soft-remove → status = replaced)
 *   - GET  /api/visuals/entity/:type/:id (initial state fetch)
 *   - GET  /api/visuals/:id              (poll while queued/generating)
 *
 * entityId may be null when the entity doesn't exist yet (create form).
 * All actions are no-ops while entityId is null; pass an override to
 * requestGeneration/regenerate to fire before the parent state updates.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';
import { freshToken } from '../services/apiToken.ts';

// ── Client-side type mirrors (no server import) ───────────────────────────────

export type VisualStyle =
  | 'portava_editorial'
  | 'cinematic_travel'
  | 'premium_nightlife'
  | 'tropical_social'
  | 'urban_explorer'
  | 'food_and_dining'
  | 'outdoor_adventure'
  | 'minimal_illustration'
  | 'passport_poster'
  | 'colorful_festival';

export type GenerationStatus =
  | 'not_requested'
  | 'queued'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'blocked'
  | 'replaced';

export type VisualEntityType =
  | 'event'
  | 'place'
  | 'trip'
  | 'city_guide'
  | 'group'
  | 'content';

export type VisualPurpose =
  | 'event_header'
  | 'place_header'
  | 'trip_cover'
  | 'city_guide_cover'
  | 'group_cover'
  | 'generic_content_header';

export interface GeneratedVisual {
  id: string;
  /** Best available image URL (hero_path > source_image_url). Null while generating. */
  imageUrl: string | null;
  style: string;
  status: GenerationStatus;
}

export interface UseVisualGenerationResult {
  status: GenerationStatus;
  generatedVisual: GeneratedVisual | null;
  error: string | null;
  isLoading: boolean;
  /** True when both ai_event_headers_enabled AND ai_visual_provider_enabled flags are on. */
  generationEnabled: boolean;
  /**
   * Request first-time generation. Pass entityIdOverride to use a different ID than
   * the one the hook was initialised with (useful in create-form flows where the
   * entity is created just before generation is triggered).
   */
  requestGeneration: (style?: VisualStyle, entityIdOverride?: string) => Promise<void>;
  /**
   * Re-generate. If a style is supplied the server creates a fresh request with that
   * style; otherwise the existing visual is re-queued via the /regenerate endpoint.
   * Accepts the same entityIdOverride escape hatch as requestGeneration.
   */
  regenerate: (style?: VisualStyle, entityIdOverride?: string) => Promise<void>;
  accept: () => Promise<void>;
  remove: () => Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE = (() => {
  const d = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  return d.endsWith('/') ? d.slice(0, -1) : d;
})();

const POLL_INTERVAL_MS = 2500;
const POLL_STATUSES = new Set<GenerationStatus>(['queued', 'generating']);

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  message?: string;
}

async function apiReq<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: object,
): Promise<ApiResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Not authenticated' };
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, message: json.message ?? json.error ?? `HTTP ${r.status}` };
    return { ok: true, data: json as T };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

function parseVisualRow(row: Record<string, unknown>): GeneratedVisual {
  const sourceImageUrl = (row.source_image_url as string | null) ?? null;
  const heroPath       = (row.hero_path as string | null) ?? null;
  // hero_path is a storage path (e.g. "generated-visuals/event/…/hero.jpg"),
  // NOT a directly renderable URL. Prefer source_image_url (the provider's
  // HTTP URL). Only accept hero_path if it is itself an absolute URL (some
  // storage configs may return a signed public URL here).
  const imageUrl =
    (sourceImageUrl?.startsWith('http') ? sourceImageUrl : null) ??
    (heroPath?.startsWith('http')       ? heroPath       : null) ??
    null;
  return {
    id: row.id as string,
    imageUrl,
    style: (row.style as string) ?? 'portava_editorial',
    status: (row.status as GenerationStatus) ?? 'not_requested',
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useVisualGeneration(
  entityType: VisualEntityType,
  entityId: string | null,
  purpose: VisualPurpose,
): UseVisualGenerationResult {
  const { isEnabled } = useFeatureFlags();

  const [status, setStatus]                   = useState<GenerationStatus>('not_requested');
  const [generatedVisual, setGeneratedVisual] = useState<GeneratedVisual | null>(null);
  const [error, setError]                     = useState<string | null>(null);
  const [isLoading, setIsLoading]             = useState(false);

  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // ── Polling ────────────────────────────────────────────────────────────────

  const startPolling = useCallback((visualId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      if (!mountedRef.current) { if (pollRef.current) clearInterval(pollRef.current); return; }
      const res = await apiReq<{ visual: Record<string, unknown> }>('GET', `/api/visuals/${visualId}`);
      if (!mountedRef.current) return;
      if (!res.ok || !res.data?.visual) return;
      const v = parseVisualRow(res.data.visual);
      setGeneratedVisual(v);
      setStatus(v.status);
      if (!POLL_STATUSES.has(v.status)) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, POLL_INTERVAL_MS);
  }, []);

  // ── Reinitialise when entityId changes ─────────────────────────────────────

  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setStatus('not_requested');
    setGeneratedVisual(null);
    setError(null);
    if (!entityId) return;

    // Fetch existing visuals for this entity so the picker shows the current state.
    (async () => {
      const res = await apiReq<{ visuals: Record<string, unknown>[] }>(
        'GET', `/api/visuals/entity/${entityType}/${entityId}`,
      );
      if (!mountedRef.current) return;
      if (!res.ok || !res.data?.visuals?.length) return;
      const latest = res.data.visuals.find(
        (v) => v.status !== 'replaced' && (v.purpose === purpose || !purpose),
      );
      if (!latest) return;
      const visual = parseVisualRow(latest);
      setGeneratedVisual(visual);
      setStatus(visual.status);
      if (POLL_STATUSES.has(visual.status)) startPolling(visual.id as string);
    })().catch(() => {});
  }, [entityId, entityType, purpose, startPolling]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const requestGeneration = useCallback(async (
    style?: VisualStyle,
    entityIdOverride?: string,
  ) => {
    const eid = entityIdOverride ?? entityId;
    if (!eid) return;
    setIsLoading(true);
    setError(null);

    const res = await apiReq<{ id: string; status: string }>('POST', '/api/visuals/generate', {
      entityType,
      entityId: eid,
      purpose,
      style: style ?? 'portava_editorial',
    });

    if (!mountedRef.current) return;
    setIsLoading(false);

    if (!res.ok || !res.data) {
      setError(res.message ?? 'Generation failed');
      setStatus('failed');
      return;
    }

    const nextStatus = res.data.status as GenerationStatus;
    const visual: GeneratedVisual = {
      id: res.data.id,
      imageUrl: null,
      style: style ?? 'portava_editorial',
      status: nextStatus,
    };
    setGeneratedVisual(visual);
    setStatus(nextStatus);
    if (POLL_STATUSES.has(nextStatus)) startPolling(res.data.id);
  }, [entityId, entityType, purpose, startPolling]);

  const regenerate = useCallback(async (
    style?: VisualStyle,
    entityIdOverride?: string,
  ) => {
    const eid = entityIdOverride ?? entityId;
    if (!eid) return;

    // If we have no prior visual or a style override was requested, use the generate endpoint.
    if (!generatedVisual || style) {
      return requestGeneration(style, eid);
    }

    setIsLoading(true);
    setError(null);
    const res = await apiReq<{ id: string; status: string }>(
      'POST', `/api/visuals/${generatedVisual.id}/regenerate`,
    );
    if (!mountedRef.current) return;
    setIsLoading(false);
    if (!res.ok || !res.data) { setError(res.message ?? 'Regeneration failed'); setStatus('failed'); return; }

    const nextStatus = res.data.status as GenerationStatus;
    const visual: GeneratedVisual = {
      id: res.data.id,
      imageUrl: null,
      style: generatedVisual.style,
      status: nextStatus,
    };
    setGeneratedVisual(visual);
    setStatus(nextStatus);
    if (POLL_STATUSES.has(nextStatus)) startPolling(res.data.id);
  }, [entityId, generatedVisual, requestGeneration, startPolling]);

  const accept = useCallback(async () => {
    if (!generatedVisual || status !== 'ready') return;
    const res = await apiReq('POST', `/api/visuals/${generatedVisual.id}/accept`);
    if (!mountedRef.current) return;
    if (!res.ok) setError(res.message ?? 'Accept failed');
  }, [generatedVisual, status]);

  const remove = useCallback(async () => {
    if (!generatedVisual) return;
    const res = await apiReq('DELETE', `/api/visuals/${generatedVisual.id}`);
    if (!mountedRef.current) return;
    if (!res.ok) { setError(res.message ?? 'Remove failed'); return; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setStatus('not_requested');
    setGeneratedVisual(null);
  }, [generatedVisual]);

  const generationEnabled =
    isEnabled('ai_event_headers_enabled') && isEnabled('ai_visual_provider_enabled');

  return {
    status,
    generatedVisual,
    error,
    isLoading,
    generationEnabled,
    requestGeneration,
    regenerate,
    accept,
    remove,
  };
}
