/**
 * Telemetry outcome integrity — the NEGATIVE cases, and decision continuity.
 *
 * mapTelemetry.test.ts covers what the emitter does when asked correctly. This
 * file covers two things that are easy to get wrong and invisible when wrong:
 *
 *  1. A REFUSED Meet Here must not look like a successful one. If a §23 policy
 *     block emitted `meet_here_created`, the funnel would count a disclosure
 *     that never happened. If it emitted nothing at all, a rule that fires
 *     constantly would be indistinguishable from a feature nobody uses — and
 *     the obvious "fix" for dead code is to delete the rule.
 *
 *  2. A decision must survive the client lifecycle. `alternative_requested`
 *     carries a round precisely so "user rejected three suggestions" is ONE
 *     decision with three rounds. If a refresh, a retry or a back-navigation
 *     forked the decisionId, that single decision would silently become three
 *     unrelated asks and the rejection signal would vanish into the noise.
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAP_EVENT_NAMES,
  clearActiveDecision,
  currentDecisionId,
  describeMapObject,
  emitMapEvent,
  endMapSession,
  flushMapTelemetry,
  setMapTelemetryTransport,
  type MapTelemetryBatch,
} from '../mapTelemetry.ts';
import { point, type MapObject } from '../../../../types/mapObjects.ts';

/** Collects every event the emitter flushes, so assertions read the real stream. */
function collector() {
  const events: MapTelemetryBatch['events'] = [];
  setMapTelemetryTransport(async (batch) => {
    events.push(...batch.events);
    return { ok: true };
  });
  return {
    events,
    names: () => events.map((e) => e.name),
    named: (n: string) => events.filter((e) => e.name === n),
    /** The emitter BATCHES; nothing reaches the transport until it flushes. */
    flush: () => flushMapTelemetry(),
  };
}

function obj(over: Partial<MapObject> = {}): MapObject {
  return {
    id: 'social_zone:s1',
    kind: 'social_zone',
    geometry: point(16.05, 108.2),
    title: 'Traveler nearby',
    privacyClass: 'aggregate_only',
    renderingPriority: 30,
    ...over,
  };
}

beforeEach(() => {
  endMapSession();
  clearActiveDecision();
});

// ── 1. A refusal is not a success ─────────────────────────────────────────────

describe('a refused Meet Here', () => {
  test('emits meet_here_refused and NOT meet_here_created', async () => {
    const c = collector();
    emitMapEvent('map_opened', { entry: 'direct', mode: 'LIVE', hasTripContext: false, hasCrewContext: false });
    emitMapEvent('meet_here_refused', {
      ref: describeMapObject(obj()),
      reason: 'aggregate_subject',
      surface: 'action_rail',
    });
    await c.flush();
    assert.equal(c.named('meet_here_created').length, 0, 'a refusal must never count as a disclosure');
    assert.equal(c.named('meet_here_refused').length, 1);
    assert.equal(c.named('meet_here_refused')[0].payload.reason, 'aggregate_subject');
  });

  test('carries the RULE that fired, not just "it failed"', async () => {
    const c = collector();
    for (const reason of ['aggregate_subject', 'no_geometry', 'not_visible'] as const) {
      emitMapEvent('meet_here_refused', {
        ref: describeMapObject(obj()),
        reason,
        surface: 'long_press',
      });
    }
    await c.flush();
    const reasons = c.named('meet_here_refused').map((e) => e.payload.reason);
    assert.deepEqual(reasons, ['aggregate_subject', 'no_geometry', 'not_visible']);
  });

  test('distinguishes the surface, so rail and long-press are separable', async () => {
    const c = collector();
    emitMapEvent('meet_here_refused', {
      ref: describeMapObject(obj()),
      reason: 'aggregate_subject',
      surface: 'long_press',
    });
    await c.flush();
    assert.equal(c.named('meet_here_refused')[0].payload.surface, 'long_press');
  });

  test('is NOT decision-scoped — a refusal is not an outcome of a recommendation', async () => {
    const c = collector();
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    const decision = currentDecisionId();
    assert.ok(decision, 'a compass ask should open a decision');

    emitMapEvent('meet_here_refused', {
      ref: describeMapObject(obj()),
      reason: 'aggregate_subject',
      surface: 'action_rail',
    });
    await c.flush();
    assert.equal(
      c.named('meet_here_refused')[0].payload.decisionId,
      undefined,
      'attaching a decisionId would let a policy block count against a recommendation it had nothing to do with',
    );
  });

  test('the refused subject is coarsened like every other ref', async () => {
    const c = collector();
    emitMapEvent('meet_here_refused', {
      ref: describeMapObject(obj({ privacyClass: 'place_level', title: 'Rooftop Bar' })),
      reason: 'no_geometry',
      surface: 'place_sheet',
    });
    await c.flush();
    const serialized = JSON.stringify(c.named('meet_here_refused')[0]);
    assert.ok(!serialized.includes('16.05'), 'no raw latitude');
    assert.ok(!serialized.includes('108.2'), 'no raw longitude');
    assert.ok(!serialized.includes('Rooftop Bar'), 'no subject title');
  });
});

