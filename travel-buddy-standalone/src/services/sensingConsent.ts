/**
 * OD-MAP-6's three passive-sensing consents — client of
 * GET/PUT /api/v1/sensing/consent (artifacts/api-server/src/routes/sensingConsent.ts).
 *
 * The server owns the truth and stamps each consent's version; the client sends
 * only the intent and, on a grant, the version of the words it DISPLAYED (the
 * server refuses a mismatch). A read that fails is `unreadable` — never "all
 * off" — so a screen does not show a person who consented that they have not,
 * and a capture loop does not start or stop on a guess.
 *
 * Every successful change notifies subscribers (`onSensingConsentChange`), so the
 * capture loop stops or starts as soon as a switch moves, not at the next launch.
 */
import { runSensingRequest } from './sensing/sensingRequest.ts';
import { holdSensingWithdrawal, clearSensingWithdrawal, readSensingWithdrawalHolds } from './sensing/withdrawalHold.ts';
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope, type DiscoveryScope } from './discoveryViewerScope.ts';
import { SENSING_CONSENT_SCOPES, wordsFor, type SensingConsentScope } from '../lib/sensing/consentSplit.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
const PATH = '/api/v1/sensing/consent';

export interface SensingConsentEntry {
  scope: SensingConsentScope;
  granted: boolean;
  /** The recorded grant is under the words in force. */
  current: boolean;
  /** It has an effect now (granted, current, and the consents before it too). */
  effective: boolean;
  disclosureVersion: string | null;
  currentVersion: string;
}

export interface SensingConsentState {
  localWithdrawalPending?: SensingConsentScope[];
  /** The feature is switched on server-side: grants can be recorded. Withdrawals always can. */
  available: boolean;
  consents: Record<SensingConsentScope, SensingConsentEntry>;
}

export type SensingConsentRead =
  | { status: 'ok'; state: SensingConsentState }
  | { status: 'unreadable'; reason: 'not_configured' | 'http' | 'network' | 'malformed'; httpStatus?: number };

async function authedFetch(path: string, opts: RequestInit, owner: DiscoveryScope) {
  return runSensingRequest(async (signal) => {
    const token = await freshApiToken();
    if (signal.aborted || !isCurrentDiscoveryScope(owner) || !token || !owner.viewer?.startsWith('u:')) {
      throw new Error('Sensing account unavailable');
    }
    const response = await fetch(`${apiBase()}${path}`, {
      ...opts, signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opts.headers },
    });
    const body: unknown = response.ok ? await response.json().catch(() => null) : null;
    return { ok: response.ok, status: response.status, state: parse(body) };
  });
}

function parse(body: unknown): SensingConsentState | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as { available?: unknown; consents?: unknown };
  if (typeof o.available !== 'boolean' || !Array.isArray(o.consents)) return null;
  const out = {} as Record<SensingConsentScope, SensingConsentEntry>;
  for (const c of o.consents as Array<Record<string, unknown>>) {
    const scope = c?.scope;
    if (scope !== 'capture' && scope !== 'upload' && scope !== 'surface') continue;
    if (typeof c.granted !== 'boolean' || typeof c.effective !== 'boolean' || typeof c.currentVersion !== 'string') return null;
    out[scope] = {
      scope,
      granted: c.granted,
      current: c.current === true,
      effective: c.effective,
      disclosureVersion: typeof c.disclosureVersion === 'string' ? c.disclosureVersion : null,
      currentVersion: c.currentVersion,
    };
  }
  for (const s of SENSING_CONSENT_SCOPES) if (!out[s]) return null;
  return { available: o.available, consents: out };
}

async function withWithdrawalHolds(state: SensingConsentState, owner: DiscoveryScope): Promise<SensingConsentState> {
  if (!owner.viewer?.startsWith('u:')) throw new Error('No sensing owner');
  const pending = await readSensingWithdrawalHolds(owner.viewer);
  if (!isCurrentDiscoveryScope(owner)) throw new Error('Sensing account changed');
  const consents = { ...state.consents };
  let blocked = false;
  for (const scope of SENSING_CONSENT_SCOPES) {
    blocked = blocked || pending.includes(scope);
    if (blocked) consents[scope] = { ...consents[scope], effective: false };
  }
  return { ...state, consents, localWithdrawalPending: pending };
}

export async function readSensingConsent(): Promise<SensingConsentRead> {
  const owner = currentDiscoveryScope();
  if (!isSupabaseConfigured || !apiBase()) return { status: 'unreadable', reason: 'not_configured' };
  let res: Awaited<ReturnType<typeof authedFetch>>;
  try {
    res = await authedFetch(PATH, {}, owner);
  } catch {
    return { status: 'unreadable', reason: 'network' };
  }
  if (!isCurrentDiscoveryScope(owner)) return { status: 'unreadable', reason: 'network' };
  if (!res.ok) return { status: 'unreadable', reason: 'http', httpStatus: res.status };
  try {
    const state = res.state;
    if (!isCurrentDiscoveryScope(owner)) return { status: 'unreadable', reason: 'network' };
    return state ? { status: 'ok', state: await withWithdrawalHolds(state, owner) } : { status: 'unreadable', reason: 'malformed' };
  } catch {
    return { status: 'unreadable', reason: 'malformed' };
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();
/** Called after every successful change. Returns an unsubscribe. */
export function onSensingConsentChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export type SetSensingConsentOutcome =
  | { ok: true; state: SensingConsentState | null }
  | { ok: false; reason: 'not_configured' | 'words_unavailable' | 'refused' | 'failed'; httpStatus?: number };

/**
 * Turn ONE consent on or off. A grant sends the version of the words this build
 * displays, and only if they are the words the server has in force; otherwise it
 * is refused here ("update the app") and nothing is sent.
 */
export async function setSensingConsent(scope: SensingConsentScope, granted: boolean, serverVersion: string): Promise<SetSensingConsentOutcome> {
  const owner = currentDiscoveryScope();
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, reason: 'not_configured' };
  const words = wordsFor(scope, serverVersion);
  if (granted && !words) return { ok: false, reason: 'words_unavailable' };
  if (!owner.viewer?.startsWith('u:')) return { ok: false, reason: 'failed' };
  if (!granted) {
    const persisted = holdSensingWithdrawal(owner.viewer, scope);
    for (const fn of listeners) { try { fn(); } catch {} }
    // Server withdrawal still proceeds if storage fails; the current process
    // remains denied, and the UI can report/retry an unsuccessful server write.
    try { await persisted; } catch {}
  }
  let res: Awaited<ReturnType<typeof authedFetch>>;
  try {
    res = await authedFetch(`${PATH}/${scope}`, {
      method: 'PUT',
      body: JSON.stringify(granted ? { granted, displayedVersion: words!.version } : { granted }),
    }, owner);
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!isCurrentDiscoveryScope(owner)) return { ok: false, reason: 'failed' };
  if (!res.ok) return { ok: false, reason: res.status === 404 || res.status === 409 ? 'refused' : 'failed', httpStatus: res.status };
  let state = res.state;
  if (!isCurrentDiscoveryScope(owner)) return { ok: false, reason: 'failed' };
  try { await clearSensingWithdrawal(owner.viewer, scope); } catch {}
  if (state) { try { state = await withWithdrawalHolds(state, owner); } catch { state = null; } }
  if (!isCurrentDiscoveryScope(owner)) return { ok: false, reason: 'failed' };
  for (const fn of listeners) { try { fn(); } catch { /* a listener must not undo a saved change */ } }
  return { ok: true, state };
}
