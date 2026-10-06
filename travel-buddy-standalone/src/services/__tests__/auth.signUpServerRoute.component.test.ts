/**
 * signUp creates the account THROUGH POST /api/auth/signup, then signs in.
 *
 * The server route is the only door that enforces `disable_signups` and
 * `invite_only_beta` (routes/auth.ts). signUp used to call supabase.auth.signUp
 * directly, so for the app both rules were advisory. These cases assert the
 * requests the app makes and what the person is told:
 *
 *   - open: POST /api/auth/signup (normalised email, the name/handle metadata),
 *     then mockSignInWithPassword, then the profile — and the old outcome;
 *   - the server refuses (invite_required / feature_disabled / 409 / 429):
 *     no sign-in is attempted, and the sentence is the one the old path used;
 *   - the status read said "open" but the server says invite-only: the SERVER
 *     wins (the read is advisory);
 *   - email confirmation on: sign-in answers email_not_confirmed, the app asks
 *     Supabase Auth to send the confirmation email, and returns the new user id
 *     with no session, as supabase.auth.signUp did;
 *   - supabase.auth.signUp is never called.
 *
 * Only fetch and the Supabase client are faked.
 * Run with: pnpm test:component
 */

const mockSignInWithPassword = jest.fn();
const mockResend = jest.fn();
const mockDirectSignUp = jest.fn();

// NOTE: exhaustive — the real client opens a Supabase connection on import; only
// the three auth methods signUp may touch are provided, and signUp is a spy that
// must never be called.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: { auth: { signInWithPassword: (...a: any[]) => mockSignInWithPassword(...a), resend: (...a: any[]) => mockResend(...a), signUp: (...a: any[]) => mockDirectSignUp(...a) } },
}));
// NOTE: exhaustive — the real token helper reaches the Supabase client.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => 'tok' }));

import { signUp, _setTestSessionToken } from '../auth.ts';

const ORIGIN = 'https://portava.test';
type Reply = { status: number; body: unknown };
let replies: Record<string, Reply>;
let calls: Array<{ url: string; method: string; body: any }>;

function json(r: Reply) {
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGIN;
  calls = [];
  replies = {
    '/api/auth/signup-status': { status: 200, body: { signupsEnabled: true, inviteOnly: false } },
    '/api/auth/signup': { status: 201, body: { user: { id: 'u-new', email: 'ada@example.com' } } },
  };
  (global as any).fetch = jest.fn(async (url: string, init?: any) => {
    const path = String(url).replace(ORIGIN, '');
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    return json(replies[path] ?? { status: 200, body: { ok: true } });
  });
  mockSignInWithPassword.mockReset();
  mockResend.mockReset();
  mockDirectSignUp.mockReset();
  mockSignInWithPassword.mockResolvedValue({ data: { user: { id: 'u-new' }, session: { access_token: 't' } }, error: null });
  mockResend.mockResolvedValue({ data: {}, error: null });
  _setTestSessionToken('tok');
});

afterEach(() => _setTestSessionToken(null));

const signupPosts = () => calls.filter((c) => c.url === `${ORIGIN}/api/auth/signup` && c.method === 'POST');

test('open: the account is created by the server, then the app signs in', async () => {
  const r = await signUp('  Ada@Example.com ', 'long-enough', { name: 'Ada' });
  expect(r).toEqual({ userId: 'u-new', error: null });
  expect(signupPosts()).toHaveLength(1);
  expect(signupPosts()[0].body).toEqual({ email: 'ada@example.com', password: 'long-enough', name: 'Ada' });
  expect(mockSignInWithPassword).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'long-enough' });
  expect(mockDirectSignUp).not.toHaveBeenCalled();
});

test.each([
  [403, { error: 'invite_required' }, 'Portava is invite-only right now. You need an invite to create an account.'],
  [403, { error: 'feature_disabled' }, 'New sign-ups are temporarily closed. Please check back soon.'],
  [409, { error: 'email_taken', message: 'User already registered' }, 'User already registered'],
  [429, { error: 'RATE_LIMITED', message: 'Too many signup attempts. Please try again later.' }, 'Too many signup attempts. Please try again later.'],
  [503, { error: 'service_unavailable' }, 'Sign-up is unavailable right now. Please try again.'],
])('the server refuses (%s %j): no sign-in, the person is told why', async (status, body, sentence) => {
  replies['/api/auth/signup'] = { status, body };
  const r = await signUp('ada@example.com', 'long-enough');
  expect(r).toEqual({ userId: null, error: sentence });
  expect(mockSignInWithPassword).not.toHaveBeenCalled();
  expect(mockDirectSignUp).not.toHaveBeenCalled();
});

test('the SERVER decides: an "open" status read does not open a server that says invite-only', async () => {
  replies['/api/auth/signup'] = { status: 403, body: { error: 'invite_required' } };
  const r = await signUp('ada@example.com', 'long-enough');
  expect(r.userId).toBeNull();
  expect(r.error).toMatch(/invite-only/);
  expect(signupPosts()).toHaveLength(1);
});

test('the advisory read already says invite-only: no account request is made at all', async () => {
  replies['/api/auth/signup-status'] = { status: 200, body: { signupsEnabled: true, inviteOnly: true } };
  const r = await signUp('ada@example.com', 'long-enough');
  expect(r.error).toMatch(/invite-only/);
  expect(signupPosts()).toHaveLength(0);
});

test('email confirmation on: the confirmation email is requested and the user id returned without a session', async () => {
  mockSignInWithPassword.mockResolvedValue({ data: { user: null, session: null }, error: { code: 'email_not_confirmed', message: 'Email not confirmed' } });
  const r = await signUp('ada@example.com', 'long-enough');
  expect(r).toEqual({ userId: 'u-new', error: null });
  expect(mockResend).toHaveBeenCalledWith({ type: 'signup', email: 'ada@example.com' });
});

test('no API address in this build: refused before any request', async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = '';
  const r = await signUp('ada@example.com', 'long-enough');
  expect(r.userId).toBeNull();
  expect(r.error).toMatch(/no API address/);
  expect(calls).toHaveLength(0);
  expect(mockDirectSignUp).not.toHaveBeenCalled();
});
