/**
 * Unit tests for the PulseCreate category persistence helpers.
 *
 * Run via:
 *   node --import tsx/esm --test src/components/__tests__/pulseCreateCategoryStorage.test.ts
 *
 * Tests:
 *   1. lastCatKey returns the expected key format
 *   2. loadLastCategory returns a valid stored value
 *   3. loadLastCategory returns null for an invalid stored value
 *   4. loadLastCategory returns null when the key is missing (null from storage)
 *   5. loadLastCategory returns null when storage rejects
 *   6. saveLastCategory calls setItem with the correct key and value
 *   7. saveLastCategory swallows setItem errors (fire-and-forget)
 *   8. clearLastCategory calls removeItem with the correct key
 *   9. clearLastCategory swallows removeItem errors (fire-and-forget)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastCatKey,
  loadLastCategory,
  saveLastCategory,
  clearLastCategory,
} from '../pulseCreateCategoryStorage.ts';
import type { StorageLike } from '../pulseCreateCategoryStorage.ts';

// ── Fake AsyncStorage factory ──────────────────────────────────────────────────

function fakeStorage(opts: {
  getResult?: string | null;
  getError?: Error;
  setError?: Error;
  removeError?: Error;
} = {}): StorageLike & {
  setItemCalls: Array<{ key: string; value: string }>;
  removeItemCalls: string[];
} {
  const setItemCalls: Array<{ key: string; value: string }> = [];
  const removeItemCalls: string[] = [];
  return {
    setItemCalls,
    removeItemCalls,
    getItem(_key: string): Promise<string | null> {
      if (opts.getError) return Promise.reject(opts.getError);
      return Promise.resolve(opts.getResult ?? null);
    },
    setItem(key: string, value: string): Promise<void> {
      setItemCalls.push({ key, value });
      if (opts.setError) return Promise.reject(opts.setError);
      return Promise.resolve();
    },
    removeItem(key: string): Promise<void> {
      removeItemCalls.push(key);
      if (opts.removeError) return Promise.reject(opts.removeError);
      return Promise.resolve();
    },
  };
}

// ── lastCatKey ─────────────────────────────────────────────────────────────────

describe('lastCatKey', () => {
  it('1. returns the expected key format for a known type', () => {
    assert.equal(lastCatKey('post_update'), 'pulse_create_cat_post_update');
  });

  it('1b. key is unique per type', () => {
    assert.notEqual(lastCatKey('post_update'), lastCatKey('ask_question'));
  });
});

// ── loadLastCategory ──────────────────────────────────────────────────────────

describe('loadLastCategory', () => {
  it('2. returns a valid stored value', async () => {
    const storage = fakeStorage({ getResult: 'food' });
    const result = await loadLastCategory(storage, 'share_food_spot');
    assert.equal(result, 'food');
  });

  it('3. returns null for an invalid stored value', async () => {
    const storage = fakeStorage({ getResult: 'not_a_real_category' });
    const result = await loadLastCategory(storage, 'post_update');
    assert.equal(result, null);
  });

  it('4. returns null when key is missing (null from storage)', async () => {
    const storage = fakeStorage({ getResult: null });
    const result = await loadLastCategory(storage, 'post_update');
    assert.equal(result, null);
  });

  it('5. returns null when storage rejects', async () => {
    const storage = fakeStorage({ getError: new Error('storage unavailable') });
    const result = await loadLastCategory(storage, 'post_update');
    assert.equal(result, null);
  });
});

// ── saveLastCategory ──────────────────────────────────────────────────────────

describe('saveLastCategory', () => {
  it('6. calls setItem with the correct key and value', async () => {
    const storage = fakeStorage();
    saveLastCategory(storage, 'post_update', 'tip');
    await Promise.resolve();
    assert.equal(storage.setItemCalls.length, 1);
    assert.deepEqual(storage.setItemCalls[0], {
      key: 'pulse_create_cat_post_update',
      value: 'tip',
    });
  });

  it('7. swallows setItem errors (fire-and-forget)', async () => {
    const storage = fakeStorage({ setError: new Error('disk full') });
    assert.doesNotThrow(() => saveLastCategory(storage, 'post_update', 'tip'));
    await Promise.resolve();
  });
});

// ── clearLastCategory ─────────────────────────────────────────────────────────

describe('clearLastCategory', () => {
  it('8. calls removeItem with the correct key', async () => {
    const storage = fakeStorage();
    clearLastCategory(storage, 'post_update');
    await Promise.resolve();
    assert.equal(storage.removeItemCalls.length, 1);
    assert.equal(storage.removeItemCalls[0], 'pulse_create_cat_post_update');
  });

  it('9. swallows removeItem errors (fire-and-forget)', async () => {
    const storage = fakeStorage({ removeError: new Error('io error') });
    assert.doesNotThrow(() => clearLastCategory(storage, 'post_update'));
    await Promise.resolve();
  });
});
