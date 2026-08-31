/**
 * homeFilters tests — Map spec §3.
 *
 * The five things that must never regress:
 *   1. §3's five chips, in the spec's order, single-select.
 *   2. A CHIP CANNOT RE-ENABLE A DISABLED LAYER. The headline guarantee — see
 *      the "chips never widen the layer-filtered set" block. Chips filter a set
 *      they are handed; they never widen it, and they never touch preferences.
 *   3. `live` means live: fresh AND confident AND not server-expired, each gate
 *      failing closed.
 *   4. `chipCount` and `filterForHome` can never disagree.
 *   5. `for_you` is a projection over server-supplied ranking, not a ranker —
 *      it drops nothing and orders by fields the object already carries.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAP_OBJECT_KINDS,
  point,
  type ConfidenceState,
  type FreshnessState,
  type MapObject,
  type MapObjectKind,
} from '../../../../types/mapObjects.ts';
import {
  DEFAULT_LAYER_CONTEXT,
  EMPTY_LAYER_PREFERENCES,
  MAP_LAYER_IDS,
  TOGGLEABLE_LAYER_IDS,
  filterByLayers,
  layerForKind,
  setLayerChoice,
  type LayerContext,
  type LayerPreferences,
  type ToggleableLayerId,
} from '../../layers/layerModel.ts';
import * as homeFilters from '../homeFilters.ts';
import {
  DEFAULT_HOME_FILTER,
  HOME_FILTERS,
  HOME_FILTER_IDS,
  HOME_FILTER_META,
  LIVE_CHIP_MIN_CONFIDENCE,
  chipCount,
  chipCounts,
  emptyStateFor,
  filterForHome,
  homeChipCounts,
  homeFilterLabel,
  homeVisibleObjects,
  isHomeFilterId,
  matchesHomeFilter,
  meetsLiveConfidenceFloor,
  qualifiesAsLive,
  type HomeFilterId,
} from '../homeFilters.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-08-31T12:00:00.000Z');

let seq = 0;

function obj(over: Partial<MapObject> = {}): MapObject {
  seq += 1;
  return {
    id: over.id ?? `o${String(seq).padStart(3, '0')}`,
    kind: 'place',
    geometry: point(16.05, 108.2),
    title: 'Fixture',
    privacyClass: 'place_level',
    renderingPriority: 40,
    ...over,
  };
}

/** An object that genuinely qualifies as Live. */
function liveObj(over: Partial<MapObject> = {}): MapObject {
  return obj({ freshness: 'live', confidence: 'strong', ...over });
}

function ctx(over: Partial<LayerContext> = {}): LayerContext {
  return { ...DEFAULT_LAYER_CONTEXT, ...over };
}

/** Layer prefs with every toggleable layer explicitly ON, so kinds are permitted. */
const ALL_LAYERS_ON: LayerPreferences = TOGGLEABLE_LAYER_IDS.reduce<LayerPreferences>(
  (acc, id) => setLayerChoice(acc, id, 'on'),
  EMPTY_LAYER_PREFERENCES,
);

const ids = (objects: readonly MapObject[]): string[] => objects.map((o) => o.id);

// ── 1. §3's chips ─────────────────────────────────────────────────────────────

