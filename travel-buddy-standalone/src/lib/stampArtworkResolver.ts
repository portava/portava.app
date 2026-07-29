/**
 * Stamp Artwork Resolver
 *
 * Pure TypeScript — no React, no RN. Converts a PassportStamp into a
 * StampArtworkDef that all stamp renderers consume.
 *
 * Resolution order:
 *   1. Locked override (grayscale everything)
 *   2. City-specific caption overrides (for known city slugs)
 *   3. Category theme (color, icon, pattern)
 *   4. Rarity-driven visual treatment (border, shape, texture, shimmer)
 */

import type { PassportStamp, StampKind } from '../types/models.ts';
import type {
  StampArtworkDef,
  StampBorderStyle,
  StampPattern,
  StampRarity,
  StampShape,
  StampTexture,
} from '../types/stampArtwork.ts';
import { STAMP_LOCKED_BG, STAMP_LOCKED_COLOR } from '../types/stampArtwork.ts';

/* ── Category themes ─────────────────────────────────────────────────────── */

interface CategoryTheme {
  accent: string;
  background: string;
  iconKey: string;
  label: string;
  pattern: StampPattern;
}

const CATEGORY_THEME: Record<StampKind, CategoryTheme> = {
  city:  { accent: '#0A3D4A', background: '#EFF5F5', iconKey: 'MapPin',      label: 'CITY',  pattern: 'radial'   },
  plan:  { accent: '#FF4D2E', background: '#FFF0F3', iconKey: 'Users',       label: 'PLAN',  pattern: 'diagonal' },
  gem:   { accent: '#7A4DBF', background: '#F5F0FF', iconKey: 'Gem',         label: 'GEM',   pattern: 'dots'     },
  safe:  { accent: '#2E7D5B', background: '#F0F8F5', iconKey: 'ShieldCheck', label: 'SAFE',  pattern: 'grid'     },
  host:  { accent: '#11110F', background: '#F0F0EE', iconKey: 'Crown',       label: 'HOST',  pattern: 'solid'    },
  perk:  { accent: '#C8851A', background: '#FFF8F0', iconKey: 'Ticket',      label: 'PERK',  pattern: 'diagonal' },
};

/* ── Rarity mapping ──────────────────────────────────────────────────────── */

const KIND_RARITY: Record<StampKind, StampRarity> = {
  city: 'rare',
  plan: 'uncommon',
  gem:  'rare',
  safe: 'uncommon',
  host: 'epic',
  perk: 'common',
};

/* ── Rarity → visual treatment ───────────────────────────────────────────── */

const RARITY_BORDER: Record<StampRarity, StampBorderStyle> = {
  common:    'single',
  uncommon:  'double',
  rare:      'sawtooth',
  epic:      'wave',
  legendary: 'wave',
};

const RARITY_WEIGHT: Record<StampRarity, 1 | 2 | 3 | 4> = {
  common:    1,
  uncommon:  2,
  rare:      2,
  epic:      3,
  legendary: 4,
};

const RARITY_TEXTURE: Record<StampRarity, StampTexture> = {
  common:    'paper',
  uncommon:  'paper',
  rare:      'worn',
  epic:      'ink',
  legendary: 'foil',
};

/* ── Shape by kind ───────────────────────────────────────────────────────── */

const KIND_SHAPE: Record<StampKind, StampShape> = {
  city: 'oval',
  plan: 'rect',
  gem:  'hexagon',
  safe: 'round',
  host: 'rect',
  perk: 'round',
};

/* ── City caption lookup ─────────────────────────────────────────────────── */

const CITY_CAPTIONS: Record<string, string> = {
  cebu:    'DIVING',
  manila:  'HISTORY',
  tokyo:   'TEMPLES',
  bangkok: 'STREET FOOD',
  bali:    'CULTURE',
  paris:   'ROMANCE',
  london:  'CULTURE',
  dubai:   'LUXURY',
  seoul:   'K-CULTURE',
  bkk:     'STREET FOOD',
};

function cityCaption(stamp: PassportStamp): string | undefined {
  const hay = `${stamp.label} ${stamp.sublabel ?? ''}`.toLowerCase();
  for (const [slug, caption] of Object.entries(CITY_CAPTIONS)) {
    if (hay.includes(slug)) return caption;
  }
  return undefined;
}

/* ── Accessibility label ─────────────────────────────────────────────────── */

function buildAccessibilityLabel(
  stamp: PassportStamp,
  categoryLabel: string,
  locked: boolean,
): string {
  if (locked) return `Locked ${categoryLabel} stamp — not yet earned`;
  const parts: string[] = [stamp.label];
  if (stamp.sublabel) parts.push(stamp.sublabel);
  parts.push(`${categoryLabel} stamp`);
  return parts.join(' — ');
}

/* ── Public resolver ─────────────────────────────────────────────────────── */

/**
 * Resolve a PassportStamp into a StampArtworkDef.
 * This function is pure — it has no side effects and never throws.
 */
export function resolveArtwork(stamp: PassportStamp): StampArtworkDef {
  const theme = CATEGORY_THEME[stamp.kind];
  // Prefer the authoritative rarity from the stamp definition when known;
  // only fall back to the kind-based guess for legacy stamps without one.
  // Using the kind guess when a real rarity exists caused header/subtitle
  // rarity mismatches (e.g. "Rare" badge vs "COMMON" artwork subtitle).
  const rarity = stamp.rarity ?? KIND_RARITY[stamp.kind];
  const locked = stamp.locked ?? false;

  const def: StampArtworkDef = {
    shape:         KIND_SHAPE[stamp.kind],
    borderStyle:   RARITY_BORDER[rarity],
    borderWeight:  RARITY_WEIGHT[rarity],
    accent:        locked ? STAMP_LOCKED_COLOR : theme.accent,
    background:    locked ? STAMP_LOCKED_BG    : theme.background,
    pattern:       locked ? 'solid'             : theme.pattern,
    texture:       locked ? 'worn'              : RARITY_TEXTURE[rarity],
    iconKey:       theme.iconKey,
    categoryLabel: theme.label,
    rarity,
    hasShimmer:    !locked && (rarity === 'epic' || rarity === 'legendary'),
    hasGlow:       !locked && rarity === 'legendary',
    locked,
    accessibilityLabel: buildAccessibilityLabel(stamp, theme.label, locked),
  };

  if (stamp.kind === 'city') {
    const caption = cityCaption(stamp);
    if (caption) def.captionText = caption;
  }

  return def;
}

/**
 * Determine the rarity of a stamp kind.
 * Exported for use in admin previews and tests.
 */
export function rarityForKind(kind: StampKind): StampRarity {
  return KIND_RARITY[kind];
}

/** All category themes keyed by StampKind — exported for admin preview. */
export { CATEGORY_THEME };
