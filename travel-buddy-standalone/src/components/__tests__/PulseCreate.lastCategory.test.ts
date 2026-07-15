/**
 * Scenario tests for the PulseCreate last-used category lifecycle.
 *
 * Run via:
 *   node --import tsx/esm --test src/components/__tests__/PulseCreate.lastCategory.test.ts
 *
 * These tests exercise the exact resolution logic used by the component's
 * selectedType useEffect:
 *
 *   loadLastCategory(storage, typeId).then(saved =>
 *     setSelectedCategory(saved ?? resolveDefaultCategory(typeId))
 *   )
 *
 * No React or native runtime is needed — all tested through pure helpers.
 *
 * Scenarios:
 *   S1. First open (no saved value) → type default is used
 *   S2. Second open, same type (saved value) → preference is restored
 *   S3. Switch type → each type loads its own stored value independently
 *   S4. Invalid stored string → falls back to type default without crashing
 *   S5. Save → reopen round-trip → stored value survives
 *   S6. Reset (clearLastCategory) → next open returns to type default
 *   S7. Stale-effect cancellation → cancelled load does not update state
 *   S8. resolveDefaultCategory returns expected defaults for all known types
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadLastCategory,
  saveLastCategory,
  clearLastCategory,
} from '../pulseCreateCategoryStorage.ts';
import type { StorageLike } from '../pulseCreateCategoryStorage.ts';
import {
  resolveDefaultCategory,
} from '../PulseCreate.machine.ts';
import type { PostCategory } from '../../types/models.ts';

// ── Storage helpers ────────────────────────────────────────────────────────────

/** In-memory storage that supports full get/set/remove lifecycle. */
function mapStorage(
  initial: Record<string, string> = {},
): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => Promise.resolve(data.get(key) ?? null),
    setItem: (key, value) => { data.set(key, value); return Promise.resolve(); },
    removeItem: (key) => { data.delete(key); return Promise.resolve(); },
  };
}