describe('§3 filter chips', () => {
  it('lists exactly the five chips the spec names, in spec order', () => {
    assert.deepEqual(HOME_FILTER_IDS, ['for_you', 'live', 'people', 'events', 'gems']);
  });

  it('labels them in the spec’s own words', () => {
    assert.deepEqual(
      HOME_FILTERS.map((m) => m.label),
      ['For You', 'Live', 'People', 'Events', 'Gems'],
    );
    assert.equal(homeFilterLabel('for_you'), 'For You');
  });

  it('opens on For You', () => {
    assert.equal(DEFAULT_HOME_FILTER, 'for_you');
    assert.ok(isHomeFilterId(DEFAULT_HOME_FILTER));
  });

  it('is single-select: the active filter is a scalar, not a set', () => {
    // Structural first: `filterForHome` takes ONE HomeFilterId, so "two chips
    // at once" is not expressible. `.length` counts required parameters only
    // (`ctx` has a default), so 2 pins the (objects, filter) shape — a future
    // change to `HomeFilterId[]` would have to be deliberate, not drift.
    assert.equal(filterForHome.length, 2);
    for (const id of HOME_FILTER_IDS) {
      assert.equal(typeof id, 'string');
    }

    // Behavioural: a caller that smuggles a multi-select value through the type
    // gets nothing, not a union. The switch's exhaustiveness branch fails closed
    // rather than matching everything.
    const objects = MAP_OBJECT_KINDS.map((kind) => obj({ id: `m-${kind}`, kind }));
    const smuggled = ['people', 'events'] as unknown as HomeFilterId;
    assert.deepEqual(filterForHome(objects, smuggled), []);
    assert.equal(chipCount(objects, smuggled), 0);
  });

  it('rejects unknown chip ids', () => {
    assert.equal(isHomeFilterId('saved'), false);
    assert.equal(isHomeFilterId(''), false);
    assert.equal(isHomeFilterId(null), false);
    assert.equal(isHomeFilterId(undefined), false);
  });

  it('classifies the three chip roles honestly', () => {
    assert.equal(HOME_FILTER_META.for_you.role, 'ranking');
    assert.equal(HOME_FILTER_META.live.role, 'truth_state');
    for (const id of ['people', 'events', 'gems'] as const) {
      assert.equal(HOME_FILTER_META[id].role, 'kind');
      assert.ok(HOME_FILTER_META[id].kinds != null);
    }
    // The two non-kind chips must not declare kinds — a kind list on a ranking
    // lens would be an invitation to treat it as a kind filter.
    assert.equal(HOME_FILTER_META.for_you.kinds, null);
    assert.equal(HOME_FILTER_META.live.kinds, null);
  });

  it('only names kinds that exist in the object contract', () => {
    for (const meta of HOME_FILTERS) {
      for (const kind of meta.kinds ?? []) {
        assert.ok(
          (MAP_OBJECT_KINDS as readonly string[]).includes(kind),
          `${meta.id} names unknown kind ${kind}`,
        );
      }
    }
  });
});

// ── 2. THE HEADLINE GUARANTEE: chips never widen the layer-filtered set ───────

