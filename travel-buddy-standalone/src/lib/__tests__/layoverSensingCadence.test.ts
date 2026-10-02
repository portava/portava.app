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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
function layoverSurfaceFiles(): string[] {
  const root = new URL('../../..', import.meta.url).pathname;
  const roots = [
    join(root, 'src/components/layover'),
    join(root, 'app/layover'),
  ];
  const files: string[] = [
    join(root, 'src/services/layover.ts'),
    join(root, 'src/lib/layoverPlanCache.ts'),
    join(root, 'src/lib/layoverReasonCodes.ts'),
    join(root, 'src/lib/layoverSensingCadence.ts'),
  ];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry)) files.push(p);
    }
  };
  for (const r of roots) walk(r);
  return files;
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
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Import sites only: the words appear in this file's own prose and in the
    // census commentary the surface carries, and a comment is not a prompt.
    if (/from ['"]expo-location['"]/.test(src)) offenders.push(`${f}: imports expo-location`);
    if (/requestForegroundPermissionsAsync|requestBackgroundPermissionsAsync|watchPositionAsync/.test(src)) {
      offenders.push(`${f}: calls a location permission/watch API`);
    }
  }
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
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (/from ['"]expo-(image-picker|contacts|camera|media-library)['"]/.test(src)) {
      offenders.push(`${f}: imports a photo/contacts module`);
    }
    if (/launchImageLibraryAsync|launchCameraAsync|getContactsAsync/.test(src)) {
      offenders.push(`${f}: calls a photo/contacts API`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
  assert.ok(files.length > 15, `only ${files.length} files scanned`);
});
