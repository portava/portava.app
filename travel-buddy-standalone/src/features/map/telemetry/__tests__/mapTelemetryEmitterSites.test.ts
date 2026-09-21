/**
 * §35 emitter inventory — PER CALL SITE, not per total. (census-map M259–M274)
 *
 * ## Why this file exists next to `mapTelemetryCardinality.test.ts`
 *
 * That file asks a weaker question: "does every event have at least one
 * producer, and does anything with more than one carry a stated reason?" It is
 * satisfied by an event that grew from one call site to four, as long as the
 * event is already on its multi-site allow-list. Three of the six events on
 * that list would absorb a new duplicate producer in silence, and a duplicate
 * producer inflates a §35 metric by a factor nothing in the data reveals.
 *
 * census-map §42.2 re-counted every `emitMapEvent` call site in
 * `travel-buddy-standalone/src` and `travel-buddy-standalone/app` and anchored
 * them individually, row by row, "so the next re-count is a re-read rather than
 * a re-derivation". This file IS that re-read, executed. Each of M259–M274
 * asserts its own exact count AND the exact set of files those emits live in,
 * so:
 *
 *   * a new duplicate producer fails the count for its event;
 *   * an emit that MOVES to another surface fails the file set, because "two
 *     emits of `place_opened`" is a different fact from "two emits of
 *     `place_opened`, one of which is now in the trip planner";
 *   * an emit deleted in a refactor fails both.
 *
 * ## Files, not line numbers
 *
 * The census anchors carry line numbers; this does not. A line number is
 * correct for exactly as long as nobody edits the file above it, and a test
 * that reddens on an unrelated edit is a test people delete. The FILE is the
 * durable half of the anchor and it is the half that carries the meaning — it
 * names the surface the user touched.
 *
 * ## Anti-vacuity
 *
 * The scan is proved to be scanning something before any count is believed:
 * the file walk must find the app tree, and the total must be non-zero. A
 * broken glob otherwise makes every "expected 0, got 0" case pass.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAP_EVENT_NAMES, type MapEventName } from '../mapTelemetry.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dir, '../../../../..');

/** A single `emitMapEvent('name', …)` occurrence. */
interface Site {
  event: string;
  /** Repo-relative, POSIX-separated, so the expectations below read the same on any host. */
  file: string;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const skipDir = new Set(['node_modules', '__tests__', '__mocks__', '.expo', 'e2e']);
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (!skipDir.has(name)) walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(name)) continue;
      if (/\.test\.tsx?$/.test(name)) continue;
      // The emitter module declares every name; it is not a producer.
      if (full.endsWith(join('telemetry', 'mapTelemetry.ts'))) continue;
      out.push(full);
    }
  };
  walk(join(APP_ROOT, 'src'));
  walk(join(APP_ROOT, 'app'));
  return out;
}

