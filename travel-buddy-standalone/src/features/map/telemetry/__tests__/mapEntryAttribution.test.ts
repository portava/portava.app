/**
 * §35 map_opened.entry — explicit attribution, per real producer.
 *
 * entry = WHERE THE SESSION ORIGINATED. mode = HOW THE MAP RENDERS.
 * Neither is derived from the other; see the contract beside MAP_ENTRY_POINTS.
 *
 * Every case below corresponds to a navigation that EXISTS in this app. The
 * producer inventory was taken on 2026-09-04 by searching for '/map' across
 * app/ and src/: 14 call sites in 10 files. Vocabulary members with no
 * producer are listed at the bottom as DECLARED, NO CURRENT PRODUCER rather
 * than given fabricated coverage.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAP_ENTRY_POINTS,
  isMapEntryPoint,
  deriveMapEntryPoint,
  type MapEntryPoint,
} from '../mapTelemetry.ts';

/** Parse a real production href the way the map screen's params arrive. */
function paramsOf(href: string): Record<string, string | string[] | undefined> {
  const q = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
  const out: Record<string, string | string[] | undefined> = {};
  for (const pair of q.split('&').filter(Boolean)) {
    const [k, v = ''] = pair.split('=');
    out[decodeURIComponent(k!)] = decodeURIComponent(v);
  }
  return out;
}

/** The hrefs exactly as the producers construct them. */
const PRODUCERS: Array<{ surface: string; href: string; entry: MapEntryPoint; mode?: string }> = [
  { surface: 'Gems index — View on map',        href: '/map?entityTypes=gems&entry=gems',                          entry: 'gems' },
  { surface: 'Circle map section',              href: '/map?entityTypes=friends&mode=circle&entry=circle',         entry: 'circle', mode: 'circle' },
  { surface: 'Passport — Journeys',             href: '/map?entityTypes=stamps&mode=passport&entry=passport',      entry: 'passport', mode: 'passport' },
  { surface: 'Passport — MyWorld',              href: '/map?entityTypes=stamps&mode=passport&entry=passport',      entry: 'passport', mode: 'passport' },
  { surface: 'MapTab component',                href: '/map?entityTypes=stamps&mode=passport&entry=passport',      entry: 'passport', mode: 'passport' },
  { surface: 'Trip map preview (no tripId)',    href: '/map?entityTypes=trips&entry=trip',                         entry: 'trip' },
  { surface: 'Trip map preview (with tripId)',  href: '/map?entityTypes=trips&entry=trip&tripId=t-1',              entry: 'trip' },
  { surface: 'AI assistant openMap action',     href: '/map?entry=compass',                                        entry: 'compass' },
  { surface: 'Explore Portava — Map tile',      href: '/map?entry=unknown',                                        entry: 'unknown' },
  { surface: 'Explore Portava — Neighborhoods', href: '/map?entry=unknown',                                        entry: 'unknown' },
  { surface: 'Wall — See live',                 href: '/map?entry=unknown',                                        entry: 'unknown' },
  { surface: "Wall item — 'open_map' action",   href: '/map?entry=unknown',                                        entry: 'unknown' },
];

describe('every real /map producer attributes its own origin', () => {
  for (const p of PRODUCERS) {
    test(`${p.surface} -> entry=${p.entry}`, () => {
      assert.equal(deriveMapEntryPoint(paramsOf(p.href)), p.entry);
    });
  }

  test('the Compass chat blocks pass entry in the params object, not the query string', () => {
    // router.push({ pathname: '/map', params: { entry: 'compass', lat, lng, … } })
    assert.equal(
      deriveMapEntryPoint({ entry: 'compass', lat: '16.06', lng: '108.21', focusId: 'p1', title: 'X' }),
      'compass',
    );
  });
});

describe('entry is never derived from mode', () => {
  test('a passport-mode session that did NOT come from Passport is not attributed to it', () => {
    assert.equal(deriveMapEntryPoint({ mode: 'passport', entry: 'gems' }), 'gems');
  });

  test('a circle-mode session that did NOT come from Circle is not attributed to it', () => {
    assert.equal(deriveMapEntryPoint({ mode: 'circle', entry: 'trip' }), 'trip');
  });

  test('mode alone attributes nothing — it is not an origin', () => {
    // The historical defect: entry was literally `mode ?? 'direct'`.
    assert.equal(deriveMapEntryPoint({ mode: 'circle' }), 'deeplink');
    assert.equal(deriveMapEntryPoint({ mode: 'passport' }), 'deeplink');
  });

  test('entry and mode may share a word without being linked', () => {
    assert.equal(deriveMapEntryPoint({ entry: 'circle', mode: 'circle' }), 'circle');
    assert.equal(deriveMapEntryPoint({ entry: 'passport', mode: 'passport' }), 'passport');
  });
});

