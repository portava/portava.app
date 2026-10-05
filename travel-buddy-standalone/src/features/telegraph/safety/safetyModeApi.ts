/**
 * Telegraph §15.2 — the conversation's safety mode, read from the server.
 *
 *   GET /api/threads/:threadId/safety-mode
 *
 * The server derives the mode from what people SAID in this conversation (a
 * §6.2 SAFETY message, a §9.1 NEED_HELP) and serves §15.2's promotion list in
 * the spec's own order (`services/telegraph/safetyMode.ts` SAFETY_PROMOTED), so
 * both clients promote the same affordances in the same order rather than each
 * deciding urgency for itself.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export type SafetyMode = 'NORMAL' | 'SAFETY_ATTENTION' | 'SAFETY_EVENT';

/** §15.2's seven, as the server names them. An id this build does not know is ignored, never guessed at. */
export type SafetyAffordanceId =
  | 'TRUSTED_CONTACT'
  | 'CURRENT_STATUS'
  | 'OFFICIAL_HELP'
  | 'ROUTE_OR_RETURN'
  | 'CALL'
  | 'BLOCK_OR_REPORT'
  | 'LOCATION_SCOPE';

export interface SafetyModeResponse {
  threadId: string;
  generatedAt: string;
  mode: SafetyMode;
  since: string | null;
  raisedBy: string | null;
  clearedAt: string | null;
  reason: string;
  affordances: { promoted: string[]; deprioritized: string[] };
  derivedFrom: 'THREAD_SAFETY_SIGNALS_ONLY';
}

export type SafetyModeResult = { ok: true; data: SafetyModeResponse } | { ok: false; error: string; message?: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export async function fetchSafetyMode(threadId: string): Promise<SafetyModeResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/threads/${threadId}/safety-mode`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      return { ok: false, error: String(body?.error ?? res.status), message: body?.message };
    }
    return { ok: true, data: (await res.json()) as SafetyModeResponse };
  } catch (e) {
    return { ok: false, error: 'network', message: e instanceof Error ? e.message : undefined };
  }
}

/** True when the mode is raised (anything but NORMAL). */
export function isSafetyRaised(mode: SafetyMode | null | undefined): boolean {
  return mode === 'SAFETY_ATTENTION' || mode === 'SAFETY_EVENT';
}

/** §15.2 "de-prioritizes entertainment" — read from the server's list, not assumed from the mode. */
export function deprioritizesEntertainment(r: SafetyModeResponse | null | undefined): boolean {
  return Boolean(r && isSafetyRaised(r.mode) && r.affordances.deprioritized.includes('ENTERTAINMENT'));
}
