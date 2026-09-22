/**
 * Global Input Intelligence §48 / G340 — the fetch half of the policy sync.
 *
 * Thin client for `GET /input-assistance/policies`. Mirrors
 * `inputAssistance.ts`'s conventions exactly: apiBase + refresh-first token,
 * an `{ ok }` envelope, and it NEVER throws.
 *
 * This module imports the Supabase-backed token helper, so it must not be
 * imported by node:test files. Everything it produces is narrowed by
 * `policyFallback.ts` and stored by `policyStore.ts`, both of which are pure
 * and ARE tested — so the untestable part of this path is only the fetch call
 * itself, and it is kept to that.
 *
 * DEGRADE-GRACEFULLY, AND NOTE WHICH DIRECTION THAT IS. For the suggest
 * endpoint, "unavailable" means show no suggestions. Here it means something
 * stronger: the store keeps whatever it already trusted and, if it has nothing,
 * every field stays at the conservative policy. A failed policy fetch can
 * therefore only ever REDUCE what the app does. There is no branch in this file
 * that makes a field more capable.
 */
import { freshToken as freshApiToken } from '../../../services/apiToken.ts';

export type {
  PolicyFetchOk,
  PolicyFetchFail,
  PolicyFetchResult,
} from './policySync.ts';
import type { PolicyFetchResult } from './policySync.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Endpoint statuses that mean "backend not deployed here" → degrade silently. */
function isUnavailableStatus(status: number): boolean {
  return status === 404 || status === 501 || status === 405;
}

/**
 * Fetch the authority's policy table. Never throws.
 *
 * The response is returned RAW — `policyVersion` as whatever arrived and
 * `contexts` unvalidated — because narrowing belongs in one place
 * (`sanitizeServedPolicy`, reached via `PolicyStore.install`) and duplicating
 * it here would create a second opinion about what a valid policy is.
 */
export async function fetchInputPolicies(signal?: AbortSignal): Promise<PolicyFetchResult> {
  const base = apiBase();
  if (!base) return { ok: false, unavailable: true, error: 'API not configured' };

  let token: string | null = null;
  try {
    token = await freshApiToken();
  } catch {
    token = null;
  }
  // Policy is per-viewer, so an unauthenticated fetch is not merely useless —
  // it would produce a table with no account to file it under. The store
  // refuses that anyway; this returns early rather than relying on it.
  if (!token) return { ok: false, unavailable: true, error: 'Not signed in' };

  try {
    const res = await fetch(`${base}/input-assistance/policies`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        unavailable: isUnavailableStatus(res.status),
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { policyVersion?: unknown; contexts?: unknown };
    const version = typeof body.policyVersion === 'string' ? body.policyVersion : '';
    const contexts =
      body.contexts !== null && typeof body.contexts === 'object'
        ? (body.contexts as Record<string, unknown>)
        : null;
    if (version === '' || contexts === null) {
      // A 200 whose body is not the contract. Reported as unavailable rather
      // than as an error the UI could surface: from the field's point of view
      // there is no policy, which is the same situation as a 404.
      return { ok: false, unavailable: true, error: 'Malformed policy payload' };
    }
    return { ok: true, policyVersion: version, contexts };
  } catch (e) {
    const aborted = (e as { name?: string } | null)?.name === 'AbortError';
    return { ok: false, unavailable: !aborted, error: aborted ? 'Aborted' : 'Network error' };
  }
}
