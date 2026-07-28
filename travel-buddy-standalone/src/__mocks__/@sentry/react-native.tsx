/**
 * Minimal @sentry/react-native mock for jest-expo.
 * The real package uses native modules unavailable in Jest; this stub
 * prevents import errors while keeping call-site behaviour deterministic.
 *
 * Uses plain no-op functions (not jest.fn()) so this file compiles cleanly
 * under the standalone typecheck (tsconfig.json excludes jest types).
 */

const noop = (..._args: any[]): any => undefined;

export const init = noop;
export const captureException = noop;
export const captureMessage = noop;
export const setUser = noop;
export const setTag = noop;
export const setExtra = noop;
export const addBreadcrumb = noop;
export const configureScope = noop;
export const withScope = (cb: (scope: any) => void): void => {
  cb({
    setUser: noop,
    setTag: noop,
    setExtra: noop,
    setLevel: noop,
    setContext: noop,
  });
};

export const wrap = (component: any): any => component;

export default {
  init,
  captureException,
  captureMessage,
  setUser,
  setTag,
  setExtra,
  addBreadcrumb,
  configureScope,
  withScope,
  wrap,
};
