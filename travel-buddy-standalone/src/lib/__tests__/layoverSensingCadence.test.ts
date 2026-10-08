/**
 * layoverSensingCadence — census §16 L157 and §17.1 L164, the CLIENT half.
 *
 * ── WHAT THE CENSUS SAYS, AND WHAT IS ACTUALLY WRONG ─────────────────────────
 * L157 ("adaptive sensing: low frequency when safe/stationary, moderate near
 * decision boundaries, navigation-appropriate during RETURNING; avoid
 * continuous GPS") reads `N`, with this evidence: *"The layover surface
 * performs no location sensing at all … The only cadence is a fixed 60-second
 * overview refetch and a 30-second local clock, neither state-dependent."*
 *
 * Both halves of that are re-measured and TRUE at this commit. The prohibition
 * half — avoid continuous GPS — holds by absence, and the last case in this
 * file is what stops that absence being silently reversed (which is also all
 * L164 asks of this surface: location is requested when a traveller enables
 * something that needs it, never merely because Layover exists).
 *
 * The ADAPTIVE half was a real client gap and is what the module closes: the
 * one periodic loop this surface does have re-read the server every 60 seconds
 * whether the traveller had four hours or four minutes.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Every rung is asserted against a NEIGHBOUR, so a policy that answered one
 * constant everywhere fails. `NORMAL` is pinned at exactly the 60 s this screen
 * has always used: this change tightens the cadence as the deadline approaches
 * and must not loosen or quicken the case that was already shipping.
 *
 * And the rule that keeps this honest: the cadence is a function of the
 * CERTIFIED return state alone. It never re-derives the rung from a clock — a
 * second escalation rule on the client is the §13/L115 defect in a new place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  LAYOVER_REFRESH_INTERVAL_MS,
  layoverSensingCadence,
} from '../layoverSensingCadence.ts';

test('a session that is not active polls NOTHING', () => {
  const c = layoverSensingCadence({ sessionStatus: 'completed', returnState: 'RETURN_NOW' });
  assert.equal(c.cadence, 'idle');
  assert.equal(c.intervalMs, null);
  // Even at the sharpest rung: an ended layover has nothing left to re-read.
  const cancelled = layoverSensingCadence({ sessionStatus: 'cancelled', returnState: 'NORMAL' });
  assert.equal(cancelled.intervalMs, null);
});

test('NORMAL keeps the 60 s this screen has always used', () => {
  const c = layoverSensingCadence({ sessionStatus: 'active', returnState: 'NORMAL' });
  assert.equal(c.cadence, 'low');
  assert.equal(c.intervalMs, 60_000);
  assert.equal(c.intervalMs, LAYOVER_REFRESH_INTERVAL_MS.low);
});

test('RETURN_SOON is moderate — faster than NORMAL, slower than returning', () => {
  const soon = layoverSensingCadence({ sessionStatus: 'active', returnState: 'RETURN_SOON' });
  const normal = layoverSensingCadence({ sessionStatus: 'active', returnState: 'NORMAL' });
  const now = layoverSensingCadence({ sessionStatus: 'active', returnState: 'RETURN_NOW' });
  assert.equal(soon.cadence, 'moderate');
  assert.ok(soon.intervalMs! < normal.intervalMs!);
  assert.ok(soon.intervalMs! > now.intervalMs!);
});

test('RETURN_NOW and CONNECTION_AT_RISK are the sharpest rung, and are equal', () => {
  const now = layoverSensingCadence({ sessionStatus: 'active', returnState: 'RETURN_NOW' });
  const risk = layoverSensingCadence({ sessionStatus: 'active', returnState: 'CONNECTION_AT_RISK' });
  assert.equal(now.cadence, 'returning');
  assert.equal(risk.cadence, 'returning');
  assert.equal(now.intervalMs, risk.intervalMs);
  assert.equal(now.intervalMs, LAYOVER_REFRESH_INTERVAL_MS.returning);
});

test('an absent or unrecognised return state falls back to the shipping cadence', () => {
  // A server that states no rung does not get one invented for it, and the
  // screen must not go quiet: it keeps the 60 s it always had.
  for (const state of [null, undefined, 'SOMETHING_NEW' as never]) {
    const c = layoverSensingCadence({ sessionStatus: 'active', returnState: state });
    assert.equal(c.intervalMs, 60_000, `state ${String(state)} changed the default`);
    assert.equal(c.cadence, 'low');
  }
});

test('no cadence ever permits continuous location sensing', () => {
  for (const state of ['NORMAL', 'RETURN_SOON', 'RETURN_NOW', 'CONNECTION_AT_RISK'] as const) {
    const c = layoverSensingCadence({ sessionStatus: 'active', returnState: state });
    // This surface has no location grant to spend, in any state, including the
    // emergency one. An emergency does not grant a permission nobody gave.
    assert.equal(c.locationSensing, 'none');
  }
});

/** The files the two prohibition scans below both cover. */
const APP_ROOT = new URL('../../..', import.meta.url).pathname;

