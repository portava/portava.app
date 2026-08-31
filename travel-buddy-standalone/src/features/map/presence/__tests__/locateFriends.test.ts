/**
 * locateFriends tests — spec §12.
 *
 * §12 is the highest-risk surface in the map spec: it is the one place the
 * product deliberately puts people on a map. These tests are therefore written
 * against the CONSTRAINTS first (opt-in, group scope, mandatory expiry, no
 * identity below `approximate`) and the display strings second.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCATE_SIGNAL_RUNGS,
  RUNG_POLICY,
  PROXIMITY_BUCKETS,
  PROXIMITY_BUCKET_RANGE,
  APPROXIMATE_DISTANCE_LADDER,
  rungIndex,
  unsupportedRungs,
  isRungSupported,
  resolvePosition,
  rangeFor,
  NO_POSITION,
  MAX_SESSION_MS,
  LocateSession,
  createLocateSession,
  endLocateSession,
  removeMember,
  isActive,
  isOptedIn,
  remainingMs,
  resolveMember,
  describeMember,
  describeSessionRemaining,
  formatRange,
  formatAge,
  memberToMapObject,
  checkpointToMapObject,
  LOCATE_FRIENDS_PURPOSE,
  type LocateSignal,
  type LocateSignalRung,
  type LocateMemberInput,
} from '../locateFriends.ts';
import {
  precisionRank,
  mayRenderIdentity,
  CURRENT_STACK_CAPABILITIES,
  type PrecisionGrant,
  type PresenceCapabilities,
  type PrivacyClass,
} from '../presenceLadder.ts';
import { coarsenForFriend } from '../../../../hooks/mapEntityFilters.ts';

const T0 = 1_800_000_000_000;
const ALL_CAPS: PresenceCapabilities = {
  bleScan: true,
  bleAdvertise: true,
  backgroundBle: true,
  backgroundLocation: true,
  uwb: true,
  localPeer: true,
};

function session(over: Record<string, unknown> = {}) {
  const res = createLocateSession({
    sessionId: 's1',
    groupId: 'group-1',
    optedInMemberIds: ['m1', 'm2'],
    startedAt: T0,
    expiresAt: T0 + 60 * 60_000,
    label: 'Night Market',
    ...over,
  } as never);
  assert.ok(res.ok, `session fixture rejected: ${res.ok ? '' : res.reason}`);
  return res.ok ? res.session : (null as never);
}

function grant(over: Partial<PrecisionGrant> = {}): PrecisionGrant {
  return {
    purpose: LOCATE_FRIENDS_PURPOSE,
    optedIn: true,
    scopeId: 'group-1',
    grantedClass: 'precise_temporary',
    expiresAt: T0 + 30 * 60_000,
    ...over,
  };
}

/** One usable signal per rung, all observed `ageMs` ago. */
function allSignals(ageMs = 0): LocateSignal[] {
  const at = T0 - ageMs;
  return [
    { rung: 'network_location', observedAt: at, position: { lat: 16.06, lng: 108.22 } },
    {
      rung: 'event_cached_location',
      observedAt: at,
      position: { lat: 16.061, lng: 108.221 },
      checkpointLabel: 'Han Market',
    },
    { rung: 'device_proximity', observedAt: at, proximity: 'within_area' },
    { rung: 'peer_relay', observedAt: at, proximity: 'weak' },
    { rung: 'last_known', observedAt: at, position: { lat: 16.062, lng: 108.222 } },
    { rung: 'manual_checkpoint', observedAt: at, checkpointLabel: 'Food Court', checkpointId: 'cp1' },
  ];
}

// ── The ladder itself ─────────────────────────────────────────────────────────

test('§12 preferred signal sequence is in the spec order', () => {
  assert.deepEqual([...LOCATE_SIGNAL_RUNGS], [
    'network_location',
    'event_cached_location',
    'device_proximity',
    'peer_relay',
    'last_known',
    'manual_checkpoint',
  ]);
  assert.equal(rungIndex('network_location'), 0);
  assert.equal(rungIndex('manual_checkpoint'), 5);
  assert.equal(rungIndex('nonsense'), -1);
  assert.equal(rungIndex(null), -1);
});

