/**
 * "Remember this together" — the client calls (census-highlights-memories H53).
 *
 *   - every call goes to the route that owns the behaviour, with its method;
 *   - feature_disabled is its own kind (the screen shows nothing), a refusal
 *     keeps the server's sentence, a dropped connection is network_unreachable,
 *     and a malformed body is a failure — never "no shared experience".
 *
 * Run with: pnpm test:component
 */
// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => 'test-token' }));

import {
  acceptSharedInvitation, declineSharedInvitation, endSharedExperience, getSharedExperience, inviteToRememberTogether,
  leaveSharedExperience, listMySharedExits, listSharedInvitations, withdrawInvitation,
} from '../memorySharedExperiences.ts';

const MID = '33333333-3333-4333-8333-333333333333';
interface Call { url: string; method: string; body: unknown; auth: string | undefined }
let calls: Call[] = [];
let responses: Array<{ status: number; json: unknown } | 'throw'> = [];
const fakeFetch = jest.fn((url: string, opts: RequestInit = {}) => {
  calls.push({ url: String(url), method: String(opts.method ?? 'GET'), body: opts.body ? JSON.parse(String(opts.body)) : null, auth: (opts.headers as Record<string, string>)?.Authorization });
  const next = responses.shift();
  if (next === 'throw' || next === undefined) return Promise.reject(new TypeError('Network request failed'));
  return Promise.resolve({ ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.json } as Response);
});

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  (globalThis as { fetch: unknown }).fetch = fakeFetch;
});
beforeEach(() => { calls = []; responses = []; });

it('reaches each route with its method and the bearer token', async () => {
  responses.push(
    { status: 200, json: { sharedExperience: null } },
    { status: 201, json: { outcome: 'invited', invitationId: 'i1' } },
    { status: 200, json: { withdrawn: true } },
    { status: 200, json: { ended: true } },
    { status: 200, json: { left: true } },
    { status: 200, json: { invitations: [] } },
    { status: 200, json: { outcome: 'accepted', experienceId: 'e1' } },
    { status: 200, json: { outcome: 'declined', experienceId: null } },
  );
  expect(await getSharedExperience(MID)).toEqual({ ok: true, sharedExperience: null });
  expect(await inviteToRememberTogether(MID, 'u2')).toEqual({ ok: true, outcome: 'invited' });
  expect(await withdrawInvitation(MID, 'u2')).toEqual({ ok: true, withdrawn: true });
  expect(await endSharedExperience(MID)).toEqual({ ok: true, ended: true });
  expect(await leaveSharedExperience('e1')).toEqual({ ok: true, left: true });
  expect(await listSharedInvitations()).toEqual({ ok: true, invitations: [] });
  expect(await acceptSharedInvitation('i1', MID)).toEqual({ ok: true, experienceId: 'e1' });
  expect(await declineSharedInvitation('i1')).toEqual({ ok: true, declined: true });
  expect(calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`)).toEqual([
    `GET /api/memories/${MID}/shared-experience`,
    `POST /api/memories/${MID}/shared-experience/invitations`,
    `DELETE /api/memories/${MID}/shared-experience/invitations/u2`,
    `DELETE /api/memories/${MID}/shared-experience`,
    'POST /api/shared-experiences/e1/leave',
    'GET /api/me/shared-experience-invitations',
    'POST /api/shared-experience-invitations/i1/accept',
    'POST /api/shared-experience-invitations/i1/decline',
  ]);
  expect(calls[1]!.body).toEqual({ userId: 'u2' });
  expect(calls[6]!.body).toEqual({ memoryId: MID });
  expect(calls.every((c) => c.auth === 'Bearer test-token')).toBe(true);
});

it('accepting without a Memory sends no memoryId', async () => {
  responses.push({ status: 200, json: { outcome: 'accepted', experienceId: 'e1' } });
  await acceptSharedInvitation('i1', null);
  expect(calls[0]!.body).toEqual({});
});

it('feature_disabled is its own kind; a refusal keeps the server sentence; offline is network_unreachable', async () => {
  responses.push({ status: 404, json: { error: 'feature_disabled', message: 'feature_disabled' } });
  const off = await getSharedExperience(MID);
  expect(off.ok).toBe(false);
  if (!off.ok) expect(off.kind).toBe('feature_disabled');
  responses.push({ status: 403, json: { error: 'forbidden', message: 'That person cannot be invited to remember this together.' } });
  expect(await inviteToRememberTogether(MID, 'u2')).toEqual({ ok: false, kind: 'forbidden', message: 'That person cannot be invited to remember this together.' });
  responses.push('throw');
  const offline = await listSharedInvitations();
  expect(offline.ok).toBe(false);
  if (!offline.ok) expect(offline.kind).toBe('network_unreachable');
});

it('a body without the field it promised is a failure, never "nothing shared"', async () => {
  responses.push({ status: 200, json: {} }, { status: 200, json: { invitations: 'nope' } });
  expect((await getSharedExperience(MID)).ok).toBe(false);
  expect((await listSharedInvitations()).ok).toBe(false);
});

it('the exits read (H53): GET /me/shared-experience-exits, ids only, and a malformed body is a failure', async () => {
  const exits = { memberships: [{ experienceId: 'e1', myMemoryId: null }], invitations: [{ invitationId: 'i1' }], hosting: [{ hostMemoryId: MID }] };
  responses.push({ status: 200, json: exits }, { status: 200, json: { memberships: [{}], invitations: [], hosting: [] } }, { status: 200, json: { invitations: [] } });
  expect(await listMySharedExits()).toEqual({ ok: true, exits });
  expect(calls.at(-1)).toMatchObject({ method: 'GET', url: 'http://api.test/api/me/shared-experience-exits', auth: 'Bearer test-token' });
  expect(await listMySharedExits()).toMatchObject({ ok: false, kind: 'degraded_unavailable' });
  expect(await listMySharedExits()).toMatchObject({ ok: false, kind: 'degraded_unavailable' });
});
