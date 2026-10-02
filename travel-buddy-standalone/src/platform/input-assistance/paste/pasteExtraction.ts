/**
 * Global Input Intelligence — §24 Paste Intelligence, the client of
 * `POST /api/input-assistance/extract` (flow GII-F08).
 *
 * Never throws, and never turns a failure into an empty answer: every way this
 * can go wrong comes back as `{ ok: false, error, retryable }`, which the review
 * screen shows as an error with Retry. Only an answer that parses as the
 * contract (`pasteReview.ts#parsePasteExtraction`, which also insists the
 * server said `mutated: false`) is a review.
 *
 * Imports the Supabase-backed token helper, so it is exercised under jest, not
 * node:test.
 */
import { freshToken } from '../../../services/apiToken.ts';
import type { InputContext } from '../types/inputContext.ts';
import type { InputSessionContext } from '../types/inputSuggestion.ts';
import { parsePasteExtraction, type PasteExtraction } from './pasteReview.ts';

export interface PasteExtractRequest {
  context: InputContext;
  fieldId: string;
  text: string;
  sessionContext?: InputSessionContext;
}

export type PasteExtractResult =
  | { ok: true; data: PasteExtraction }
  | { ok: false; error: string; retryable: boolean };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export async function extractPastedEntities(
  req: PasteExtractRequest,
  signal?: AbortSignal,
): Promise<PasteExtractResult> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'Reading pasted places isn’t available on this build.', retryable: false };
  let token: string | null = null;
  try {
    token = await freshToken();
  } catch {
    token = null;
  }
  if (!token) return { ok: false, error: 'Sign in to read pasted places.', retryable: false };

  let res: Response;
  try {
    res = await fetch(`${base}/api/input-assistance/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        context: req.context,
        fieldId: req.fieldId,
        text: req.text,
        ...(req.sessionContext ? { sessionContext: req.sessionContext } : {}),
      }),
      signal,
    });
  } catch {
    return { ok: false, error: 'Couldn’t reach Portava. Check your connection and try again.', retryable: true };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === 'string' ? body.message : null;
    if (res.status === 429) return { ok: false, error: 'Too many pastes at once. Wait a minute and try again.', retryable: true };
    if (res.status >= 500) return { ok: false, error: message ?? 'We couldn’t read that paste. Try again.', retryable: true };
    return { ok: false, error: message ?? `That paste couldn’t be read (HTTP ${res.status}).`, retryable: false };
  }

  const parsed = parsePasteExtraction(await res.json().catch(() => null));
  if (!parsed) return { ok: false, error: 'We got an answer we couldn’t read. Try again.', retryable: true };
  return { ok: true, data: parsed };
}