test('PROPERTY: rung ceilings are monotone non-increasing down the chain', () => {
  let prev = Number.POSITIVE_INFINITY;
  for (const rung of LOCATE_SIGNAL_RUNGS) {
    const rank = precisionRank(RUNG_POLICY[rung].ceiling);
    assert.ok(rank <= prev, `${rung} is sharper than the rung above it`);
    prev = rank;
  }
  // Only the top rung may ever be precise; a peer relay never is.
  assert.equal(RUNG_POLICY.network_location.ceiling, 'precise_temporary');
  assert.equal(RUNG_POLICY.peer_relay.ceiling, 'approximate');
  assert.equal(RUNG_POLICY.device_proximity.ceiling, 'approximate');
  assert.equal(RUNG_POLICY.last_known.ceiling, 'approximate');
});

test('rung estimate states use the server presence vocabulary', () => {
  assert.equal(RUNG_POLICY.network_location.estimateState, 'precise');
  assert.equal(RUNG_POLICY.peer_relay.estimateState, 'relayed');
  assert.equal(RUNG_POLICY.last_known.estimateState, 'last_known');
});

test("today's stack cannot reach the two radio rungs, and says so", () => {
  assert.deepEqual(unsupportedRungs(CURRENT_STACK_CAPABILITIES), [
    'device_proximity',
    'peer_relay',
  ]);
  assert.deepEqual(unsupportedRungs(ALL_CAPS), []);
  assert.equal(isRungSupported('network_location', CURRENT_STACK_CAPABILITIES), true);
  assert.equal(isRungSupported('device_proximity', CURRENT_STACK_CAPABILITIES), false);
});

// ── The fallback chain ────────────────────────────────────────────────────────

test('the full six-rung chain answers from the highest available rung, degrading as it descends', () => {
  const expected: Array<[LocateSignalRung, PrivacyClass]> = [
    ['network_location', 'precise_temporary'],
    ['event_cached_location', 'place_level'],
    ['device_proximity', 'approximate'],
    ['peer_relay', 'approximate'],
    ['last_known', 'approximate'],
    ['manual_checkpoint', 'approximate'],
  ];

  let signals = allSignals();
  let previousRank = Number.POSITIVE_INFINITY;
  for (const [rung, cls] of expected) {
    const r = resolvePosition(signals, T0, { subjectKey: 'm1' });
    assert.equal(r.rung, rung, `expected ${rung}, got ${String(r.rung)}`);
    assert.equal(r.privacyClass, cls, `${rung} resolved to ${r.privacyClass}`);
    assert.equal(r.offline, false);
    assert.equal(r.degraded, rung !== 'network_location');
    assert.ok(
      precisionRank(r.privacyClass) <= previousRank,
      `${rung} was sharper than the rung above it`,
    );
    previousRank = precisionRank(r.privacyClass);
    signals = signals.filter((s) => s.rung !== rung);
  }

  // Every signal absent.
  const nothing = resolvePosition(signals, T0, { subjectKey: 'm1' });
  assert.equal(nothing.rung, null);
  assert.equal(nothing.offline, true);
  assert.equal(nothing.degraded, true);
  assert.equal(nothing.privacyClass, 'none');
  assert.equal(nothing.freshness, 'unknown');
  assert.equal(nothing.estimateState, 'unknown');
  assert.equal(nothing.position, null);
});

test('every-signal-absent inputs all collapse to the fail-closed state', () => {
  for (const input of [null, undefined, [], [{} as LocateSignal]]) {
    const r = resolvePosition(input as LocateSignal[], T0, { subjectKey: 'm1' });
    assert.equal(r.rung, null);
    assert.equal(r.privacyClass, 'none');
    assert.equal(r.position, null);
  }
  assert.equal(NO_POSITION.privacyClass, 'none');
  assert.equal(NO_POSITION.offline, true);
});

test('signals with no evidence at all are discarded rather than answering', () => {
  const empty: LocateSignal[] = [
    { rung: 'network_location', observedAt: T0 },
    { rung: 'network_location', observedAt: T0, position: { lat: Number.NaN, lng: 1 } },
    { rung: 'network_location', observedAt: Number.NaN, position: { lat: 1, lng: 1 } },
    { rung: 'device_proximity', observedAt: T0, proximity: 'bogus' as never },
  ];
  assert.equal(resolvePosition(empty, T0, { subjectKey: 'm1' }).rung, null);
});

test('input order cannot promote a lower rung above a higher one', () => {
  const reversed = [...allSignals()].reverse();
  assert.equal(resolvePosition(reversed, T0, { subjectKey: 'm1' }).rung, 'network_location');
});

