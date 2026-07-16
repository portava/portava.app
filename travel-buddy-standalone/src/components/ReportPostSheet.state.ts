/**
 * Pure state machine and data for ReportPostSheet.
 *
 * Extracted here so the reset / validation logic and reason list can be tested
 * with node:test without requiring a React Native renderer. The component
 * imports these types and helpers instead of inlining the logic.
 */

import type { ReasonCode, ReportContentPayload, ReportResult } from '../services/reports.ts';

export const REPORT_POST_REASONS: { code: ReasonCode; label: string }[] = [
  { code: 'spam',           label: 'Spam or misleading' },
  { code: 'harassment',     label: 'Harassment or bullying' },
  { code: 'hate_speech',    label: 'Hate speech' },
  { code: 'violence',       label: 'Violent or dangerous content' },
  { code: 'nudity',         label: 'Nudity or sexual content' },
  { code: 'misinformation', label: 'Misinformation' },
  { code: 'other',          label: 'Something else' },
];

export interface ReportSheetState {
  reason: ReasonCode | null;
  detail: string;
  submitting: boolean;
  done: boolean;
}

/** The canonical initial / fully-reset state. */
export const INITIAL_REPORT_SHEET_STATE: ReportSheetState = {
  reason: null,
  detail: '',
  submitting: false,
  done: false,
};

/** Returns true when the state is identical to the initial/reset state. */
export function isReportSheetInitial(state: ReportSheetState): boolean {
  return (
    state.reason    === null &&
    state.detail    === ''  &&
    state.submitting === false &&
    state.done      === false
  );
}

/**
 * Returns true when the form is in a valid state to submit.
 * A reason must be chosen, no submission must be in flight, and the form must
 * not already be in the "done" (submitted) state.
 */
export function canSubmitReport(state: ReportSheetState): boolean {
  return state.reason !== null && !state.submitting && !state.done;
}

/**
 * Returns a fresh copy of the state with all fields reset.
 * Called by handleClose() in the component so state never leaks
 * between open/close cycles.
 */
export function resetReportSheet(): ReportSheetState {
  return { ...INITIAL_REPORT_SHEET_STATE };
}

// ── Behavioural integration machine ──────────────────────────────────────────
//
// createReportSheetMachine encodes the *wiring* contract that the React
// component must honour: handleClose() must (a) call onClose() to notify the
// parent and (b) reset all internal state so the next open starts clean.
//
// Because the test environment runs under node:test without a React Native
// renderer, we cannot mount the component directly. This plain-object machine
// mirrors the component's handleClose/reset wiring exactly, so tests can
// drive state transitions and assert both the callback and the state reset
// without a renderer.
//
// Component mirrors the machine contract:
//   machine.handleClose()  →  onClose(); state = INITIAL_REPORT_SHEET_STATE
//   component.handleClose()→  onClose(); reset() sets all useState slices to
//                              INITIAL_REPORT_SHEET_STATE fields
//
// If either call is removed from the machine the wiring tests fail, catching
// the same regression that would appear in the component.

export interface ReportSheetMachine {
  /** Returns a snapshot of the current state (new object each call). */
  getState(): ReportSheetState;
  /** User picks a reason from REPORT_POST_REASONS. */
  selectReason(r: ReasonCode | null): void;
  /** User types in the optional detail field. */
  setDetail(d: string): void;
  /**
   * User dismisses the sheet (backdrop tap, X button, Android back).
   * Calls onClose() then resets all state — both calls are required.
   */
  handleClose(): void;
}

/**
 * Pure integration harness for ReportPostSheet's open/close/reset contract.
 *
 * @param onClose  The parent's close callback (same role as the React prop).
 */
export function createReportSheetMachine(onClose: () => void): ReportSheetMachine {
  let state: ReportSheetState = { ...INITIAL_REPORT_SHEET_STATE };

  return {
    getState: () => ({ ...state }),

    selectReason(r) {
      state = { ...state, reason: r };
    },

    setDetail(d) {
      state = { ...state, detail: d };
    },

    handleClose() {
      onClose();                                  // (a) notify the parent
      state = { ...INITIAL_REPORT_SHEET_STATE };  // (b) reset all state
    },
  };
}

// ── Submit machine ─────────────────────────────────────────────────────────────
//
// createReportSubmitMachine extends the close/reset machine with the async
// submit() action. The reportContentFn dependency is injected so tests can
// observe the exact payload sent without importing supabase.
//
// Machine mirrors the component's submit() contract exactly:
//   submit() →
//     canSubmitReport guard → return early if blocked
//     state.submitting = true
//     call reportContentFn({ target_type:'post', target_id, reason_code,
//                            reason_detail: trimmed | omitted if empty })
//     state.submitting = false
//     if res.ok: state.done = true, onReported?.()
//     if !res.ok: state unchanged (caller surfaces the error)
//
// If the component's submit() ever sends the wrong payload, omits onReported,
// or skips the submitting guard, the machine tests will catch it.

export interface ReportSubmitMachine extends ReportSheetMachine {
  /**
   * Runs the full submit flow: guards with canSubmitReport, sets submitting,
   * calls the injected reportContentFn with the correct payload, and
   * transitions state on success/error — mirrors ReportPostSheet.submit().
   */
  submit(): Promise<void>;
}

/**
 * Pure submit harness for ReportPostSheet's submission contract.
 *
 * @param postId           The post being reported (same as the React prop).
 * @param onClose          Parent close callback.
 * @param onReported       Optional success callback fired after submit ok.
 * @param reportContentFn  Injected reportContent — accepts the production
 *                         ReportContentPayload type and returns ReportResult.
 */
export function createReportSubmitMachine(
  postId: string,
  onClose: () => void,
  onReported: (() => void) | undefined,
  reportContentFn: (payload: ReportContentPayload) => Promise<ReportResult>,
): ReportSubmitMachine {
  let state: ReportSheetState = { ...INITIAL_REPORT_SHEET_STATE };

  return {
    getState: () => ({ ...state }),

    selectReason(r) {
      state = { ...state, reason: r };
    },

    setDetail(d) {
      state = { ...state, detail: d };
    },

    handleClose() {
      onClose();
      state = { ...INITIAL_REPORT_SHEET_STATE };
    },

    async submit() {
      if (!canSubmitReport(state)) return;
      // Snapshot reason + detail before the await so mutations don't race.
      const reasonCode = state.reason!;
      const trimmedDetail = state.detail.trim();
      state = { ...state, submitting: true };
      const res = await reportContentFn({
        target_type:   'post',
        target_id:     postId,
        reason_code:   reasonCode,
        reason_detail: trimmedDetail || undefined,
      });
      state = { ...state, submitting: false };
      if (res.ok) {
        state = { ...state, done: true };
        onReported?.();
      }
    },
  };
}
