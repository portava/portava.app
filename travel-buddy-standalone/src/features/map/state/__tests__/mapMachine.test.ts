/**
 * mapMachine tests — spec §30 (Map State Machine), §2 (one coordinated shell),
 * §5 (safety precedence), §16 (layers + automatic relevance).
 *
 * The suite is organised around the five things that would silently rot if
 * nobody asserted them: the mode x camera coupling table, the BACK ladder at
 * every depth, fail-closed capability gating, overlay mutual exclusion, and
 * the promise that a mode round-trip never edits the user's layer toggles.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAP_MODES,
  MAP_OVERLAYS,
  CAMERA_STATES,
  MODE_CAMERA,
  OBJECT_KIND_CAMERA,
  MODE_CAPABILITY,
  MODE_LAYER_POLICY,
  MAP_LAYERS,
  ALWAYS_ON_LAYERS,
  DEFAULT_ENABLED_LAYERS,
  DEFAULT_MAP_CAPABILITIES,
  SECONDARY_MODES,
  HOME_MODE,
  LEGACY_LAYER_TO_MAP_LAYER,
  TIME_OFFSET_MIN_MINUTES,
  TIME_OFFSET_MAX_MINUTES,
  cameraForMode,
  cameraForObjectKind,
  canEnterMode,
  enterableModes,
  clampTimeOffsetMinutes,
  createInitialMapMachineState,
  withCapabilities,
  mapMachineReducer,
  resolveBack,
  visibleLayersFor,
  visibleLegacyLayersFor,
  visibleLayers,
  activeOverlay,
  isOverlayOpen,
  isCameraUserControlled,
  isMapMode,
  isMapOverlay,
  isMapLayerId,
  isSecondaryMode,
} from '../mapMachine.ts';
import type { MapMachineState, MapMachineEvent, MapMode, MapLayerId } from '../mapMachine.ts';
import { MAP_OBJECT_KINDS } from '../../../../types/mapObjects.ts';
import { TOGGLEABLE_LAYERS } from '../../../../types/mapTypes.ts';

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** Every surface unlocked, so gating never accidentally masks another test. */
const ALL_CAPS = {
  COMPASS: true,
  TRIP: true,
  CROWD_FLOW: true,
  LOCATE_FRIENDS: true,
  TIME_MACHINE: true,
} as const;

function fresh(caps = ALL_CAPS): MapMachineState {
  return createInitialMapMachineState(caps);
}

/** Apply a list of events, left to right. */
function run(state: MapMachineState, ...events: MapMachineEvent[]): MapMachineState {
  return events.reduce(mapMachineReducer, state);
}

const SELECT_CAFE: MapMachineEvent = {
  type: 'SELECT_OBJECT',
  objectId: 'place-cafe',
  objectKind: 'place',
};

// ── Shape / initial state ──────────────────────────────────────────────────────

describe('initial state', () => {
  test('starts at LIVE, following the user, with nothing selected or open', () => {
    const s = fresh();
    assert.equal(s.mode, 'LIVE');
    assert.equal(s.camera, 'FOLLOW_USER');
    assert.equal(s.cameraTargetId, null);
    assert.equal(s.selection, null);
    assert.equal(s.navigation, null);
    assert.equal(s.timeOffsetMinutes, 0);
    assert.deepEqual([...s.overlays], []);
  });

  test('defaults gate the three unbuilt surfaces off', () => {
    const s = createInitialMapMachineState();
    assert.deepEqual(enterableModes(s.capabilities).sort(), ['COMPASS', 'LIVE', 'PLACE_SELECTED', 'TRIP']);
    assert.equal(DEFAULT_MAP_CAPABILITIES.CROWD_FLOW, false);
    assert.equal(DEFAULT_MAP_CAPABILITIES.LOCATE_FRIENDS, false);
    assert.equal(DEFAULT_MAP_CAPABILITIES.TIME_MACHINE, false);
  });

  test('copies the capability record instead of aliasing the caller’s object', () => {
    const caps = { ...ALL_CAPS };
    const s = createInitialMapMachineState(caps);
    (caps as Record<string, boolean>).CROWD_FLOW = false;
    assert.equal(s.capabilities.CROWD_FLOW, true);
  });

  test('type guards accept the vocabulary and reject everything else', () => {
    assert.equal(isMapMode('TRIP'), true);
    assert.equal(isMapMode('trip'), false);
    assert.equal(isMapMode(undefined), false);
    assert.equal(isMapOverlay('LAYERS'), true);
    assert.equal(isMapOverlay('SHEET'), false);
    assert.equal(isMapLayerId('crowd_flow'), true);
    assert.equal(isMapLayerId('nope'), false);
    assert.equal(isSecondaryMode('TRIP'), true);
    assert.equal(isSecondaryMode('LIVE'), false);
    assert.equal(isSecondaryMode('PLACE_SELECTED'), false);
  });
});

// ── The mode x camera coupling table ───────────────────────────────────────────