test('within a rung the freshest observation wins', () => {
  const signals: LocateSignal[] = [
    { rung: 'last_known', observedAt: T0 - 10 * 60_000, position: { lat: 1, lng: 1 } },
    { rung: 'last_known', observedAt: T0 - 60_000, position: { lat: 2, lng: 2 } },
  ];
  const r = resolvePosition(signals, T0, { subjectKey: 'm1' });
  assert.equal(r.ageMs, 60_000);
});

test('a rung that has fully decayed is skipped and the chain continues', () => {
  const stale = T0 - 3 * 60 * 60_000; // well past the last_known boundary
  const signals: LocateSignal[] = [
    { rung: 'network_location', observedAt: stale, position: { lat: 16.06, lng: 108.22 } },
    { rung: 'manual_checkpoint', observedAt: T0, checkpointLabel: 'Food Court' },
  ];
  const r = resolvePosition(signals, T0, { subjectKey: 'm1' });
  assert.equal(r.rung, 'manual_checkpoint');
  assert.deepEqual(r.attempted, ['network_location', 'manual_checkpoint']);
});

test('an unsupported rung is skipped entirely on a device that lacks the radio', () => {
  const signals = allSignals().filter(
    (s) => s.rung === 'device_proximity' || s.rung === 'last_known',
  );
  assert.equal(
    resolvePosition(signals, T0, { subjectKey: 'm1', capabilities: ALL_CAPS }).rung,
    'device_proximity',
  );
  assert.equal(
    resolvePosition(signals, T0, { subjectKey: 'm1', capabilities: CURRENT_STACK_CAPABILITIES }).rung,
    'last_known',
  );
});

test('a caller-supplied ceiling only ever tightens the chain result', () => {
  for (const ceiling of ['precise_temporary', 'place_level', 'approximate', 'aggregate_only', 'none'] as PrivacyClass[]) {
    const r = resolvePosition(allSignals(), T0, { subjectKey: 'm1', ceiling });
    assert.ok(precisionRank(r.privacyClass) <= precisionRank(ceiling));
  }
  assert.equal(resolvePosition(allSignals(), T0, { subjectKey: 'm1', ceiling: 'none' }).rung, null);
});

test('a source-imposed class is honoured and never overridden', () => {
  const signals: LocateSignal[] = [
    {
      rung: 'network_location',
      observedAt: T0,
      position: { lat: 16.06, lng: 108.22 },
      sourceClass: 'approximate',
    },
  ];
  const r = resolvePosition(signals, T0, { subjectKey: 'm1' });
  assert.equal(r.privacyClass, 'approximate');
});

// ── Coordinates ───────────────────────────────────────────────────────────────

test('a coordinate below place_level is coarsened deterministically, never passed through', () => {
  const raw = { lat: 16.06, lng: 108.22 };
  const signals: LocateSignal[] = [{ rung: 'last_known', observedAt: T0, position: raw }];
  const r = resolvePosition(signals, T0, { subjectKey: 'm1' });
  assert.equal(r.privacyClass, 'approximate');
  assert.equal(r.positionCoarsened, true);
  assert.notDeepEqual(r.position, raw);
  assert.deepEqual(r.position, coarsenForFriend('m1', raw.lat, raw.lng));
  // Stable between resolutions — a ring that jitters every render is a ring
  // whose centre can be averaged back to the truth.
  assert.deepEqual(resolvePosition(signals, T0, { subjectKey: 'm1' }).position, r.position);
});

test('without a subject key a sub-place-level coordinate is DROPPED, not leaked', () => {
  const signals: LocateSignal[] = [
    { rung: 'last_known', observedAt: T0, position: { lat: 16.06, lng: 108.22 } },
  ];
  const r = resolvePosition(signals, T0);
  assert.equal(r.rung, 'last_known');
  assert.equal(r.position, null);
});

test('an aggregate_only result never carries geometry, a distance, or an identity', () => {
  const r = resolvePosition(allSignals(), T0, { subjectKey: 'm1', ceiling: 'aggregate_only' });
  assert.equal(r.privacyClass, 'aggregate_only');
  assert.equal(r.position, null);
  assert.equal(r.distanceRange, null);
  assert.equal(mayRenderIdentity(r.privacyClass), false);
});

