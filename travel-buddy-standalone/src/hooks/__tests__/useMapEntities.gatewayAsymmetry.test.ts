/**
 * The gateway asymmetry guard — a kind the SERVER serves that the CLIENT never
 * asks for.
 *
 * THE BUG CLASS THIS EXISTS FOR
 * =============================
 * GET /api/map/projection grew `crew_member`, `buddy_zone` and `trip_stop`,
 * each with a privacy-complete reader extracted out of a route handler, each
 * with server tests, each registered in the gateway-bypass guard. The client's
 * `GATEWAY_KIND_FOR_LAYER` still named two kinds. So three server projectors
 * had no production caller and the client kept re-deriving those layers on the
 * device — the §19 violation the gateway exists to remove — and NOTHING FAILED.
 * Both halves were individually well tested. The gap was between them.
 *
 * `crowd_flow` landed the same way and is still in that state: a commit titled
 * "the client can now receive it" changed no client file, and nothing noticed.
 *
 * That asymmetry is invisible to every other test in either package, because
 * every other test looks at one side. This one looks at both and compares them.
 *
 * WHY IT READS SOURCE INSTEAD OF IMPORTING
 * ========================================
 * The route is an Express module in a different package and the hook pulls in
 * React plus the supabase client; neither is importable from a node:test in
 * this one. So both sides are parsed, and every parse is asserted non-trivial
 * first — a guard that silently reads zero kinds would "pass" forever, which is
 * the same failure it was written to catch.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAP_OBJECT_KINDS, type MapObjectKind } from '../../types/mapObjects.ts';
import { TOGGLEABLE_LAYERS } from '../../types/mapTypes.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(__dir, '../../..', '..', 'artifacts/api-server/src/routes/mapProjection.ts');
const HOOK = resolve(__dir, '..', 'useMapEntities.ts');

/**
 * Kinds the gateway can serve, read from the route's own `wantKind("…")` gates
 * — the single expression that decides whether a layer is collected at all.
 */
