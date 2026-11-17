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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { withInputApiResponse } from './inputApiRequest.ts';
import { onAuthChange, getSessionUserId } from '../../../services/auth.ts';
import {
  OUTCOME_DISCLOSURE_VERSION,
  stateGrantsOutcomes,
  currentOutcomeScope, isCurrentOutcomeScope, holdOutcomeWithdrawal, clearOutcomeWithdrawal,
  isCurrentOutcomeAuthorization, outcomeAuthorizationSignal,
  createOutcomeConsentSync,
  parseOutcomeConsentState,
  type OutcomeConsentState,
  type TaskOutcomeBody,
} from './outcomeLearning.ts';

/**
 * The read, with "could not read it" kept apart from "off" — a settings screen
 * that renders an outage as "off" invites the person to re-grant a consent they
 * already gave, or hides one they came to withdraw.
 */
export type OutcomeConsentRead =
  | { status: 'ok'; state: OutcomeConsentState }
  | { status: 'unreadable' };

const holdKey = (account: string) => `input-outcome:withdrawal:${account}`;
// Serialize storage mutations, so an older asynchronous remove cannot finish
// after a newer withdrawal has been durably saved. Intent identity invalidates
// same-account requests even when the local gate was already held closed.
const intents = new Map<string, object>();
const storageTails = new Map<string, Promise<unknown>>();
const requestTails = new Map<string, Promise<unknown>>();
function ordered<T>(tails: Map<string, Promise<unknown>>, account: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(account) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  tails.set(account, next);
  void next.finally(() => { if (tails.get(account) === next) tails.delete(account); }).catch(() => undefined);
  return next;
}

export async function readOutcomeConsent(): Promise<OutcomeConsentRead> {
  const initial = currentOutcomeScope();
  const account = initial.account;
  if (!account) return { status: 'unreadable' };
  const intent = intents.get(account);
  await ordered(storageTails, account, async () => {
    let held = false;
    try { held = !!(await AsyncStorage.getItem(holdKey(account))); }
    catch { held = true; } // unreadable local privacy intent fails closed
    if (held && isCurrentOutcomeScope(initial) && intents.get(account) === intent) holdOutcomeWithdrawal(account);
  });
  const scope = currentOutcomeScope();
  if (scope.account !== account || intents.get(account) !== intent) return { status: 'unreadable' };
  try {
    return await withInputApiResponse<OutcomeConsentRead>('/api/input-assistance/outcome-consent', {}, async res => {
      if (!res.ok) return { status: 'unreadable' };
      const body = await res.json();
      if (!isCurrentOutcomeScope(scope) || intents.get(account) !== intent) return { status: 'unreadable' };
      const state = parseOutcomeConsentState(body);
      return state ? { status: 'ok', state } : { status: 'unreadable' };
    }, undefined, account);
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
  const account = currentOutcomeScope().account;
  if (!account) return { status: 'failed' };
  const intent = {};
  intents.set(account, intent);
  if (!enabled) holdOutcomeWithdrawal(account);
  const scope = currentOutcomeScope();
  const current = () => isCurrentOutcomeScope(scope) && intents.get(account) === intent;
  // Persist a withdrawal immediately, without waiting for an older network call.
  const persisted = enabled ? Promise.resolve() : ordered(storageTails, account, async () => {
    try { await AsyncStorage.setItem(holdKey(account), '1'); }
    catch { /* Still attempt server revocation; this session's hold remains closed. */ }
  });
  // Issue same-account requests in intent order, so a pending grant does not
  // overtake a later withdrawal. The shared request budget bounds each wait.
  return ordered(requestTails, account, async (): Promise<OutcomeConsentWrite> => {
    try {
      await persisted;
      if (!current()) return { status: 'failed' };
      return await withInputApiResponse<OutcomeConsentWrite>('/api/input-assistance/outcome-consent', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(enabled ? { enabled: true, disclosureVersion: OUTCOME_DISCLOSURE_VERSION } : { enabled: false }),
      }, async res => {
        if (res.status === 404) return { status: 'unavailable' };
        if (res.status === 409) return { status: 'stale_disclosure' };
        if (!res.ok) return { status: 'failed' };
        const body = (await res.json()) as Record<string, unknown>;
        if (!current()) return { status: 'failed' };
        const state = parseOutcomeConsentState(body);
        if (!state) return { status: 'failed' };
        if (enabled) {
          if (!stateGrantsOutcomes(state)) return { status: 'failed' };
          const cleared = await ordered(storageTails, account, async () => {
            if (!current()) return false;
            await AsyncStorage.removeItem(holdKey(account));
            if (!current()) {
              // A later withdrawal may have arrived while the native remove was
              // in flight. Restore the hold before this grant can finish.
              await AsyncStorage.setItem(holdKey(account), '1');
              return false;
            }
            clearOutcomeWithdrawal(account);
            return true;
          });
          if (!cleared || !current()) return { status: 'failed' };
        } else if (state.enabled || !state.withdrawnAt) {
          // A concurrent grant can legitimately win the server's reread. That
          // is not an acknowledgement that our withdrawal is still in force.
          return { status: 'failed' };
        }
        const erased = body.countersErased;
        return { status: 'ok', state, countersErased: typeof erased === 'boolean' ? erased : null };
      }, undefined, account);
    } catch {
      return { status: 'failed' };
    }
  });
}

/** The per-user credit for a completed task. Resolves false on any failure. */
export async function postTaskOutcome(body: TaskOutcomeBody): Promise<boolean> {
  if (!isCurrentOutcomeAuthorization(body)) return false;
  const authorization = outcomeAuthorizationSignal([body]);
  try {
    return await withInputApiResponse('/api/input-assistance/outcome', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, async res => res.ok, authorization.signal, authorization.accountId);
  } catch {
    return false;
  } finally { authorization.dispose(); }
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
