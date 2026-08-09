/**
 * Travel Buddy — design tokens
 * Editorial / passport visual direction. One bold device (the stamp),
 * everything else quiet so imagery leads.
 */
import type { TextStyle } from 'react-native';

export const color = {
  ink: '#11110F', // near-black text + immersive surfaces
  paper: '#FAF9F6', // base background
  paperRaised: '#FFFFFF', // cards on paper
  signal: '#FF4D2E', // vermilion — primary action + live pulse only
  signalDim: '#E5391C',
  deep: '#0A3D4A', // teal-ink — destination accents
  haze: '#E8E5DE', // dividers, card edges
  mute: '#6B6862', // secondary text
  faint: '#9C988F', // tertiary text, placeholders
  scrimTop: 'rgba(17,17,15,0)',
  scrimBottom: 'rgba(17,17,15,0.78)',
  onInk: '#FAF9F6', // text on dark/immersive
  onInkMute: 'rgba(250,249,246,0.72)',
  success: '#2E7D5B',
  warn: '#C8851A',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  pill: 999,
} as const;

/**
 * Type roles:
 *  - display: condensed grotesque feel, tight, big editorial titles
 *  - body: humanist sans for reading
 *  - stamp: monospace for tags, distances, dates, costs (passport-stamp device)
 *
 * Using system fonts now so the shell runs with zero font-loading.
 * Swap `display`/`stamp` for loaded faces later (e.g. Archivo, IBM Plex Mono).
 */
export const font = {
  display: undefined as string | undefined, // system bold, condensed via letterSpacing
  body: undefined as string | undefined,
  stamp: 'Courier' as string, // monospace, available on iOS/Android
} as const;

export const type = {
  hero: { fontSize: 30, lineHeight: 32, fontWeight: '800', letterSpacing: -0.8 },
  title: { fontSize: 22, lineHeight: 26, fontWeight: '800', letterSpacing: -0.5 },
  heading: { fontSize: 18, lineHeight: 23, fontWeight: '700', letterSpacing: -0.3 },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  bodyStrong: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  stamp: { fontSize: 11, lineHeight: 13, fontWeight: '700', letterSpacing: 0.5 },
} satisfies Record<string, TextStyle>;

