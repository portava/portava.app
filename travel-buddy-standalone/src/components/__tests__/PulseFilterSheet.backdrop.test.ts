/**
 * Backdrop dismiss tests for PulseFilterSheet (PulseCreate.tsx).
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/PulseFilterSheet.backdrop.test.ts
 *
 * ## Why this test exists
 *
 * PulseFilterSheet uses a backdrop Pressable with onPress={onClose} and a
 * Modal onRequestClose={onClose}. There was no machine-layer test confirming
 * either dismiss path works — a future refactor could break it silently.
 *
 * ## Testing strategy
 *
 * We use the machine-layer pattern (see PulseCreate.backdrop.test.ts). The
 * React Native test renderer (RNTL) is unavailable in this environment
 * (jest-expo + React 19 creates multiple React instances), so we test the
 * dismiss-handler factory that the component imports and uses directly.
 *
 * `createFilterDismissHandlers` is wired in PulseCreate.tsx to:
 *
 *   <Modal onRequestClose={dismiss.onRequestClose}>
 *     <Pressable testID="filter-sheet-backdrop" onPress={dismiss.onBackdropPress} />
 *     <Pressable testID="filter-sheet-close-btn" onPress={dismiss.onCloseButtonPress} />
 *     <Pressable testID="filter-sheet-apply" onPress={dismiss.onApplyPress} />
 *   </Modal>
 *
 * These tests import and exercise `createFilterDismissHandlers` directly,
 * verifying the production code path that the component depends on. If the
 * factory is changed so that a handler no longer calls `onClose`, these tests
 * will fail and catch the regression.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFilterDismissHandlers } from '../PulseFilterSheet.machine.ts';

// ── Backdrop tap → onClose ─────────────────────────────────────────────────────

describe('backdrop press — onBackdropPress invokes onClose', () => {
  it('calls onClose exactly once when the backdrop is tapped', () => {
    let calls = 0;
    const dismiss = createFilterDismissHandlers(() => { calls++; });

    dismiss.onBackdropPress();

    assert.equal(calls, 1, 'onClose must be called exactly once on backdrop tap');
  });

  it('calls onClose each time onBackdropPress is invoked (multiple open/close cycles)', () => {
    let calls = 0;
    const dismiss = createFilterDismissHandlers(() => { calls++; });

    dismiss.onBackdropPress();
    dismiss.onBackdropPress();
    dismiss.onBackdropPress();

    assert.equal(calls, 3, 'onClose called once per tap');
  });

  it('invokes the correct spy (not a different callback)', () => {
    const log: string[] = [];
    const dismiss = createFilterDismissHandlers(() => { log.push('backdrop'); });

    dismiss.onBackdropPress();

    assert.deepEqual(log, ['backdrop']);
  });
});

// ── X close button → onClose ───────────────────────────────────────────────────

describe('X close button — onCloseButtonPress invokes onClose', () => {
  it('calls onClose exactly once when the X icon is tapped', () => {
    let calls = 0;
    const dismiss = createFilterDismissHandlers(() => { calls++; });

    dismiss.onCloseButtonPress();

    assert.equal(calls, 1, 'onClose must be called exactly once on X tap');
  });

  it('calls onClose each time onCloseButtonPress is invoked', () => {
    let calls = 0;
    const dismiss = createFilterDismissHandlers(() => { calls++; });

    for (let i = 0; i < 5; i++) {
      dismiss.onCloseButtonPress();
    }

    assert.equal(calls, 5);
  });
});

// ── Android back button (onRequestClose) → onClose ────────────────────────────

describe('Android back button — onRequestClose invokes onClose', () => {
  it('calls onClose exactly once when the system back button is pressed', () => {
    let calls = 0;
    const dismiss = createFilterDismissHandlers(() => { calls++; });

    dismiss.onRequestClose();

    assert.equal(calls, 1, 'onClose must be called exactly once on back button');
  });
});

// ── "Show results" apply button → onClose ─────────────────────────────────────

describe('"Show results" button — onApplyPress invokes onClose', () => {
  it('calls onClose exactly once when "Show results" is tapped', () => {
    let calls = 0;
    const dismiss = createFilterDismissHandlers(() => { calls++; });

    dismiss.onApplyPress();

    assert.equal(calls, 1, 'onClose must be called exactly once on apply tap');
  });
});

// ── All dismiss paths share a single onClose ───────────────────────────────────

describe('all dismiss paths share a single onClose callback', () => {
  it('backdrop, X button, back button, and apply all invoke the same onClose', () => {
    const log: string[] = [];
    const dismiss = createFilterDismissHandlers(() => { log.push('x'); });

    dismiss.onBackdropPress();
    dismiss.onCloseButtonPress();
    dismiss.onRequestClose();
    dismiss.onApplyPress();

    assert.equal(log.length, 4, 'four dismiss paths → four onClose calls');
    assert.ok(log.every((v) => v === 'x'), 'all calls hit the same callback');
  });

  it('dismiss paths are independent — any one alone is sufficient to close', () => {
    let backdropCount = 0;
    createFilterDismissHandlers(() => { backdropCount++; }).onBackdropPress();
    assert.equal(backdropCount, 1, 'backdrop alone closes');

    let closeCount = 0;
    createFilterDismissHandlers(() => { closeCount++; }).onCloseButtonPress();
    assert.equal(closeCount, 1, 'X button alone closes');

    let backCount = 0;
    createFilterDismissHandlers(() => { backCount++; }).onRequestClose();
    assert.equal(backCount, 1, 'back button alone closes');

    let applyCount = 0;
    createFilterDismissHandlers(() => { applyCount++; }).onApplyPress();
    assert.equal(applyCount, 1, 'apply button alone closes');
  });

  it('fresh handler set per sheet instance — callbacks do not cross-contaminate', () => {
    let countA = 0;
    let countB = 0;
    const dismissA = createFilterDismissHandlers(() => { countA++; });
    const dismissB = createFilterDismissHandlers(() => { countB++; });

    dismissA.onBackdropPress();
    dismissB.onCloseButtonPress();

    assert.equal(countA, 1, 'dismissA.onBackdropPress called A callback only');
    assert.equal(countB, 1, 'dismissB.onCloseButtonPress called B callback only');
  });
});
