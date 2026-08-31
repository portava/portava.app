/**
 * features/media — Media v2 Phase 10 (Human Network) client tests (§19/§25/§46).
 *
 * Verifies, against the REAL merged-backend shapes (#295):
 *   (a) mappers coerce the coverage / reputation payloads without throwing and
 *       never fabricate a live label (no-fake-live, §46.2);
 *   (b) the §25 boundary — reputation is intelligence-trust only: basis pinned,
 *       social fields ignored, and the rendered vocabulary carries NO
 *       follower/like/popularity/leaderboard language;
 *   (c) the flag-gate — the Request-a-View affordance is HIDDEN when the flag is
 *       off (dormant by default), and only shows for a real coverage gap;
 *   (d) refusal mapping + calm messaging (never an error storm);
 *   (e) the opt-in optimistic/revert rule;
 *   (f) transport degrades gracefully — 404/empty/missing-auth/network throw all
 *       resolve to a typed result and never throw.
 *
 * Pure node:test suite — imports only the service (no react-native).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapVisualCoverage,
  mapContributorReputation,
  reputationDisplayDimensions,
  percentLabel,
  REPUTATION_TRUST_CAPTION,
  shouldShowRequestPrompt,
  refusalFromResponse,
  refusalMessage,
  resolveOptInAfterRequest,
  fetchVisualCoverage,
  fetchContributorReputation,
  requestView,
  setContributorViewOptIn,
  _setTestFreshToken,
  _clearTestFreshToken,
} from '../services/viewRequest.ts';
import type { VisualCoverage, ViewRequestRefusalReason } from '../types/viewRequest.ts';

const PLACE = '11111111-1111-1111-1111-111111111111';
const CONTRIB = '22222222-2222-2222-2222-222222222222';

// ── mapVisualCoverage (§19) ────────────────────────────────────────────────────

test('mapVisualCoverage: maps the real { coverage } envelope', () => {
  const cov = mapVisualCoverage({
    coverage: {
      lastObservedAt: '2026-08-31T12:00:00.000Z',
      ageMinutes: 28,
      lastUpdateLabel: '28m ago',
      stale: true,
      noCoverage: false,
    },
  });
  assert.equal(cov.ageMinutes, 28);
  assert.equal(cov.lastUpdateLabel, '28m ago');
  assert.equal(cov.stale, true);
  assert.equal(cov.noCoverage, false);
});

test('mapVisualCoverage: tolerates a bare object (no envelope)', () => {
  const cov = mapVisualCoverage({ lastObservedAt: null, ageMinutes: null, lastUpdateLabel: null, stale: true, noCoverage: true });
  assert.equal(cov.noCoverage, true);
  assert.equal(cov.lastUpdateLabel, null);
});

test('mapVisualCoverage: garbage/empty ⇒ a coverage void (stale + noCoverage), never throws', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { coverage: null }]) {
    const cov = mapVisualCoverage(bad);
    assert.equal(cov.stale, true, `stale for ${JSON.stringify(bad)}`);
    assert.equal(cov.noCoverage, true, `noCoverage for ${JSON.stringify(bad)}`);
    assert.equal(cov.lastUpdateLabel, null);
  }
});

test('no-fake-live: a payload without a label never gets a fabricated one', () => {
  const cov = mapVisualCoverage({ coverage: { lastObservedAt: null, ageMinutes: null, stale: true } });
  assert.equal(cov.lastUpdateLabel, null);
});

// ── mapContributorReputation (§25) ─────────────────────────────────────────────

test('mapContributorReputation: maps the real { reputation } envelope + clamps 0..1', () => {
  const rep = mapContributorReputation({
    reputation: {
      contributorReliability: 0.82,
      placeExpertise: 1.4, // out of range → clamps to 1
      liveAccuracy: -0.2, // out of range → clamps to 0
      basis: 'intelligence_trust',
      isEmpty: false,
    },
  });
  assert.equal(rep.contributorReliability, 0.82);
  assert.equal(rep.placeExpertise, 1);
  assert.equal(rep.liveAccuracy, 0);
  assert.equal(rep.basis, 'intelligence_trust');
  assert.equal(rep.isEmpty, false);
});

test('§25 boundary: basis is PINNED — a payload claiming another basis cannot render popularity as trust', () => {
  const rep = mapContributorReputation({ reputation: { contributorReliability: 0.5, basis: 'social_popularity' } });
  assert.equal(rep.basis, 'intelligence_trust');
});

test('§25 boundary: social/popularity fields in the payload are IGNORED (no path into the number)', () => {
  const withSocial = mapContributorReputation({
    reputation: {
      contributorReliability: 0.7,
      placeExpertise: 0.5,
      liveAccuracy: 0.6,
      followers: 999999,
      likes: 4242,
      isEmpty: false,
    },
  });
  const withoutSocial = mapContributorReputation({
    reputation: { contributorReliability: 0.7, placeExpertise: 0.5, liveAccuracy: 0.6, isEmpty: false },
  });
  // Identical intel dimensions ⇒ byte-identical reputation, regardless of reach.
  assert.deepEqual(withSocial, withoutSocial);
  // And the object exposes ONLY intelligence-trust keys — no social field survives.
  assert.deepEqual(
    Object.keys(withSocial).sort(),
    ['basis', 'contributorReliability', 'isEmpty', 'liveAccuracy', 'placeExpertise'],
  );
});

test('mapContributorReputation: empty when no signal (pre-launch graceful)', () => {
  const rep = mapContributorReputation({ reputation: {} });
  assert.equal(rep.isEmpty, true);
  assert.equal(rep.contributorReliability, 0);
});

// ── reputationDisplayDimensions + vocabulary boundary (§25) ─────────────────────

test('reputationDisplayDimensions: renders the three §25 dimensions with percent labels', () => {
  const dims = reputationDisplayDimensions({
    contributorReliability: 0.82,
    placeExpertise: 0.6,
    liveAccuracy: 0.75,
    basis: 'intelligence_trust',
    isEmpty: false,
  });
  assert.equal(dims.length, 3);
  assert.deepEqual(dims.map((d) => d.key), ['contributorReliability', 'placeExpertise', 'liveAccuracy']);
  assert.deepEqual(dims.map((d) => d.percentLabel), ['82%', '60%', '75%']);
  assert.ok(dims.every((d) => d.label.length > 0 && d.description.length > 0));
});

test('reputationDisplayDimensions: empty reputation ⇒ [] (no hollow 0% rows)', () => {
  const dims = reputationDisplayDimensions({
    contributorReliability: 0,
    placeExpertise: 0,
    liveAccuracy: 0,
    basis: 'intelligence_trust',
    isEmpty: true,
  });
  assert.equal(dims.length, 0);
  assert.equal(reputationDisplayDimensions(null).length, 0);
});

test('§25 boundary: dimension labels + descriptions carry NO popularity/vanity language', () => {
  const dims = reputationDisplayDimensions({
    contributorReliability: 0.5,
    placeExpertise: 0.5,
    liveAccuracy: 0.5,
    basis: 'intelligence_trust',
    isEmpty: false,
  });
  const forbidden = /follow|like|fan|popular|trend|viral|leaderboard|rank|vanity|most|top\b/i;
  for (const d of dims) {
    assert.ok(!forbidden.test(d.label), `label must be evidence-based, got: ${d.label}`);
    assert.ok(!forbidden.test(d.description), `description must be evidence-based, got: ${d.description}`);
  }
});

test('§25 boundary: the caption states the boundary explicitly (trust, not popularity)', () => {
  assert.match(REPUTATION_TRUST_CAPTION, /trust/i);
  assert.match(REPUTATION_TRUST_CAPTION, /not popularity/i);
});

test('percentLabel: rounds + clamps', () => {
  assert.equal(percentLabel(0.826), '83%');
  assert.equal(percentLabel(0), '0%');
  assert.equal(percentLabel(1), '100%');
  assert.equal(percentLabel(2), '100%');
  assert.equal(percentLabel(-1), '0%');
});

// ── Flag-gate: dormant by default (§19) ────────────────────────────────────────

const staleCov: VisualCoverage = { lastObservedAt: '2026-08-31T12:00:00Z', ageMinutes: 28, lastUpdateLabel: '28m ago', stale: true, noCoverage: false };
const freshCov: VisualCoverage = { lastObservedAt: '2026-08-31T12:59:00Z', ageMinutes: 1, lastUpdateLabel: '1m ago', stale: false, noCoverage: false };
const voidCov: VisualCoverage = { lastObservedAt: null, ageMinutes: null, lastUpdateLabel: null, stale: true, noCoverage: true };

test('shouldShowRequestPrompt: flag OFF ⇒ hidden even when the place is stale', () => {
  assert.equal(shouldShowRequestPrompt(staleCov, false), false);
  assert.equal(shouldShowRequestPrompt(voidCov, false), false);
});

test('shouldShowRequestPrompt: flag ON ⇒ shows only for a coverage gap (stale / no coverage)', () => {
  assert.equal(shouldShowRequestPrompt(staleCov, true), true);
  assert.equal(shouldShowRequestPrompt(voidCov, true), true);
  assert.equal(shouldShowRequestPrompt(freshCov, true), false); // fresh place → nothing
});

test('shouldShowRequestPrompt: null coverage (unknown / error) ⇒ hidden', () => {
  assert.equal(shouldShowRequestPrompt(null, true), false);
  assert.equal(shouldShowRequestPrompt(null, false), false);
});

// ── Refusal mapping + calm messaging (§19/§46) ─────────────────────────────────

test('refusalFromResponse: maps the real STATUS table to calm reasons', () => {
  assert.equal(refusalFromResponse(404, 'feature_disabled'), 'disabled');
  assert.equal(refusalFromResponse(429, 'rate_limited'), 'rate_limited');
  assert.equal(refusalFromResponse(409, 'conflict'), 'duplicate');
  assert.equal(refusalFromResponse(403, 'forbidden'), 'protected_location');
  assert.equal(refusalFromResponse(400, 'invalid_payload'), 'invalid');
  assert.equal(refusalFromResponse(404, null), 'disabled'); // route absent ⇒ dormant
  assert.equal(refusalFromResponse(500, 'db_error'), 'server');
});

test('refusalMessage: every reason yields a calm, non-empty, non-shouting line', () => {
  const reasons: ViewRequestRefusalReason[] = ['disabled', 'rate_limited', 'duplicate', 'protected_location', 'invalid', 'server'];
  for (const r of reasons) {
    const msg = refusalMessage(r);
    assert.ok(msg.length > 0);
    assert.ok(!/error|fail|!!/i.test(msg), `message should stay calm, got: ${msg}`);
  }
});

// ── Opt-in optimistic/revert (§19) ─────────────────────────────────────────────

test('resolveOptInAfterRequest: keep on success, revert on failure', () => {
  assert.equal(resolveOptInAfterRequest(true, false, true), true); // opt-in accepted
  assert.equal(resolveOptInAfterRequest(true, false, false), false); // failed → revert to off
  assert.equal(resolveOptInAfterRequest(false, true, false), true); // opt-out failed → revert to on
});

// ── Transport degrade ──────────────────────────────────────────────────────────

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
  return () => {
    (globalThis as { fetch: typeof fetch }).fetch = original;
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('fetchVisualCoverage: 200 maps; hits the /api/v1 path', async () => {
  _setTestFreshToken('tok');
  let seenUrl = '';
  const restore = stubFetch(async (url) => {
    seenUrl = url;
    return json({ coverage: { lastObservedAt: '2026-08-31T12:00:00Z', ageMinutes: 28, lastUpdateLabel: '28m ago', stale: true, noCoverage: false } });
  });
  try {
    const r = await fetchVisualCoverage(PLACE, { city: 'Da Nang' });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data.lastUpdateLabel, '28m ago');
    assert.match(seenUrl, /\/api\/v1\/media\/places\/.*\/visual-coverage/);
    assert.match(seenUrl, /city=Da\+Nang/);
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchVisualCoverage: 404 degrades to empty (affordance hidden), never throws', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => new Response('nope', { status: 404 }));
  try {
    const r = await fetchVisualCoverage(PLACE);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'empty');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('fetchVisualCoverage: missing token → auth (no fetch attempted)', async () => {
  _setTestFreshToken('');
  try {
    const r = await fetchVisualCoverage(PLACE);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.errorKind, 'auth');
  } finally {
    _clearTestFreshToken();
  }
});

test('fetchContributorReputation: 200 maps; 404 degrades to empty', async () => {
  _setTestFreshToken('tok');
  let restore = stubFetch(async () => json({ reputation: { contributorReliability: 0.9, placeExpertise: 0.4, liveAccuracy: 0.7, basis: 'intelligence_trust', isEmpty: false } }));
  try {
    const r = await fetchContributorReputation(CONTRIB, { subjectId: PLACE });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data.basis, 'intelligence_trust');
  } finally {
    restore();
  }
  restore = stubFetch(async () => new Response('nope', { status: 404 }));
  try {
    const r = await fetchContributorReputation(CONTRIB);
    assert.equal(r.ok === false && r.errorKind, 'empty');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('requestView: 201 maps success + recipientCount', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => json({ requestId: 'req-1', missionCandidateId: 'm-1', recipientCount: 3 }, 201));
  try {
    const r = await requestView({ placeId: PLACE, question: 'Is the entrance still busy?' });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.recipientCount, 3);
    assert.equal(r.ok && r.requestId, 'req-1');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('requestView: recipientCount 0 is a graceful success (nobody opted in yet)', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => json({ requestId: 'req-2', missionCandidateId: null, recipientCount: 0 }, 201));
  try {
    const r = await requestView({ placeId: PLACE, question: 'Show me' });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.recipientCount, 0);
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('requestView: 429 → calm rate_limited refusal (never throws)', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => json({ error: 'rate_limited', message: 'slow down' }, 429));
  try {
    const r = await requestView({ placeId: PLACE, question: 'busy?' });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'rate_limited');
    assert.ok(r.ok === false && r.message.length > 0);
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('requestView: flag-off 404 feature_disabled → calm disabled refusal', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => json({ error: 'feature_disabled', message: 'off' }, 404));
  try {
    const r = await requestView({ placeId: PLACE, question: 'busy?' });
    assert.equal(r.ok === false && r.reason, 'disabled');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('requestView: protected place 403 → protected_location refusal', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => json({ error: 'forbidden', message: 'protected' }, 403));
  try {
    const r = await requestView({ placeId: PLACE, question: 'busy?' });
    assert.equal(r.ok === false && r.reason, 'protected_location');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('requestView: network throw is caught → server refusal (never throws)', async () => {
  _setTestFreshToken('tok');
  const restore = stubFetch(async () => { throw new Error('network request failed'); });
  try {
    const r = await requestView({ placeId: PLACE, question: 'busy?' });
    assert.equal(r.ok === false && r.reason, 'server');
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('requestView: missing token → disabled refusal (no fetch attempted)', async () => {
  _setTestFreshToken('');
  try {
    const r = await requestView({ placeId: PLACE, question: 'busy?' });
    assert.equal(r.ok === false && r.reason, 'disabled');
  } finally {
    _clearTestFreshToken();
  }
});

test('requestView: never sends a requester id or precise-location field in the body', async () => {
  _setTestFreshToken('tok');
  let sentBody: any = null;
  const restore = stubFetch(async (_url, init) => {
    sentBody = init?.body ? JSON.parse(String(init.body)) : null;
    return json({ requestId: 'r', missionCandidateId: null, recipientCount: 0 }, 201);
  });
  try {
    await requestView({ placeId: PLACE, question: 'busy?', city: 'Tokyo' });
    assert.ok(sentBody);
    assert.equal(sentBody.subjectId, PLACE);
    assert.equal('requesterId' in sentBody, false);
    assert.equal('lat' in sentBody, false);
    assert.equal('lng' in sentBody, false);
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('setContributorViewOptIn: 200 ok; 403 auth; 500 server; network caught', async () => {
  _setTestFreshToken('tok');
  let restore = stubFetch(async () => json({ ok: true, optedIn: true }));
  try {
    const r = await setContributorViewOptIn(true, 'Da Nang');
    assert.equal(r.ok, true);
    assert.equal(r.optedIn, true);
  } finally {
    restore();
  }
  restore = stubFetch(async () => new Response('no', { status: 403 }));
  try {
    const r = await setContributorViewOptIn(true);
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, 'auth');
  } finally {
    restore();
  }
  restore = stubFetch(async () => new Response('boom', { status: 500 }));
  try {
    const r = await setContributorViewOptIn(false);
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, 'server');
  } finally {
    restore();
  }
  restore = stubFetch(async () => { throw new Error('network down'); });
  try {
    const r = await setContributorViewOptIn(true);
    assert.equal(r.ok, false);
  } finally {
    restore();
    _clearTestFreshToken();
  }
});

test('setContributorViewOptIn: missing token → auth (no fetch attempted)', async () => {
  _setTestFreshToken('');
  try {
    const r = await setContributorViewOptIn(true);
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, 'auth');
  } finally {
    _clearTestFreshToken();
  }
});
