/**
 * timeoutSignal works under React Native's AbortSignal, which has no static
 * `timeout` (verifier N1) — and nothing in the app's runtime code calls
 * `AbortSignal.timeout(` any more.
 *
 * React Native installs AbortController/AbortSignal from the `abort-controller`
 * package (Libraries/Core/setUpXHR.js); this test swaps exactly that class in
 * for Node's own, so a regression to `AbortSignal.timeout` throws here as it
 * does on a phone.
 *
 * Run: node --import tsx/esm --test src/lib/__tests__/timeoutSignal.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { timeoutSignal } from '../timeoutSignal.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const RN = require('abort-controller') as { AbortController: typeof AbortController; AbortSignal: typeof AbortSignal };

describe('timeoutSignal under React Native\'s AbortSignal', () => {
  const g = globalThis as any;
  let savedController: unknown;
  let savedSignal: unknown;
  before(() => {
    savedController = g.AbortController;
    savedSignal = g.AbortSignal;
    g.AbortController = RN.AbortController;
    g.AbortSignal = RN.AbortSignal;
  });
  after(() => {
    g.AbortController = savedController;
    g.AbortSignal = savedSignal;
  });

  it('the RN class really lacks AbortSignal.timeout (the premise)', () => {
    assert.equal(typeof (globalThis as any).AbortSignal.timeout, 'undefined');
    assert.throws(() => (globalThis as any).AbortSignal.timeout(10), TypeError);
  });

  it('returns a signal that is live first and aborted after the timeout', async () => {
    const signal = timeoutSignal(20);
    assert.ok(signal instanceof RN.AbortSignal, 'built from the runtime\'s own AbortController');
    assert.equal(signal.aborted, false);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(signal.aborted, true);
  });
});

describe('no runtime code calls AbortSignal.timeout(', () => {
  const ROOT = pathResolve(__dir, '../../..');
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (e === 'node_modules' || e === '__tests__' || e === '__mocks__') continue;
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|js|jsx)$/.test(e) && !/\.test\./.test(e)) out.push(full);
    }
    return out;
  }
  it('src/ and app/ have no call (comments and this file excepted)', () => {
    const offenders: string[] = [];
    for (const f of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'app'))]) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const at = line.indexOf('AbortSignal.timeout(');
        if (at < 0) return;
        const before = line.slice(0, at);
        if (/^\s*(\*|\/\/)/.test(line) || before.includes('//') || /not\s+$/.test(before)) return;
        offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, [], 'AbortSignal.timeout throws on React Native; use timeoutSignal()');
  });
});
