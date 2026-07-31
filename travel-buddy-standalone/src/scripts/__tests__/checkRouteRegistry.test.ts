/**
 * Guard test — check-route-registry.mjs
 *
 * Verifies that the route-registry guard:
 *   - exits 1 and prints the expected error text when a .tsx file is present
 *     in app/ but has no matching path: entry in portavaRoutes.ts.
 *   - exits 0 and prints the ok message when every app/ screen and layout is
 *     registered correctly (happy path).
 *
 * Strategy: each case creates a temporary directory with an `app/` subtree and
 * a minimal `src/navigation/portavaRoutes.ts`, then runs the guard script with
 * that directory as cwd.  No real app/ or portavaRoutes.ts files are touched.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import process from 'node:process';

/** Absolute path to the guard script, resolved from the travel-buddy root. */
const GUARD_SCRIPT = join(process.cwd(), 'scripts/check-route-registry.mjs');

/**
 * Minimal portavaRoutes.ts content that registers exactly one screen and one
 * layout under app/.
 */
function makeRoutesTs(extraPaths: string[] = []): string {
  const extras = extraPaths.map((p) => `  { key: 'extra', path: '${p}', title: 'Extra', parent: null, icon: null, requiresAuth: false },`).join('\n');
  return `
export const PORTAVA_ROUTES = [
  { key: 'root', path: 'index', title: 'Entry', parent: null, icon: null, requiresAuth: false },
${extras}
];
export const PORTAVA_LAYOUT_FILES = [
  { key: 'root-layout', path: '_layout', title: 'Root', navigator: 'Stack', description: 'Root layout' },
];
`.trimStart();
}

/** Run the guard script in the given cwd, capturing output. */
function runGuard(cwd: string) {
  return spawnSync(process.execPath, [GUARD_SCRIPT], {
    cwd,
    encoding: 'utf8',
  });
}

/** Create a temp dir with the required app/ and src/navigation/ scaffolding. */
function makeTmpDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'route-registry-guard-'));
  mkdirSync(join(tmp, 'app'), { recursive: true });
  mkdirSync(join(tmp, 'src', 'navigation'), { recursive: true });
  return tmp;
}

