/**
 * Unit tests for src/lib/stampRarity.ts
 *
 * Pure function module — no React needed.
 */

import {
  RARITY_COLORS,
  RARITY_LABEL,
  normalizeRarity,
  hasGlowRing,
  type StampRarity,
} from '../stampRarity.ts';

describe('normalizeRarity', () => {
  it('returns valid rarities unchanged', () => {
    const valid: StampRarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
    for (const r of valid) {
      expect(normalizeRarity(r)).toBe(r);
    }
  });

  it('coerces null to common', () => {
    expect(normalizeRarity(null)).toBe('common');
  });

  it('coerces undefined to common', () => {
    expect(normalizeRarity(undefined)).toBe('common');
  });

  it('coerces unknown strings to common', () => {
    expect(normalizeRarity('EPIC')).toBe('common');   // case-sensitive
    expect(normalizeRarity('mythic')).toBe('common');
    expect(normalizeRarity('')).toBe('common');
  });
});

describe('RARITY_COLORS', () => {
  const tiers: StampRarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

  it('covers every rarity tier', () => {
    for (const tier of tiers) {
      expect(RARITY_COLORS[tier]).toBeDefined();
    }
  });

  it('provides ring and text for every tier', () => {
    for (const tier of tiers) {
      const palette = RARITY_COLORS[tier];
      expect(typeof palette.ring).toBe('string');
      expect(palette.ring.startsWith('#')).toBe(true);
      expect(typeof palette.text).toBe('string');
      expect(palette.text.startsWith('#')).toBe(true);
    }
  });

  it('provides glow only for epic and legendary', () => {
    expect(RARITY_COLORS.common.glow).toBeUndefined();
    expect(RARITY_COLORS.uncommon.glow).toBeUndefined();
    expect(RARITY_COLORS.rare.glow).toBeUndefined();
    expect(typeof RARITY_COLORS.epic.glow).toBe('string');
    expect(typeof RARITY_COLORS.legendary.glow).toBe('string');
  });
});

describe('RARITY_LABEL', () => {
  it('has a non-empty label for every tier', () => {
    const tiers: StampRarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
    for (const tier of tiers) {
      expect(typeof RARITY_LABEL[tier]).toBe('string');
      expect(RARITY_LABEL[tier].length).toBeGreaterThan(0);
    }
  });
});

describe('hasGlowRing', () => {
  it('returns true for epic and legendary', () => {
    expect(hasGlowRing('epic')).toBe(true);
    expect(hasGlowRing('legendary')).toBe(true);
  });

  it('returns false for common, uncommon, rare', () => {
    expect(hasGlowRing('common')).toBe(false);
    expect(hasGlowRing('uncommon')).toBe(false);
    expect(hasGlowRing('rare')).toBe(false);
  });
});
