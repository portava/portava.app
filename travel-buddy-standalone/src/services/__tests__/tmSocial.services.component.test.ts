/**
 * TM-social lane — the client service halves of the lists and actions this lane
 * put on screen (PLAT-F11, PLAT-F14, PLAT-F16, PLAT-F37, PASS-F09, MAP-F08).
 *
 * Each wrapper is pinned against the route contract it calls, and against the
 * one failure shape that matters for it: a failed read is an error (never an
 * empty list / "not saved" / "0 earned"), and a refusal keeps its status so
 * the screen can say which refusal it was.
 *
 * Run with: pnpm test:component
 */
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

// NOTE: intentionally exhaustive — the real Supabase client pulls react-native
// native internals that crash under jest-expo.
jest.mock('../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: true }));
jest.mock('../apiToken', () => ({
  ...jest.requireActual('../apiToken'),
  freshToken: jest.fn(async () => 'tok'),
}));

const { postNeedHelp } = require('../circle.ts');
const { removeCircleMember } = require('../friends.ts');
const { toSaveStatus, getMySavedProfiles } = require('../saves.ts');
const { getMyStampCollections, getStampCatalog } = require('../stamps.ts');
const { addGemToPlan } = require('../hiddenGems.ts');
const { toProfileTabPage, getProfileTabPage } = require('../profileTabs.ts');
const { gemPlanOutcomeFromError } = require('../../components/gems/GemTripPlanPicker.tsx');

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
function respond(status: number, body: unknown) {
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  });
}

beforeEach(() => { calls = []; });

describe('MAP-F08 postNeedHelp', () => {
  it('POSTs to the context need-help route and is ok only on acknowledged', async () => {
    respond(200, { acknowledged: true, message: 'x' });
    await expect(postNeedHelp('event', 'ev-1')).resolves.toEqual({ ok: true, data: { acknowledged: true } });
    expect(calls[0].url).toBe('http://api.test/api/circle/contexts/event/ev-1/need-help');
    expect(calls[0].init.method).toBe('POST');
  });
  it('a 429 keeps its status', async () => {
    respond(429, { error: 'rate_limited' });
    await expect(postNeedHelp('trip', 't-1')).resolves.toEqual({ ok: false, error: 'rate_limited', status: 429 });
  });
  it('a 200 without acknowledged is not a success', async () => {
    respond(200, {});
    const r = await postNeedHelp('trip', 't-1');
    expect(r.ok).toBe(false);
  });
});

describe('PLAT-F11 removeCircleMember', () => {
  it('DELETEs /circles/:owner/members/:member', async () => {
    respond(200, { status: 'removed', memberId: 'm-1' });
    const r = await removeCircleMember('o-1', 'm-1');
    expect(r).toEqual({ ok: true, data: { status: 'removed', memberId: 'm-1' } });
    expect(calls[0].url).toBe('http://api.test/api/circles/o-1/members/m-1');
    expect(calls[0].init.method).toBe('DELETE');
  });
  it('a 404 is not_found, a 403 is forbidden — neither is a removal', async () => {
    respond(404, { error: 'not_found' });
    expect((await removeCircleMember('o', 'm')).errorKind).toBe('not_found');
    respond(403, { error: 'forbidden' });
    expect((await removeCircleMember('o', 'm')).errorKind).toBe('forbidden');
  });
});

describe('PLAT-F16 saves', () => {
  it('toSaveStatus reads the route\'s `saved` (the old cast left isSaved undefined)', () => {
    expect(toSaveStatus('u1', { userId: 'u1', saved: true })).toEqual({ userId: 'u1', isSaved: true });
    expect(toSaveStatus('u1', { userId: 'u1', saved: false })).toEqual({ userId: 'u1', isSaved: false });
    expect(toSaveStatus('u1', null)).toEqual({ userId: 'u1', isSaved: false });
  });
  it('getMySavedProfiles maps GET /me/saves', async () => {
    respond(200, { saves: [{ id: 'a', handle: 'ann', name: null, avatarUrl: null, savedAt: '2026-01-01' }] });
    const r = await getMySavedProfiles();
    expect(r).toEqual({ ok: true, data: [{ id: 'a', handle: 'ann', name: null, avatarUrl: null, savedAt: '2026-01-01' }] });
    expect(calls[0].url).toBe('http://api.test/api/me/saves');
  });
  it('a 503 (unreadable blocks) is an error, never an empty list', async () => {
    respond(503, { error: 'degraded_unavailable', message: 'Your block list could not be read' });
    const r = await getMySavedProfiles();
    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
  });
  it('a body without a saves array is an error', async () => {
    respond(200, {});
    expect((await getMySavedProfiles()).ok).toBe(false);
  });
});

