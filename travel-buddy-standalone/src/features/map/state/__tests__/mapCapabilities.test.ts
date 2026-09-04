/**
 * §30 capability derivation — what the map shell is allowed to open.
 *
 * ## The defect this covers
 *
 * `DEFAULT_MAP_CAPABILITIES` hardcoded `CROWD_FLOW: false, LOCATE_FRIENDS:
 * false, TIME_MACHINE: false`, `canEnterMode` fails closed, and nothing in the
 * app ever called `setMapCapabilities`. Three of §2's nine surfaces were gated
 * behind a switch with no hand on it — not a feature flag, because there was no
 * flag table, env var or admin toggle behind it. `deriveMapCapabilities` is the
 * hand: it answers each gate from evidence the session can actually see.
 *
 * ## What is asserted, and why each assertion is the interesting one
 *
 * The easy way to "fix" an unreachable surface is to hardcode `true`, which
 * trades an unreachable surface for one that opens onto nothing. So the tests
 * below pin BOTH directions for every gate: the condition that legitimately
 * opens it, and the absence of that condition keeping it shut. TIME_MACHINE has
 * no honest source at all today, and the test that matters for it is that a
 * fully-populated input still leaves it closed.
 *
 * Run: node --import tsx/esm --test src/features/map/state/__tests__/mapCapabilities.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveMapCapabilities,
  sameMapCapabilities,
  type MapCapabilityInputs,
} from '../../../../stores/mapStore.tsx';
import { canEnterMode, MAP_CAPABILITY_KEYS } from '../mapMachine.ts';

/** Nothing available: no flows on screen, flag off, no scope, signed out. */
const NOTHING: MapCapabilityInputs = {
  crowdFlowObjectCount: 0,
  locateFriendsFlagEnabled: false,
  locateFriendsScopeId: null,
  viewerId: null,
  timeMachineProducerEnabled: false,
};

/** Everything a session could possibly offer. */
const EVERYTHING: MapCapabilityInputs = {
  crowdFlowObjectCount: 3,
  locateFriendsFlagEnabled: true,
  locateFriendsScopeId: 'trip-1',
  viewerId: 'user-1',
  timeMachineProducerEnabled: true,
};

describe('deriveMapCapabilities — §10 Crowd Flow', () => {
  it('opens when flow objects actually reached the client', () => {
    // Presence is the honest test: the server only serves crowd_flow once
    // map_crowd_flow_enabled is on AND the cohort/privacy gates pass, so a
    // non-zero count means there is genuinely movement to render.
    const caps = deriveMapCapabilities({ ...NOTHING, crowdFlowObjectCount: 1 });
    assert.equal(caps.CROWD_FLOW, true);
    assert.equal(canEnterMode('CROWD_FLOW', caps), true);
  });

  it('stays shut when no flow object is on screen', () => {
    const caps = deriveMapCapabilities(NOTHING);
    assert.equal(caps.CROWD_FLOW, false);
    assert.equal(canEnterMode('CROWD_FLOW', caps), false);
  });

  it('does not open on some other kind being present', () => {
    // The count is of crowd_flow objects specifically. A map full of places
    // must not imply the city is moving.
    const caps = deriveMapCapabilities({ ...EVERYTHING, crowdFlowObjectCount: 0 });
    assert.equal(caps.CROWD_FLOW, false);
  });
});

describe('deriveMapCapabilities — §12 Locate My Friends', () => {
  it('opens only when the flag, a group scope and a viewer identity all exist', () => {
    const caps = deriveMapCapabilities(EVERYTHING);
    assert.equal(caps.LOCATE_FRIENDS, true);
    assert.equal(canEnterMode('LOCATE_FRIENDS', caps), true);
  });

  it('stays shut when the server flag is off', () => {
    // locate_friends_enabled is seeded FALSE (migration 2219) and every route
    // checks it. Opening the mode without it gives a session that cannot start.
    const caps = deriveMapCapabilities({ ...EVERYTHING, locateFriendsFlagEnabled: false });
    assert.equal(caps.LOCATE_FRIENDS, false);
  });

  it('stays shut with no group scope', () => {
    // §12 is group-scoped by definition. No scope means no session to start,
    // so the mode would have no subject.
    const caps = deriveMapCapabilities({ ...EVERYTHING, locateFriendsScopeId: null });
    assert.equal(caps.LOCATE_FRIENDS, false);
  });

  it('stays shut with no viewer identity', () => {
    // LocateFriendsPanel needs a viewerMemberId; a signed-out viewer cannot be
    // a member of the group the mode would open.
    const caps = deriveMapCapabilities({ ...EVERYTHING, viewerId: null });
    assert.equal(caps.LOCATE_FRIENDS, false);
  });
});

describe('deriveMapCapabilities — §15 Time Machine', () => {
  it('opens when the per-offset producer is reachable for this session', () => {
    // GET /api/map/projection/temporal is now the source §15 never had. The gate
    // is a presence check on the PRODUCER, so the mode opens even though a given
    // offset may have nothing to show — an empty offset is an honest empty state,
    // not a closed mode.
    const caps = deriveMapCapabilities({ ...NOTHING, timeMachineProducerEnabled: true });
    assert.equal(caps.TIME_MACHINE, true);
    assert.equal(canEnterMode('TIME_MACHINE', caps), true);
  });

  it('stays shut when the temporal producer is unreachable (gateway flag off)', () => {
    // The temporal endpoint rides map_projection_enabled; when it answers
    // enabled:false there is no source to scrub through, so the mode stays shut
    // rather than open onto a producer that cannot answer.
    const caps = deriveMapCapabilities({ ...EVERYTHING, timeMachineProducerEnabled: false });
    assert.equal(caps.TIME_MACHINE, false);
    assert.equal(canEnterMode('TIME_MACHINE', caps), false);
  });
});

describe('deriveMapCapabilities — the surfaces that already worked', () => {
  it('leaves Compass and Trip open regardless of input', () => {
    // Both have working surfaces on this screen (the pick pipeline and the Ask
    // Compass bar; trip objects and Optimize Today). Nothing here narrows them.
    for (const inputs of [NOTHING, EVERYTHING]) {
      const caps = deriveMapCapabilities(inputs);
      assert.equal(caps.COMPASS, true);
      assert.equal(caps.TRIP, true);
    }
  });

  it('answers every capability key the machine knows about', () => {
    // A key the machine gates on but the derivation forgets would read as
    // `undefined`, which canEnterMode denies — an unreachable surface again,
    // this time silently.
    const caps = deriveMapCapabilities(EVERYTHING);
    for (const key of MAP_CAPABILITY_KEYS) {
      assert.equal(typeof caps[key], 'boolean', `${key} must be answered`);
    }
  });
});

describe('sameMapCapabilities — the store bailout this depends on', () => {
  it('is true for two records that say the same thing', () => {
    // withCapabilities always allocates, so the store compares by VALUE. If it
    // did not, the screen's derive-and-dispatch effect would re-render forever.
    assert.equal(
      sameMapCapabilities(deriveMapCapabilities(NOTHING), deriveMapCapabilities(NOTHING)),
      true,
    );
  });

  it('is false as soon as one surface changes', () => {
    assert.equal(
      sameMapCapabilities(
        deriveMapCapabilities(NOTHING),
        deriveMapCapabilities({ ...NOTHING, crowdFlowObjectCount: 1 }),
      ),
      false,
    );
  });

  it('treats a null record as equal only to another null', () => {
    assert.equal(sameMapCapabilities(null, null), true);
    assert.equal(sameMapCapabilities(null, deriveMapCapabilities(NOTHING)), false);
  });
});
