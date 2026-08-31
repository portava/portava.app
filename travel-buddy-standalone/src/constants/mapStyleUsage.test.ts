/**
 * Every MapLibre surface uses the SHARED style and can recover from a failure.
 *
 * ## The defect
 *
 * constants/mapStyle.ts documents, in its own header, that
 * EXPO_PUBLIC_MAPTILER_KEY returns HTTP 403 on MapTiler's /styles endpoint even
 * when valid for its other APIs, and that this is why the shared module returns
 * OpenFreeMap Liberty unconditionally. It also states that "the
 * onDidFailLoadingMap handlers on each Map instance remain as a safety net".
 *
 * Two components carried their own copy of the rejected MapTiler URL instead —
 * DiscoveryMapView (which app/map/index.tsx renders, so the FLAGSHIP map) and
 * CompassMiniMap. Both pinned `maps/streets`, the v1 id, where the shared
 * module's own re-enable instructions specify `streets-v2`. Neither had the
 * onDidFailLoadingMap handler the header assumes. So on a 403 they did not fall
 * back to Liberty; they fell back to their own hardcoded else-branch,
 * demotiles.maplibre.org — a grey country-outline debug basemap with no
 * streets. That is what "the map looks broken" was.
 *
 * ## Why a source scan rather than a render test
 *
 * The property is "no surface diverges from the shared decision", which is a
 * property of the FILE SET, not of any one component — a render test of the two
 * components fixed today would pass forever while a third copy appeared
 * elsewhere. This is the same reasoning as the raw-error-copy guard.
 *
 * Run: node --import tsx/esm --test src/constants/mapStyleUsage.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOTS = ['src', 'app'];

/**
 * A component that renders a MapLibre map.
 *
 * The negative lookahead matters: `<Map\b` alone also matches the GENERIC type
 * `Array<Map<string, X>>`, which pulled eight hooks and services with no map in
 * them into the first draft of this scan. A JSX element is followed by
 * whitespace, `/` or `>`; a generic is followed by `<`.
 */
const RENDERS_MAP = /<Map(View)?[\s/>]/;

/**
 * The only reliable signal that a file renders a REAL map: it imports MapLibre.
 *
 * `<Map ` alone is ambiguous in this codebase — lucide-react-native exports an
 * icon called `Map`, so `<Map size={13} />` appears in screens with no map at
 * all (ai.tsx, event/[id].tsx, profile/edit/index.tsx, rent-a-buddy admin).
 * Requiring the import removes them without an allowlist of false positives.
 */
const IMPORTS_MAPLIBRE = /@maplibre\/maplibre-react-native/;

/**
 * Strip a trailing line comment WITHOUT eating URLs.
 *
 * The first version of this used `line.split('//')[0]`, which is wrong in a way
 * that made the whole check vacuous: `https://` contains `//`, so every URL was
 * truncated to `https:` before the pattern ever saw it. The guard could not
 * have detected a hardcoded style at all, and passed for that reason rather
 * than because the codebase was clean — caught by a mutation that restored the
 * real bug and stayed green.
 *
 * The negative lookbehind on `:` is the whole fix: a comment marker is `//` not
 * preceded by a colon.
 */
function stripLineComment(line: string): string {
  return line.replace(/(^|[^:])\/\/.*$/, '$1');
}

/**
 * A hardcoded MAP STYLE URL — the thing that must live in one place only.
 *
 * Deliberately narrower than "any api.maptiler.com URL". The 403 documented in
 * constants/mapStyle.ts is specific to the /styles endpoint; that header states
 * the same key stays valid for MapTiler's other APIs, and the codebase relies
 * on it — RouteItPlaceSheet.tsx:104 builds a static map IMAGE and
 * app/(tabs)/discovery.tsx:632 calls geocoding. Flagging those would make this
 * guard fire on working code, and a guard that fires on the wrong thing is one
 * somebody silences.
 */