/**
 * THE WHOLE layover/airport client scope, DERIVED rather than listed (lead
 * ruling 2026-10-07 on guarded prohibitions: a guard is an artifact only if it
 * covers the full scope). Every non-test `.ts`/`.tsx` under `src/` and `app/`
 * whose path names "layover" or "airport", in any case — so a new layover file
 * anywhere is in scope the day it is created, without editing this list.
 */
function layoverSurfaceFiles(root = APP_ROOT): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__') continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
        if (/layover|airport/i.test(relative(root, p))) files.push(p);
      }
    }
  };
  for (const top of ['src', 'app']) walk(join(root, top));
  return files.sort();
}

/** The permission-bearing APIs each prohibition forbids, as import and call patterns. */
const LOCATION_RULES: ReadonlyArray<[RegExp, string]> = [
  [/from ['"]expo-location['"]/, 'imports expo-location'],
  [/requestForegroundPermissionsAsync|requestBackgroundPermissionsAsync|watchPositionAsync|getCurrentPositionAsync/, 'calls a location permission/watch API'],
];
const PHOTO_CONTACT_RULES: ReadonlyArray<[RegExp, string]> = [
  [/from ['"]expo-(image-picker|contacts|camera|media-library)['"]/, 'imports a photo/contacts module'],
  [/launchImageLibraryAsync|launchCameraAsync|getContactsAsync/, 'calls a photo/contacts API'],
];

function permissionOffenders(files: readonly string[], rules: ReadonlyArray<[RegExp, string]>): string[] {
  const out: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const [re, what] of rules) if (re.test(src)) out.push(`${f}: ${what}`);
  }
  return out;
}

/**
 * THE SCOPE IS THE IMPORT GRAPH, not the file names (third verification of lane
 * R, F3 on ab67f861bb). A path-named walk missed `src/lib/maps.ts` — which the
 * layover screen imports for L120's directions — and `DiscoveryMapView.tsx`,
 * which `LayoverMapCard` mounts and which L164's own evidence named: a location
 * prompt planted in either passed the guard. The scope is now every file
 * reachable by import from the layover/airport-named files above (relative and
 * `@/` imports, inside `src/` and `app/`, transitively; `node_modules` is not
 * walked), so whatever the layover screen bundles is scanned.
 */
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function resolveImport(from: string, spec: string, root: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@/')) base = join(root, spec.slice(2));
  else return null; // a package: node_modules is not product code
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (!existsSync(c) || !statSync(c).isFile() || !/\.(ts|tsx)$/.test(c)) continue;
    const rel = relative(root, c);
    if (rel.startsWith('src/') || rel.startsWith('app/')) return c;
  }
  return null;
}

/** Every file the layover/airport surface reaches by import, the surface included. */
function layoverImportClosure(root = APP_ROOT): string[] {
  const seen = new Set<string>();
  const stack = [...layoverSurfaceFiles(root)];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT_SPEC)) {
      const r = resolveImport(f, m[1]!, root);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return [...seen].sort();
}

/**
 * The app-wide location stack the layover surface REACHES but does not own,
 * each with the reason it is not a layover request. The import chain is
 * LayoverMapCard -> PlaceDetailSheet -> LocationContext (PlaceDetailSheet reads
 * `resolvedLocation`; it requests nothing). `LocationProvider` is mounted once,
 * at the app root (`app/_layout.tsx`), so whatever it asks for it asks because
 * the APP is running, not because Layover exists — which is exactly the line
 * L164 draws, and exactly why L164 is NOT graded `C` on this guard: these are
 * the files where a prompt lives, and a scan cannot tell whose prompt it is.
 * The list is pinned below to be exact (each must be reached and must touch
 * location), so it cannot grow quietly.
 */
const APP_WIDE_LOCATION_STACK: ReadonlyArray<[string, string]> = [
  ['src/services/location.ts', 'the one module that asks the OS for a fix; called by the root LocationProvider'],
  ['src/hooks/useActiveLocation.ts', 'the root LocationProvider\'s capture/refresh hook'],
  ['src/context/LocationContext.tsx', 'the root provider itself (mounted in app/_layout.tsx)'],
  ['src/components/selectors/GlobalPlacePicker.tsx', 'reads the EXISTING permission and the last known fix (getForegroundPermissionsAsync / getLastKnownPositionAsync); it prompts for nothing'],
];

/**
 * §17.1 L164 — the prohibition, over the import graph. No file the layover
 * surface reaches, other than the app-wide stack above, imports `expo-location`
 * or calls a location permission or watch API.
 *
 * If live return assistance is ever built, this test is the place the decision
 * gets made explicitly — by changing it, with the rationale-sheet requirement
 * (L165, already built for notifications) applied to location too.
 */
test('nothing the layover surface reaches asks for location, outside the app-wide location stack', () => {
  const stack = new Set(APP_WIDE_LOCATION_STACK.map(([f]) => join(APP_ROOT, f)));
  const files = layoverImportClosure().filter((f) => !stack.has(f));
  // Import sites only: the words appear in this file's own prose and in the
  // census commentary the surface carries, and a comment is not a prompt.
  const offenders = permissionOffenders(files, LOCATION_RULES);
  assert.deepEqual(offenders, [], offenders.join('\n'));
  assert.ok(files.length > 100, `only ${files.length} files scanned — the import walk broke`);
});

