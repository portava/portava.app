/**
 * wallApi — the typed client for the Wall endpoints (Wall spec §26/§29).
 *
 *   GET    /api/wall?mode=&cursor=&session_intent=&limit=
 *   GET    /api/wall/live?limit=
 *   GET    /api/wall/quick-media?limit=
 *   POST   /api/wall/session-intent   { text }
 *   DELETE /api/wall/session-intent
 *   POST   /api/wall/impression       { objectId, objectType, session? }
 *   POST   /api/wall/action           { objectId, objectType, action, session? }
 *
 * FAIL-SOFT BY DESIGN (spec §34 / §40). The Wall is flag-gated OFF server-side,
 * so `feature_disabled` and "not configured / not authenticated" are NORMAL,
 * not errors: `fetchWall` returns an empty, well-formed WallResponse with
 * `degraded: true` so a safe (empty) social feed still renders. Only genuine
 * transport failures surface as `{ ok: false }`, and even then the caller keeps
 * whatever it already had — a safe social feed always remains.
 *
 * The mutation endpoints (impression/action) are strictly fire-and-forget and
 * carry only ids — never `text` or any private content (spec §32).
 */

import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';
import type {
  QuickMediaItem,
  StructuredIntent,
  WallMode,
  WallProjection,
  WallResponse,
} from '../types/wallProjection.ts';
import type { LiveForYouItem } from '../types/liveForYou.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** The mutation-action verbs the server's POST /wall/action accepts. */
export type WallActionEvent =
  | 'open'
  | 'tap'
  | 'save'
  | 'hide'
  | 'report'
  | 'follow'
  | 'share';

export interface FetchWallOptions {
  mode: WallMode;
  cursor?: string | null;
  /** Temporary typed steer for THIS request only (spec §17); not persisted. */
  sessionIntent?: string | null;
  limit?: number;
  signal?: AbortSignal;
}

export type FetchWallResult =
  | { ok: true; data: WallResponse; degraded: boolean }
  | { ok: false; error: string };

export type FetchLiveResult =
  | { ok: true; liveForYou: LiveForYouItem[]; degraded: boolean }
  | { ok: false; error: string };

export type FetchQuickMediaResult =
  | { ok: true; items: QuickMediaItem[]; degraded: boolean }
  | { ok: false; error: string };

export type SessionIntentResult =
  | { ok: true; sessionIntent: StructuredIntent }
  | { ok: false; error: string; disabled?: boolean };

/** A safe, empty response — used for "not configured", "disabled", parse fail. */
function emptyWallResponse(mode: WallMode): WallResponse {
  return {
    mode,
    liveForYou: [],
    items: [],
    generatedAt: new Date().toISOString(),
  };
}

/** Normalize a raw body into a well-formed WallResponse (never crashes render). */
function normalizeWallResponse(mode: WallMode, body: Partial<WallResponse>): WallResponse {
  return {
    mode: body.mode === 'following' || body.mode === 'for_you' ? body.mode : mode,
    sessionIntent: body.sessionIntent,
    liveForYou: Array.isArray(body.liveForYou) ? body.liveForYou : [],
    items: Array.isArray(body.items) ? (body.items as WallProjection[]) : [],
    nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : undefined,
    caughtUp: body.caughtUp === true,
    generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : new Date().toISOString(),
  };
}

async function readErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? `http_${res.status}`;
  } catch {
    return `http_${res.status}`;
  }
}

// ── GET /wall ────────────────────────────────────────────────────────────────

