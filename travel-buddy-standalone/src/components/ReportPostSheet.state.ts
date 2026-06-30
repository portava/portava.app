/**
 * Pure state machine and data for ReportPostSheet.
 *
 * Extracted here so the reset / validation logic and reason list can be tested
 * with node:test without requiring a React Native renderer. The component
 * imports these types and helpers instead of inlining the logic.
 */

import type { ReasonCode } from '../services/reports';

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