test('the app-wide location stack is EXACT: every listed file is reached and touches location, and no other reached file does', () => {
  const closure = layoverImportClosure();
  const touching = closure
    .filter((f) => /from ['"]expo-location['"]/.test(readFileSync(f, 'utf8')) || LOCATION_RULES.some(([re]) => re.test(readFileSync(f, 'utf8'))))
    .map((f) => relative(APP_ROOT, f));
  const listed = APP_WIDE_LOCATION_STACK.map(([f]) => f);
  for (const f of listed) assert.ok(closure.includes(join(APP_ROOT, f)), `${f} is listed but no longer reached — remove it`);
  // LocationContext reaches location only through the hook; it is listed for
  // the reason above, not because it names an API itself.
  assert.deepEqual(touching.sort(), listed.filter((f) => f !== 'src/context/LocationContext.tsx').sort());
  // An exception holds only for what its reason says: the place picker reads
  // the existing permission and the last known fix, and must never PROMPT.
  const picker = readFileSync(join(APP_ROOT, 'src/components/selectors/GlobalPlacePicker.tsx'), 'utf8');
  assert.doesNotMatch(picker, /requestForegroundPermissionsAsync|requestBackgroundPermissionsAsync|watchPositionAsync|getCurrentPositionAsync/, 'GlobalPlacePicker is excepted as a non-prompting reader; it now prompts');
});

/**
 * §17.1 L168 — "photos/contacts not required for core safety operation". Over
 * the WHOLE import closure, with no exception: nothing the layover surface
 * reaches imports a picker, camera, media-library or contacts module or calls
 * one. Avatars render through `CachedImage`, which is display, not access.
 */
test('nothing the layover surface reaches asks for photos or contacts — no exception', () => {
  const files = layoverImportClosure();
  const offenders = permissionOffenders(files, PHOTO_CONTACT_RULES);
  assert.deepEqual(offenders, [], offenders.join('\n'));
  assert.ok(files.length > 100, `only ${files.length} files scanned — the import walk broke`);
});

test('the scope is the import graph: the screen, the context, the admin airports screen, the services — and what they import', () => {
  const rel = layoverImportClosure().map((f) => relative(APP_ROOT, f));
  for (const must of [
    'app/layover/[id].tsx', 'src/context/LayoverSessionContext.tsx', 'app/admin/airports.tsx',
    'src/services/layover.ts', 'src/lib/layoverPlanCache.ts', 'src/components/layover/LayoverMapCard.tsx',
    // Not layover-named, reached by import: the two files the path-named walk missed.
    'src/lib/maps.ts', 'src/components/discovery/DiscoveryMapView.tsx',
  ]) assert.ok(rel.includes(must), `${must} is not scanned`);
  assert.ok(!rel.some((f) => /__tests__|\.test\./.test(f)), 'tests are not product code');
});

test('PLANTED violations are caught where the path-named walk could not see them: maps.ts and DiscoveryMapView.tsx', () => {
  const root = mkdtempSync(join(tmpdir(), 'layover-perm-guard-'));
  try {
    const plant = (rel: string, body: string) => {
      const dir = join(root, rel.split('/').slice(0, -1).join('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    plant('app/layover/[id].tsx', "import { directionsUrl } from '../../src/lib/maps';\nimport { LayoverMapCard } from '../../src/components/layover/LayoverMapCard';\n");
    plant('src/components/layover/LayoverMapCard.tsx', "import { DiscoveryMapView } from '@/src/components/discovery/DiscoveryMapView';\n");
    plant('src/lib/maps.ts', "import * as Location from 'expo-location';\nexport const whereAmI = () => Location.getCurrentPositionAsync();\n");
    plant('src/components/discovery/DiscoveryMapView.tsx', "import * as Contacts from 'expo-contacts';\nexport const read = () => Contacts.getContactsAsync();\n");
    plant('src/components/other/Unrelated.tsx', "import * as Location from 'expo-location';\n");
    const files = layoverImportClosure(root);
    assert.deepEqual(files.map((f) => relative(root, f)), [
      'app/layover/[id].tsx', 'src/components/discovery/DiscoveryMapView.tsx', 'src/components/layover/LayoverMapCard.tsx', 'src/lib/maps.ts',
    ], 'reached by import, and only those: an unimported file is not the layover surface');
    const loc = permissionOffenders(files, LOCATION_RULES).map((x) => x.replace(root + '/', ''));
    assert.deepEqual(loc, ['src/lib/maps.ts: imports expo-location', 'src/lib/maps.ts: calls a location permission/watch API']);
    const pc = permissionOffenders(files, PHOTO_CONTACT_RULES).map((x) => x.replace(root + '/', ''));
    assert.deepEqual(pc, ['src/components/discovery/DiscoveryMapView.tsx: imports a photo/contacts module', 'src/components/discovery/DiscoveryMapView.tsx: calls a photo/contacts API']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
