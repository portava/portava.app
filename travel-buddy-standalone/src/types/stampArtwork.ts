/**
 * Stamp Artwork & Design System — type contracts.
 *
 * A `StampArtworkDef` is a pure data record describing how one stamp should
 * look. It is resolved by `stampArtworkResolver.ts` from a `PassportStamp`
 * and is presentation-framework-independent (no React, no RN).
 */

/** Outer silhouette of the stamp frame. */
export type StampShape = 'oval' | 'round' | 'rect' | 'hexagon';

/**
 * Border treatment.
 * - single / double / dotted — rendered as dashed/solid View borders or SVG strokes.
 * - sawtooth / wave — rendered via SVG paths; communicates higher rarity.
 */
export type StampBorderStyle = 'single' | 'double' | 'sawtooth' | 'wave' | 'dotted';

/** Background texture overlay. Controls opacity on ink/foil textures. */
export type StampTexture = 'paper' | 'ink' | 'foil' | 'worn';

/** Background fill pattern drawn inside the stamp shape. */
export type StampPattern = 'solid' | 'radial' | 'grid' | 'dots' | 'diagonal';

/** Collectible rarity tier — drives border style, weight, and animations. */
export type StampRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

/**
 * The resolved artwork descriptor for a single stamp.
 * All fields are non-optional so renderers never need fallback logic.
 */
export interface StampArtworkDef {
  /** Outer frame geometry. */
  shape: StampShape;

  /** Border treatment (see type docs above). */
  borderStyle: StampBorderStyle;

  /**
   * Border stroke width multiplier (1–4).
   * Component interprets as base-weight × borderWeight pixels.
   */
  borderWeight: 1 | 2 | 3 | 4;

  /** Stamp accent / primary color as a hex string, e.g. "#0A3D4A". */
  accent: string;

  /** Background fill color as a hex string. Grayscale when locked. */
  background: string;

  /** SVG fill pattern inside the stamp shape. */
  pattern: StampPattern;

  /** Texture mood applied as a semi-transparent overlay. */
  texture: StampTexture;

  /** Lucide icon key rendered at the stamp center. */
  iconKey: string;

  /** Short uppercase category label, e.g. "CITY", "PLAN". */
  categoryLabel: string;

  /** Optional secondary caption, e.g. "DIVING", "STREET FOOD". City-specific. */
  captionText?: string;

  /** Collectible rarity tier. */
  rarity: StampRarity;

  /**
   * Whether to render an animated shimmer sweep over the stamp.
   * Enabled for epic and legendary when unlocked.
   * Suppressed when the user prefers reduced motion.
   */
  hasShimmer: boolean;

  /**
   * Whether to render an outer glow ring.
   * Enabled for legendary only.
   */
  hasGlow: boolean;

  /** When true the stamp renders in grayscale with a lock overlay. */
  locked: boolean;

  /**
   * Non-empty accessibility label read aloud by screen readers.
   * Format: "<label> — <sublabel> <categoryLabel> stamp [locked]"
   */
  accessibilityLabel: string;
}

/** Human-readable names for each rarity tier. */
export const STAMP_RARITY_LABELS: Record<StampRarity, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
};

/** Representative badge color for each rarity tier. */
export const STAMP_RARITY_COLORS: Record<StampRarity, string> = {
  common: '#9CA3AF',
  uncommon: '#10B981',
  rare: '#3B82F6',
  epic: '#8B5CF6',
  legendary: '#F59E0B',
};

/** Badge color for locked / not-yet-earned stamps. */
export const STAMP_LOCKED_COLOR = '#D1D5DB';
export const STAMP_LOCKED_BG = '#F3F4F6';