// ── 2. Decision continuity across the client lifecycle ────────────────────────

describe('decision continuity', () => {
  test('a retry does not fork the decision', async () => {
    const c = collector();
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    const first = currentDecisionId();

    // A failed request the user retried: the SAME question, asked again.
    emitMapEvent('alternative_requested', { reason: 'not_interested', round: 1 });
    emitMapEvent('alternative_requested', { reason: 'not_interested', round: 2 });
    await c.flush();

    const ids = c.named('alternative_requested').map((e) => e.payload.decisionId);
    assert.deepEqual(ids, [first, first], 'both rounds belong to one decision');
  });

  test('rounds increase monotonically within one decision', async () => {
    const c = collector();
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    for (let r = 1; r <= 4; r += 1) {
      emitMapEvent('alternative_requested', { reason: 'not_interested', round: r });
    }
    await c.flush();
    const rounds = c.named('alternative_requested').map((e) => e.payload.round);
    assert.deepEqual(rounds, [1, 2, 3, 4]);
    assert.deepEqual(
      c.named('alternative_requested').map((e) => e.payload.decisionId),
      Array(4).fill(currentDecisionId()),
    );
  });

  test('a NEW ask mints a new decision — rounds do not leak across questions', async () => {
    const c = collector();
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    const first = currentDecisionId();
    emitMapEvent('alternative_requested', { reason: 'not_interested', round: 1 });

    clearActiveDecision();
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    const second = currentDecisionId();
    emitMapEvent('alternative_requested', { reason: 'not_interested', round: 1 });
    await c.flush();

    assert.notEqual(first, second, 'a different question is a different decision');
    const ids = c.named('alternative_requested').map((e) => e.payload.decisionId);
    assert.deepEqual(ids, [first, second]);
  });

  test('the outcome chain shares one decision from ask to contribution', async () => {
    const c = collector();
    emitMapEvent('map_opened', { entry: 'direct', mode: 'LIVE', hasTripContext: false, hasCrewContext: false });
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    const decision = currentDecisionId();

    const ref = describeMapObject(obj({ privacyClass: 'place_level' }));
    emitMapEvent('compass_option_selected', { ref, optionIndex: 0, optionCount: 3 });
    emitMapEvent('recommendation_accepted', { ref, via: 'route' });
    emitMapEvent('route_started', { ref, travelMode: 'unknown', distance: 'unknown' });
    await c.flush();

    for (const name of ['compass_option_selected', 'recommendation_accepted', 'route_started']) {
      assert.equal(
        c.named(name)[0].payload.decisionId,
        decision,
        `${name} left the decision — the §38 outcome loop would break here`,
      );
    }
  });

  test('every event in one session shares one mapSessionId', async () => {
    const c = collector();
    emitMapEvent('map_opened', { entry: 'direct', mode: 'LIVE', hasTripContext: false, hasCrewContext: false });
    emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    emitMapEvent('alternative_requested', { reason: 'not_interested', round: 1 });
    await c.flush();

    const sessions = new Set(c.events.map((e) => e.mapSessionId));
    assert.equal(sessions.size, 1, 'a lifecycle event must not fork the session either');
  });
});

// ── 3. The event set itself ───────────────────────────────────────────────────

describe('the event catalogue', () => {
  test('contains §35s sixteen plus the deliberate refusal event', () => {
    assert.equal(MAP_EVENT_NAMES.length, 17);
    assert.ok(MAP_EVENT_NAMES.includes('meet_here_refused'));
  });

  test('has no duplicates', () => {
    assert.equal(new Set(MAP_EVENT_NAMES).size, MAP_EVENT_NAMES.length);
  });
});
