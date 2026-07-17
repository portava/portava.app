'use strict';

module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/*.component.test.{ts,tsx}'],
  setupFilesAfterEnv: ['<rootDir>/src/jest.setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|native-base|lucide-react-native)',
  ],
  moduleNameMapper: {
    'lucide-react-native': '<rootDir>/src/__mocks__/lucide-react-native.tsx',
  },
};