function servedKinds(): Set<string> {
  const src = readFileSync(ROUTE, 'utf8');
  const found = [...src.matchAll(/wantKind\(\s*["']([a-z_]+)["']\s*\)/g)].map((m) => m[1]);
  assert.ok(
    found.length >= 6,
    `parsed only ${found.length} wantKind() gates from the route — the parse broke, so this guard would be inert`,
  );
  return new Set(found);
}

/** The `sources` names the route reports, read from its `sources.push("…")` calls. */
function reportedSources(): Set<string> {
  const src = readFileSync(ROUTE, 'utf8');
  const found = [...src.matchAll(/sources\.push\(\s*["']([a-z_]+)["']\s*\)/g)].map((m) => m[1]);
  assert.ok(found.length >= 6, `parsed only ${found.length} sources.push() calls — the parse broke`);
  return new Set(found);
}

/** One `Record<ToggleableEntityType, …>` literal in the hook, as a map. */
function hookMap(name: string): Map<string, string> {
  const src = readFileSync(HOOK, 'utf8');
  const from = src.indexOf(`const ${name}`);
  assert.ok(from >= 0, `${name} not found in useMapEntities.ts — did it get renamed?`);
  const open = src.indexOf('{', from);
  const close = src.indexOf('};', open);
  assert.ok(close > open, `could not find the end of ${name}`);
  const out = new Map<string, string>();
  for (const m of src.slice(open, close).matchAll(/^\s+([a-z_]+):\s*'([a-z_]+)',/gm)) {
    out.set(m[1], m[2]);
  }
  assert.ok(out.size >= 2, `parsed only ${out.size} entries from ${name} — the parse broke`);
  return out;
}

/**
 * Kinds the gateway serves that this client deliberately does not ask for.
 *
 * An entry is a STATEMENT that the layer reaches users some other way, or is a
 * known gap. It is not an exemption: the guard fails if an entry stops being
 * unrequested (stale) as loudly as it fails on an unlisted one.
 */
const NOT_REQUESTED_BY_THIS_CLIENT: Record<string, string> = {
  // Travelers are not a `ToggleableEntityType` at all — the map screen has no
  // travelers layer. They render on the Discovery map through
  // useMapTravelers/TravelerMapLayer, whose avatar clustering and 45s poll are
  // that screen's, not this hook's. Asking here would double-draw them.
  social_zone:
    'rendered by useMapTravelers/TravelerMapLayer on the Discovery map; not a ToggleableEntityType',
  // A real gap, recorded rather than hidden: §10 crowd flow reached the gateway
  // server-side and no client file changed with it. Nothing can request it, so
  // no viewer can see a flow however many gates it clears. It needs a layer
  // toggle and a LineString renderer, which is its own change.
  crowd_flow:
    'GAP — server-only since the §10 wiring commit; no client toggle or LineString renderer yet',
};

describe('the client asks for every kind the gateway serves', () => {
  test('no server-served kind is silently unrequested', () => {
    const served = servedKinds();
    const requested = new Set(hookMap('GATEWAY_KIND_FOR_LAYER').values());

    const unrequested = [...served].filter((k) => !requested.has(k)).sort();
    assert.deepEqual(
      unrequested,
      Object.keys(NOT_REQUESTED_BY_THIS_CLIENT).sort(),
      'the gateway serves a kind no client layer asks for. Either map a layer to it in ' +
        'GATEWAY_KIND_FOR_LAYER, or add it to NOT_REQUESTED_BY_THIS_CLIENT with the reason. ' +
        'A server half with no client half is not a delivered layer.',
    );
  });

  test('the allowlist cannot go stale', () => {
    // Every excuse must still describe reality: a kind listed here that the
    // client HAS since started requesting, or that the server no longer serves,
    // is a lie about the system's shape.
    const served = servedKinds();
    const requested = new Set(hookMap('GATEWAY_KIND_FOR_LAYER').values());
    for (const [kind, why] of Object.entries(NOT_REQUESTED_BY_THIS_CLIENT)) {
      assert.ok(served.has(kind), `${kind} is allowlisted but the gateway no longer serves it`);
      assert.ok(!requested.has(kind), `${kind} is allowlisted but the client now requests it — drop the entry`);
      assert.ok(why.length > 20, `${kind} needs a real reason, not a placeholder`);
    }
  });

  test('the client never asks for a kind the gateway cannot serve', () => {
    // The mirror image, and the same silent failure: the request succeeds, the
    // layer is simply always empty, and the fallback never runs because the
    // gateway "answered".
    const served = servedKinds();
    const requested = [...hookMap('GATEWAY_KIND_FOR_LAYER').values()];
    const unservable = requested.filter((k) => !served.has(k)).sort();
    assert.deepEqual(unservable, [], 'the client requests a kind GET /api/map/projection never collects');
  });

  test('every kind on both sides is a real MapObjectKind', () => {
    const known = new Set<string>(MAP_OBJECT_KINDS as readonly string[]);
    for (const k of servedKinds()) assert.ok(known.has(k), `the route serves unknown kind "${k}"`);
    for (const k of hookMap('GATEWAY_KIND_FOR_LAYER').values()) {
      assert.ok(known.has(k as MapObjectKind), `the hook requests unknown kind "${k}"`);
    }
  });
});

describe('every toggleable layer is wired to the gateway', () => {
  test('the layer map covers all of TOGGLEABLE_LAYERS', () => {
    // The original defect in its most direct form: a layer with no gateway kind
    // keeps re-deriving itself on the device. The map is typed
    // `Record<ToggleableEntityType, …>` so this is also a compile error — this
    // asserts it at runtime too, because the parse above is what the other
    // tests here depend on.
    const layers = [...hookMap('GATEWAY_KIND_FOR_LAYER').keys()].sort();
    assert.deepEqual(layers, [...TOGGLEABLE_LAYERS].sort());
  });

  test('one kind per layer — no two layers share a kind', () => {
    const kinds = [...hookMap('GATEWAY_KIND_FOR_LAYER').values()];
    assert.equal(new Set(kinds).size, kinds.length, 'two layers map to the same kind, so one can never be turned off alone');
  });
});

describe('the source names the client watches for are the ones the server reports', () => {
  test('every GATEWAY_SOURCE_FOR_LAYER value is a name the route actually pushes', () => {
    // `friends` → "circle" is the one entry that is not the layer's own name.
    // If the server renamed it, the client would report friends as permanently
    // unread while their pins rendered perfectly — a warning nobody could act on.
    const reported = reportedSources();
    const watched = hookMap('GATEWAY_SOURCE_FOR_LAYER');
    for (const [layer, source] of watched) {
      assert.ok(
        reported.has(source),
        `the client watches for source "${source}" (layer ${layer}) but the route never pushes it`,
      );
    }
  });

  test('the source map covers all of TOGGLEABLE_LAYERS', () => {
    assert.deepEqual([...hookMap('GATEWAY_SOURCE_FOR_LAYER').keys()].sort(), [...TOGGLEABLE_LAYERS].sort());
  });
});
