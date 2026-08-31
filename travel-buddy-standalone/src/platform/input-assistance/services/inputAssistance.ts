/**
 * Global Input Intelligence — the client gateway to the suggest endpoint.
 *
 * Thin fetch client for the canonical `POST /input-assistance/suggest` (spec
 * §41). Mirrors the app's established service conventions (apiBase +
 * refresh-first token from apiToken.ts, `{ ok }` result envelope, never throws).
 *
 * DEGRADE-GRACEFULLY CONTRACT (§38 failure fallback ladder): the backend is
 * built by a parallel effort and may land separately. If the endpoint is
 * missing (404 / 501) or the network fails, this returns `{ ok: false,
 * unavailable: true }` so the hook shows "no suggestions" instead of an error —
 * the input UI must never collapse because assistance is offline.
 *
 * This module imports the Supabase-backed token helper, so it must NOT be
 * imported by node:test files (those exclude RN). Hooks import it; tests do not.
 */
import { freshToken as freshApiToken } from '../../../services/apiToken.ts';
import type {
  InputSuggestion,
  SuggestRequest,
  SuggestResult,
} from '../types/inputSuggestion.ts';
import { INPUT_POLICY_VERSION } from '../contexts/inputContexts.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  try {
    return await freshApiToken();
  } catch {
    return null;
  }
}

/** Endpoint statuses that mean "backend not deployed here" → degrade silently. */
function isUnavailableStatus(status: number): boolean {
  return status === 404 || status === 501 || status === 405;
}

/**
 * Request suggestions for a field. Never throws.
 *
 * @param req     the §41 request body (context, fieldId, text, limit, sessionContext)
 * @param signal  AbortSignal so the caller can cancel a superseded keystroke (§33)
 */
export async function requestSuggestions(
  req: SuggestRequest,
  signal?: AbortSignal,
): Promise<SuggestResult> {
  const base = apiBase();
  if (!base) {
    return { ok: false, aborted: false, unavailable: true, error: 'API not configured' };
  }

  const token = await freshToken();
  // No token → treat as unavailable rather than an error; unauthenticated
  // surfaces still get local zero-state from the hook.
  if (!token) {
    return { ok: false, aborted: false, unavailable: true, error: 'Not signed in' };
  }

  try {
    const res = await fetch(`${base}/input-assistance/suggest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        context: req.context,
        fieldId: req.fieldId,
        text: req.text,
        limit: req.limit,
        sessionContext: req.sessionContext,
      } satisfies SuggestRequest),
      signal,
    });

    if (!res.ok) {
      return {
        ok: false,
        aborted: false,
        unavailable: isUnavailableStatus(res.status),
        error: `HTTP ${res.status}`,
      };
    }

    const body = (await res.json()) as {
      requestId?: string;
      policyVersion?: string;
      suggestions?: InputSuggestion[];
    };

    return {
      ok: true,
      requestId: body.requestId ?? '',
      policyVersion: body.policyVersion ?? INPUT_POLICY_VERSION,
      suggestions: Array.isArray(body.suggestions) ? body.suggestions : [],
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    // A network failure (backend unreachable) is treated as unavailable, not a
    // hard error — the field falls back to local/cached suggestions (§38).
    return { ok: false, aborted, unavailable: !aborted, error: 'Network error' };
  }
}
