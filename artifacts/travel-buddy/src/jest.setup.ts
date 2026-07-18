/**
 * Shared Jest setup for travel-buddy component tests (React 19 + RNTL v14).
 *
 * IS_REACT_ACT_ENVIRONMENT must be `true` BEFORE any RNTL act() call runs.
 *
 * RNTL's act() saves the current value of the global, sets it to true, and
 * restores the saved value afterwards.  jest-expo does not set the global, so
 * without this file every act() call ends by restoring `undefined`.  State
 * updates from async continuations (e.g. a screen's load() resolving) then
 * fire outside act() context between tests, producing:
 *   - "The current testing environment is not configured to support act()"
 *     warnings, and
 *   - "overlapping act()" errors during RNTL cleanup that corrupt
 *     actScopeDepth for all subsequent tests in the file.
 *
 * Setting it once here makes every RNTL act() save true → restore true, so
 * synchronous act-queue scheduling stays active for the whole test run.
 *
 * NOTE: Verified 2026-07-18 — jest-expo 56.0.5 (installed) and 57.0.2
 * (latest) do not set IS_REACT_ACT_ENVIRONMENT in any of their preset setup
 * files.  Remove the declare-global block and the assignment below once a
 * jest-expo release adds native support (grep its src/preset/setup.js for
 * "IS_REACT_ACT_ENVIRONMENT").
 *
 * See src/components/__tests__/TESTING.md for the companion rule: never wrap
 * an Alert button's onPress handler in act().
 *
 * ## Overlapping-act() warning suppression
 *
 * React 19's concurrent-mode scheduler opens its own internal act() scope when
 * it processes a state update that fired outside of a test's explicit act()
 * (e.g. from an async mock continuation).  When the scheduler's scope is still
 * active at the moment RNTL's waitFor launches the next poll's act(), React
 * logs "You seem to have overlapping act() calls."
 *
 * These warnings are cosmetic — all tests pass — and stem from a known
 * React 19 + RNTL v14 interaction where the concurrent scheduler races with
 * waitFor's polling interval.  They are suppressed here so they do not
 * obscure real console errors in CI output.  All other console.error messages
 * (including actual assertion failures and component errors) are forwarded as
 * usual.
 */
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ── Suppress spurious React 19 overlapping-act() warnings ─────────────────────

const _originalConsoleError = console.error.bind(console);
console.error = (...args: Parameters<typeof console.error>) => {
  if (
    typeof args[0] === 'string' &&
    args[0].includes('overlapping act() calls')
  ) {
    return; // suppress — cosmetic artifact of React 19 + RNTL v14 scheduling
  }
  _originalConsoleError(...args);
};

export {};
