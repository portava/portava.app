/**
 * M43 — the map SCREEN must hand the viewer's live position to the map CANVAS.
 *
 * `UserPositionMarker.component.test.tsx` proves the marker draws, and
 * `DiscoveryMapView.userPosition.component.test.tsx` proves the canvas mounts
 * it unconditionally — on an empty map, and alongside place pins. Neither
 * proves the screen GIVES the canvas a position. A canvas that would draw the
 * viewer, mounted by a screen that never tells it where the viewer is, draws
 * nothing, and both of those suites stay green.
 *
 * That hand-off is three facts about `app/map/index.tsx`, and this file pins
 * each of them:
 *
 *   1. the canvas the screen mounts IS `DiscoveryMapView` — the component the
 *      canvas suite tests, not a sibling with the same props;
 *   2. the position it passes is the device's live fix
 *      (`locationState.coords`), not the camera centre or a fallback city —
 *      a blue dot drawn at the place the map happens to be looking at would be
 *      worse than none;
 *   3. both coordinates are passed to that canvas element.
 *
 * ## Why this reads source text rather than rendering the screen
 *
 * The same reason `whyShownOpenedWiring.test.ts` gives: the element is one JSX
 * node on a 3000-line screen that can only be reached by mounting the whole
 * map. The property is a fact about the call site, so it is asserted at the
 * call site.
 *
 * ## Anti-vacuity
 *
 * The screen is first proved to mount a canvas at all, so a renamed or moved
 * screen fails loudly instead of passing on an empty search. The props are
 * read from INSIDE the canvas element's own opening tag, so a `userLat=` on
 * some other component (the carousel and the place sheet both take one) cannot
 * satisfy it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dir, '../../../..');
const MAP_SCREEN = resolve(APP_ROOT, 'app/map/index.tsx');

const src = readFileSync(MAP_SCREEN, 'utf8');

/** The opening tag of the canvas element: `<MapComponent … >`, attributes only. */
function canvasOpeningTag(): string {
  const start = src.indexOf('<MapComponent');
  assert.ok(start >= 0, 'app/map/index.tsx no longer mounts <MapComponent — this guard is pointed at the wrong file');
  // The tag ends at the first `/>` or `>` that closes it. Attribute values on
  // this element are simple `{identifier}` / `{a ?? b}` expressions, so the
  // first `/>` after the start is the end of this element.
  const end = src.indexOf('/>', start);
  assert.ok(end > start, 'could not find the end of the <MapComponent element');
  return src.slice(start, end);
}

describe('M43 — the map screen hands the viewer position to the canvas', () => {
  test('the canvas the screen mounts is DiscoveryMapView (anti-vacuity)', () => {
    assert.match(
      src,
      /require\(\s*['"][^'"]*components\/discovery\/DiscoveryMapView['"]\s*\)/,
      'the screen no longer loads DiscoveryMapView — the canvas suite is testing a component this screen does not mount',
    );
    assert.match(
      src,
      /const\s+MapComponent\s*=\s*DiscoveryMapView\b/,
      '<MapComponent> is no longer DiscoveryMapView',
    );
  });

  test('the position is the device live fix, not the camera or a fallback', () => {
    assert.match(
      src,
      /const\s+userLat\s*=\s*locationState\.coords\?\.lat\s*\?\?\s*null\s*;/,
      'userLat must come from the live location fix and be null without one',
    );
    assert.match(
      src,
      /const\s+userLng\s*=\s*locationState\.coords\?\.lng\s*\?\?\s*null\s*;/,
      'userLng must come from the live location fix and be null without one',
    );
  });

  test('both coordinates are passed to the canvas element itself', () => {
    const tag = canvasOpeningTag();
    assert.match(tag, /\buserLat=\{userLat\}/, 'the canvas is not given the viewer latitude');
    assert.match(tag, /\buserLng=\{userLng\}/, 'the canvas is not given the viewer longitude');
  });

  test('the canvas is not handed the fallback centre as the viewer position', () => {
    // The fallback centre is where the map LOOKS when it has nothing better.
    // Passing it as `userLat` would draw "you are here" on a city the viewer
    // may never have visited.
    const tag = canvasOpeningTag();
    assert.doesNotMatch(tag, /\buserLat=\{[^}]*fallback[^}]*\}/i);
    assert.doesNotMatch(tag, /\buserLat=\{[^}]*cameraCenter[^}]*\}/);
    assert.doesNotMatch(tag, /\buserLng=\{[^}]*fallback[^}]*\}/i);
    assert.doesNotMatch(tag, /\buserLng=\{[^}]*cameraCenter[^}]*\}/);
  });
});
