/**
 * Owner ruling 2026-10-17 — "Allow users to unarchive conversations."
 *
 * POST /api/threads/:threadId/unarchive (artifacts/api-server/src/routes/telegraphArchive.ts)
 * clears the CALLER'S OWN archived_at and answers the read-back
 * `{ ok: true, threadId, archivedAt: null, changed }`.
 *
 * ok ONLY when the server answered 2xx AND its read-back says the conversation
 * is unarchived — a body that says anything else is not an unarchive. A
 * failure carries the server's own sentence when it sent one (the caller runs
 * it through errorCopy), and is `null` otherwise. Never throws.
 *
 * Kept apart from services/messaging.ts on purpose, like inboxBandsApi.ts: the
 * inbox screen imports this, and the messaging service's import graph (E2EE,
 * the realtime client) is not what an inbox needs to load to send one POST.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export type UnarchiveResult = { ok: true } | { ok: false; message: string | null };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export async function unarchiveThread(threadId: string): Promise<UnarchiveResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, message: null };
  const token = await freshToken();
  if (!token) return { ok: false, message: null };
  try {
    const res = await fetch(`${apiBase()}/api/threads/${encodeURIComponent(threadId)}/unarchive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => null)) as { ok?: unknown; archivedAt?: unknown; message?: unknown } | null;
    if (!res.ok) return { ok: false, message: typeof body?.message === 'string' ? body.message : null };
    if (body?.ok !== true || body.archivedAt !== null) return { ok: false, message: null };
    return { ok: true };
  } catch {
    return { ok: false, message: null };
  }
}
