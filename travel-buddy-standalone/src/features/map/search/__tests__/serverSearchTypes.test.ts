/**
 * serverSearchTypes — the adapter's type table, checked against the WIRE.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * `SERVER_TYPE_TO_MAP_TYPE` was keyed on singular forms — `place`, `user`,
 * `area` — that the server has never emitted. The wire carries the plural
 * `SearchType` values (`travelers`, `hidden_gems`, `cities`, ...), so four of
 * §27's nine headings received nothing, and `toMapSearchResults` dropped them
 * without a sound. The unit test alongside this one was green the whole time,
 * because its fixtures used the same singular strings the adapter did: two
 * copies of the same mistake agreeing with each other.
 *
 * So this test refuses to name the types at all. It reads `SEARCH_TYPES` out of
 * `artifacts/api-server/src/routes/discoverySearch.ts` — the same declaration
 * the route's own `SearchType` union is derived from — and requires the adapter
 * to have an opinion about every member. A type added to the server and not to
 * the adapter fails HERE, at the seam, instead of silently vanishing from map
 * search.
 *
 * (The orphan-test guard, scripts/check-orphan-tests.mjs, derives each runner's
 * selection from that runner's real configuration for the same reason. This is
 * that idea applied to a network contract.)
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SERVER_TYPE_NOT_ON_MAP,
  SERVER_TYPE_TO_MAP_TYPE,
  classifyServerType,
  setUnknownServerTypeSink,
  toMapSearchResult,
  toMapSearchResults,
  type UnknownServerTypeSink,
} from '../searchAdapter.ts';
import { MAP_SEARCH_RESULT_TYPES } from '../mapSearchModel.ts';

// ── Reading the server's own declaration ─────────────────────────────────────

const SERVER_ROUTE_REL = 'artifacts/api-server/src/routes/discoverySearch.ts';

/**
 * Walk up from this file until the monorepo root that holds the api-server.
 * Resolution is relative to this module, never to cwd, so the runner's working
 * directory cannot change the answer.
 */
function locateServerRoute(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, SERVER_ROUTE_REL);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // Deliberately a FAILURE, not a skip. A skip here would restore exactly the
  // property this test exists to remove: a check that reports success while
  // verifying nothing.
  throw new Error(
    `Could not find ${SERVER_ROUTE_REL} above ${fileURLToPath(import.meta.url)}. ` +
      'This test derives the wire vocabulary from the server source; it cannot ' +
      'run against a hand-written copy.',
  );
}

const serverSource = readFileSync(locateServerRoute(), 'utf8');

