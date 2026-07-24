/**
 * stampRarity — single source of truth for stamp rarity colours, labels,
 * and normalisation. All components must import from here; local maps are
 * forbidden after this module was introduced.
 *
 * Colour semantics:
 *   ring  — background of rarity pip / badge / ring (more saturated)
 *   text  — foreground text colour on light backgrounds (darker)
 *   glow  — optional glow ring colour for epic/legendary only (alpha-blended)
 */

export type StampRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface RarityPalette {
  ring: string;
  text: string;
  glow?: string;
}

export const RARITY_COLORS: Record<StampRarity, RarityPalette> = {
  common:    { ring: '#9CA3AF', text: '#6B7280' },
  uncommon:  { ring: '#10B981', text: '#059669' },
  rare:      { ring: '#3B82F6', text: '#2563EB' },
  epic:      { ring: '#8B5CF6', text: '#7C3AED', glow: 'rgba(139,92,246,0.3)' },
  legendary: { ring: '#F59E0B', text: '#D97706', glow: 'rgba(245,158,11,0.35)' },
};

export const RARITY_LABEL: Record<StampRarity, string> = {
  common:    'Common',
  uncommon:  'Uncommon',
  rare:      'Rare',
  epic:      'Epic',
  legendary: 'Legendary',
};

const VALID: ReadonlySet<string> = new Set([
  'common', 'uncommon', 'rare', 'epic', 'legendary',
]);

/** Coerce any unknown value to a valid StampRarity; defaults to 'common'. */
export function normalizeRarity(v?: string | null): StampRarity {
  return (v && VALID.has(v)) ? (v as StampRarity) : 'common';
}

/** Whether this rarity tier should show a glow ring on tiles. */
export function hasGlowRing(rarity: StampRarity): boolean {
  return rarity === 'epic' || rarity === 'legendary';
}