describe('mode x camera coupling (§30)', () => {
  test('MODE_CAMERA is total over MAP_MODES and only names real camera states', () => {
    assert.equal(Object.keys(MODE_CAMERA).length, MAP_MODES.length);
    for (const mode of MAP_MODES) {
      assert.ok(MODE_CAMERA[mode], `no camera for mode ${mode}`);
      assert.ok(CAMERA_STATES.includes(MODE_CAMERA[mode]), `bogus camera for ${mode}`);
    }
  });

  test('the table is exactly the coupling the spec asks for', () => {
    assert.deepEqual(MODE_CAMERA, {
      LIVE: 'FOLLOW_USER',
      PLACE_SELECTED: 'FOCUS_PLACE',
      COMPASS: 'COMPASS_RECOMMENDATIONS',
      TRIP: 'FOCUS_TRIP',
      CROWD_FLOW: 'FOCUS_AREA',
      LOCATE_FRIENDS: 'FOCUS_GROUP',
      TIME_MACHINE: 'FOCUS_AREA',
    });
  });

  test('entering every mode drives the camera from the table', () => {
    for (const mode of MAP_MODES) {
      if (mode === 'PLACE_SELECTED') continue; // reached via SELECT_OBJECT, see below
      const s = run(fresh(), { type: 'ENTER_MODE', mode });
      assert.equal(s.mode, mode, `mode not entered: ${mode}`);
      assert.equal(s.camera, MODE_CAMERA[mode], `camera mismatch entering ${mode}`);
    }
  });

  test('ENTER_MODE carries a target id for the camera to frame', () => {
    const s = run(fresh(), { type: 'ENTER_MODE', mode: 'TRIP', targetId: 'trip-77' });
    assert.equal(s.camera, 'FOCUS_TRIP');
    assert.equal(s.cameraTargetId, 'trip-77');

    const g = run(fresh(), { type: 'ENTER_MODE', mode: 'LOCATE_FRIENDS', targetId: 'group-9' });
    assert.equal(g.camera, 'FOCUS_GROUP');
    assert.equal(g.cameraTargetId, 'group-9');
  });

  test('OBJECT_KIND_CAMERA is total over the MapObject contract', () => {
    assert.equal(Object.keys(OBJECT_KIND_CAMERA).length, MAP_OBJECT_KINDS.length);
    for (const kind of MAP_OBJECT_KINDS) {
      assert.ok(CAMERA_STATES.includes(OBJECT_KIND_CAMERA[kind]), `bogus camera for kind ${kind}`);
    }
  });

  test('selecting a place implies FOCUS_PLACE; selecting an aggregate implies FOCUS_AREA', () => {
    assert.equal(cameraForObjectKind('place'), 'FOCUS_PLACE');
    assert.equal(cameraForObjectKind('event'), 'FOCUS_PLACE');
    assert.equal(cameraForObjectKind('hidden_gem'), 'FOCUS_PLACE');
    // §23: an aggregate must never be framed as if it were a precise pin.
    assert.equal(cameraForObjectKind('activity_zone'), 'FOCUS_AREA');
    assert.equal(cameraForObjectKind('crowd_flow'), 'FOCUS_AREA');
    assert.equal(cameraForObjectKind('prediction'), 'FOCUS_AREA');
    assert.equal(cameraForObjectKind('buddy_zone'), 'FOCUS_AREA');
    // Framing a crew member frames the group, never the individual.
    assert.equal(cameraForObjectKind('crew_member'), 'FOCUS_GROUP');
  });

  test('every camera state is reachable from some event', () => {
    const reached = new Set<string>();
    reached.add(fresh().camera); // FOLLOW_USER
    reached.add(run(fresh(), { type: 'USER_PANNED' }).camera); // FREE_EXPLORE
    reached.add(run(fresh(), SELECT_CAFE).camera); // FOCUS_PLACE
    reached.add(run(fresh(), { type: 'ENTER_MODE', mode: 'CROWD_FLOW' }).camera); // FOCUS_AREA
    reached.add(run(fresh(), { type: 'START_NAVIGATION', routeId: 'r1' }).camera); // FOCUS_ROUTE
    reached.add(run(fresh(), { type: 'ENTER_MODE', mode: 'TRIP' }).camera); // FOCUS_TRIP
    reached.add(run(fresh(), { type: 'ENTER_MODE', mode: 'LOCATE_FRIENDS' }).camera); // FOCUS_GROUP
    reached.add(run(fresh(), { type: 'ENTER_MODE', mode: 'COMPASS' }).camera); // COMPASS_RECOMMENDATIONS
    for (const camera of CAMERA_STATES) {
      assert.ok(reached.has(camera), `camera state unreachable: ${camera}`);
    }
  });

  test('cameraForMode / cameraForObjectKind fall back rather than returning undefined', () => {
    assert.equal(cameraForMode('NOPE' as MapMode), 'FOLLOW_USER');
    assert.equal(cameraForObjectKind('nope' as never), 'FOCUS_PLACE');
  });
});

// ── SELECT_OBJECT / CLEAR_SELECTION ────────────────────────────────────────────

describe('SELECT_OBJECT', () => {
  test('promotes LIVE to PLACE_SELECTED and focuses the object', () => {
    const s = run(fresh(), SELECT_CAFE);
    assert.equal(s.mode, 'PLACE_SELECTED');
    assert.equal(s.camera, 'FOCUS_PLACE');
    assert.equal(s.cameraTargetId, 'place-cafe');
    assert.deepEqual(s.selection, { objectId: 'place-cafe', objectKind: 'place' });
  });

  test('does NOT drop you out of a secondary mode (§2: one coordinated system)', () => {
    for (const mode of SECONDARY_MODES) {
      const s = run(fresh(), { type: 'ENTER_MODE', mode }, {
        type: 'SELECT_OBJECT',
        objectId: 'stop-1',
        objectKind: 'trip_stop',
      });
      assert.equal(s.mode, mode, `selecting inside ${mode} escaped the mode`);
      assert.equal(s.camera, 'FOCUS_PLACE');
      assert.equal(s.selection?.objectId, 'stop-1');
    }
  });

  test('dismisses an open overlay (tapping a search result closes Search)', () => {
    const s = run(fresh(), { type: 'OPEN_OVERLAY', overlay: 'SEARCH' }, SELECT_CAFE);
    assert.deepEqual([...s.overlays], []);
    assert.equal(s.selection?.objectId, 'place-cafe');
  });

  test('reclaims the camera after a user pan', () => {
    const s = run(fresh(), { type: 'USER_PANNED' }, SELECT_CAFE);
    assert.equal(s.camera, 'FOCUS_PLACE');
  });

  test('re-selecting the same object is a no-op (same reference)', () => {
    const a = run(fresh(), SELECT_CAFE);
    const b = mapMachineReducer(a, SELECT_CAFE);
    assert.equal(b, a);
  });

  test('switching selection updates both selection and camera target', () => {
    const s = run(fresh(), SELECT_CAFE, {
      type: 'SELECT_OBJECT',
      objectId: 'zone-1',
      objectKind: 'activity_zone',
    });
    assert.equal(s.selection?.objectId, 'zone-1');
    assert.equal(s.camera, 'FOCUS_AREA');
    assert.equal(s.cameraTargetId, 'zone-1');
  });

  test('rejects a malformed selection instead of entering a subjectless mode', () => {
    const base = fresh();
    assert.equal(mapMachineReducer(base, { type: 'SELECT_OBJECT', objectId: '', objectKind: 'place' }), base);
    assert.equal(
      mapMachineReducer(base, { type: 'SELECT_OBJECT', objectId: 'x', objectKind: 'unicorn' as never }),
      base,
    );
    assert.equal(
      mapMachineReducer(base, { type: 'SELECT_OBJECT', objectId: null as never, objectKind: 'place' }),
      base,
    );
  });
});

describe('CLEAR_SELECTION', () => {
  test('returns PLACE_SELECTED to LIVE and the camera to FOLLOW_USER', () => {
    const s = run(fresh(), SELECT_CAFE, { type: 'CLEAR_SELECTION' });
    assert.equal(s.mode, 'LIVE');
    assert.equal(s.camera, 'FOLLOW_USER');
    assert.equal(s.cameraTargetId, null);
    assert.equal(s.selection, null);
  });

  test('inside a secondary mode it clears only the selection and restores that mode’s camera', () => {
    const s = run(
      fresh(),
      { type: 'ENTER_MODE', mode: 'TRIP', targetId: 'trip-1' },
      { type: 'SELECT_OBJECT', objectId: 'stop-1', objectKind: 'trip_stop' },
      { type: 'CLEAR_SELECTION' },
    );
    assert.equal(s.mode, 'TRIP');
    assert.equal(s.camera, 'FOCUS_TRIP');
    assert.equal(s.selection, null);
  });

  test('does not yank the camera back from a user who has panned', () => {
    const s = run(fresh(), SELECT_CAFE, { type: 'USER_PANNED' }, { type: 'CLEAR_SELECTION' });
    assert.equal(s.mode, 'LIVE');
    assert.equal(s.camera, 'FREE_EXPLORE');
    assert.equal(s.selection, null);
  });

  test('is a no-op when there is nothing selected', () => {
    const base = fresh();
    assert.equal(mapMachineReducer(base, { type: 'CLEAR_SELECTION' }), base);
  });
});