describe('chips are a lens over layers, never an override of them', () => {
  /**
   * THE test. The user switched the People layer OFF in the Layers sheet, then
   * taps the People chip. If chips could re-enable a layer, this is where it
   * would show up: the disabled kind would reappear on the map.
   */
  it('a chip cannot re-enable a layer the user switched off', () => {
    const socialZone = obj({ id: 'social-1', kind: 'social_zone' });
    const place = obj({ id: 'place-1', kind: 'place' });
    const projection = [socialZone, place];

    // The user's explicit, durable choice: People OFF.
    const prefs = setLayerChoice(ALL_LAYERS_ON, 'people', 'off');
    const layerCtx = ctx();

    // Sanity: the layer model itself already removed the social zone.
    const permitted = filterByLayers(projection, prefs, layerCtx);
    assert.deepEqual(ids(permitted), ['place-1']);

    // Now the user taps the People chip. The map must stay empty of people —
    // the chip filters what the layers permitted, it does not go back to the
    // projection for more.
    const shown = homeVisibleObjects(projection, 'people', prefs, layerCtx);
    assert.deepEqual(ids(shown), [], 'People chip resurrected a disabled layer');

    // And the badge agrees: 0, not 1.
    assert.equal(homeChipCounts(projection, prefs, layerCtx).people, 0);

    // The chip left the user's preference untouched.
    assert.equal((prefs as Record<string, unknown>).people, 'off');
    assert.deepEqual(
      prefs,
      setLayerChoice(ALL_LAYERS_ON, 'people', 'off'),
      'chip mutated layer preferences',
    );
  });

  it('holds for every chip against its own layer, for every kind', () => {
    // Exhaustive form of the same guarantee: for each kind, disable exactly the
    // layer that carries it, then try every chip. No chip may surface it.
    for (const kind of MAP_OBJECT_KINDS) {
      const layerId = layerForKind(kind);
      if (layerId === 'safety') continue; // §5/§24: not disableable by design
      const target = obj({ id: `k-${kind}`, kind, freshness: 'live', confidence: 'strong' });
      const prefs = setLayerChoice(ALL_LAYERS_ON, layerId as ToggleableLayerId, 'off');
      for (const chip of HOME_FILTER_IDS) {
        const shown = homeVisibleObjects([target], chip, prefs, ctx(), { now: NOW });
        assert.deepEqual(
          ids(shown),
          [],
          `chip "${chip}" surfaced kind "${kind}" whose layer "${layerId}" is off`,
        );
      }
    }
  });

  it('filterForHome returns a subset of its input, for every chip', () => {
    const objects = MAP_OBJECT_KINDS.map((kind) =>
      obj({ id: `s-${kind}`, kind, freshness: 'live', confidence: 'strong' }),
    );
    const inputIds = new Set(ids(objects));
    for (const chip of HOME_FILTER_IDS) {
      const out = filterForHome(objects, chip, { now: NOW });
      assert.ok(out.length <= objects.length, `${chip} grew the set`);
      for (const o of out) {
        assert.ok(inputIds.has(o.id), `${chip} produced an object that was not passed in`);
        assert.ok(objects.includes(o), `${chip} produced a synthesised object`);
      }
      assert.equal(new Set(ids(out)).size, out.length, `${chip} duplicated an object`);
    }
  });

  it('never mutates the array it was given', () => {
    const objects = [
      obj({ id: 'a', kind: 'event', renderingPriority: 10 }),
      obj({ id: 'b', kind: 'place', renderingPriority: 90 }),
    ];
    const before = ids(objects);
    for (const chip of HOME_FILTER_IDS) filterForHome(objects, chip, { now: NOW });
    assert.deepEqual(ids(objects), before, 'filterForHome sorted the caller’s array in place');
  });

  it('an empty permitted set stays empty however loud the chip is', () => {
    for (const chip of HOME_FILTER_IDS) {
      assert.deepEqual(filterForHome([], chip), []);
      assert.equal(chipCount([], chip), 0);
    }
  });

  it('takes no layer preferences and exposes no way to write them', () => {
    // homeVisibleObjects is the only function that sees prefs, and it only
    // READS them (via filterByLayers). filterForHome / chipCount /
    // matchesHomeFilter cannot: their required arity is (objects, filter) and
    // (obj, filter) — no room for a preferences argument, let alone a setter.
    assert.equal(chipCount.length, 2);
    assert.equal(matchesHomeFilter.length, 2);
    assert.equal(filterForHome.length, 2);
    // And the module exports no writer for layer state at all.
    const writers = Object.keys(homeFilters).filter((k) => /^(set|clear|toggle|enable)/.test(k));
    assert.deepEqual(writers, [], `homeFilters exports mutators: ${writers.join(', ')}`);
  });

  it('an always-on layer is unaffected by chips too — safety still shows', () => {
    // Safety is forced visible by the layer model; the chips must neither
    // hide it via layers nor claim it. It simply is not a chip's business.
    const notice = obj({ id: 'safety-1', kind: 'safety_notice', renderingPriority: 120 });
    const prefs = EMPTY_LAYER_PREFERENCES;
    const shown = homeVisibleObjects([notice], 'for_you', prefs, ctx());
    assert.deepEqual(ids(shown), ['safety-1']);
    // ...but a kind chip does not pretend a safety notice is a person/event/gem.
    for (const chip of ['people', 'events', 'gems'] as const) {
      assert.deepEqual(ids(homeVisibleObjects([notice], chip, prefs, ctx())), []);
    }
  });
});

// ── 3. `live` means live ──────────────────────────────────────────────────────

