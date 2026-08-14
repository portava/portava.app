'use strict';

// Web-renderer Jest config (jest-expo/web → react-native-web + jsdom +
// react-dom). Exists because the jest-expo NATIVE React 19 renderer cannot
// commit out-of-band event-bus setState updates to the tree (the known
// renderer wall) — so on-screen assertions for realtime-driven UI (e.g. the
// CompassLive nudge card) run here against real react-dom instead.
//
// Only *.webrender.test.{ts,tsx} files run under this config; the main
// jest.config.js ignores them. Wired into `pnpm run test:component`.
// NOTE: preserved-by-design mirror file (flat node_modules layout) — the
// canonical twin lived at artifacts/travel-buddy/jest.web.config.js, archived
// at bc1bef404. There is no twin now; this file is the only one.
const base = require('./jest.config.js');

module.exports = {
  ...base,
  preset: 'jest-expo/web',
  testMatch: [
    '<rootDir>/src/**/*.webrender.test.{ts,tsx}',
    '<rootDir>/app/**/*.webrender.test.{ts,tsx}',
  ],
  testPathIgnorePatterns: ['/node_modules/'],
};
