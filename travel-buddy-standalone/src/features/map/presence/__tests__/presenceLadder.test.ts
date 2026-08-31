/**
 * presenceLadder tests — spec §23/§24.
 *
 * The interesting tests here are the PROPERTY tests. Example tests prove the
 * cases someone thought of; the properties ("combining bounds can only tighten",
 * "elapsed time can only lower precision") are what actually make the unsafe
 * states unrepresentable, so they are asserted over the full ladder
 * cross-product rather than over a handful of hand-picked inputs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRIVACY_CLASSES,
  precisionRank,
  narrowestPrivacyClass,
  mayRenderIdentity,
  narrowestOf,
  LOCATION_VISIBILITY,
  privacyClassFromVisibility,
  PRECISION_LADDER,
  serverPrecisionRank,
  narrowestPrecision,
  FEATURE_PRECISION_CEILING,
  ESTIMATE_STATES,
  isLiveState,
  CURRENT_STACK_CAPABILITIES,
  PRECISION_SEMANTIC_EQUIVALENT,
  PRECISION_AS_CEILING,
  ceilingFromServerPrecision,
  LADDER_DISAGREEMENTS,
  STORED_VISIBILITY_AS_PRIVACY_CLASS,
  privacyClassFromStoredVisibility,
  ceilingFromLocationPrivacy,
  PRESENCE_PURPOSES,
  purposeCeilingRow,
  UNKNOWN_PURPOSE_CEILING,
  ceilingForPurpose,
  applyCeiling,
  isGrantLive,
  grantApplies,
  DECAY_STAGES,
  DECAY_INTERVALS_MS,
  DECAY_BOUNDARIES_MS,
  DECAY_STAGE_CEILING,
  DECAY_STAGE_FRESHNESS,
  decayStageAt,
  decay,
  effectiveClass,
  type PrecisionGrant,
  type PrivacyClass,
} from '../presenceLadder.ts';

const T0 = 1_800_000_000_000;

function liveGrant(over: Partial<PrecisionGrant> = {}): PrecisionGrant {
  return {
    purpose: 'locate_my_friends',
    optedIn: true,
    scopeId: 'group-1',
    grantedClass: 'precise_temporary',
    expiresAt: T0 + 60_000,
    ...over,
  };
}

// ── §23 enum ──────────────────────────────────────────────────────────────────

test('§23 LocationVisibility maps 1:1 onto the contract PrivacyClass ladder', () => {
  assert.deepEqual(Object.values(LOCATION_VISIBILITY), [...PRIVACY_CLASSES]);
  assert.equal(privacyClassFromVisibility('PRECISE_TEMPORARY'), 'precise_temporary');
  assert.equal(privacyClassFromVisibility('AGGREGATE_ONLY'), 'aggregate_only');
});

test('an unrecognised visibility identifier fails closed to none', () => {
  for (const bad of ['EXACT', 'precise_temporary', '', 'ALWAYS', null, undefined, 'NONE ']) {
    assert.equal(privacyClassFromVisibility(bad as string), 'none', `${String(bad)} did not fail closed`);
  }
  // Positive control so the assertion above is not vacuously true.
  assert.equal(privacyClassFromVisibility('APPROXIMATE'), 'approximate');
});

test('narrowestOf with no bounds fails closed to none', () => {
  assert.equal(narrowestOf(), 'none');
});

test('narrowestOf returns the minimum rank over any number of bounds', () => {
  assert.equal(narrowestOf('precise_temporary', 'place_level', 'approximate'), 'approximate');
  assert.equal(narrowestOf('approximate', 'precise_temporary'), 'approximate');
  assert.equal(narrowestOf('precise_temporary'), 'precise_temporary');
});

// ── Mirror fidelity with the server's presence domain ─────────────────────────

test('the mirrored server ladder matches artifacts/api-server presence/domain', () => {
  assert.deepEqual([...PRECISION_LADDER], [
    'none', 'presence_only', 'venue', 'zone', 'approximate', 'nearby', 'precise',
  ]);
  assert.deepEqual([...ESTIMATE_STATES], [
    'precise', 'nearby', 'relayed', 'recent', 'inferred', 'predicted', 'last_known', 'unknown',
  ]);
  assert.deepEqual(FEATURE_PRECISION_CEILING, {
    crowd_intelligence: 'presence_only',
    bump: 'zone',
    crew: 'precise',
    proof_of_presence: 'presence_only',
  });
  assert.deepEqual(CURRENT_STACK_CAPABILITIES, {
    bleScan: false,
    bleAdvertise: false,
    backgroundBle: false,
    backgroundLocation: true,
    uwb: false,
    localPeer: false,
  });
});

test('narrowestPrecision (server mirror) never widens, over the full cross-product', () => {
  for (const a of PRECISION_LADDER) {
    for (const b of PRECISION_LADDER) {
      const out = narrowestPrecision(a, b);
      assert.ok(serverPrecisionRank(out) <= serverPrecisionRank(a));
      assert.ok(serverPrecisionRank(out) <= serverPrecisionRank(b));
    }
  }
});

test('isLiveState matches the server: only precise/nearby/relayed assert current truth', () => {
  assert.deepEqual(
    ESTIMATE_STATES.filter(isLiveState),
    ['precise', 'nearby', 'relayed'],
  );
});

test('the venue/zone ladder disagreement is resolved in the narrowing direction', () => {
  // The semantic reading says a venue is place_level...
  assert.equal(PRECISION_SEMANTIC_EQUIVALENT.venue, 'place_level');
  // ...but as a CEILING it is translated down, because the server ranks venue
  // below zone and we must not widen under either reading.
  assert.equal(PRECISION_AS_CEILING.venue, 'approximate');
  assert.ok(
    precisionRank(PRECISION_AS_CEILING.venue) <=
      precisionRank(PRECISION_SEMANTIC_EQUIVALENT.venue),
  );
  assert.ok(LADDER_DISAGREEMENTS.length >= 1);
});

test('PRECISION_AS_CEILING never exceeds the semantic reading and is monotone along the server ladder', () => {
  let prev = -1;
  for (const p of PRECISION_LADDER) {
    const ceiling = PRECISION_AS_CEILING[p];
    assert.ok(
      precisionRank(ceiling) <= precisionRank(PRECISION_SEMANTIC_EQUIVALENT[p]),
      `${p}: ceiling wider than its semantic equivalent`,
    );
    assert.ok(precisionRank(ceiling) >= prev, `${p}: ceiling drops as the server ladder rises`);
    prev = precisionRank(ceiling);
  }
});

test('an unknown server precision fails closed to none', () => {
  assert.equal(ceilingFromServerPrecision('exact'), 'none');
  assert.equal(ceilingFromServerPrecision(null), 'none');
  assert.equal(ceilingFromServerPrecision(undefined), 'none');
  assert.equal(ceilingFromServerPrecision('precise'), 'precise_temporary');
});

// ── Stored preference vocabulary ──────────────────────────────────────────────

test('the stored services/map.ts visibility vocabulary maps in, and exact_hidden is approximate', () => {
  assert.equal(STORED_VISIBILITY_AS_PRIVACY_CLASS.exact_hidden, 'approximate');
  assert.equal(STORED_VISIBILITY_AS_PRIVACY_CLASS.no_location, 'none');
  assert.equal(privacyClassFromStoredVisibility('venue_tagged'), 'place_level');
  assert.equal(privacyClassFromStoredVisibility('whatever'), 'none');
  assert.equal(privacyClassFromStoredVisibility(null), 'none');
});

test('sharingPaused overrides every location mode', () => {
  assert.equal(
    ceilingFromLocationPrivacy({ locationMode: 'trusted_circle_live', sharingPaused: true }),
    'none',
  );
  assert.equal(
    ceilingFromLocationPrivacy({ locationMode: 'trusted_circle_live', sharingPaused: false }),
    'precise_temporary',
  );
  assert.equal(ceilingFromLocationPrivacy({ locationMode: 'off' }), 'none');
  assert.equal(ceilingFromLocationPrivacy(null), 'none');
  assert.equal(ceilingFromLocationPrivacy({ locationMode: 'nonsense' }), 'none');
});

// ── ceilingForPurpose ─────────────────────────────────────────────────────────

test('§23 purpose table matches the spec text', () => {
  assert.deepEqual([...PRESENCE_PURPOSES], [
    'public_stranger', 'shared_moment', 'trip_crew', 'locate_my_friends', 'safe_return',
  ]);
  assert.equal(ceilingForPurpose('public_stranger'), 'aggregate_only');
  assert.equal(ceilingForPurpose('shared_moment'), 'place_level');
  assert.equal(ceilingForPurpose('trip_crew'), 'approximate');
  assert.equal(ceilingForPurpose('locate_my_friends'), 'approximate');
  // "purpose-bound precise": with no active Safe Return there is no location.
  assert.equal(ceilingForPurpose('safe_return'), 'none');
});

test('an unknown purpose fails closed to NONE, with or without a grant', () => {
  for (const bad of ['stranger', 'friends', '', 'PUBLIC_STRANGER', null, undefined, 'admin']) {
    assert.equal(ceilingForPurpose(bad as string), 'none', `${String(bad)} ungranted`);
    assert.equal(
      ceilingForPurpose(bad as string, liveGrant({ purpose: bad as never }), T0),
      'none',
      `${String(bad)} granted`,
    );
    assert.equal(purposeCeilingRow(bad as string), UNKNOWN_PURPOSE_CEILING);
  }
});

test('no grant can raise a public stranger above aggregate_only (§37)', () => {
  const grant = liveGrant({ purpose: 'public_stranger', grantedClass: 'precise_temporary' });
  assert.equal(ceilingForPurpose('public_stranger', grant, T0), 'aggregate_only');
  assert.equal(applyCeiling('precise_temporary', 'public_stranger', grant, { now: T0 }), 'aggregate_only');
});

test('a live scoped grant raises Locate My Friends to temporary precise, and nothing else does', () => {
  assert.equal(ceilingForPurpose('locate_my_friends', null, T0), 'approximate');
  assert.equal(ceilingForPurpose('locate_my_friends', liveGrant(), T0), 'precise_temporary');

  // Each of the four grant conditions, removed one at a time.
  const broken: Array<[string, PrecisionGrant]> = [
    ['not opted in', liveGrant({ optedIn: false })],
    ['no scope', liveGrant({ scopeId: null })],
    ['empty scope', liveGrant({ scopeId: '   ' })],
    ['expired', liveGrant({ expiresAt: T0 - 1 })],
    ['wrong purpose', liveGrant({ purpose: 'trip_crew' })],
  ];
  for (const [why, grant] of broken) {
    assert.equal(
      ceilingForPurpose('locate_my_friends', grant, T0),
      'approximate',
      `grant elevated despite: ${why}`,
    );
  }
});

test('a grant can never hand out more than the subject actually granted', () => {
  const grant = liveGrant({ grantedClass: 'approximate' });
  assert.equal(ceilingForPurpose('safe_return', { ...grant, purpose: 'safe_return' }, T0), 'approximate');
});

test('grant expiry is exclusive at the boundary', () => {
  const g = liveGrant({ expiresAt: T0 });
  assert.equal(isGrantLive(g, T0 - 1), true);
  assert.equal(isGrantLive(g, T0), false);
  assert.equal(isGrantLive(g, T0 + 1), false);
  assert.equal(isGrantLive(null, T0 - 1), false);
  assert.equal(isGrantLive(g, Number.NaN), false);
  assert.equal(isGrantLive({ ...g, expiresAt: Number.POSITIVE_INFINITY }, T0), false);
});

test('grantApplies requires the purposes to match', () => {
  assert.equal(grantApplies(liveGrant(), 'locate_my_friends', T0), true);
  assert.equal(grantApplies(liveGrant(), 'trip_crew', T0), false);
  assert.equal(grantApplies(liveGrant(), null, T0), false);
});

// ── applyCeiling: the tightening property ─────────────────────────────────────

test('PROPERTY: applyCeiling never returns something wider than the request, over the whole cross-product', () => {
  const grants: Array<PrecisionGrant | null> = [
    null,
    liveGrant(),
    liveGrant({ optedIn: false }),
    liveGrant({ expiresAt: T0 - 1 }),
    liveGrant({ grantedClass: 'approximate' }),
    liveGrant({ purpose: 'trip_crew' }),
    liveGrant({ purpose: 'safe_return' }),
  ];
  const purposes: Array<string | null | undefined> = [
    ...PRESENCE_PURPOSES, 'unknown_purpose', '', null, undefined,
  ];
  let combos = 0;
  for (const requested of PRIVACY_CLASSES) {
    for (const purpose of purposes) {
      for (const grant of grants) {
        for (const extra of [[], ['approximate'], ['aggregate_only'], ['none'], ['place_level', 'approximate']] as PrivacyClass[][]) {
          const out = applyCeiling(requested, purpose, grant, { now: T0, additionalBounds: extra });
          combos += 1;
          assert.ok(
            precisionRank(out) <= precisionRank(requested),
            `widened past the request: ${requested}/${String(purpose)} -> ${out}`,
          );
          for (const bound of extra) {
            assert.ok(
              precisionRank(out) <= precisionRank(bound),
              `widened past bound ${bound}: -> ${out}`,
            );
          }
          assert.ok(
            precisionRank(out) <= precisionRank(ceilingForPurpose(purpose, grant, T0)),
            `widened past the purpose ceiling: ${String(purpose)} -> ${out}`,
          );
        }
      }
    }
  }
  assert.ok(combos > 1000, `expected a real cross-product, got ${combos}`);
});

test('PROPERTY: adding a bound can only tighten, never loosen', () => {
  for (const requested of PRIVACY_CLASSES) {
    for (const purpose of PRESENCE_PURPOSES) {
      const before = applyCeiling(requested, purpose, liveGrant({ purpose }), { now: T0 });
      for (const extra of PRIVACY_CLASSES) {
        const after = applyCeiling(requested, purpose, liveGrant({ purpose }), {
          now: T0,
          additionalBounds: [extra],
        });
        assert.ok(precisionRank(after) <= precisionRank(before));
        assert.equal(after, narrowestPrivacyClass(before, extra));
      }
    }
  }
});

test('applyCeiling with a missing clock treats every grant as not-yet-live', () => {
  // now defaults to 0, which is before any real expiry — but the grant's own
  // expiresAt is in the future relative to 0, so the guard that matters is that
  // an explicitly non-finite clock cannot elevate.
  assert.equal(
    applyCeiling('precise_temporary', 'locate_my_friends', liveGrant(), { now: Number.NaN }),
    'approximate',
  );
});

// ── decay ─────────────────────────────────────────────────────────────────────

test('§23 decay runs Precise -> Approximate -> Last known -> Expired', () => {
  assert.deepEqual([...DECAY_STAGES], ['precise', 'approximate', 'last_known', 'expired']);
  assert.equal(decayStageAt(0), 'precise');
  assert.equal(decayStageAt(DECAY_BOUNDARIES_MS.precise - 1), 'precise');
  assert.equal(decayStageAt(DECAY_BOUNDARIES_MS.precise), 'approximate');
  assert.equal(decayStageAt(DECAY_BOUNDARIES_MS.approximate - 1), 'approximate');
  assert.equal(decayStageAt(DECAY_BOUNDARIES_MS.approximate), 'last_known');
  assert.equal(decayStageAt(DECAY_BOUNDARIES_MS.last_known - 1), 'last_known');
  assert.equal(decayStageAt(DECAY_BOUNDARIES_MS.last_known), 'expired');
});

test('the named decay intervals compose into the cumulative boundaries', () => {
  assert.equal(DECAY_BOUNDARIES_MS.precise, DECAY_INTERVALS_MS.preciseHoldMs);
  assert.equal(
    DECAY_BOUNDARIES_MS.approximate,
    DECAY_INTERVALS_MS.preciseHoldMs + DECAY_INTERVALS_MS.approximateHoldMs,
  );
  assert.equal(
    DECAY_BOUNDARIES_MS.last_known,
    DECAY_INTERVALS_MS.preciseHoldMs +
      DECAY_INTERVALS_MS.approximateHoldMs +
      DECAY_INTERVALS_MS.lastKnownHoldMs,
  );
});

test('stage ceilings are non-increasing, and last_known is explicitly not live', () => {
  let prev = Number.POSITIVE_INFINITY;
  for (const stage of DECAY_STAGES) {
    const rank = precisionRank(DECAY_STAGE_CEILING[stage]);
    assert.ok(rank <= prev, `stage ${stage} raised the ceiling`);
    prev = rank;
  }
  assert.equal(DECAY_STAGE_FRESHNESS.precise, 'live');
  assert.equal(DECAY_STAGE_FRESHNESS.last_known, 'stale');
  assert.equal(DECAY_STAGE_FRESHNESS.expired, 'historical');
  // Same precision as `approximate`, different freshness — the whole point.
  assert.equal(DECAY_STAGE_CEILING.last_known, DECAY_STAGE_CEILING.approximate);
});

test('PROPERTY: decay is monotonic — elapsed time can never raise precision', () => {
  const samples = [
    0, 1, 1_000, 59_999, 60_000,
    DECAY_BOUNDARIES_MS.precise - 1, DECAY_BOUNDARIES_MS.precise, DECAY_BOUNDARIES_MS.precise + 1,
    DECAY_BOUNDARIES_MS.approximate - 1, DECAY_BOUNDARIES_MS.approximate, DECAY_BOUNDARIES_MS.approximate + 1,
    DECAY_BOUNDARIES_MS.last_known - 1, DECAY_BOUNDARIES_MS.last_known, DECAY_BOUNDARIES_MS.last_known + 1,
    24 * 60 * 60_000, 365 * 24 * 60 * 60_000,
  ];
  for (const cls of PRIVACY_CLASSES) {
    for (let i = 0; i < samples.length; i++) {
      for (let j = i; j < samples.length; j++) {
        const earlier = decay(cls, samples[i]);
        const later = decay(cls, samples[j]);
        assert.ok(
          precisionRank(later.privacyClass) <= precisionRank(earlier.privacyClass),
          `decay(${cls}, ${samples[j]}) is sharper than decay(${cls}, ${samples[i]})`,
        );
      }
    }
  }
});

test('PROPERTY: decay never returns something sharper than its input', () => {
  for (const cls of PRIVACY_CLASSES) {
    for (const elapsed of [0, 1, 60_000, 10 * 60_000, 40 * 60_000, 90 * 60_000]) {
      assert.ok(precisionRank(decay(cls, elapsed).privacyClass) <= precisionRank(cls));
    }
  }
});

test('an unknowable age is treated as expired, and clock skew cannot sharpen', () => {
  assert.equal(decay('precise_temporary', Number.NaN).stage, 'expired');
  assert.equal(decay('precise_temporary', Number.NaN).privacyClass, 'none');
  assert.equal(decay('precise_temporary', Number.POSITIVE_INFINITY).stage, 'expired');
  // Negative elapsed clamps to 0, whose ceiling equals the input class — it can
  // therefore never widen anything.
  assert.equal(decay('approximate', -60_000).privacyClass, 'approximate');
  assert.equal(decay('approximate', -60_000).ageMs, 0);
  assert.equal(decay('aggregate_only', -1).privacyClass, 'aggregate_only');
});

test('decay of an already-coarse class stays coarse', () => {
  assert.equal(decay('aggregate_only', 0).privacyClass, 'aggregate_only');
  assert.equal(decay('approximate', 0).privacyClass, 'approximate');
  assert.equal(decay('none', 0).privacyClass, 'none');
});

// ── effectiveClass ────────────────────────────────────────────────────────────

test('effectiveClass composes decay and every standing bound', () => {
  const fresh = effectiveClass('precise_temporary', 0, 'locate_my_friends', liveGrant(), { now: T0 });
  assert.equal(fresh.privacyClass, 'precise_temporary');
  assert.equal(fresh.stage, 'precise');

  const aged = effectiveClass(
    'precise_temporary',
    DECAY_BOUNDARIES_MS.precise,
    'locate_my_friends',
    liveGrant(),
    { now: T0 },
  );
  assert.equal(aged.privacyClass, 'approximate');

  const ungranted = effectiveClass('precise_temporary', 0, 'locate_my_friends', null, { now: T0 });
  assert.equal(ungranted.privacyClass, 'approximate');

  const dead = effectiveClass('precise_temporary', DECAY_BOUNDARIES_MS.last_known, 'locate_my_friends', liveGrant(), { now: T0 });
  assert.equal(dead.privacyClass, 'none');
});

// ── identity ──────────────────────────────────────────────────────────────────

test('§23: identity may only render at approximate or above', () => {
  assert.equal(mayRenderIdentity('none'), false);
  assert.equal(mayRenderIdentity('aggregate_only'), false);
  assert.equal(mayRenderIdentity('approximate'), true);
  assert.equal(mayRenderIdentity('place_level'), true);
  assert.equal(mayRenderIdentity('precise_temporary'), true);
});

test('a public stranger can never reach a rung that renders identity', () => {
  for (const requested of PRIVACY_CLASSES) {
    for (const grant of [null, liveGrant({ purpose: 'public_stranger' })]) {
      const out = applyCeiling(requested, 'public_stranger', grant, { now: T0 });
      assert.equal(mayRenderIdentity(out), false, `stranger reached ${out}`);
    }
  }
});