describe('the Live chip', () => {
  it('requires a live/recent freshness band', () => {
    const fresh: FreshnessState[] = ['live', 'recent'];
    const notFresh: FreshnessState[] = ['aging', 'stale', 'historical', 'unknown'];
    for (const f of fresh) {
      assert.equal(qualifiesAsLive(obj({ freshness: f, confidence: 'strong' })), true, f);
    }
    for (const f of notFresh) {
      assert.equal(qualifiesAsLive(obj({ freshness: f, confidence: 'strong' })), false, f);
    }
  });

  it('is not fooled by a busy reading from an hour ago', () => {
    // An hour-old observation lands in the `aging` band. High activity, strong
    // confidence, a recent-looking title — still not Live.
    const hourOld = obj({
      id: 'busy-hour-ago',
      kind: 'activity_zone',
      title: 'Busy right now',
      activity: 'very_busy',
      trend: 'getting_busier',
      confidence: 'strong',
      freshness: 'aging',
      observedAt: new Date(NOW - 60 * 60_000).toISOString(),
    });
    assert.equal(qualifiesAsLive(hourOld, NOW), false);
    assert.deepEqual(filterForHome([hourOld], 'live', { now: NOW }), []);
  });

  it('requires a confidence floor as well as freshness', () => {
    assert.equal(LIVE_CHIP_MIN_CONFIDENCE, 'likely_current');
    const below: ConfidenceState[] = ['unverified', 'provisional'];
    const atOrAbove: ConfidenceState[] = ['likely_current', 'live', 'strong'];
    for (const c of below) {
      assert.equal(meetsLiveConfidenceFloor(c), false, c);
      assert.equal(qualifiesAsLive(obj({ freshness: 'live', confidence: c })), false, c);
    }
    for (const c of atOrAbove) {
      assert.equal(meetsLiveConfidenceFloor(c), true, c);
      assert.equal(qualifiesAsLive(obj({ freshness: 'live', confidence: c })), true, c);
    }
  });

  it('fails closed on a missing or unrecognised axis', () => {
    assert.equal(meetsLiveConfidenceFloor(null), false);
    assert.equal(meetsLiveConfidenceFloor(undefined), false);
    assert.equal(meetsLiveConfidenceFloor('very_sure' as ConfidenceState), false);
    assert.equal(qualifiesAsLive(obj({})), false, 'no axes at all');
    assert.equal(qualifiesAsLive(obj({ freshness: 'live' })), false, 'no confidence');
    assert.equal(qualifiesAsLive(obj({ confidence: 'strong' })), false, 'no freshness');
  });

  it('honours the server’s expiry over the freshness band', () => {
    // §18: "expiry always wins over the bucket".
    const expired = liveObj({
      id: 'expired',
      expiresAt: new Date(NOW - 1000).toISOString(),
    });
    const current = liveObj({
      id: 'current',
      expiresAt: new Date(NOW + 60_000).toISOString(),
    });
    assert.equal(qualifiesAsLive(expired, NOW), false);
    assert.equal(qualifiesAsLive(current, NOW), true);
    assert.deepEqual(ids(filterForHome([expired, current], 'live', { now: NOW })), ['current']);
  });

  it('does not invent an expiry the server did not set', () => {
    // Absent or unparseable expiresAt means "no TTL from the source" — the
    // client must not synthesise one (§19).
    assert.equal(qualifiesAsLive(liveObj({}), NOW), true);
    assert.equal(qualifiesAsLive(liveObj({ expiresAt: '' }), NOW), true);
    assert.equal(qualifiesAsLive(liveObj({ expiresAt: 'not-a-date' }), NOW), true);
  });

  it('cuts across kinds — liveness is a truth state, not a category', () => {
    const objects = [
      liveObj({ id: 'ev', kind: 'event' }),
      liveObj({ id: 'zone', kind: 'activity_zone' }),
      liveObj({ id: 'pl', kind: 'place' }),
      obj({ id: 'stale-gem', kind: 'hidden_gem', freshness: 'stale', confidence: 'strong' }),
    ];
    assert.deepEqual(ids(filterForHome(objects, 'live', { now: NOW })), ['ev', 'zone', 'pl']);
  });
});

// ── 4. Kind chips ─────────────────────────────────────────────────────────────

