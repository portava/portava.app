/**
 * §33 FILTERS — the overlay the machine declared and nothing ever opened.
 *
 * WHAT WAS WRONG (census-map M226, BUILT-BUT-WRONG)
 * ================================================
 * `MAP_OVERLAYS` has declared `'FILTERS'` since the machine was written, and
 * the reducer covers it: OPEN_OVERLAY admits it, D1 mutual exclusion applies to
 * it, CLOSE_OVERLAY closes it, `resolveBack` consumes a back press for it. All
 * of that was reachable only from the reducer's own tests. A repo-wide search
 * for `overlay: 'FILTERS'` outside tests returned nothing: the actual filter
 * sheet was driven by a plain `useState` in `app/map/index.tsx`
 * (`filterSheetOpen`), and the floating control whose accessibility label reads
 * "Open filters" dispatched `'LAYERS'`. A dead state in the machine and a sheet
 * outside it.
 *
 * The consequence was not cosmetic. Every other overlay obeys D1 — opening one
 * closes the rest — and resolves hardware back through `resolveBack`. A sheet
 * held in component state does neither: it could sit open UNDERNEATH the layers
 * or search sheet, and back would leave the screen with it still up.
 *
 * WHAT THIS FILE CHECKS, AND WHICH HALF IS LOAD-BEARING
 * ====================================================
 * Two halves, stated separately because they are not equally strong:
 *
 *   1. The REDUCER half was already correct and passed before this change. It
 *      is kept because it is the thing being claimed — that FILTERS is a
 *      first-class overlay, not a special case — and because it is the positive
 *      control for half 2: if these fail, the scan below is asserting against a
 *      state the machine does not really support.
 *
 *   2. The WIRING half is the regression. `app/map/index.tsx` is a screen this
 *      runner cannot render (it pulls MapLibre), so it is read as source, in
 *      the same way `src/components/map/lazyMapTyping.test.ts` reads it. A
 *      source scan is weaker than a render, and it is named as such here rather
 *      than dressed up: what it can prove is that the bypass is gone and the
 *      machine is the sheet's only owner, which is exactly what regressed.
 *
 * Run: node --import tsx --test src/features/map/state/__tests__/filtersOverlay.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAP_OVERLAYS,
  createInitialMapMachineState,
  mapMachineReducer,
  resolveBack,
} from '../mapMachine.ts';

// ── 1. the reducer half (a positive control, green before this change) ───────

describe('FILTERS is a first-class overlay in the machine', () => {
  test('it is declared', () => {
    assert.ok((MAP_OVERLAYS as readonly string[]).includes('FILTERS'));
  });

  test('OPEN_OVERLAY opens it', () => {
    const s = mapMachineReducer(createInitialMapMachineState(), { type: 'OPEN_OVERLAY', overlay: 'FILTERS' });
    assert.deepEqual(s.overlays, ['FILTERS']);
  });

  test('D1: opening FILTERS closes whatever else was open', () => {
    let s = mapMachineReducer(createInitialMapMachineState(), { type: 'OPEN_OVERLAY', overlay: 'LAYERS' });
    s = mapMachineReducer(s, { type: 'OPEN_OVERLAY', overlay: 'FILTERS' });
    assert.deepEqual(s.overlays, ['FILTERS'], 'two sheets were open at once');
  });

  test('D1 the other way: opening LAYERS closes FILTERS', () => {
    let s = mapMachineReducer(createInitialMapMachineState(), { type: 'OPEN_OVERLAY', overlay: 'FILTERS' });
    s = mapMachineReducer(s, { type: 'OPEN_OVERLAY', overlay: 'LAYERS' });
    assert.deepEqual(s.overlays, ['LAYERS']);
  });

  test('CLOSE_OVERLAY closes it, and only when it is the one open', () => {
    let s = mapMachineReducer(createInitialMapMachineState(), { type: 'OPEN_OVERLAY', overlay: 'FILTERS' });
    const untouched = mapMachineReducer(s, { type: 'CLOSE_OVERLAY', overlay: 'SEARCH' });
    assert.deepEqual(untouched.overlays, ['FILTERS'], 'closing SEARCH closed FILTERS');
    s = mapMachineReducer(s, { type: 'CLOSE_OVERLAY', overlay: 'FILTERS' });
    assert.deepEqual(s.overlays, []);
  });

  test('hardware back consumes the press instead of leaving the screen', () => {
    const s = mapMachineReducer(createInitialMapMachineState(), { type: 'OPEN_OVERLAY', overlay: 'FILTERS' });
    const back = resolveBack(s);
    assert.equal(back.handled, true, 'back would have left the screen with the sheet up');
    assert.deepEqual(back.state.overlays, []);
  });
});

// ── 2. the wiring half (the regression) ──────────────────────────────────────

const MAP_SCREEN_REL = 'app/map/index.tsx';

function locateMapScreen(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, MAP_SCREEN_REL);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // A FAILURE, never a skip: a skip here restores exactly the property this
  // test exists to remove — a check that reports success having verified
  // nothing.
  throw new Error(`Could not find ${MAP_SCREEN_REL} above ${fileURLToPath(import.meta.url)}.`);
}

const screen = readFileSync(locateMapScreen(), 'utf8');

describe('the map screen enters the FILTERS state it declares', () => {
  test('the scan is not vacuous — this really is the map screen', () => {
    assert.match(screen, /<MapFilterSheet/, 'MapFilterSheet is gone; update this guard to match');
    assert.match(screen, /dispatchMapEvent\(/, 'the screen no longer dispatches machine events at all');
  });

  test('something outside the machine tests opens FILTERS', () => {
    assert.match(
      screen,
      /OPEN_OVERLAY',\s*overlay:\s*'FILTERS'/,
      "nothing in the screen dispatches OPEN_OVERLAY FILTERS — the declared state is dead again",
    );
  });

  test('the filter sheet reads its visibility from the machine', () => {
    assert.match(
      screen,
      /<MapFilterSheet[\s\S]{0,400}?visible=\{overlayOpen\('FILTERS'\)\}/,
      'MapFilterSheet is visible from something other than the machine',
    );
  });

  test('the bypassing useState is gone — the machine is the only owner', () => {
    // The exact defect: a second source of truth for whether the sheet is up.
    // While it exists, D1 and back-handling are advisory.
    assert.doesNotMatch(
      screen,
      /filterSheetOpen/,
      'app/map/index.tsx still holds the filter sheet in component state',
    );
  });

  test('the control labelled "Open filters" no longer opens the LAYERS sheet', () => {
    const line = screen.split('\n').find((l) => l.includes('onFiltersPress='));
    assert.ok(line, 'no onFiltersPress handler found in the screen');
    assert.doesNotMatch(line, /'LAYERS'/, 'the filters control dispatches LAYERS again');
  });

  test('LAYERS keeps its own entry point — this did not steal the layers sheet', () => {
    // The header has a dedicated layers button. Repointing the filters control
    // would be a fix that broke §16 instead, so this pins that it still exists.
    assert.match(
      screen,
      /onLayersPress=\{\(\) => dispatchMapEvent\(\{ type: 'OPEN_OVERLAY', overlay: 'LAYERS' \}\)\}/,
      'the layers sheet lost its entry point',
    );
    assert.match(screen, /visible=\{overlayOpen\('LAYERS'\)\}/);
  });
});
