#!/usr/bin/env node
/**
 * Regression tests for check-avatar-icon-sizing.mjs.
 *
 * Runs the guard in a subprocess against temporary fixture files written into
 * src/ so the real SCAN_ROOTS apply.  Each test case verifies that the guard
 * (a) exits 1 for a new violation, or (b) exits 0 when a token is used
 * correctly or a value is only in the allowlist.
 *
 * Run from travel-buddy-standalone/:
 *   node scripts/check-avatar-icon-sizing.test.mjs
 */

import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const GUARD = join(ROOT, 'scripts', 'check-avatar-icon-sizing.mjs');

let passed = 0;
let failed = 0;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Write a temp source file into src/, run the guard, remove the file. */
function runGuard(content) {
  const tmp = join(ROOT, 'src', '_test_avatar_sizing_TEMP.tsx');
  writeFileSync(tmp, content, 'utf8');
  try {
    execFileSync(process.execPath, [GUARD], { cwd: ROOT, stdio: 'pipe' });
    return { exitCode: 0 };
  } catch (e) {
    return { exitCode: e.status ?? 1, stderr: e.stderr?.toString() ?? '' };
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function expect(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

// ── dot-band tests (5-12px) ──────────────────────────────────────────────────

console.log('\n== DOT band (5–12px) ==');

{
  // Same-line 8px dot — must be caught
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
const styles = StyleSheet.create({
  liveDot: { width: 8, height: 8, borderRadius: 4 },
});
`);
  expect('same-line 8px dot → guard exits 1', exitCode, 1);
}

{
  // Multi-line 8px dot — must be caught (the reviewed gap)
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
const styles = StyleSheet.create({
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
`);
  expect('multi-line 8px dot → guard exits 1', exitCode, 1);
}

{
  // Same-line 6px dot — must be caught
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
const styles = StyleSheet.create({
  dot: { width: 6, height: 6, borderRadius: 3 },
});
`);
  expect('same-line 6px dot → guard exits 1', exitCode, 1);
}

{
  // Multi-line 6px dot — must be caught
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
const styles = StyleSheet.create({
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
`);
  expect('multi-line 6px dot → guard exits 1', exitCode, 1);
}

{
  // 10px dot — must be caught
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
const styles = StyleSheet.create({
  radioDot: { width: 10, height: 10, borderRadius: 5 },
});
`);
  expect('10px dot → guard exits 1', exitCode, 1);
}

{
  // 12px dot — must be caught
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
const styles = StyleSheet.create({
  onlineDot: { width: 12, height: 12, borderRadius: 6 },
});
`);
  expect('12px dot → guard exits 1', exitCode, 1);
}

{
  // dot.s8 token usage — must NOT be caught (no numeric literals)
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
import { dot } from '../theme/tokens.ts';
const styles = StyleSheet.create({
  liveDot: { width: dot.s8, height: dot.s8, borderRadius: dot.s8 / 2 },
});
`);
  expect('dot.s8 token usage → guard exits 0', exitCode, 0);
}

{
  // dot.s6 token usage — must NOT be caught
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
import { dot } from '../theme/tokens.ts';
const styles = StyleSheet.create({
  pageDot: { width: dot.s6, height: dot.s6, borderRadius: dot.s6 / 2 },
});
`);
  expect('dot.s6 token usage → guard exits 0', exitCode, 0);
}

// ── avatar-band tests (27–56px) ───────────────────────────────────────────────

console.log('\n== AVATAR band (27–56px) ==');

{
  // 36px avatar — must be caught
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
const styles = StyleSheet.create({
  avatar: { width: 36, height: 36, borderRadius: 18 },
});
`);
  expect('same-line 36px avatar → guard exits 1', exitCode, 1);
}

{
  // 37px avatar (between tokens) — must be caught by wide-band
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
const styles = StyleSheet.create({
  avatar: { width: 37, height: 37, borderRadius: 18.5 },
});
`);
  expect('37px off-token avatar → guard exits 1 (wide-band)', exitCode, 1);
}

{
  // avatar.s36 token — must NOT be caught
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
import { avatar } from '../theme/tokens.ts';
const styles = StyleSheet.create({
  av: { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2 },
});
`);
  expect('avatar.s36 token usage → guard exits 0', exitCode, 0);
}

// ── boundary / edge cases ─────────────────────────────────────────────────────

console.log('\n== Boundaries ==');

{
  // 4px below DOT_BAND_MIN — must NOT be caught (animation particles)
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
const dots = [{ width: 4, height: 4, borderRadius: 2 }];
`);
  expect('4px below DOT_BAND_MIN → guard exits 0', exitCode, 0);
}

{
  // 13px above DOT_BAND_MAX but below ICON_VALUES → must NOT be caught
  // (13 is not in DOT_BAND 5-12, not in ICON_VALUES 14/18/20/22/26, not in WIDE_BAND 27-56)
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
const styles = StyleSheet.create({
  oddDot: { width: 13, height: 13, borderRadius: 6.5 },
});
`);
  expect('13px above DOT_BAND_MAX → guard exits 0 (not a token range)', exitCode, 0);
}

{
  // Circle with no borderRadius — must NOT be caught (not a circular dot)
  const { exitCode } = runGuard(`
import { View, StyleSheet } from 'react-native';
const styles = StyleSheet.create({
  sq: { width: 8, height: 8 },
});
`);
  expect('8px square (no borderRadius) → guard exits 0', exitCode, 0);
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\ncheck-avatar-icon-sizing tests: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
