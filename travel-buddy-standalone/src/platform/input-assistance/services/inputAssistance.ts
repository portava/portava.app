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
import { inputPolicyVersion } from '../contexts/inputContexts.ts';
import { sharedPolicyStore } from './policyStore.ts';
import { buildSuggestBody } from './suggestBody.ts';
import { parseSuggestBody, isSchemaCompatible, type RawSuggestBody } from './suggestResponse.ts';
import { CLIENT_SCHEMA_VERSION } from '../contexts/clientCapabilities.ts';

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
      body: JSON.stringify(buildSuggestBody(req)),
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

    // The envelope's coercions live in `suggestResponse.ts` — a pure module —
    // because this one imports the Supabase-backed token helper and therefore
    // cannot be reached by a node:test. Inline, they were unprovable.
    const parsed = parseSuggestBody((await res.json()) as RawSuggestBody);

    // §48 (census G341) — a serve whose RESPONSE SHAPE is newer than this build
    // is not an error and not an empty result: it is assistance this client
    // cannot safely read. `unavailable` is §38's own word for that, and it is
    // what makes the field fall back to its local zero-state instead of
    // rendering rows out of a shape it does not know.
    if (!isSchemaCompatible(parsed.schemaVersion, CLIENT_SCHEMA_VERSION)) {
      return {
        ok: false,
        aborted: false,
        unavailable: true,
        error: `Unsupported suggestion schema ${parsed.schemaVersion} (this build reads ${CLIENT_SCHEMA_VERSION})`,
      };
    }

    // The authority's own statement of which policy table produced this serve.
    // Recording it is what lets the store notice, under a live session, that
    // the table it holds has been retired — §48's promise, which had no
    // mechanism behind it while there was no endpoint to refetch from.
    sharedPolicyStore.noteServedVersion(parsed.policyVersion ?? null);

    return {
      ok: true,
      requestId: parsed.requestId,
      // §48 SKEW DETECTION, which this line used to defeat. It read
      // `?? INPUT_POLICY_VERSION` — a constant baked in at BUILD time — so a
      // deployment that sent no version was reported as running whatever
      // version the client was compiled against. The one field designed to
      // notice skew always agreed with itself. It now falls back to what the
      // store actually HOLDS (`'unfetched'` when it holds nothing).
      policyVersion: parsed.policyVersion ?? inputPolicyVersion(),
      suggestions: parsed.suggestions,
      // §44/§57 serve latency (census G372). ABSENT, never 0, when the server
      // did not send it — see suggestResponse.ts.
      serverMs: parsed.serverMs,
      schemaVersion: parsed.schemaVersion ?? undefined,
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    // A network failure (backend unreachable) is treated as unavailable, not a
    // hard error — the field falls back to local/cached suggestions (§38).
    return { ok: false, aborted, unavailable: !aborted, error: 'Network error' };
  }
}