/** `SEARCH_TYPES` as the server declares it — the source of `SearchType`. */
function parseSearchTypes(source: string): string[] {
  const block = /const\s+SEARCH_TYPES\s*=\s*\[([\s\S]*?)\]\s*as\s+const;/.exec(source);
  assert.ok(block, 'SEARCH_TYPES literal not found in the server route — has it been renamed?');
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** Every `type: "..."` literal the route actually puts on a result. */
function parseEmittedTypes(source: string): string[] {
  return [...new Set([...source.matchAll(/\btype:\s*"([a-z_]+)"/g)].map((m) => m[1]))];
}

const SEARCH_TYPES = parseSearchTypes(serverSource);
/** What a client can actually receive: every SearchType except the "all" selector. */
const WIRE_TYPES = SEARCH_TYPES.filter((t) => t !== 'all');

// ── The parse itself must not be vacuous ─────────────────────────────────────

describe('the derivation', () => {
  test('parsed a real vocabulary out of the server, not an empty list', () => {
    // Without this, a regex that stops matching turns every loop below into a
    // zero-iteration no-op and the suite goes green having checked nothing —
    // the same failure mode as the fixtures this file replaces.
    assert.ok(SEARCH_TYPES.includes('all'), 'the "all" selector should be in SEARCH_TYPES');
    assert.ok(WIRE_TYPES.length >= 15, `only parsed ${WIRE_TYPES.length} wire types`);
    // Anchors: the four the adapter used to drop, spelled as the wire spells them.
    for (const anchor of ['travelers', 'hidden_gems', 'cities', 'countries']) {
      assert.ok(WIRE_TYPES.includes(anchor), `expected "${anchor}" in the parsed wire vocabulary`);
    }
  });

  test('every type the route emits is a declared SearchType', () => {
    const emitted = parseEmittedTypes(serverSource);
    assert.ok(emitted.length >= 10, `only found ${emitted.length} emitted type literals`);
    for (const t of emitted) {
      assert.ok(
        SEARCH_TYPES.includes(t),
        `the route emits type "${t}", which is not in SEARCH_TYPES`,
      );
    }
  });
});

// ── The contract ─────────────────────────────────────────────────────────────

describe('adapter coverage of the wire vocabulary', () => {
  test('the adapter has an opinion about EVERY type the server can send', () => {
    const unknown = WIRE_TYPES.filter((t) => classifyServerType(t).kind === 'unknown');
    assert.deepEqual(
      unknown,
      [],
      `these server types reach the adapter and are silently dropped: ${unknown.join(', ')}. ` +
        'Add each to SERVER_TYPE_TO_MAP_TYPE or, if it has no map representation, ' +
        'to SERVER_TYPE_NOT_ON_MAP with a reason.',
    );
  });

  test('no type is both mapped and ruled off the map', () => {
    for (const t of WIRE_TYPES) {
      const inMapped = Object.prototype.hasOwnProperty.call(SERVER_TYPE_TO_MAP_TYPE, t);
      const inNotOnMap = Object.prototype.hasOwnProperty.call(SERVER_TYPE_NOT_ON_MAP, t);
      assert.ok(!(inMapped && inNotOnMap), `"${t}" appears in both tables`);
    }
  });

  test('every deliberate omission carries a real reason', () => {
    for (const [t, reason] of Object.entries(SERVER_TYPE_NOT_ON_MAP)) {
      assert.equal(typeof reason, 'string');
      assert.ok(reason.trim().length >= 20, `"${t}" is ruled off the map without a reason`);
    }
  });

  test('every mapped type lands on one of §27 nine headings', () => {
    for (const t of WIRE_TYPES) {
      const v = classifyServerType(t);
      if (v.kind !== 'mapped') continue;
      assert.ok(
        (MAP_SEARCH_RESULT_TYPES as readonly string[]).includes(v.mapType),
        `"${t}" maps to "${v.mapType}", which is not a §27 result type`,
      );
    }
  });
});

// ── End to end, one fixture per wire type ────────────────────────────────────

/** A result carrying every geometry the adapter knows how to read. */
function wireResult(type: string) {
  return {
    id: `${type}-1`,
    type,
    title: `A ${type} result`,
    destinationRoute: `/${type}/1`,
    metadata: {
      lat: 16.05,
      lng: 108.2,
      bounds: { north: 16.09, south: 16.01, east: 108.29, west: 108.11 },
    },
  };
}

describe('every mapped wire type survives the adapter', () => {
  test('a fully-located result of each mapped type comes out the other side', () => {
    const mapped = WIRE_TYPES.filter((t) => classifyServerType(t).kind === 'mapped');
    // Positive control: the set is non-empty and covers more than the four
    // types that survived before this was fixed.
    assert.ok(mapped.length >= 8, `only ${mapped.length} wire types are mapped`);

    const out = toMapSearchResults(mapped.map(wireResult));
    const survived = out.map((r) => r.id);
    const lost = mapped.map((t) => `${t}-1`).filter((id) => !survived.includes(id));
    assert.deepEqual(lost, [], `mapped types that still vanish in the adapter: ${lost.join(', ')}`);
    assert.equal(out.length, mapped.length, 'order and count must be preserved');
  });

  test('the four types the singular keys used to lose now arrive', () => {
    // Named explicitly, because these are the regression. Each is asserted via
    // the wire spelling, and each must reach its §27 heading.
    assert.equal(classifyServerType('travelers').kind, 'mapped');
    assert.deepEqual(classifyServerType('travelers'), { kind: 'mapped', mapType: 'user' });
    assert.deepEqual(classifyServerType('hidden_gems'), { kind: 'mapped', mapType: 'hidden_gem' });
    assert.deepEqual(classifyServerType('cities'), { kind: 'mapped', mapType: 'area' });
    assert.deepEqual(classifyServerType('countries'), { kind: 'mapped', mapType: 'area' });
  });

  test('the singular forms are aliases only — they are NOT what the wire sends', () => {
    // If someone "fixes" the table back to singular keys, the coverage test
    // above fails. This one records why the singular keys are not sufficient:
    // no result the server produces is ever spelled this way.
    for (const singular of ['traveler', 'city', 'country']) {
      assert.ok(
        !WIRE_TYPES.includes(singular),
        `"${singular}" is not a wire type; do not key the table on it`,
      );
    }
  });
});

// ── Deliberate omission vs. unknown ──────────────────────────────────────────

describe('a deliberate drop is distinguishable from an unrecognised one', () => {
  let seen: string[] = [];
  let restore: UnknownServerTypeSink;

  before(() => {
    restore = setUnknownServerTypeSink((t) => seen.push(t));
  });
  after(() => {
    setUnknownServerTypeSink(restore);
  });

  test('an unknown type warns exactly once, however many results carry it', () => {
    seen = [];
    setUnknownServerTypeSink((t) => seen.push(t));
    const out = toMapSearchResults([
      { id: '1', type: 'podcast', title: 'A' },
      { id: '2', type: 'podcast', title: 'B' },
      { id: '3', type: 'PODCAST', title: 'C' },
      { id: '4', type: 'places', title: 'D', metadata: { lat: 1, lng: 1 } },
    ]);
    assert.deepEqual(out.map((r) => r.id), ['4']);
    assert.deepEqual(seen, ['podcast'], 'the unknown type should be reported once, not per result');
  });

  test('a type ruled off the map on purpose does NOT warn', () => {
    seen = [];
    setUnknownServerTypeSink((t) => seen.push(t));
    const deliberate = WIRE_TYPES.filter((t) => classifyServerType(t).kind === 'not_on_map');
    assert.ok(deliberate.length > 0, 'expected at least one deliberately unmapped type');
    const out = toMapSearchResults(deliberate.map(wireResult));
    assert.deepEqual(out, [], 'deliberately unmapped types must not reach the map');
    assert.deepEqual(seen, [], `warned about deliberate omissions: ${seen.join(', ')}`);
  });

  test('classification says WHY, not just that it was dropped', () => {
    const plans = classifyServerType('plans');
    assert.equal(plans.kind, 'not_on_map');
    if (plans.kind === 'not_on_map') assert.match(plans.reason, /trip/);
    assert.deepEqual(classifyServerType('podcast'), { kind: 'unknown' });
  });
});

// ── What the server does not send at all ─────────────────────────────────────

describe('§27 headings with no producer', () => {
  test('Saved items has no SearchType — it is a server gap, not a mapping gap', () => {
    // §27's ninth type. The adapter keeps a 'saved' branch (the Areas
    // degradation path uses it), but nothing on the wire can reach it, so no
    // mapping is invented for a type that cannot arrive.
    assert.ok(!WIRE_TYPES.includes('saved'), 'a saved SearchType now exists — map it');
    assert.ok(!WIRE_TYPES.includes('wishlist'), 'a wishlist SearchType now exists — map it');
  });
});

// ── Dropped for want of coordinates, not for want of a mapping ───────────────

describe('the remaining drops are geometric, and provably so', () => {
  test('travelers and buddies are listable without being locatable', () => {
    // The server sends metadata: null for both. They must still arrive — a
    // person is a search result even when §23 gives the map no position.
    for (const t of ['travelers', 'buddies']) {
      const r = toMapSearchResult({ id: `${t}-x`, type: t, title: 'Ada', metadata: null });
      assert.ok(r, `${t} with no coordinates should still be listed`);
      // Narrow to the two person-shaped members before reading `center`: it is
      // not on every MapSearchResult (a hashtag has none), so an unnarrowed
      // read would be asserting about a field the union does not guarantee.
      assert.ok(
        r.type === 'user' || r.type === 'buddy',
        `${t} must map to a person result, got '${r.type}'`,
      );
      assert.equal(r.center ?? null, null);
    }
  });

  test('a mapped type with no geometry is dropped by the coordinate rule, not the type table', () => {
    // events / hidden_gems / cities / countries are all mapped, but the server
    // omits their coordinates (see the module docs). The distinction matters:
    // this is the server withholding geometry, not the client failing to
    // recognise the type — and the classification proves which.
    for (const t of ['events', 'hidden_gems', 'cities', 'countries']) {
      assert.equal(classifyServerType(t).kind, 'mapped', `${t} must be recognised`);
      assert.equal(
        toMapSearchResult({ id: `${t}-y`, type: t, title: 'X', metadata: null }),
        null,
        `${t} with no geometry must not be placed on the map`,
      );
      // Positive control: with coordinates, the same type does arrive.
      assert.ok(
        toMapSearchResult({ id: `${t}-z`, type: t, title: 'X', metadata: { lat: 16, lng: 108 } }),
        `${t} WITH coordinates must arrive`,
      );
    }
  });
});
