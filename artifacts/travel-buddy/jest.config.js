'use strict';

// pnpm stores packages at node_modules/.pnpm/<pkg>/node_modules/<pkg>.
// Jest's transformIgnorePatterns must account for this nested structure;
// otherwise RN 0.81's ESM setup file and other ESM-only packages are
// executed without Babel transformation and fail with a syntax error.
const TRANSFORM_ALLOW = [
  '(jest-)?react-native',
  '@react-native',
  'expo(nent)?',
  '@expo(nent)?/.*',
  '@expo-google-fonts/.*',
  'react-navigation',
  '@react-navigation/.*',
  '@unimodules/.*',
  'unimodules',
  'native-base',
  'lucide-react-native',
].join('|');

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
  // Match both flat npm/yarn layout (node_modules/<pkg>) and pnpm's nested
  // layout (node_modules/.pnpm/<hash>/node_modules/<pkg>) with the optional
  // (.+/node_modules/) group.
  transformIgnorePatterns: [
    'node_modules/(?!(?:.+/node_modules/)?(?:' + TRANSFORM_ALLOW + '))',
  ],
  // React 19 + RNTL v14: sets globalThis.IS_REACT_ACT_ENVIRONMENT = true so
  // RNTL's act() saves/restores true instead of undefined between tests.
  // Companion rule: never wrap an Alert button's onPress in act() — see
  // src/components/__tests__/TESTING.md for both rules and the reasoning.
  setupFilesAfterEnv: ['<rootDir>/src/jest.setup.ts'],
  moduleNameMapper: {
    // AsyncStorage's native module is null under jest; map every import to the
    // official jest mock so no test file needs a per-file jest.mock.
    '^@react-native-async-storage/async-storage$':
      '@react-native-async-storage/async-storage/jest/async-storage-mock',
    'lucide-react-native': '<rootDir>/src/__mocks__/lucide-react-native.tsx',
    'expo-router': '<rootDir>/src/__mocks__/expo-router.tsx',
    // maplibre requires native GL/camera modules unavailable in jest-expo.
    // The stub exports null-render components so screens using the map can be
    // tested without crashing the suite.
    '^@maplibre/maplibre-react-native$':
      '<rootDir>/src/__mocks__/maplibre-react-native.tsx',
    // expo-av requires the native ExponentAV module unavailable in jest-expo.
    // Per-file jest.mock() factories (e.g. SharedVideoPlayer tests) override
    // this global stub when they need to assert on Video behaviour.
    '^expo-av$': '<rootDir>/src/__mocks__/expo-av.tsx',
    // expo-image requires native modules unavailable in jest-expo.
    // The stub renders a plain View with testID forwarded so snapshot tests
    // and getByTestId queries work. Per-file jest.mock factories override it.
    '^expo-image$': '<rootDir>/src/__mocks__/expo-image.tsx',
    // Resolve the @/ path alias used in source files (maps to the package root).
    // Without this, Jest cannot find @/components/... imports and test files
    // for screens that use @/ (e.g. Trips, Trip Detail) fail to load.
    '^@/(.*)$': '<rootDir>/$1',
    // react-native-draggable-flatlist pulls gesture-handler / reanimated native
    // modules; stub it out so component tests can assert on list content.
    '^react-native-draggable-flatlist$':
      '<rootDir>/src/__mocks__/react-native-draggable-flatlist.tsx',
    // jest-expo@56's setup.js requires expo-modules-core from its own nested
    // pnpm path where the package is not directly hoisted.  Pin the resolution
    // to the pnpm store copy so every jest.requireActual/jest.doMock call lands
    // on the same installed instance (expo-modules-core@3.0.30 for expo@54 /
    // react-native@0.81.5).
    '^expo-modules-core$': '<rootDir>/../../node_modules/.pnpm/expo-modules-core@3.0.30_react-native@0.81.5_@babel+core@7.29.7_@types+react@19.1.17_react@19.1.0__react@19.1.0/node_modules/expo-modules-core',
    '^expo-modules-core/(.*)$': '<rootDir>/../../node_modules/.pnpm/expo-modules-core@3.0.30_react-native@0.81.5_@babel+core@7.29.7_@types+react@19.1.17_react@19.1.0__react@19.1.0/node_modules/expo-modules-core/$1',
  },
};
