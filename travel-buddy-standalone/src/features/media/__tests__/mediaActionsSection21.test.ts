/**
 * features/media — census-media §21: the client half of the action rail and
 * the §44 client signals.
 *
 * Three layers, stated so nobody mistakes one for another:
 *   1. PURE behaviour (resolver, directions, compiled plan, Save Route) — run.
 *   2. The CONTRACT with the server — the client's signal names and payload
 *      keys are read against the server's own allow-lists (source text), so a
 *      client signal the batch endpoint would drop fails here, not silently.
 *   3. CALL-SITE WIRING in React components this node suite cannot render —
 *      asserted on the source. That proves the line is there and in the right
 *      branch; it does not prove a device ran it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveMediaActionExecution,
  pickDirectionsUrl,
  openDirectionsForPlace,
  mapCompiledPlan,
  planItemsFromCompiledPlan,
  applyCompiledPlan,
  saveMediaRoute,
  fetchCompiledExperiencePlan,
  MEDIA_ACTION_IDS,
  _setTestFreshToken,
  _clearTestFreshToken,
} from '../services/mediaActions.ts';
import {
  mediaActionToNorthStar,
  emitsNorthStarOnTap,
  emitMediaSignal,
  buildSignalPayload,
  MEDIA_CLIENT_SIGNALS,
} from '../telemetry/mediaTelemetry.ts';
import type { MediaAction, MediaEntityRef, CompiledExperiencePlan } from '../types/mediaActions.ts';

const M = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const Q = '44444444-4444-4444-8444-444444444444';
const T = '33333333-3333-4333-8333-333333333333';
const G = '55555555-5555-4555-8555-555555555555';

const REFS: MediaEntityRef[] = [
  { kind: 'media', id: M, label: null },
  { kind: 'place', id: P, label: 'An Thuong' },
];

function action(id: string, params: Record<string, unknown>, method: 'GET' | 'POST' = 'GET'): MediaAction {
  return { id, label: id, outcome: 'navigate', target: { method, endpoint: '/x', params } } as MediaAction;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', '..');
const REPO = join(SRC, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readRepo = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

// ── 1. Resolver: every §21 id resolves to a real destination ─────────────────

test('§21 ids are known to the client (the rail renders what the server offers)', () => {
  for (const id of [
    'directions', 'view_event', 'view_passport', 'find_quieter', 'find_cheaper',
    'contribute_gem', 'invite_people', 'follow_this_night', 'save_route',
  ]) {
    assert.ok((MEDIA_ACTION_IDS as readonly string[]).includes(id), id);
  }
});

test('MD94 directions → the place, from params or the place ref; no place → unsupported', () => {
  assert.deepEqual(resolveMediaActionExecution(action('directions', { placeId: Q }), REFS), { kind: 'directions', placeId: Q });
  assert.deepEqual(resolveMediaActionExecution(action('directions', {}), REFS), { kind: 'directions', placeId: P });
  assert.equal(resolveMediaActionExecution(action('directions', {}), [{ kind: 'media', id: M, label: null }]).kind, 'unsupported');
});

test('MD103 view_event → /event/:id; view_passport → the Postcard viewer', () => {
  assert.deepEqual(resolveMediaActionExecution(action('view_event', { experienceId: T }), REFS), { kind: 'navigate', route: `/event/${T}` });
  assert.equal(resolveMediaActionExecution(action('view_event', {}), REFS).kind, 'unsupported');
  assert.deepEqual(resolveMediaActionExecution(action('view_passport', { id: M, postcardId: 'pc1' }), REFS), { kind: 'navigate', route: `/postcard/${M}` });
});

test('MD101 find_quieter / find_cheaper → Compass with the server-written prompt', () => {
  const q = resolveMediaActionExecution(action('find_quieter', { mediaId: M, prompt: 'quieter please', comparator: 'quieter' }, 'POST'), REFS);
  assert.deepEqual(q, { kind: 'compass', mediaId: M, prompt: 'quieter please' });
  // No prompt → no row: Compass is never asked an empty question.
  assert.equal(resolveMediaActionExecution(action('find_cheaper', { mediaId: M }, 'POST'), REFS).kind, 'unsupported');
});

test('MD104 share_telegraph with an object reference → telegraph_share; without → the old hand-off', () => {
  assert.deepEqual(
    resolveMediaActionExecution(action('share_telegraph', { objectType: 'POST', objectId: M }, 'POST'), REFS),
    { kind: 'telegraph_share', objectType: 'POST', objectId: M },
  );
  assert.deepEqual(resolveMediaActionExecution(action('share_telegraph', {}, 'POST'), REFS), { kind: 'navigate', route: '/telegraph/new' });
});

test('MD107 do_this_experience with compile:true → compiled_plan carrying the source kind', () => {
  assert.deepEqual(
    resolveMediaActionExecution(action('do_this_experience', { experienceId: T, sourceExperienceId: T, compile: true, source: 'trail' }), REFS),
    { kind: 'compiled_plan', experienceId: T, source: 'trail' },
  );
  assert.deepEqual(
    resolveMediaActionExecution(action('do_this_experience', { experienceId: T, compile: true, source: 'experience' }), REFS),
    { kind: 'compiled_plan', experienceId: T, source: 'experience' },
  );
  // An older server (no compile flag) keeps the proposal path.
  assert.equal(resolveMediaActionExecution(action('do_this_experience', { sourceExperienceId: T }), REFS).kind, 'experience_plan');
});

test('MD173 save_route: place stops only, two or more, carrying the media ref', () => {
  const two = [{ sourceType: 'place', sourceId: P, title: 'A' }, { sourceType: 'place', sourceId: Q, title: 'B' }];
  const exec = resolveMediaActionExecution(action('save_route', { title: 'Night', stops: two }, 'POST'), REFS);
  assert.deepEqual(exec, {
    kind: 'save_route',
    title: 'Night',
    stops: [{ sourceType: 'place', sourceId: P, title: 'A' }, { sourceType: 'place', sourceId: Q, title: 'B' }],
    mediaId: M,
  });
  const oneAndJunk = [{ sourceType: 'place', sourceId: P }, { sourceType: 'trip', sourceId: Q }, 'x'];
  assert.equal(resolveMediaActionExecution(action('save_route', { stops: oneAndJunk }, 'POST'), REFS).kind, 'unsupported');
});

test('MD381 invite_people / MD400 contribute_gem carry the media id to the server', () => {
  assert.deepEqual(resolveMediaActionExecution(action('invite_people', { id: T }, 'POST'), REFS), { kind: 'invite', momentId: T, mediaId: M });
  assert.deepEqual(
    resolveMediaActionExecution(action('contribute_gem', { id: G, originMediaId: M }, 'POST'), REFS),
    { kind: 'contribute_gem', gemId: G, mediaId: M },
  );
  assert.equal(resolveMediaActionExecution(action('contribute_gem', {}, 'POST'), REFS).kind, 'unsupported');
});

// ── 1b. Go There — Directions STARTED only when the maps app opened ──────────

const URLS = { appleMaps: 'maps://a', googleMaps: 'https://g', waze: 'waze://w' };

test('pickDirectionsUrl: Apple Maps on iOS, Google Maps elsewhere, nothing when there is nothing', () => {
  assert.equal(pickDirectionsUrl(URLS, 'ios'), 'maps://a');
  assert.equal(pickDirectionsUrl(URLS, 'android'), 'https://g');
  assert.equal(pickDirectionsUrl(null, 'ios'), null);
  assert.equal(pickDirectionsUrl({ ...URLS, appleMaps: '' }, 'ios'), null);
});

test('MD213/MD378/MD396 openDirectionsForPlace: onOpened fires ONLY after the maps app opened', async () => {
  let opened = 0;
  const urlsSeen: string[] = [];
  const ok = await openDirectionsForPlace(P, {
    platform: 'ios',
    loadDirections: async (id) => (id === P ? URLS : null),
    openUrl: async (u) => { urlsSeen.push(u); },
    onOpened: () => { opened += 1; },
  });
  assert.equal(ok, 'opened');
  assert.deepEqual(urlsSeen, ['maps://a']);
  assert.equal(opened, 1);

  const none = await openDirectionsForPlace(P, {
    platform: 'ios', loadDirections: async () => null, openUrl: async () => {}, onOpened: () => { opened += 1; },
  });
  assert.equal(none, 'no_directions');

  const refused = await openDirectionsForPlace(P, {
    platform: 'ios', loadDirections: async () => URLS, openUrl: async () => { throw new Error('no maps app'); }, onOpened: () => { opened += 1; },
  });
  assert.equal(refused, 'failed');

  const unreadable = await openDirectionsForPlace(P, {
    platform: 'ios', loadDirections: async () => { throw new Error('503'); }, openUrl: async () => {}, onOpened: () => { opened += 1; },
  });
  assert.equal(unreadable, 'failed');
  assert.equal(opened, 1, 'a tap that did not open directions recorded nothing');
});

test('directions is the one rail action whose north-star waits for the outcome', () => {
  assert.equal(emitsNorthStarOnTap('directions'), false);
  assert.equal(emitsNorthStarOnTap('show_on_map'), true);
  assert.equal(mediaActionToNorthStar('directions'), 'media_route');
});

// ── 1c. Do This Experience — executable plan, one trip, tentative items ──────

function compiledRaw() {
  return {
    compiled: {
      source: { kind: 'trail', id: T, title: 'Old town' },
      day: '2026-10-01',
      startsAt: '2026-10-01T10:00:00.000Z',
      stops: [
        { order: 2, sourceType: 'media', sourceId: M, title: 'Mural', startsAt: '2026-10-01T11:20:00.000Z', endsAt: '2026-10-01T12:20:00.000Z', dwellMinutes: 60, transitMinutesBefore: 20, transitBasis: 'default' },
        { order: 1, sourceType: 'place', sourceId: P, title: 'Market', startsAt: '2026-10-01T10:00:00.000Z', endsAt: '2026-10-01T11:00:00.000Z', dwellMinutes: 60, transitMinutesBefore: 0, transitBasis: 'none' },
        { order: 3, sourceType: 'place', sourceId: Q, title: 'No times' },
      ],
      eligibleTripIds: ['trip-a'],
      feasibility: 'not_verified',
    },
    generatedAt: '2026-09-26T00:00:00.000Z',
  };
}

test('mapCompiledPlan maps the server envelope; untimed stops are dropped; garbage → null', () => {
  const plan = mapCompiledPlan(compiledRaw());
  assert.ok(plan);
  assert.equal(plan.source.kind, 'trail');
  assert.equal(plan.stops.length, 2);
  assert.equal(plan.feasibility, 'not_verified');
  assert.equal(mapCompiledPlan({ compiled: { source: { id: T }, day: '2026-10-01', stops: [] } }), null);
  assert.equal(mapCompiledPlan('nope'), null);
});

test('planItemsFromCompiledPlan: ordered, TENTATIVE, compiled times; only place stops keep a source id', () => {
  const plan = mapCompiledPlan(compiledRaw()) as CompiledExperiencePlan;
  const items = planItemsFromCompiledPlan(plan);
  assert.deepEqual(items.map((i) => i.title), ['Market', 'Mural']);
  assert.ok(items.every((i) => i.status === 'tentative' && i.lockType === 'flexible' && i.dayDate === '2026-10-01'));
  assert.equal(items[0]!.sourceType, 'place');
  assert.equal(items[0]!.sourceId, P);
  assert.equal(items[0]!.startsAt, '2026-10-01T10:00:00.000Z');
  assert.equal(items[1]!.sourceType, 'manual');
  assert.equal('sourceId' in items[1]!, false);
});

test('applyCompiledPlan writes only into a trip the server named, and counts what landed', async () => {
  const plan = mapCompiledPlan(compiledRaw()) as CompiledExperiencePlan;
  const calls: string[] = [];
  const refused = await applyCompiledPlan(plan, 'trip-z', async (tripId) => { calls.push(tripId); });
  assert.deepEqual(refused, { created: 0, failed: 2 });
  assert.equal(calls.length, 0, 'an ineligible trip is never written to');

  let n = 0;
  const partial = await applyCompiledPlan(plan, 'trip-a', async (tripId, item) => {
    calls.push(`${tripId}:${item.title}`);
    n += 1;
    if (n === 2) throw new Error('duplicate');
  });
  assert.deepEqual(partial, { created: 1, failed: 1 });
  assert.deepEqual(calls, ['trip-a:Market', 'trip-a:Mural']);
});

test('fetchCompiledExperiencePlan asks for compile=1 with the source; a 404 is "no plan", not an error', async () => {
  _setTestFreshToken('tok');
  const original = globalThis.fetch;
  const urls: string[] = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string) => {
    urls.push(String(url));
    return urls.length === 1
      ? new Response(JSON.stringify(compiledRaw()), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  try {
    const r = await fetchCompiledExperiencePlan(T, { source: 'trail', day: '2026-10-01' });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data?.stops.length, 2);
    assert.match(urls[0]!, new RegExp(`/api/media/experiences/${T}/plan\\?compile=1&source=trail&day=2026-10-01$`));
    const none = await fetchCompiledExperiencePlan(T, { source: 'experience' });
    assert.deepEqual(none, { ok: true, data: null });
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = original;
    _clearTestFreshToken();
  }
});

// ── 1d. Save Route — coordinates completed per stop, two or refuse ───────────

test('MD173 saveMediaRoute completes each stop, sends originMediaId, and reads the plan id from the envelope', async () => {
  const sent: unknown[] = [];
  const res = await saveMediaRoute(
    { title: 'Night', stops: [{ sourceType: 'place', sourceId: P, title: 'A' }, { sourceType: 'place', sourceId: Q, title: 'B' }], mediaId: M },
    {
      resolveCoords: async (id) => (id === P ? { lat: 16.06, lng: 108.2 } : { lat: 16.07, lng: 108.22 }),
      createRoute: async (payload) => { sent.push(payload); return { plan: { id: 'route-1' } }; },
    },
  );
  assert.deepEqual(res, { ok: true, routeId: 'route-1' });
  assert.deepEqual(sent, [{
    title: 'Night',
    routeStyle: 'custom',
    stops: [
      { title: 'A', lat: 16.06, lng: 108.2, sourceType: 'place', sourceId: P },
      { title: 'B', lat: 16.07, lng: 108.22, sourceType: 'place', sourceId: Q },
    ],
    originMediaId: M,
  }]);
});

test('saveMediaRoute refuses a one-stop route, drops unresolvable stops, and never reports a route it did not get', async () => {
  const neverCalled = async () => { throw new Error('must not be called'); };
  assert.deepEqual(
    await saveMediaRoute({ title: 'x', stops: [{ sourceType: 'place', sourceId: P, title: 'A' }], mediaId: M }, { resolveCoords: neverCalled, createRoute: neverCalled }),
    { ok: false, reason: 'too_few_stops' },
  );
  let created = 0;
  const unresolved = await saveMediaRoute(
    { title: 'x', stops: [{ sourceType: 'place', sourceId: P, title: 'A' }, { sourceType: 'place', sourceId: Q, title: 'B' }], mediaId: M },
    { resolveCoords: async (id) => (id === P ? { lat: 1, lng: 2 } : null), createRoute: async () => { created += 1; return { plan: { id: 'r' } }; } },
  );
  assert.deepEqual(unresolved, { ok: false, reason: 'unresolved_stops' });
  assert.equal(created, 0);
  const noId = await saveMediaRoute(
    { title: 'x', stops: [{ sourceType: 'place', sourceId: P, title: 'A' }, { sourceType: 'place', sourceId: Q, title: 'B' }], mediaId: null },
    { resolveCoords: async () => ({ lat: 1, lng: 2 }), createRoute: async () => ({ plan: null }) },
  );
  assert.deepEqual(noId, { ok: false, reason: 'create_failed' });
});

// ── 2. Contract with the server's allow-lists ────────────────────────────────

test('§44 client signals: every name is one the batch endpoint accepts', () => {
  const batch = readRepo('artifacts/api-server/src/routes/mediaAnalyticsBatch.ts');
  const analytics = readRepo('artifacts/api-server/src/lib/mediaAnalytics.ts');
  const clientOutcome = analytics.match(/MEDIA_CLIENT_OUTCOME_SIGNAL_TYPES[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(clientOutcome, 'server declares its client outcome signal list');
  const allowListBlock = batch.slice(batch.indexOf('const VALID_EVENT_TYPES'), batch.indexOf(']);', batch.indexOf('const VALID_EVENT_TYPES')));
  const accepted = new Set([...allowListBlock.matchAll(/"([a-z_]+)"/g), ...clientOutcome[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  for (const signal of MEDIA_CLIENT_SIGNALS) assert.ok(accepted.has(signal), `batch endpoint accepts ${signal}`);
});

test('§44 client signal payload keys are all on the server payload allow-list; nothing forbidden leaves', () => {
  const analytics = readRepo('artifacts/api-server/src/lib/mediaAnalytics.ts');
  const payload = buildSignalPayload({ mediaId: M, placeId: P, gemId: G, creatorId: T, surface: 's', actionId: 'directions' });
  for (const key of Object.keys(payload)) assert.match(analytics, new RegExp(`"${key}"`), `server keeps ${key}`);
  const calls: Array<[string, unknown]> = [];
  assert.equal(emitMediaSignal((t, p) => calls.push([t, p]), 'gem_open', { gemId: G, mediaId: M }), true);
  assert.equal(emitMediaSignal((t, p) => calls.push([t, p]), 'invite_sent' as never, { mediaId: M }), false, 'server-only signals are refused client-side too');
  assert.deepEqual(calls, [['gem_open', { media_id: M, gem_id: G }]]);
});

// ── 3. Call-site wiring (source) ─────────────────────────────────────────────

test('rail: Go There records media_route + directions_tap inside the opened callback only; tap-time emission skips it', () => {
  const rail = read('features/media/components/MediaActionRail.tsx');
  assert.match(rail, /if \(emitsNorthStarOnTap\(action\.id\)\) emitMediaNorthStar\(record, action\.id, northStarCtx\);/);
  const dirCase = rail.slice(rail.indexOf("case 'directions': {"), rail.indexOf("case 'telegraph_share':"));
  const cb = dirCase.slice(dirCase.indexOf('openRailDirections(exec.placeId, () => {'), dirCase.indexOf('}).then('));
  assert.match(cb, /emitMediaNorthStar\(record, action\.id, northStarCtx\)/);
  assert.match(cb, /emitMediaSignal\(record, 'directions_tap'/);
});

test('rail: Telegraph share sends an object reference; Save Route / plan / invite / gem reach their executors', () => {
  const rail = read('features/media/components/MediaActionRail.tsx');
  assert.match(rail, /<TelegraphObjectShareSheet mediaId=\{mediaId\} object=\{shareObject\}/);
  assert.match(rail, /saveRailRoute\(\{ title: exec\.title, stops: exec\.stops, mediaId: exec\.mediaId \}\)/);
  assert.match(rail, /fetchCompiledExperiencePlan\(exec\.experienceId, \{ source: exec\.source \}\)/);
  assert.match(rail, /<InvitePanel momentId=\{panel\.momentId\} mediaId=\{panel\.mediaId\}/);
  assert.match(rail, /<ContributePanel gemId=\{panel\.gemId\} mediaId=\{panel\.mediaId\}/);
  const panels = read('features/media/components/MediaActionPanels.tsx');
  assert.match(panels, /telegraphObject=\{object\}/);
  assert.match(panels, /inviteToSharedMoment\(momentId, userId, mediaId\)/);
  assert.match(panels, /<GemContributeSection gemId=\{gemId\} isAuthed originMediaId=\{mediaId\} \/>/);
  assert.match(panels, /applyCompiledPlan\(plan, tripId, createPlanItem\)/);
  const share = read('components/ShareSheet.tsx');
  assert.equal((share.match(/telegraphObject\s*\n?\s*\? await shareObjectIntoThread\(/g) ?? []).length, 2, 'both in-app send paths honour the reference');
});

test('services forward originMediaId to the endpoints that attribute it', () => {
  assert.match(read('services/sharedMoments.ts'), /JSON\.stringify\(originMediaId \? \{ userId, originMediaId \} : \{ userId \}\)/);
  assert.match(read('services/hiddenGems.ts'), /opts\.originMediaId \? \{ contributionType, notes, originMediaId: opts\.originMediaId \}/);
  assert.match(read('components/gems/GemContributeSection.tsx'), /contributeToGem\(gemId, type, undefined, \{ originMediaId \}\)/);
});

test('MD387 comment: emitted from the MEDIA comment sheet, only on a comment the server accepted', () => {
  const adapter = read('components/media/MediaCommentSheet.tsx');
  assert.match(adapter, /onCommentPosted=\{\(\) => emitMediaSignal\(mediaSignalRecorder, 'comment', \{ mediaId, surface: 'media_comments' \}\)\}/);
  const sheet = read('components/CommentsSheet.tsx');
  const sheetBody = sheet.slice(sheet.indexOf('export function CommentsSheet('));
  const replyOk = sheetBody.slice(sheetBody.indexOf("if (result && 'reply' in result) {"), sheetBody.indexOf("} else if (result && 'error' in result) {"));
  assert.match(replyOk, /onCommentPosted\?\.\(\);/);
  const commentOk = sheetBody.slice(sheetBody.indexOf("if (result && 'comment' in result) {"));
  assert.match(commentOk.slice(0, commentOk.indexOf("} else if (result && 'error' in result) {")), /onCommentPosted\?\.\(\);/);
  assert.equal((sheetBody.match(/onCommentPosted\?\.\(\)/g) ?? []).length, 2, 'never on a refusal');
  // The generic post surfaces (Wall, Pulse) do not pass it — §11.6.
  assert.doesNotMatch(read('components/PostEngagementBar.tsx'), /onCommentPosted/);
});

test('MD393 profile_open / place_open, MD376 gem_open, MD374 visual_opportunity_open are emitted where the viewer opens them', () => {
  const overlay = read('components/media/WatchItemOverlay.tsx');
  assert.match(overlay, /router\.push\(`\/u\/\$\{item\.creator\.username\}` as any\); emitMediaSignal\(mediaSignalRecorder, 'profile_open', \{ mediaId: item\.id, creatorId: item\.creator\.id/);
  assert.match(overlay, /router\.push\(`\/place\/\$\{item\.place\.id\}` as any\); emitMediaSignal\(mediaSignalRecorder, 'place_open', \{ mediaId: item\.id, placeId: item\.place\.id/);
  const gems = read('components/media/GemsFeed.tsx');
  assert.match(gems, /if \(it\.gemId && it\.location\?\.canonicalPlaceId\) emitMediaSignal\(mediaSignalRecorder, 'gem_open', \{ mediaId: it\.id, gemId: it\.gemId/);
  const shell = read('features/media/screens/MediaWorldShell.tsx');
  assert.equal((shell.match(/emitMediaSignal\(mediaSignalRecorder, 'visual_opportunity_open'/g) ?? []).length, 3);
});
