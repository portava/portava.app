/**
 * Telemetry cardinality audit — one producer path per event, no orphans.
 *
 * §35's events have become architectural contracts: the decision chain, the
 * outcome funnel and the §38 loop all depend on them. Three failure modes are
 * invisible without a guard, because each of them looks like healthy data:
 *
 *  1. AN ORPHAN EVENT. Declared in the contract, emitted nowhere. Its metric
 *     reads zero forever, which is indistinguishable from a feature nobody
 *     uses — so nobody investigates.
 *  2. A DUPLICATED PRODUCER. Two call sites emitting one event means every
 *     count is inflated by an unknown factor, and no dashboard can tell.
 *  3. AN UNVERSIONED CONTRACT. A payload change is silently averaged in with
 *     rows written under the previous shape.
 *
 * This reads the SOURCE rather than the types: a type can be declared and never
 * used, which is precisely the orphan case.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAP_EVENT_NAMES,
  MAP_TELEMETRY_SCHEMA_VERSION,
  type MapEventName,
} from '../mapTelemetry.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dir, '../../../../..');

/** Every source file that could contain an emit, excluding tests and the emitter. */
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
      // The emitter itself declares every name; it is not a producer.
      if (full.endsWith(join('telemetry', 'mapTelemetry.ts'))) continue;
      out.push(full);
    }
  };
  walk(join(APP_ROOT, 'src'));
  walk(join(APP_ROOT, 'app'));
  return out;
}

/** file -> the event names it emits, one entry per emitMapEvent call site. */
function producers(): Map<MapEventName, string[]> {
  const found = new Map<MapEventName, string[]>();
  for (const name of MAP_EVENT_NAMES) found.set(name, []);

  for (const file of sourceFiles()) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('emitMapEvent')) continue;
    // emitMapEvent('name', ... — the only supported emit form.
    for (const m of src.matchAll(/emitMapEvent\(\s*['"]([a-z_]+)['"]/g)) {
      const name = m[1] as MapEventName;
      const list = found.get(name);
      if (list) list.push(file.slice(APP_ROOT.length + 1));
    }
  }
  return found;
}

describe('every event has a producer', () => {
  test('the scan finds source files at all (the guard is not scanning nothing)', () => {
    const files = sourceFiles();
    assert.ok(files.length > 200, `expected the app source tree, found ${files.length}`);
    assert.ok(
      files.some((f) => f.includes(join('app', 'map'))),
      'the map screen must be in scope — it is the busiest producer',
    );
  });

  test('no event is declared but never emitted', () => {
    const p = producers();
    const orphans = [...p.entries()].filter(([, sites]) => sites.length === 0).map(([n]) => n);
    assert.deepEqual(
      orphans,
      [],
      'an orphan event reads zero forever, which looks exactly like a feature nobody uses',
    );
  });

  test('every emitted name is a declared one — no ad-hoc events', () => {
    const declared = new Set<string>(MAP_EVENT_NAMES);
    const stray: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('emitMapEvent')) continue;
      for (const m of src.matchAll(/emitMapEvent\(\s*['"]([a-z_]+)['"]/g)) {
        if (!declared.has(m[1])) stray.push(`${file.slice(APP_ROOT.length + 1)}: ${m[1]}`);
      }
    }
    assert.deepEqual(stray, [], 'an undeclared event name would be dropped by the server');
  });
});

describe('producer cardinality', () => {
  /**
   * Events that legitimately have more than one call site, each with the reason.
   * Anything not listed here must have exactly one — otherwise its counts are
   * inflated by an unknown factor and no dashboard can tell.
   */
  const MULTI_SITE_ALLOWED: Partial<Record<MapEventName, string>> = {
    place_opened:
      'three genuinely different surfaces open a place — carousel, preview card and the Live Place sheet — and `source` distinguishes them',
    zone_selected:
      'the same three surfaces can select a zone-shaped object; `source` distinguishes them',
    recommendation_accepted:
      'acceptance is emitted alongside the concrete action, and `via` names which one',
    recommendation_declined:
      'a decision can be abandoned from the Compass bar or by dismissing the Live Place sheet',
    route_started:
      'navigation starts from both the action row and the Live Place sheet',
    live_state_viewed:
      'ONE viewing emits TWICE — on show (carrying the §7 axes) and on close (carrying dwell). Emitting only on close would lose the view entirely if the app is killed. ANALYSIS MUST FILTER: rows WITH `dwell` are closes, rows WITHOUT are shows; counting both doubles the metric.',
  };

  test('every event has exactly one producer, or a stated reason for more', () => {
    const p = producers();
    const problems: string[] = [];
    for (const [name, sites] of p) {
      if (sites.length <= 1) continue;
      if (MULTI_SITE_ALLOWED[name]) continue;
      problems.push(`${name}: ${sites.length} call sites -> ${sites.join(', ')}`);
    }
    assert.deepEqual(problems, [], 'duplicate producers inflate counts invisibly');
  });

  test('the allow-list has no stale entries', () => {
    // An allow-list that outlives its reason quietly permits a real duplicate.
    const p = producers();
    const stale = Object.keys(MULTI_SITE_ALLOWED).filter(
      (n) => (p.get(n as MapEventName)?.length ?? 0) <= 1,
    );
    assert.deepEqual(stale, [], 'these no longer have multiple producers — drop the exemption');
  });

  test('every allow-list entry carries a reason, not just a name', () => {
    for (const [name, reason] of Object.entries(MULTI_SITE_ALLOWED)) {
      assert.ok(
        typeof reason === 'string' && reason.length > 30,
        `${name} is exempted without a stated reason`,
      );
    }
  });
});

describe('live_state_viewed — the two emissions are distinguishable', () => {
  // The exemption above is only safe if the two emissions can actually be told
  // apart in the data. That distinguishing field is `dwell`, so it is pinned
  // here rather than left to a comment.
  test('the show emit carries no dwell and the close emit does', () => {
    const src = readFileSync(
      resolve(APP_ROOT, 'src', 'components', 'map', 'LivePlaceSheet.tsx'),
      'utf8',
    );
    const emits = [...src.matchAll(/emitMapEvent\(\s*'live_state_viewed',\s*\{([\s\S]*?)\}\s*\);/g)]
      .map((m) => m[1]);
    assert.equal(emits.length, 2, 'expected exactly the show and close emissions');
    const withDwell = emits.filter((body) => body.includes('dwell:'));
    assert.equal(
      withDwell.length,
      1,
      'exactly one of the two must carry dwell, or the emissions are indistinguishable in the data',
    );
  });
});

describe('the contract is versioned', () => {
  test('a schema version exists and is a real version string', () => {
    assert.match(
      MAP_TELEMETRY_SCHEMA_VERSION,
      /^\d+\.\d+$/,
      'these payloads are contracts; an unversioned contract cannot have a deliberate breaking change',
    );
  });

  test('the version is sent on every batch', () => {
    const src = readFileSync(join(__dir, '..', 'mapTelemetry.ts'), 'utf8');
    assert.match(
      src,
      /schemaVersion:\s*MAP_TELEMETRY_SCHEMA_VERSION/,
      'the batch meta must carry the version, or the server cannot record which contract wrote a row',
    );
  });

  test('the server persists it rather than dropping it', () => {
    const route = resolve(
      APP_ROOT,
      '..',
      'artifacts',
      'api-server',
      'src',
      'routes',
      'mapTelemetry.ts',
    );
    const src = readFileSync(route, 'utf8');
    assert.match(
      src,
      /schema_version:/,
      'a stored row that cannot say which contract produced it makes a breaking change indistinguishable from a bug',
    );
  });
});
