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
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
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
  /** The feature is switched on server-side: grants can be recorded. Withdrawals always can. */
  available: boolean;
  consents: Record<SensingConsentScope, SensingConsentEntry>;
}

export type SensingConsentRead =
  | { status: 'ok'; state: SensingConsentState }
  | { status: 'unreadable'; reason: 'not_configured' | 'http' | 'network' | 'malformed'; httpStatus?: number };

async function authedFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshApiToken();
  return fetch(`${apiBase()}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers ?? {}) },
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

export async function readSensingConsent(): Promise<SensingConsentRead> {
  if (!isSupabaseConfigured || !apiBase()) return { status: 'unreadable', reason: 'not_configured' };
  let res: Response;
  try {
    res = await authedFetch(PATH);
  } catch {
    return { status: 'unreadable', reason: 'network' };
  }
  if (!res.ok) return { status: 'unreadable', reason: 'http', httpStatus: res.status };
  try {
    const state = parse(await res.json());
    return state ? { status: 'ok', state } : { status: 'unreadable', reason: 'malformed' };
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
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, reason: 'not_configured' };
  const words = wordsFor(scope, serverVersion);
  if (granted && !words) return { ok: false, reason: 'words_unavailable' };
  let res: Response;
  try {
    res = await authedFetch(`${PATH}/${scope}`, {
      method: 'PUT',
      body: JSON.stringify(granted ? { granted, displayedVersion: words!.version } : { granted }),
    });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!res.ok) return { ok: false, reason: res.status === 404 || res.status === 409 ? 'refused' : 'failed', httpStatus: res.status };
  let state: SensingConsentState | null = null;
  try { state = parse(await res.json()); } catch { state = null; }
  for (const fn of listeners) { try { fn(); } catch { /* a listener must not undo a saved change */ } }
  return { ok: true, state };
}
