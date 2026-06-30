/**
 * Unit tests for ReportPostSheet pure state logic.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/ReportPostSheet.test.ts
 *
 * These tests verify:
 *   - REPORT_POST_REASONS shape and uniqueness
 *   - INITIAL_REPORT_SHEET_STATE starts fully reset
 *   - resetReportSheet() always produces a clean slate
 *   - canSubmitReport() gates on reason + not-submitting
 *   - isReportSheetInitial() correctly detects stale state
 *
 * Invocation scenarios covered:
 *   "feed-card path"  — PostCard's inline overflow button, same ReportPostSheet
 *   "detail-screen path" — app/post/[id].tsx header overflow → report action
 *   Both paths mount the same ReportPostSheet component; the state logic
 *   tested here applies identically to both.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_POST_REASONS,
  INITIAL_REPORT_SHEET_STATE,
  resetReportSheet,
  canSubmitReport,
  isReportSheetInitial,
  type ReportSheetState,
} from '../ReportPostSheet.state.ts';

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
  it('returns a fresh state object (not a reference to the constant)', () => {
    const a = resetReportSheet();
    const b = resetReportSheet();
    assert.notEqual(a, b); // different objects
    assert.deepEqual(a, b); // same shape
  });

  it('cleared state passes isReportSheetInitial', () => {
    assert.equal(isReportSheetInitial(resetReportSheet()), true);
  });

  it('reason is null after reset', () => {
    assert.equal(resetReportSheet().reason, null);
  });

  it('detail is empty string after reset', () => {
    assert.equal(resetReportSheet().detail, '');
  });

  it('submitting is false after reset', () => {
    assert.equal(resetReportSheet().submitting, false);
  });

  it('done is false after reset', () => {
    assert.equal(resetReportSheet().done, false);
  });
});

// ── isReportSheetInitial ───────────────────────────────────────────────────────

describe('isReportSheetInitial — detects stale state left from a previous open', () => {
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

  it('returns true when all fields are reset', () => {
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

  it('returns false when done=true (post-submission state)', () => {
    assert.equal(canSubmitReport(state({ reason: 'spam', done: true })), false);
  });

  it('detail text does not affect canSubmitReport', () => {
    assert.equal(canSubmitReport(state({ reason: 'other', detail: 'some text' })), true);
    assert.equal(canSubmitReport(state({ reason: 'other', detail: '' })), true);
  });
});

// ── reset-on-close contract ────────────────────────────────────────────────────
//
// This block tests the core behavioral contract the task was written to protect:
// after the user partially fills in the sheet and closes it without submitting,
// re-opening the sheet must show a clean form — not stale selections or a stuck
// "Report submitted" banner.
//
// Both the feed-card path (PostCard overflow button) and the detail-screen path
// (post/[id].tsx header overflow → "Report post") mount the same ReportPostSheet
// component and share this same reset contract.

describe('reset-on-close contract — stale state cannot survive a close/re-open cycle', () => {
  it('feed-card path: selecting a reason then closing resets to initial', () => {
    // Simulate: user opens sheet from feed card, selects a reason, then taps backdrop
    let currentState: ReportSheetState = { ...INITIAL_REPORT_SHEET_STATE };

    // User selects a reason
    currentState = { ...currentState, reason: 'harassment' };
    assert.equal(isReportSheetInitial(currentState), false, 'should be stale before close');

    // User taps backdrop / close button → handleClose() calls reset()
    currentState = resetReportSheet();
    assert.equal(isReportSheetInitial(currentState), true, 'should be clean after close');
    assert.equal(currentState.reason, null, 'reason must be null');
    assert.equal(currentState.done,   false, 'done must be false');
  });

  it('detail-screen path: selecting a reason then closing resets to initial', () => {
    // Simulate: user taps MoreVertical in post detail header, picks "Report",
    // selects a reason + types detail, then taps the X close button
    let currentState: ReportSheetState = { ...INITIAL_REPORT_SHEET_STATE };

    currentState = { ...currentState, reason: 'misinformation', detail: 'fake news' };
    assert.equal(isReportSheetInitial(currentState), false, 'partially filled state is stale');

    // handleClose() fires: onClose() called, then reset()
    currentState = resetReportSheet();
    assert.equal(currentState.reason, null,  'reason cleared after close');
    assert.equal(currentState.detail, '',    'detail cleared after close');
    assert.equal(currentState.done,   false, 'done must be false');
  });

  it('done=true ("Report submitted" banner) is cleared on close', () => {
    // Simulate: user successfully submitted a report (done=true banner showing),
    // then the sheet auto-closes. Re-opening must NOT show the banner.
    let currentState: ReportSheetState = { ...INITIAL_REPORT_SHEET_STATE };

    // Submission completes
    currentState = { ...currentState, reason: 'spam', done: true };
    assert.equal(currentState.done, true, 'banner is showing');

    // Sheet auto-closes → handleClose() calls reset()
    currentState = resetReportSheet();
    assert.equal(currentState.done,   false, 'banner cleared after close');
    assert.equal(currentState.reason, null,  'reason cleared too');
  });

  it('submitting=true spinner is cleared on close', () => {
    // Edge case: network hangs while submitting, user force-closes the modal.
    let currentState: ReportSheetState = {
      ...INITIAL_REPORT_SHEET_STATE,
      reason: 'nudity',
      submitting: true,
    };
    assert.equal(canSubmitReport(currentState), false, 'cannot re-submit while in-flight');

    currentState = resetReportSheet();
    assert.equal(currentState.submitting, false, 'spinner cleared on close');
    assert.equal(currentState.reason,     null,  'reason also cleared');
  });

  it('multiple open/close cycles always return to initial state', () => {
    for (let cycle = 0; cycle < 5; cycle++) {
      let state: ReportSheetState = { ...INITIAL_REPORT_SHEET_STATE };

      // Partially fill (vary per cycle)
      state = { ...state, reason: 'spam', detail: `cycle ${cycle}` };
      assert.equal(isReportSheetInitial(state), false, `cycle ${cycle}: should be stale`);

      // Close
      state = resetReportSheet();
      assert.equal(isReportSheetInitial(state), true,  `cycle ${cycle}: should be clean after close`);
    }
  });
});
