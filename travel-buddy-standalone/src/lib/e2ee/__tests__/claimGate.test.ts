/**
 * E2EE claim gate — pins the encryption-claim mitigation.
 *
 * The app must not represent a thread as verified end-to-end encrypted until
 * BOTH conditions in lib/e2ee/verificationGate.ts are met: FFI bar 2 proven on
 * a device, and the client attachment-control gap closed. Neither is met.
 *
 * WHAT THIS TEST IS, AND IS NOT.
 *
 * These are source-level assertions, not render assertions. app/messages/[id].tsx
 * is a ~1700-line screen with a large dependency graph and no existing component
 * test harness; standing one up to assert the absence of a padlock would be a
 * far larger change than the mitigation itself.
 *
 * The risk actually being defended against is a source edit — someone deleting
 * the guard or flipping the constant without reading why it exists. A source
 * assertion catches exactly that. It would NOT catch the badge being
 * reintroduced through some other component, which is a real gap and is stated
 * here rather than papered over.
 *
 * Runs under node:test, like the rest of this directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  E2EE_CLAIM_UI_ENABLED,
  E2EE_VERIFICATION_UI_ENABLED,
} from '../verificationGate.ts';

const here = join(fileURLToPath(import.meta.url), '..');
const threadScreen = () =>
  readFileSync(join(here, '../../../../app/messages/[id].tsx'), 'utf8');

test('the claim gate is closed', () => {
  // Flipping this to true asserts verified E2EE to users. Read the rationale
  // block in verificationGate.ts before changing it.
  assert.equal(E2EE_CLAIM_UI_ENABLED, false);
});

test('the verification gate is closed, and is a separate gate', () => {
  assert.equal(E2EE_VERIFICATION_UI_ENABLED, false);
  // Distinct on purpose: the verification affordance being off did not stop the
  // claim being made. That was the bug this mitigation fixes.
  assert.notEqual(E2EE_CLAIM_UI_ENABLED, undefined);
});

test('the thread header gates its lock badge on the claim gate', () => {
  const src = threadScreen();

  // The badge must be guarded by the claim gate, not only by isE2ee.
  assert.ok(
    src.includes('E2EE_CLAIM_UI_ENABLED && isE2ee'),
    'lock badge is no longer guarded by E2EE_CLAIM_UI_ENABLED',
  );

  // And the gate must actually be imported rather than shadowed locally.
  assert.match(
    src,
    /import\s*\{[^}]*E2EE_CLAIM_UI_ENABLED[^}]*\}\s*from\s*'[^']*verificationGate'/,
  );
});

test('no unguarded "End-to-end encrypted" claim remains in the thread header', () => {
  const src = threadScreen();

  const gatedIndex = src.indexOf('E2EE_CLAIM_UI_ENABLED && isE2ee');
  assert.ok(gatedIndex > -1, 'claim guard missing entirely');

  // Match the *rendered* claim, not prose. The guard's own comment explains
  // what the padlock asserts and necessarily quotes the phrase; matching bare
  // text would flag that comment forever. Only accessibilityLabel reaches a
  // user (screen readers announce it verbatim).
  const claimRe = /accessibilityLabel="End-to-end encrypted/g;
  const positions = [...src.matchAll(claimRe)].map((m) => m.index ?? -1);

  assert.ok(positions.length > 0, 'expected the rendered claim to still exist');
  for (const pos of positions) {
    assert.ok(
      pos > gatedIndex,
      `an "End-to-end encrypted" accessibilityLabel at index ${pos} appears before the claim guard at ${gatedIndex}`,
    );
  }
});
