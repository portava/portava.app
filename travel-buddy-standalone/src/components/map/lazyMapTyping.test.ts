/**
 * The lazily-required map component must be typed by its real props.
 *
 * ## Why this file exists
 *
 * app/map/index.tsx cannot import DiscoveryMapView normally: DiscoveryMapView
 * pulls MapLibre, which crashes on web, so it is loaded through a guarded
 * `require` behind `Platform.OS !== 'web'`. That require has no type of its own,
 * so whatever annotation sits on the binding IS the type-check for every prop
 * the JSX below passes.
 *
 * It was annotated `React.ComponentType<any>`. `any` accepts every prop, so
 * when DiscoveryMapViewProps failed to declare entities, enabledEntityLayers,
 * onSelectEntity and filterRowOffset, all four were passed, silently dropped by
 * React, and TypeScript reported nothing. Every entity layer — buddies, events,
 * gems, trips, friends, passport stamps — rendered carousel cards and no pins,
 * and EntityMarkers.tsx sat at 389 lines with zero non-test importers.
 *
 * A test of the props themselves cannot catch a recurrence: re-annotating this
 * binding as `any` would restore the hole while every render test stayed green,
 * because the failure mode is the absence of a compile error, not a wrong
 * value. That is what this scan checks.
 *
 * `import type` is erased at compile time and emits no require, which is why
 * naming the props type here does not pull MapLibre into the web bundle. There
 * is no trade-off to reintroduce.
 *
 * Run: node --import tsx/esm --test src/components/map/lazyMapTyping.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAP_SCREEN = 'app/map/index.tsx';

function read(file: string): string {
  return readFileSync(resolve(file), 'utf8');
}

describe('app/map/index.tsx types its lazy map component', () => {
  it('the file still lazily requires DiscoveryMapView — the scan is not vacuous', () => {
    const src = read(MAP_SCREEN);
    assert.match(
      src,
      /let DiscoveryMapView:/,
      'the lazy binding was renamed or removed; update this guard to match',
    );
    assert.match(
      src,
      /Platform\.OS !== 'web'/,
      'the web guard is what forces the require, and the require is what needs the annotation',
    );
  });

  it('does not annotate the lazy map component as ComponentType<any>', () => {
    const src = read(MAP_SCREEN);
    const line = src
      .split('\n')
      .find((l) => /let DiscoveryMapView:/.test(l));
    assert.ok(line, 'lazy binding declaration not found');
    assert.doesNotMatch(
      line,
      /ComponentType<\s*any\s*>/,
      'ComponentType<any> accepts every prop, so a prop the component does not ' +
        'declare is dropped at runtime with no compile error — the entity-layer bug. ' +
        'Annotate with DiscoveryMapViewProps instead.',
    );
    assert.match(
      line,
      /ComponentType<\s*DiscoveryMapViewProps\s*>/,
      'the binding must be typed by the component\'s real props type',
    );
  });

  it('imports the props type as a type-only import so web stays MapLibre-free', () => {
    const src = read(MAP_SCREEN);
    // `import type` is the whole reason this can be typed at all. A plain value
    // import of the same name would emit a require and reintroduce the web
    // crash the Platform guard exists to prevent.
    assert.match(
      src,
      /import type \{[^}]*DiscoveryMapViewProps[^}]*\} from/,
      'DiscoveryMapViewProps must be imported with `import type`, not as a value',
    );
  });

  it('does not cast the require result back to any', () => {
    const src = read(MAP_SCREEN);
    // Typing the binding is pointless if the assignment launders the value
    // through `as any` — the props check would be skipped just the same.
    const requireBlock = src.slice(
      src.indexOf('let DiscoveryMapView:'),
      src.indexOf('// ── Passport helpers'),
    );
    assert.doesNotMatch(
      requireBlock,
      /\bas any\b/,
      'an `as any` on the require result defeats the annotation above it',
    );
  });
});

describe('DiscoveryMapView declares the props the map screen passes', () => {
  /**
   * The four props the screen passes that the interface used to omit.
   *
   * Listed literally rather than parsed out of the JSX: the point is that these
   * exact four were dropped, and a parser that derived them from the call site
   * would derive nothing if the call site regressed too.
   */
  const REQUIRED = ['entities', 'enabledEntityLayers', 'onSelectEntity', 'filterRowOffset'];

  it('every prop the map screen passes is declared in DiscoveryMapViewProps', () => {
    const props = read('src/components/discovery/DiscoveryMapView.tsx');
    const iface = props.slice(
      props.indexOf('export interface DiscoveryMapViewProps'),
      props.indexOf('// ── Category pin colours'),
    );
    assert.ok(iface.length > 0, 'DiscoveryMapViewProps interface not found');

    const missing = REQUIRED.filter((p) => !new RegExp(`^\\s*${p}\\??:`, 'm').test(iface));
    assert.deepEqual(
      missing,
      [],
      `app/map/index.tsx passes these; an undeclared prop is dropped silently:\n${missing.join('\n')}`,
    );
  });

  it('the component destructures them — declaring is not receiving', () => {
    // The interface and the destructure are separate failure points. A prop can
    // be declared and still never read, which renders exactly as the bug did.
    const props = read('src/components/discovery/DiscoveryMapView.tsx');
    const signature = props.slice(
      props.indexOf('export function DiscoveryMapView({'),
      props.indexOf('}: DiscoveryMapViewProps)'),
    );
    const missing = REQUIRED.filter((p) => !new RegExp(`\\b${p}\\b`).test(signature));
    assert.deepEqual(missing, [], `declared but never destructured:\n${missing.join('\n')}`);
  });

  it('EntityMapLayers is actually rendered — the layer has a real importer', () => {
    // EntityMarkers.tsx had zero non-test importers while the bug was live.
    // This asserts the production import exists, so the 389 lines are reachable.
    const props = read('src/components/discovery/DiscoveryMapView.tsx');
    assert.match(props, /import \{ EntityMapLayers \} from '\.\.\/map\/EntityMarkers\.tsx'/);
    assert.match(props, /<EntityMapLayers/);
  });
});
