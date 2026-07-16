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
  testMatch: ['<rootDir>/src/**/*.component.test.{ts,tsx}'],
  // Match both flat npm/yarn layout (node_modules/<pkg>) and pnpm's nested
  // layout (node_modules/.pnpm/<hash>/node_modules/<pkg>) with the optional
  // (.+/node_modules/) group.
  transformIgnorePatterns: [
    'node_modules/(?!(?:.+/node_modules/)?(?:' + TRANSFORM_ALLOW + '))',
  ],
  moduleNameMapper: {
    'lucide-react-native': '<rootDir>/src/__mocks__/lucide-react-native.tsx',
    'expo-router': '<rootDir>/src/__mocks__/expo-router.tsx',
  },
};
