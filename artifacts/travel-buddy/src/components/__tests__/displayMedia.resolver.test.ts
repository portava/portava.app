/**
 * resolveDisplayMedia — priority-chain and designed-fallback tests.
 *
 * Pure logic: no React, no mocks required.
 * Runs under the node:test runner (registered in package.json "test" list).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDisplayMedia, avatarFallback } from '../../lib/displayMedia.ts';

// ── resolveDisplayMedia — priority chain ─────────────────────────────────────

describe('resolveDisplayMedia — designed fallback (all null/empty)', () => {
  it('returns null for an empty sources array', () => {
    assert.equal(resolveDisplayMedia([]), null);
  });

  it('returns null when every source is null', () => {
    assert.equal(resolveDisplayMedia([null, null, null]), null);
  });

  it('returns null when every source is undefined', () => {
    assert.equal(resolveDisplayMedia([undefined, undefined]), null);
  });

  it('returns null when every source is an empty string', () => {
    assert.equal(resolveDisplayMedia(['', '']), null);
  });

  it('returns null when every source is whitespace-only', () => {
    assert.equal(resolveDisplayMedia(['   ', '\t', '\n']), null);
  });

  it('returns null for a mixed empty/null/whitespace array', () => {
    assert.equal(resolveDisplayMedia([null, '', '  ', undefined]), null);
  });
});

describe('resolveDisplayMedia — first non-empty wins', () => {
  it('returns the sole non-empty URL', () => {
    assert.equal(
      resolveDisplayMedia(['https://example.com/photo.jpg']),
      'https://example.com/photo.jpg',
    );
  });

  it('trims leading/trailing whitespace from a URL', () => {
    assert.equal(
      resolveDisplayMedia(['  https://example.com/photo.jpg  ']),
      'https://example.com/photo.jpg',
    );
  });

  it('returns the first URL when multiple are present (user photo wins over official)', () => {
    assert.equal(
      resolveDisplayMedia([
        'https://user-photo.example.com/img.jpg',
        'https://official-photo.example.com/img.jpg',
      ]),
      'https://user-photo.example.com/img.jpg',
    );
  });

  it('skips null and empty prefixes, returns the first real URL', () => {
    assert.equal(
      resolveDisplayMedia([null, '', 'https://fallback.example.com/img.jpg']),
      'https://fallback.example.com/img.jpg',
    );
  });

  it('skips whitespace-only prefixes, returns the first real URL', () => {
    assert.equal(
      resolveDisplayMedia(['  ', undefined, 'https://deep-fallback.example.com/img.jpg']),
      'https://deep-fallback.example.com/img.jpg',
    );
  });

  it('skips null/empty first sources to reach a later provider photo', () => {
    // Simulates: user photo → official photo → provider photo (first filled)
    assert.equal(
      resolveDisplayMedia([null, null, 'https://provider.example.com/img.jpg', 'https://community.example.com/img.jpg']),
      'https://provider.example.com/img.jpg',
    );
  });

  it('does not trim the URL value itself — a real URL with internal spaces is not trimmed mid-path', () => {
    // The trim is only on leading/trailing whitespace; real URLs should not have internal spaces
    const url = 'https://cdn.example.com/path/to/image.jpg';
    assert.equal(resolveDisplayMedia([url]), url);
  });
});

describe('resolveDisplayMedia — full priority chain (8 tiers)', () => {
  it('user photo tier wins over all others', () => {
    assert.equal(
      resolveDisplayMedia([
        'https://user.example.com/photo.jpg',
        'https://official.example.com/photo.jpg',
        'https://provider.example.com/photo.jpg',
        'https://community.example.com/photo.jpg',
        'https://related.example.com/image.jpg',
        'https://map.example.com/preview.jpg',
        'https://category.example.com/artwork.jpg',
      ]),
      'https://user.example.com/photo.jpg',
    );
  });

  it('falls to category artwork when all earlier tiers are null (designed fallback)', () => {
    assert.equal(
      resolveDisplayMedia([
        null,  // user photo
        null,  // official photo
        null,  // provider photo
        null,  // community photo
        null,  // related image
        null,  // map preview
        'https://category.example.com/artwork.jpg',
      ]),
      'https://category.example.com/artwork.jpg',
    );
  });

  it('returns null when even the last-resort tier is missing (designed null fallback)', () => {
    assert.equal(
      resolveDisplayMedia([null, null, null, null, null, null, null]),
      null,
    );
  });
});

// ── avatarFallback ───────────────────────────────────────────────────────────

describe('avatarFallback', () => {
  it('returns the avatarUrl when set', () => {
    const { url, initials } = avatarFallback({
      avatarUrl: 'https://cdn.example.com/avatar.jpg',
      displayName: 'Alice',
    });
    assert.equal(url, 'https://cdn.example.com/avatar.jpg');
    assert.ok(initials.length > 0, 'initials must be non-empty');
  });

  it('returns null url when avatarUrl is null', () => {
    const { url } = avatarFallback({ avatarUrl: null, displayName: 'Alice' });
    assert.equal(url, null);
  });

  it('returns initials from displayName when avatarUrl is null', () => {
    const { initials } = avatarFallback({ avatarUrl: null, displayName: 'Alice' });
    assert.ok(initials.length > 0, 'initials must be non-empty');
    assert.ok(initials.length <= 2, 'initials must be 1–2 characters');
  });

  it('returns initials from handle when displayName is absent', () => {
    const { initials } = avatarFallback({ avatarUrl: null, handle: 'bob' });
    assert.ok(initials.length > 0);
  });
});