describe('the kind chips', () => {
  it('People admits social zones, crew and buddy zones — and nothing else', () => {
    const objects = MAP_OBJECT_KINDS.map((kind) => obj({ id: kind, kind }));
    assert.deepEqual(ids(filterForHome(objects, 'people')), [
      'social_zone',
      'crew_member',
      'buddy_zone',
    ]);
  });

  it('People does not admit meeting points — a checkpoint is a place, not a person', () => {
    const mp = obj({ id: 'mp', kind: 'meeting_point' });
    assert.equal(matchesHomeFilter(mp, 'people'), false);
  });

  it('Events admits only events; Gems admits only hidden gems', () => {
    const objects = MAP_OBJECT_KINDS.map((kind) => obj({ id: kind, kind }));
    assert.deepEqual(ids(filterForHome(objects, 'events')), ['event']);
    assert.deepEqual(ids(filterForHome(objects, 'gems')), ['hidden_gem']);
  });

  it('kind chips ignore freshness — a quiet gem is still a gem', () => {
    const gem = obj({ id: 'g', kind: 'hidden_gem', freshness: 'historical', confidence: 'unverified' });
    assert.equal(matchesHomeFilter(gem, 'gems', { now: NOW }), true);
    assert.equal(matchesHomeFilter(gem, 'live', { now: NOW }), false);
  });

  it('kind chips preserve the projection’s order', () => {
    const objects = [
      obj({ id: 'e3', kind: 'event', renderingPriority: 10 }),
      obj({ id: 'e1', kind: 'event', renderingPriority: 90 }),
      obj({ id: 'e2', kind: 'event', renderingPriority: 60 }),
    ];
    assert.deepEqual(ids(filterForHome(objects, 'events')), ['e3', 'e1', 'e2']);
  });
});

// ── 5. For You is a projection, not a ranker ─────────────────────────────────

describe('the For You chip', () => {
  it('drops nothing — it is a ranking lens, not a filter', () => {
    const objects = MAP_OBJECT_KINDS.map((kind) => obj({ id: kind, kind }));
    assert.equal(filterForHome(objects, 'for_you').length, objects.length);
    assert.equal(chipCount(objects, 'for_you'), objects.length);
  });

  it('orders by the server’s own rendering priority, highest first', () => {
    const objects = [
      obj({ id: 'poi', renderingPriority: 10 }),
      obj({ id: 'safety', renderingPriority: 120 }),
      obj({ id: 'compass', renderingPriority: 70 }),
    ];
    assert.deepEqual(ids(filterForHome(objects, 'for_you')), ['safety', 'compass', 'poi']);
  });

  it('breaks a priority tie by distance, then by evidence, then deterministically', () => {
    const near = obj({ id: 'near', renderingPriority: 40, distanceKm: 0.2 });
    const far = obj({ id: 'far', renderingPriority: 40, distanceKm: 9 });
    const unknownDistance = obj({ id: 'unknown', renderingPriority: 40, distanceKm: null });
    assert.deepEqual(
      ids(filterForHome([far, unknownDistance, near], 'for_you')),
      ['near', 'far', 'unknown'],
    );

    const weak = obj({ id: 'a-weak', renderingPriority: 40, distanceKm: 1, confidence: 'provisional' });
    const strong = obj({ id: 'z-strong', renderingPriority: 40, distanceKm: 1, confidence: 'strong' });
    assert.deepEqual(
      ids(filterForHome([weak, strong], 'for_you')),
      ['z-strong', 'a-weak'],
      'evidence must outrank alphabetical order',
    );

    // Fully tied: a total order on id, so paging is stable.
    const t1 = obj({ id: 'b', renderingPriority: 40, distanceKm: 1, confidence: 'strong' });
    const t2 = obj({ id: 'a', renderingPriority: 40, distanceKm: 1, confidence: 'strong' });
    assert.deepEqual(ids(filterForHome([t1, t2], 'for_you')), ['a', 'b']);
    assert.deepEqual(ids(filterForHome([t2, t1], 'for_you')), ['a', 'b']);
  });

  it('invents no ranking of its own — identical server fields means input order is kept', () => {
    // If this module had a ranker, two objects the server ranked identically
    // would still get reordered by some client-side notion of relevance.
    const a = obj({ id: 'aa', kind: 'event', renderingPriority: 40, distanceKm: 1, confidence: 'strong' });
    const b = obj({ id: 'ab', kind: 'hidden_gem', renderingPriority: 40, distanceKm: 1, confidence: 'strong' });
    // Only the id fall-through separates them, and it is alphabetical, not
    // kind-weighted: a gem does not outrank an event by fiat.
    assert.deepEqual(ids(filterForHome([b, a], 'for_you')), ['aa', 'ab']);
  });
});