describe('check-route-registry.mjs', () => {
  const tmps: string[] = [];

  after(() => {
    for (const d of tmps) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('exits 1 and reports the missing route when a screen file has no registry entry', () => {
    const tmp = makeTmpDir();
    tmps.push(tmp);

    // Write a portavaRoutes.ts that only registers `index` and `_layout`
    writeFileSync(join(tmp, 'src', 'navigation', 'portavaRoutes.ts'), makeRoutesTs());
    // Required registered files
    writeFileSync(join(tmp, 'app', 'index.tsx'), 'export default function Index() { return null; }');
    writeFileSync(join(tmp, 'app', '_layout.tsx'), 'export default function Layout() { return null; }');
    // Unregistered screen — the trigger
    writeFileSync(join(tmp, 'app', 'unregistered-screen.tsx'), 'export default function Unregistered() { return null; }');

    const result = runGuard(tmp);

    assert.equal(result.status, 1, 'expected exit code 1 for an unregistered screen file');

    const output = (result.stderr ?? '') + (result.stdout ?? '');
    assert.ok(
      output.includes('Route registry drift'),
      `expected "Route registry drift" in output, got:\n${output}`,
    );
    assert.ok(
      output.includes('unregistered-screen'),
      `expected the missing filename in the error output, got:\n${output}`,
    );
  });

  it('exits 1 and reports the missing layout when a _layout.tsx has no registry entry', () => {
    const tmp = makeTmpDir();
    tmps.push(tmp);

    // Write a portavaRoutes.ts that registers index and root _layout but NOT a nested layout
    writeFileSync(join(tmp, 'src', 'navigation', 'portavaRoutes.ts'), makeRoutesTs());
    writeFileSync(join(tmp, 'app', 'index.tsx'), 'export default function Index() { return null; }');
    writeFileSync(join(tmp, 'app', '_layout.tsx'), 'export default function Layout() { return null; }');
    // Add an unregistered sub-layout
    mkdirSync(join(tmp, 'app', '(tabs)'), { recursive: true });
    writeFileSync(join(tmp, 'app', '(tabs)', '_layout.tsx'), 'export default function TabsLayout() { return null; }');

    const result = runGuard(tmp);

    assert.equal(result.status, 1, 'expected exit code 1 for an unregistered layout file');

    const output = (result.stderr ?? '') + (result.stdout ?? '');
    assert.ok(
      output.includes('Layout registry drift'),
      `expected "Layout registry drift" in output, got:\n${output}`,
    );
    assert.ok(
      output.includes('(tabs)/_layout'),
      `expected the missing layout path in the error output, got:\n${output}`,
    );
  });

  it('exits 0 and prints the ok message when every screen and layout is registered', () => {
    const tmp = makeTmpDir();
    tmps.push(tmp);

    // portavaRoutes.ts that registers index, _layout, and an extra screen
    writeFileSync(
      join(tmp, 'src', 'navigation', 'portavaRoutes.ts'),
      makeRoutesTs(['registered-screen']),
    );
    writeFileSync(join(tmp, 'app', 'index.tsx'), 'export default function Index() { return null; }');
    writeFileSync(join(tmp, 'app', '_layout.tsx'), 'export default function Layout() { return null; }');
    writeFileSync(join(tmp, 'app', 'registered-screen.tsx'), 'export default function Registered() { return null; }');

    const result = runGuard(tmp);

    assert.equal(result.status, 0, `expected exit code 0 for a fully-registered tree; stderr:\n${result.stderr}`);

    const output = (result.stderr ?? '') + (result.stdout ?? '');
    assert.ok(
      output.includes('check-route-registry — OK'),
      `expected ok message, got:\n${output}`,
    );
  });

  it('exits 0 when app/ is empty (nothing to check)', () => {
    const tmp = makeTmpDir();
    tmps.push(tmp);

    // portavaRoutes.ts with no paths required — app/ has no .tsx files
    writeFileSync(join(tmp, 'src', 'navigation', 'portavaRoutes.ts'), makeRoutesTs());

    const result = runGuard(tmp);

    assert.equal(result.status, 0, `expected exit code 0 when app/ has no .tsx files; stderr:\n${result.stderr}`);
  });

  it('exits 0 for platform-specific siblings (.web.tsx, .native.tsx) — they are not independent routes', () => {
    const tmp = makeTmpDir();
    tmps.push(tmp);

    // Only the canonical index + layout are registered; the .web sibling is exempt
    writeFileSync(join(tmp, 'src', 'navigation', 'portavaRoutes.ts'), makeRoutesTs());
    writeFileSync(join(tmp, 'app', 'index.tsx'), 'export default function Index() { return null; }');
    writeFileSync(join(tmp, 'app', 'index.web.tsx'), 'export default function IndexWeb() { return null; }');
    writeFileSync(join(tmp, 'app', '_layout.tsx'), 'export default function Layout() { return null; }');

    const result = runGuard(tmp);

    assert.equal(
      result.status,
      0,
      `expected exit code 0 for platform-specific siblings; stderr:\n${result.stderr}`,
    );
  });

  it('exits 0 and ignores files inside __tests__ directories', () => {
    const tmp = makeTmpDir();
    tmps.push(tmp);

    writeFileSync(join(tmp, 'src', 'navigation', 'portavaRoutes.ts'), makeRoutesTs());
    writeFileSync(join(tmp, 'app', 'index.tsx'), 'export default function Index() { return null; }');
    writeFileSync(join(tmp, 'app', '_layout.tsx'), 'export default function Layout() { return null; }');
    // __tests__ file under app/ — should be ignored
    mkdirSync(join(tmp, 'app', '__tests__'), { recursive: true });
    writeFileSync(join(tmp, 'app', '__tests__', 'SomeScreen.test.tsx'), 'it("ok", () => {})');

    const result = runGuard(tmp);

    assert.equal(result.status, 0, `expected exit code 0; test files under __tests__ must be excluded; stderr:\n${result.stderr}`);
  });
});
