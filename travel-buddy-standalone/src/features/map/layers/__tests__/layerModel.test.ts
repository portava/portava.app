/**
 * layerModel tests — Map spec §16.
 *
 * The four things that must never regress:
 *   1. §16's suggested defaults, quoted verbatim.
 *   2. `contextual` is a real third state that resolves from context.
 *   3. An explicit user choice outranks the automatic resolution AND survives
 *      every context change.
 *   4. Safety cannot be switched off — by preference, by stored blob, or by
 *      any context.
 * Plus: `layerForKind` covers EVERY member of MAP_OBJECT_KINDS, so adding a
 * kind to the contract without giving it a layer fails here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MAP_OBJECT_KINDS, type MapObjectKind } from '../../../../types/mapObjects.ts';
import {
  ALWAYS_ON_LAYER_IDS,
  CORE_LAYER_IDS,
  DEFAULT_LAYER_CONTEXT,
  EMPTY_LAYER_PREFERENCES,
  LAYER_DEFAULTS,
  LAYER_META,
  LAYER_PREFERENCES_STORAGE_KEY,
  LEGEND_MEANINGS,
  MAP_LAYER_IDS,
  TOGGLEABLE_LAYER_IDS,
  clearLayerChoice,
  filterByLayers,
  isAlwaysOnLayer,
  isKindVisible,
  kindsForLayer,
  layerControlValue,
  layerForKind,
  parseLayerPreferences,
  resolveLayers,
  serializeLayerPreferences,
  setLayerChoice,
  visibleLayerIds,
  type LayerContext,
  type LayerPreferences,
  type MapLayerId,
  type ToggleableLayerId,
} from '../layerModel.ts';

function ctx(over: Partial<LayerContext> = {}): LayerContext {
  return { ...DEFAULT_LAYER_CONTEXT, ...over };
}

// ── 1. §16's core layer list and suggested defaults ────────────────────────────

describe('§16 core layers', () => {
  it('lists exactly the eleven core layers the spec names, in spec order', () => {
    assert.deepEqual(CORE_LAYER_IDS, [
      'live_activity',
      'people',
      'events',
      'trip',
      'buddies',
      'saved',
      'crowd_flow',
      'hidden_gems',
      'safety',
      'transport',
      'memories',
    ]);
    assert.equal(CORE_LAYER_IDS.length, 11);
  });

  it('adds Relevant Places, which §16 names in its defaults line', () => {
    assert.ok(MAP_LAYER_IDS.includes('relevant_places'));
    assert.equal(MAP_LAYER_IDS.length, 12);
  });

  it('gives every layer presentation metadata', () => {
    for (const id of MAP_LAYER_IDS) {
      const meta = LAYER_META[id];
      assert.ok(meta, `no LAYER_META for ${id}`);
      assert.equal(meta.id, id);
      assert.ok(meta.label.length > 0);
      assert.ok(meta.description.length > 0);
      assert.match(meta.accent, /^#[0-9A-Fa-f]{6}$/);
      assert.ok(meta.glyphs.length > 0, `${id} contributes no §6 visual`);
      for (const glyph of meta.glyphs) {
        assert.ok(LEGEND_MEANINGS[glyph], `glyph ${glyph} has no §6 meaning`);
      }
    }
  });
});

describe('§16 suggested defaults, verbatim', () => {
  // "Live Activity on, Events on, Relevant Places on, Saved on;
  //  People/Trip/Crowd Flow contextual; Buddies and Memories off."
  it('turns Live Activity, Events, Relevant Places and Saved on', () => {
    assert.equal(LAYER_DEFAULTS.live_activity, 'on');
    assert.equal(LAYER_DEFAULTS.events, 'on');
    assert.equal(LAYER_DEFAULTS.relevant_places, 'on');
    assert.equal(LAYER_DEFAULTS.saved, 'on');
  });

  it('makes People, Trip and Crowd Flow contextual — not on, not off', () => {
    assert.equal(LAYER_DEFAULTS.people, 'contextual');
    assert.equal(LAYER_DEFAULTS.trip, 'contextual');
    assert.equal(LAYER_DEFAULTS.crowd_flow, 'contextual');
  });

  it('leaves Buddies and Memories off', () => {
    assert.equal(LAYER_DEFAULTS.buddies, 'off');
    assert.equal(LAYER_DEFAULTS.memories, 'off');
  });

  it('leaves the unassigned layers off — §16 forbids turning everything on', () => {
    // §16 names Transport and Hidden Gems as core layers but assigns them no
    // default. `off` is the only reading its governing rule permits.
    assert.equal(LAYER_DEFAULTS.transport, 'off');
    assert.equal(LAYER_DEFAULTS.hidden_gems, 'off');
  });

  it('marks Safety always_on rather than "on by default"', () => {
    assert.equal(LAYER_DEFAULTS.safety, 'always_on');
  });

  it('never turns every layer on simultaneously out of the box', () => {
    const visible = visibleLayerIds(EMPTY_LAYER_PREFERENCES, ctx());
    assert.ok(
      visible.length < MAP_LAYER_IDS.length,
      '§16: "Do not turn every layer on simultaneously"',
    );
    // The four §16 "on" layers plus forced Safety, and nothing else in a
    // neutral context.
    assert.deepEqual(visible.sort(), [
      'events',
      'live_activity',
      'relevant_places',
      'safety',
      'saved',
    ]);
  });
});

// ── 2. contextual is a real third state ────────────────────────────────────────

describe('contextual resolution', () => {
  it('resolves Trip from trip state, not from a stored boolean', () => {
    const off = resolveLayers(EMPTY_LAYER_PREFERENCES, ctx({ tripActive: false }));
    assert.equal(off.trip.visible, false);
    assert.equal(off.trip.source, 'context');

    const on = resolveLayers(EMPTY_LAYER_PREFERENCES, ctx({ tripActive: true }));
    assert.equal(on.trip.visible, true);
    assert.equal(on.trip.source, 'context');
    assert.equal(on.trip.reason, 'Trip in progress');
  });

  it('resolves Trip on in TRIP mode even without an active trip flag', () => {
    const r = resolveLayers(EMPTY_LAYER_PREFERENCES, ctx({ mode: 'TRIP', tripActive: false }));
    assert.equal(r.trip.visible, true);
  });

  it('resolves People from presence + zoom, never at world/city zoom', () => {
    const noone = resolveLayers(EMPTY_LAYER_PREFERENCES, ctx({ zoomBand: 'street', sharingPresenceCount: 0 }));
    assert.equal(noone.people.visible, false);

    const wide = resolveLayers(EMPTY_LAYER_PREFERENCES, ctx({ zoomBand: 'city', sharingPresenceCount: 4 }));
    assert.equal(wide.people.visible, false, '§17: city zoom renders zones, not individuals');

    const close = resolveLayers(EMPTY_LAYER_PREFERENCES, ctx({ zoomBand: 'street', sharingPresenceCount: 4 }));
    assert.equal(close.people.visible, true);
  });

  it('resolves People on in Locate My Friends mode', () => {
    const r = resolveLayers(
      EMPTY_LAYER_PREFERENCES,
      ctx({ mode: 'LOCATE_FRIENDS', zoomBand: 'city', sharingPresenceCount: 0 }),
    );
    assert.equal(r.people.visible, true);
  });

  it('resolves Crowd Flow from density and zoom, and always in CROWD_FLOW mode', () => {
    const quiet = resolveLayers(EMPTY_LAYER_PREFERENCES, ctx({ density: 'sparse', zoomBand: 'city' }));
    assert.equal(quiet.crowd_flow.visible, false);

    const busy = resolveLayers(EMPTY_LAYER_PREFERENCES, ctx({ density: 'very_dense', zoomBand: 'city' }));
    assert.equal(busy.crowd_flow.visible, true);

    const tooClose = resolveLayers(EMPTY_LAYER_PREFERENCES, ctx({ density: 'very_dense', zoomBand: 'venue' }));
    assert.equal(tooClose.crowd_flow.visible, false);

    const mode = resolveLayers(EMPTY_LAYER_PREFERENCES, ctx({ mode: 'CROWD_FLOW', density: 'sparse', zoomBand: 'venue' }));
    assert.equal(mode.crowd_flow.visible, true);
  });

  it('reports every resolution with a source and a human reason', () => {
    const r = resolveLayers(EMPTY_LAYER_PREFERENCES, ctx());
    for (const id of MAP_LAYER_IDS) {
      assert.ok(r[id], `no resolution for ${id}`);
      assert.equal(r[id].layerId, id);
      assert.equal(typeof r[id].visible, 'boolean');
      assert.ok(r[id].reason.length > 0, `${id} resolved without a reason`);
      assert.equal(r[id].defaultState, LAYER_DEFAULTS[id]);
    }
  });

  it('shows "auto" as the control value while no choice is stored', () => {
    assert.equal(layerControlValue(EMPTY_LAYER_PREFERENCES, 'trip'), 'auto');
    assert.equal(layerControlValue(EMPTY_LAYER_PREFERENCES, 'buddies'), 'auto');
    assert.equal(layerControlValue(EMPTY_LAYER_PREFERENCES, 'safety'), 'locked');
  });
});

// ── 3. explicit choice outranks automation and survives context change ─────────

describe('explicit user choice', () => {
  it('overrides the contextual resolution in both directions', () => {
    const forcedOn = setLayerChoice(EMPTY_LAYER_PREFERENCES, 'crowd_flow', 'on');
    const quiet = ctx({ density: 'sparse', zoomBand: 'venue' });
    assert.equal(resolveLayers(EMPTY_LAYER_PREFERENCES, quiet).crowd_flow.visible, false);
    assert.equal(resolveLayers(forcedOn, quiet).crowd_flow.visible, true);
    assert.equal(resolveLayers(forcedOn, quiet).crowd_flow.source, 'user');

    const forcedOff = setLayerChoice(EMPTY_LAYER_PREFERENCES, 'trip', 'off');
    const touring = ctx({ tripActive: true, mode: 'TRIP' });
    assert.equal(resolveLayers(EMPTY_LAYER_PREFERENCES, touring).trip.visible, true);
    assert.equal(resolveLayers(forcedOff, touring).trip.visible, false);
  });

  it('overrides a plain on/off default too', () => {
    const on = setLayerChoice(EMPTY_LAYER_PREFERENCES, 'memories', 'on');
    assert.equal(resolveLayers(on, ctx()).memories.visible, true);
    const off = setLayerChoice(EMPTY_LAYER_PREFERENCES, 'events', 'off');
    assert.equal(resolveLayers(off, ctx()).events.visible, false);
  });

  it('SURVIVES a context change — the choice lives in prefs, not in context', () => {
    const prefs = setLayerChoice(EMPTY_LAYER_PREFERENCES, 'people', 'off');
    const contexts: LayerContext[] = [
      ctx({ mode: 'LOCATE_FRIENDS', zoomBand: 'venue', sharingPresenceCount: 20 }),
      ctx({ mode: 'LIVE', zoomBand: 'world', sharingPresenceCount: 0 }),
      ctx({ mode: 'TRIP', zoomBand: 'street', tripActive: true, sharingPresenceCount: 3 }),
      ctx({ mode: 'CROWD_FLOW', density: 'very_dense', zoomBand: 'city' }),
    ];
    for (const c of contexts) {
      const r = resolveLayers(prefs, c);
      assert.equal(r.people.visible, false, `context ${c.mode}/${c.zoomBand} clobbered the user choice`);
      assert.equal(r.people.source, 'user');
    }
    // ...and the stored preference object itself is untouched by resolution.
    assert.deepEqual({ ...prefs }, { people: 'off' });
  });

  it('returns a layer to automatic when the choice is cleared', () => {
    const prefs = setLayerChoice(EMPTY_LAYER_PREFERENCES, 'trip', 'off');
    const touring = ctx({ tripActive: true });
    assert.equal(resolveLayers(prefs, touring).trip.visible, false);

    const cleared = clearLayerChoice(prefs, 'trip');
    const r = resolveLayers(cleared, touring);
    assert.equal(r.trip.visible, true);
    assert.equal(r.trip.source, 'context');
    assert.equal(layerControlValue(cleared, 'trip'), 'auto');
  });

  it('does not mutate the preferences it is given', () => {
    const base = setLayerChoice(EMPTY_LAYER_PREFERENCES, 'saved', 'off');
    const next = setLayerChoice(base, 'buddies', 'on');
    assert.equal((base as Record<string, unknown>).buddies, undefined);
    assert.equal((next as Record<string, unknown>).buddies, 'on');
    assert.equal(clearLayerChoice(base, 'saved') === base, false);
    assert.equal((base as Record<string, unknown>).saved, 'off');
  });
});

// ── 4. Safety is structurally un-disableable ───────────────────────────────────

describe('§5/§24 Safety cannot be switched off', () => {
  it('is excluded from the toggleable layer list', () => {
    assert.deepEqual([...ALWAYS_ON_LAYER_IDS], ['safety']);
    assert.equal(TOGGLEABLE_LAYER_IDS.includes('safety' as ToggleableLayerId), false);
    assert.equal(TOGGLEABLE_LAYER_IDS.length, MAP_LAYER_IDS.length - 1);
    assert.ok(isAlwaysOnLayer('safety'));
  });

  it('resolves visible under every context, including hostile ones', () => {
    const contexts: LayerContext[] = [
      ctx(),
      ctx({ zoomBand: 'world', mode: 'TIME_MACHINE', density: 'sparse' }),
      ctx({ zoomBand: 'venue', mode: 'LOCATE_FRIENDS', density: 'very_dense' }),
      ctx({ mode: 'COMPASS', compassActive: true, tripActive: true }),
    ];
    for (const c of contexts) {
      const r = resolveLayers(EMPTY_LAYER_PREFERENCES, c);
      assert.equal(r.safety.visible, true);
      assert.equal(r.safety.source, 'forced');
    }
  });

  it('ignores a stored preferences blob that tries to switch it off', () => {
    // The type forbids this; a hand-edited or migrated blob does not.
    const hostile = { safety: 'off', events: 'off' } as unknown as LayerPreferences;
    const r = resolveLayers(hostile, ctx());
    assert.equal(r.safety.visible, true, 'a stored blob must not be able to hide safety');
    assert.equal(r.safety.source, 'forced');
    assert.equal(r.events.visible, false, 'other layers in the same blob still apply');
  });

  it('strips a safety key when parsing stored preferences', () => {
    const parsed = parseLayerPreferences(JSON.stringify({ safety: 'off', trip: 'on' }));
    assert.equal((parsed as Record<string, unknown>).safety, undefined);
    assert.equal(parsed.trip, 'on');
  });

  it('keeps safety_notice objects on the map when every other layer is off', () => {
    let prefs: LayerPreferences = EMPTY_LAYER_PREFERENCES;
    for (const id of TOGGLEABLE_LAYER_IDS) prefs = setLayerChoice(prefs, id, 'off');
    const objects = MAP_OBJECT_KINDS.map((kind) => ({ kind }));
    const kept = filterByLayers(objects, prefs, ctx());
    assert.deepEqual(kept, [{ kind: 'safety_notice' }]);
    assert.equal(isKindVisible('safety_notice', prefs, ctx()), true);
    assert.equal(isKindVisible('place', prefs, ctx()), false);
  });
});

// ── 5. layerForKind covers the whole contract ──────────────────────────────────

describe('layerForKind', () => {
  it('maps EVERY MapObjectKind to a real layer', () => {
    for (const kind of MAP_OBJECT_KINDS) {
      const layer = layerForKind(kind);
      assert.ok(
        layer !== undefined && MAP_LAYER_IDS.includes(layer),
        `MapObjectKind '${kind}' has no layer — add it to LAYER_FOR_KIND`,
      );
    }
    // Belt and braces: the kind list itself must not have shrunk silently.
    assert.equal(MAP_OBJECT_KINDS.length, 14);
  });

  it('places each kind on the layer §16/§11 puts it on', () => {
    const expected: Record<MapObjectKind, MapLayerId> = {
      place: 'relevant_places',
      event: 'events',
      activity_zone: 'live_activity',
      crowd_flow: 'crowd_flow',
      social_zone: 'people',
      hidden_gem: 'hidden_gems',
      trip_stop: 'trip',
      crew_member: 'trip',
      meeting_point: 'trip',
      buddy_zone: 'buddies',
      safety_notice: 'safety',
      memory: 'memories',
      prediction: 'live_activity',
      saved_place: 'saved',
    };
    for (const kind of MAP_OBJECT_KINDS) {
      assert.equal(layerForKind(kind), expected[kind], `wrong layer for '${kind}'`);
    }
  });

  it('round-trips through kindsForLayer', () => {
    for (const kind of MAP_OBJECT_KINDS) {
      assert.ok(kindsForLayer(layerForKind(kind)).includes(kind));
    }
    assert.deepEqual(kindsForLayer('trip'), ['trip_stop', 'crew_member', 'meeting_point']);
    // Transport carries no object kind — that is legal, not a gap.
    assert.deepEqual(kindsForLayer('transport'), []);
  });
});

// ── 6. persistence helpers ─────────────────────────────────────────────────────

describe('preference serialization', () => {
  it('has a versioned storage key distinct from the legacy filter sheet key', () => {
    assert.equal(LAYER_PREFERENCES_STORAGE_KEY, 'map_layer_prefs_v1');
    assert.notEqual(LAYER_PREFERENCES_STORAGE_KEY, 'map_entity_layers_v1');
  });

  it('round-trips a preference set', () => {
    let prefs: LayerPreferences = EMPTY_LAYER_PREFERENCES;
    prefs = setLayerChoice(prefs, 'buddies', 'on');
    prefs = setLayerChoice(prefs, 'events', 'off');
    assert.deepEqual({ ...parseLayerPreferences(serializeLayerPreferences(prefs)) }, { ...prefs });
  });

  it('falls back to empty (i.e. to the §16 defaults) on junk', () => {
    for (const junk of [null, undefined, '', 'not json', '[]', '"x"', '7']) {
      assert.deepEqual({ ...parseLayerPreferences(junk) }, {});
    }
  });

  it('drops unknown layers and unknown choices', () => {
    const parsed = parseLayerPreferences(
      JSON.stringify({ trip: 'on', not_a_layer: 'on', saved: 'contextual', buddies: 1 }),
    );
    assert.deepEqual({ ...parsed }, { trip: 'on' });
  });
});