// ── 6. Counts can never disagree with the map ────────────────────────────────

describe('badge counts', () => {
  const objects: MapObject[] = [
    liveObj({ id: 'ev-live', kind: 'event' }),
    obj({ id: 'ev-old', kind: 'event', freshness: 'stale', confidence: 'strong' }),
    liveObj({ id: 'zone', kind: 'activity_zone' }),
    obj({ id: 'gem', kind: 'hidden_gem' }),
    obj({ id: 'soc', kind: 'social_zone' }),
    obj({ id: 'crew', kind: 'crew_member' }),
    obj({ id: 'buddy', kind: 'buddy_zone' }),
    obj({ id: 'plain', kind: 'place' }),
  ];

  it('chipCount equals filterForHome(...).length for every chip', () => {
    for (const chip of HOME_FILTER_IDS) {
      assert.equal(
        chipCount(objects, chip, { now: NOW }),
        filterForHome(objects, chip, { now: NOW }).length,
        `count disagreed with the map for "${chip}"`,
      );
    }
  });

  it('chipCounts agrees with chipCount, chip by chip', () => {
    const all = chipCounts(objects, { now: NOW });
    for (const chip of HOME_FILTER_IDS) {
      assert.equal(all[chip], chipCount(objects, chip, { now: NOW }), chip);
    }
    assert.deepEqual(all, { for_you: 8, live: 2, people: 3, events: 2, gems: 1 });
  });

  it('counts obey the layers too', () => {
    const prefs = setLayerChoice(ALL_LAYERS_ON, 'events', 'off');
    const layerCtx = ctx();
    const counts = homeChipCounts(objects, prefs, layerCtx, { now: NOW });
    assert.equal(counts.events, 0, 'badge counted objects the layers had removed');
    assert.equal(counts.live, 1, 'the live event was removed with its layer');
    for (const chip of HOME_FILTER_IDS) {
      assert.equal(
        counts[chip],
        homeVisibleObjects(objects, chip, prefs, layerCtx, { now: NOW }).length,
        chip,
      );
    }
  });
});

// ── 7. Honest empty states ───────────────────────────────────────────────────

describe('empty states', () => {
  it('gives every chip its own honest message', () => {
    const messages = HOME_FILTER_IDS.map((id) => emptyStateFor(id));
    assert.equal(new Set(messages).size, HOME_FILTER_IDS.length, 'messages are not distinct');
    for (const m of messages) {
      assert.ok(m.length > 0);
      assert.ok(!/no results/i.test(m), `"${m}" is a generic non-answer`);
    }
  });

  it('says what is actually missing, per chip', () => {
    assert.equal(emptyStateFor('live'), 'Nothing live around here right now');
    assert.match(emptyStateFor('people'), /presence/i);
    assert.match(emptyStateFor('events'), /events/i);
    assert.match(emptyStateFor('gems'), /gems/i);
  });
});

// ── 8. Composition order ─────────────────────────────────────────────────────

