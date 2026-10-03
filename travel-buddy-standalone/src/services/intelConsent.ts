/**
 * Intelligence Contributions consent (D4) — client of the server-authoritative
 * consent endpoint.
 *
 * The server owns the truth: it stamps the consent VERSION and the consent/
 * withdrawal timestamps. The client READS its state and sends the boolean
 * intent (Allow & Share / turn off), plus — on a grant — the disclosure version
 * whose words it DISPLAYED, which the server checks against the version it
 * stamps and refuses on mismatch. The client never supplies the RECORDED version
 * or a timestamp — it cannot forge consent. With the API unconfigured every call
 * is a no-op.
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
  currentDisclosureVersion: string; /** Server-derived (Gate 2b's predicate): would a map photo be KEPT for this account? Absent on an older server, which reads as no. */ coversPhotoEvidence?: boolean;
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

/**
 * The consent read, with "could not read it" kept apart from "not granted".
 *
 * WHY THIS EXISTS BESIDE getIntelConsent. getIntelConsent folds every failure
 * into `null`, which hasValidConsent reads as "not granted" — correct for the
 * callers that only need to know whether they may capture (the sensing
 * installer, the outcome-consent bit at boot): an unknown consent must not
 * capture. It is WRONG for the screens that SHOW consent. The server says so in
 * as many words (routes/intel.ts GET /v1/intel/consent): an unreadable consent
 * row must not render as "you have never consented", because the toggle would
 * then re-stamp a consent the person already gave. The Quick Signal screen and
 * Settings did exactly that — a 500, a dropped connection or a malformed body
 * put a person who HAD consented in front of the first-use consent gate. Those
 * screens read this, and render an outage as an outage with a retry.
 */
export type IntelConsentRead =
  | { status: 'ok'; state: IntelConsentState }
  | { status: 'unreadable'; reason: 'not_configured' | 'http' | 'network' | 'malformed'; httpStatus?: number };

function isConsentState(v: unknown): v is IntelConsentState {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.enabled === 'boolean' && typeof o.currentDisclosureVersion === 'string';
}

export async function readIntelConsent(): Promise<IntelConsentRead> {
  if (!isSupabaseConfigured || !apiBase()) return { status: 'unreadable', reason: 'not_configured' };
  let res: Response;
  try {
    res = await authedFetch(`${INTEL_BASE}/consent`);
  } catch {
    return { status: 'unreadable', reason: 'network' };
  }
  if (!res.ok) return { status: 'unreadable', reason: 'http', httpStatus: res.status };
  try {
    const body: unknown = await res.json();
    // A body that is not a consent state is not a "no": it is an answer this
    // build cannot read, and showing the first-use gate over it is the defect.
    return isConsentState(body) ? { status: 'ok', state: body } : { status: 'unreadable', reason: 'malformed' };
  } catch {
    return { status: 'unreadable', reason: 'malformed' };
  }
}

/**
 * Read the current consent state, or null if unavailable — FAIL-CLOSED, for
 * callers deciding whether they may capture. A screen that DISPLAYS consent
 * must use readIntelConsent instead (see above).
 */
export async function getIntelConsent(): Promise<IntelConsentState | null> {
  const read = await readIntelConsent();
  return read.status === 'ok' ? read.state : null;
}

/**
 * Grant (enabled=true, an explicit "Allow & Share") or withdraw (false) consent.
 * The server records the version + timestamps; the client never supplies the
 * version that is RECORDED. On a grant the client sends the disclosure version
 * it DISPLAYED, and the server refuses (409) unless that is the version it
 * stamps — so a record can never name words the person did not see. Returns the
 * authoritative post-write state, or null on failure (including that refusal).
 */
export async function setIntelConsent(enabled: boolean, displayedDisclosureVersion?: string): Promise<IntelConsentState | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${INTEL_BASE}/consent`, {
      method: 'PUT',
      body: JSON.stringify(
        enabled && displayedDisclosureVersion ? { enabled, disclosureVersion: displayedDisclosureVersion } : { enabled },
      ),
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
