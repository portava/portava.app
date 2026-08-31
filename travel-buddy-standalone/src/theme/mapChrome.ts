/**
 * Portava Map — dark chrome palette.
 *
 * Map spec §4 ("Base Map Appearance") is dark-mode-first: near-black/navy
 * interface chrome floating over a subdued geographic base, with bright
 * semantic Portava overlays above it. The rest of the app is the light
 * "paper" system in theme/tokens.ts; the map is the one surface that inverts.
 *
 * ## Why this file exists
 *
 * Every map surface built so far invented its own dark values. A grep of
 * src/components/map/*.tsx (2026-08-31) found the SAME handful of colours
 * retyped across unrelated components:
 *
 *   #0E1216                  LayersSheet, LivePlaceSheet, OptimizeTodaySheet
 *   #0B1017                  CheckpointPin, LocateFriendsPanel
 *   #171C22                  LayersSheet, LivePlaceSheet
 *   #1F262E / #2A323B        LayersSheet, LivePlaceSheet
 *   #F2F5F7                  LayersSheet, LivePlaceSheet
 *   rgba(242,245,247,0.62)   LayersSheet, LivePlaceSheet
 *   rgba(242,245,247,0.40)   LayersSheet, LivePlaceSheet
 *   rgba(255,255,255,0.14)   IntentSheet, LivePulseCard, MapBottomActions,
 *                            OptimizeTodaySheet
 *   rgba(4,6,8,0.55/0.62)    LivePlaceSheet, LayersSheet
 *   #0A3D4A (= color.deep)   AskCompassBar, LivePulseCard, OptimizeTodaySheet
 *
 * That is the avatar/icon-token story again (see tokens.ts): with nowhere to
 * reach, near-identical values drift apart and cannot be restyled as a group.
 * These tokens are the observed cluster, not invented values.
 *
 * ## Two groups
 *
 * `mapChrome` — the floating UI (cards, sheets, control bars, pills) that sits
 * ABOVE the map. Level 4-7 in spec §5.
 *
 * `mapBase` — the geographic base itself (spec §5 levels 0-1), consumed by
 * constants/mapStyle.ts to paint the MapLibre style. It lives here rather than
 * in mapStyle.ts so chrome and geography are tuned against each other in one
 * place: the whole point of §4 is that the base recedes BEHIND the chrome.
 */
import { color } from './tokens.ts';

/**
 * Floating map chrome — cards, sheets, controls layered over the map.
 *
 * Opacity choices are deliberate: §4 asks for "rounded translucent cards", so
 * separators and inset fills are alpha-on-white rather than opaque greys. That
 * keeps them correct over both `surface` and over live map tiles.
 */
export const mapChrome = {
  /** Primary chrome fill — sheets, control bars, cards. The default surface. */
  surface: '#0E1216',
  /** A card/row sitting ON `surface` — one step lighter. */
  surfaceRaised: '#171C22',
  /** Deepest fill — pin bodies and panels that must read as "further back". */
  surfaceDeep: '#0B1017',
  /** Inset fill — chips, segmented-control tracks, disabled wells. */
  surfaceInset: '#1F262E',
  /** Translucent inset for chrome floating directly over map tiles. */
  surfaceTranslucent: 'rgba(14,18,22,0.78)',

  /** Default 1px separator over dark chrome. */
  hairline: 'rgba(255,255,255,0.14)',
  /** Barely-there separator — inside an already-inset surface. */
  hairlineFaint: 'rgba(255,255,255,0.08)',
  /** Opaque border where a translucent one would show the map through it. */
  hairlineStrong: '#2A323B',

  /** Primary text/icon on dark chrome. */
  textOnDark: '#F2F5F7',
  /** Secondary text — labels, metadata, inactive icons. */
  textOnDarkMute: 'rgba(242,245,247,0.62)',
  /** Tertiary text — placeholders, disabled. */
  textOnDarkFaint: 'rgba(242,245,247,0.40)',

  /** Full-screen dim behind a modal sheet. */
  scrim: 'rgba(4,6,8,0.62)',
  /** Lighter dim — behind a peek/half sheet where the map must stay readable. */
  scrimSoft: 'rgba(4,6,8,0.55)',

  /** Brand accent on dark chrome (teal-ink, = tokens color.deep). */
  brand: color.deep,
  /** Live/primary-action accent (vermilion, = tokens color.signal). */
  signal: color.signal,

  /**
   * Shadow for chrome floating over the map. `shadow.float` in tokens.ts is
   * tuned for dark-on-light; over a near-black base a soft glow-less drop at
   * higher opacity is what actually separates the card from the tiles.
   */
  float: {
    shadowColor: '#000000',
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
} as const;

/**
 * The geographic base (spec §5 levels 0-1). Consumed by constants/mapStyle.ts.
 *
 * Every value here is deliberately LOW SATURATION and LOW LUMINANCE per §4.
 * The two exceptions are `water` and the label colours: §4 explicitly requires
 * "recognizable water and major road labels", so water is tinted toward the
 * brand teal far enough to separate from land, and labels sit high enough
 * above the base to be legible — but still below any Portava overlay.
 */
export const mapBase = {
  /** Level 0 — the ground. Near-black navy. */
  ground: '#070B10',
  /** Residential / built-up land, a hair above the ground. */
  land: '#0B1017',
  /** Parks and woodland — desaturated toward green, not green. */
  green: '#0C1512',
  /** Water body fill — recognizable, brand-tinted, still dark. */
  water: '#0B2A33',
  /** Rivers/streams. */
  waterway: '#123540',

  /** Building footprints (z12+). */
  building: '#111823',
  /** Building outline — just enough to read block shapes at street zoom. */
  buildingOutline: '#18202B',

  /** Motorways / trunk — the only roads that read at city zoom. */
  roadMotorway: '#2E3946',
  /** Primary / secondary / tertiary. */
  roadMajor: '#232C37',
  /** Residential / service / track — barely above the ground. */
  roadMinor: '#171E27',
  /** Casing under motorway + major, for the road-over-road stacking order. */
  roadCasing: '#39454F',
  /** Rail. */
  rail: '#1C242E',

  /** Admin boundaries. */
  boundary: 'rgba(150,172,192,0.24)',

  /** Place + road label text. */
  label: '#93A3B2',
  /** Larger/major place labels. */
  labelStrong: '#B6C4D1',
  /** Water label — tinted to match the water it names. */
  labelWater: '#6E9CAC',
  /** Halo behind every label so it survives over any base fill. */
  labelHalo: '#05080C',
} as const;

export type MapChrome = typeof mapChrome;
export type MapBase = typeof mapBase;
