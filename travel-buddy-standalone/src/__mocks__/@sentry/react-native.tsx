/**
 * Minimal @sentry/react-native stub for Jest.
 * The real package uses native modules unavailable in the test environment.
 * All exported functions are no-ops; Sentry.init() is a no-op stub.
 */
module.exports = {
  init: () => {},
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
  withScope: (_cb: (scope: any) => void) => {},
  setUser: () => {},
  setTag: () => {},
  setContext: () => {},
  setExtra: () => {},
  configureScope: () => {},
  getCurrentHub: () => ({ configureScope: () => {}, setUser: () => {} }),
};