// ── ENTER_MODE / EXIT_MODE ─────────────────────────────────────────────────────

describe('ENTER_MODE / EXIT_MODE', () => {
  test('entering a mode closes any open overlay', () => {
    const s = run(fresh(), { type: 'OPEN_OVERLAY', overlay: 'LAYERS' }, { type: 'ENTER_MODE', mode: 'TRIP' });
    assert.deepEqual([...s.overlays], []);
    assert.equal(s.mode, 'TRIP');
  });

  test('entering a mode clears a stale selection', () => {
    const s = run(fresh(), SELECT_CAFE, { type: 'ENTER_MODE', mode: 'COMPASS' });
    assert.equal(s.selection, null);
    assert.equal(s.mode, 'COMPASS');
    assert.equal(s.camera, 'COMPASS_RECOMMENDATIONS');
  });

  test('PLACE_SELECTED cannot be entered with nothing selected', () => {
    const base = fresh();
    assert.equal(mapMachineReducer(base, { type: 'ENTER_MODE', mode: 'PLACE_SELECTED' }), base);
  });

  test('PLACE_SELECTED can be re-entered when a selection already exists', () => {
    const selected = run(fresh(), { type: 'ENTER_MODE', mode: 'TRIP' }, SELECT_CAFE);
    const s = mapMachineReducer(selected, { type: 'ENTER_MODE', mode: 'PLACE_SELECTED' });
    assert.equal(s.mode, 'PLACE_SELECTED');
    assert.equal(s.selection?.objectId, 'place-cafe');
    assert.equal(s.camera, 'FOCUS_PLACE');
    assert.equal(s.cameraTargetId, 'place-cafe');
  });

  test('an unknown mode string is refused', () => {
    const base = fresh();
    assert.equal(mapMachineReducer(base, { type: 'ENTER_MODE', mode: 'TELEPORT' as MapMode }), base);
  });

  test('EXIT_MODE returns to LIVE from every secondary mode and clears selection', () => {
    for (const mode of SECONDARY_MODES) {
      const s = run(
        fresh(),
        { type: 'ENTER_MODE', mode },
        { type: 'SELECT_OBJECT', objectId: 'o1', objectKind: 'place' },
        { type: 'EXIT_MODE' },
      );
      assert.equal(s.mode, 'LIVE', `EXIT_MODE stuck in ${mode}`);
      assert.equal(s.camera, 'FOLLOW_USER');
      assert.equal(s.selection, null);
    }
  });

  test('EXIT_MODE at LIVE with nothing selected is a no-op', () => {
    const base = fresh();
    assert.equal(mapMachineReducer(base, { type: 'EXIT_MODE' }), base);
  });

  test('entering and leaving TIME_MACHINE always resets the clock to NOW (§37)', () => {
    const entered = run(
      fresh(),
      { type: 'SET_TIME_OFFSET', minutes: 120 },
      { type: 'ENTER_MODE', mode: 'TIME_MACHINE' },
    );
    assert.equal(entered.timeOffsetMinutes, 0);

    const left = run(entered, { type: 'SET_TIME_OFFSET', minutes: 60 }, { type: 'EXIT_MODE' });
    assert.equal(left.mode, 'LIVE');
    assert.equal(left.timeOffsetMinutes, 0);
  });

  test('leaving a non-TIME_MACHINE mode preserves the offset', () => {
    const s = run(
      fresh(),
      { type: 'ENTER_MODE', mode: 'TRIP' },
      { type: 'SET_TIME_OFFSET', minutes: 30 },
      { type: 'EXIT_MODE' },
    );
    assert.equal(s.timeOffsetMinutes, 30);
  });
});

// ── Capability gating (fail closed) ────────────────────────────────────────────

describe('canEnterMode fails closed', () => {
  test('MODE_CAPABILITY is total, and LIVE/PLACE_SELECTED are ungated', () => {
    assert.equal(Object.keys(MODE_CAPABILITY).length, MAP_MODES.length);
    assert.equal(MODE_CAPABILITY.LIVE, null);
    assert.equal(MODE_CAPABILITY.PLACE_SELECTED, null);
  });

  test('LIVE is always reachable, whatever the flags say', () => {
    assert.equal(canEnterMode('LIVE', {}), true);
    assert.equal(canEnterMode('LIVE', null), true);
    assert.equal(canEnterMode('LIVE', undefined), true);
    assert.equal(canEnterMode('PLACE_SELECTED', {}), true);
  });

  test('a missing flag denies', () => {
    assert.equal(canEnterMode('CROWD_FLOW', {}), false);
    assert.equal(canEnterMode('LOCATE_FRIENDS', {}), false);
    assert.equal(canEnterMode('TIME_MACHINE', {}), false);
  });

  test('undefined, null, and truthy non-booleans all deny', () => {
    assert.equal(canEnterMode('CROWD_FLOW', { CROWD_FLOW: undefined }), false);
    assert.equal(canEnterMode('CROWD_FLOW', { CROWD_FLOW: null as never }), false);
    assert.equal(canEnterMode('CROWD_FLOW', { CROWD_FLOW: 1 as never }), false);
    assert.equal(canEnterMode('CROWD_FLOW', { CROWD_FLOW: 'true' as never }), false);
    assert.equal(canEnterMode('CROWD_FLOW', { CROWD_FLOW: {} as never }), false);
  });

  test('a null/undefined/non-object capability record denies every gated mode', () => {
    for (const mode of ['CROWD_FLOW', 'LOCATE_FRIENDS', 'TIME_MACHINE', 'TRIP', 'COMPASS'] as MapMode[]) {
      assert.equal(canEnterMode(mode, null), false);
      assert.equal(canEnterMode(mode, undefined), false);
      assert.equal(canEnterMode(mode, 'yes' as never), false);
    }
  });

  test('an unknown mode is never enterable', () => {
    assert.equal(canEnterMode('TELEPORT' as MapMode, { ...ALL_CAPS, TELEPORT: true } as never), false);
  });

  test('only a literal true opens a gated surface', () => {
    assert.equal(canEnterMode('TIME_MACHINE', { TIME_MACHINE: true }), true);
  });

  test('the reducer refuses to route into a dead surface', () => {
    const base = createInitialMapMachineState(); // shipping defaults: three surfaces off
    for (const mode of ['CROWD_FLOW', 'LOCATE_FRIENDS', 'TIME_MACHINE'] as MapMode[]) {
      const s = mapMachineReducer(base, { type: 'ENTER_MODE', mode });
      assert.equal(s, base, `machine routed into the unbuilt ${mode}`);
      assert.equal(s.mode, 'LIVE');
    }
  });

  test('withCapabilities evacuates a mode that just lost its flag', () => {
    const inFlow = run(fresh(), { type: 'ENTER_MODE', mode: 'CROWD_FLOW' }, SELECT_CAFE);
    assert.equal(inFlow.mode, 'CROWD_FLOW');

    const revoked = withCapabilities(inFlow, { ...ALL_CAPS, CROWD_FLOW: false });
    assert.equal(revoked.mode, 'LIVE');
    assert.equal(revoked.camera, 'FOLLOW_USER');
    assert.equal(revoked.selection, null);
  });

  test('withCapabilities leaves a still-legal mode alone', () => {
    const inTrip = run(fresh(), { type: 'ENTER_MODE', mode: 'TRIP', targetId: 't1' });
    const next = withCapabilities(inTrip, { ...ALL_CAPS, CROWD_FLOW: false });
    assert.equal(next.mode, 'TRIP');
    assert.equal(next.cameraTargetId, 't1');
  });
});