const HARDCODED_STYLE =
  /https:\/\/api\.maptiler\.com\/maps\/[^'"`\s]*style\.json|https:\/\/demotiles\.maplibre\.org\/style\.json|https:\/\/tiles\.openfreemap\.org\/styles/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(r));

describe('the shared style module is the only place a style URL is written', () => {
  it('has files to scan — the guard must not pass vacuously', () => {
    assert.ok(FILES.length > 200, `expected the app tree, found ${FILES.length}`);
    assert.ok(
      FILES.some((f) => f.endsWith('components/discovery/DiscoveryMapView.tsx')),
      'the flagship map component must be in scope',
    );
  });

  it('no component hardcodes a provider style URL', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file.endsWith('constants/mapStyle.ts')) continue; // the one place it belongs
      const src = readFileSync(resolve(file), 'utf8');
      src.split('\n').forEach((line, i) => {
        const code = stripLineComment(line);
        if (HARDCODED_STYLE.test(code)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `style URLs must come from constants/mapStyle.ts, not be rewritten:\n${offenders.join('\n')}`,
    );
  });

  /**
   * Map surfaces that still lack onDidFailLoadingMap.
   *
   * ONE reason covers the whole list: they pre-date this fix and are outside
   * the scope it was given, which was the two components carrying a DIVERGENT
   * style URL (DiscoveryMapView and CompassMiniMap). Every entry here uses the
   * shared style — the first assertion proves no file rebuilds a provider URL —
   * so none of them can hit the 403 path that made the flagship map render a
   * debug basemap. What they lack is the recovery net for a FUTURE style-load
   * failure, which is a smaller and separate problem.
   *
   * The list is here rather than absent so it is visible and finite. The test
   * below asserts it cannot GROW: a new map surface must ship with a handler.
   */
  const KNOWN_MISSING_HANDLER = [
    'src/components/SavedPlacesMapView.tsx',
    'src/components/circle/CircleMapSection.tsx',
    'src/components/discovery/GemMapPreview.tsx',
    'src/components/gems/GemLocationPreview.tsx',
    'src/components/location/MapLocationPicker.tsx',
    'src/components/location/MeetupAreaPreview.tsx',
    'src/components/map/EntityMarkers.tsx',
    'src/components/passport/DestinationsTab.tsx',
    'src/components/trip/LocationCheckMapPicker.tsx',
  ];

  it('no NEW map surface ships without a failure handler', () => {
    const missing: string[] = [];
    for (const file of FILES) {
      if (!file.endsWith('.tsx')) continue; // components only
      const src = readFileSync(resolve(file), 'utf8');
      if (!IMPORTS_MAPLIBRE.test(src) || !RENDERS_MAP.test(src)) continue;
      if (!/onDidFailLoadingMap/.test(src)) missing.push(file);
    }
    const unexpected = missing.filter((f) => !KNOWN_MISSING_HANDLER.includes(f));
    assert.deepEqual(
      unexpected,
      [],
      'a new map surface must ship with onDidFailLoadingMap — the shared style ' +
        'module names these handlers as its safety net:\n' + unexpected.join('\n'),
    );
  });

  it('the known-missing list is accurate — no stale entries', () => {
    // A file that gained a handler must leave the list, or the list slowly
    // becomes a record of what used to be true rather than what is.
    const stale = KNOWN_MISSING_HANDLER.filter((f) => {
      const src = readFileSync(resolve(f), 'utf8');
      // Two ways an entry goes stale: it gained a handler, or it stopped being
      // a map surface at all. Both mean the list no longer describes reality.
      const stillAMapSurface = IMPORTS_MAPLIBRE.test(src) && RENDERS_MAP.test(src);
      return /onDidFailLoadingMap/.test(src) || !stillAMapSurface;
    });
    assert.deepEqual(
      stale,
      [],
      'these entries no longer describe reality — they gained a handler or stopped ' +
        `rendering a map:\n${stale.join('\n')}`,
    );
  });

  it('the two previously-divergent components are covered by the scan', () => {
    // Named explicitly so a future refactor that moves or renames them cannot
    // silently drop them out of the file set the assertions above walk.
    for (const f of [
      'src/components/discovery/DiscoveryMapView.tsx',
      'src/components/compass/CompassMiniMap.tsx',
    ]) {
      const src = readFileSync(resolve(f), 'utf8');
      assert.match(src, /from '.*constants\/mapStyle\.ts'/, `${f} must import the shared style`);
      assert.match(src, /onDidFailLoadingMap/, `${f} must handle a style-load failure`);
      const codeOnly = src.split('\n').map(stripLineComment).join('\n');
      assert.doesNotMatch(codeOnly, /api\.maptiler\.com/, `${f} must not rebuild a MapTiler URL`);
    }
  });

  it('the Map Shell keeps a DARK basemap through its whole failure ladder', () => {
    // §4 is dark-mode-first. Dropping straight from the dark style to demotiles
    // puts a LIGHT grey basemap under dark chrome, which reads as a broken
    // screen rather than a degraded one — so the ladder must pass through the
    // verified keyless dark URL first. Pinning it here stops a future refactor
    // from quietly collapsing the ladder back to one step.
    const src = readFileSync(resolve('src/components/discovery/DiscoveryMapView.tsx'), 'utf8');
    assert.match(
      src,
      /useState<string \| StyleSpecification>\(PORTAVA_DARK_MAP_STYLE\)/,
      'the Map Shell must start on the Portava dark style object',
    );
    assert.match(
      src,
      /setMapStyle\(DARK_MAP_STYLE_URL\)/,
      'the first fallback must still be dark',
    );
  });

  it('the failure handler swaps to the fallback and cannot loop', () => {
    for (const f of [
      'src/components/discovery/DiscoveryMapView.tsx',
      'src/components/compass/CompassMiniMap.tsx',
    ]) {
      const src = readFileSync(resolve(f), 'utf8');
      assert.match(
        src,
        /if \(mapStyle !== FALLBACK_MAP_STYLE_URL\) setMapStyle\(FALLBACK_MAP_STYLE_URL\)/,
        `${f}: the guard stops a failing fallback from re-triggering itself forever`,
      );
    }
  });
});
