/**
 * Backdrop dismiss tests for UnifiedPostComposer (PulseCreate.tsx).
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/PulseCreate.backdrop.test.ts
 *
 * ## Why this test exists
 *
 * A layout fix moved the backdrop Pressable to `StyleSheet.absoluteFillObject`
 * so it no longer competes with the sheet in the flex layout. The fix preserved
 * the `onPress={onClose}` wiring, but there was no automated test confirming
 * the tap-dismiss path still works after such structural changes.
 *
 * ## Testing strategy
 *
 * We use the machine-layer pattern (see ReportPostSheet.test.ts). The React
 * Native test renderer (RNTL) is unavailable in this environment (jest-expo +
 * React 19 creates multiple React instances), so we test the dismiss-handler
 * factory that the component imports and uses directly.
 *
 * `PulseCreate.tsx` imports `createComposerDismissHandlers` from
 * `PulseCreate.machine.ts` and wires the returned handlers to:
 *
 *   <Modal onRequestClose={dismiss.onRequestClose}>
 *     <Pressable testID="post-composer-backdrop" onPress={dismiss.onBackdropPress} />
 *     <Pressable testID="post-composer-close-btn" onPress={dismiss.onCloseButtonPress} />
 *   </Modal>
 *
 * These tests import and exercise `createComposerDismissHandlers` directly,
 * verifying the production code path that the component depends on. If the
 * factory is changed so that a handler no longer calls `onClose`, these tests
 * will fail and catch the regression.
 *
 * The `testID` attributes on the backdrop and close button are the stable
 * selectors future RNTL tests can use once the multi-React-instance issue is
 * resolved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createComposerDismissHandlers } from '../PulseCreate.machine.ts';

// ── Backdrop tap → onClose ────────────────────────────────────────────────────

describe('backdrop press — onBackdropPress invokes onClose', () => {
  it('calls onClose exactly once when the backdrop is tapped', () => {
    let calls = 0;
    const dismiss = createComposerDismissHandlers(() => { calls++; });

    dismiss.onBackdropPress();

    assert.equal(calls, 1, 'onClose must be called exactly once on backdrop tap');
  });

  it('calls onClose each time onBackdropPress is invoked (multiple open/close cycles)', () => {
    let calls = 0;
    const dismiss = createComposerDismissHandlers(() => { calls++; });

    dismiss.onBackdropPress();
    dismiss.onBackdropPress();
    dismiss.onBackdropPress();

    assert.equal(calls, 3, 'onClose called once per tap');
  });

  it('invokes the correct spy (not a different callback)', () => {
    const log: string[] = [];
    const dismiss = createComposerDismissHandlers(() => { log.push('backdrop'); });

    dismiss.onBackdropPress();

    assert.deepEqual(log, ['backdrop']);
  });
});

// ── X close button → onClose ──────────────────────────────────────────────────

describe('X close button — onCloseButtonPress invokes onClose', () => {
  it('calls onClose exactly once when the X icon is tapped', () => {
    let calls = 0;
    const dismiss = createComposerDismissHandlers(() => { calls++; });

    dismiss.onCloseButtonPress();

    assert.equal(calls, 1, 'onClose must be called exactly once on X tap');
  });

  it('calls onClose each time onCloseButtonPress is invoked', () => {
    let calls = 0;
    const dismiss = createComposerDismissHandlers(() => { calls++; });

    for (let i = 0; i < 5; i++) {
      dismiss.onCloseButtonPress();
    }

    assert.equal(calls, 5);
  });
});

// ── Android back button (onRequestClose) → onClose ───────────────────────────

describe('Android back button — onRequestClose invokes onClose', () => {
  it('calls onClose exactly once when the system back button is pressed', () => {
    let calls = 0;
    const dismiss = createComposerDismissHandlers(() => { calls++; });

    dismiss.onRequestClose();

    assert.equal(calls, 1, 'onClose must be called exactly once on back button');
  });
});

// ── All three dismiss paths share a single onClose ────────────────────────────

describe('all dismiss paths share a single onClose callback', () => {
  it('backdrop, X button, and back button all invoke the same onClose', () => {
    const log: string[] = [];
    const dismiss = createComposerDismissHandlers(() => { log.push('x'); });

    dismiss.onBackdropPress();
    dismiss.onCloseButtonPress();
    dismiss.onRequestClose();

    assert.equal(log.length, 3, 'three dismiss paths → three onClose calls');
    assert.ok(log.every((v) => v === 'x'), 'all calls hit the same callback');
  });

  it('dismiss paths are independent — any one alone is sufficient to close', () => {
    let backdropCount = 0;
    createComposerDismissHandlers(() => { backdropCount++; }).onBackdropPress();
    assert.equal(backdropCount, 1, 'backdrop alone closes');

    let closeCount = 0;
    createComposerDismissHandlers(() => { closeCount++; }).onCloseButtonPress();
    assert.equal(closeCount, 1, 'X button alone closes');

    let backCount = 0;
    createComposerDismissHandlers(() => { backCount++; }).onRequestClose();
    assert.equal(backCount, 1, 'back button alone closes');
  });

  it('fresh handler set per composer instance — callbacks do not cross-contaminate', () => {
    let countA = 0;
    let countB = 0;
    const dismissA = createComposerDismissHandlers(() => { countA++; });
    const dismissB = createComposerDismissHandlers(() => { countB++; });

    dismissA.onBackdropPress();
    dismissB.onCloseButtonPress();

    assert.equal(countA, 1, 'dismissA.onBackdropPress called A callback only');
    assert.equal(countB, 1, 'dismissB.onCloseButtonPress called B callback only');
  });
});
