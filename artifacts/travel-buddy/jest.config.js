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
  preset: 'jest-expo',
  testMatch: [
    '<rootDir>/src/**/*.component.test.{ts,tsx}',
    '<rootDir>/app/**/*.component.test.{ts,tsx}',
  ],
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
    // Resolve the @/ path alias used in source files (maps to the package root).
    // Without this, Jest cannot find @/components/... imports and test files
    // for screens that use @/ (e.g. Trips, Trip Detail) fail to load.
    '^@/(.*)$': '<rootDir>/$1',
  },
};
