/**
 * likeToggleGuard tests — node:test + node:assert only (no RNTL / React).
 *
 * Verifies that the in-flight guard prevents a second network request from
 * being dispatched when the like button is double-tapped before the first
 * call resolves.
 *
 * Run with:
 *   node --import tsx/esm --test src/lib/likeToggleGuard.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLikeToggleGuard } from './likeToggleGuard.ts';

describe('createLikeToggleGuard', () => {
  describe('single call', () => {
    it('calls doToggle and returns ok', async () => {
      const guard = createLikeToggleGuard();
      let called = 0;
      const result = await guard.tryToggle(async () => { called++; });
      assert.equal(result, 'ok');
      assert.equal(called, 1);
    });

    it('isToggling is false before and after a call', async () => {
      const guard = createLikeToggleGuard();
      assert.equal(guard.isToggling(), false);
      await guard.tryToggle(async () => {});
      assert.equal(guard.isToggling(), false);
    });

    it('isToggling is true while doToggle is in flight', async () => {
      const guard = createLikeToggleGuard();
      let observedDuring = false;
      await guard.tryToggle(async () => {
        observedDuring = guard.isToggling();
      });
      assert.equal(observedDuring, true);
      assert.equal(guard.isToggling(), false);
    });
  });

  describe('double-tap prevention', () => {
    it('returns in_flight for a concurrent second call', async () => {
      const guard = createLikeToggleGuard();
      let resolve!: () => void;
      const slowToggle = new Promise<void>(r => { resolve = r; });

      let firstCalls = 0;
      let secondCalls = 0;

      const first = guard.tryToggle(async () => { firstCalls++; await slowToggle; });
      const secondResult = await guard.tryToggle(async () => { secondCalls++; });

      assert.equal(secondResult, 'in_flight');
      assert.equal(secondCalls, 0);

      resolve();
      assert.equal(await first, 'ok');
      assert.equal(firstCalls, 1);
    });

    it('isToggling is true for the duration of a slow toggle', async () => {
      const guard = createLikeToggleGuard();
      let resolve!: () => void;
      const slow = new Promise<void>(r => { resolve = r; });

      const first = guard.tryToggle(async () => { await slow; });
      assert.equal(guard.isToggling(), true);
      resolve();
      await first;
      assert.equal(guard.isToggling(), false);
    });
  });

  describe('error handling', () => {
    it('returns error when doToggle throws', async () => {
      const guard = createLikeToggleGuard();
      const result = await guard.tryToggle(async () => { throw new Error('network fail'); });
      assert.equal(result, 'error');
    });

    it('resets isToggling after an error so the user can retry', async () => {
      const guard = createLikeToggleGuard();
      await guard.tryToggle(async () => { throw new Error('fail'); });
      assert.equal(guard.isToggling(), false);
    });

    it('allows a subsequent call after an error', async () => {
      const guard = createLikeToggleGuard();
      await guard.tryToggle(async () => { throw new Error('fail'); });
      let called = 0;
      const result = await guard.tryToggle(async () => { called++; });
      assert.equal(result, 'ok');
      assert.equal(called, 1);
    });
  });

  describe('sequential calls', () => {
    it('allows a second call after the first resolves', async () => {
      const guard = createLikeToggleGuard();
      let called = 0;
      await guard.tryToggle(async () => { called++; });
      await guard.tryToggle(async () => { called++; });
      assert.equal(called, 2);
    });

    it('correctly tracks isToggling across multiple sequential calls', async () => {
      const guard = createLikeToggleGuard();
      await guard.tryToggle(async () => {});
      assert.equal(guard.isToggling(), false);
      await guard.tryToggle(async () => {});
      assert.equal(guard.isToggling(), false);
    });
  });
});