// ── Overlays ───────────────────────────────────────────────────────────────────

describe('overlays are orthogonal to mode and mutually exclusive', () => {
  test('opening one overlay closes the other (no sheet stack)', () => {
    let s = run(fresh(), { type: 'OPEN_OVERLAY', overlay: 'LAYERS' });
    assert.deepEqual([...s.overlays], ['LAYERS']);
    s = mapMachineReducer(s, { type: 'OPEN_OVERLAY', overlay: 'FILTERS' });
    assert.deepEqual([...s.overlays], ['FILTERS']);
    assert.equal(s.overlays.length, 1);
    assert.equal(activeOverlay(s), 'FILTERS');
    assert.equal(isOverlayOpen(s, 'LAYERS'), false);
    assert.equal(isOverlayOpen(s), true);
  });

  test('opening every pair leaves exactly one open', () => {
    for (const first of MAP_OVERLAYS) {
      for (const second of MAP_OVERLAYS) {
        const s = run(
          fresh(),
          { type: 'OPEN_OVERLAY', overlay: first },
          { type: 'OPEN_OVERLAY', overlay: second },
        );
        assert.equal(s.overlays.length, 1);
        assert.equal(s.overlays[0], second);
      }
    }
  });

  test('an overlay round-trip preserves mode, camera and selection in every mode', () => {
    for (const mode of MAP_MODES) {
      const entered =
        mode === 'PLACE_SELECTED'
          ? run(fresh(), SELECT_CAFE)
          : run(fresh(), { type: 'ENTER_MODE', mode, targetId: 'target-1' });
      const roundTripped = run(
        entered,
        { type: 'OPEN_OVERLAY', overlay: 'INTENT' },
        { type: 'CLOSE_OVERLAY' },
      );
      assert.equal(roundTripped.mode, entered.mode, `overlay changed the mode in ${mode}`);
      assert.equal(roundTripped.camera, entered.camera, `overlay changed the camera in ${mode}`);
      assert.equal(roundTripped.cameraTargetId, entered.cameraTargetId);
      assert.deepEqual(roundTripped.selection, entered.selection);
      assert.deepEqual([...roundTripped.overlays], []);
    }
  });

  test('re-opening the already-open overlay is a no-op', () => {
    const s = run(fresh(), { type: 'OPEN_OVERLAY', overlay: 'SEARCH' });
    assert.equal(mapMachineReducer(s, { type: 'OPEN_OVERLAY', overlay: 'SEARCH' }), s);
  });

  test('an unknown overlay is refused', () => {
    const base = fresh();
    assert.equal(mapMachineReducer(base, { type: 'OPEN_OVERLAY', overlay: 'DRAWER' as never }), base);
  });

  test('CLOSE_OVERLAY with a name only closes that overlay', () => {
    const s = run(fresh(), { type: 'OPEN_OVERLAY', overlay: 'LAYERS' });
    // Naming a different overlay must not close the one that is open.
    assert.equal(mapMachineReducer(s, { type: 'CLOSE_OVERLAY', overlay: 'FILTERS' }), s);
    const closed = mapMachineReducer(s, { type: 'CLOSE_OVERLAY', overlay: 'LAYERS' });
    assert.deepEqual([...closed.overlays], []);
  });

  test('CLOSE_OVERLAY with nothing open is a no-op', () => {
    const base = fresh();
    assert.equal(mapMachineReducer(base, { type: 'CLOSE_OVERLAY' }), base);
  });

  test('a pan under an open overlay leaves the overlay open', () => {
    const s = run(fresh(), { type: 'OPEN_OVERLAY', overlay: 'INTENT' }, { type: 'USER_PANNED' });
    assert.deepEqual([...s.overlays], ['INTENT']);
    assert.equal(s.camera, 'FREE_EXPLORE');
  });
});

// ── Camera events ──────────────────────────────────────────────────────────────

describe('USER_PANNED preserves everything except the camera (§30)', () => {
  test('mode, selection, overlay, navigation and time all survive a pan', () => {
    for (const mode of MAP_MODES) {
      const entered =
        mode === 'PLACE_SELECTED'
          ? run(fresh(), SELECT_CAFE)
          : run(fresh(), { type: 'ENTER_MODE', mode, targetId: 'target-1' });
      const panned = mapMachineReducer(entered, { type: 'USER_PANNED' });
      assert.equal(panned.mode, mode, `pan changed the mode in ${mode}`);
      assert.deepEqual(panned.selection, entered.selection);
      assert.deepEqual([...panned.overlays], [...entered.overlays]);
      assert.equal(panned.navigation, entered.navigation);
      assert.equal(panned.timeOffsetMinutes, entered.timeOffsetMinutes);
      assert.equal(panned.camera, 'FREE_EXPLORE', `pan did not free the camera in ${mode}`);
      assert.equal(panned.cameraTargetId, null);
    }
  });

  test('panning during navigation keeps navigation active', () => {
    const s = run(fresh(), { type: 'START_NAVIGATION', routeId: 'r1' }, { type: 'USER_PANNED' });
    assert.deepEqual(s.navigation, { routeId: 'r1', destinationObjectId: null });
    assert.equal(s.camera, 'FREE_EXPLORE');
  });

  test('a second pan is a no-op', () => {
    const s = run(fresh(), { type: 'USER_PANNED' });
    assert.equal(mapMachineReducer(s, { type: 'USER_PANNED' }), s);
  });
});

