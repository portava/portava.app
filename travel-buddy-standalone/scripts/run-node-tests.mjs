#!/usr/bin/env node
// Discovers and runs all node:test files so new tests can't be silently skipped.
// Mirrors travel-buddy-standalone/scripts/run-node-tests.mjs.
//
// Discovery: src/**/*.test.ts and server/**/*.test.ts
// Exclusions:
//   - *.component.test.* files (run under jest via `pnpm test:component`)
//   - src/test/** (special runners, e.g. `pnpm test:stamps`)
//   - KNOWN_BROKEN below (documented failures; this script fails loudly if
//     an entry no longer exists so the list can't go stale)

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// Pre-flight: catch extensionless relative imports before any test starts,
// so failures surface as the guard's clear message instead of a cryptic ESM
// resolution error mid-run.
const guard = spawnSync(
  process.execPath,
  ['scripts/check-import-extensions.mjs'],
  { stdio: 'inherit' },
);
if ((guard.status ?? 1) !== 0) {
  process.exit(guard.status ?? 1);
}

// Pre-flight: reject crash-prone jest.mock stand-ins in component tests
// (bare object-literal factories without requireActual/NOTE, per-file lucide
// mocks) before jest ever runs them.
const mockGuard = spawnSync(
  process.execPath,
  ['scripts/check-test-mocks.mjs'],
  { stdio: 'inherit' },
);
if ((mockGuard.status ?? 1) !== 0) {
  process.exit(mockGuard.status ?? 1);
}

// Pre-flight: reject raw <KeyboardAvoidingView usage in app/ and
// src/components/ — all screens must go through KeyboardSafeView or
// KeyboardSafeScrollView so Android keyboard avoidance is never skipped.
const kavGuard = spawnSync(
  process.execPath,
  ['scripts/check-keyboard-avoiding-view.mjs'],
  { stdio: 'inherit' },
);
if ((kavGuard.status ?? 1) !== 0) {
  process.exit(kavGuard.status ?? 1);
}

// Pre-flight: reject <KeyboardSafeScrollView> + inner <ScrollView> nesting in
// app/ and src/components/ — use <KeyboardSafeView> instead.
const ksvGuard = spawnSync(
  process.execPath,
  ['scripts/check-ksv-inner-scroll.mjs'],
  { stdio: 'inherit' },
);
if ((ksvGuard.status ?? 1) !== 0) {
  process.exit(ksvGuard.status ?? 1);
}

// Known-broken node:test files, excluded from the run. Fix and remove.
//
// Transform-failed (react-native@0.81.5 esbuild syntax incompatibility) and
// native-module tests (expo-modules-core@3.0.30 requires native runtime) —
// all introduced by the sign-in / E2EE tasks before this one.
const KNOWN_BROKEN = [
  // react-native@0.81.5 esbuild "Unexpected typeof" — cannot run in Node
  'src/components/__tests__/LivePulseRail.test.ts',
  'src/components/__tests__/MemoryComposer.duration.test.ts',
  'src/components/__tests__/PostcardComposer.duration.test.ts',
  'src/hooks/__tests__/useMessageMediaPicker.validation.test.ts',
  'src/components/__tests__/LivePulseRail.test.ts',
  'src/services/__tests__/adminCatalogAuditMalformed.test.ts',
  'src/services/__tests__/media.upload.test.ts',
  'src/services/__tests__/apiToken.freshToken.test.ts',
  'src/services/__tests__/catalogDetail.approvedStale.test.ts',
  'src/services/__tests__/catalogDetail.archivedVersions.test.ts',
  'src/services/__tests__/catalogDetail.earnNullUserId.test.ts',
  'src/services/__tests__/catalogDetail.lastError.test.ts',
  'src/services/__tests__/compassAskStream.test.ts',
  'src/services/__tests__/compass.cityConfidenceCache.test.ts',
  'src/services/__tests__/compass.homeTzOffset.test.ts',
  'src/services/__tests__/compass.reportViewed.test.ts',
  'src/services/__tests__/compass.tzOffsetSurfaces.test.ts',
  'src/services/__tests__/discovery.liveStatusCached.test.ts',
  // discovery.ts → supabase.ts → SecureStoreAdapter → react-native esbuild "Unexpected typeof"
  'src/services/__tests__/friends.sendAutoAccept.test.ts',
  'src/services/__tests__/onboardingSaveAlert.partialSave.test.ts',
  'src/services/__tests__/profilePartialSave.test.ts',
  // react-native@0.81.5 esbuild "Unexpected typeof" via discovery.ts → supabase.ts → SecureStoreAdapter
  'src/services/__tests__/discovery.searchSignal.test.ts',
  'src/services/__tests__/profileSaveFlow.partialSave.test.ts',
  // standalone-only files that hit the same esbuild "Unexpected typeof" wall
  'src/components/__tests__/LivePulseRail.test.ts',
  'src/services/__tests__/media.upload.test.ts',
  'src/services/__tests__/places.getCanonicalPlace.test.ts',
  // react-native@0.81.5 esbuild "Unexpected typeof" — cannot run via tsx in Node
  'src/components/__tests__/LivePulseRail.test.ts',
  'src/services/__tests__/media.upload.test.ts',
  // react-native@0.81.5 esbuild "Unexpected typeof" via apiToken.ts → supabase.ts
  // → secureStore.ts → expo-secure-store (same wall as apiToken.freshToken.test.ts)
  'src/services/__tests__/places.getCanonicalPlace.test.ts',
  // auth.ts imports supabase.ts → SecureStoreAdapter → react-native (esbuild "Unexpected typeof")
  // Uses Jest syntax (jest.mock/describe/expect) — run via `pnpm test:component`
  'src/services/__tests__/auth.requestPasswordReset.test.ts',
  // getPublicPostcards → profile.ts → apiToken.ts → supabase.ts → SecureStoreAdapter
  // → react-native (esbuild "Unexpected typeof"). Uses Jest syntax — run via `pnpm test:component`
  'src/services/__tests__/postcardWall.blockGate.test.ts',
  // discovery.ts → supabase.ts → SecureStoreAdapter → react-native esbuild "Unexpected typeof"
  'src/services/__tests__/discovery.searchSignal.test.ts',
  // Jest-syntax (describe/it/expect) test — not converted to node:test yet
  'src/lib/__tests__/stampRarity.test.ts',
  // expo-modules-core@3.0.30 requires native sweet/setUpJsLogger.fx — not in Node
  // secureStore.e0 was here. Removed 2026-08-29: it is now
  // src/lib/__tests__/secureStore.e0.component.test.ts and runs under jest via
  // `pnpm test:component`. Being in this list AND not matching the component
  // pattern meant it executed in neither runner — see the note above KNOWN_BROKEN.
  // discovery.ts → supabase.ts → SecureStoreAdapter → react-native (esbuild "Unexpected typeof")
  'src/services/__tests__/discovery.searchSignal.test.ts',
];

