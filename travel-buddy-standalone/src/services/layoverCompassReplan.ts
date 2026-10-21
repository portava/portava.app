import { freshToken } from './apiToken.ts';

export interface CompassReplanAction {
  id: string; kind: 'recheck_current_facts'; snapshotId: string; expiresAt: string;
}
export function compassReplanAction(value: unknown): CompassReplanAction | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  if (a.kind !== 'recheck_current_facts' || typeof a.id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(a.id)
    || typeof a.snapshotId !== 'string' || !a.snapshotId || typeof a.expiresAt !== 'string' || !Number.isFinite(Date.parse(a.expiresAt))) return null;
  return { id: a.id, kind: 'recheck_current_facts', snapshotId: a.snapshotId, expiresAt: a.expiresAt };
}
export type CompassReplanResult = { ok: true; state: 'applied' | 'partial' | 'failed'; message: string } | { ok: false; message: string };
export async function applyCompassReplan(sessionId: string, actionId: string): Promise<CompassReplanResult> {
  try {
    const token = await freshToken();
    const res = await fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL ?? ''}/api/airport/sessions/${encodeURIComponent(sessionId)}/compass/replan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ actionId, confirmed: true }),
    });
    const body = await res.json();
    const state = body?.result?.state;
    if (body?.ok === true && (state === 'applied' || state === 'partial' || state === 'failed')) {
      if (state === 'applied' && res.ok) return { ok: true, state, message: 'Plan rechecked. Review your updated recommendations.' };
      return { ok: true, state: state === 'applied' ? 'partial' : state, message: state === 'failed' ? 'The recheck could not finish. Ask Compass again for a new recheck.' : 'Some updates completed, but the recheck could not finish. Review your latest plan before continuing.' };
    }
    const messages: Record<string, string> = {
      action_expired: 'This recheck offer expired. Ask Compass again.', action_stale: 'Your layover changed. Ask Compass again for a current recheck.',
      action_in_progress: 'This recheck is already running. Try the same action again shortly.',
      session_ended: 'This layover has ended.', feature_disabled: 'Plan rechecking is unavailable right now.',
    };
    return { ok: false, message: messages[body?.reason ?? body?.error] ?? 'Could not confirm whether the recheck finished. Retry this same action to check its result.' };
  } catch {
    return { ok: false, message: 'Could not confirm whether the recheck finished. Retry this same action to check its result.' };
  }
}