describe('RECENTER', () => {
  test('returns the camera to FOLLOW_USER from every mode without changing the mode', () => {
    for (const mode of MAP_MODES) {
      const entered =
        mode === 'PLACE_SELECTED'
          ? run(fresh(), SELECT_CAFE)
          : run(fresh(), { type: 'ENTER_MODE', mode, targetId: 'target-1' });
      const s = run(entered, { type: 'USER_PANNED' }, { type: 'RECENTER' });
      assert.equal(s.camera, 'FOLLOW_USER');
      assert.equal(s.cameraTargetId, null);
      assert.equal(s.mode, mode, `recenter changed the mode in ${mode}`);
    }
  });

  test('is a no-op when already following the user', () => {
    const base = fresh();
    assert.equal(mapMachineReducer(base, { type: 'RECENTER' }), base);
  });
});

describe('FOCUS_OBJECT frames without selecting', () => {
  test('moves the camera but leaves mode, selection and overlays untouched', () => {
    const before = run(fresh(), { type: 'ENTER_MODE', mode: 'COMPASS' }, {
      type: 'OPEN_OVERLAY',
      overlay: 'FILTERS',
    });
    const s = mapMachineReducer(before, {
      type: 'FOCUS_OBJECT',
      objectId: 'gem-3',
      objectKind: 'hidden_gem',
    });
    assert.equal(s.mode, 'COMPASS');
    assert.equal(s.selection, null);
    assert.deepEqual([...s.overlays], ['FILTERS']);
    assert.equal(s.camera, 'FOCUS_PLACE');
    assert.equal(s.cameraTargetId, 'gem-3');
  });

  test('uses the kind table, so a zone gets FOCUS_AREA', () => {
    const s = run(fresh(), { type: 'FOCUS_OBJECT', objectId: 'z1', objectKind: 'social_zone' });
    assert.equal(s.camera, 'FOCUS_AREA');
  });

  test('reclaims the camera from FREE_EXPLORE (an explicit camera intent)', () => {
    const s = run(fresh(), { type: 'USER_PANNED' }, {
      type: 'FOCUS_OBJECT',
      objectId: 'p1',
      objectKind: 'place',
    });
    assert.equal(s.camera, 'FOCUS_PLACE');
  });

  test('rejects malformed input and repeats are no-ops', () => {
    const base = fresh();
    assert.equal(
      mapMachineReducer(base, { type: 'FOCUS_OBJECT', objectId: '', objectKind: 'place' }),
      base,
    );
    assert.equal(
      mapMachineReducer(base, { type: 'FOCUS_OBJECT', objectId: 'x', objectKind: 'blob' as never }),
      base,
    );
    const once = mapMachineReducer(base, { type: 'FOCUS_OBJECT', objectId: 'p1', objectKind: 'place' });
    assert.equal(
      mapMachineReducer(once, { type: 'FOCUS_OBJECT', objectId: 'p1', objectKind: 'place' }),
      once,
    );
  });
});

// ── Navigation ─────────────────────────────────────────────────────────────────

describe('navigation (§5 standing precedence)', () => {
  test('START_NAVIGATION focuses the route, closes overlays and keeps the mode', () => {
    const s = run(
      fresh(),
      { type: 'ENTER_MODE', mode: 'TRIP', targetId: 'trip-1' },
      { type: 'OPEN_OVERLAY', overlay: 'LAYERS' },
      { type: 'START_NAVIGATION', routeId: 'route-9', destinationObjectId: 'place-x' },
    );
    assert.equal(s.mode, 'TRIP');
    assert.equal(s.camera, 'FOCUS_ROUTE');
    assert.equal(s.cameraTargetId, 'route-9');
    assert.deepEqual([...s.overlays], []);
    assert.deepEqual(s.navigation, { routeId: 'route-9', destinationObjectId: 'place-x' });
  });

  test('END_NAVIGATION restores the camera implied by the current mode', () => {
    const s = run(
      fresh(),
      { type: 'ENTER_MODE', mode: 'TRIP' },
      { type: 'START_NAVIGATION', routeId: 'r1' },
      { type: 'END_NAVIGATION' },
    );
    assert.equal(s.navigation, null);
    assert.equal(s.mode, 'TRIP');
    assert.equal(s.camera, 'FOCUS_TRIP');
    assert.equal(s.cameraTargetId, null);
  });

  test('END_NAVIGATION leaves a panned camera where the user put it', () => {
    const s = run(
      fresh(),
      { type: 'START_NAVIGATION', routeId: 'r1' },
      { type: 'USER_PANNED' },
      { type: 'END_NAVIGATION' },
    );
    assert.equal(s.camera, 'FREE_EXPLORE');
    assert.equal(s.navigation, null);
  });

  test('a bad route id, and ending when not navigating, are no-ops', () => {
    const base = fresh();
    assert.equal(mapMachineReducer(base, { type: 'START_NAVIGATION', routeId: '' }), base);
    assert.equal(mapMachineReducer(base, { type: 'END_NAVIGATION' }), base);
  });

  test('BACK never silently ends navigation', () => {
    const navigating = run(
      fresh(),
      { type: 'ENTER_MODE', mode: 'TRIP' },
      { type: 'START_NAVIGATION', routeId: 'r1' },
    );
    const back = resolveBack(navigating);
    assert.equal(back.handled, true);
    assert.equal(back.effect, 'exit_mode');
    assert.deepEqual(back.state.navigation, { routeId: 'r1', destinationObjectId: null });
  });
});

// ── Time Machine ───────────────────────────────────────────────────────────────

describe('SET_TIME_OFFSET (§15)', () => {
  test('sets the offset without touching mode or camera', () => {
    const before = run(fresh(), { type: 'ENTER_MODE', mode: 'TIME_MACHINE' });
    const s = mapMachineReducer(before, { type: 'SET_TIME_OFFSET', minutes: 60 });
    assert.equal(s.timeOffsetMinutes, 60);
    assert.equal(s.mode, before.mode);
    assert.equal(s.camera, before.camera);
  });

  test('accepts the §15 primary controls and historical (negative) offsets', () => {
    for (const minutes of [0, 30, 60, 120, -60, -24 * 60]) {
      const s = run(fresh(), { type: 'SET_TIME_OFFSET', minutes });
      assert.equal(s.timeOffsetMinutes, minutes);
    }
  });

  test('clamps out-of-range and falls back to NOW on non-finite offsets', () => {
    // A non-finite offset is malformed, not "very far away" — fail safe to NOW
    // rather than showing a forecast the projection could never serve.
    assert.equal(clampTimeOffsetMinutes(Number.NaN), 0);
    assert.equal(clampTimeOffsetMinutes(Number.POSITIVE_INFINITY), 0);
    assert.equal(clampTimeOffsetMinutes(Number.NEGATIVE_INFINITY), 0);
    assert.equal(clampTimeOffsetMinutes('60' as never), 0);
    assert.equal(clampTimeOffsetMinutes(99_999_999), TIME_OFFSET_MAX_MINUTES);
    assert.equal(clampTimeOffsetMinutes(-99_999_999), TIME_OFFSET_MIN_MINUTES);
    assert.equal(clampTimeOffsetMinutes(30.7), 30);

    const s = run(fresh(), { type: 'SET_TIME_OFFSET', minutes: 99_999_999 });
    assert.equal(s.timeOffsetMinutes, TIME_OFFSET_MAX_MINUTES);
  });

  test('setting the same offset twice is a no-op', () => {
    const s = run(fresh(), { type: 'SET_TIME_OFFSET', minutes: 30 });
    assert.equal(mapMachineReducer(s, { type: 'SET_TIME_OFFSET', minutes: 30 }), s);
  });
});

