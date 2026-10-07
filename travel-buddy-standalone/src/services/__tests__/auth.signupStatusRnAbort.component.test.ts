/**
 * The sign-up status read actually runs on React Native (verifier N1).
 *
 * `fetchSignupStatus` used `AbortSignal.timeout(5000)`, which React Native's
 * AbortSignal (the `abort-controller` package) does not have: the call threw
 * before the request, the fail-open catch swallowed it, and a phone never
 * learned that sign-up was invite-only. With React Native's class installed,
 * the read must reach the API and report what it says.
 *
 * Run with: pnpm test:component
 */

// NOTE: exhaustive — the real client opens a Supabase connection on import; the
// status read touches none of it.
jest.mock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: { auth: {} } }));
// NOTE: exhaustive — the real token helper reaches the Supabase client.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => 'tok' }));

import { getSignupStatus } from '../auth.ts';

const RN = jest.requireActual('abort-controller') as { AbortController: unknown; AbortSignal: { timeout?: unknown } };
const ORIGIN = 'https://portava.test';
const g = globalThis as any;
let saved: { c: unknown; s: unknown };
let calls: string[];

beforeEach(() => {
  saved = { c: g.AbortController, s: g.AbortSignal };
  g.AbortController = RN.AbortController;
  g.AbortSignal = RN.AbortSignal;
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGIN;
  calls = [];
  g.fetch = jest.fn(async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ signupsEnabled: true, inviteOnly: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  g.AbortController = saved.c;
  g.AbortSignal = saved.s;
});

test('premise: React Native\'s AbortSignal has no static timeout', () => {
  expect(typeof g.AbortSignal.timeout).toBe('undefined');
});

test('the status read reaches the API and reports invite-only under React Native\'s AbortSignal', async () => {
  await expect(getSignupStatus()).resolves.toEqual({ signupsEnabled: true, inviteOnly: true });
  expect(calls).toEqual([`${ORIGIN}/api/auth/signup-status`]);
});
