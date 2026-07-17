---
name: Jest moduleNameMapper vs per-file mocks
description: Global moduleNameMapper entries clash with leftover per-file jest.mock factories that require the same mock module.
---
Rule: when wiring a module to its official jest mock via `moduleNameMapper`, delete every per-file `jest.mock('<module>', () => require('<mock-path>'))` for that module.

**Why:** With the mapper active, the per-file factory's `require` of the mock path recurses through jest's module resolution and throws `RangeError: Maximum call stack size exceeded` at suite load (seen with @react-native-async-storage/async-storage in travel-buddy-standalone).

**How to apply:** After adding a mapper entry, grep the test tree for the mock path (e.g. `async-storage-mock`) and strip redundant per-file mocks before running the suite.