// ── Distance snapping ─────────────────────────────────────────────────────────

test('rangeFor snaps an approximate reading onto the coarse ladder (§12 "~40-80m")', () => {
  assert.deepEqual(rangeFor('approximate', { minMeters: 42, maxMeters: 63 }), {
    minMeters: 40,
    maxMeters: 80,
  });
  assert.deepEqual(rangeFor('approximate', PROXIMITY_BUCKET_RANGE.within_area), {
    minMeters: 40,
    maxMeters: 80,
  });
});

test('rangeFor drops the distance entirely at place_level and below', () => {
  assert.equal(rangeFor('place_level', { minMeters: 42, maxMeters: 63 }), null);
  assert.equal(rangeFor('aggregate_only', { minMeters: 42, maxMeters: 63 }), null);
  assert.equal(rangeFor('none', { minMeters: 42, maxMeters: 63 }), null);
  assert.equal(rangeFor('approximate', null), null);
});

test('PROPERTY: an approximate range only ever reports ladder values', () => {
  const ladder = new Set<number>(APPROXIMATE_DISTANCE_LADDER);
  for (let min = 0; min < 1500; min += 7) {
    for (const span of [1, 5, 25, 120, 700]) {
      const out = rangeFor('approximate', { minMeters: min, maxMeters: min + span });
      assert.ok(out, 'expected a range');
      assert.ok(ladder.has(out!.minMeters), `min ${out!.minMeters} is off-ladder`);
      if (out!.maxMeters != null) {
        assert.ok(ladder.has(out!.maxMeters), `max ${out!.maxMeters} is off-ladder`);
        assert.ok(out!.maxMeters > out!.minMeters, 'zero-width range asserts a point fix');
      }
      assert.ok(out!.minMeters <= min, 'snapped inward, narrowing the true range');
    }
  }
});

test('PROPERTY: a precise range is never reported finer than 10m', () => {
  for (let min = 0; min < 400; min += 3) {
    const out = rangeFor('precise_temporary', { minMeters: min, maxMeters: min + 4 });
    assert.ok(out);
    assert.equal(out!.minMeters % 10, 0);
    assert.equal(out!.maxMeters! % 10, 0);
    assert.ok(out!.maxMeters! - out!.minMeters >= 10);
  }
});

test('every proximity bucket has a range and none of them is a point', () => {
  for (const b of PROXIMITY_BUCKETS) {
    const r = PROXIMITY_BUCKET_RANGE[b];
    assert.ok(r.maxMeters != null && r.maxMeters > r.minMeters, `${b} is a point fix`);
  }
});

// ── The session ───────────────────────────────────────────────────────────────

test('a session with no expiry is not constructible', () => {
  const noExpiry = createLocateSession({
    sessionId: 's1',
    groupId: 'g1',
    optedInMemberIds: ['m1'],
    startedAt: T0,
  } as never);
  assert.equal(noExpiry.ok, false);
  assert.equal(noExpiry.ok === false && noExpiry.reason, 'missing_expiry');

  for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, null, undefined, '3' as never]) {
    const r = createLocateSession({
      sessionId: 's1',
      groupId: 'g1',
      optedInMemberIds: ['m1'],
      startedAt: T0,
      expiresAt: bad as number,
    });
    assert.equal(r.ok, false, `expiresAt=${String(bad)} was accepted`);
  }
});

test('a session may not be unbounded, backwards, ungrouped, or empty', () => {
  const base = {
    sessionId: 's1',
    groupId: 'g1',
    optedInMemberIds: ['m1'],
    startedAt: T0,
    expiresAt: T0 + 60_000,
  };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['expiry_exceeds_maximum', { expiresAt: T0 + MAX_SESSION_MS + 1 }],
    ['expiry_not_after_start', { expiresAt: T0 }],
    ['expiry_not_after_start', { expiresAt: T0 - 1 }],
    ['missing_group_id', { groupId: '' }],
    ['missing_group_id', { groupId: '   ' }],
    ['missing_session_id', { sessionId: '' }],
    ['no_opted_in_members', { optedInMemberIds: [] }],
    ['no_opted_in_members', { optedInMemberIds: ['', '  '] }],
    ['invalid_start', { startedAt: Number.NaN }],
  ];
  for (const [reason, over] of cases) {
    const r = createLocateSession({ ...base, ...over } as never);
    assert.equal(r.ok, false, `${reason}: unexpectedly accepted`);
    assert.equal(r.ok === false && r.reason, reason);
  }
  // Exactly at the maximum is fine; one millisecond past is not.
  assert.equal(createLocateSession({ ...base, expiresAt: T0 + MAX_SESSION_MS }).ok, true);
});