describe('homeVisibleObjects composes layers then chip', () => {
  it('equals filterForHome(filterByLayers(...)) exactly', () => {
    const objects = MAP_OBJECT_KINDS.map((kind) =>
      obj({ id: `c-${kind}`, kind, freshness: 'live', confidence: 'strong' }),
    );
    const prefs = setLayerChoice(ALL_LAYERS_ON, 'hidden_gems', 'off');
    const layerCtx = ctx({ zoomBand: 'street', mode: 'LIVE' });
    for (const chip of HOME_FILTER_IDS) {
      assert.deepEqual(
        ids(homeVisibleObjects(objects, chip, prefs, layerCtx, { now: NOW })),
        ids(filterForHome(filterByLayers(objects, prefs, layerCtx), chip, { now: NOW })),
        chip,
      );
    }
  });

  it('a contextual layer resolving off is not overridden by a chip either', () => {
    // People is `contextual`: with nobody sharing presence it resolves OFF with
    // no user choice involved. The chip must respect that resolution too.
    const soc = obj({ id: 'soc', kind: 'social_zone' });
    const quiet = ctx({ sharingPresenceCount: 0, mode: 'LIVE' });
    assert.deepEqual(
      ids(homeVisibleObjects([soc], 'people', EMPTY_LAYER_PREFERENCES, quiet)),
      [],
    );
    // ...and when context does resolve it on, the chip shows it.
    const busy = ctx({ sharingPresenceCount: 3, zoomBand: 'district' });
    assert.deepEqual(
      ids(homeVisibleObjects([soc], 'people', EMPTY_LAYER_PREFERENCES, busy)),
      ['soc'],
    );
  });

  it('tolerates a null/undefined projection', () => {
    assert.deepEqual(
      homeVisibleObjects(undefined as unknown as MapObject[], 'live', EMPTY_LAYER_PREFERENCES, ctx()),
      [],
    );
    assert.equal(
      homeChipCounts(undefined as unknown as MapObject[], EMPTY_LAYER_PREFERENCES, ctx()).live,
      0,
    );
  });
});

// ── 9. Coverage of the layer surface ─────────────────────────────────────────

describe('chips and layers stay distinct axes', () => {
  it('a chip that SHARES a layer’s name is still not that layer', () => {
    // `people` and `events` exist in both vocabularies. That is a real hazard:
    // it invites someone to assume `HomeFilterId` and `MapLayerId` are
    // interchangeable and pass one where the other belongs. They are not, and
    // the People pair proves it — the chip and the layer admit different kinds.
    const shared = HOME_FILTER_IDS.filter((id) => (MAP_LAYER_IDS as readonly string[]).includes(id));
    assert.deepEqual(shared, ['people', 'events']);

    const peopleChipKinds = HOME_FILTER_META.people.kinds ?? [];
    const peopleLayerKinds = MAP_OBJECT_KINDS.filter((k) => layerForKind(k) === 'people');
    assert.deepEqual([...peopleLayerKinds], ['social_zone']);
    assert.deepEqual([...peopleChipKinds], ['social_zone', 'crew_member', 'buddy_zone']);
    assert.notDeepEqual([...peopleChipKinds], [...peopleLayerKinds]);

    // The wider chip is harmless precisely because it cannot widen: with the
    // Buddies and Trip layers off, its two extra kinds never arrive.
    const extras = [
      obj({ id: 'crew', kind: 'crew_member' }),
      obj({ id: 'buddy', kind: 'buddy_zone' }),
    ];
    let prefs = setLayerChoice(ALL_LAYERS_ON, 'buddies', 'off');
    prefs = setLayerChoice(prefs, 'trip', 'off');
    assert.deepEqual(ids(homeVisibleObjects(extras, 'people', prefs, ctx())), []);
  });

  it('the chips do not cover every layer — and must not pretend to', () => {
    // Saved, Memories, Transport, Trip, Crowd Flow have no chip. That is §3's
    // design (five chips, eleven-plus layers): the Layers sheet is the complete
    // control surface, chips are the fast lens. A chip set that grew to cover
    // every layer would be a second layers UI with no persistence.
    const chipKinds = new Set<MapObjectKind>();
    for (const meta of HOME_FILTERS) for (const k of meta.kinds ?? []) chipKinds.add(k);
    const uncovered = MAP_OBJECT_KINDS.filter((k) => !chipKinds.has(k));
    assert.ok(uncovered.length > 0);
    assert.ok(uncovered.includes('memory'));
    assert.ok(uncovered.includes('safety_notice'));
  });
});
