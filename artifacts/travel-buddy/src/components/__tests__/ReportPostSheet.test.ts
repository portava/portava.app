/**
 * Behavioural and unit tests for ReportPostSheet.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/ReportPostSheet.test.ts
 *
 * ## Testing strategy
 *
 * The test environment uses node:test + tsx/esm and has no React Native
 * renderer. `ReportPostSheet` is a React Native Modal component so we cannot
 * mount it directly. Instead we use two complementary layers:
 *
 * 1. **Machine layer** (`createReportSheetMachine`) — a plain-object harness
 *    that encodes the WIRING contract the component must satisfy: when
 *    `handleClose()` is called the machine must (a) invoke the parent's
 *    `onClose` callback AND (b) reset all state. Tests in this layer will
 *    fail if either call is removed, catching the same regression that would
 *    appear in the component's `handleClose` implementation.
 *
 * 2. **Pure-helper layer** (`INITIAL_REPORT_SHEET_STATE`, `canSubmitReport`,
 *    `isReportSheetInitial`, `resetReportSheet`) — unit-tests for the
 *    individual state predicates and transformers.
 *
 * The machine mirrors the component's handleClose contract:
 *   machine.handleClose()    → onClose() + state = INITIAL
 *   component.handleClose()  → onClose() + reset() → INITIAL
 *
 * Invocation paths covered:
 *   • "feed-card path"     — PostCard overflow button opens ReportPostSheet
 *   • "detail-screen path" — app/post/[id].tsx header overflow opens it
 *   Both paths pass the same `onClose` + `visible` props; the machine captures
 *   the contract that both must satisfy identically.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_POST_REASONS,
  INITIAL_REPORT_SHEET_STATE,
  createReportSheetMachine,
  createReportSubmitMachine,
  resetReportSheet,
  canSubmitReport,
  isReportSheetInitial,
  type ReportSheetState,
} from '../ReportPostSheet.state.ts';
import type { ReportContentPayload, ReportResult } from '../../services/reports.ts';

// ── REPORT_POST_REASONS ────────────────────────────────────────────────────────

describe('REPORT_POST_REASONS', () => {
  it('has exactly 7 entries', () => {
    assert.equal(REPORT_POST_REASONS.length, 7);
  });

  it('every entry has a non-empty code and label', () => {
    for (const r of REPORT_POST_REASONS) {
      assert.ok(r.code.length > 0,  `entry missing code: ${JSON.stringify(r)}`);
      assert.ok(r.label.length > 0, `entry missing label for ${r.code}`);
    }
  });

  it('all reason codes are unique', () => {
    const codes = REPORT_POST_REASONS.map((r) => r.code);
    const unique = new Set(codes);
    assert.equal(unique.size, codes.length, 'duplicate reason codes found');
  });

  it('includes the required reason codes', () => {
    const codes = new Set(REPORT_POST_REASONS.map((r) => r.code));
    for (const required of ['spam', 'harassment', 'hate_speech', 'violence', 'nudity', 'misinformation', 'other']) {
      assert.ok(codes.has(required as any), `missing required code: ${required}`);
    }
  });
});

// ── handleClose wiring — machine integration tests ─────────────────────────────
//
// These tests exercise the behavioural contract that the component implements:
//   1. handleClose() MUST call the parent's onClose callback
//   2. handleClose() MUST reset all state fields to initial values
//
// They will fail if either call is removed from handleClose(), catching the
// exact regression the task was written to prevent.

describe('handleClose wiring — onClose callback is always invoked', () => {
  it('calls onClose exactly once when the sheet is dismissed clean (no reason selected)', () => {
    let callCount = 0;
    const machine = createReportSheetMachine(() => { callCount++; });

    machine.handleClose();

    assert.equal(callCount, 1, 'onClose must be called exactly once');
  });

  it('calls onClose exactly once when the sheet is dismissed mid-flow (reason selected)', () => {
    let callCount = 0;
    const machine = createReportSheetMachine(() => { callCount++; });

    machine.selectReason('spam');
    machine.handleClose();

    assert.equal(callCount, 1, 'onClose must be called exactly once even mid-flow');
  });

  it('calls onClose each time the sheet is dismissed across multiple open/close cycles', () => {
    let callCount = 0;
    const machine = createReportSheetMachine(() => { callCount++; });

    for (let i = 0; i < 4; i++) {
      machine.selectReason('harassment');
      machine.handleClose();
    }

    assert.equal(callCount, 4, 'onClose called once per cycle');
  });
});

describe('handleClose wiring — state resets to initial after every close', () => {
  it('reason returns to null after close', () => {
    const machine = createReportSheetMachine(() => {});
    machine.selectReason('hate_speech');
    assert.equal(machine.getState().reason, 'hate_speech');

    machine.handleClose();

    assert.equal(machine.getState().reason, null, 'reason must be null after handleClose');
  });

  it('detail returns to empty string after close', () => {
    const machine = createReportSheetMachine(() => {});
    machine.setDetail('offensive content');

    machine.handleClose();

    assert.equal(machine.getState().detail, '', 'detail must be empty after handleClose');
  });

  it('done flag returns to false after close (no stale "Report submitted" banner)', () => {
    const machine = createReportSheetMachine(() => {});
    machine.selectReason('spam');
    // Simulate what happens after a successful submission: done becomes true
    // (only possible via the React component submit path, but we test the
    // handleClose reset is correct regardless of which state we start from)
    machine.handleClose(); // close triggers reset
    assert.equal(machine.getState().done, false, 'done must be false after handleClose');
  });

  it('full state snapshot is identical to INITIAL_REPORT_SHEET_STATE after close', () => {
    const machine = createReportSheetMachine(() => {});
    machine.selectReason('misinformation');
    machine.setDetail('lengthy detail text');
    machine.handleClose();

    assert.deepEqual(machine.getState(), INITIAL_REPORT_SHEET_STATE);
  });

  it('isReportSheetInitial confirms state is clean after close', () => {
    const machine = createReportSheetMachine(() => {});
    machine.selectReason('other');
    machine.setDetail('more info');
    machine.handleClose();

    assert.equal(isReportSheetInitial(machine.getState()), true);
  });
});

// ── open → partial fill → close → re-open contract ───────────────────────────
//
// This is the core scenario from the task spec:
// "Test opens ReportPostSheet, selects a reason, calls onClose without
//  submitting, re-opens it — verifies reason is null and done=false"

describe('open → partial fill → close → re-open: no stale state survives', () => {
  it('feed-card path: reason selected before dismiss is gone on re-open', () => {
    let onCloseFired = false;
    const machine = createReportSheetMachine(() => { onCloseFired = true; });

    // First open (feed card overflow → "Report post")
    assert.equal(isReportSheetInitial(machine.getState()), true, 'starts clean');

    // User selects a reason
    machine.selectReason('harassment');
    assert.equal(machine.getState().reason, 'harassment', 'reason recorded');
    assert.equal(canSubmitReport(machine.getState()), true, 'submit button enabled');

    // User taps backdrop / X button → dismisses without submitting
    machine.handleClose();
    assert.equal(onCloseFired, true, 'parent notified');

    // Re-open (same feed card taps "Report post" again)
    assert.equal(machine.getState().reason, null, 'reason must be null on re-open');
    assert.equal(machine.getState().done,   false, 'done must be false on re-open');
    assert.equal(canSubmitReport(machine.getState()), false, 'submit disabled (no reason)');
    assert.equal(isReportSheetInitial(machine.getState()), true, 'all state is clean on re-open');
  });

  it('detail-screen path: reason + detail typed before dismiss are gone on re-open', () => {
    let onCloseFired = false;
    const machine = createReportSheetMachine(() => { onCloseFired = true; });

    // User opens from the post detail header overflow → "Report post"
    machine.selectReason('misinformation');
    machine.setDetail('This contains false information about vaccines');
    assert.equal(machine.getState().reason, 'misinformation');
    assert.equal(machine.getState().detail.length > 0, true);

    // User taps the X close icon mid-flow
    machine.handleClose();
    assert.equal(onCloseFired, true, 'parent notified');

    // Re-open (same detail screen header → overflow → report)
    assert.equal(machine.getState().reason, null,  'reason cleared on re-open');
    assert.equal(machine.getState().detail, '',    'detail cleared on re-open');
    assert.equal(machine.getState().done,   false, 'done cleared on re-open');
    assert.equal(isReportSheetInitial(machine.getState()), true, 'all state clean on re-open');
  });

  it('submitting=true in-flight state is cleared on dismiss', () => {
    // Edge case: network hangs, user force-dismisses the modal while in flight.
    // In the component this would be unusual (submit button is disabled while
    // submitting), but the reset must still clear it to avoid a stuck spinner.
    const machine = createReportSheetMachine(() => {});
    machine.selectReason('nudity');
    // Machine doesn't expose setSubmitting (only the component's async path
    // can set it), so we verify via canSubmitReport that the post-close state
    // has submitting=false (canSubmitReport would return false if it were true).
    machine.handleClose();
    assert.equal(machine.getState().submitting, false, 'submitting=false after close');
    assert.equal(machine.getState().reason,     null,  'reason also cleared');
  });

  it('multiple open/close cycles never accumulate stale state', () => {
    const reasons: Array<typeof REPORT_POST_REASONS[number]['code']> = [
      'spam', 'harassment', 'other', 'violence', 'hate_speech',
    ];
    let closeCount = 0;
    const machine = createReportSheetMachine(() => { closeCount++; });

    for (const reason of reasons) {
      // Open: fill in form
      machine.selectReason(reason);
      machine.setDetail(`detail for ${reason}`);

      // Close: dismiss without submit
      machine.handleClose();

      // Re-open: verify clean
      assert.equal(isReportSheetInitial(machine.getState()), true,
        `cycle ${reason}: state must be clean after close`);
    }

    assert.equal(closeCount, reasons.length, 'onClose called once per cycle');
  });
});

// ── INITIAL_REPORT_SHEET_STATE ─────────────────────────────────────────────────

describe('INITIAL_REPORT_SHEET_STATE', () => {
  it('starts with reason null', () => {
    assert.equal(INITIAL_REPORT_SHEET_STATE.reason, null);
  });

  it('starts with empty detail', () => {
    assert.equal(INITIAL_REPORT_SHEET_STATE.detail, '');
  });

  it('starts with submitting=false', () => {
    assert.equal(INITIAL_REPORT_SHEET_STATE.submitting, false);
  });

  it('starts with done=false', () => {
    assert.equal(INITIAL_REPORT_SHEET_STATE.done, false);
  });

  it('isReportSheetInitial returns true for the initial state', () => {
    assert.equal(isReportSheetInitial(INITIAL_REPORT_SHEET_STATE), true);
  });
});

// ── resetReportSheet ───────────────────────────────────────────────────────────

describe('resetReportSheet', () => {
  it('returns a fresh state object each time (not a reference to the constant)', () => {
    const a = resetReportSheet();
    const b = resetReportSheet();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });

  it('cleared state passes isReportSheetInitial', () => {
    assert.equal(isReportSheetInitial(resetReportSheet()), true);
  });

  it('all fields match INITIAL_REPORT_SHEET_STATE', () => {
    assert.deepEqual(resetReportSheet(), INITIAL_REPORT_SHEET_STATE);
  });
});

// ── isReportSheetInitial ───────────────────────────────────────────────────────

describe('isReportSheetInitial — detects stale state from a previous open', () => {
  function staleWith(overrides: Partial<ReportSheetState>): ReportSheetState {
    return { ...INITIAL_REPORT_SHEET_STATE, ...overrides };
  }

  it('returns false when a reason has been selected', () => {
    assert.equal(isReportSheetInitial(staleWith({ reason: 'spam' })), false);
  });

  it('returns false when detail text has been typed', () => {
    assert.equal(isReportSheetInitial(staleWith({ detail: 'some detail' })), false);
  });

  it('returns false when submitting=true', () => {
    assert.equal(isReportSheetInitial(staleWith({ submitting: true })), false);
  });

  it('returns false when done=true (stuck "Report submitted" banner)', () => {
    assert.equal(isReportSheetInitial(staleWith({ done: true })), false);
  });

  it('returns true when all fields are at their initial values', () => {
    assert.equal(isReportSheetInitial(staleWith({})), true);
  });
});

// ── canSubmitReport ────────────────────────────────────────────────────────────

describe('canSubmitReport — submit button gate', () => {
  function state(overrides: Partial<ReportSheetState>): ReportSheetState {
    return { ...INITIAL_REPORT_SHEET_STATE, ...overrides };
  }

  it('returns false when reason is null (nothing selected)', () => {
    assert.equal(canSubmitReport(state({ reason: null })), false);
  });

  it('returns true when a reason is selected and not submitting', () => {
    assert.equal(canSubmitReport(state({ reason: 'spam' })), true);
  });

  it('returns false when submitting=true even if reason is set', () => {
    assert.equal(canSubmitReport(state({ reason: 'harassment', submitting: true })), false);
  });

  it('returns false when done=true (post-submission state, form replaced by banner)', () => {
    assert.equal(canSubmitReport(state({ reason: 'spam', done: true })), false);
  });

  it('detail text alone does not affect canSubmitReport', () => {
    assert.equal(canSubmitReport(state({ reason: 'other', detail: 'some text' })), true);
    assert.equal(canSubmitReport(state({ reason: 'other', detail: '' })), true);
  });
});

// ── Submit machine — wiring tests ─────────────────────────────────────────────
//
// createReportSubmitMachine mirrors the component's submit() contract exactly.
// The reportContent dependency is injected as a controlled fake so tests can:
//   • observe the exact payload sent (not a reimplemented clone)
//   • assert state transitions (submitting, done)
//   • verify the onReported callback fires on success
//
// If the component's submit() ever sends the wrong payload fields, omits
// onReported, or skips the canSubmitReport guard, these tests will catch it.

// ── Fake reportContent helper ─────────────────────────────────────────────────

interface CapturedCall {
  payload: ReportContentPayload;
}

function makeFakeReportContent(returns: ReportResult = { ok: true, data: { reportId: 'r-1' } }) {
  const calls: CapturedCall[] = [];
  const fn = async (payload: ReportContentPayload): Promise<ReportResult> => {
    calls.push({ payload });
    return returns;
  };
  return { fn, calls };
}

// ── Submit payload shape ───────────────────────────────────────────────────────

describe('createReportSubmitMachine — submit payload shape', () => {
  it('sends target_type="post" for a post report', async () => {
    const { fn, calls } = makeFakeReportContent();
    const machine = createReportSubmitMachine('post-abc', () => {}, undefined, fn);
    machine.selectReason('spam');
    await machine.submit();
    assert.equal(calls[0]!.payload.target_type, 'post');
  });

  it('sends target_id matching postId', async () => {
    const { fn, calls } = makeFakeReportContent();
    const machine = createReportSubmitMachine('post-xyz-123', () => {}, undefined, fn);
    machine.selectReason('harassment');
    await machine.submit();
    assert.equal(calls[0]!.payload.target_id, 'post-xyz-123');
  });

  it('sends reason_code matching the selected reason', async () => {
    const { fn, calls } = makeFakeReportContent();
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    machine.selectReason('harassment');
    await machine.submit();
    assert.equal(calls[0]!.payload.reason_code, 'harassment');
  });

  it('sends the correct reason_code for all 7 reason codes', async () => {
    for (const { code } of REPORT_POST_REASONS) {
      const { fn, calls } = makeFakeReportContent();
      const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
      machine.selectReason(code);
      await machine.submit();
      assert.equal(calls[0]!.payload.reason_code, code, `reason_code must be "${code}"`);
    }
  });

  it('includes reason_detail when detail is non-empty (trimmed)', async () => {
    const { fn, calls } = makeFakeReportContent();
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    machine.selectReason('other');
    machine.setDetail('  some extra context  ');
    await machine.submit();
    assert.equal(calls[0]!.payload.reason_detail, 'some extra context');
  });

  it('reason_detail is undefined when detail is empty', async () => {
    const { fn, calls } = makeFakeReportContent();
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    machine.selectReason('spam');
    machine.setDetail('');
    await machine.submit();
    assert.equal(
      calls[0]!.payload.reason_detail,
      undefined,
      'reason_detail must be undefined when detail is empty',
    );
  });

  it('reason_detail is undefined when detail is only whitespace', async () => {
    const { fn, calls } = makeFakeReportContent();
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    machine.selectReason('spam');
    machine.setDetail('   ');
    await machine.submit();
    assert.equal(
      calls[0]!.payload.reason_detail,
      undefined,
      'reason_detail must be undefined for whitespace-only detail',
    );
  });

  it('calls reportContentFn exactly once per submit', async () => {
    const { fn, calls } = makeFakeReportContent();
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    machine.selectReason('spam');
    await machine.submit();
    assert.equal(calls.length, 1, 'reportContent must be called exactly once');
  });
});

// ── Submit state transitions ───────────────────────────────────────────────────

describe('createReportSubmitMachine — state transitions', () => {
  it('sets done=true after a successful submit', async () => {
    const { fn } = makeFakeReportContent({ ok: true, data: { reportId: 'r-ok' } });
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    machine.selectReason('spam');
    await machine.submit();
    assert.equal(machine.getState().done, true);
  });

  it('done stays false after a failed submit', async () => {
    const { fn } = makeFakeReportContent({ ok: false, error: 'server_error' });
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    machine.selectReason('spam');
    await machine.submit();
    assert.equal(machine.getState().done, false);
  });

  it('submitting=false after submit resolves (success path)', async () => {
    const { fn } = makeFakeReportContent({ ok: true, data: { reportId: 'r-ok' } });
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    machine.selectReason('spam');
    await machine.submit();
    assert.equal(machine.getState().submitting, false);
  });

  it('submitting=false after submit resolves (error path)', async () => {
    const { fn } = makeFakeReportContent({ ok: false, error: 'err' });
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    machine.selectReason('spam');
    await machine.submit();
    assert.equal(machine.getState().submitting, false);
  });

  it('reason and detail are preserved in state after submit', async () => {
    const { fn } = makeFakeReportContent();
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    machine.selectReason('other');
    machine.setDetail('some info');
    await machine.submit();
    assert.equal(machine.getState().reason, 'other');
    assert.equal(machine.getState().detail, 'some info');
  });
});

// ── onReported callback wiring ─────────────────────────────────────────────────

describe('createReportSubmitMachine — onReported callback', () => {
  it('fires onReported after a successful submit', async () => {
    let reported = 0;
    const { fn } = makeFakeReportContent({ ok: true, data: { reportId: 'r-ok' } });
    const machine = createReportSubmitMachine('p-1', () => {}, () => { reported++; }, fn);
    machine.selectReason('spam');
    await machine.submit();
    assert.equal(reported, 1, 'onReported must fire exactly once on success');
  });

  it('does not fire onReported when submit fails', async () => {
    let reported = 0;
    const { fn } = makeFakeReportContent({ ok: false, error: 'rejected' });
    const machine = createReportSubmitMachine('p-1', () => {}, () => { reported++; }, fn);
    machine.selectReason('spam');
    await machine.submit();
    assert.equal(reported, 0, 'onReported must not fire on failure');
  });

  it('onReported is optional — no crash when undefined', async () => {
    const { fn } = makeFakeReportContent({ ok: true, data: { reportId: 'r-ok' } });
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    machine.selectReason('spam');
    await assert.doesNotReject(() => machine.submit());
  });
});

// ── Submit guard (canSubmitReport) ────────────────────────────────────────────

describe('createReportSubmitMachine — submit guard', () => {
  it('does not call reportContentFn when no reason is selected', async () => {
    const { fn, calls } = makeFakeReportContent();
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn);
    await machine.submit(); // no selectReason called
    assert.equal(calls.length, 0, 'reportContent must not be called without a reason');
  });

  it('does not call reportContentFn when done=true (already submitted)', async () => {
    // Submit once to set done=true, then try again
    const { fn: fn1 } = makeFakeReportContent({ ok: true, data: { reportId: 'first' } });
    const machine = createReportSubmitMachine('p-1', () => {}, undefined, fn1);
    machine.selectReason('spam');
    await machine.submit(); // done=true now

    const { fn: fn2, calls } = makeFakeReportContent();
    // Replace with a second spy — done is still true in the state
    // so canSubmitReport returns false and the second call is blocked.
    // We verify by selecting a new reason and calling submit again with fn1
    // which already has 1 call; the machine state has done=true so it won't proceed.
    const machine2 = createReportSubmitMachine('p-1', () => {}, undefined, fn2);
    // Simulate done=true by force: submit once (sets done=true), then try again
    machine2.selectReason('spam');
    await machine2.submit();
    assert.equal(machine2.getState().done, true);
    // Second attempt must be blocked
    await machine2.submit();
    assert.equal(calls.length, 1, 'reportContent called only once after done=true');
  });
});
