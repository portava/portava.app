/**
 * Tests for sync-standalone.sh --check-source
 *
 * Verifies that the source-drift check:
 *   - Exits 0 when artifacts/travel-buddy/ and travel-buddy-standalone/ are
 *     identical for all checked directories.
 *   - Exits non-zero when any of the newly covered directories (docs,
 *     migrations, scripts, server) diverge between the two trees.
 *
 * Uses Node.js built-in test runner (Node 20+).
 * Run:  pnpm --filter @workspace/scripts run test:sync-check
 *
 * The script under test honours the SYNC_STANDALONE_REPO_ROOT env var so we
 * can redirect it at a throwaway temp workspace without touching the real repo.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// pnpm-lock.yaml v9 fixture builder
//
// Builds a minimal but structurally accurate pnpm-lock.yaml with a single
// importer block. The parser uses 2/4/6/8-space indentation so the fixture
// must match exactly.
// ---------------------------------------------------------------------------
type DepMap = Record<string, string>; // pkg → resolved version

function buildLockfile(importerKey: string, deps: DepMap = {}, devDeps: DepMap = {}): string {
  const lines: string[] = [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    `  ${importerKey}:`,
  ];

  const addSection = (label: string, map: DepMap) => {
    const pkgs = Object.keys(map);
    if (pkgs.length === 0) return;
    lines.push(`    ${label}:`);
    for (const pkg of pkgs) {
      lines.push(`      ${pkg}:`);
      lines.push(`        specifier: '*'`);
      lines.push(`        version: ${map[pkg]}`);
    }
  };

  addSection('dependencies', deps);
  addSection('devDependencies', devDeps);

  lines.push('', 'packages:', '');
  return lines.join('\n');
}

// Absolute path to the script under test.
const SYNC_SCRIPT = resolve(
  new URL('../../scripts/sync-standalone.sh', import.meta.url).pathname,
);

// ── helpers ──────────────────────────────────────────────────────────────────

function file(path: string, content = '-- fixture\n'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function runCheckLockfile(
  repoRoot: string,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SYNC_SCRIPT, '--check-lockfile'], {
    encoding: 'utf8',
    env: { ...process.env, SYNC_STANDALONE_REPO_ROOT: repoRoot },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runCheckSource(
  repoRoot: string,
  sourceDriftDirs?: string,
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SYNC_STANDALONE_REPO_ROOT: repoRoot,
  };
  if (sourceDriftDirs !== undefined) {
    env['SOURCE_DRIFT_DIRS'] = sourceDriftDirs;
  }
  const r = spawnSync('bash', [SYNC_SCRIPT, '--check-source'], {
    encoding: 'utf8',
    env,
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

// ── suite ────────────────────────────────────────────────────────────────────

describe('sync-standalone.sh --check-source', () => {
  let tmpBase: string;

  before(() => {
    tmpBase = join(tmpdir(), `sync-check-test-${Date.now()}`);
    mkdirSync(tmpBase, { recursive: true });
  });

  after(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  function makeCase(name: string): { src: string; dst: string; root: string } {
    const root = join(tmpBase, name);
    const src = join(root, 'artifacts', 'travel-buddy');
    const dst = join(root, 'travel-buddy-standalone');
    mkdirSync(src, { recursive: true });
    mkdirSync(dst, { recursive: true });
    return { src, dst, root };
  }

  // ── green path ─────────────────────────────────────────────────────────────

  test('exits 0 when all checked directories are identical', () => {
    const { src, dst, root } = makeCase('green');
    const dirs = ['docs', 'migrations', 'scripts', 'server'];
    for (const dir of dirs) {
      file(join(src, dir, 'same.sql'));
      file(join(dst, dir, 'same.sql'));
    }

    const result = runCheckSource(root, dirs.join(' '));

    assert.equal(
      result.status,
      0,
      `Expected exit 0 (no drift) but got ${result.status}.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('PASS'),
      `Expected "PASS" in output.\nStdout:\n${result.stdout}`,
    );
  });

  // ── per-directory drift tests ───────────────────────────────────────────────
  // Each test introduces a file that exists in source but not in standalone,
  // which is the simplest form of divergence.

  const driftCases: Array<{ dir: string; description: string }> = [
    { dir: 'docs', description: 'new .md file added to source docs/' },
    { dir: 'migrations', description: 'new .sql file added to source migrations/' },
    { dir: 'scripts', description: 'new script added to source scripts/' },
    { dir: 'server', description: 'new file added to source server/' },
  ];

  for (const { dir, description } of driftCases) {
    test(`exits non-zero when ${dir}/ diverges (${description})`, () => {
      const caseName = `drift-${dir}`;
      const { src, dst, root } = makeCase(caseName);
      const allDirs = ['docs', 'migrations', 'scripts', 'server'];

      // Identical baseline in every dir
      for (const d of allDirs) {
        file(join(src, d, 'baseline.sql'));
        file(join(dst, d, 'baseline.sql'));
      }

      // Introduce a deliberate one-line diff in the target dir:
      // a new file present only in source, absent from standalone.
      file(join(src, dir, 'drift-only-in-source.sql'), '-- deliberate drift\n');

      const result = runCheckSource(root, allDirs.join(' '));

      assert.notEqual(
        result.status,
        0,
        `Expected non-zero exit for drift in ${dir}/ but got 0.\nStdout:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes('FAIL'),
        `Expected "FAIL" in output for ${dir}/ drift.\nStdout:\n${result.stdout}`,
      );
    });
  }

  // ── modified-file drift (not just missing) ─────────────────────────────────

  test('exits non-zero when a file is present on both sides but contents differ', () => {
    const { src, dst, root } = makeCase('modified-file');
    const dir = 'migrations';
    file(join(src, dir, 'shared.sql'), '-- version A\n');
    file(join(dst, dir, 'shared.sql'), '-- version B (modified)\n');

    const result = runCheckSource(root, dir);

    assert.notEqual(
      result.status,
      0,
      `Expected non-zero exit for modified file drift but got 0.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('FAIL'),
      `Expected "FAIL" in output.\nStdout:\n${result.stdout}`,
    );
  });

  // ── stale-file drift (standalone has file that source removed) ─────────────

  test('exits non-zero when standalone has a file that source no longer contains', () => {
    const { src, dst, root } = makeCase('stale-in-standalone');
    const dir = 'server';
    file(join(src, dir, 'active.ts'), 'export {};\n');
    file(join(dst, dir, 'active.ts'), 'export {};\n');
    // Standalone has an extra file that source removed
    file(join(dst, dir, 'stale-removed-from-source.ts'), 'export {};\n');

    const result = runCheckSource(root, dir);

    assert.notEqual(
      result.status,
      0,
      `Expected non-zero exit for stale file in standalone but got 0.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('FAIL'),
      `Expected "FAIL" in output.\nStdout:\n${result.stdout}`,
    );
  });

  // ── SOURCE_DRIFT_THRESHOLD grace margin ────────────────────────────────────

  test('exits 0 when drift count is within SOURCE_DRIFT_THRESHOLD', () => {
    const { src, dst, root } = makeCase('threshold');
    const dir = 'docs';
    file(join(src, dir, 'base.md'));
    file(join(dst, dir, 'base.md'));
    // 1 drifted file
    file(join(src, dir, 'new-doc.md'), '# new\n');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SYNC_STANDALONE_REPO_ROOT: root,
      SOURCE_DRIFT_DIRS: dir,
      SOURCE_DRIFT_THRESHOLD: '1',
    };
    const r = spawnSync('bash', [SYNC_SCRIPT, '--check-source'], {
      encoding: 'utf8',
      env,
    });

    assert.equal(
      r.status ?? 1,
      0,
      `Expected exit 0 (1 drift ≤ threshold 1) but got ${r.status}.\nStdout:\n${r.stdout}`,
    );
    assert.ok(
      (r.stdout ?? '').includes('PASS'),
      `Expected "PASS" in output.\nStdout:\n${r.stdout}`,
    );
  });
});

// ── sync-standalone.sh --check-lockfile ──────────────────────────────────────

describe('sync-standalone.sh --check-lockfile', () => {
  let tmpBase: string;

  before(() => {
    tmpBase = join(tmpdir(), `lockfile-check-test-${Date.now()}`);
    mkdirSync(tmpBase, { recursive: true });
  });

  after(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  function makeCase(name: string): { root: string; standaloneDir: string } {
    const root = join(tmpBase, name);
    const standaloneDir = join(root, 'travel-buddy-standalone');
    mkdirSync(join(root, 'artifacts', 'travel-buddy'), { recursive: true });
    mkdirSync(standaloneDir, { recursive: true });
    return { root, standaloneDir };
  }

  function writeLockfiles(
    root: string,
    standaloneDir: string,
    monoDeps: DepMap,
    monoDevDeps: DepMap,
    standaloneDeps: DepMap,
    standaloneDevDeps: DepMap,
  ): void {
    writeFileSync(
      join(root, 'pnpm-lock.yaml'),
      buildLockfile('artifacts/travel-buddy', monoDeps, monoDevDeps),
    );
    writeFileSync(
      join(standaloneDir, 'pnpm-lock.yaml'),
      buildLockfile('.', standaloneDeps, standaloneDevDeps),
    );
  }

  // ── green path ─────────────────────────────────────────────────────────────

  test('exits 0 when all shared direct deps resolve to the same version', () => {
    const { root, standaloneDir } = makeCase('green');
    writeLockfiles(
      root,
      standaloneDir,
      { expo: '54.0.35', react: '19.1.0' },
      { typescript: '5.9.3' },
      { expo: '54.0.35', react: '19.1.0' },
      { typescript: '5.9.3' },
    );

    const result = runCheckLockfile(root);

    assert.equal(
      result.status,
      0,
      `Expected exit 0 but got ${result.status}.\nStdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('PASS'),
      `Expected "PASS" in stdout.\nStdout:\n${result.stdout}`,
    );
  });

  // ── version mismatch ───────────────────────────────────────────────────────

  test('exits non-zero when a shared dep resolves to a different version', () => {
    const { root, standaloneDir } = makeCase('mismatch');
    writeLockfiles(
      root,
      standaloneDir,
      { expo: '54.0.35', react: '19.1.0' },
      {},
      { expo: '54.0.10', react: '19.1.0' }, // expo resolves differently
      {},
    );

    const result = runCheckLockfile(root);

    assert.notEqual(
      result.status,
      0,
      `Expected non-zero exit for version mismatch but got 0.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('FAIL'),
      `Expected "FAIL" in stdout.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('expo'),
      `Expected mismatch report to mention "expo".\nStdout:\n${result.stdout}`,
    );
  });

  // ── missing from standalone lockfile ───────────────────────────────────────

  test('exits non-zero when a monorepo dep is absent from the standalone lockfile', () => {
    const { root, standaloneDir } = makeCase('missing');
    writeLockfiles(
      root,
      standaloneDir,
      { expo: '54.0.35', 'react-native': '0.75.0' },
      {},
      { expo: '54.0.35' }, // react-native missing from standalone
      {},
    );

    const result = runCheckLockfile(root);

    assert.notEqual(
      result.status,
      0,
      `Expected non-zero exit for missing dep but got 0.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('FAIL'),
      `Expected "FAIL" in stdout.\nStdout:\n${result.stdout}`,
    );
  });

  // ── standalone-only deps are informational only ────────────────────────────

  test('exits 0 when standalone has extra deps not in the monorepo app', () => {
    const { root, standaloneDir } = makeCase('standalone-only');
    writeLockfiles(
      root,
      standaloneDir,
      { expo: '54.0.35' },
      {},
      { expo: '54.0.35', 'standalone-only-pkg': '1.0.0' }, // extra dep OK
      {},
    );

    const result = runCheckLockfile(root);

    assert.equal(
      result.status,
      0,
      `Expected exit 0 (standalone-only deps are not a failure) but got ${result.status}.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('PASS'),
      `Expected "PASS" in stdout.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('standalone-only'),
      `Expected standalone-only informational note.\nStdout:\n${result.stdout}`,
    );
  });

  // ── devDependency mismatch also fails ──────────────────────────────────────

  test('exits non-zero when a shared devDependency resolves to a different version', () => {
    const { root, standaloneDir } = makeCase('devdep-mismatch');
    writeLockfiles(
      root,
      standaloneDir,
      {},
      { typescript: '5.9.3' },
      {},
      { typescript: '5.8.0' }, // devDep resolves differently
    );

    const result = runCheckLockfile(root);

    assert.notEqual(
      result.status,
      0,
      `Expected non-zero exit for devDep mismatch but got 0.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('FAIL'),
      `Expected "FAIL" in stdout.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('typescript'),
      `Expected mismatch report to mention "typescript".\nStdout:\n${result.stdout}`,
    );
  });
});
