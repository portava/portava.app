/**
 * census-telegraph T417 (#786 verifier CV4) — the client trusts ONLY a server that says `isHost: true`.
 *
 * The moderation controls (mute, remove) are offered to a host the SERVER named. `fetchGroupControls`
 * reads `isHost === true`; an absent, null, "true"-string or any other answer is NOT a host, so a
 * malformed or older server answer can never put moderation controls in front of a member. (The server
 * still refuses a non-host at the door; this pins that the client does not offer what it would refuse.)
 *
 * MUTANT CV4: `isHost: r.data?.isHost !== false` — an absent answer read as a host → red.
 */
jest.mock('../../../lib/supabase.ts', () => ({ ...jest.requireActual('../../../lib/supabase.ts'), isSupabaseConfigured: true }));
jest.mock('../../../services/apiToken.ts', () => ({ ...jest.requireActual('../../../services/apiToken.ts'), freshToken: jest.fn(async () => 'token-cv4') }));

import { fetchGroupControls } from '../groups/groupControlsApi.ts';

const CONTROLS = { slowModeSeconds: 0, postingPolicy: 'everyone', mediaPolicy: 'everyone', linkPolicy: 'everyone' };
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;

function answer(body: Record<string, unknown>) {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });
afterAll(() => { global.fetch = originalFetch; process.env.EXPO_PUBLIC_API_BASE_URL = originalBase; });

describe('fetchGroupControls — only an explicit isHost: true is a host (CV4)', () => {
  it('isHost: true is a host', async () => {
    answer({ controls: CONTROLS, isHost: true, mutedUntil: null });
    const r = await fetchGroupControls('t1');
    expect(r.ok && r.data.isHost).toBe(true);
  });

  it.each([
    ['absent', {}],
    ['null', { isHost: null }],
    ['the string "true"', { isHost: 'true' }],
    ['1', { isHost: 1 }],
  ])('isHost %s is NOT a host', async (_label, extra) => {
    answer({ controls: CONTROLS, mutedUntil: null, ...extra });
    const r = await fetchGroupControls('t1');
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.isHost).toBe(false);
  });
});
