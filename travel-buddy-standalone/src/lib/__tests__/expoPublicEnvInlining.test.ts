/**
 * EXPO_PUBLIC_* values exist in a release build only where babel-preset-expo inlines them, and it inlines only a
 * plain `process.env.EXPO_PUBLIC_X` (or `process.env['EXPO_PUBLIC_X']`) member read. A read through a type cast,
 * `(process.env as any).EXPO_PUBLIC_X`, or a destructuring of process.env, survives into the bundle and is
 * undefined at runtime, so the request it builds goes to a relative URL. Three such API-base reads
 * (useActiveLocation, useLocationPreferences, services/location) shipped that way until 2026-10-21; they were
 * found in a built Release bundle, not by review.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const CAST_READ = /\(\s*process\.env\s+as\s+[^)]+\)\s*(?:\.|\[\s*['"])EXPO_PUBLIC_[A-Z0-9_]+/;
const DESTRUCTURED = /\{[^}]*\bEXPO_PUBLIC_[A-Z0-9_]+[^}]*\}\s*=\s*process\.env\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name) && !/\.test\.(ts|tsx|js)$/.test(name)) out.push(path);
  }
  return out;
}

describe('EXPO_PUBLIC_* reads are ones the release build can inline', () => {
  it('the patterns catch the shapes that are not inlined (control)', () => {
    assert.match('return (process.env as any).EXPO_PUBLIC_API_BASE_URL ?? "";', CAST_READ);
    assert.match("const b = (process.env as Record<string, string>)['EXPO_PUBLIC_API_BASE_URL'];", CAST_READ);
    assert.match('const { EXPO_PUBLIC_API_BASE_URL } = process.env;', DESTRUCTURED);
    assert.doesNotMatch('const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? "";', CAST_READ);
    assert.doesNotMatch("const base = process.env['EXPO_PUBLIC_API_BASE_URL'];", CAST_READ);
  });
  it('no app source reads an EXPO_PUBLIC_* value through a cast or a destructuring of process.env', () => {
    const offenders: string[] = [];
    for (const dir of ['src', 'app']) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (CAST_READ.test(line) || DESTRUCTURED.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}`);
        });
      }
    }
    assert.deepEqual(offenders, [], `not inlined in a release build, so undefined at runtime: ${offenders.join(', ')}`);
  });
});