export async function fetchWall(opts: FetchWallOptions): Promise<FetchWallResult> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: true, data: emptyWallResponse(opts.mode), degraded: true };
  }
  const token = await freshToken();
  if (!token) {
    // Not signed in — a safe empty feed, not an error screen.
    return { ok: true, data: emptyWallResponse(opts.mode), degraded: true };
  }

  const params = new URLSearchParams({ mode: opts.mode });
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.sessionIntent && opts.sessionIntent.trim()) {
    params.set('session_intent', opts.sessionIntent.trim());
  }
  if (opts.limit != null) params.set('limit', String(opts.limit));

  try {
    const res = await fetch(`${apiBase()}/api/wall?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: opts.signal,
    });
    if (!res.ok) {
      const code = await readErrorCode(res);
      // The Wall being disabled is a normal, degraded-but-safe state.
      if (code === 'feature_disabled') {
        return { ok: true, data: emptyWallResponse(opts.mode), degraded: true };
      }
      return { ok: false, error: code };
    }
    const body = (await res.json()) as Partial<WallResponse>;
    return { ok: true, data: normalizeWallResponse(opts.mode, body), degraded: false };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, error: 'aborted' };
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}

// ── GET /wall/live ───────────────────────────────────────────────────────────

export async function fetchLiveForYou(opts: {
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<FetchLiveResult> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: true, liveForYou: [], degraded: true };
  }
  const token = await freshToken();
  if (!token) return { ok: true, liveForYou: [], degraded: true };

  const params = new URLSearchParams();
  if (opts.limit != null) params.set('limit', String(opts.limit));

  try {
    const res = await fetch(`${apiBase()}/api/wall/live?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: opts.signal,
    });
    if (!res.ok) {
      const code = await readErrorCode(res);
      if (code === 'feature_disabled') return { ok: true, liveForYou: [], degraded: true };
      return { ok: false, error: code };
    }
    const body = (await res.json()) as { liveForYou?: LiveForYouItem[] };
    return {
      ok: true,
      liveForYou: Array.isArray(body.liveForYou) ? body.liveForYou : [],
      degraded: false,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, error: 'aborted' };
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}

// ── GET /wall/quick-media (spec §18) ─────────────────────────────────────────

/**
 * The Stories / Quick Media row's data source. Same fail-soft contract as the
 * live strip: "not configured / not signed in / feature disabled" is an empty,
 * degraded row — never an error the feed has to show.
 */
export async function fetchQuickMedia(opts: {
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<FetchQuickMediaResult> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: true, items: [], degraded: true };
  }
  const token = await freshToken();
  if (!token) return { ok: true, items: [], degraded: true };

  const params = new URLSearchParams();
  if (opts.limit != null) params.set('limit', String(opts.limit));

  try {
    const res = await fetch(`${apiBase()}/api/wall/quick-media?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: opts.signal,
    });
    if (!res.ok) {
      const code = await readErrorCode(res);
      if (code === 'feature_disabled') return { ok: true, items: [], degraded: true };
      return { ok: false, error: code };
    }
    const body = (await res.json()) as { items?: QuickMediaItem[] };
    return {
      ok: true,
      items: Array.isArray(body.items) ? body.items : [],
      degraded: false,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, error: 'aborted' };
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}

// ── POST /wall/session-intent ────────────────────────────────────────────────

export async function setSessionIntent(text: string): Promise<SessionIntentResult> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, error: 'not_configured', disabled: true };
  }
  const token = await freshToken();
  if (!token) return { ok: false, error: 'not_authenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/wall/session-intent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const code = await readErrorCode(res);
      return { ok: false, error: code, disabled: code === 'feature_disabled' };
    }
    const body = (await res.json()) as { sessionIntent?: StructuredIntent };
    if (!body.sessionIntent) return { ok: false, error: 'malformed_response' };
    return { ok: true, sessionIntent: body.sessionIntent };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}

// ── DELETE /wall/session-intent ──────────────────────────────────────────────

export async function clearSessionIntent(): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true };
  const token = await freshToken();
  if (!token) return { ok: true };

  try {
    const res = await fetch(`${apiBase()}/api/wall/session-intent`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, error: await readErrorCode(res) };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}

// ── POST /wall/impression + /wall/action (fire-and-forget, ids only) ─────────

export interface WallMutationTarget {
  objectId: string;
  objectType: string;
  session?: string | null;
}

async function postJson(path: string, payload: Record<string, unknown>): Promise<void> {
  if (!isSupabaseConfigured || !apiBase()) return;
  const token = await freshToken();
  if (!token) return;
  try {
    await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Fire-and-forget: an impression/action that fails to record must never
    // affect the feed the user is looking at (spec §40).
  }
}

/** Record that an object was seen. Carries ONLY ids (never text — spec §32). */
export async function sendImpression(target: WallMutationTarget): Promise<void> {
  await postJson('/api/wall/impression', {
    objectId: target.objectId,
    objectType: target.objectType,
    ...(target.session ? { session: target.session } : {}),
  });
}

/** Record a user action on an object. Carries ONLY ids + verb (never text). */
export async function sendAction(
  target: WallMutationTarget,
  action: WallActionEvent,
): Promise<void> {
  await postJson('/api/wall/action', {
    objectId: target.objectId,
    objectType: target.objectType,
    action,
    ...(target.session ? { session: target.session } : {}),
  });
}
