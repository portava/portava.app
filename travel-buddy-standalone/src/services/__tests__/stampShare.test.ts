/**
 * stampShareUtils — unit tests
 *
 * Pure helper functions tested in Node.js (no React Native runtime required).
 *
 * Run with:
 *   node --import tsx/esm --test src/services/__tests__/stampShare.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stampToLegacy, makeStampShareMessage, toFileUri } from '../stampShareUtils.ts';
import type { PassportStampNew } from '../passportStamps.ts';

// ── Minimal stub factory ────────────────────────────────────────────────────
function makeStamp(overrides: Partial<PassportStampNew> = {}): PassportStampNew {
  return {
    id: 'stamp-001',
    userId: 'user-001',
    stampType: 'city',
    sourceType: 'trip',
    city: 'Cebu',
    country: 'Philippines',
    earnedAt: '2025-01-15T10:00:00Z',
    isRevoked: false,
    visibility: 'public',
    displayOnPassport: true,
    titleOverride: null,
    definition: null,
    ...overrides,
  } as PassportStampNew;
}

// ── stampToLegacy ──────────────────────────────────────────────────────────
describe('stampToLegacy', () => {
  it('maps city stampType to kind=city', () => {
    const legacy = stampToLegacy(makeStamp({ stampType: 'city', city: 'Cebu', titleOverride: null }));
    assert.equal(legacy.kind, 'city');
  });

  it('maps plan stampType to kind=plan', () => {
    const legacy = stampToLegacy(makeStamp({ stampType: 'plan' }));
    assert.equal(legacy.kind, 'plan');
  });

  it('maps hidden_gem to kind=gem', () => {
    const legacy = stampToLegacy(makeStamp({ stampType: 'hidden_gem' }));
    assert.equal(legacy.kind, 'gem');
  });

  it('maps safe_return to kind=safe', () => {
    const legacy = stampToLegacy(makeStamp({ stampType: 'safe_return' }));
    assert.equal(legacy.kind, 'safe');
  });

  it('maps host to kind=host', () => {
    const legacy = stampToLegacy(makeStamp({ stampType: 'host' }));
    assert.equal(legacy.kind, 'host');
  });

  it('falls back to city for unknown stampType', () => {
    const legacy = stampToLegacy(makeStamp({ stampType: 'event' }));
    assert.equal(legacy.kind, 'city');
  });

  it('uses titleOverride as label when present', () => {
    const legacy = stampToLegacy(makeStamp({ titleOverride: 'My Custom Label', city: 'Cebu' }));
    assert.equal(legacy.label, 'My Custom Label');
  });

  it('uses definition.name as label when no titleOverride', () => {
    const legacy = stampToLegacy(makeStamp({
      titleOverride: null,
      definition: { name: 'Pacific Explorer', rarity: 'rare', category: 'location', description: null } as any,
      city: 'Cebu',
    }));
    assert.equal(legacy.label, 'Pacific Explorer');
  });

  it('falls back to city when no titleOverride or definition', () => {
    const legacy = stampToLegacy(makeStamp({ titleOverride: null, definition: null, city: 'Cebu' }));
    assert.equal(legacy.label, 'Cebu');
  });

  it('falls back to country when no titleOverride, definition, or city', () => {
    const legacy = stampToLegacy(makeStamp({ titleOverride: null, definition: null, city: null, country: 'Philippines' }));
    assert.equal(legacy.label, 'Philippines');
  });

  it('copies isRevoked to locked', () => {
    const legacy = stampToLegacy(makeStamp({ isRevoked: true }));
    assert.equal(legacy.locked, true);
  });

  it('copies stamp id', () => {
    const legacy = stampToLegacy(makeStamp({ id: 'stamp-xyz' }));
    assert.equal(legacy.id, 'stamp-xyz');
  });
});

// ── makeStampShareMessage ──────────────────────────────────────────────────
describe('makeStampShareMessage', () => {
  it('includes "I" when no username given', () => {
    const msg = makeStampShareMessage(makeStamp({ city: 'Cebu', titleOverride: null, definition: null }), null);
    assert.match(msg, /^I just earned/);
  });

  it('uses @username when provided', () => {
    const msg = makeStampShareMessage(makeStamp({ city: 'Cebu', titleOverride: null, definition: null }), 'alice');
    assert.match(msg, /^@alice just earned/);
  });

  it('includes the stamp name in quotes', () => {
    const msg = makeStampShareMessage(makeStamp({ titleOverride: 'Jazz Night', city: 'New Orleans' }), null);
    assert.match(msg, /"Jazz Night"/);
  });

  it('includes the city in the message', () => {
    const msg = makeStampShareMessage(makeStamp({ city: 'Tokyo', titleOverride: null, definition: null }), null);
    assert.match(msg, /in Tokyo/);
  });

  it('omits city text when city and country are both null', () => {
    const msg = makeStampShareMessage(makeStamp({ city: null, country: null, titleOverride: null, definition: null }), null);
    assert.doesNotMatch(msg, /in null/);
    assert.doesNotMatch(msg, / in /);
  });

  it('falls back to country in location when city is null', () => {
    const msg = makeStampShareMessage(makeStamp({ city: null, country: 'Japan', titleOverride: null, definition: null }), null);
    assert.match(msg, /in Japan/);
  });

  it('uses definition.name as stamp name over city fallback', () => {
    const msg = makeStampShareMessage(makeStamp({
      titleOverride: null,
      definition: { name: 'Island Hopper', rarity: 'uncommon', category: 'location', description: null } as any,
      city: 'Palawan',
    }), null);
    assert.match(msg, /"Island Hopper"/);
  });

  it('ends with Travel Buddy call-to-action', () => {
    const msg = makeStampShareMessage(makeStamp(), 'bob');
    assert.match(msg, /Travel Buddy/);
  });
});

// ── toFileUri ─────────────────────────────────────────────────────────────
describe('toFileUri', () => {
  it('prefixes bare paths with file://', () => {
    assert.equal(toFileUri('/tmp/stamp.jpg'), 'file:///tmp/stamp.jpg');
  });

  it('leaves existing file:// URIs unchanged', () => {
    assert.equal(toFileUri('file:///tmp/stamp.jpg'), 'file:///tmp/stamp.jpg');
  });
});
