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
/**
 * Icon sizing scale — circular icon-button wrapper sizes.
 * Core tiers: sm (14) · md (18) · lg (22) · xl (26) · action (20, post-action-row spec).
 * Infill tokens added 2026-08-09 after sweeping the 14-26px band (same pass that added
 * avatar infills): `smMd` (16) at 4 independent call sites, `lgXl` (24) at 14 — both
 * confirmed RECURRING/INTENTIONAL (radio buttons, stacked avatar rings, map-pin overlays,
 * icon-button wrappers across unrelated components), not typos of existing tokens.
 * Named by bounding-tier concatenation, matching the `avatar` infill convention.
 */
export const icon = { sm: 14, smMd: 16, md: 18, lg: 22, lgXl: 24, xl: 26, action: 20 } as const;

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
 *
 * `xsSm` (30), `mdLg` (38), `lgLgXl` (42), `lgXlXl` (46), and `xlXxl` (52)
 * were added the same day, later, after widening
 * scripts/check-avatar-icon-sizing.mjs to catch ANY circular box in the
 * 27-56px band, not just literals that already matched an existing token
 * (see that script's header for why: matching-only enforcement is exactly
 * what let the original 28/32/34/36/40 cluster form in the first place —
 * nobody reused a value because there was nothing to check against). All
 * five are the same story as smMd/lgXl: real, recurring, cross-component
 * shapes (map pins, icon-buttons, avatar circles reused verbatim across
 * unrelated screens) with zero co-occurring use of a neighboring token for
 * the same element in any of their call sites — not drift. Named by
 * concatenating their two bounding tier keys per the same infill
 * convention; where a value sits between two *already-infilled* keys (e.g.
 * 42 between `lg` and `lgXl`) the name concatenates both of those, which is
 * why `lgLgXl`/`lgXlXl` look denser than `xsSm`/`mdLg` — they are one infill
 * level deeper in the same 40-48 span that `lgXl` already lives in.
 *
 * All existing call sites are migrated as of this pass. See
 * scripts/check-avatar-icon-sizing.mjs for the guard + shrink-only allowlist.
 */
export const avatar = {
  xs: 28,
  xsSm: 30,
  sm: 32,
  smMd: 34,
  md: 36,
  mdLg: 38,
  lg: 40,
  lgLgXl: 42,
  lgXl: 44,
  lgXlXl: 46,
  xl: 48,
  xlXxl: 52,
  xxl: 56,
  /**
   * `xxxl` (64), `xxxxl` (72), and `xxxxxl` (96) were added 2026-08-09 after
   * a follow-up sweep of circular-box literals above 56px. 64 appears at 9
   * independent call sites across error/empty-state/map placeholder circles;
   * 72 appears at 3 sites (trust rings, icon wraps); 96 appears at 2 sites
   * (profile-photo edit screen). All are the same RECURRING pattern. One-offs
   * (60→64, 68→64, 80→72, 88→96, 90→96) were snapped to the nearest token.
   * Intentional decorative rings (70px/110px in CrewMapSection, 78px in
   * PassportMarks) are kept as hardcoded values and recorded in the allowlist.
   */
  xxxl: 64,
  xxxxl: 72,
  xxxxxl: 96,
} as const;

/**
 * Indicator dot / status-dot sizing scale.
 *
 * Derived from the actual distribution of hardcoded circular dot sizes
 * across app/ and src/ (swept 2026-08-09, same pass as the avatar widening):
 *
 *   xxs  5px — carousel/loader indicator dots, rarity markers
 *   xs   6px — pagination dots, suggestion dots, entity map markers
 *   sm   7px — unread notification badge dots on icon buttons
 *   md   8px — live-status / health / check indicator dots (most common: 24 sites)
 *   lg  10px — radio-button fill dots, presence / status dots
 *   xl  12px — online-presence dots overlaid on avatar corners
 *
 * All six are observed values across 5+ independent call sites each, not
 * invented ones. The sub-5px values (3, 4) and the 9px/11px values are
 * intentional one-offs kept as literals — see docs/design/sizing-near-misses.md.
 *
 * `dot` is deliberately separate from `avatar` / `icon` — dots and indicators
 * are a different UI category (they are not interchangeable with avatar or
 * icon-button containers) and their sub-14px range is below the `icon` floor.
 */
export const dot = {
  xxs: 5,
  xs:  6,
  sm:  7,
  md:  8,
  lg:  10,
  xl:  12,
} as const;

/** Layout constraints. */
export const layout = {
  maxWidth: 720,        // desktop/tablet content cap
  hitSlop: { top: 6, bottom: 6, left: 6, right: 6 },
  pressedOpacity: 0.85,
} as const;