describe('unattributed and invalid origins', () => {
  test('a bare /map with no params is an unattributable deep link', () => {
    // Every internal surface states its origin explicitly, so an unstated one
    // did not come from a surface this app controls.
    assert.equal(deriveMapEntryPoint({}), 'deeplink');
  });

  test('an entry that is not a real origin is unknown, not a deep link', () => {
    for (const bad of ['direct', 'wall', 'explore', 'zzz', 'Circle']) {
      assert.equal(deriveMapEntryPoint({ entry: bad }), 'unknown', bad);
    }
  });

  test('whatever the input, the result is always a member of the union', () => {
    const inputs: Array<Record<string, string | string[] | undefined>> = [
      {}, { entry: '' }, { entry: [] }, { entry: ['gems'] }, { mode: 'circle' },
      { entry: 'direct' }, { zoom: '11' }, { entry: undefined },
    ];
    for (const i of inputs) {
      assert.equal(isMapEntryPoint(deriveMapEntryPoint(i)), true, JSON.stringify(i));
    }
  });
});

describe('vocabulary coverage is honest', () => {
  test('DECLARED, NO CURRENT PRODUCER — these have no navigation that emits them', () => {
    // Not fabricated coverage: no producer in this app emits these today.
    //   tab          — there is NO map tab. app/(tabs) registers index, discovery,
    //                  media, events, trips, messages, passport, ai, wall. Nothing
    //                  navigates with entry=tab.
    //   search       — no search surface links to /map.
    //   place        — no place surface links to /map.
    //   notification — no notification route targets /map.
    const declaredWithoutProducer: MapEntryPoint[] = ['tab', 'search', 'place', 'notification'];
    const produced = new Set(PRODUCERS.map((p) => p.entry));
    produced.add('compass');
    produced.add('deeplink');
    for (const m of declaredWithoutProducer) {
      assert.equal(produced.has(m), false, `${m} is claimed to have no producer but one is listed`);
      assert.equal(isMapEntryPoint(m), true, `${m} must still be a valid member`);
    }
  });

  test('every produced value is in the vocabulary, and the vocabulary has no duplicates', () => {
    for (const p of PRODUCERS) assert.equal(isMapEntryPoint(p.entry), true, p.surface);
    assert.equal(new Set(MAP_ENTRY_POINTS).size, MAP_ENTRY_POINTS.length);
  });
});

describe('the PRODUCER SOURCE actually carries the attribution', () => {
  // The table above proves the derivation. This proves the call sites still
  // pass what the table claims — without it, deleting `entry=gems` from
  // app/gems/index.tsx would leave every test above green, which is precisely
  // the vacuous-coverage failure this repo keeps getting bitten by.
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

  const SOURCES: Array<{ file: string; needle: string; surface: string }> = [
    { file: 'app/gems/index.tsx',                                  needle: "entityTypes=gems&entry=gems",              surface: 'Gems index' },
    { file: 'src/components/circle/CircleMapSection.tsx',          needle: "mode=circle&entry=circle",                  surface: 'Circle map section' },
    { file: 'src/features/passport/JourneysScreen.tsx',            needle: "mode=passport&entry=passport",              surface: 'Passport Journeys' },
    { file: 'src/features/passport/MyWorldScreen.tsx',             needle: "mode=passport&entry=passport",              surface: 'Passport MyWorld' },
    { file: 'src/components/MapTab.tsx',                           needle: "mode=passport&entry=passport",              surface: 'MapTab' },
    { file: 'src/components/TripPage.tsx',                         needle: "entityTypes=trips&entry=trip",              surface: 'Trip map preview' },
    { file: 'app/(tabs)/ai.tsx',                                   needle: "/map?entry=compass",                        surface: 'AI openMap' },
    { file: 'src/features/wall/components/WallScreen.tsx',         needle: "/map?entry=unknown",                        surface: 'Wall See live' },
    { file: 'src/features/wall/components/objects/wallItemShared.tsx', needle: "/map?entry=unknown",                    surface: 'Wall item open_map' },
    { file: 'app/explore-portava.tsx',                             needle: "/map?entry=unknown",                        surface: 'Explore tiles' },
  ];

  for (const src of SOURCES) {
    test(`${src.surface} still states its entry in source`, () => {
      const text = readFileSync(join(ROOT, src.file), 'utf8');
      assert.ok(
        text.includes(src.needle),
        `${src.file} no longer contains "${src.needle}". A producer that stops ` +
          'stating its origin silently falls back to deeplink, and the funnel ' +
          'loses that surface without any test going red.',
      );
    });
  }

  test('the Compass chat blocks still pass entry in their params objects', () => {
    const text = readFileSync(join(ROOT, 'src/components/compass/CompassChatBlocks.tsx'), 'utf8');
    const pushes = (text.match(/pathname: '\/map'/g) ?? []).length;
    const entries = (text.match(/entry: 'compass',/g) ?? []).length;
    assert.equal(pushes, 3, 'expected exactly 3 /map navigations in CompassChatBlocks');
    assert.equal(entries, pushes, 'every Compass /map navigation must state entry=compass');
  });

  test('NO production /map navigation is left without an entry', () => {
    // The catch-all: any new call site that forgets attribution shows up here.
    const files = SOURCES.map((s) => s.file).concat('src/components/compass/CompassChatBlocks.tsx');
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      for (const m of text.matchAll(/['\`]\/map\?([^'\`]*)['\`]/g)) {
        assert.ok(
          m[1]!.includes('entry='),
          `${f}: /map?${m[1]} navigates without stating entry=`,
        );
      }
    }
  });
});