// ── BACK ───────────────────────────────────────────────────────────────────────

describe('BACK ladder (§2 — predictable unwinding)', () => {
  test('rung 1: an open overlay is closed and the mode is kept', () => {
    const s = run(fresh(), { type: 'ENTER_MODE', mode: 'TRIP' }, {
      type: 'OPEN_OVERLAY',
      overlay: 'LAYERS',
    });
    const back = resolveBack(s);
    assert.equal(back.handled, true);
    assert.equal(back.effect, 'close_overlay');
    assert.deepEqual([...back.state.overlays], []);
    assert.equal(back.state.mode, 'TRIP');
    assert.equal(back.state.camera, 'FOCUS_TRIP');
  });

  test('rung 1 wins over a selection', () => {
    const s = run(fresh(), SELECT_CAFE, { type: 'OPEN_OVERLAY', overlay: 'FILTERS' });
    const back = resolveBack(s);
    assert.equal(back.effect, 'close_overlay');
    assert.equal(back.state.selection?.objectId, 'place-cafe');
    assert.equal(back.state.mode, 'PLACE_SELECTED');
  });

  test('rung 2: PLACE_SELECTED returns to LIVE and clears the selection', () => {
    const back = resolveBack(run(fresh(), SELECT_CAFE));
    assert.equal(back.handled, true);
    assert.equal(back.effect, 'clear_selection');
    assert.equal(back.state.mode, 'LIVE');
    assert.equal(back.state.selection, null);
    assert.equal(back.state.camera, 'FOLLOW_USER');
    assert.equal(back.state.cameraTargetId, null);
  });

  test('rung 2 inside a secondary mode clears the selection but keeps the mode', () => {
    const s = run(fresh(), { type: 'ENTER_MODE', mode: 'LOCATE_FRIENDS' }, {
      type: 'SELECT_OBJECT',
      objectId: 'mp-1',
      objectKind: 'meeting_point',
    });
    const back = resolveBack(s);
    assert.equal(back.effect, 'clear_selection');
    assert.equal(back.state.mode, 'LOCATE_FRIENDS');
    assert.equal(back.state.selection, null);
    assert.equal(back.state.camera, 'FOCUS_GROUP');
  });

  test('rung 2 respects a panned camera', () => {
    const s = run(fresh(), SELECT_CAFE, { type: 'USER_PANNED' });
    const back = resolveBack(s);
    assert.equal(back.effect, 'clear_selection');
    assert.equal(back.state.camera, 'FREE_EXPLORE');
  });

  test('rung 3: every secondary mode collapses to LIVE', () => {
    for (const mode of SECONDARY_MODES) {
      const back = resolveBack(run(fresh(), { type: 'ENTER_MODE', mode, targetId: 't' }));
      assert.equal(back.handled, true);
      assert.equal(back.effect, 'exit_mode');
      assert.equal(back.state.mode, 'LIVE');
      assert.equal(back.state.camera, 'FOLLOW_USER');
      assert.equal(back.state.cameraTargetId, null);
    }
  });

  test('rung 3 out of TIME_MACHINE resets the clock to NOW', () => {
    const s = run(
      fresh(),
      { type: 'ENTER_MODE', mode: 'TIME_MACHINE' },
      { type: 'SET_TIME_OFFSET', minutes: 120 },
    );
    const back = resolveBack(s);
    assert.equal(back.effect, 'exit_mode');
    assert.equal(back.state.timeOffsetMinutes, 0);
  });

  test('rung 4: at LIVE with nothing open, the router must pop', () => {
    const base = fresh();
    const back = resolveBack(base);
    assert.equal(back.handled, false);
    assert.equal(back.effect, 'pop_route');
    assert.equal(back.state, base);
  });

  test('the full ladder unwinds one rung per press, in order', () => {
    let s = run(
      fresh(),
      { type: 'ENTER_MODE', mode: 'CROWD_FLOW' },
      { type: 'SELECT_OBJECT', objectId: 'flow-1', objectKind: 'crowd_flow' },
      { type: 'OPEN_OVERLAY', overlay: 'SEARCH' },
    );

    const press1 = resolveBack(s);
    assert.equal(press1.effect, 'close_overlay');
    s = press1.state;

    const press2 = resolveBack(s);
    assert.equal(press2.effect, 'clear_selection');
    assert.equal(press2.state.mode, 'CROWD_FLOW');
    s = press2.state;

    const press3 = resolveBack(s);
    assert.equal(press3.effect, 'exit_mode');
    assert.equal(press3.state.mode, 'LIVE');
    s = press3.state;

    const press4 = resolveBack(s);
    assert.equal(press4.handled, false);
    assert.equal(press4.effect, 'pop_route');
  });

  test('dispatching BACK applies exactly the state resolveBack returns', () => {
    const states = [
      run(fresh(), { type: 'OPEN_OVERLAY', overlay: 'INTENT' }),
      run(fresh(), SELECT_CAFE),
      run(fresh(), { type: 'ENTER_MODE', mode: 'TRIP' }),
      fresh(),
    ];
    for (const s of states) {
      assert.deepEqual(mapMachineReducer(s, { type: 'BACK' }), resolveBack(s).state);
    }
  });

  test('BACK at the root returns the same reference (no re-render)', () => {
    const base = fresh();
    assert.equal(mapMachineReducer(base, { type: 'BACK' }), base);
  });

  test('PLACE_SELECTED with no selection is repaired to LIVE rather than trapping BACK', () => {
    const broken: MapMachineState = { ...fresh(), mode: 'PLACE_SELECTED', selection: null };
    const back = resolveBack(broken);
    assert.equal(back.handled, true);
    assert.equal(back.effect, 'exit_mode');
    assert.equal(back.state.mode, 'LIVE');
  });
});

// ── Layers (§16) ───────────────────────────────────────────────────────────────

