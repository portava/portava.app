/**
 * refreshPolicyOnUse — a failed or stale policy table is asked for again when a
 * field is USED, through the fetcher the app root installed, and never on every
 * keystroke. census-discovery §80 round 3, register D-W10-S1-4 ("The missing
 * policy").
 *
 * Before this, `installInputPolicySync` refetched on auth events only, so a
 * startup fetch that failed stayed failed for the session and every field sat
 * on the conservative policy until the viewer signed in again.
 *
 * Run with: pnpm test:component
 */

// NOTE: exhaustive — the real auth module reaches the Supabase client at load.
// `installInputPolicySync` imports exactly these two; both are injected below.
jest.mock('../../../../services/auth.ts', () => ({
  onAuthChange: () => () => {},
  getSessionUserId: async () => null,
}));
// NOTE: exhaustive — the real client reaches the token helper at load. The
// installer's default fetcher; every case below injects its own.
jest.mock('../policyClient.ts', () => ({ fetchInputPolicies: jest.fn() }));

import { installInputPolicySync } from '../installInputPolicySync.ts';
import { PolicyStore, _PERMISSIVE_TEST_POLICY } from '../policyStore.ts';
import {
  refreshPolicyOnUse,
  POLICY_RETRY_MIN_GAP_MS,
  _resetPolicyRefreshOnUseForTests,
} from '../policyRefreshOnUse.ts';

const OK = {
  ok: true as const,
  policyVersion: 'v1',
  contexts: { global_search: { context: 'global_search', ..._PERMISSIVE_TEST_POLICY } },
};
const FAIL = { ok: false as const, unavailable: true, error: 'offline' };

beforeEach(() => _resetPolicyRefreshOnUseForTests());

function install(store: PolicyStore, fetchPolicies: jest.Mock) {
  return installInputPolicySync({
    store,
    fetchPolicies,
    cache: { clear: () => {} },
    recents: { clear: () => {} },
    subscribeAuth: () => () => {},
    // Never answers: the installer's own startup read stays out of the way,
    // so the only fetch these cases see is the one made on use.
    currentUserId: () => new Promise<string | null>(() => {}),
  });
}

it('the fetcher the app root INSTALLED is the one a refresh on use goes through', async () => {
  const store = new PolicyStore();
  const fetchPolicies = jest.fn(async () => OK);
  install(store, fetchPolicies);
  store.setActiveAccount('acct-1');

  expect(await refreshPolicyOnUse()).toBe('installed');
  expect(fetchPolicies).toHaveBeenCalledTimes(1);
  expect(store.readActive('global_search').authoritative).toBe(true);
});

it('nothing installed → nothing fetched (a refresh on use never invents a network path)', async () => {
  const store = new PolicyStore();
  store.setActiveAccount('acct-1');
  expect(await refreshPolicyOnUse({ store })).toBe('skipped');
});

it('a FAILED attempt is not repeated inside the gap, and is repeated after it', async () => {
  const store = new PolicyStore();
  store.setActiveAccount('acct-1');
  const fetchPolicies = jest.fn(async () => FAIL);
  let t = 1_000_000;
  const now = () => t;

  expect(await refreshPolicyOnUse({ store, fetchPolicies, now })).toBe('failed');
  t += POLICY_RETRY_MIN_GAP_MS - 1;
  expect(await refreshPolicyOnUse({ store, fetchPolicies, now })).toBe('skipped');
  expect(fetchPolicies).toHaveBeenCalledTimes(1);

  t += 1;
  fetchPolicies.mockResolvedValueOnce(OK as never);
  expect(await refreshPolicyOnUse({ store, fetchPolicies, now })).toBe('installed');
  expect(fetchPolicies).toHaveBeenCalledTimes(2);
});

it('a CURRENT table is not refetched, and a signed-out viewer has nobody to fetch for', async () => {
  const store = new PolicyStore();
  const fetchPolicies = jest.fn(async () => OK);
  expect(await refreshPolicyOnUse({ store, fetchPolicies })).toBe('skipped'); // signed out

  store.setActiveAccount('acct-1');
  store.install('acct-1', 'v1', OK.contexts);
  expect(await refreshPolicyOnUse({ store, fetchPolicies })).toBe('skipped'); // current
  expect(fetchPolicies).not.toHaveBeenCalled();
});

it('a failed fetch relaxes nothing: the store stays conservative', async () => {
  const store = new PolicyStore();
  store.setActiveAccount('acct-1');
  await refreshPolicyOnUse({ store, fetchPolicies: jest.fn(async () => FAIL) });
  expect(store.readActive('global_search').authoritative).toBe(false);
});
