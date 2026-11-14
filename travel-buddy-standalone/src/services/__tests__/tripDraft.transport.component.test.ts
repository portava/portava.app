// NOTE: native SDK/session boundary only; request, deadline and decoder run for real.
jest.mock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true }));
let mockCurrent = true;
jest.mock('../messagingOwnerRequest.ts', () => ({
  captureMessagingOwnerRequest: () => ({ ownerId: 'owner', sessionId: 'session', isCurrent: () => mockCurrent }),
  messagingOwnerToken: async () => 'token',
}));
import { draftTripFromText } from '../tripIntel.ts';
const realFetch = globalThis.fetch;
const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const draft = { draft: { title: 'Hang out at Kala kala' }, confirmed: false, message: 'Review your trip.' };
beforeEach(() => { mockCurrent = true; process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });
afterEach(() => {
  globalThis.fetch = realFetch; jest.useRealTimers();
  if (realBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
});
it('returns a review-only draft from the authenticated request', async () => {
  globalThis.fetch = jest.fn(async (url) => ({ ok: true, status: 200, url, json: async () => draft } as Response));
  expect(await draftTripFromText('Hang out at Kala kala')).toEqual(draft);
  expect(jest.mocked(fetch).mock.calls[0]).toEqual(['https://api.test/api/trips/draft-from-text', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ text: 'Hang out at Kala kala' }), headers: expect.objectContaining({ Authorization: 'Bearer token' }),
  })]);
});
it('ends a stalled draft read and allows a fresh attempt', async () => {
  jest.useFakeTimers();
  globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response));
  const pending = draftTripFromText('Trip').catch(error => error.message);
  await jest.advanceTimersByTimeAsync(30001);
  expect(await pending).toMatch(/timed out/);
  globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => draft } as Response));
  expect(await draftTripFromText('Trip')).toEqual(draft);
});
it('refuses malformed responses and drafts from a replaced session', async () => {
  globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ draft: [] }) } as Response));
  await expect(draftTripFromText('Trip')).rejects.toThrow('invalid_draft');
  globalThis.fetch = jest.fn(async () => { mockCurrent = false; return { ok: true, status: 200, json: async () => draft } as Response; });
  await expect(draftTripFromText('Trip')).rejects.toThrow();
});