test('an object literal is not a LocateSession', () => {
  const impostor = {
    sessionId: 's1',
    groupId: 'g1',
    optedInMemberIds: ['m1'],
    startedAt: T0,
    expiresAt: Number.POSITIVE_INFINITY,
    grantedClass: 'precise_temporary',
    endedAt: null,
    label: null,
  };
  assert.equal(impostor instanceof LocateSession, false);
  assert.equal(session() instanceof LocateSession, true);
});

test('a session is frozen and its member list cannot be mutated after construction', () => {
  const s = session();
  assert.equal(Object.isFrozen(s), true);
  assert.equal(Object.isFrozen(s.optedInMemberIds), true);
});

test('isActive respects the start, the expiry and an explicit end', () => {
  const s = session();
  assert.equal(isActive(s, T0 - 1), false);
  assert.equal(isActive(s, T0), true);
  assert.equal(isActive(s, s.expiresAt - 1), true);
  assert.equal(isActive(s, s.expiresAt), false);
  assert.equal(isActive(null, T0), false);
  assert.equal(isActive(s, Number.NaN), false);
  assert.equal(remainingMs(s, T0), 60 * 60_000);
  assert.equal(remainingMs(s, s.expiresAt), 0);
});

test('ending a session shortens it and can never extend it', () => {
  const s = session();
  const ended = endLocateSession(s, T0 + 10 * 60_000);
  assert.ok(ended.expiresAt <= s.expiresAt);
  assert.equal(isActive(ended, T0 + 10 * 60_000), false);
  assert.equal(isActive(ended, T0 + 60_000), true);

  // "End" far in the future must not push the expiry out.
  const notExtended = endLocateSession(s, T0 + 10 * MAX_SESSION_MS);
  assert.equal(notExtended.expiresAt, s.expiresAt);
  assert.equal(notExtended.endedAt, T0 + 10 * MAX_SESSION_MS);
});

test('the last member leaving ends the session', () => {
  const s = session({ optedInMemberIds: ['m1'] });
  const after = removeMember(s, 'm1');
  assert.equal(isActive(after, T0 + 1), false);

  const two = session();
  const oneLeft = removeMember(two, 'm1');
  assert.equal(isOptedIn(oneLeft, 'm1'), false);
  assert.equal(isOptedIn(oneLeft, 'm2'), true);
  assert.equal(isActive(oneLeft, T0 + 1), true);
});

// ── Members ───────────────────────────────────────────────────────────────────

function member(over: Partial<LocateMemberInput> = {}): LocateMemberInput {
  return { memberId: 'm1', displayName: 'Ana', avatarUrl: 'https://x/a.jpg', signals: allSignals(), ...over };
}

test('§12 opt-in only: a member not in the session resolves to nothing', () => {
  const s = session();
  const stranger = resolveMember(s, member({ memberId: 'nope' }), T0);
  assert.equal(stranger.resolved.rung, null);
  assert.equal(stranger.displayName, null);
  assert.equal(stranger.identityVisible, false);
  assert.deepEqual(stranger.resolved, NO_POSITION);
});

test('an inactive or ended session resolves every member to nothing', () => {
  const s = session();
  assert.deepEqual(resolveMember(s, member(), s.expiresAt).resolved, NO_POSITION);
  assert.deepEqual(resolveMember(endLocateSession(s, T0 + 1), member(), T0 + 5).resolved, NO_POSITION);
  assert.deepEqual(resolveMember(null, member(), T0).resolved, NO_POSITION);
});

test('§12 group-scoped: a grant scoped to another group does not elevate', () => {
  const s = session({ grantedClass: 'precise_temporary' });
  const withOwn = resolveMember(s, member({ grant: grant() }), T0);
  assert.equal(withOwn.resolved.privacyClass, 'precise_temporary');

  const otherGroup = resolveMember(s, member({ grant: grant({ scopeId: 'group-2' }) }), T0);
  assert.equal(otherGroup.resolved.privacyClass, 'approximate');

  const expired = resolveMember(s, member({ grant: grant({ expiresAt: T0 - 1 }) }), T0);
  assert.equal(expired.resolved.privacyClass, 'approximate');

  const notOptedIn = resolveMember(s, member({ grant: grant({ optedIn: false }) }), T0);
  assert.equal(notOptedIn.resolved.privacyClass, 'approximate');
});

