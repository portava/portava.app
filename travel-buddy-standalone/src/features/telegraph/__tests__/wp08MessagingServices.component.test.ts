/**
 * WP-08 (lane tm-telegraph) — the service calls behind the new Telegraph
 * surfaces, against a stubbed `fetch`.
 *
 *   TEL-F08  `saveMessage` — the save route answers HTTP 200
 *            `{ ok: false, reason: 'unavailable' }` when the write failed.
 *            `apiPost` looks only at the status, so the screen said "Saved"
 *            about a save that did not happen.
 *   TEL-F08  `getSavedMessages` — an unconfigured build is `ok: false`, never
 *            `{ ok: true, data: null }` read as "no saved messages" (DV-83).
 *   TEL-F09  `reportMessage` — sends the reason code the server computes
 *            severity from; an older call without one keeps the old body.
 *   TEL-F07  `getMessageEditHistory` — a 503 carries the server's code, so the
 *            sheet can tell "unavailable" from "never edited".
 */

// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time, which fails outside an Expo runtime. The service reads only
// these two names from it.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: {},
  isSupabaseConfigured: true,
}));
// NOTE: intentionally exhaustive — the service reads one function from it.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: async () => 'tok-1',
}));
// NOTE: intentionally exhaustive — the E2EE modules load native crypto; none
// of the calls under test touches them.
jest.mock('../../../lib/e2ee/threadCrypto.ts', () => ({
  buildOutgoingPayload: jest.fn(),
  establishE2ee: jest.fn(),
  decryptIncoming: jest.fn(),
  joinFromWelcomeIfNeeded: jest.fn(),
  E2EE_WELCOME_SUBTYPE: 'e2ee_welcome',
}));
// NOTE: intentionally exhaustive — see above.
jest.mock('../../../lib/e2ee/realPort.ts', () => ({ realCryptoPort: {} }));

import {
  saveMessage,
  getSavedMessages,
  reportMessage,
  getMessageEditHistory,
} from '../../../services/messaging.ts';

const realFetch = global.fetch;
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];

function respond(status: number, body: unknown) {
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
});
afterAll(() => { global.fetch = realFetch; });

describe('saveMessage (TEL-F08)', () => {
  it('a 200 whose body says the save failed is a FAILURE, not "Saved"', async () => {
    respond(200, { ok: false, reason: 'unavailable' });
    const r = await saveMessage('t-1', 'm-1');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Nothing was saved/);
  });

  it('a real save is still a success (control)', async () => {
    respond(201, { ok: true, savedAt: '2026-09-29T10:00:00Z' });
    const r = await saveMessage('t-1', 'm-1');
    expect(r.ok).toBe(true);
    expect(r.data?.savedAt).toBe('2026-09-29T10:00:00Z');
  });
});

describe('getSavedMessages (TEL-F08)', () => {
  it('an unconfigured build is ok:false, never an empty success', async () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    respond(200, { saved: [] });
    const r = await getSavedMessages();
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('a server refusal carries the server code', async () => {
    respond(500, { error: 'db_error', message: 'boom' });
    const r = await getSavedMessages();
    expect(r).toMatchObject({ ok: false, code: 'db_error' });
  });

  it('a response without a `saved` array is not "nothing saved"', async () => {
    respond(200, { items: [] });
    const r = await getSavedMessages();
    expect(r).toMatchObject({ ok: false, code: 'bad_response' });
  });
});

describe('reportMessage (TEL-F09)', () => {
  it('sends the reason code with the text', async () => {
    respond(201, { ok: true });
    const r = await reportMessage('m-9', 'Harassment or bullying', 'harassment');
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('https://api.test/api/messages/m-9/report');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ reason: 'Harassment or bullying', reason_code: 'harassment' });
  });

  it('without a code the body is exactly the old one', async () => {
    respond(201, { ok: true });
    await reportMessage('m-9', 'Spam');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ reason: 'Spam' });
  });
});

describe('getMessageEditHistory (TEL-F07)', () => {
  it('a 503 is ok:false with degraded_unavailable — not an empty history', async () => {
    respond(503, { error: 'degraded_unavailable', message: 'later' });
    const r = await getMessageEditHistory('t-1', 'm-1');
    expect(r).toMatchObject({ ok: false, code: 'degraded_unavailable', data: null });
  });
});