function allSites(): Site[] {
  const sites: Site[] = [];
  for (const full of sourceFiles()) {
    const src = readFileSync(full, 'utf8');
    if (!src.includes('emitMapEvent')) continue;
    const rel = full.slice(APP_ROOT.length + 1).split(sep).join('/');
    for (const m of src.matchAll(/emitMapEvent\(\s*['"]([a-z_]+)['"]/g)) {
      sites.push({ event: m[1], file: rel });
    }
  }
  return sites;
}

const SITES = allSites();

function sitesFor(event: string): Site[] {
  return SITES.filter((s) => s.event === event);
}

/**
 * census-map §42.2, row by row: the requirement id, the §35 event, and the
 * exact file set its emits live in. A count is implied by the list's length —
 * stated as a list rather than a number precisely so a moved emit is caught.
 *
 * Every entry below was re-read off disk when this file was written and agrees
 * with the anchors on rows M259–M274.
 */
const CENSUS_42_2: ReadonlyArray<{
  row: string;
  event: MapEventName;
  files: readonly string[];
  note?: string;
}> = [
  {
    row: 'M259',
    event: 'map_opened',
    files: ['app/map/index.tsx'],
    note: 'mints the map session id; every later event inherits it',
  },
  {
    row: 'M260',
    event: 'zone_selected',
    files: [
      'src/components/map/LivePlaceSheet.tsx',
      'src/components/map/MapCarousel.tsx',
      'src/components/map/MapEntityPreviewCard.tsx',
    ],
  },
  {
    row: 'M261',
    event: 'place_opened',
    files: [
      'src/components/map/LivePlaceSheet.tsx',
      'src/components/map/MapCarousel.tsx',
      'src/components/map/MapEntityPreviewCard.tsx',
    ],
  },
  {
    row: 'M262',
    event: 'live_state_viewed',
    files: ['src/components/map/LivePlaceSheet.tsx', 'src/components/map/LivePlaceSheet.tsx'],
    note: 'ONE viewing emits twice from one file — on show and on close; `dwell` distinguishes them',
  },
  { row: 'M263', event: 'why_shown_opened', files: ['app/map/index.tsx'] },
  { row: 'M264', event: 'compass_requested', files: ['src/components/map/AskCompassBar.tsx'] },
  {
    row: 'M265',
    event: 'compass_option_selected',
    files: ['src/components/map/MapCarousel.tsx'],
  },
  {
    row: 'M266',
    event: 'route_started',
    files: ['src/components/map/LivePlaceSheet.tsx', 'src/components/map/MapEntityActionRow.tsx'],
    note: 'TWO, re-counted 2026-09-14; the row previously claimed three and the other occurrences are comments and the type declaration',
  },
  { row: 'M267', event: 'trip_stop_added', files: ['src/components/map/MapEntityActionRow.tsx'] },
  {
    row: 'M268',
    event: 'plan_joined',
    files: ['app/map/index.tsx', 'src/components/map/MapEntityActionRow.tsx'],
  },
  { row: 'M269', event: 'meet_here_created', files: ['app/map/index.tsx'] },
  { row: 'M270', event: 'crew_locate_started', files: ['app/map/index.tsx'] },
  { row: 'M271', event: 'contribution_submitted', files: ['app/map/index.tsx'] },
  { row: 'M272', event: 'alternative_requested', files: ['app/map/index.tsx'] },
  {
    row: 'M273',
    event: 'recommendation_accepted',
    files: [
      'src/components/map/LivePlaceSheet.tsx',
      'src/components/map/MapCarousel.tsx',
      'src/components/map/MapEntityActionRow.tsx',
    ],
  },
  {
    row: 'M274',
    event: 'recommendation_declined',
    files: ['src/components/map/AskCompassBar.tsx', 'src/components/map/LivePlaceSheet.tsx'],
  },
];

describe('the scan is scanning something (anti-vacuity)', () => {
  test('the app tree is in scope', () => {
    const files = sourceFiles();
    assert.ok(files.length > 200, `expected the app source tree, found ${files.length}`);
    assert.ok(
      files.some((f) => f.endsWith(join('app', 'map', 'index.tsx'))),
      'app/map/index.tsx must be in scope — six §35 events emit from it',
    );
  });

  test('emits were actually found', () => {
    // Without this, every `assert.equal(found, 0)` below would pass on a
    // regex that stopped matching.
    assert.ok(SITES.length > 20, `expected the §35 emitter set, found ${SITES.length}`);
  });
});

describe('§42.2 — each §35 event has exactly the call sites the census anchored', () => {
  for (const { row, event, files, note } of CENSUS_42_2) {
    test(`${row} ${event}: ${files.length} call site(s)${note ? ` — ${note}` : ''}`, () => {
      const found = sitesFor(event);
      assert.equal(
        found.length,
        files.length,
        `${event}: census §42.2 anchors ${files.length} call site(s), the tree has ${found.length}` +
          ` (${found.map((s) => s.file).join(', ') || 'none'}). A duplicate producer inflates this` +
          ` event's count by a factor no dashboard can see; a deleted one makes it read zero,` +
          ` which looks exactly like a feature nobody uses.`,
      );
      assert.deepEqual(
        found.map((s) => s.file).sort(),
        [...files].sort(),
        `${event}: the emits are in different files than the census anchored`,
      );
    });
  }

  test('every §35 event is covered by an entry above', () => {
    // §35's sixteen, minus the deliberate seventeenth (`meet_here_refused`,
    // migration 2222), which is beyond the spec and owned by no M-row here.
    const covered = new Set(CENSUS_42_2.map((e) => e.event));
    const uncovered = (MAP_EVENT_NAMES as readonly string[]).filter(
      (n) => n !== 'meet_here_refused' && !covered.has(n as MapEventName),
    );
    assert.deepEqual(uncovered, [], 'a §35 event with no per-call-site expectation');
  });

  test('no emit in the tree is outside the inventory', () => {
    // The mirror of the case above: an event emitted from somewhere nothing
    // here accounts for. `meet_here_refused` is allowed and named.
    const accounted = new Set(CENSUS_42_2.map((e) => e.event));
    accounted.add('meet_here_refused' as MapEventName);
    const stray = SITES.filter((s) => !accounted.has(s.event as MapEventName));
    assert.deepEqual(
      stray.map((s) => `${s.event} @ ${s.file}`),
      [],
      'an emit this inventory does not account for',
    );
  });
});

describe('the §35 total, stated so it cannot drift silently', () => {
  test('the per-row call sites sum to the number of §35 emits in the tree', () => {
    // Deliberately DERIVED from the per-row lists rather than written as a
    // literal. census-map §42.2's prose says "25 sites" while its own per-row
    // anchors sum to 26 §35 sites (plus one `meet_here_refused`, 27 emits in
    // all) — which is exactly why this suite asserts per call site and treats
    // the total as a consequence rather than as the requirement.
    const expected = CENSUS_42_2.reduce((n, e) => n + e.files.length, 0);
    const actual = SITES.filter((s) => s.event !== 'meet_here_refused').length;
    assert.equal(actual, expected);
  });
});