test("the session's own granted class caps every member grant", () => {
  // Default session ceiling is `approximate`; a precise member grant cannot
  // exceed what the group agreed to.
  const s = session();
  assert.equal(resolveMember(s, member({ grant: grant() }), T0).resolved.privacyClass, 'approximate');
});

test('an aggregate_only member never yields an identity (§23)', () => {
  const s = session({ grantedClass: 'aggregate_only' });
  const state = resolveMember(s, member({ grant: grant() }), T0);
  assert.equal(state.resolved.privacyClass, 'aggregate_only');
  assert.equal(mayRenderIdentity(state.resolved.privacyClass), false);
  assert.equal(state.identityVisible, false);
  assert.equal(state.displayName, null);
  assert.equal(state.avatarUrl, null);
  assert.equal(state.resolved.position, null);
  assert.equal(describeMember(state).kind, 'in_area');
  assert.equal(describeMember(state).identityVisible, false);
  assert.equal(memberToMapObject(state), null);
});

test('additionalBounds tighten a member result further', () => {
  const s = session({ grantedClass: 'precise_temporary' });
  const state = resolveMember(s, member({ grant: grant() }), T0, {
    additionalBounds: ['approximate'],
  });
  assert.equal(state.resolved.privacyClass, 'approximate');
});

// ── §12 display states ────────────────────────────────────────────────────────

test('§12 display states render exactly as the spec writes them', () => {
  const s = session();

  const proximity = resolveMember(
    s,
    member({ signals: [{ rung: 'device_proximity', observedAt: T0, proximity: 'within_area' }] }),
    T0,
    { capabilities: ALL_CAPS },
  );
  assert.equal(describeMember(proximity).text, 'Nearby ~40-80m');
  assert.equal(describeMember(proximity).kind, 'nearby_range');

  const lastKnown = resolveMember(
    s,
    member({
      signals: [{ rung: 'last_known', observedAt: T0 - 3 * 60_000, position: { lat: 16, lng: 108 } }],
    }),
    T0,
  );
  assert.equal(describeMember(lastKnown).text, 'Last seen 3m ago');
  assert.equal(describeMember(lastKnown).kind, 'last_seen');

  const checkpoint = resolveMember(
    s,
    member({ signals: [{ rung: 'manual_checkpoint', observedAt: T0, checkpointLabel: 'Food Court' }] }),
    T0,
  );
  assert.equal(describeMember(checkpoint).text, 'Checkpoint: Food Court');
  assert.equal(describeMember(checkpoint).kind, 'checkpoint');
});

test('a member with nothing to show reads as Not sharing', () => {
  const s = session();
  const state = resolveMember(s, member({ signals: [] }), T0);
  assert.equal(describeMember(state).kind, 'not_sharing');
  assert.equal(describeMember(state).text, 'Not sharing');
  assert.equal(describeMember(state).distance, null);
});

test('PROPERTY: describeMember never emits a distance finer than the rung allows', () => {
  const ladder = new Set<number>(APPROXIMATE_DISTANCE_LADDER);
  const ages = [0, 60_000, 4 * 60_000, 20 * 60_000, 45 * 60_000, 3 * 60 * 60_000];
  const ceilings: PrivacyClass[] = ['precise_temporary', 'place_level', 'approximate', 'aggregate_only'];
  let checked = 0;

  for (const rung of LOCATE_SIGNAL_RUNGS) {
    for (const age of ages) {
      for (const ceiling of ceilings) {
        const s = session({ grantedClass: ceiling });
        const signals: LocateSignal[] = [
          {
            rung,
            observedAt: T0 - age,
            position: { lat: 16.06, lng: 108.22 },
            distanceRange: { minMeters: 43, maxMeters: 47 },
            checkpointLabel: 'Food Court',
          },
        ];
        const state = resolveMember(s, member({ signals, grant: grant() }), T0, {
          capabilities: ALL_CAPS,
        });
        const display = describeMember(state);
        checked += 1;

        const cls = state.resolved.privacyClass;
        assert.ok(
          precisionRank(cls) <= precisionRank(RUNG_POLICY[rung].ceiling),
          `${rung}@${age} exceeded its rung ceiling: ${cls}`,
        );

        if (display.distance) {
          // A distance may only appear at approximate or above...
          assert.ok(precisionRank(cls) >= precisionRank('approximate'));
          if (cls === 'approximate') {
            assert.ok(ladder.has(display.distance.minMeters), `off-ladder min at ${rung}@${age}`);
            assert.ok(
              display.distance.maxMeters == null || ladder.has(display.distance.maxMeters),
              `off-ladder max at ${rung}@${age}`,
            );
          } else {
            assert.equal(display.distance.minMeters % 10, 0);
          }
          assert.equal(display.text, `Nearby ~${formatRange(display.distance)}`);
        }

        // ...and identity only at approximate or above, always.
        assert.equal(display.identityVisible, mayRenderIdentity(cls));
        if (!mayRenderIdentity(cls)) {
          assert.equal(state.displayName, null);
          assert.equal(state.avatarUrl, null);
          assert.equal(display.distance, null);
        }
      }
    }
  }
  assert.ok(checked > 100, `expected a real cross-product, got ${checked}`);
});