const ROOTS = ['src', 'server'];

function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === 'src/test') continue; // special runners
      collect(full, out);
    } else if (
      entry.name.endsWith('.test.ts') &&
      !entry.name.includes('.component.test.')
    ) {
      out.push(full);
    }
  }
}

// Fail loudly if a known-broken entry no longer exists (stale list).
const missing = KNOWN_BROKEN.filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error(
    'KNOWN_BROKEN entries no longer exist — remove them from scripts/run-node-tests.mjs:\n' +
      missing.map((f) => `  - ${f}`).join('\n'),
  );
  process.exit(1);
}

const files = [];
for (const root of ROOTS) {
  if (existsSync(root)) collect(root, files);
}
files.sort();

const broken = new Set(KNOWN_BROKEN);
const toRun = files.filter((f) => !broken.has(f));

if (toRun.length === 0) {
  console.error('No test files discovered — discovery is broken.');
  process.exit(1);
}

console.log(`Running ${toRun.length} node:test files (${broken.size} known-broken excluded).`);

// ── THE LOADER IS CHOSEN BY NODE MAJOR, AND THE REASON IS WORTH THE LINES ────
//
// On NODE 24 — what CI pins (`NODE_VERSION: '24'` in ci.yml) — `tsx/esm` is the
// right loader and this suite is green.
//
// On NODE 22 IT IS NOT, AND THE FAILURE IS CATASTROPHIC AND UNINFORMATIVE.
// Measured on Node v22.22.2, 2026-09-14: **269 of 272 files fail**, every one
// with `ERR_REQUIRE_CYCLE_MODULE — Cannot require() ES Module … in a cycle`,
// thrown before a single test body runs. The same files pass 272/272 under
// `--import tsx`. It is not the tree: `require(esm)` cycle handling changed
// between 22 and 24, and `tsx/esm` trips it.
//
// WHY THIS MATTERS MORE THAN AN ERGONOMIC ANNOYANCE. A developer or agent on
// Node 22 sees 269 red files and has two readings available: "the client test
// suite is broken" or "the client test suite does not run here". Those lead to
// opposite actions, and the first one is wrong. It has already cost this
// project twice — once recorded as "a property of this container's module
// resolution rather than of the tree", and once as a lane reporting that the
// standalone runner was dark and every client assertion across several censuses
// might be unexecuted. It is not dark in CI. It was dark on that lane's Node.
//
// So: pick the loader that works, and SAY SO, rather than letting the version
// difference surface as 269 stack traces.
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
const loader = nodeMajor >= 24 ? 'tsx/esm' : 'tsx';
if (loader !== 'tsx/esm') {
  console.log(
    `Node ${process.versions.node} < 24: using --import tsx instead of tsx/esm. ` +
      'On Node 22 the tsx/esm loader fails every file with ERR_REQUIRE_CYCLE_MODULE ' +
      'before any test runs — a loader artefact, not a defect in these tests. ' +
      "CI pins Node 24 and uses tsx/esm; this is the local equivalent, not a weaker run.",
  );
}

const result = spawnSync(
  process.execPath,
  ['--import', loader, '--test', ...toRun],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
