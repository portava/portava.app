/**
 * features/media — action rail mapper / resolver / transport tests (§15).
 *
 * Verifies (a) the pure mappers coerce the REAL merged-backend shapes (#292)
 * without throwing and render ONLY the actions the server returned, (b) the
 * pure resolver maps every action id to its client destination (unknown →
 * unsupported, so no dead rows), (c) the "I Want This" optimistic toggle +
 * degrade rule, and (d) the transport degrades gracefully — a 404 becomes an
 * empty/no-op result, missing auth is reported, and nothing ever throws.
 *
 * Pure node:test suite — imports only the service (no react-native).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapMediaActionSet,
  mapExperiencePlan,
  resolveMediaActionExecution,
  resolveWantedAfterRequest,
  fetchMediaActions,
  fetchExperiencePlan,
  postMediaIntent,
  deleteMediaIntent,
  MEDIA_ACTION_IDS,
  ASK_COMPASS_DEFAULT_PROMPT,
  CREATE_PLAN_DEFAULT_PROMPT,
  _setTestFreshToken,
  _clearTestFreshToken,
} from '../services/mediaActions.ts';
import type { MediaAction, MediaEntityRef } from '../types/mediaActions.ts';

const M = '11111111-1111-1111-1111-111111111111';
const P = '22222222-2222-2222-2222-222222222222';
const T = '33333333-3333-3333-3333-333333333333';

// A faithful slice of the real GET /media/:id/actions response.
function realActionSet() {
  return {
    mediaId: M,
    entityRefs: [
      { kind: 'media', id: M, label: null },
      { kind: 'place', id: P, label: 'An Thuong' },
      { kind: 'trip', id: T, label: 'Da Nang trip' },
    ],
    actions: [
      { id: 'report', label: 'Report / Not relevant', outcome: 'moderate', target: { method: 'POST', endpoint: '/api/media/:id/report', params: { id: M } } },
      { id: 'share_telegraph', label: 'Share via Telegraph', outcome: 'share', target: { method: 'POST', endpoint: '/api/media/:id/share', params: { id: M } } },
      { id: 'save', label: 'Save', outcome: 'save', target: { method: 'POST', endpoint: '/api/media/:id/save', params: { id: M } } },
      { id: 'i_want_this', label: 'I want this', outcome: 'want', target: { method: 'POST', endpoint: '/api/media/:id/intent', params: { id: M, entityType: 'place', entityId: P } } },
      { id: 'show_on_map', label: 'Show on map', outcome: 'navigate', target: { method: 'GET', endpoint: '/api/media/places/:placeId', params: { placeId: P } } },
      { id: 'see_nearby', label: 'See nearby', outcome: 'discover', target: { method: 'GET', endpoint: '/api/media/map', params: { city: 'Da Nang' } } },
      { id: 'find_similar', label: 'Find similar', outcome: 'discover', target: { method: 'GET', endpoint: '/api/media/world', params: { city: 'Da Nang' } } },
      { id: 'ask_compass', label: 'Ask Compass', outcome: 'compass', target: { method: 'POST', endpoint: '/api/compass/ask', params: { mediaId: M } } },
      { id: 'create_plan', label: 'Create a plan', outcome: 'plan', target: { method: 'POST', endpoint: '/api/compass/ask', params: { mediaId: M, prompt: 'Build a plan around this.' } } },
      { id: 'add_to_trip', label: 'Add to trip', outcome: 'plan', target: { method: 'POST', endpoint: '/api/trips/:tripId/plan/items', params: { editableTripIds: [T], sourceType: 'place', sourceId: P, title: 'An Thuong', category: 'activity' } } },
      { id: 'do_this_experience', label: 'Do this experience', outcome: 'plan', target: { method: 'POST', endpoint: '/api/trips/:tripId/plan/items', params: { editableTripIds: [T], sourceExperienceId: T } } },
      { id: 'view_experience', label: 'View experience', outcome: 'navigate', target: { method: 'GET', endpoint: '/api/media/experiences/:experienceId', params: { experienceId: T } } },
    ],
    generatedAt: '2026-08-31T10:00:00.000Z',
  };
}

// ── Mapper: action set ────────────────────────────────────────────────────────

test('mapMediaActionSet maps the real payload and renders ONLY returned actions', () => {
  const raw = realActionSet();
  const set = mapMediaActionSet(raw);
  assert.equal(set.mediaId, M);
  assert.equal(set.generatedAt, '2026-08-31T10:00:00.000Z');
  assert.equal(set.entityRefs.length, 3);
  assert.equal(set.entityRefs[1].kind, 'place');
  assert.equal(set.entityRefs[1].label, 'An Thuong');
  // Exactly the 12 server actions — no synthesised extras, none dropped.
  assert.equal(set.actions.length, raw.actions.length);
  assert.deepEqual(
    set.actions.map((a) => a.id),
    raw.actions.map((a) => a.id),
  );
  const ask = set.actions.find((a) => a.id === 'ask_compass')!;
  assert.equal(ask.target.method, 'POST');
  assert.equal(ask.target.endpoint, '/api/compass/ask');
  assert.equal(ask.target.params.mediaId, M);
});

test('mapMediaActionSet drops malformed actions (no fabrication, no crash)', () => {
  const set = mapMediaActionSet({
    mediaId: M,
    entityRefs: [{ kind: 'media', id: M, label: null }, 'garbage', { id: null }],
    actions: [
      { id: 'save', label: 'Save', outcome: 'save', target: { method: 'POST', endpoint: '/api/media/:id/save', params: {} } },
      { id: 'no_target', label: 'X', outcome: 'navigate' }, // missing target → dropped
      { label: 'no id', target: { endpoint: '/x' } }, // missing id → dropped
      { id: 'no_endpoint', label: 'Y', target: { method: 'GET' } }, // missing endpoint → dropped
      'not an object',
    ],
  });
  assert.equal(set.actions.length, 1);
  assert.equal(set.actions[0].id, 'save');
  assert.equal(set.entityRefs.length, 1); // only the valid media ref survives
});

test('mapMediaActionSet is safe on {} / null / garbage', () => {
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    const set = mapMediaActionSet(bad as unknown);
    assert.equal(set.mediaId, '');
    assert.deepEqual(set.actions, []);
    assert.deepEqual(set.entityRefs, []);
    assert.equal(set.generatedAt, null);
  }
});

// ── Resolver: action → client destination ─────────────────────────────────────

const REFS: MediaEntityRef[] = [
  { kind: 'media', id: M, label: null },
  { kind: 'place', id: P, label: 'An Thuong' },
  { kind: 'trip', id: T, label: 'Da Nang trip' },
];

function action(raw: Partial<MediaAction> & { id: string }): MediaAction {
  return {
    id: raw.id,
    label: raw.label ?? raw.id,
    outcome: raw.outcome ?? 'navigate',
    target: raw.target ?? { method: 'GET', endpoint: '/x', params: {} },
  } as MediaAction;
}

test('resolveMediaActionExecution: Ask Compass carries the mediaId + default prompt (§32)', () => {
  const exec = resolveMediaActionExecution(
    action({ id: 'ask_compass', target: { method: 'POST', endpoint: '/api/compass/ask', params: { mediaId: M } } }),
    REFS,
  );
  assert.equal(exec.kind, 'compass');
  assert.equal(exec.kind === 'compass' && exec.mediaId, M);
  assert.equal(exec.kind === 'compass' && exec.prompt, ASK_COMPASS_DEFAULT_PROMPT);
});

test('resolveMediaActionExecution: Create Plan uses the server prompt when present', () => {
  const exec = resolveMediaActionExecution(
    action({ id: 'create_plan', target: { method: 'POST', endpoint: '/api/compass/ask', params: { mediaId: M, prompt: 'Build a plan around this.' } } }),
    REFS,
  );
  assert.equal(exec.kind, 'compass');
  assert.equal(exec.kind === 'compass' && exec.prompt, 'Build a plan around this.');
  // And falls back to the default when the server omits it.
  const exec2 = resolveMediaActionExecution(
    action({ id: 'create_plan', target: { method: 'POST', endpoint: '/api/compass/ask', params: { mediaId: M } } }),
    REFS,
  );
  assert.equal(exec2.kind === 'compass' && exec2.prompt, CREATE_PLAN_DEFAULT_PROMPT);
});

test('resolveMediaActionExecution: I Want This → intent (distinct from save)', () => {
  assert.equal(resolveMediaActionExecution(action({ id: 'i_want_this' }), REFS).kind, 'intent');
  assert.equal(resolveMediaActionExecution(action({ id: 'save' }), REFS).kind, 'save');
});

test('resolveMediaActionExecution: Do This Experience → experience_plan with the experience id', () => {
  const exec = resolveMediaActionExecution(
    action({ id: 'do_this_experience', target: { method: 'POST', endpoint: '/api/trips/:tripId/plan/items', params: { sourceExperienceId: T } } }),
    REFS,
  );
  assert.equal(exec.kind, 'experience_plan');
  assert.equal(exec.kind === 'experience_plan' && exec.experienceId, T);
});

test('resolveMediaActionExecution: Add to Trip → plan_picker source (propose-only)', () => {
  const exec = resolveMediaActionExecution(
    action({ id: 'add_to_trip', target: { method: 'POST', endpoint: '/api/trips/:tripId/plan/items', params: { sourceType: 'place', sourceId: P, title: 'An Thuong', category: 'activity' } } }),
    REFS,
  );
  assert.equal(exec.kind, 'plan_picker');
  if (exec.kind === 'plan_picker') {
    assert.equal(exec.source.id, P);
    assert.equal(exec.source.type, 'place');
    assert.equal(exec.source.title, 'An Thuong');
  }
});

test('resolveMediaActionExecution: navigation actions resolve to existing routes', () => {
  const showOnMap = resolveMediaActionExecution(
    action({ id: 'show_on_map', target: { method: 'GET', endpoint: '/api/media/places/:placeId', params: { placeId: P } } }),
    REFS,
  );
  assert.equal(showOnMap.kind === 'navigate' && showOnMap.route, `/place/${P}`);

  assert.equal(
    (resolveMediaActionExecution(action({ id: 'see_nearby' }), REFS) as { route: string }).route,
    '/media-world',
  );
  assert.equal(
    (resolveMediaActionExecution(action({ id: 'find_similar' }), REFS) as { route: string }).route,
    '/media-world',
  );
  assert.equal(
    (resolveMediaActionExecution(action({ id: 'meet_here' }), REFS) as { route: string }).route,
    '/meetups',
  );
  assert.equal(
    (resolveMediaActionExecution(action({ id: 'share_telegraph' }), REFS) as { route: string }).route,
    '/telegraph/new',
  );
  const viewExp = resolveMediaActionExecution(
    action({ id: 'view_experience', target: { method: 'GET', endpoint: '/api/media/experiences/:experienceId', params: { experienceId: T } } }),
    REFS,
  );
  assert.equal(viewExp.kind === 'navigate' && viewExp.route, `/trip/${T}`);
});

test('resolveMediaActionExecution: report → report; unknown id → unsupported (no dead rows)', () => {
  assert.equal(resolveMediaActionExecution(action({ id: 'report' }), REFS).kind, 'report');
  assert.equal(resolveMediaActionExecution(action({ id: 'some_future_action' }), REFS).kind, 'unsupported');
  // A place-bound action with no place ref anywhere degrades to unsupported.
  assert.equal(
    resolveMediaActionExecution(action({ id: 'show_on_map', target: { method: 'GET', endpoint: '/x', params: {} } }), [
      { kind: 'media', id: M, label: null },
    ]).kind,
    'unsupported',
  );
});

test('every known action id resolves to a supported execution with a full ref set', () => {
  for (const id of MEDIA_ACTION_IDS) {
    // Provide the params the resolver reads for the param-driven ids.
    const params: Record<string, unknown> = {
      placeId: P,
      mediaId: M,
      sourceId: P,
      sourceExperienceId: T,
      experienceId: T,
      sourceType: 'place',
    };
    const exec = resolveMediaActionExecution(action({ id, target: { method: 'GET', endpoint: '/x', params } }), REFS);
    assert.notEqual(exec.kind, 'unsupported', `action ${id} should be supported`);
  }
});

// ── Toggle + degrade rule ──────────────────────────────────────────────────────

test('resolveWantedAfterRequest keeps the optimistic value on success, reverts on failure', () => {
  // Turning it ON, request succeeds → stays on.
  assert.equal(resolveWantedAfterRequest(true, false, true), true);
  // Turning it ON, request fails → reverts to off.
  assert.equal(resolveWantedAfterRequest(true, false, false), false);
  // Turning it OFF, request succeeds → stays off.
  assert.equal(resolveWantedAfterRequest(false, true, true), false);
  // Turning it OFF, request fails → reverts to on.
  assert.equal(resolveWantedAfterRequest(false, true, false), true);
});

// ── Mapper: experience plan ────────────────────────────────────────────────────

test('mapExperiencePlan maps the real /plan shape', () => {
  const plan = mapExperiencePlan({
    experienceId: T,
    kind: 'trip',
    targetEndpoint: '/api/trips/:tripId/plan/items',
    method: 'POST',
    stops: [
      { sourceType: 'place', sourceId: P, title: 'An Thuong', category: 'activity' },
      { sourceType: 'media', sourceId: M, title: 'Rooftop', category: 'activity' },
    ],
    eligibleTripIds: [T],
    generatedAt: '2026-08-31T10:00:00.000Z',
  });
  assert.ok(plan);
  assert.equal(plan!.experienceId, T);
  assert.equal(plan!.kind, 'trip');
  assert.equal(plan!.stops.length, 2);
  assert.equal(plan!.stops[0].sourceId, P);
  assert.deepEqual(plan!.eligibleTripIds, [T]);
});

test('mapExperiencePlan returns null when there is no usable experience id', () => {
  assert.equal(mapExperiencePlan({}), null);
  assert.equal(mapExperiencePlan(null), null);
  assert.equal(mapExperiencePlan({ kind: 'trip', stops: [] }), null);
});

// ── Transport degrade ──────────────────────────────────────────────────────────

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
  return () => {
    (globalThis as { fetch: typeof fetch }).fetch = original;
  };
}

test('fetchMediaActions: 200 maps the eligible set', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () =>
    new Response(JSON.stringify(realActionSet()), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  try {
    const r = await fetchMediaActions(M);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data.actions.length, 12);
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchMediaActions: 404 degrades to empty (no rail), never throws', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => new Response('not found', { status: 404 }));
  try {
    const r = await fetchMediaActions(M);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'empty');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchMediaActions: missing token → auth (no fetch attempted)', async () => {
  _setTestFreshToken(''); // falsy token
  try {
    const r = await fetchMediaActions(M);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'auth');
  } finally {
    _clearTestFreshToken();
  }
});

test('fetchMediaActions: network throw is caught (never throws)', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => { throw new Error('network request failed'); });
  try {
    const r = await fetchMediaActions(M);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'network');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchExperiencePlan: 404 degrades to ok/null (no plan to propose)', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => new Response('nope', { status: 404 }));
  try {
    const r = await fetchExperiencePlan(T);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data, null);
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('postMediaIntent / deleteMediaIntent: success + failure surfaced, never thrown', async () => {
  _setTestFreshToken('tok');
  let restore = stubFetch(async () => new Response(JSON.stringify({ recorded: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    assert.equal((await postMediaIntent(M, 'want_to_go')).ok, true);
    assert.equal((await deleteMediaIntent(M)).ok, true);
  } finally {
    restore();
  }
  restore = stubFetch(async () => new Response('boom', { status: 500 }));
  try {
    const p = await postMediaIntent(M);
    assert.equal(p.ok, false);
    assert.equal(p.errorKind, 'server');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});