/** Mirrors the component's useEffect resolution function. */
async function resolveCategory(
  storage: StorageLike,
  typeId: string,
): Promise<PostCategory | null> {
  const saved = await loadLastCategory(storage, typeId);
  return saved ?? resolveDefaultCategory(typeId);
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

describe('S1 — first open, no saved value → type default is used', () => {
  it('post_update with empty storage resolves to tip (its type default)', async () => {
    const storage = mapStorage();
    const result = await resolveCategory(storage, 'post_update');
    assert.equal(result, 'tip');
  });

  it('ask_question with empty storage resolves to question', async () => {
    const storage = mapStorage();
    const result = await resolveCategory(storage, 'ask_question');
    assert.equal(result, 'question');
  });
});

describe('S2 — second open same type → saved preference is restored', () => {
  it('saves nightlife for post_update then restores it on next open', async () => {
    const storage = mapStorage();

    // First session: user picks nightlife
    saveLastCategory(storage, 'post_update', 'nightlife');
    await Promise.resolve(); // flush fire-and-forget

    // Second session: reopen with same type
    const result = await resolveCategory(storage, 'post_update');
    assert.equal(result, 'nightlife');
  });

  it('saved preference overrides the type default', async () => {
    // post_update default is 'tip'; user chose 'beach'
    const storage = mapStorage({ 'pulse_create_cat_post_update': 'beach' });
    const result = await resolveCategory(storage, 'post_update');
    assert.equal(result, 'beach');
    // verify it is NOT the default
    assert.notEqual(result, resolveDefaultCategory('post_update'));
  });
});

describe('S3 — switch to different type → each type loads its own stored value', () => {
  it('post_update and ask_question have independent storage keys', async () => {
    const storage = mapStorage({
      'pulse_create_cat_post_update': 'nightlife',
      // ask_question has no saved entry
    });

    const catPostUpdate = await resolveCategory(storage, 'post_update');
    const catAskQuestion = await resolveCategory(storage, 'ask_question');

    assert.equal(catPostUpdate, 'nightlife');
    assert.equal(catAskQuestion, 'question'); // falls back to its own type default
  });

  it('each type preserves its own preference independently', async () => {
    const storage = mapStorage({
      'pulse_create_cat_post_update': 'beach',
      'pulse_create_cat_share_food_spot': 'hotel',
    });

    const catUpdate = await resolveCategory(storage, 'post_update');
    const catFood   = await resolveCategory(storage, 'share_food_spot');

    assert.equal(catUpdate, 'beach');
    assert.equal(catFood,   'hotel');
  });
});

describe('S4 — invalid stored string → falls back to type default without crashing', () => {
  it('invalid stored value "garbage" falls back to post_update default (tip)', async () => {
    const storage = mapStorage({ 'pulse_create_cat_post_update': 'garbage' });
    const result = await resolveCategory(storage, 'post_update');
    assert.equal(result, 'tip');
  });

  it('empty string stored value falls back to type default', async () => {
    const storage = mapStorage({ 'pulse_create_cat_ask_question': '' });
    const result = await resolveCategory(storage, 'ask_question');
    assert.equal(result, 'question');
  });
});

describe('S5 — save then reopen round-trip', () => {
  it('saved preference persists across simulated close/reopen', async () => {
    const storage = mapStorage();

    // User picks food during first session
    saveLastCategory(storage, 'share_moment', 'food');
    await Promise.resolve();

    // Simulate close (nothing changes in storage)
    // Simulate reopen
    const result = await resolveCategory(storage, 'share_moment');
    assert.equal(result, 'food');
  });
});

describe('S6 — reset clears preference → next open uses type default', () => {
  it('clearLastCategory makes next open resolve to the type default', async () => {
    const storage = mapStorage({ 'pulse_create_cat_post_update': 'nightlife' });

    // Confirm preference is loaded
    const before = await resolveCategory(storage, 'post_update');
    assert.equal(before, 'nightlife');

    // User taps "Reset to default"
    clearLastCategory(storage, 'post_update');
    await Promise.resolve();

    // Next open: falls back to type default
    const after = await resolveCategory(storage, 'post_update');
    assert.equal(after, 'tip'); // post_update default
  });
});

describe('S7 — stale-effect cancellation', () => {
  it('cancelled load does not update state after type switches away', async () => {
    let resolveFirst!: (val: string | null) => void;

    const slowStorage: StorageLike = {
      getItem: () => new Promise((r) => { resolveFirst = r; }),
      setItem: () => Promise.resolve(),
      removeItem: () => Promise.resolve(),
    };

    let state: PostCategory | null = null;
    let cancelled = false;

    // Start the load (does not resolve yet)
    loadLastCategory(slowStorage, 'post_update').then((saved) => {
      if (cancelled) return;
      state = saved ?? resolveDefaultCategory('post_update');
    });

    // User switches type before the load finishes — effect cleanup fires
    cancelled = true;

    // Now the slow storage resolves ('beach')
    resolveFirst('beach');
    await new Promise((r) => setTimeout(r, 0));

    // State must NOT have been updated
    assert.equal(state, null);
  });
});

describe('S8 — resolveDefaultCategory covers all known post types', () => {
  const expectedDefaults: Array<[string, PostCategory]> = [
    ['post_update',       'tip'],
    ['ask_question',      'question'],
    ['share_moment',      'activity'],
    ['share_postcard',    'activity'],
    ['share_hidden_gem',  'activity'],
    ['share_food_spot',   'food'],
  ];

  for (const [typeId, expected] of expectedDefaults) {
    it(`${typeId} → ${expected}`, () => {
      assert.equal(resolveDefaultCategory(typeId), expected);
    });
  }

  it('unknown type returns null', () => {
    assert.equal(resolveDefaultCategory('unknown_type'), null);
  });
});