describe('visibleLayersFor (§16 automatic relevance)', () => {
  test('MODE_LAYER_POLICY is total and force/suppress are disjoint per mode', () => {
    assert.equal(Object.keys(MODE_LAYER_POLICY).length, MAP_MODES.length);
    for (const mode of MAP_MODES) {
      const policy = MODE_LAYER_POLICY[mode];
      assert.ok(policy, `no layer policy for ${mode}`);
      for (const layer of [...policy.force, ...policy.suppress]) {
        assert.ok(isMapLayerId(layer), `unknown layer id ${layer} in ${mode}`);
      }
      for (const layer of policy.force) {
        assert.ok(!policy.suppress.includes(layer), `${mode} both forces and suppresses ${layer}`);
      }
    }
  });

  test('safety is always visible and no mode may suppress it (§5)', () => {
    for (const mode of MAP_MODES) {
      assert.ok(!MODE_LAYER_POLICY[mode].suppress.includes('safety'), `${mode} suppresses safety`);
      assert.ok(visibleLayersFor(mode, []).includes('safety'), `${mode} hid safety`);
      // Even when the user has explicitly turned everything else off.
      assert.ok(visibleLayersFor(mode, ALWAYS_ON_LAYERS.slice()).includes('safety'));
    }
  });

  test('CROWD_FLOW suppresses individual place pins and forces the flow layer (§10)', () => {
    const visible = visibleLayersFor('CROWD_FLOW', [...MAP_LAYERS]);
    assert.ok(visible.includes('crowd_flow'));
    assert.ok(visible.includes('live_activity'));
    assert.ok(!visible.includes('relevant_places'), 'CROWD_FLOW leaked individual place pins');
    assert.ok(!visible.includes('hidden_gems'));
    assert.ok(!visible.includes('people'), 'CROWD_FLOW leaked individual people');
    assert.ok(!visible.includes('saved'));
    // §10: the inferred cause stays representable.
    assert.ok(visible.includes('events'));
  });

  test('LOCATE_FRIENDS forces people and suppresses gems and buddies (§12)', () => {
    const visible = visibleLayersFor('LOCATE_FRIENDS', []);
    assert.ok(visible.includes('people'), 'LOCATE_FRIENDS did not force the people layer');
    const withAll = visibleLayersFor('LOCATE_FRIENDS', [...MAP_LAYERS]);
    assert.ok(!withAll.includes('hidden_gems'));
    assert.ok(!withAll.includes('buddies'));
    assert.ok(!withAll.includes('crowd_flow'));
  });

  test('TIME_MACHINE never replays where individuals were (§23)', () => {
    const visible = visibleLayersFor('TIME_MACHINE', [...MAP_LAYERS]);
    assert.ok(!visible.includes('people'));
    assert.ok(!visible.includes('buddies'));
    assert.ok(!visible.includes('memories'));
  });

  test('COMPASS reduces noise (§14) while keeping places', () => {
    const visible = visibleLayersFor('COMPASS', [...MAP_LAYERS]);
    assert.ok(visible.includes('relevant_places'));
    assert.ok(!visible.includes('crowd_flow'));
    assert.ok(!visible.includes('memories'));
    assert.ok(!visible.includes('transport'));
  });

  test('TRIP forces the trip layer even when the user has it off', () => {
    const visible = visibleLayersFor('TRIP', ['saved']);
    assert.ok(visible.includes('trip'));
    assert.ok(visible.includes('saved'));
  });

  test('a suppressed layer stays hidden even when the user has it on', () => {
    assert.ok(!visibleLayersFor('CROWD_FLOW', ['memories', 'saved']).includes('memories'));
  });

  test('results come back in canonical MAP_LAYERS order, deduplicated', () => {
    const visible = visibleLayersFor('LIVE', ['saved', 'saved', 'events', 'live_activity']);
    const order = visible.map((l) => MAP_LAYERS.indexOf(l));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.equal(new Set(visible).size, visible.length);
  });

  test('unknown ids in the stored preferences are dropped, not passed through', () => {
    const visible = visibleLayersFor('LIVE', ['saved', 'aliens' as MapLayerId]);
    assert.ok(!visible.includes('aliens' as MapLayerId));
    assert.ok(visible.includes('saved'));
  });

  test('null / undefined / non-array preferences still yield the mode floor', () => {
    for (const input of [null, undefined, 'saved' as never]) {
      const visible = visibleLayersFor('LIVE', input);
      assert.ok(visible.includes('safety'));
      assert.ok(visible.includes('live_activity'));
    }
  });

  test('an unknown mode yields the user’s preferences plus the always-on floor — never a blank map', () => {
    const visible = visibleLayersFor('TELEPORT' as MapMode, ['saved', 'events']);
    assert.deepEqual(visible, ['events', 'saved', 'safety']);
  });

  test('THE ROUND-TRIP GUARANTEE: a mode tour never edits the stored preferences', () => {
    const prefs: MapLayerId[] = [...DEFAULT_ENABLED_LAYERS, 'memories', 'buddies'];
    const snapshot = [...prefs];
    Object.freeze(prefs); // a mutating implementation would throw here in strict mode

    const tour = [...MAP_MODES, ...MAP_MODES].map((mode) => visibleLayersFor(mode, prefs));

    assert.deepEqual([...prefs], snapshot, 'visibleLayersFor mutated the user’s preferences');
    // And the same mode always produces the same answer, however long the tour.
    assert.deepEqual(tour[0], tour[MAP_MODES.length]);
    // Returning to LIVE restores exactly what the user asked for, plus the floor.
    const live = visibleLayersFor('LIVE', prefs);
    for (const layer of snapshot) {
      assert.ok(live.includes(layer), `LIVE lost the user's ${layer} toggle`);
    }
    assert.ok(live.includes('memories'), 'a CROWD_FLOW visit permanently killed memories');
    assert.ok(live.includes('buddies'));
  });

  test('the returned array is fresh each call (callers may sort it in place)', () => {
    const prefs: MapLayerId[] = ['saved'];
    const a = visibleLayersFor('LIVE', prefs);
    const b = visibleLayersFor('LIVE', prefs);
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
    assert.notEqual(a, prefs);
  });

  test('visibleLayers(state, prefs) reads the mode off the machine', () => {
    const s = run(fresh(), { type: 'ENTER_MODE', mode: 'CROWD_FLOW' });
    assert.deepEqual(visibleLayers(s, [...MAP_LAYERS]), visibleLayersFor('CROWD_FLOW', [...MAP_LAYERS]));
  });
});