test('formatting helpers', () => {
  assert.equal(formatRange({ minMeters: 40, maxMeters: 80 }), '40-80m');
  assert.equal(formatRange({ minMeters: 1200, maxMeters: null }), '1.2km+');
  assert.equal(formatRange({ minMeters: 600, maxMeters: 1200 }), '600m-1.2km');
  assert.equal(formatAge(0), 'just now');
  assert.equal(formatAge(59_999), 'just now');
  assert.equal(formatAge(3 * 60_000), '3m ago');
  assert.equal(formatAge(90 * 60_000), '1h ago');
  assert.equal(formatAge(50 * 60 * 60_000), '2d ago');
  assert.equal(formatAge(null), 'a while ago');
  assert.equal(formatAge(Number.NaN), 'a while ago');
});

test('describeSessionRemaining reads the clock, and says Ended once it is', () => {
  const s = session();
  assert.equal(describeSessionRemaining(s, T0), 'Ends in 1h');
  assert.equal(describeSessionRemaining(s, T0 + 30 * 60_000), 'Ends in 30m');
  assert.equal(describeSessionRemaining(s, s.expiresAt), 'Ended');
  assert.equal(describeSessionRemaining(null, T0), 'Ended');
  const long = session({ expiresAt: T0 + 3 * 60 * 60_000 + 5 * 60_000 });
  assert.equal(describeSessionRemaining(long, T0), 'Ends in 3h 5m');
});

// ── Projection into the §18 contract ──────────────────────────────────────────

test('a member becomes a crew_member map object only when it has renderable geometry', () => {
  const s = session({ grantedClass: 'precise_temporary' });
  const state = resolveMember(s, member({ grant: grant() }), T0);
  const obj = memberToMapObject(state);
  assert.ok(obj);
  assert.equal(obj!.kind, 'crew_member');
  assert.equal(obj!.privacyClass, 'precise_temporary');
  assert.equal(obj!.title, 'Ana');
  assert.equal(obj!.renderingPriority, 90);

  const noGeo = resolveMember(
    s,
    member({ signals: [{ rung: 'device_proximity', observedAt: T0, proximity: 'nearby' }] }),
    T0,
    { capabilities: ALL_CAPS },
  );
  assert.equal(memberToMapObject(noGeo), null);
});

test('a checkpoint becomes a place_level meeting_point, and rejects junk', () => {
  const obj = checkpointToMapObject({
    id: 'cp1',
    label: 'Food Court',
    position: { lat: 16.06, lng: 108.22 },
    createdAt: T0,
  });
  assert.ok(obj);
  assert.equal(obj!.kind, 'meeting_point');
  assert.equal(obj!.privacyClass, 'place_level');
  assert.equal(obj!.geometry.type, 'Point');
  assert.deepEqual((obj!.geometry as { coordinates: number[] }).coordinates, [108.22, 16.06]);

  assert.equal(
    checkpointToMapObject({ id: 'x', label: '', position: { lat: 1, lng: 1 }, createdAt: T0 }),
    null,
  );
  assert.equal(
    checkpointToMapObject({
      id: 'x',
      label: 'ok',
      position: { lat: Number.NaN, lng: 1 },
      createdAt: T0,
    }),
    null,
  );
});
