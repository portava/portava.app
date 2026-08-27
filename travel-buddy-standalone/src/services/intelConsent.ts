/**
 * Intelligence Contributions consent (D4) — client of the server-authoritative
 * consent endpoint.
 *
 * The server owns the truth: it stamps the consent VERSION and the consent/
 * withdrawal timestamps. The client only READS its state and sends the boolean
 * intent (Allow & Share / turn off). It never sends a version or a timestamp — it
 * cannot forge consent. With the API unconfigured every call is a no-op.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
const INTEL_BASE = '/api/v1/intel';

export interface IntelConsentState {
  enabled: boolean;
  consentVersion: string | null;
  consentedAt: string | null;
  withdrawnAt: string | null;
  /** The disclosure version a NEW grant is recorded under. */
  currentDisclosureVersion: string;
}

async function authedFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshApiToken();
  return fetch(`${apiBase()}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

/** Read the current consent state, or null if unavailable (treated as not-granted). */
export async function getIntelConsent(): Promise<IntelConsentState | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${INTEL_BASE}/consent`);
    if (!res.ok) return null;
    return (await res.json()) as IntelConsentState;
  } catch {
    return null;
  }
}

/**
 * Grant (enabled=true, an explicit "Allow & Share") or withdraw (false) consent.
 * Only the boolean is sent; the server records the version + timestamps. Returns
 * the authoritative post-write state, or null on failure.
 */
export async function setIntelConsent(enabled: boolean): Promise<IntelConsentState | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${INTEL_BASE}/consent`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) return null;
    return (await res.json()) as IntelConsentState;
  } catch {
    return null;
  }
}

/** Valid, capture-permitting consent = enabled and not withdrawn. */
export function hasValidConsent(state: IntelConsentState | null | undefined): boolean {
  return !!state && state.enabled === true && !state.withdrawnAt;
}