export const shadow = {
  card: {
    shadowColor: '#11110F',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  float: {
    shadowColor: '#11110F',
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
} as const;

/**
 * Normalized sizing tokens for the design-layer pass.
 *
 * `action` is the one canonical size for icons in a post/media action row
 * (Stamp, Comment, Share, Save, More) per icon-spacing spec §2. Note the spec
 * specifies a *visible* size — see components/ui/ActionRowIcon.tsx, which is
 * what turns this number into a matching rendered glyph for icon families whose
 * artwork fills its viewBox differently.
 */
export const icon = { sm: 14, md: 18, lg: 22, xl: 26, action: 20 } as const;

/**
 * Named typography roles — every text element in the app maps to exactly one
 * role. Use these instead of hardcoded fontSize/lineHeight/fontWeight values.
 */
export const typography = {
  display:      { fontSize: 30, lineHeight: 32, fontWeight: '800' as const, letterSpacing: -0.8 },
  pageTitle:    { fontSize: 22, lineHeight: 26, fontWeight: '800' as const, letterSpacing: -0.5 },
  sectionTitle: { fontSize: 18, lineHeight: 23, fontWeight: '700' as const, letterSpacing: -0.3 },
  cardTitle:    { fontSize: 15, lineHeight: 20, fontWeight: '700' as const },
  body:         { fontSize: 15, lineHeight: 22, fontWeight: '400' as const },
  supporting:   { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  label:        { fontSize: 12, lineHeight: 16, fontWeight: '600' as const },
  caption:      { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  button:       { fontSize: 14, lineHeight: 20, fontWeight: '700' as const },
  metadata:     { fontSize: 11, lineHeight: 14, fontWeight: '600' as const, letterSpacing: 0.4 },
} satisfies Record<string, import('react-native').TextStyle>;

/**
 * Explicit numeric spacing scale. Prefer the named `space` tokens for component
 * internal padding/gap; use `spacing` when a component needs to express size as
 * a numeric value (e.g. skeleton placeholder heights).
 */
export const spacing = {
  4: 4,
  8: 8,
  12: 12,
  16: 16,
  20: 20,
  24: 24,
  32: 32,
  40: 40,
} as const;

/**
 * Standard image aspect ratios (width / height).
 *
 * `portrait` is 4/5 — the Facebook/Instagram portrait-post standard, and the
 * ratio MasonryGrid.tsx actually falls back to for dimensionless media
 * (`colWidth * 1.25`, i.e. height/width = 5/4). This was 3/4 until 2026-08-09;
 * nothing in the app ever rendered 3/4, so it was a dead, incorrect default —
 * fixed here rather than left for whoever reaches for it next.
 * `story` (9/16) is the vertical ratio StoryComposer's preview renders at.
 */
export const aspect = { wide: 16 / 9, card: 4 / 3, square: 1, portrait: 4 / 5, story: 9 / 16 } as const;

/**
 * Avatar sizing scale.
 *
 * Derived from the actual distribution of hardcoded circular avatar sizes
 * across app/ and src/ (grepped 2026-08-09): 28/32/36/40 each appear 13-16
 * times as independent, un-migrated values — a scale nobody had to reach for,
 * so they drifted into four near-identical sizes instead of one. 48 and 56
 * are the next real, repeated tier (profile-header-sized avatars, 5 uses
 * each). All six are observed values, not invented ones; nothing below 28 is
 * included because that range is already served by `icon` (max 26).
 *
 * `smMd` (34) and `lgXl` (44) were added 2026-08-09 after a follow-up sweep
 * of near-miss circular-box literals (see docs/design/sizing-near-misses.md):
 * 34 appears at 23 independent call sites and 44 at 19, each reproducing the
 * exact same circular icon-button/avatar shape across unrelated components
 * (event sheets, passport screens, map pins, stamp pickers, etc) with no
 * co-occurring 32/36/40 use of the same element in those files — i.e. not a
 * typo'd/drifted existing token, but two real, deliberately-reused sizes
 * that just don't line up with the xs/sm/md/lg/xl/xxl steps. Named for their
 * position in the scale (`smMd` sits between `sm` and `md`, `lgXl` between
 * `lg` and `xl`) rather than continuing the tier-letter sequence, since they
 * are not a new tier — they are an infill.
 */
export const avatar = { xs: 28, sm: 32, smMd: 34, md: 36, lg: 40, lgXl: 44, xl: 48, xxl: 56 } as const;

/**
 * Dot sizing scale — small circular status/presence indicators (live dots,
 * unread badges, freshness badges, timeline/legend dots). Deliberately a
 * SEPARATE token group from `avatar`, not an extension of it downward: these
 * are a different semantic category (an indicator glyph, never a person's
 * photo/initials) even though the guard that enforces both lives in the same
 * script. Added 2026-08-09 after classifying the sub-14px band of
 * `docs/design/sizing-near-misses.md` — 88 of 94 sites there were this exact
 * recurring "dot" shape (named `liveDot`/`killDot`/`visDot`/`unreadDot`/
 * `freshDot`/etc at the call sites themselves, independently, well before
 * this token existed) spanning 6/7/8/10/12px, reused across dozens of
 * unrelated components.
 *
 * Three additional sites were genuine drift (a typo'd/near-miss size, not a
 * new tier) and were normalized to the nearest real tier rather than
 * tokenized as their own value: a 9px dot -> `s8`, an 11px "freshDot" -> `s12`
 * (matching the visually-identical presence-badge pattern already using 12),
 * and a 4px decorative "bandDot" -> `s5`.
 *
 * `StampItBurst.tsx`'s `INK_DOTS` array (sizes 3/4/4/5/6, one file only) was
 * deliberately excluded from this token set even though its name says
 * "dots" too: it's a single decorative burst effect using graduated,
 * intentionally-varied particle sizes for an organic look, not a reusable
 * semantic size. Forcing its particles onto shared tiers would remove the
 * variety that's the point of the effect. Its duplicate-literal shape was
 * refactored into a small local size helper instead, so it neither drifts
 * unnoticed nor false-positives against this token's guard.
 *
 * Keys are numeric-pixel (`s<value>`) rather than tier letters like `avatar`
 * uses: there is no established small/medium/large vocabulary for a 6-value
 * indicator-dot scale, and a bare numeric key isn't valid as a dot-access
 * identifier (`dot.5` doesn't parse) — `s<value>` sidesteps inventing tier
 * names for values that are already self-describing as pixel sizes.
 */
export const dot = {
  s5: 5,
  s6: 6,
  s7: 7,
  s8: 8,
  s10: 10,
  s12: 12,
} as const;

/** Layout constraints. */
export const layout = {
  maxWidth: 720,        // desktop/tablet content cap
  hitSlop: { top: 6, bottom: 6, left: 6, right: 6 },
  pressedOpacity: 0.85,
} as const;
