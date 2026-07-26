/**
 * resolveHeaderImage — priority ladder and disclaimer tests.
 *
 * Pure logic: no React, no mocks required.
 * Auto-discovered by scripts/run-node-tests.mjs (src/**\/\*.test.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHeaderImage,
  sourceRank,
  type HeaderCandidate,
} from './resolveHeaderImage.ts';

// ── sourceRank — nine canonical types in strict spec order ───────────────────

describe('sourceRank — nine canonical types in strict spec order', () => {
  it('official outranks every other source type', () => {
    const types = [
      'trusted_provider', 'tourism_authority', 'verified_owner',
      'verified_user_photo', 'reference_grounded_ai', 'generic_ai_illustration',
      'category_fallback', 'map_fallback',
    ];
    for (const t of types) {
      assert.ok(
        sourceRank('official') > sourceRank(t),
        `official must outrank ${t}`,
      );
    }
  });

  it('reference_grounded_ai outranks generic_ai_illustration and category_fallback', () => {
    assert.ok(sourceRank('reference_grounded_ai') > sourceRank('generic_ai_illustration'));
    assert.ok(sourceRank('reference_grounded_ai') > sourceRank('category_fallback'));
  });

  it('generic_ai_illustration outranks category_fallback', () => {
    assert.ok(sourceRank('generic_ai_illustration') > sourceRank('category_fallback'));
  });

  it('category_fallback outranks map_fallback', () => {
    assert.ok(sourceRank('category_fallback') > sourceRank('map_fallback'));
  });

  it('map_fallback is the lowest-ranked canonical source (rank 0)', () => {
    assert.equal(sourceRank('map_fallback'), 0);
  });

  it('all nine canonical types are in strict descending order', () => {
    const order = [
      'official',
      'trusted_provider',
      'tourism_authority',
      'verified_owner',
      'verified_user_photo',
      'reference_grounded_ai',
      'generic_ai_illustration',
      'category_fallback',
      'map_fallback',
    ];
    for (let i = 0; i < order.length - 1; i++) {
      assert.ok(
        sourceRank(order[i]!) > sourceRank(order[i + 1]!),
        `${order[i]} must outrank ${order[i + 1]}`,
      );
    }
  });

  it('unknown source type defaults to rank 0 (does not throw)', () => {
    assert.equal(sourceRank('some_future_type'), 0);
  });
});

// ── resolveHeaderImage — new canonical types win over category_fallback ───────

describe('resolveHeaderImage — accuracy-pipeline sources win over category_fallback', () => {
  const FALLBACK_URL = 'https://cdn.example.com/fallback.jpg';

  it('reference_grounded_ai beats the category fallback', () => {
    const result = resolveHeaderImage(
      [{ url: 'https://cdn.example.com/ai-grounded.webp', source: 'reference_grounded_ai' }],
      { fallbackUrlFor: () => FALLBACK_URL },
    );
    assert.ok(result !== null);
    assert.equal(result!.url, 'https://cdn.example.com/ai-grounded.webp');
    assert.equal(result!.source, 'reference_grounded_ai');
  });

  it('generic_ai_illustration beats the category fallback', () => {
    const result = resolveHeaderImage(
      [{ url: 'https://cdn.example.com/ai-generic.webp', source: 'generic_ai_illustration' }],
      { fallbackUrlFor: () => FALLBACK_URL },
    );
    assert.ok(result !== null);
    assert.equal(result!.url, 'https://cdn.example.com/ai-generic.webp');
    assert.equal(result!.source, 'generic_ai_illustration');
  });

  it('map_fallback loses to the category fallback (rank 0 < rank 1)', () => {
    const result = resolveHeaderImage(
      [{ url: 'https://cdn.example.com/map.png', source: 'map_fallback' }],
      { fallbackUrlFor: () => FALLBACK_URL },
    );
    assert.ok(result !== null);
    // The injected category_fallback (rank 1) wins over map_fallback (rank 0)
    assert.equal(result!.url, FALLBACK_URL);
    assert.equal(result!.source, 'category_fallback');
  });

  it('official wins over reference_grounded_ai', () => {
    const candidates: HeaderCandidate[] = [
      { url: 'https://cdn.example.com/ai-grounded.webp', source: 'reference_grounded_ai' },
      { url: 'https://cdn.example.com/official.jpg',     source: 'official' },
    ];
    const result = resolveHeaderImage(candidates);
    assert.equal(result!.url, 'https://cdn.example.com/official.jpg');
    assert.equal(result!.source, 'official');
  });

  it('verified_user_photo wins over reference_grounded_ai', () => {
    const candidates: HeaderCandidate[] = [
      { url: 'https://cdn.example.com/ai-grounded.webp', source: 'reference_grounded_ai' },
      { url: 'https://cdn.example.com/user-verified.jpg', source: 'verified_user_photo' },
    ];
    const result = resolveHeaderImage(candidates);
    assert.equal(result!.url, 'https://cdn.example.com/user-verified.jpg');
    assert.equal(result!.source, 'verified_user_photo');
  });

  it('reference_grounded_ai wins over generic_ai_illustration', () => {
    const candidates: HeaderCandidate[] = [
      { url: 'https://cdn.example.com/generic.webp',   source: 'generic_ai_illustration' },
      { url: 'https://cdn.example.com/grounded.webp',  source: 'reference_grounded_ai' },
    ];
    const result = resolveHeaderImage(candidates);
    assert.equal(result!.url, 'https://cdn.example.com/grounded.webp');
    assert.equal(result!.source, 'reference_grounded_ai');
  });
});

// ── resolveHeaderImage — isRepresentation flag ────────────────────────────────

describe('resolveHeaderImage — isRepresentation for AI sources', () => {
  it('sets isRepresentation=true for reference_grounded_ai on a place entity', () => {
    const result = resolveHeaderImage(
      [{ url: 'https://cdn.example.com/grounded.webp', source: 'reference_grounded_ai' }],
      { entityType: 'place' },
    );
    assert.equal(result!.isRepresentation, true);
  });

  it('sets isRepresentation=true for generic_ai_illustration on a place entity', () => {
    const result = resolveHeaderImage(
      [{ url: 'https://cdn.example.com/generic.webp', source: 'generic_ai_illustration' }],
      { entityType: 'place' },
    );
    assert.equal(result!.isRepresentation, true);
  });

  it('sets isRepresentation=true for legacy ai_generated on a place entity', () => {
    const result = resolveHeaderImage(
      [{ url: 'https://cdn.example.com/ai.webp', source: 'ai_generated' }],
      { entityType: 'place' },
    );
    assert.equal(result!.isRepresentation, true);
  });

  it('does NOT set isRepresentation for official image on a place entity', () => {
    const result = resolveHeaderImage(
      [{ url: 'https://cdn.example.com/official.jpg', source: 'official' }],
      { entityType: 'place' },
    );
    assert.equal(result!.isRepresentation, false);
  });

  it('does NOT set isRepresentation for reference_grounded_ai on an event entity', () => {
    const result = resolveHeaderImage(
      [{ url: 'https://cdn.example.com/grounded.webp', source: 'reference_grounded_ai' }],
      { entityType: 'event' },
    );
    assert.equal(result!.isRepresentation, false);
  });
});

// ── resolveHeaderImage — disclaimer passthrough ───────────────────────────────

describe('resolveHeaderImage — disclaimer fields are passed through from the winning candidate', () => {
  it('passes through disclaimerRequired=true from candidate', () => {
    const result = resolveHeaderImage([
      {
        url: 'https://cdn.example.com/grounded.webp',
        source: 'reference_grounded_ai',
        disclaimerRequired: true,
        disclaimerText: 'AI-generated representation of this place',
      },
    ]);
    assert.equal(result!.disclaimerRequired, true);
    assert.equal(result!.disclaimerText, 'AI-generated representation of this place');
  });

  it('disclaimerRequired is null when not set on the winning candidate', () => {
    const result = resolveHeaderImage([
      { url: 'https://cdn.example.com/official.jpg', source: 'official' },
    ]);
    assert.equal(result!.disclaimerRequired, null);
  });
});

// ── resolveHeaderImage — legacy sources still work ───────────────────────────

describe('resolveHeaderImage — legacy source types continue to resolve correctly', () => {
  it('user_upload (rank 9) beats official (rank 8)', () => {
    const result = resolveHeaderImage([
      { url: 'https://cdn.example.com/official.jpg',   source: 'official' },
      { url: 'https://cdn.example.com/user-photo.jpg', source: 'user_upload' },
    ]);
    assert.equal(result!.source, 'user_upload');
  });

  it('portava_media (rank 5) beats reference_grounded_ai (rank 3)', () => {
    const result = resolveHeaderImage([
      { url: 'https://cdn.example.com/grounded.webp', source: 'reference_grounded_ai' },
      { url: 'https://cdn.example.com/portava.jpg',   source: 'portava_media' },
    ]);
    assert.equal(result!.source, 'portava_media');
  });

  it('ai_generated (rank 3) beats generic_ai_illustration (rank 2 — same rank, order depends on tie-break)', () => {
    // Both rank 3 (ai_generated) and rank 3 (reference_grounded_ai) tie.
    // The tie-break falls to verifiedAt; without it, array order is stable.
    const result = resolveHeaderImage([
      { url: 'https://cdn.example.com/ai.webp',     source: 'ai_generated' },
      { url: 'https://cdn.example.com/generic.webp', source: 'generic_ai_illustration' },
    ]);
    // ai_generated (3) > generic_ai_illustration (2)
    assert.equal(result!.source, 'ai_generated');
  });
});
