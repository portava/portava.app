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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
 * §17.1 L164 — THE PROHIBITION, GUARDED.
 *
 * The census records L164 as `N ∅`: "unguarded absence". Layover asks for no
 * location permission anywhere, which is what the requirement wants, and
 * nothing stopped the next pass from adding one. This is that guard. It is a
 * source scan rather than a runtime assertion because the failure it prevents
 * is an IMPORT: the moment `expo-location` appears on this surface, a prompt is
 * one call away and it will fire because Layover exists rather than because a
 * traveller turned something on.
 *
 * If live return assistance is ever built, this test is the place the decision
 * gets made explicitly — by changing it, with the rationale-sheet requirement
 * (L165, already built for notifications) applied to location too.
 */
test('the layover surface imports no location API at all', () => {
  const files = layoverSurfaceFiles();
  // Import sites only: the words appear in this file's own prose and in the
  // census commentary the surface carries, and a comment is not a prompt.
  const offenders = permissionOffenders(files, LOCATION_RULES);
  assert.deepEqual(offenders, [], offenders.join('\n'));
  // The scan must actually have looked at something — a walk that found no
  // files would pass vacuously.
  assert.ok(files.length > 15, `only ${files.length} files scanned`);
});

/**
 * §17.1 L168 — "photos/contacts not required for core safety operation",
 * recorded as `N ∅`: unguarded absence. Same guard, same argument as L164. The
 * layover surface renders avatars through `CachedImage`, which is display and
 * not access; what must never appear is a PICKER or a contacts read, because
 * either one makes a permission prompt part of getting back to a plane.
 */
test('the layover surface asks for no photos and no contacts', () => {
  const files = layoverSurfaceFiles();
  const offenders = permissionOffenders(files, PHOTO_CONTACT_RULES);
  assert.deepEqual(offenders, [], offenders.join('\n'));
  assert.ok(files.length > 15, `only ${files.length} files scanned`);
});

/**
 * The guard's own proof (lead ruling 2026-10-07): the derived scope reaches
 * the layover files outside the two directories the first version listed, and
 * a PLANTED violation in a layover/airport-named file anywhere is reported.
 */
test('the scope is the whole surface: the screen, the context, the admin airports screen, the services', () => {
  const rel = layoverSurfaceFiles().map((f) => relative(APP_ROOT, f));
  for (const must of [
    'app/layover/[id].tsx', 'src/context/LayoverSessionContext.tsx', 'app/admin/airports.tsx',
    'src/services/layover.ts', 'src/lib/layoverPlanCache.ts', 'src/components/layover/LayoverMapCard.tsx',
  ]) assert.ok(rel.includes(must), `${must} is not scanned`);
  assert.ok(!rel.some((f) => /__tests__|\.test\./.test(f)), 'tests are not product code');
});

test('PLANTED violations are caught: a location prompt and a contacts read in new layover/airport files', () => {
  const root = mkdtempSync(join(tmpdir(), 'layover-perm-guard-'));
  try {
    const plant = (rel: string, body: string) => {
      const dir = join(root, rel.split('/').slice(0, -1).join('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    plant('src/features/layoverNew/ReturnAssist.tsx', "import * as Location from 'expo-location';\nexport const go = () => Location.requestForegroundPermissionsAsync();\n");
    plant('app/airport/[code].tsx', "import * as Contacts from 'expo-contacts';\nexport const read = () => Contacts.getContactsAsync();\n");
    plant('src/components/other/Unrelated.tsx', "import * as Location from 'expo-location';\n");
    const files = layoverSurfaceFiles(root);
    assert.deepEqual(files.map((f) => relative(root, f)), ['app/airport/[code].tsx', 'src/features/layoverNew/ReturnAssist.tsx']);
    const loc = permissionOffenders(files, LOCATION_RULES).map((x) => x.replace(root + '/', ''));
    assert.deepEqual(loc, [
      'src/features/layoverNew/ReturnAssist.tsx: imports expo-location',
      'src/features/layoverNew/ReturnAssist.tsx: calls a location permission/watch API',
    ]);
    const pc = permissionOffenders(files, PHOTO_CONTACT_RULES).map((x) => x.replace(root + '/', ''));
    assert.deepEqual(pc, ['app/airport/[code].tsx: imports a photo/contacts module', 'app/airport/[code].tsx: calls a photo/contacts API']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
