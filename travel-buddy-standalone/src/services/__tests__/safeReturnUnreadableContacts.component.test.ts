/**
 * Safe Return — "we could not read your contacts" tests.
 *
 * Runs under jest (`pnpm test:component`) rather than node:test because
 * safeReturn.ts reaches ../lib/supabase, which node's tsx transform cannot
 * load — the same reason location.gps.component.test.ts lives here.
 *
 * ## The defect
 *
 * `apiFetch` in safeReturn.ts resolves an ordinary object on every path — a
 * network throw becomes `{ error: 'network_error' }`, a 500 becomes whatever
 * the error body parsed to. `getTrustedContacts` and `getSessionContacts` then
 * did `data?.contacts ?? []`, so an outage reached the user as the confident
 * statement that their alert list is empty:
 *
 *   - SafeReturnSetupSheet: "No contacts saved yet. Add emergency contacts in
 *     Settings, or follow people on the app."
 *   - ActiveSafeReturnCard: "No contacts in this session have location sharing
 *     enabled."
 *
 * Both are shown while the user is arming, or already inside, a personal-safety
 * timer.
 *
 * ## What's covered
 *
 * Unreadable (500 / 401 / network throw) → `null`, AND a readable response —
 * including a genuinely empty list — still comes through as an array, so the
 * fix cannot blank a working feature.
 *
 * The `runContactLoad` half (a `null` list now raises `loadError`, reviving that
 * module's previously unreachable error contract) is covered in
 * src/components/__tests__/SafeReturnSetupSheet.contactLoad.test.ts.
 */

import { getTrustedContacts, getSessionContacts } from '../safeReturn.ts';

// ── auth token — always present, so the tests exercise the HTTP paths ────────

jest.mock('../apiToken', () => ({
  ...jest.requireActual('../apiToken'),
  freshToken: jest.fn(async () => 'test-token'),
}));

const realFetch = globalThis.fetch;

/** Installs a fetch stub; returns the URLs it was asked for. */
function stubFetch(outcome: { status: number; body?: unknown } | 'throw') {
  const seen: string[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
    seen.push(String(url));
    if (outcome === 'throw') throw new Error('network down');
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      json: async () => outcome.body ?? {},
    };
  };
  return seen;
}

afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  jest.clearAllMocks();
});

describe('safeReturn reads separate "none" from "could not find out"', () => {
  it('getTrustedContacts returns null on a 500', async () => {
    stubFetch({ status: 500, body: { error: 'boom' } });
    expect(await getTrustedContacts()).toBeNull();
  });

  it('getTrustedContacts returns null when the network throws', async () => {
    stubFetch('throw');
    expect(await getTrustedContacts()).toBeNull();
  });

  it('getTrustedContacts still returns the real list when the read succeeds', async () => {
    stubFetch({
      status: 200,
      body: { contacts: [{ userId: 'u1', handle: 'ana', displayName: 'Ana', avatarUrl: null }] },
    });
    const result = await getTrustedContacts();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result![0]!.userId).toBe('u1');
  });

  it('getTrustedContacts returns [] — not null — for a genuine "you have none"', async () => {
    stubFetch({ status: 200, body: { contacts: [] } });
    expect(await getTrustedContacts()).toEqual([]);
  });

  it('getSessionContacts returns null on a 401', async () => {
    stubFetch({ status: 401, body: { error: 'unauthorized' } });
    expect(await getSessionContacts('sess-1')).toBeNull();
  });

  it('getSessionContacts still returns the real contacts when the read succeeds', async () => {
    const seen = stubFetch({
      status: 200,
      body: {
        contacts: [
          { id: 'c1', contactUserId: 'u1', contactName: 'Ana', canReceiveLiveLocation: true },
          { id: 'c2', contactUserId: null, contactName: 'Mum', canReceiveLiveLocation: false },
        ],
      },
    });
    const result = await getSessionContacts('sess-1');
    expect(result).toHaveLength(2);
    expect(result!.filter((c) => c.canReceiveLiveLocation)).toHaveLength(1);
    expect(seen.some((u) => u.includes('/sessions/sess-1/contacts'))).toBe(true);
  });
});