describe('visibleLegacyLayersFor (bridge to mapStore.enabledLayers)', () => {
  test('every legacy toggle maps to a real §16 layer', () => {
    for (const legacy of TOGGLEABLE_LAYERS) {
      assert.ok(isMapLayerId(LEGACY_LAYER_TO_MAP_LAYER[legacy]), `no mapping for ${legacy}`);
    }
    assert.equal(Object.keys(LEGACY_LAYER_TO_MAP_LAYER).length, TOGGLEABLE_LAYERS.length);
  });

  test('LIVE passes the user’s legacy toggles through untouched', () => {
    const enabled = [...TOGGLEABLE_LAYERS];
    assert.deepEqual(visibleLegacyLayersFor('LIVE', enabled), [...TOGGLEABLE_LAYERS]);
  });

  test('CROWD_FLOW suppresses gems, buddies, friends and trips', () => {
    const visible = visibleLegacyLayersFor('CROWD_FLOW', [...TOGGLEABLE_LAYERS]);
    assert.deepEqual(visible, ['events']);
  });

  test('TRIP forces the trips layer on even when the user turned it off', () => {
    const visible = visibleLegacyLayersFor('TRIP', ['events']);
    assert.ok(visible.includes('trips'));
  });

  test('does not mutate the stored legacy array across a mode round-trip', () => {
    const enabled: ReadonlyArray<(typeof TOGGLEABLE_LAYERS)[number]> = Object.freeze([
      ...TOGGLEABLE_LAYERS,
    ]);
    visibleLegacyLayersFor('CROWD_FLOW', enabled);
    visibleLegacyLayersFor('LOCATE_FRIENDS', enabled);
    assert.deepEqual([...visibleLegacyLayersFor('LIVE', enabled)], [...TOGGLEABLE_LAYERS]);
    assert.deepEqual([...enabled], [...TOGGLEABLE_LAYERS]);
  });

  test('handles null / unknown input without throwing', () => {
    assert.deepEqual(visibleLegacyLayersFor('LIVE', null), []);
    assert.deepEqual(visibleLegacyLayersFor('LIVE', ['ufo' as never]), []);
  });
});

// ── Whole-machine invariants ───────────────────────────────────────────────────

describe('machine invariants', () => {
  const EVERY_EVENT: MapMachineEvent[] = [
    { type: 'SELECT_OBJECT', objectId: 'o1', objectKind: 'place' },
    { type: 'CLEAR_SELECTION' },
    { type: 'ENTER_MODE', mode: 'TRIP', targetId: 't1' },
    { type: 'ENTER_MODE', mode: 'CROWD_FLOW' },
    { type: 'ENTER_MODE', mode: 'LOCATE_FRIENDS' },
    { type: 'ENTER_MODE', mode: 'TIME_MACHINE' },
    { type: 'ENTER_MODE', mode: 'COMPASS' },
    { type: 'EXIT_MODE' },
    { type: 'OPEN_OVERLAY', overlay: 'INTENT' },
    { type: 'OPEN_OVERLAY', overlay: 'LAYERS' },
    { type: 'OPEN_OVERLAY', overlay: 'FILTERS' },
    { type: 'OPEN_OVERLAY', overlay: 'SEARCH' },
    { type: 'CLOSE_OVERLAY' },
    { type: 'USER_PANNED' },
    { type: 'RECENTER' },
    { type: 'FOCUS_OBJECT', objectId: 'o2', objectKind: 'activity_zone' },
    { type: 'START_NAVIGATION', routeId: 'r1', destinationObjectId: 'o1' },
    { type: 'END_NAVIGATION' },
    { type: 'SET_TIME_OFFSET', minutes: 30 },
    { type: 'BACK' },
  ];

  test('the fixture exercises every event name in the union', () => {
    const covered = new Set(EVERY_EVENT.map((e) => e.type));
    assert.deepEqual(
      [...covered].sort(),
      [
        'BACK',
        'CLEAR_SELECTION',
        'CLOSE_OVERLAY',
        'END_NAVIGATION',
        'ENTER_MODE',
        'EXIT_MODE',
        'FOCUS_OBJECT',
        'OPEN_OVERLAY',
        'RECENTER',
        'SELECT_OBJECT',
        'SET_TIME_OFFSET',
        'START_NAVIGATION',
        'USER_PANNED',
      ],
    );
  });

  test('no event sequence can produce an invalid state', () => {
    // A deterministic walk over every ordered pair, then every triple prefix.
    for (const a of EVERY_EVENT) {
      for (const b of EVERY_EVENT) {
        for (const c of EVERY_EVENT) {
          const s = run(fresh(), a, b, c);
          assert.ok(isMapMode(s.mode), `invalid mode after ${a.type}/${b.type}/${c.type}`);
          assert.ok(CAMERA_STATES.includes(s.camera), 'invalid camera');
          assert.ok(s.overlays.length <= 1, 'more than one overlay open');
          for (const o of s.overlays) assert.ok(isMapOverlay(o), 'invalid overlay');
          // A mode with a subject always has one.
          if (s.mode === 'PLACE_SELECTED') assert.notEqual(s.selection, null);
          // FOLLOW_USER and FREE_EXPLORE frame nothing.
          if (s.camera === 'FOLLOW_USER') assert.equal(s.cameraTargetId, null);
          assert.ok(
            s.timeOffsetMinutes >= TIME_OFFSET_MIN_MINUTES &&
              s.timeOffsetMinutes <= TIME_OFFSET_MAX_MINUTES,
          );
        }
      }
    }
  });

  test('the reducer never mutates the state it was given', () => {
    for (const event of EVERY_EVENT) {
      const before = run(fresh(), { type: 'ENTER_MODE', mode: 'TRIP' }, SELECT_CAFE, {
        type: 'OPEN_OVERLAY',
        overlay: 'LAYERS',
      });
      const snapshot = JSON.stringify(before);
      mapMachineReducer(before, event);
      assert.equal(JSON.stringify(before), snapshot, `${event.type} mutated its input`);
    }
  });

  test('an unknown or malformed event returns the same reference', () => {
    const base = fresh();
    assert.equal(mapMachineReducer(base, { type: 'NOT_AN_EVENT' } as never), base);
    assert.equal(mapMachineReducer(base, {} as never), base);
    assert.equal(mapMachineReducer(base, null as never), base);
  });

  test('a gated surface stays unreachable through every event path', () => {
    const shipping = createInitialMapMachineState(); // CROWD_FLOW/LOCATE_FRIENDS/TIME_MACHINE off
    for (const a of EVERY_EVENT) {
      for (const b of EVERY_EVENT) {
        const s = run(shipping, a, b);
        assert.ok(
          canEnterMode(s.mode, s.capabilities),
          `reached ungated mode ${s.mode} via ${a.type}/${b.type}`,
        );
      }
    }
  });

  test('isCameraUserControlled tracks FREE_EXPLORE only', () => {
    assert.equal(isCameraUserControlled(fresh()), false);
    assert.equal(isCameraUserControlled(run(fresh(), { type: 'USER_PANNED' })), true);
    assert.equal(
      isCameraUserControlled(run(fresh(), { type: 'USER_PANNED' }, { type: 'RECENTER' })),
      false,
    );
  });

  test('HOME_MODE is LIVE and is always reachable', () => {
    assert.equal(HOME_MODE, 'LIVE');
    assert.equal(canEnterMode(HOME_MODE, {}), true);
  });
});
