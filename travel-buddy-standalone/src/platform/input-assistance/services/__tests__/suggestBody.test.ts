/**
 * Phase 7 (Compass + AI) — the suggest request body builder (§22 opt-in, §29).
 *
 * Pure logic — runs under node:test. Proves the AI opt-in only reaches the wire
 * when the caller explicitly opts in, and that a default (non-AI) request body is
 * byte-for-byte the pre-Phase-7 shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSuggestBody } from '../suggestBody.ts';
import type { SuggestRequest } from '../../types/inputSuggestion.ts';
import { GLOBAL_SEARCH_CAPABILITIES } from '../../contexts/clientCapabilities.ts';

function base(overrides: Partial<SuggestRequest> = {}): SuggestRequest {
  return {
    context: 'compass_prompt',
    fieldId: 'compass.prompt',
    text: 'where should I',
    limit: 8,
    ...overrides,
  };
}

test('a default request omits aiAssist entirely (opt-in is real; default body unchanged)', () => {
  const body = buildSuggestBody(base());
  assert.equal('aiAssist' in body, false, 'aiAssist must not be present by default');
  // The classic fields are all present and unchanged.
  assert.equal(body.context, 'compass_prompt');
  assert.equal(body.fieldId, 'compass.prompt');
  assert.equal(body.text, 'where should I');
  assert.equal(body.limit, 8);
  // No coarse AI-context keys leak in when not set.
  assert.equal('city' in body, false);
  assert.equal('draft' in body, false);
  assert.equal('tz' in body, false);
});

test('aiAssist:true is forwarded; aiAssist:false / undefined never sets the key', () => {
  assert.equal(buildSuggestBody(base({ aiAssist: true })).aiAssist, true);
  assert.equal('aiAssist' in buildSuggestBody(base({ aiAssist: false })), false);
  assert.equal('aiAssist' in buildSuggestBody(base({ aiAssist: undefined })), false);
  // Only a literal boolean true opts in — a truthy non-boolean must NOT.
  assert.equal('aiAssist' in buildSuggestBody(base({ aiAssist: 1 as unknown as boolean })), false);
});

test('coarse city/tz/draft are forwarded only when meaningfully set (§29)', () => {
  const body = buildSuggestBody(
    base({ aiAssist: true, city: 'Da Nang', tz: 'Asia/Ho_Chi_Minh', draft: { city: 'Da Nang', category: 'food' } }),
  );
  assert.equal(body.city, 'Da Nang');
  assert.equal(body.tz, 'Asia/Ho_Chi_Minh');
  assert.deepEqual(body.draft, { city: 'Da Nang', category: 'food' });

  // Blank / empty values are dropped.
  const blank = buildSuggestBody(base({ city: '   ', tz: '', draft: {} }));
  assert.equal('city' in blank, false);
  assert.equal('tz' in blank, false);
  assert.equal('draft' in blank, false);
});

// ── §48 the capability handshake's REQUEST half (census G343) ────────────────

test('§48: a caller that declares nothing sends the body it always sent', () => {
  // The handshake must be additive. A surface that does not participate must
  // produce a byte-for-byte unchanged request, or this is a flag day for every
  // screen at once rather than a negotiation.
  const body = buildSuggestBody(base());
  assert.equal('client' in body, false);
});

test('§48: a declaration reaches the wire verbatim', () => {
  const body = buildSuggestBody(base({ client: GLOBAL_SEARCH_CAPABILITIES }));
  assert.deepEqual(body.client, GLOBAL_SEARCH_CAPABILITIES);
});

test('§48: an EMPTY declaration is not sent — it would read as "I render nothing"', () => {
  // The server treats an absent block as "serve it the way you always did" and
  // a present one as a narrowing instruction. Sending an empty one would ask
  // the server to withhold everything.
  assert.equal('client' in buildSuggestBody(base({ client: { schemaVersion: 1 } })), false);
  assert.equal(
    'client' in buildSuggestBody(base({ client: { schemaVersion: 1, actionTypes: [], suggestionTypes: [] } })),
    false,
  );
});

// §45 / OD-INPUT-1 — the outcome-learning hint rides the body ONLY as a literal
// true, and only when the caller set it (the hook sets it while this account's
// opt-in gate is open). The server re-checks consent, so the hint grants nothing;
// leaving it off keeps every non-consenting serve free of outcome reads.
test('outcomeLearning is sent only as a literal true, and omitted otherwise', () => {
  const base = { context: 'city_picker' as const, fieldId: 'geo.city', text: 'sant', limit: 8 };
  assert.equal(buildSuggestBody({ ...base, outcomeLearning: true }).outcomeLearning, true);
  for (const v of [false, undefined, 'true' as unknown as boolean, 1 as unknown as boolean]) {
    assert.ok(!('outcomeLearning' in buildSuggestBody({ ...base, outcomeLearning: v })), `sent for ${String(v)}`);
  }
});

// census G150 (§23) — a NEW Trip's window rides `sessionContext`, which is where
// app/trip/new.tsx puts it and where the server's trip-date check now reads it
// (`withDeclaredSessionDates` in routes/inputAssistance.ts). This pins the client
// half: the body carries the two dates exactly as the screen set them.
// MUTATION: emit `sessionContext` without its dates in buildSuggestBody → red.
test('G150: a new Trip\'s window travels in the session context, unchanged', () => {
  const body = buildSuggestBody({
    context: 'trip_title', fieldId: 'creation.trip_title', text: 'Spring Escape', limit: 8,
    sessionContext: { surface: 'trip_create', startDate: '2026-03-15', endDate: '2026-03-25' },
  });
  assert.deepEqual(body.sessionContext, { surface: 'trip_create', startDate: '2026-03-15', endDate: '2026-03-25' });
});

// ── census G176 (wave-5 fix) — the viewer's position on the wire ─────────────
//
// The two callers with a granted position (GlobalPlacePicker, the search screen)
// hand it to the hook as `sessionContext.lat/lng`. The route reads the position
// from the TOP-LEVEL pair only, so this builder is where the two meet: a valid
// pair is lifted, coarsened to 3 decimals, and removed from the session object.
// MUTATIONS (each red alone, restored): no lift; no coarsening; the range or the
// finiteness check dropped; the session forwarded with the pair still in it.
test('G176: a supplied pair rides at the top level, coarsened to 3 decimals, and never inside the session', () => {
  const body = buildSuggestBody({
    context: 'place_picker', fieldId: 'place_picker', text: 'lantern', limit: 8,
    sessionContext: { surface: 'event_create', tripId: 't-1', lat: 15.870012345, lng: 108.338049876 },
  });
  assert.equal(body.lat, 15.87);
  assert.equal(body.lng, 108.338);
  assert.deepEqual(body.sessionContext, { surface: 'event_create', tripId: 't-1' });
  const wire = JSON.stringify(body);
  assert.ok(!wire.includes('15.870012') && !wire.includes('108.33804'), 'the device fix never reaches the wire');
});

test('G176: no position supplied → no position keys, and the session is forwarded exactly as given', () => {
  const session = { surface: 'search', tz: 'Asia/Ho_Chi_Minh' };
  const body = buildSuggestBody({ context: 'global_search', fieldId: 'discovery.search', text: 'han', limit: 8, sessionContext: session });
  assert.equal('lat' in body, false);
  assert.equal('lng' in body, false);
  assert.equal(body.sessionContext, session, 'byte-for-byte the pre-G176 body: the same object');
  const bare = buildSuggestBody({ context: 'global_search', fieldId: 'discovery.search', text: 'han', limit: 8 });
  assert.equal('lat' in bare, false);
  assert.equal(bare.sessionContext, undefined);
});

test('G176: an unusable pair sends NO position — never half of one — and is still stripped from the session', () => {
  const bad: Array<Record<string, unknown>> = [
    { lat: 91, lng: 10 }, { lat: -91, lng: 10 }, { lat: 10, lng: 181 }, { lat: 10, lng: -181 },
    { lat: Number.NaN, lng: 10 }, { lat: 10, lng: Number.POSITIVE_INFINITY }, { lat: 10 }, { lng: 10 },
    { lat: '10', lng: '20' }, { lat: null, lng: 20 },
  ];
  for (const coords of bad) {
    const body = buildSuggestBody({
      context: 'place_picker', fieldId: 'place_picker', text: 'x', limit: 8,
      sessionContext: { surface: 'event_create', ...(coords as object) },
    });
    assert.equal('lat' in body, false, JSON.stringify(coords));
    assert.equal('lng' in body, false, JSON.stringify(coords));
    assert.deepEqual(body.sessionContext, { surface: 'event_create' }, JSON.stringify(coords));
  }
  // The edges themselves are valid positions.
  const edge = buildSuggestBody({ context: 'place_picker', fieldId: 'place_picker', text: 'x', limit: 8, sessionContext: { lat: -90, lng: 180 } });
  assert.equal(edge.lat, -90);
  assert.equal(edge.lng, 180);
});
