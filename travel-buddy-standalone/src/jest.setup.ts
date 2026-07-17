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
 * See src/components/__tests__/TESTING.md for the companion rule: never wrap
 * an Alert button's onPress handler in act().
 */
// This file runs only under jest, but it's included in the app tsconfig
// (it isn't a *.test.* file), and @types/jest isn't installed app-wide.
declare const jest: { mock: (moduleName: string, factory: () => unknown) => void };

// Global mock for AsyncStorage: the real module's NativeModule is null under
// jest, so any service importing it would crash the suite. With this mock in
// place, service modules like discoveryBookmarks become requireActual-safe.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export {};
