/**
 * sensingWiring — the guard that stops all of this becoming a tree nothing
 * imports.
 *
 * ── WHY A SOURCE SCAN ────────────────────────────────────────────────────────
 * Census S28 did not read `N` because there was no reduction code; it read `N`
 * because the app did not sense. A capture module that is perfectly tested and
 * mounted nowhere produces exactly the census verdict it was written to close,
 * while looking finished. `installInputTelemetry.test.ts` already keeps this
 * kind of watch over the §44 sink for the same reason and in the same way, and
 * its header records what the absence of that line actually cost.
 *
 * So four things are asserted from the files themselves:
 *   1. `app/_layout.tsx` imports `installSensingCapture`, calls it, and mounts
 *      `<SensingCaptureSetup />` in the rendered tree;
 *   2. `package.json` declares `expo-sensors` — the dependency S28 names first;
 *   3. `app.json` declares the SEPARATE acoustic permission (S29), and its
 *      declaration does not reuse the call/video microphone string;
 *   4. `app.json` declares the motion usage string the OS needs for §4.1's
 *      motion inputs.
 *
 * WATCHED IT FAIL: with `<SensingCaptureSetup />` removed from the tree, (1)
 * goes red; with the `expo-sensors` line removed from package.json, (2) does;
 * with `sensingPermissions` removed from app.json, (3) does.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// …/src/services/sensing/__tests__ → the standalone app root.
const APP_ROOT = join(HERE, '..', '..', '..', '..');

describe('S28 — the capture module is wired into the app, not merely written', () => {
  const layout = readFileSync(join(APP_ROOT, 'app', '_layout.tsx'), 'utf8');

  test('app/_layout.tsx imports and calls installSensingCapture', () => {
    assert.match(
      layout,
      /import \{ installSensingCapture \} from '\.\.\/src\/services\/sensing\/installSensingCapture'/,
      'the root layout must import the installer',
    );
    assert.match(
      layout,
      /installSensingCapture\s*\(\s*\)/,
      'the root layout must CALL it — an import alone senses nothing',
    );
  });

  test('and mounts <SensingCaptureSetup /> in the rendered tree', () => {
    assert.match(
      layout,
      /<SensingCaptureSetup\s*\/>/,
      'the setup component must actually be mounted, or the effect never runs',
    );
    // Mounted inside the returned tree, not merely defined above it.
    const returnIndex = layout.indexOf('return (');
    assert.ok(returnIndex > 0);
    assert.ok(
      layout.indexOf('<SensingCaptureSetup />', returnIndex) > returnIndex,
      'the mount must be inside RootLayout’s returned tree',
    );
  });

  test('the installer disposes on unmount, so a root remount does not stack loops', () => {
    assert.match(
      layout,
      /const handle = installSensingCapture\(\);\s*\n\s*return \(\) => handle\.dispose\(\);/,
      'the effect must return the disposer',
    );
  });

  test('package.json declares expo-sensors', () => {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.ok(
      typeof pkg.dependencies['expo-sensors'] === 'string',
      'S28 names expo-sensors first; the dependency must be declared',
    );
  });
});

describe('S29 — the SEPARATE acoustic permission is declared in app.json', () => {
  const appJson = JSON.parse(readFileSync(join(APP_ROOT, 'app.json'), 'utf8')) as any;
  const expo = appJson.expo;

  test('a purpose-scoped acoustic permission is declared, default-denied', () => {
    const decl = expo?.extra?.sensingPermissions?.acousticEnergy;
    assert.ok(decl, 'expo.extra.sensingPermissions.acousticEnergy must exist');
    assert.equal(decl.scope, 'sensing.acoustic.energy');
    assert.equal(decl.storageKey, 'sensing_acoustic_permission_v1');
    assert.equal(decl.defaultGranted, false, 'it must be off until a user turns it on');
    assert.equal(decl.requiresExplicitOptIn, true);
  });

  test('and it names the call/video microphone grants it is NOT satisfied by', () => {
    const decl = expo.extra.sensingPermissions.acousticEnergy;
    // This is the whole of the census requirement: "separate being the
    // requirement, so reusing a video permission would not close it".
    for (const grant of ['call.microphone', 'livekit.microphone', 'video.microphone', 'expo-av.recording']) {
      assert.ok(
        (decl.notSatisfiedBy as string[]).includes(grant),
        `${grant} must be named as not satisfying the acoustic permission`,
      );
    }
  });

  test('its usage string is its own, not the calls-and-video one', () => {
    const decl = expo.extra.sensingPermissions.acousticEnergy;
    const callsString = expo.ios.infoPlist.NSMicrophoneUsageDescription as string;
    assert.ok(typeof decl.usageDescription === 'string' && decl.usageDescription.length > 40);
    assert.notEqual(
      decl.usageDescription,
      callsString,
      'reusing the calls string would be reusing the permission in all but name',
    );
    assert.match(callsString, /calls/i, 'the existing microphone string is still the calls one');
  });

  test('a user can actually grant it — the settings screen owns the switch', () => {
    // A permission nothing can turn on is a permission that gates nothing: the
    // extractor would be permanently dead and S29 would be closed on paper.
    const screen = readFileSync(join(APP_ROOT, 'app', 'settings', 'intel-prompts.tsx'), 'utf8');
    assert.match(screen, /requestAcousticSensingPermission/, 'the screen must be able to grant it');
    assert.match(screen, /withdrawAcousticSensingPermission/, 'and to withdraw it');
    assert.match(
      screen,
      /Sound level sensing/,
      'it must be its OWN control, not folded into the calls microphone',
    );
  });

  test('the motion usage string §4.1 needs is declared too', () => {
    const motion = expo.ios.infoPlist.NSMotionUsageDescription as string;
    assert.ok(typeof motion === 'string' && motion.length > 40, 'iOS needs a motion usage string');
    assert.notEqual(motion, expo.ios.infoPlist.NSMicrophoneUsageDescription);
  });
});
