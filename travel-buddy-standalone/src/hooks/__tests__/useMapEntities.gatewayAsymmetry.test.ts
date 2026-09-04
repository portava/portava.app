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
import {
  DEFAULT_LAYER_CONTEXT,
  EMPTY_LAYER_PREFERENCES,
  kindsForLayer,
  resolveLayers,
  setLayerChoice,
  type LayerContext,
} from '../../features/map/layers/layerModel.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(__dir, '../../..', '..', 'artifacts/api-server/src/routes/mapProjection.ts');
const HOOK = resolve(__dir, '..', 'useMapEntities.ts');
const STORE = resolve(__dir, '../..', 'stores/mapStore.tsx');

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
function hookMap(name: string, minEntries = 2): Map<string, string> {
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
  assert.ok(
    out.size >= minEntries,
    `parsed only ${out.size} entries from ${name} — the parse broke`,
  );
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
};

describe('the client asks for every kind the gateway serves', () => {
  test('no server-served kind is silently unrequested', () => {
    const served = servedKinds();
    // The union of BOTH request maps. crowd_flow is requested from the optional
    // map rather than the toggle-keyed one, because it is a §16 layer and not a
    // legacy pin toggle — but a request is a request, and this guard must see
    // every one of them or it is back to comparing one side against itself.
    const requested = new Set([
      ...hookMap('GATEWAY_KIND_FOR_LAYER').values(),
      ...hookMap('GATEWAY_KIND_FOR_OPTIONAL_LAYER', 1).values(),
    ]);

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

/**
 * WHY `crowd_flow` IS STILL ALLOWLISTED, AND WHICH FIX IS THE ONLY ONE THAT WORKS
 * ==============================================================================
 * The obvious fix — add `crowd_flow` to `ToggleableEntityType` so it gets a
 * `GATEWAY_KIND_FOR_LAYER` entry like every other layer — is WRONG, and the
 * second-most obvious one — request the kind when §16's automatic relevance
 * turns the layer on — cannot start.
 *
 * §16 assigns Crowd Flow the `contextual` default. `TOGGLEABLE_LAYERS` has no
 * contextual state: every member is seeded ON (`mapStore`'s `enabledLayers`
 * default and `MapFilterSheet`'s `DEFAULT_ENABLED` are both
 * `[...TOGGLEABLE_LAYERS]`), so a member added there is requested on every map
 * load. That contradicts §16's own assignment and its governing rule, "Do not
 * turn every layer on simultaneously" — and it is the worst possible default
 * for a people-derived layer.
 *
 * Crowd Flow does not need that entry anyway: it is ALREADY a toggleable §16
 * layer in `layerModel`. The tests below pin the three facts that leave exactly
 * one viable trigger.
 */
describe('the §16 trigger that can request crowd_flow', () => {
  /** The context the map shell actually builds (app/map/index.tsx). */
  function shellContext(mode: LayerContext['mode']): LayerContext {
    // The shell spreads DEFAULT_LAYER_CONTEXT and overrides only mode, zoomBand
    // and tripActive — it never supplies `density`, so density is always the
    // default 'moderate' on that screen.
    return { ...DEFAULT_LAYER_CONTEXT, mode, zoomBand: 'city', tripActive: false };
  }

  test('the §16 layer already carries the kind — it is not the transport trap', () => {
    // "it is already a layer" would be worthless as a trigger if EVERY layer
    // carried a kind — so this pins that some do not. `transport` is the
    // contrast: a toggleable layer that carries nothing. M5 gave the Saved layer
    // the `saved_place` kind (§16 Saved), so `saved` now carries its own kind
    // just as crowd_flow does — it is no longer an empty layer; transport still
    // is. crowd_flow carrying `['crowd_flow']` is the fact this describe relies on.
    assert.deepEqual(kindsForLayer('crowd_flow'), ['crowd_flow']);
    assert.deepEqual(kindsForLayer('saved'), ['saved_place'], 'M5 §16 Saved carries saved_place');
    assert.deepEqual(kindsForLayer('transport'), [], 'guard assumption changed');
  });

  test('automatic relevance cannot trigger the request — both inputs are post-fetch', () => {
    // §16's contextual rule for crowd_flow has exactly two ways to say yes:
    // heavy density, or CROWD_FLOW mode. Neither is knowable before the fetch.
    //
    //   density — LayerContext calls it "as measured by the projection/
    //             aggregation layer", i.e. a property of the RESPONSE; and the
    //             shell never sets it, so it is permanently 'moderate' there.
    const auto = resolveLayers(EMPTY_LAYER_PREFERENCES, shellContext('LIVE')).crowd_flow;
    assert.equal(auto.visible, false);
    assert.equal(auto.source, 'context');

    //   mode   — CROWD_FLOW mode turns the layer on, but the mode is only
    //            REACHABLE once flows have already arrived (see below), so
    //            conditioning the request on it is a closed loop.
    const viaMode = resolveLayers(EMPTY_LAYER_PREFERENCES, shellContext('CROWD_FLOW')).crowd_flow;
    assert.equal(viaMode.visible, true);
    assert.equal(viaMode.source, 'context');
  });

  test('CROWD_FLOW mode is gated on flows having already arrived — the loop is real', () => {
    // Source-read for the same reason the route is read: mapStore is a .tsx
    // that pulls in React and cannot be imported from a node:test here.
    const src = readFileSync(STORE, 'utf8');
    assert.match(
      src,
      /CROWD_FLOW:\s*inputs\.crowdFlowObjectCount\s*>\s*0/,
      'the CROWD_FLOW capability is no longer presence-derived — re-check whether ' +
        'mode can now gate the gateway request without deadlocking',
    );
    // ...and the count it reads is taken from the very objects this hook fetches.
    assert.match(
      src,
      /crowdFlowObjectCount/,
      'mapStore no longer names crowdFlowObjectCount — the parse broke',
    );
  });

  test('an explicit user choice is the only non-circular trigger', () => {
    // §16: "The moment the user makes an explicit choice that choice is stored
    // and OUTRANKS the automatic resolution." It is evaluated BEFORE the
    // contextual rule, needs no response to exist first, and never fires for a
    // user who left the layer alone or switched it off — which is exactly the
    // consent property a people-derived layer needs.
    const on = resolveLayers(
      setLayerChoice(EMPTY_LAYER_PREFERENCES, 'crowd_flow', 'on'),
      shellContext('LIVE'),
    ).crowd_flow;
    assert.equal(on.visible, true);
    assert.equal(on.source, 'user', 'the user choice must outrank the contextual rule');

    const off = resolveLayers(
      setLayerChoice(EMPTY_LAYER_PREFERENCES, 'crowd_flow', 'off'),
      shellContext('CROWD_FLOW'),
    ).crowd_flow;
    assert.equal(off.visible, false, 'an explicit off must survive even CROWD_FLOW mode');
  });
});
