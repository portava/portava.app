/**
 * features/media — the §16 Hidden Gems LENS model (census-media §19: MD21 ·
 * MD313 · MD15 · MD33 · MD415).
 *
 * What this suite holds the lens to:
 *   1. it reads the REAL `GET /media/gems` shape (gemId / name / neighborhood),
 *      which the old client mapper silently dropped whole;
 *   2. it never forwards a coordinate, even when the payload carries one;
 *   3. "the gem table did not answer" is never "no gems here";
 *   4. the §3 sections group without re-ranking, protective states win, and
 *      "Worth the detour" comes from a visitor OBSERVATION, never from saves;
 *   5. the §46.1 contour: a fragile gem never gets the brightest glow, an
 *      unavailable one gets none, and every one of the ten states has one;
 *   6. the card's own words carry no hype vocabulary and no number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapGemLensItem,
  mapGemLensProjection,
  gemLensReadState,
  isGemLensEmpty,
  sectionGemLens,
  gemLensSectionOf,
  gemContourTreatment,
  gemCardCopy,
  gemCardChromeStrings,
  GEM_LENS_SECTION_ORDER,
} from '../state/gemLens.ts';
import { GEM_STATES, findHypeLanguage } from '../../../lib/gems/gemStateDisplay.ts';
import type { HiddenGemLensItem, HiddenGemState } from '../types/hiddenGemMedia.ts';

/** A payload item exactly as MediaGemStateService serves it. */
function serverGem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gemId: 'g1',
    name: 'Secret cove',
    placeId: 'p1',
    category: 'beach',
    neighborhood: 'Son Tra',
    city: 'Da Nang',
    country: 'Vietnam',
    state: 'recently_confirmed',
    confidence: { score: 0.72, band: 'likely_current' },
    contributionCounts: { still_here: 2 },
    verificationLevel: 'community',
    lastUpdatedAt: '2026-09-20T10:00:00.000Z',
    imageUrl: 'https://cdn.example.test/g1.jpg',
    ...over,
  };
}

function item(state: HiddenGemState, over: Partial<HiddenGemLensItem> = {}): HiddenGemLensItem {
  return {
    gemId: `g-${state}`,
    name: `Gem ${state}`,
    placeId: null,
    category: null,
    neighborhood: null,
    city: null,
    country: null,
    state,
    confidence: { score: 0.5, band: 'provisional' },
    contributionCounts: {},
    verificationLevel: null,
    lastUpdatedAt: null,
    imageUrl: null,
    ...over,
  };
}

test('maps the REAL server shape — gemId/name/neighborhood — which the old mapper dropped', () => {
  const p = mapGemLensProjection({
    generatedAt: '2026-09-26T00:00:00.000Z',
    city: 'Da Nang',
    gems: [serverGem()],
    total: 1,
    determined: true,
    undetermined: [],
  });
  assert.equal(p.gems.length, 1);
  const g = p.gems[0]!;
  assert.equal(g.gemId, 'g1');
  assert.equal(g.name, 'Secret cove');
  assert.equal(g.neighborhood, 'Son Tra');
  assert.equal(g.state, 'recently_confirmed');
  assert.equal(g.imageUrl, 'https://cdn.example.test/g1.jpg');
  assert.equal(p.determined, true);
});

test('never forwards a coordinate, even if a regressed payload carries one', () => {
  const g = mapGemLensItem(serverGem({ lat: 16.05, lng: 108.25, latitude: 16.05, approx_latitude: 16 }));
  assert.ok(g);
  const keys = Object.keys(g!);
  for (const k of ['lat', 'lng', 'latitude', 'longitude', 'approx_latitude', 'approx_longitude']) {
    assert.equal(keys.includes(k), false, `${k} must not reach the lens item`);
  }
});

test('an item without a gemId is dropped; an unknown state reads as the calm still_hidden, never as confirmed', () => {
  assert.equal(mapGemLensItem({ name: 'no id' }), null);
  assert.equal(mapGemLensItem(serverGem({ state: 'viral_now' }))!.state, 'still_hidden');
});

test('UNREADABLE is not EMPTY: determined:false with "gems" undetermined is list_unreadable', () => {
  const unreadable = mapGemLensProjection({ gems: [], determined: false, undetermined: ['gems'] });
  assert.equal(gemLensReadState(unreadable), 'list_unreadable');
  assert.equal(isGemLensEmpty(unreadable), false, 'an unread list must not classify as an empty city');

  const empty = mapGemLensProjection({ gems: [], determined: true, undetermined: [] });
  assert.equal(gemLensReadState(empty), 'determined');
  assert.equal(isGemLensEmpty(empty), true);

  const partial = mapGemLensProjection({ gems: [serverGem()], determined: false, undetermined: ['gemState'] });
  assert.equal(gemLensReadState(partial), 'state_partial');

  // A payload that does not SAY it was determined has not said so.
  assert.equal(mapGemLensProjection({ gems: [] }).determined, false);
});

