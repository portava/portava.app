/**
 * Outcome learning — the IMPURE half: real `fetch`, real bearer token, real
 * auth subscription. Every decision lives in `outcomeLearning.ts` and is
 * node-tested there; this file only binds it to the network and the session.
 *
 * It imports the Supabase-backed token and auth helpers, so — like
 * `telemetryTransport.ts` — it must NOT be imported by a node:test file.
 *
 * Endpoints (artifacts/api-server/src/routes/inputAssistance.ts):
 *   GET  /api/input-assistance/outcome-consent
 *   PUT  /api/input-assistance/outcome-consent   { enabled, disclosureVersion }
 *   POST /api/input-assistance/outcome           { context, fieldId, task, ok, entities }
 */
import { freshToken as freshApiToken } from '../../../services/apiToken.ts';
import { onAuthChange, getSessionUserId } from '../../../services/auth.ts';
import {
  OUTCOME_DISCLOSURE_VERSION,
  createOutcomeConsentSync,
  parseOutcomeConsentState,
  type OutcomeConsentState,
  type TaskOutcomeBody,
} from './outcomeLearning.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function authed(path: string, init: RequestInit = {}): Promise<Response | null> {
  const base = apiBase();
  if (!base) return null;
  let token: string | null = null;
  try {
    token = await freshApiToken();
  } catch {
    token = null;
  }
  if (!token) return null;
  return fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

/**
 * The read, with "could not read it" kept apart from "off" — a settings screen
 * that renders an outage as "off" invites the person to re-grant a consent they
 * already gave, or hides one they came to withdraw.
 */
export type OutcomeConsentRead =
  | { status: 'ok'; state: OutcomeConsentState }
  | { status: 'unreadable' };

export async function readOutcomeConsent(): Promise<OutcomeConsentRead> {
  try {
    const res = await authed('/api/input-assistance/outcome-consent');
    if (!res || !res.ok) return { status: 'unreadable' };
    const state = parseOutcomeConsentState(await res.json());
    return state ? { status: 'ok', state } : { status: 'unreadable' };
  } catch {
    return { status: 'unreadable' };
  }
}

export type OutcomeConsentWrite =
  | { status: 'ok'; state: OutcomeConsentState; countersErased: boolean | null }
  | { status: 'unavailable' }
  | { status: 'stale_disclosure' }
  | { status: 'failed' };

/** Grant (sending the version of the words actually shown) or withdraw. */
export async function writeOutcomeConsent(enabled: boolean): Promise<OutcomeConsentWrite> {
  try {
    const res = await authed('/api/input-assistance/outcome-consent', {
      method: 'PUT',
      body: JSON.stringify(enabled ? { enabled: true, disclosureVersion: OUTCOME_DISCLOSURE_VERSION } : { enabled: false }),
    });
    if (!res) return { status: 'failed' };
    if (res.status === 404) return { status: 'unavailable' };
    if (res.status === 409) return { status: 'stale_disclosure' };
    if (!res.ok) return { status: 'failed' };
    const body = (await res.json()) as Record<string, unknown>;
    const state = parseOutcomeConsentState(body);
    if (!state) return { status: 'failed' };
    const erased = body.countersErased;
    return { status: 'ok', state, countersErased: typeof erased === 'boolean' ? erased : null };
  } catch {
    return { status: 'failed' };
  }
}

/** The per-user credit for a completed task. Resolves false on any failure. */
export async function postTaskOutcome(body: TaskOutcomeBody): Promise<boolean> {
  try {
    const res = await authed('/api/input-assistance/outcome', { method: 'POST', body: JSON.stringify(body) });
    return !!res && res.ok;
  } catch {
    return false;
  }
}

/**
 * Attach the account-bound consent gate and the outcome poster. Call ONCE from
 * the app root, beside `installInputTelemetry`. Returns the teardown.
 */
export function installOutcomeConsentSync(): () => void {
  return createOutcomeConsentSync({
    subscribeAuth: onAuthChange,
    currentUserId: getSessionUserId,
    fetchConsent: async () => {
      const r = await readOutcomeConsent();
      return r.status === 'ok' ? r.state : null;
    },
    post: postTaskOutcome,
  });
}
