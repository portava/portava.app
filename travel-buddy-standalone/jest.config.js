'use strict';

module.exports = {
  preset: 'jest-expo',
  testMatch: [
    '<rootDir>/src/**/*.test.{ts,tsx}',
    '<rootDir>/app/**/*.test.{ts,tsx}',
  ],
  // React 19 + RNTL v14: sets globalThis.IS_REACT_ACT_ENVIRONMENT = true so
  // RNTL's act() saves/restores true instead of undefined between tests.
  setupFilesAfterEnv: ['<rootDir>/src/jest.setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|native-base|lucide-react-native)',
  ],
  moduleNameMapper: {
    // AsyncStorage's native module is null under jest; map every import to the
    // official jest mock so no test file needs a per-file jest.mock.
    '^@react-native-async-storage/async-storage$':
      '@react-native-async-storage/async-storage/jest/async-storage-mock',
    'lucide-react-native': '<rootDir>/src/__mocks__/lucide-react-native.tsx',
    'expo-router': '<rootDir>/src/__mocks__/expo-router.tsx',
  },
};