test('sections: every gem lands in exactly one, server order is kept inside each, sections follow §3 order', () => {
  const gems = [
    item('still_hidden', { gemId: 'a' }),
    item('recently_confirmed', { gemId: 'b' }),
    item('seasonal', { gemId: 'c' }),
    item('still_hidden', { gemId: 'd', contributionCounts: { still_worth_it: 1 } }),
    item('access_changed', { gemId: 'e' }),
    item('overcrowding_risk', { gemId: 'f' }),
    item('quiet_now', { gemId: 'g' }),
  ];
  const sections = sectionGemLens(gems);
  const all = sections.flatMap((s) => s.gems.map((g) => g.gemId));
  assert.deepEqual([...all].sort(), gems.map((g) => g.gemId).sort(), 'no gem lost, none duplicated');
  assert.deepEqual(
    sections.map((s) => s.key),
    GEM_LENS_SECTION_ORDER.filter((k) => sections.some((s) => s.key === k)),
  );
  assert.deepEqual(sections.find((s) => s.key === 'still_hidden')!.gems.map((g) => g.gemId), ['a', 'g']);
  assert.equal(sections[0]!.label, 'Recently confirmed');
});

test('"Worth the detour" is a visitor OBSERVATION — saves and visits cannot put a gem there', () => {
  assert.equal(gemLensSectionOf(item('still_hidden', { contributionCounts: { still_worth_it: 2 } })), 'worth_the_detour');
  // Heavy popularity with no observation stays "still hidden" — no input here is a save count.
  assert.equal(gemLensSectionOf(item('still_hidden', { contributionCounts: {} })), 'still_hidden');
});

test('PROTECTIVE FIRST: a gem reported closed or overcrowded is never filed under an enticing heading', () => {
  const worthIt = { still_worth_it: 5 };
  assert.equal(gemLensSectionOf(item('temporarily_unavailable', { contributionCounts: worthIt })), 'access_changed');
  assert.equal(gemLensSectionOf(item('overcrowding_risk', { contributionCounts: worthIt })), 'visit_gently');
  assert.equal(gemLensSectionOf(item('getting_discovered', { contributionCounts: worthIt })), 'visit_gently');
});

test('§46.1 contour: every one of the ten states has a treatment; fragile is dimmer than calm; unavailable has no glow', () => {
  for (const s of GEM_STATES) assert.ok(gemContourTreatment(s), `${s} has no contour`);
  const calm = gemContourTreatment('recently_confirmed');
  const fragile = gemContourTreatment('overcrowding_risk');
  const unavailable = gemContourTreatment('temporarily_unavailable');
  assert.equal(calm.kind, 'glow');
  assert.equal(fragile.kind, 'protective');
  assert.ok(fragile.glowOpacity < calm.glowOpacity, 'a fragile gem must never glow brighter than a calm one');
  assert.ok(fragile.glowRadius < calm.glowRadius);
  assert.equal(unavailable.kind, 'muted');
  assert.equal(unavailable.glowOpacity, 0);
  assert.ok(calm.borderWidth > 0, 'the contour line itself must be drawn');
});

test('the card authors no hype vocabulary and prints no number — for every state, with and without observations', () => {
  for (const s of GEM_STATES) {
    for (const counts of [{}, { still_worth_it: 3, still_here: 12 }]) {
      const strings = gemCardChromeStrings(item(s, { contributionCounts: counts, confidence: { score: 0.95, band: 'strong' } }));
      for (const str of strings) {
        assert.deepEqual(findHypeLanguage(str), [], `"${str}" (${s}) carries hype vocabulary`);
        assert.equal(/\d/.test(str), false, `"${str}" (${s}) prints a number — §46.1 forbids popularity counters`);
      }
    }
  }
});

test('card copy: coarse area only, a name fallback that invents nothing specific, the observation label', () => {
  const c = gemCardCopy(item('still_hidden', { name: null, neighborhood: 'Son Tra', city: 'Da Nang', contributionCounts: { still_worth_it: 1 } }));
  assert.equal(c.title, 'Hidden gem');
  assert.equal(c.area, 'Son Tra · Da Nang');
  assert.equal(c.observationLabel, 'Worth the detour');
  assert.equal(gemCardCopy(item('overcrowding_risk')).note, 'This small spot is getting busy — consider another time.');
});
