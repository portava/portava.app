/**
 * Minimal stub for @sentry/react-native.
 *
 * Uses plain no-op functions (not jest.fn()) so this file compiles cleanly
 * under the app tsconfig. Tests that need to assert on Sentry calls should
 * re-mock individual exports inside the test file.
 *
 * Stubs every symbol used by crashReporter.ts and any other module that
 * imports @sentry/react-native, so component tests don't crash due to the
 * real SDK's ESM syntax and unavailable native modules.
 */

export const init = (_options: unknown) => {};
export const captureException = (_error: unknown, _hint?: unknown) => '';
export const captureMessage = (_message: string, _level?: unknown) => '';
export const addBreadcrumb = (_breadcrumb: unknown) => {};
export const setUser = (_user: unknown) => {};
export const setTag = (_key: string, _value: unknown) => {};
export const setExtra = (_key: string, _extra: unknown) => {};
export const setContext = (_name: string, _context: unknown) => {};

export const withScope = (cb: (scope: {
  setUser: (_u: unknown) => void;
  setExtra: (_k: string, _v: unknown) => void;
  setTag: (_k: string, _v: unknown) => void;
  setContext: (_n: string, _c: unknown) => void;
  setLevel: (_l: unknown) => void;
}) => void) => {
  cb({
    setUser: () => {},
    setExtra: () => {},
    setTag: () => {},
    setContext: () => {},
    setLevel: () => {},
  });
};

export const startTransaction = (_ctx: unknown) => ({ finish: () => {}, setTag: () => {} });
export const getCurrentHub = () => ({ getScope: () => ({ setTag: () => {} }) });

export const wrap = (component: unknown) => component;

export const ReactNativeTracing = class {};
export const ReactNavigationInstrumentation = class {};
export const ErrorBoundary = ({ children }: { children: React.ReactNode }) => children;
export const TouchEventBoundary = ({ children }: { children: React.ReactNode }) => children;

export default {
  init,
  captureException,
  captureMessage,
  addBreadcrumb,
  setUser,
  setTag,
  setExtra,
  setContext,
  withScope,
  startTransaction,
  getCurrentHub,
  wrap,
  ReactNativeTracing,
  ReactNavigationInstrumentation,
  ErrorBoundary,
  TouchEventBoundary,
};
