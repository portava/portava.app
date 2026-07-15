/**
 * Tests for guard-expo-router-duplicates.ts
 *
 * Uses Node.js built-in test runner (available since Node 18, stable in Node 20+).
 * Run:  pnpm --filter @workspace/scripts run test:routes-guard
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findConflicts } from './guard-expo-router-duplicates.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeFixture(base: string, files: string[]): void {
  for (const rel of files) {
    const full = join(base, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, `// fixture: ${rel}\n`);
  }
}

function runGuard(appDir: string, env: Record<string, string> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const scriptPath = new URL('./guard-expo-router-duplicates.ts', import.meta.url).pathname;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', scriptPath, appDir],
    { env: { ...process.env, ...env }, encoding: 'utf8' },
  );
  return {
    status: result.status ?? (result.signal ? 1 : 0),
    stdout: (result.stdout as string) ?? '',
    stderr: (result.stderr as string) ?? '',
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('guard-expo-router-duplicates', () => {
  let tmpBase: string;

  before(() => {
    tmpBase = join(tmpdir(), `expo-guard-test-${Date.now()}`);
    mkdirSync(tmpBase, { recursive: true });
  });

  after(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  // ── 1: single .tsx, no conflict ─────────────────────────────────────────
  test('no conflict when only a .tsx file exists', async () => {
    const dir = join(tmpBase, 'case1');
    makeFixture(dir, ['app/login.tsx']);

    const conflicts = await findConflicts(join(dir, 'app'));
    assert.equal(conflicts.length, 0, 'should report 0 conflicts');
  });

  // ── 2: .js-only, no conflict ─────────────────────────────────────────────
  test('no conflict when only a .js file exists (no TS duplicate)', async () => {
    const dir = join(tmpBase, 'case2');
    makeFixture(dir, ['app/help.js']);

    const conflicts = await findConflicts(join(dir, 'app'));
    assert.equal(conflicts.length, 0, 'should report 0 conflicts');
  });

  // ── 3: .tsx + .js conflict ─────────────────────────────────────────────
  test('detects .tsx + .js conflict and keeps .tsx', async () => {
    const dir = join(tmpBase, 'case3');
    makeFixture(dir, [
      'app/(auth)/_layout.tsx',
      'app/(auth)/_layout.js',
    ]);

    const conflicts = await findConflicts(join(dir, 'app'));
    assert.equal(conflicts.length, 1, 'should report 1 conflict');
    assert.ok(conflicts[0].keep.endsWith('_layout.tsx'), 'should keep .tsx');
    assert.equal(conflicts[0].dupes.length, 1, 'should have 1 dupe');
    assert.ok(conflicts[0].dupes[0].endsWith('_layout.js'), 'dupe should be .js');
  });

  // ── 4: guard CLI fails in normal mode when conflict exists ──────────────
  test('CLI exits 1 in normal mode when conflict detected', () => {
    const dir = join(tmpBase, 'case4');
    makeFixture(dir, ['app/login.tsx', 'app/login.js']);

    const result = runGuard(join(dir, 'app'));
    assert.equal(result.status, 1, 'should exit 1');
    assert.ok(
      result.stdout.includes('CONFLICT') || result.stderr.includes('CONFLICT') ||
      result.stdout.includes('conflict') || result.stderr.includes('conflict'),
      'should mention conflict',
    );
  });

  // ── 5: .tsx + .jsx conflict — keeps .tsx ────────────────────────────────
  test('detects .tsx + .jsx conflict and keeps .tsx', async () => {
    const dir = join(tmpBase, 'case5');
    makeFixture(dir, [
      'app/profile/index.tsx',
      'app/profile/index.jsx',
    ]);

    const conflicts = await findConflicts(join(dir, 'app'));
    assert.equal(conflicts.length, 1);
    assert.ok(conflicts[0].keep.endsWith('index.tsx'));
    assert.ok(conflicts[0].dupes[0].endsWith('index.jsx'));
  });

  // ── 6: self-heal mode quarantines .js and keeps .tsx ────────────────────
  test('self-heal mode quarantines lower-priority duplicate', () => {
    const dir = join(tmpBase, 'case6');
    makeFixture(dir, [
      'app/(auth)/_layout.tsx',
      'app/(auth)/_layout.js',
    ]);

    const result = runGuard(join(dir, 'app'), { SELF_HEAL_EXPO_ROUTES: '1' });
    assert.equal(result.status, 0, 'should exit 0 after self-heal');

    const tsxStillExists = existsSync(join(dir, 'app', '(auth)', '_layout.tsx'));
    const jsRemoved = !existsSync(join(dir, 'app', '(auth)', '_layout.js'));
    assert.ok(tsxStillExists, '.tsx should still exist');
    assert.ok(jsRemoved, '.js should have been quarantined');
    assert.ok(result.stdout.includes('QUARANTINE'), 'should report quarantine');
  });

  // ── 7: multiple conflicts all reported ──────────────────────────────────
  test('reports all conflict groups', async () => {
    const dir = join(tmpBase, 'case7');
    makeFixture(dir, [
      'app/index.tsx',
      'app/index.js',
      'app/(tabs)/_layout.tsx',
      'app/(tabs)/_layout.js',
      'app/profile.tsx',     // no duplicate — should not appear
    ]);

    const conflicts = await findConflicts(join(dir, 'app'));
    assert.equal(conflicts.length, 2, 'should report 2 conflict groups');
  });

  // ── 8: guard CLI passes when no conflicts ───────────────────────────────
  test('CLI exits 0 when no conflicts', () => {
    const dir = join(tmpBase, 'case8');
    makeFixture(dir, ['app/index.tsx', 'app/login.tsx', 'app/help.js']);

    const result = runGuard(join(dir, 'app'));
    assert.equal(result.status, 0, 'should exit 0');
    assert.ok(result.stdout.includes('all clear') || result.stdout.includes('No duplicate'));
  });
});
