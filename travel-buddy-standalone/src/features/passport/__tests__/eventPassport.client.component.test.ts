/**
 * eventPassport client bindings — what each server answer BECOMES.
 *
 *   • `{ enabled: true, share: null }` from GET /passport/event-share/:id is the
 *     normal "no live share" answer. It used to fall through to "Unexpected
 *     response", so every owner not yet sharing received a failure.
 *   • A 5xx / 408 / 429 / network error is an OUTAGE (`outage: true`); a 4xx is
 *     a refusal (`outage: false`). Surfaces act differently on the two.
 */
import {
  getMyEventPassportShare,
  createEventPassportShare,
  resolveEventPassport,
  isOutageStatus,
} from '../eventPassport.ts';

// NOTE: intentional stub — the real module builds a Supabase client from env;
// these bindings only read the configured flag.
jest.mock('../../../lib/supabase.ts', () => ({ isSupabaseConfigured: true }));
// NOTE: intentional stub — token refresh reaches Supabase auth.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: jest.fn(async () => 'tok') }));

const EVENT = 'eeeeeeee-0000-0000-0000-000000000001';

function respond(status: number, body: unknown) {
  (global as any).fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });

describe('eventPassport client — no share, refusal, outage', () => {
  it('share: null is a SUCCESS with no data, not a failure', async () => {
    respond(200, { enabled: true, share: null });
    expect(await getMyEventPassportShare(EVENT)).toEqual({ ok: true, enabled: true, data: null });
  });

  it('a live share is returned as data', async () => {
    respond(200, { enabled: true, share: { token: 't'.repeat(48), eventId: EVENT, expiresAt: '2030-01-01T00:00:00Z' } });
    const r = await getMyEventPassportShare(EVENT);
    expect(r.ok && r.enabled && r.data?.token).toBe('t'.repeat(48));
  });

  it('a 500 is an outage', async () => {
    respond(500, { error: 'db_error', message: 'Event Passport is temporarily unavailable' });
    const r = await getMyEventPassportShare(EVENT);
    expect(r).toMatchObject({ ok: false, outage: true });
  });

  it('a 403 is a refusal, not an outage', async () => {
    respond(403, { error: 'forbidden', message: 'You are not attending that event' });
    expect(await createEventPassportShare(EVENT)).toMatchObject({ ok: false, outage: false });
  });

  it('a network failure is an outage', async () => {
    (global as any).fetch = jest.fn(async () => { throw new Error('Network request failed'); });
    expect(await resolveEventPassport('a'.repeat(48))).toMatchObject({ ok: false, outage: true });
  });

  it('an unreadable 200 body is an outage, not a refusal', async () => {
    respond(200, { enabled: true });
    expect(await resolveEventPassport('a'.repeat(48))).toMatchObject({ ok: false, outage: true });
  });

  it('the status split', () => {
    expect([500, 502, 503, 408, 429].every(isOutageStatus)).toBe(true);
    expect([400, 401, 403, 404, 410].some(isOutageStatus)).toBe(false);
  });
});
