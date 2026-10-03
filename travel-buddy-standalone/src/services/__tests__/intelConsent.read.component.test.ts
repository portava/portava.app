/**
 * services/intelConsent — readIntelConsent keeps "could not read" apart from
 * "not granted"; getIntelConsent stays fail-closed for capture decisions.
 * CONTROLLED: fetch is a double.
 */
// NOTE: intentionally exhaustive — the real module builds a Supabase client.
jest.mock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the real token store is native.
jest.mock('../apiToken.ts', () => ({ freshToken: jest.fn().mockResolvedValue('tok') }));

import { readIntelConsent, getIntelConsent } from '../intelConsent.ts';

const GRANTED = {
  enabled: true, consentVersion: 'intel_contributions_v1', consentedAt: '2026-09-01T00:00:00Z',
  withdrawnAt: null, currentDisclosureVersion: 'intel_contributions_v1',
};
const respond = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)) });

const realFetch = global.fetch;
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'; });
afterEach(() => { global.fetch = realFetch; });

describe('readIntelConsent', () => {
  it('a readable state is ok, and reaches /api/v1/intel/consent', async () => {
    const f = jest.fn(() => respond(200, GRANTED));
    global.fetch = f as any;
    expect(await readIntelConsent()).toEqual({ status: 'ok', state: GRANTED });
    expect((f.mock.calls[0] as any[])[0]).toBe('https://api.example.test/api/v1/intel/consent');
  });
  it('an HTTP error is unreadable, with the status', async () => {
    global.fetch = jest.fn(() => respond(503, { error: 'db_error' })) as any;
    expect(await readIntelConsent()).toEqual({ status: 'unreadable', reason: 'http', httpStatus: 503 });
  });
  it('a thrown fetch is unreadable (network)', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('offline'))) as any;
    expect(await readIntelConsent()).toEqual({ status: 'unreadable', reason: 'network' });
  });
  it('a body that is not a consent state is unreadable (malformed), not a "no"', async () => {
    global.fetch = jest.fn(() => respond(200, { hello: 'world' })) as any;
    expect(await readIntelConsent()).toEqual({ status: 'unreadable', reason: 'malformed' });
    global.fetch = jest.fn(() => respond(200, new Error('bad json'))) as any;
    expect(await readIntelConsent()).toEqual({ status: 'unreadable', reason: 'malformed' });
  });
});

describe('getIntelConsent stays fail-closed for capture decisions', () => {
  it('answers the state when readable and null on every failure', async () => {
    global.fetch = jest.fn(() => respond(200, GRANTED)) as any;
    expect(await getIntelConsent()).toEqual(GRANTED);
    global.fetch = jest.fn(() => respond(500, {})) as any;
    expect(await getIntelConsent()).toBeNull();
    global.fetch = jest.fn(() => Promise.reject(new Error('x'))) as any;
    expect(await getIntelConsent()).toBeNull();
  });
});
