/**
 * Category-gate tests for UnifiedPostComposer (PulseCreate.tsx).
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/PulseCreate.categoryGate.test.ts
 *
 * ## Why this test exists
 *
 * The category chip picker is gated on !!TYPE_CATEGORY[selectedType]. If a
 * developer adds a new post type but forgets to add it to TYPE_CATEGORY, the
 * chip picker will not appear and selectedCategory stays null. Without a
 * validation guard the post would be submitted silently with no category,
 * breaking feed filters.
 *
 * validateCategoryGate() is that guard. These tests lock in two contracts:
 *
 *   1. resolveDefaultCategory returns null for a type that has no TYPE_CATEGORY
 *      entry — confirming that the picker would be hidden for such a type.
 *
 *   2. validateCategoryGate returns { ok: false, error: 'missing_category' }
 *      when TYPE_CATEGORY[type] is falsy and selectedCategory is null — so
 *      handleSubmit() surfaces feedback instead of submitting a category-less post.
 *
 * No React or native runtime is needed — all tested through pure helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDefaultCategory,
  validateCategoryGate,
  TYPE_CATEGORY,
} from '../PulseCreate.machine.ts';

// ── resolveDefaultCategory — null for unmapped types ──────────────────────────
//
// When TYPE_CATEGORY has no entry for a typeId, resolveDefaultCategory returns
// null. The component uses !!TYPE_CATEGORY[selectedType] to decide whether to
// render the chip picker at all, so a null return maps directly to "no picker
// shown, no category available".

describe('resolveDefaultCategory — returns null for unmapped post types', () => {
  it('returns null for an unmapped type ID', () => {
    assert.equal(
      resolveDefaultCategory('share_new_type'),
      null,
      'an unmapped type must return null — the chip picker will be hidden',
    );
  });

  it('returns null for any string not in TYPE_CATEGORY', () => {
    const unmappedTypes = [
      'share_new_type',
      'share_video',
      'share_poll',
      'live_update',
      '',
    ];
    for (const typeId of unmappedTypes) {
      assert.equal(
        resolveDefaultCategory(typeId),
        null,
        `"${typeId}" is not in TYPE_CATEGORY — resolveDefaultCategory must return null`,
      );
    }
  });

  it('returns non-null for every type currently in TYPE_CATEGORY (regression guard)', () => {
    const mappedTypes = Object.keys(TYPE_CATEGORY).filter(t => t !== 'share_highlight');
    for (const typeId of mappedTypes) {
      const result = resolveDefaultCategory(typeId);
      assert.notEqual(
        result,
        null,
        `type "${typeId}" is in TYPE_CATEGORY — resolveDefaultCategory must return a non-null default`,
      );
    }
  });
});

// ── validateCategoryGate — blocks submit when type has no TYPE_CATEGORY entry ─
//
// If TYPE_CATEGORY[typeId] is falsy (unmapped type → chip picker hidden) AND
// selectedCategory is null (no category set by any means), the post must not
// be submitted. validateCategoryGate() catches this and returns an error the
// component can surface.

describe('validateCategoryGate — unmapped type with null category is blocked', () => {
  it('returns ok: false for an unmapped type with selectedCategory null', () => {
    const result = validateCategoryGate('share_new_type', null);
    assert.equal(result.ok, false,
      'submit must be blocked when the type has no TYPE_CATEGORY entry and no category is selected');
  });

  it('returns error: "missing_category" for an unmapped type with null category', () => {
    const result = validateCategoryGate('share_new_type', null);
    assert.equal(result.error, 'missing_category');
  });

  it('blocks submit for any string not in TYPE_CATEGORY when selectedCategory is null', () => {
    const unmappedTypes = ['share_new_type', 'share_video', 'share_poll', 'live_update'];
    for (const typeId of unmappedTypes) {
      const result = validateCategoryGate(typeId, null);
      assert.equal(
        result.ok,
        false,
        `type "${typeId}" is not in TYPE_CATEGORY — submit must be blocked when selectedCategory is null`,
      );
      assert.equal(result.error, 'missing_category');
    }
  });
});

describe('validateCategoryGate — mapped type with null category is allowed', () => {
  it('returns ok: true for a mapped type even when selectedCategory is null', () => {
    const result = validateCategoryGate('post_update', null);
    assert.equal(result.ok, true,
      'mapped type: chip picker is shown so the user can still select — submit is not blocked');
  });

  it('returns no error field for a mapped type with null selectedCategory', () => {
    const result = validateCategoryGate('post_update', null);
    assert.equal(result.error, undefined);
  });

  it('every type currently in TYPE_CATEGORY passes the gate with null selectedCategory', () => {
    for (const typeId of Object.keys(TYPE_CATEGORY)) {
      const result = validateCategoryGate(typeId, null);
      assert.equal(
        result.ok,
        true,
        `type "${typeId}" is in TYPE_CATEGORY — gate must not block a null selectedCategory for mapped types`,
      );
    }
  });
});

describe('validateCategoryGate — any non-null selectedCategory is always allowed', () => {
  it('returns ok: true for an unmapped type when caller provides a category', () => {
    const result = validateCategoryGate('share_new_type', 'activity');
    assert.equal(result.ok, true,
      'caller-supplied category bypasses the gate even for unmapped types');
  });

  it('returns ok: true for a mapped type with a selected category', () => {
    const result = validateCategoryGate('post_update', 'tip');
    assert.equal(result.ok, true);
  });

  it('returns ok: true for every valid category paired with an unmapped type', () => {
    const categories = [
      'food', 'beach', 'nightlife', 'activity', 'hotel',
      'tip', 'safety', 'transport', 'airport', 'visa', 'question',
    ] as const;
    for (const cat of categories) {
      const result = validateCategoryGate('share_new_type', cat);
      assert.equal(
        result.ok,
        true,
        `category "${cat}" with unmapped type must pass the gate — caller provided a valid category`,
      );
    }
  });
});
