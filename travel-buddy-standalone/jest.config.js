'use strict';

module.exports = {
  // CI validation runs suites in parallel with heavy load; the 5s default
  // produced spurious one-off timeouts in otherwise-green files.
  testTimeout: 20000,
  preset: 'jest-expo',
  testMatch: [
    '<rootDir>/src/**/*.test.{ts,tsx}',
    '<rootDir>/app/**/*.test.{ts,tsx}',
  ],
  // Exclude src/test/ — those files are node:test runners (e.g. compassComponents,
  // stampGracefulDegradation) and crash Jest with "no tests found" or OOM when
  // Jest tries to load them as Jest suites.
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/src/test/',
    // *.webrender.test.* files run under jest.web.config.js (jest-expo/web,
    // react-dom) — the native renderer cannot commit their out-of-band
    // event-bus state updates (known React 19 renderer wall).
    '\\.webrender\\.test\\.',
  ],
  // Cap workers so the full component suite doesn't exhaust the heap.
  // Without this limit Jest spawns one worker per CPU and OOMs on large suites.
  maxWorkers: 1,
  // Restart the worker process when its idle heap exceeds the limit. jest-expo
  // suites leak heap across test files; a single capped worker keeps the whole
  // run inside container memory instead of being SIGTERM-killed by the OOM killer.
  workerIdleMemoryLimit: '1200MB',
  // React 19 + RNTL v14: sets globalThis.IS_REACT_ACT_ENVIRONMENT = true so
  // RNTL's act() saves/restores true instead of undefined between tests.
  setupFilesAfterEnv: ['<rootDir>/src/jest.setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|native-base|lucide-react-native|@sentry/.*)',
  ],
  moduleNameMapper: {
    // AsyncStorage's native module is null under jest; map every import to the
    // official jest mock so no test file needs a per-file jest.mock.
    '^@react-native-async-storage/async-storage$':
      '@react-native-async-storage/async-storage/jest/async-storage-mock',
    'lucide-react-native': '<rootDir>/src/__mocks__/lucide-react-native.tsx',
    'expo-router': '<rootDir>/src/__mocks__/expo-router.tsx',
    // maplibre requires native GL/camera modules unavailable in jest-expo.
    // The stub exports null-render components so screens using the map can be
    // tested without crashing the suite. Per-file jest.mock() factories
    // override this global stub when they need to assert on map behaviour.
    '^@maplibre/maplibre-react-native$':
      '<rootDir>/src/__mocks__/maplibre-react-native.tsx',
    // react-native-draggable-flatlist pulls gesture-handler / reanimated native
    // modules; stub it out so component tests can assert on list content.
    '^react-native-draggable-flatlist$':
      '<rootDir>/src/__mocks__/react-native-draggable-flatlist.tsx',
  },
};
