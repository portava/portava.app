// NOTE: exhaustive auth-boundary stub; these service tests must not initialize a native Supabase client.
jest.mock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: null }));
// NOTE: exhaustive token stub; payload tests need no native auth session. Ownership is exercised separately.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => 'token' }));
import { fetchWall, fetchLiveForYou, fetchQuickMedia } from '../../features/wall/services/wallApi.ts';
import { fetchMapProjection } from '../mapProjection.ts';
import { fetchUserHighlights, fetchFollowingHighlightsFeed } from '../highlights.ts';
import { fetchWallMoments, shownMoments, type WallMomentView } from '../../features/wall/services/wallMoments.ts';
import { _setLiveTestToken } from '../../features/live/liveApi.ts';
import { _resetDiscoveryViewerScopeForTests } from '../discoveryViewerScope.ts';
const original = globalThis.fetch;
const env = { ...process.env };
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL='https://api.test'; process.env.EXPO_PUBLIC_SUPABASE_URL='https://db.test'; process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY='test'; });
beforeEach(() => { _resetDiscoveryViewerScopeForTests(); _setLiveTestToken(async () => 'token'); });
afterEach(() => { globalThis.fetch=original; _setLiveTestToken(null); });
afterAll(() => { process.env=env; });
function answer(body: unknown) { globalThis.fetch=jest.fn(async () => ({ ok:true, status:200, json:async () => body })) as any; }
it.each([null, {}, { items: null, liveForYou: [] }])('an unreadable Wall response is not an empty feed: %p', async (body) => {
  answer(body); expect((await fetchWall({ mode:'for_you' })).ok).toBe(false);
});
it('keeps a truly empty Wall readable and exposes degraded lanes', async () => {
  answer({ items:[], liveForYou:[] }); expect((await fetchWall({ mode:'for_you' })).ok).toBe(true);
  answer({ items:[], liveForYou:[], degraded:['media'] }); expect(await fetchWall({ mode:'for_you' })).toMatchObject({ ok:true, degraded:true });
});
it('unreadable live and media strips do not claim no content', async () => {
  answer({}); expect((await fetchLiveForYou()).ok).toBe(false); expect((await fetchQuickMedia()).ok).toBe(false);
});
it('distinguishes explicit disabled Map from an unreadable projection', async () => {
  const opts={ bbox:{ west:0,south:0,east:1,north:1 },zoom:10 };
  answer({}); expect((await fetchMapProjection(opts)).ok).toBe(false);
  answer({ enabled:true, objects:null }); expect((await fetchMapProjection(opts)).ok).toBe(false);
  answer({ enabled:false, objects:[] }); expect(await fetchMapProjection(opts)).toMatchObject({ ok:true, data:{ enabled:false } });
});
it('unreadable Highlight arrays do not erase a profile or following feed', async () => {
  answer({}); expect((await fetchUserHighlights('owner')).ok).toBe(false); expect((await fetchFollowingHighlightsFeed()).ok).toBe(false);
  answer({ highlights:[] }); expect((await fetchUserHighlights('owner')).ok).toBe(true);
  answer({ users:[] }); expect((await fetchFollowingHighlightsFeed()).ok).toBe(true);
});
it('an event action cannot succeed with invalid JSON', async () => {
  const { createEvent } = require('../events.ts');
  globalThis.fetch=jest.fn(async () => ({ ok:true, status:200, json:async () => { throw new Error('invalid JSON'); } })) as any;
  expect((await createEvent({ title:'Test' })).ok).toBe(false);
});
const now=Date.now();
const moment=(expiresAt: number, route='WALL'): WallMomentView => ({ id:'m', subject:{ kind:'place',id:'p' }, transition:{ kind:'crowd_shift',claimType:'crowd',from:'busy',to:'packed' }, occurredAt:new Date(now-1000).toISOString(), expiresAt:new Date(expiresAt).toISOString(), reason:{ code:'crowd_shift',text:'Changed' }, truthClass:'observed', freshness:'fresh', attention:{ route,reasons:[] } });
it('expired, future and duplicate Moments cannot appear current', () => {
  const live=moment(now+1000);
  expect(shownMoments([live,live],now).shown).toHaveLength(1);
  expect(shownMoments([live],now+1000)).toMatchObject({ shown:[], expired:1, held:0 });
  expect(shownMoments([{ ...live, occurredAt:new Date(now+500).toISOString() }],now).shown).toHaveLength(0);
  expect(shownMoments([moment(now+1000,'SILENT')],now)).toMatchObject({ shown:[], expired:0, held:1 });
});
it('Moments from outside the requested subjects are refused', async () => {
  answer({ moments:[moment(now+1000)], subjects:[{ subjectId:'p',refusal:null,moments:1 }], liveIntelligenceReadable:true });
  expect((await fetchWallMoments(['different'])).state).toBe('unavailable');
});

it('stamp mutations require confirmed state and count', async () => {
  const { stampEntity, unstampEntity } = require('../stamps.ts');
  answer({}); expect((await stampEntity('post','p')).ok).toBe(false);
  answer({ stampCount: -1, isStamped:true }); expect((await stampEntity('post','p')).ok).toBe(false);
  answer({ stampCount: 2, isStamped:true }); expect(await stampEntity('post','p')).toMatchObject({ ok:true, data:{ count:2, isStamped:true } });
  expect((await unstampEntity('post','p')).ok).toBe(false);
  answer({ stampCount:0, isStamped:true, countUnavailable:true }); expect(await stampEntity('post','p')).toMatchObject({ ok:true, data:{ count:null, isStamped:true } });
  answer({ stampCount: 1, isStamped:false }); expect(await unstampEntity('post','p')).toMatchObject({ ok:true, data:{ count:1, isStamped:false } });
});

it('missing event or stamp lists are not successful empty collections', async () => {
  const { listEvents, listMyEvents } = require('../events.ts');
  const { getMyRecentStamps, getUserStamps, getMyProgress } = require('../stamps.ts');
  answer({});
  for (const result of await Promise.all([listEvents({}), listMyEvents(), listEvents({ nearLat:1,nearLng:1 }), getMyRecentStamps(), getUserStamps('owner'),getMyProgress()])) expect(result.ok).toBe(false);
  answer({ events:[], stamps:[], progress:[] });
  for (const result of await Promise.all([listEvents({}),listMyEvents(),getMyRecentStamps(),getUserStamps('owner'),getMyProgress()])) expect(result.ok).toBe(true);
});