describe('PASS-F09 stamp browse', () => {
  it('collections map earned/total', async () => {
    respond(200, { collections: [{ id: 'c1', slug: 's', name: 'Balkans', description: null, iconUrl: null, total: 2, earned: 1, complete: false }] });
    const r = await getMyStampCollections();
    expect(r).toEqual({ ok: true, data: [{ id: 'c1', slug: 's', name: 'Balkans', description: null, iconUrl: null, total: 2, earned: 1, complete: false }] });
  });
  it('503 feature_not_available is "disabled", not an outage', async () => {
    respond(503, { error: 'feature_not_available', message: 'Stamp System v2 is not yet enabled.' });
    expect(await getMyStampCollections()).toEqual({ ok: false, disabled: true, message: 'Stamp System v2 is not yet enabled.' });
  });
  it('a db_error is an outage, not "disabled" and not "0 earned"', async () => {
    respond(500, { error: 'db_error', message: 'boom' });
    expect(await getMyStampCollections()).toEqual({ ok: false, disabled: false, message: 'boom' });
  });
  it('catalog maps definitions', async () => {
    respond(200, { definitions: [{ id: 'd1', slug: 'x', name: 'Zagreb', description: null, stamp_type: 'city', category: 'places', rarity: 'common', icon_url: null, city: 'Zagreb', country: 'Croatia' }] });
    const r = await getStampCatalog();
    expect(r.ok && r.data[0]).toMatchObject({ id: 'd1', stampType: 'city', category: 'places', city: 'Zagreb' });
  });
});

describe('PLAT-F37 addGemToPlan', () => {
  it('POSTs the trip id to /hidden-gems/:id/plan', async () => {
    respond(201, { ok: true, planItemId: 'pi-1' });
    await expect(addGemToPlan('g-1', 't-1')).resolves.toEqual({ ok: true, planItemId: 'pi-1' });
    expect(calls[0].url).toBe('http://api.test/api/hidden-gems/g-1/plan');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ tripId: 't-1' });
  });
  it.each([
    [409, { error: 'duplicate', message: 'This gem is already in your trip plan' }, 'duplicate'],
    [403, { error: 'forbidden', message: 'no' }, 'forbidden'],
    [404, { error: 'not_found', message: 'Trip not found' }, 'not_found'],
    [500, { error: 'db_error', message: 'A database error occurred' }, 'failed'],
  ])('a %s carries its status, so the sheet can tell it apart', async (status, body, outcome) => {
    respond(status as number, body);
    const err = await addGemToPlan('g-1', 't-1').catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(status);
    expect(gemPlanOutcomeFromError(err)).toBe(outcome);
  });
});

describe('PLAT-F14 profile tabs', () => {
  it('blocked and unavailable win over items', () => {
    expect(toProfileTabPage(true, 200, { blocked: true, items: [] })).toEqual({ status: 'blocked' });
    expect(toProfileTabPage(true, 200, { unavailable: true, items: [] })).toEqual({ status: 'unavailable' });
  });
  it('an HTTP failure and a body without items are errors, not empty tabs', () => {
    expect(toProfileTabPage(false, 503, { message: 'Your follow relationship could not be read' })).toEqual({ status: 'error', message: 'Your follow relationship could not be read' });
    expect(toProfileTabPage(true, 200, {})).toEqual({ status: 'error', message: 'Unexpected response' });
  });
  it('a page carries its cursor', () => {
    expect(toProfileTabPage(true, 200, { items: [{ id: 'p' }], nextCursor: 'c' })).toEqual({ status: 'ok', items: [{ id: 'p' }], nextCursor: 'c' });
  });
  it('getProfileTabPage strips @ and sends the cursor', async () => {
    respond(200, { items: [], nextCursor: null });
    await getProfileTabPage('circles', '@ann', 'cur');
    expect(calls[0].url).toBe('http://api.test/api/users/ann/circles?limit=20&cursor=cur');
  });
});
