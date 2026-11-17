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
import { captureMessagingOwnerRequest, type MessagingOwnerRequest } from './messagingOwnerRequest.ts';
import { fetchOwnedApi } from './ownedApiRequest.ts';
import { beginIntelConsentChange, intelWithdrawalPending } from './intelConsentLifecycle.ts';
export { onIntelConsentChange } from './intelConsentLifecycle.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
const INTEL_BASE = '/api/v1/intel';

export interface IntelConsentState {
  localWithdrawalPending?: boolean;
  enabled: boolean;
  consentVersion: string | null;
  consentedAt: string | null;
  withdrawnAt: string | null;
  /** The disclosure version a NEW grant is recorded under. */
  currentDisclosureVersion: string; /** Server-derived (Gate 2b's predicate): would a map photo be KEPT for this account? Absent on an older server, which reads as no. */ coversPhotoEvidence?: boolean;
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

export async function readIntelConsent(capturedOwner?: MessagingOwnerRequest): Promise<IntelConsentRead> {
  if (!isSupabaseConfigured || !apiBase()) return { status: 'unreadable', reason: 'not_configured' };
  const owner = capturedOwner ?? captureMessagingOwnerRequest();
  if (!owner?.isCurrent()) return { status: 'unreadable', reason: 'network' };
  let res: Awaited<ReturnType<typeof fetchOwnedApi>>;
  try {
    res = await fetchOwnedApi(`${INTEL_BASE}/consent`, { owner });
  } catch {
    return { status: 'unreadable', reason: 'network' };
  }
  if (!res.ok) return { status: 'unreadable', reason: 'http', httpStatus: res.status };
  try {
    const body: unknown = await res.json();
    // A body that is not a consent state is not a "no": it is an answer this
    // build cannot read, and showing the first-use gate over it is the defect.
    if (!isConsentState(body)) return { status: 'unreadable', reason: 'malformed' };
    const pending = await intelWithdrawalPending(owner.ownerId);
    if (!owner.isCurrent()) return { status: 'unreadable', reason: 'network' };
    return { status: 'ok', state: pending ? { ...body, localWithdrawalPending: true } : body };
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
  const owner = captureMessagingOwnerRequest();
  if (!owner?.isCurrent()) return null;
  const change = beginIntelConsentChange(owner.ownerId, enabled);
  let granted = false;
  try {
    try { await change.prepare(); } catch (error) {
      // Still deliver a withdrawal if device storage fails. The in-memory hold
      // remains closed; a grant cannot proceed without reading its local hold.
      if (enabled) throw error;
    }
    if (!owner.isCurrent() || !change.current()) return null;
    const res = await fetchOwnedApi(`${INTEL_BASE}/consent`, {
      owner, isCurrent: change.current,
      method: 'PUT',
      body: enabled && displayedDisclosureVersion ? { enabled, disclosureVersion: displayedDisclosureVersion } : { enabled },
    });
    if (!res.ok) return null;
    const state: unknown = await res.json();
    if (!owner.isCurrent() || !change.current() || !isConsentState(state)) return null;
    granted = enabled && hasValidConsent(state);
    return !enabled ? { ...state, localWithdrawalPending: true } : state;
  } catch {
    return null;
  } finally {
    // Never let a late result clear a newer withdrawal or another session's hold.
    try { await change.settle(granted && owner.isCurrent()); } catch { return null; /* retain the local hold on storage failure */ }
  }
}

/** Valid, capture-permitting consent = enabled and not withdrawn. */
export function hasValidConsent(state: IntelConsentState | null | undefined): boolean {
  return !!state && state.enabled === true && !state.withdrawnAt && !state.localWithdrawalPending;
}
