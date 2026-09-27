/**
 * features/media — §46 "Dark/night-friendly primary foundation with HIGH
 * CONTRAST and clear state labels", measured from the source (census-media
 * MD403, §27).
 *
 * WHAT THIS MEASURES
 * ------------------
 * Every text-colour / background-colour pair the Media World surfaces paint,
 * and every state indicator (dot, bar, border, glyph, selected fill, marker)
 * that carries a state, computed with the WCAG 2.x relative-luminance contrast
 * formula after alpha-compositing each translucent layer onto what is really
 * beneath it.
 *
 *   - Colours come FROM THE SOURCE: tokens, the state maps, the gem accent and
 *     contours, and the dark map palette are imported; component-local
 *     literals (washes, scrims, fallbacks, sheet fills) are listed here AND
 *     checked against the component file by a needle, so a component that
 *     changes a colour turns this file red until the pair is re-measured.
 *   - Scope: MediaWorldShell.tsx and every lens screen it renders; the Media
 *     routes that paint the same ink ground (/media-map, /media-search,
 *     /media-timeline, /media-contribute, /media-perspective); every
 *     component under src/features/media those render (World header, lens
 *     tabs, mode bar, state views, NOW dashboard, Places, Experiences, Hidden
 *     Gems cards, People, My World, the Media Map list and canvas, Search, the
 *     §17 Timeline, the contribution sheet, the perspective viewer and its
 *     "what this is part of" context sheet, the offline/cached labels); the
 *     "Why this?" sheet the shell renders; MediaActionRail and its panels
 *     (the media viewer's action sheet); and RequestAViewPrompt, a
 *     features/media component rendered on the light place page.
 *     ContributorViewOptInToggle paints no colour of its own (SettingsUI
 *     does), and GemContributeSection (inside a rail panel) belongs to the
 *     gems components, not this directory.
 *
 * THRESHOLDS (WCAG 2.x AA)
 *   text  >= 4.5:1 — applied to ALL text, placeholder text included, and to
 *                    the few pairs that would qualify as large text. No
 *                    large-text relief is claimed; every large pair clears 4.5.
 *   ui    >= 3.0:1 — non-text state indicators, markers and actionable icons
 *                    (1.4.11).
 *   decor  measured and printed, never asserted — marks whose state is carried
 *                    by an adjacent text label (the gem contour, the neutral
 *                    pulse bar), a disclosure chevron, or a disabled control
 *                    (1.4.3 exempts inactive components).
 *
 * TEXT OVER PHOTOGRAPHY, AND MARKERS OVER THE MAP
 * -----------------------------------------------
 * Where text sits on a scrim over a photo, the colour beneath the scrim is the
 * photo, which no file can know. Two numbers are measured instead:
 *   - the FALLBACK — the fill the component paints when there is no image,
 *     asserted like any solid pair;
 *   - the FLOOR — the lowest ratio over every underlay on a 16-level-per-
 *     channel grid spanning the sRGB cube (4096 colours). That is the contrast
 *     the scrim GUARANTEES. The repository's own standard for a scrim is that it
 *     protects text over a bright photo (src/components/__tests__/
 *     postScrim.contrast.test.ts uses a white fixture), so a floor below
 *     threshold is a finding, not a device question.
 * The Media Map is different: its style IS in the tree (PORTAVA_DARK_MAP_STYLE
 * paints only the `mapBase` palette in src/theme/mapChrome.ts), so map
 * markers are floored over every colour that style paints, not over a photo.
 * The two remote fallback styles it switches to on a load failure are not in
 * the tree and are not measured.
 *
 * FINDINGS ARE PINNED, NOT HIDDEN
 * -------------------------------
 * A pair measured below its threshold carries `finding: <ratio>`. The test
 * asserts it is STILL below threshold and still measures that ratio, so a fix
 * turns this file red with an instruction to promote the pair — the list can
 * only shrink on purpose. Print the full measured table with
 *   MEDIA_CONTRAST_TABLE=1 node --import tsx --test src/features/media/__tests__/mediaContrast.test.ts
 *
 * DYNAMIC TYPE
 * ------------
 * The code-checkable half: no Text in these surfaces opts out of OS font
 * scaling (`allowFontScaling={false}`), none caps it (`maxFontSizeMultiplier`),
 * and no global `Text.defaultProps` override exists in app/ or src/. How the
 * layout behaves at 200% type on a device is not measured here.
 *
 * Pure TypeScript — no React, no native modules, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { color } from '../../../theme/tokens.ts';
import { mapBase } from '../../../theme/mapChrome.ts';
import { FRESHNESS_COLOR, OBSERVATION_COLOR, ZONE_COLOR } from '../state/stateColors.ts';
import { RENDER_CLASS_OBSERVATION } from '../state/timeBands.ts';
import { GEM_ACCENT, gemContourTreatment } from '../state/gemLens.ts';
import type { HiddenGemState } from '../types/hiddenGemMedia.ts';

// `dirname(fileURLToPath(import.meta.url))` — the string form; see
// src/platform/input-assistance/services/__tests__/selectionWriterCoverage.test.ts
// for why `new URL()` is avoided in this workspace.
const HERE = dirname(fileURLToPath(import.meta.url));
// …/src/features/media/__tests__ → the standalone app root.
const APP_ROOT = join(HERE, '..', '..', '..', '..');

// ── WCAG 2.x helpers ─────────────────────────────────────────────────────────

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = hex[1];
    return {
      r: parseInt(n.slice(0, 2), 16),
      g: parseInt(n.slice(2, 4), 16),
      b: parseInt(n.slice(4, 6), 16),
      a: 1,
    };
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (fn) {
    const parts = fn[1].split(',').map((p) => Number(p.trim()));
    if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) {
      throw new Error(`unparseable colour: ${value}`);
    }
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  throw new Error(`unparseable colour: ${value}`);
}

/** Source-over compositing of `fg` onto an OPAQUE `bg`. */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function channel(u8: number): number {
  const c = u8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The photograph beneath a scrim — resolved by `floorRatio`, never by a file. */
const PHOTO = 'PHOTO';
/** The in-tree dark map beneath a marker — resolved over MAP_PAINTS. */
const MAP = 'MAP';

/** Flatten a bottom-first layer stack. The bottom layer must be opaque. */
function flatten(layers: readonly string[], under?: Rgba): Rgba {
  const [bottom, ...rest] = layers;
  let bg: Rgba;
  if (bottom === PHOTO || bottom === MAP) {
    if (!under) throw new Error(`${bottom} layer needs an underlay`);
    bg = under;
  } else {
    bg = parseColor(bottom);
    if (bg.a !== 1) throw new Error(`bottom layer must be opaque: ${bottom}`);
  }
  for (const layer of rest) bg = over(parseColor(layer), bg);
  return bg;
}

/** Contrast of `fg` (itself possibly translucent) painted on the flattened stack. */
function ratioOn(fg: string, layers: readonly string[], under?: Rgba): number {
  const bg = flatten(layers, under);
  return contrast(over(parseColor(fg), bg), bg);
}

/** 16 levels per channel, black and white included: 4096 photo underlays. */
const GRID_LEVELS = Array.from({ length: 16 }, (_, i) => i * 17);

/**
 * Every AREA and LINE colour PORTAVA_DARK_MAP_STYLE paints, flattened onto its
 * ground — the translucent fills at the opacities the style gives them — plus
 * the §46.1 gem-zone wash MediaMapCanvas draws on top. The four `label*`
 * colours are text glyphs placed by collision detection; a marker is never
 * wholly over one, so they are not a marker's underlay. (With them included
 * the gem marker's floor is ~1.0:1 against `label`, which is reported in the
 * census rather than hidden.)
 */
const MAP_GROUND = parseColor(mapBase.ground);
const MAP_AREA_KEYS = Object.keys(mapBase).filter((k) => !k.startsWith('label')) as Array<keyof typeof mapBase>;
const MAP_PAINTS: Rgba[] = [
  ...MAP_AREA_KEYS.map((k) => over(parseColor(mapBase[k]), MAP_GROUND)),
  over({ ...parseColor(mapBase.land), a: 0.6 }, MAP_GROUND),
  over({ ...parseColor(mapBase.green), a: 0.9 }, MAP_GROUND),
  over({ ...parseColor(mapBase.green), a: 0.7 }, MAP_GROUND),
  over({ ...parseColor(GEM_ACCENT), a: 0.12 }, MAP_GROUND),
];

/** The lowest ratio over every underlay the surface can have. */
function floorRatio(fg: string, layers: readonly string[]): number {
  let min = Infinity;
  if (layers[0] === MAP) {
    for (const under of MAP_PAINTS) min = Math.min(min, ratioOn(fg, layers, under));
    return min;
  }
  for (const r of GRID_LEVELS) {
    for (const g of GRID_LEVELS) {
      for (const b of GRID_LEVELS) {
        const v = ratioOn(fg, layers, { r, g, b, a: 1 });
        if (v < min) min = v;
      }
    }
  }
  return min;
}

// ── Surfaces (bottom-first). Literals are needle-checked in the pairs below ───

const WASH = (alpha: string) => `rgba(250,249,246,${alpha})`;

const S = {
  /** The shell and every Media route ground (`safe: … color.ink`). */
  ink: [color.ink],
  /** Card / row wash (ChangingNowCard, pulse, mosaics, chain cards, place/map/search rows, memory). */
  card: [color.ink, WASH('0.05')],
  /** ForYouNowStrip chip, contribution media slot and note field. */
  chip06: [color.ink, WASH('0.06')],
  /** Media Map selected-cluster card. */
  chip07: [color.ink, WASH('0.07')],
  /** Lens tabs, mode bar, icon buttons, group/bucket/search chips, the search field. */
  chip08: [color.ink, WASH('0.08')],
  /** A selected Media Map row. */
  rowSelected: [color.ink, WASH('0.12')],
  /** FreshnessBadge / retry button directly on the ground. */
  pill10: [color.ink, WASH('0.10')],
  /** FreshnessBadge / private pill / bar track on a card. */
  pill10OnCard: [color.ink, WASH('0.05'), WASH('0.10')],
  /** FreshnessBadge on a selected Media Map row. */
  pill10OnRowSelected: [color.ink, WASH('0.12'), WASH('0.10')],
  /** Selected tab / segment / chip / primary button fill. */
  selected: [color.onInk],
  /** ExperienceMosaic state chip: a teal tint on the card. */
  tealChipOnCard: [color.ink, WASH('0.05'), 'rgba(61,214,196,0.16)'],
  /** HiddenGemCard row: a gem-tinted wash on the ground. */
  gemRow: [color.ink, 'rgba(16,185,129,0.05)'],
  /** HiddenGemCard tile body and image fallback. */
  gemTile: ['#15201C'],
  /** MediaContextSheet ("What this is part of"), and its "Where was this taken?" button. */
  contextSheet: ['#161614'],
  contextSheetButton: ['#161614', WASH('0.1')],
  /** Light sheets and cards: MediaActionRail + panels, WhyThisSheet, ContributorTrustChips, RequestAViewPrompt chips. */
  paper: [color.paper],
  /** MediaActionRail's active "I want this" row. */
  paperSignalTint: [color.paper, 'rgba(255,77,46,0.08)'],
  paperRaised: [color.paperRaised],
  haze: [color.haze],
  /** A disabled contribution submit: the whole control at opacity 0.4 over the ground. */
  disabledSubmit: [color.ink, 'rgba(250,249,246,0.4)'],

  // Over photography: `…Fallback` is the painted no-image fill, `…Photo` the scrim over a photo.
  tileScrimFallback: ['#22221E', 'rgba(17,17,15,0.71)'], // census-media §31: was 0.55
  tileScrimPhoto: [PHOTO, 'rgba(17,17,15,0.71)'], // census-media §31: was 0.55
  tilePlayFallback: ['#22221E', 'rgba(17,17,15,0.5)'],
  tilePlayPhoto: [PHOTO, 'rgba(17,17,15,0.5)'],
  cardChipFallback: ['#22221E', 'rgba(17,17,15,0.88)'], // census-media §31: was 0.55
  cardChipPhoto: [PHOTO, 'rgba(17,17,15,0.88)'], // census-media §31: was 0.55
  viewerOverlayFallback: ['#1B1B18', 'rgba(17,17,15,0.96)'], // census-media §31: was 0.62 (and on the five lines below)
  viewerOverlayPhoto: [PHOTO, 'rgba(17,17,15,0.96)'],
  viewerChipFallback: ['#1B1B18', 'rgba(17,17,15,0.96)', WASH('0.10')],
  viewerChipPhoto: [PHOTO, 'rgba(17,17,15,0.96)', WASH('0.10')],
  viewerPillFallback: ['#1B1B18', 'rgba(17,17,15,0.96)', WASH('0.14')],
  viewerPillPhoto: [PHOTO, 'rgba(17,17,15,0.96)', WASH('0.14')],
  viewerTitleFallback: ['#1B1B18', 'rgba(17,17,15,0.59)'], viewerBufferingFallback: ['#1B1B18', 'rgba(17,17,15,0.71)'], // census-media §31: each on its own badge (was bare `viewerBareFallback`)
  viewerTitlePhoto: [PHOTO, 'rgba(17,17,15,0.59)'], viewerBufferingPhoto: [PHOTO, 'rgba(17,17,15,0.71)'], // census-media §31: each on its own badge (was bare `viewerBarePhoto`, 1.00:1)
  viewerIconBtnPhoto: [PHOTO, 'rgba(17,17,15,0.55)'],
  viewerControlPhoto: [PHOTO, 'rgba(17,17,15,0.7)'],
  viewerPlayBadgePhoto: [PHOTO, 'rgba(17,17,15,0.59)'], // census-media §31: was 0.5
  viewerCaptionPhoto: [PHOTO, 'rgba(17,17,15,0.74)'],
  viewerProgressTrackPhoto: [PHOTO, 'rgba(17,17,15,0.80)'], // census-media §31: a dark track; was WASH('0.26')

  // Over the in-tree dark map.
  map: [MAP],
  mapBubble: [MAP, 'rgba(17,17,15,0.86)'],
  mapBubbleFallback: ['#1A1A17', 'rgba(17,17,15,0.86)'],
  mapGemMarker: [MAP, 'rgba(16,185,129,0.12)'],
} as const satisfies Record<string, readonly string[]>;

type SurfaceId = keyof typeof S | keyof typeof S_TAIL; // census-media §31.12: plus the surfaces the tail measures
type Kind = 'text' | 'ui' | 'decor';

const THRESHOLD: Record<Exclude<Kind, 'decor'>, number> = { text: 4.5, ui: 3 };

/** [file relative to the app root, literal substring or pattern that must be in it]. */
type Needle = readonly [file: string, needle: string | RegExp];

interface Pair {
  id: string;
  fg: string;
  on: SurfaceId;
  kind: Kind;
  at: readonly Needle[];
  /** Pinned finding: the measured ratio (2 dp) of a pair that is below threshold. */
  finding?: number;
}

// ── Files ────────────────────────────────────────────────────────────────────

const F = {
  shell: 'src/features/media/screens/MediaWorldShell.tsx',
  routeMap: 'app/media-map/index.tsx',
  routeSearch: 'app/media-search/index.tsx',
  routeTimeline: 'app/media-timeline/index.tsx',
  routeContribute: 'app/media-contribute/index.tsx',
  header: 'src/features/media/components/MediaWorldHeader.tsx',
  tabs: 'src/features/media/components/LensTabBar.tsx',
  modes: 'src/features/media/components/PresentationModeBar.tsx',
  lensState: 'src/features/media/components/LensStateView.tsx',
  freshness: 'src/features/media/components/FreshnessBadge.tsx',
  picture: 'src/features/media/components/CurrentPictureBadge.tsx',
  changing: 'src/features/media/components/ChangingNowCard.tsx',
  pulse: 'src/features/media/components/CityVisualPulse.tsx',
  trust: 'src/features/media/components/ContributorTrustChips.tsx',
  expMosaic: 'src/features/media/components/ExperienceMosaic.tsx',
  forYou: 'src/features/media/components/ForYouNowStrip.tsx',
  gemCard: 'src/features/media/components/HiddenGemCard.tsx',
  intel: 'src/features/media/components/IntelligenceStrip.tsx',
  actionRail: 'src/features/media/components/MediaActionRail.tsx',
  actionPanels: 'src/features/media/components/MediaActionPanels.tsx',
  contextSheet: 'src/features/media/components/MediaContextSheet.tsx',
  contribution: 'src/features/media/components/MediaContributionSheet.tsx',
  mapCanvas: 'src/features/media/components/MediaMapCanvas.tsx',
  timeRail: 'src/features/media/components/MediaTimeRail.tsx',
  memory: 'src/features/media/components/MyWorldMemorySection.tsx',
  mosaic: 'src/features/media/components/PerspectiveMosaic.tsx',
  tile: 'src/features/media/components/PerspectiveTile.tsx',
  requestView: 'src/features/media/components/RequestAViewPrompt.tsx',
  gems: 'src/features/media/screens/HiddenGemsMediaScreen.tsx',
  contributionScreen: 'src/features/media/screens/MediaContributionScreen.tsx',
  world: 'src/features/media/screens/MediaWorldScreen.tsx',
  experiences: 'src/features/media/screens/MediaExperiencesScreen.tsx',
  mapScreen: 'src/features/media/screens/MediaMapScreen.tsx',
  people: 'src/features/media/screens/MediaPeopleScreen.tsx',
  myWorld: 'src/features/media/screens/MyWorldMediaScreen.tsx',
  places: 'src/features/media/screens/MediaPlacesScreen.tsx',
  search: 'src/features/media/screens/MediaSearchScreen.tsx',
  timeline: 'src/features/media/screens/MediaTimelineScreen.tsx',
  viewer: 'src/features/media/screens/MediaPerspectiveViewerScreen.tsx',
  whyThis: 'src/components/media/WhyThisSheet.tsx',
} as const;

// Recurring surface needles.
const GROUND: Needle = [F.shell, 'safe: { flex: 1, backgroundColor: color.ink }'];
const ROUTE_GROUND = (file: string): Needle => [file, 'safe: { flex: 1, backgroundColor: color.ink }'];
const CARD = (file: string): Needle => [file, "backgroundColor: 'rgba(250,249,246,0.05)'"];
const CHIP08 = (file: string): Needle => [file, "backgroundColor: 'rgba(250,249,246,0.08)'"];
const PILL10 = (file: string): Needle => [file, "backgroundColor: 'rgba(250,249,246,0.10)'"];
const VIEWER_OVERLAY: Needle = [F.viewer, "backgroundColor: 'rgba(17,17,15,0.96)'"]; // census-media §31: was 0.62
const VIEWER_FALLBACK: Needle = [F.viewer, "frameFallback: { backgroundColor: '#1B1B18' }"];
const VIEWER_CHIP: Needle = [F.viewer, "backgroundColor: 'rgba(250,249,246,0.10)'"];

// ── The pairs ────────────────────────────────────────────────────────────────

const PAIRS: Pair[] = [];
const add = (p: Pair) => PAIRS.push(p);

// ─ Grounds: the shell and every Media route paint the same ink ─
for (const [id, file] of [['map', F.routeMap], ['search', F.routeSearch], ['timeline', F.routeTimeline], ['contribute', F.routeContribute]] as const) {
  add({ id: `route.${id}.ground`, fg: color.onInk, on: 'ink', kind: 'text', at: [ROUTE_GROUND(file)] });
}

// ─ MediaWorldHeader — on the ground; icon buttons on the 0.08 wash ─
add({ id: 'header.wordmark', fg: color.onInk, on: 'ink', kind: 'text', at: [GROUND, [F.header, /wordmark: \{\s*color: color\.onInk,/]] });
add({ id: 'header.subtitle', fg: color.onInk, on: 'ink', kind: 'text', at: [GROUND, [F.header, /subtitle: \{\s*color: color\.onInk,/]] });
add({ id: 'header.asOf', fg: color.onInkMute, on: 'ink', kind: 'text', at: [GROUND, [F.header, 'asOf: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'header.icons', fg: color.onInk, on: 'chip08', kind: 'ui', at: [[F.header, '<Search size={20} color={color.onInk}'], CHIP08(F.header)] });

// ─ LensTabBar ─
add({ id: 'tabs.label.inactive', fg: color.onInkMute, on: 'chip08', kind: 'text', at: [[F.tabs, 'const tint = isActive ? color.ink : color.onInkMute;'], CHIP08(F.tabs)] });
add({ id: 'tabs.label.active', fg: color.ink, on: 'selected', kind: 'text', at: [[F.tabs, 'const tint = isActive ? color.ink : color.onInkMute;'], [F.tabs, 'tabActive: { backgroundColor: color.onInk }']] });
add({ id: 'tabs.selectedFill', fg: color.onInk, on: 'ink', kind: 'ui', at: [GROUND, [F.tabs, 'tabActive: { backgroundColor: color.onInk }']] });

// ─ PresentationModeBar ─
add({ id: 'modes.label.inactive', fg: color.onInkMute, on: 'chip08', kind: 'text', at: [[F.modes, 'segText: { color: color.onInkMute'], CHIP08(F.modes)] });
add({ id: 'modes.label.active', fg: color.ink, on: 'selected', kind: 'text', at: [[F.modes, 'segTextActive: { color: color.ink }'], [F.modes, 'segActive: { backgroundColor: color.onInk }']] });
add({ id: 'modes.selectedFill', fg: color.onInk, on: 'chip08', kind: 'ui', at: [[F.modes, 'segActive: { backgroundColor: color.onInk }'], CHIP08(F.modes)] });

// ─ LensStateView — every lens's loading / empty / error state ─
add({ id: 'lensState.heading', fg: color.onInk, on: 'ink', kind: 'text', at: [GROUND, [F.lensState, 'heading: { color: color.onInk, fontSize: 17']] });
add({ id: 'lensState.body', fg: color.onInkMute, on: 'ink', kind: 'text', at: [GROUND, [F.lensState, 'body: { color: color.onInkMute, fontSize: 14']] });
add({ id: 'lensState.retry', fg: color.onInk, on: 'pill10', kind: 'text', at: [[F.lensState, 'retryText: { color: color.onInk'], PILL10(F.lensState)] });
add({ id: 'lensState.spinner', fg: color.onInkMute, on: 'ink', kind: 'ui', at: [[F.lensState, '<ActivityIndicator color={color.onInkMute} />']] });

// ─ FreshnessBadge — on the ground, on a card, and on a selected Media Map row ─
const FRESH_TEXT: Needle = [F.freshness, /text: \{\s*color: color\.onInkMute,/];
const FRESH_DOT: Needle[] = [[F.freshness, 'const dotColor = FRESHNESS_COLOR[freshness];'], [F.freshness, '{ backgroundColor: dotColor }']];
const MAP_ROW_BADGE: Needle[] = [[F.mapScreen, '{c.freshness ? <FreshnessBadge freshness={c.freshness} /> : null}'], [F.mapScreen, "rowSelected: { backgroundColor: 'rgba(250,249,246,0.12)' }"]];
add({ id: 'freshness.text.onGround', fg: color.onInkMute, on: 'pill10', kind: 'text', at: [FRESH_TEXT, PILL10(F.freshness)] });
add({ id: 'freshness.text.onCard', fg: color.onInkMute, on: 'pill10OnCard', kind: 'text', at: [FRESH_TEXT, PILL10(F.freshness), CARD(F.changing), [F.changing, '<FreshnessBadge freshness={item.freshness}']] });
add({ id: 'freshness.text.onSelectedMapRow', fg: color.onInkMute, on: 'pill10OnRowSelected', kind: 'text', at: [FRESH_TEXT, ...MAP_ROW_BADGE] });
for (const [k, v] of Object.entries(FRESHNESS_COLOR)) {
  add({ id: `freshness.dot.${k}.onGround`, fg: v, on: 'pill10', kind: 'ui', at: FRESH_DOT });
  add({ id: `freshness.dot.${k}.onCard`, fg: v, on: 'pill10OnCard', kind: 'ui', at: FRESH_DOT });
  add({ id: `freshness.dot.${k}.onSelectedMapRow`, fg: v, on: 'pill10OnRowSelected', kind: 'ui', at: [...FRESH_DOT, ...MAP_ROW_BADGE] });
}

// ─ CurrentPictureBadge — Places detail, tone 'dark', on the ground ─
add({ id: 'picture.label', fg: color.onInk, on: 'ink', kind: 'text', at: [[F.picture, "const textColor = tone === 'dark' ? color.onInk : color.ink;"], [F.places, '<CurrentPictureBadge']] });
add({ id: 'picture.sub', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.picture, "const subColor = tone === 'dark' ? color.onInkMute : color.mute;"]] });
for (const [k, v] of [['strong', '#3DD6C4'], ['moderate', '#8B9DFF'], ['low', '#9C988F']] as const) {
  add({ id: `picture.bar.${k}`, fg: v, on: 'ink', kind: 'ui', at: [[F.picture, `${k}: '${v}',`], [F.picture, 'backgroundColor: i < filled ? accent']] });
}

// ─ ChangingNowCard — card body; the state chip rides on the hero photo ─
add({ id: 'changing.title', fg: color.onInk, on: 'card', kind: 'text', at: [CARD(F.changing), [F.changing, 'title: { color: color.onInk, fontSize: 16']] });
add({ id: 'changing.subtitle', fg: color.onInkMute, on: 'card', kind: 'text', at: [CARD(F.changing), [F.changing, 'subtitle: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'changing.whyThis', fg: color.onInkMute, on: 'card', kind: 'text', at: [CARD(F.changing), [F.changing, 'whyText: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'changing.whyThisIcon', fg: color.onInkMute, on: 'card', kind: 'ui', at: [[F.changing, '<HelpCircle size={13} color={color.onInkMute}']] });
// Pinned by lane H (census-media §27) on the 0.55 chip scrim, floors:
//   starting 1.81, building 2.31, peak 2.02, moderate 1.66, quiet 1.40, winding_down 1.45.
// The scrim is now 0.88, the least alpha at which all six clear 4.5:1 (census-media §31).
for (const [k, v] of Object.entries(ZONE_COLOR)) {
  const at: Needle[] = [
    [F.changing, '<Text style={[styles.stateChipText, { color: accent }]}>'],
    [F.changing, "backgroundColor: 'rgba(17,17,15,0.88)'"], // census-media §31: was 0.55
    [F.changing, "heroFallback: { backgroundColor: '#22221E' }"],
  ];
  add({ id: `changing.stateChip.${k}.fallback`, fg: v, on: 'cardChipFallback', kind: 'text', at });
  add({ id: `changing.stateChip.${k}.photoFloor`, fg: v, on: 'cardChipPhoto', kind: 'text', at }); // FIXED by lane K (census-media §31)
}

// ─ CityVisualPulse — on its card ─
add({ id: 'pulse.heading', fg: color.onInkMute, on: 'card', kind: 'text', at: [CARD(F.pulse), [F.pulse, /heading: \{\s*color: color\.onInkMute,/]] });
add({ id: 'pulse.zoneName', fg: color.onInk, on: 'card', kind: 'text', at: [CARD(F.pulse), [F.pulse, /zoneName: \{\s*color: color\.onInk,/]] });
add({ id: 'pulse.coverage', fg: color.faint, on: 'card', kind: 'text', at: [CARD(F.pulse), [F.pulse, 'coverageLabel: { color: color.faint, fontSize: 12']] });
for (const [k, v] of Object.entries(ZONE_COLOR)) {
  // The label and its trend glyph / hold dot share this colour on this card.
  add({ id: `pulse.stateLabel+glyph.${k}`, fg: v, on: 'card', kind: 'text', at: [CARD(F.pulse), [F.pulse, '<Text style={[styles.stateLabel, { color: accent }]}>{stateText}</Text>']] });
  add({ id: `pulse.bar.${k}`, fg: v, on: 'pill10OnCard', kind: 'ui', at: [[F.pulse, /barTrack: \{[^}]*backgroundColor: 'rgba\(250,249,246,0\.10\)'/], [F.pulse, 'backgroundColor: accent }]}']] });
}
add({ id: 'pulse.bar.neutral', fg: 'rgba(250,249,246,0.45)', on: 'pill10OnCard', kind: 'decor', at: [[F.pulse, "const NEUTRAL_ACCENT = 'rgba(250,249,246,0.45)';"]] });

// ─ ContributorTrustChips — a paper card inside the dark perspective viewer ─
const TRUST_CARD: Needle = [F.trust, 'backgroundColor: color.paper,'];
add({ id: 'trust.label', fg: color.ink, on: 'paper', kind: 'text', at: [TRUST_CARD, [F.trust, 'label: { ...t.small, color: color.ink']] });
add({ id: 'trust.description', fg: color.mute, on: 'paper', kind: 'text', at: [TRUST_CARD, [F.trust, 'desc: { fontSize: 11, lineHeight: 14, color: color.mute }']] }); // FIXED by lane K (census-media §31): was `faint`, 2.73:1
add({ id: 'trust.percent', fg: color.mute, on: 'paper', kind: 'text', at: [TRUST_CARD, [F.trust, 'pct: { ...t.stamp, color: color.mute']] });
add({ id: 'trust.caption', fg: color.mute, on: 'paper', kind: 'text', at: [TRUST_CARD, [F.trust, 'caption: { fontSize: 11, lineHeight: 14, color: color.mute']] }); // FIXED by lane K (census-media §31): was `faint`, 2.73:1
add({ id: 'trust.meterFill', fg: color.deep, on: 'haze', kind: 'ui', at: [[F.trust, 'backgroundColor: color.haze,'], [F.trust, 'backgroundColor: color.deep }']] });

// ─ ExperienceMosaic ─
add({ id: 'expMosaic.title', fg: color.onInk, on: 'card', kind: 'text', at: [CARD(F.expMosaic), [F.expMosaic, 'title: { color: color.onInk, fontSize: 17']] });
add({ id: 'expMosaic.coverage', fg: color.onInkMute, on: 'card', kind: 'text', at: [CARD(F.expMosaic), [F.expMosaic, 'coverage: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'expMosaic.stateChip', fg: '#3DD6C4', on: 'tealChipOnCard', kind: 'text', at: [[F.expMosaic, "stateChipText: { color: '#3DD6C4'"], [F.expMosaic, "backgroundColor: 'rgba(61,214,196,0.16)'"]] });

// ─ ForYouNowStrip ─
add({ id: 'forYou.heading', fg: color.onInkMute, on: 'ink', kind: 'text', at: [GROUND, [F.forYou, /heading: \{\s*color: color\.onInkMute,/]] });
add({ id: 'forYou.category', fg: color.onInk, on: 'chip06', kind: 'text', at: [[F.forYou, 'category: { color: color.onInk, fontSize: 15'], [F.forYou, "backgroundColor: 'rgba(250,249,246,0.06)'"]] });
add({ id: 'forYou.count', fg: color.onInkMute, on: 'chip06', kind: 'text', at: [[F.forYou, 'count: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'forYou.gemIcon', fg: '#3DD6C4', on: 'chip06', kind: 'ui', at: [[F.forYou, '<Gem size={15} color="#3DD6C4"']] });
add({ id: 'forYou.sparklesIcon', fg: color.signal, on: 'chip06', kind: 'ui', at: [[F.forYou, '<Sparkles size={15} color={color.signal}']] });

// ─ Hidden Gems lens: HiddenGemCard rows (gem wash on the ground) and tiles (opaque body) ─
const GEM_ROW: Needle = [F.gemCard, "backgroundColor: 'rgba(16,185,129,0.05)'"];
const GEM_TILE: Needle = [F.gemCard, "tileFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#15201C' }"];
const GEM_TEXT: ReadonlyArray<readonly [id: string, fg: string, needle: Needle]> = [
  ['title', color.onInk, [F.gemCard, 'title: { flex: 1, color: color.onInk, fontSize: 15']],
  ['area', color.onInkMute, [F.gemCard, 'area: { color: color.onInkMute, fontSize: 12']],
  ['stateLabel', GEM_ACCENT, [F.gemCard, 'state: { color: GEM_ACCENT, fontSize: 12']],
  ['stateLabelMuted', color.onInkMute, [F.gemCard, 'stateMuted: { color: color.onInkMute }']],
  ['observation', color.onInk, [F.gemCard, 'observation: { color: color.onInk, fontSize: 12']],
  ['confidence', color.onInkMute, [F.gemCard, 'confidence: { color: color.onInkMute, fontSize: 12']],
  ['note', color.onInkMute, [F.gemCard, 'note: { color: color.onInkMute, fontSize: 12']],
];
for (const [id, fg, needle] of GEM_TEXT) {
  add({ id: `gemCard.${id}.row`, fg, on: 'gemRow', kind: 'text', at: [needle, GEM_ROW] });
  add({ id: `gemCard.${id}.tile`, fg, on: 'gemTile', kind: 'text', at: [needle, GEM_TILE] });
}
add({ id: 'gemCard.marker.row', fg: GEM_ACCENT, on: 'gemRow', kind: 'ui', at: [[F.gemCard, 'backgroundColor: GEM_ACCENT },'], GEM_ROW] });
add({ id: 'gemCard.marker.tileFallback', fg: GEM_ACCENT, on: 'gemTile', kind: 'ui', at: [[F.gemCard, 'markerLarge: { width: 18, height: 18 }'], GEM_TILE] });
// The §46.1 contour: its state is ALSO the card's text label, so it is measured, not asserted.
const GEM_STATES: HiddenGemState[] = [
  'recently_confirmed', 'still_hidden', 'quiet_now', 'getting_discovered', 'seasonal',
  'hard_to_find', 'access_changed', 'temporarily_unavailable', 'overcrowding_risk', 'no_longer_hidden',
];
const contourKinds = new Map<string, string>();
for (const st of GEM_STATES) {
  const c = gemContourTreatment(st);
  contourKinds.set(c.kind, c.borderColor);
}
for (const [kind, border] of contourKinds) {
  add({ id: `gemCard.contour.${kind}`, fg: border, on: 'ink', kind: 'decor', at: [[F.gemCard, 'borderColor: contour.borderColor,']] });
}
add({ id: 'gems.intro', fg: color.onInkMute, on: 'ink', kind: 'text', at: [GROUND, [F.gems, 'intro: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'gems.partialAndCachedLabel', fg: color.warn, on: 'ink', kind: 'text', at: [[F.gems, 'partial: { color: color.warn, fontSize: 12'], [F.gems, '{cachedLabel ? <Text style={styles.partial} testID="gem-lens-cached">{cachedLabel}</Text> : null}']] });
add({ id: 'gems.heading', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.gems, /heading: \{\s*color: color\.onInkMute,/]] });

// ─ IntelligenceStrip — on the ground in Places; on the viewer overlay over the photo ─
const INTEL_CLASS: Needle[] = [[F.intel, 'const accent = OBSERVATION_COLOR[observationClass];'], [F.intel, '<Text style={[styles.classText, { color: accent }]}>']];
// Pinned by lane H (census-media §27) on the viewer's 0.62 overlay, floors:
//   observed 2.93, inferred 2.11, user_claimed 1.84, predicted 2.56, generated 1.58.
// The overlay is now 0.96; `generated` alone needs 0.91 (census-media §31).
for (const [k, v] of Object.entries(OBSERVATION_COLOR)) {
  // The class chip's dot and border share this colour on the same ground.
  add({ id: `intel.class.${k}.onGround`, fg: v, on: 'ink', kind: 'text', at: [...INTEL_CLASS, [F.places, '<IntelligenceStrip']] });
  add({ id: `intel.class.${k}.viewerFallback`, fg: v, on: 'viewerOverlayFallback', kind: 'text', at: [...INTEL_CLASS, VIEWER_OVERLAY, VIEWER_FALLBACK] });
  add({ id: `intel.class.${k}.viewerPhotoFloor`, fg: v, on: 'viewerOverlayPhoto', kind: 'text', at: [...INTEL_CLASS, VIEWER_OVERLAY] }); // FIXED by lane K (census-media §31)
}
add({ id: 'intel.perspective.onGround', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.intel, /perspective: \{\s*color: color\.onInkMute,/]] });

// ─ MediaTimeRail — on the ground; band hues come from the §17 render classes ─
add({ id: 'time.segmentLabel', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.timeRail, 'label: { color: color.onInkMute, fontSize: 11']] });
add({ id: 'time.segmentLabelNow', fg: color.onInk, on: 'ink', kind: 'text', at: [[F.timeRail, 'labelNow: { color: color.onInk }']] });
for (const [rc, cls] of Object.entries(RENDER_CLASS_OBSERVATION)) {
  // Band label, segment note, confidence chip text, node border and node dot all paint this hue on the ground.
  add({ id: `time.band.${rc}`, fg: OBSERVATION_COLOR[cls], on: 'ink', kind: 'text', at: [[F.timeRail, '<Text style={[styles.bandLabel, { color: accent }]}>'], [F.timeRail, 'backgroundColor: color.ink,']] });
}
add({ id: 'time.neutral', fg: color.faint, on: 'ink', kind: 'text', at: [[F.timeRail, 'neutral: { color: color.faint, fontSize: 13']] });
add({ id: 'time.pattern', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.timeRail, 'patternLine: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'time.forecastLabel', fg: color.onInk, on: 'ink', kind: 'text', at: [[F.timeRail, 'forecastLabel: { color: color.onInk, fontSize: 13']] });
add({ id: 'time.forecastNote', fg: color.faint, on: 'ink', kind: 'text', at: [[F.timeRail, 'forecastNote: { color: color.faint, fontSize: 11']] });
add({ id: 'time.staleNote', fg: color.warn, on: 'ink', kind: 'text', at: [[F.timeRail, 'staleNote: { color: color.warn, fontSize: 11']] });

// ─ MediaTimelineScreen — the §17 Time lens and /media-timeline ─
add({ id: 'timeline.title', fg: color.onInk, on: 'ink', kind: 'text', at: [ROUTE_GROUND(F.routeTimeline), [F.timeline, /title: \{\s*color: color\.onInk,/]] });
add({ id: 'timeline.note', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.timeline, 'note: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'timeline.heading', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.timeline, /heading: \{\s*color: color\.onInkMute,/]] });

// ─ MyWorldMemorySection — on its card ─
add({ id: 'memory.title', fg: color.onInk, on: 'card', kind: 'text', at: [CARD(F.memory), [F.memory, 'title: { color: color.onInk, fontSize: 17']] });
add({ id: 'memory.privatePill', fg: color.onInkMute, on: 'pill10OnCard', kind: 'text', at: [[F.memory, 'privatePillText: { color: color.onInkMute'], PILL10(F.memory)] });
add({ id: 'memory.subtitle', fg: color.onInkMute, on: 'card', kind: 'text', at: [[F.memory, 'subtitle: { color: color.onInkMute, fontSize: 13, lineHeight: 18 }']] });
add({ id: 'memory.groupLabel', fg: color.onInk, on: 'card', kind: 'text', at: [[F.memory, 'groupLabel: { color: color.onInk, fontSize: 14']] });
add({ id: 'memory.groupDesc', fg: color.faint, on: 'card', kind: 'text', at: [[F.memory, 'groupDesc: { color: color.faint, fontSize: 12']] });
add({ id: 'memory.entry', fg: color.onInkMute, on: 'card', kind: 'text', at: [[F.memory, 'entryText: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'memory.gemName', fg: color.onInk, on: 'card', kind: 'text', at: [[F.memory, "gemName: { color: color.onInk, fontWeight: '700' }"]] });
add({ id: 'memory.footer', fg: color.faint, on: 'card', kind: 'text', at: [[F.memory, 'footer: { color: color.faint, fontSize: 11']] });

// ─ PerspectiveMosaic — group chips on the ground ─
add({ id: 'mosaic.chip', fg: color.onInkMute, on: 'chip08', kind: 'text', at: [[F.mosaic, 'chipText: { color: color.onInkMute, fontSize: 13'], CHIP08(F.mosaic)] });
add({ id: 'mosaic.chipCount', fg: color.faint, on: 'chip08', kind: 'text', at: [[F.mosaic, 'chipCount: { color: color.faint, fontSize: 12'], CHIP08(F.mosaic)] });
add({ id: 'mosaic.chipActive', fg: color.ink, on: 'selected', kind: 'text', at: [[F.mosaic, 'chipTextActive: { color: color.ink }'], [F.mosaic, 'chipActive: { backgroundColor: color.onInk }']] });
add({ id: 'mosaic.empty', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.mosaic, 'empty: { color: color.onInkMute, fontSize: 14']] });

// ─ PerspectiveTile — overlay scrim on the tile photo ─
const TILE_SCRIM: Needle[] = [[F.tile, "backgroundColor: 'rgba(17,17,15,0.71)'"], [F.tile, "fallback: { backgroundColor: '#22221E' }"]]; // census-media §31: was 0.55
add({ id: 'tile.perspective.fallback', fg: color.onInk, on: 'tileScrimFallback', kind: 'text', at: [...TILE_SCRIM, [F.tile, 'perspective: { color: color.onInk, fontSize: 13']] });
add({ id: 'tile.perspective.photoFloor', fg: color.onInk, on: 'tileScrimPhoto', kind: 'text', at: [...TILE_SCRIM, [F.tile, 'perspective: { color: color.onInk, fontSize: 13']] }); // FIXED by lane K (census-media §31): was 3.96 on 0.55
add({ id: 'tile.age.fallback', fg: color.onInkMute, on: 'tileScrimFallback', kind: 'text', at: [...TILE_SCRIM, [F.tile, 'age: { color: color.onInkMute, fontSize: 11']] });
add({ id: 'tile.age.photoFloor', fg: color.onInkMute, on: 'tileScrimPhoto', kind: 'text', at: [...TILE_SCRIM, [F.tile, 'age: { color: color.onInkMute, fontSize: 11']] }); // FIXED by lane K (census-media §31): was 2.87 on 0.55
add({ id: 'tile.playIcon.fallback', fg: color.onInk, on: 'tilePlayFallback', kind: 'ui', at: [[F.tile, "backgroundColor: 'rgba(17,17,15,0.5)'"], [F.tile, '<Play size={14} color={color.onInk}']] });
add({ id: 'tile.playIcon.photoFloor', fg: color.onInk, on: 'tilePlayPhoto', kind: 'ui', at: [[F.tile, "backgroundColor: 'rgba(17,17,15,0.5)'"], [F.tile, '<Play size={14} color={color.onInk}']] });

// ─ NOW, Experiences, People, My World, Places — all on the ground ─
add({ id: 'world.heading', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.world, /heading: \{\s*color: color\.onInkMute,/]] });

add({ id: 'experiences.introAndCachedLabel', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.experiences, 'intro: { color: color.onInkMute, fontSize: 13'], [F.experiences, '{cachedLabel ? <Text style={styles.intro}>{cachedLabel}</Text> : null}']] });
add({ id: 'experiences.chainHeading', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.experiences, /chainHeading: \{\s*color: color\.onInkMute,/]] });
add({ id: 'experiences.chainTitle', fg: color.onInk, on: 'card', kind: 'text', at: [CARD(F.experiences), [F.experiences, 'chainTitle: { color: color.onInk, fontSize: 15']] });
add({ id: 'experiences.chainStep', fg: color.onInkMute, on: 'card', kind: 'text', at: [[F.experiences, 'chainStep: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'experiences.chainChevron', fg: color.faint, on: 'card', kind: 'ui', at: [[F.experiences, '<ChevronRight size={14} color={color.faint}']] });

add({ id: 'people.introAndCachedLabel', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.people, 'intro: { color: color.onInkMute, fontSize: 13'], [F.people, '{cachedLabel ? <Text style={styles.intro}>{cachedLabel}']] });
add({ id: 'people.name', fg: color.onInk, on: 'ink', kind: 'text', at: [[F.people, 'name: { color: color.onInk, fontSize: 15']] });
add({ id: 'people.meta', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.people, 'meta: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'people.verifiedIcon', fg: '#3DD6C4', on: 'ink', kind: 'ui', at: [[F.people, '<BadgeCheck size={15} color="#3DD6C4"']] });

add({ id: 'myWorld.chip', fg: color.onInkMute, on: 'chip08', kind: 'text', at: [[F.myWorld, 'chipText: { color: color.onInkMute, fontSize: 13'], CHIP08(F.myWorld)] });
add({ id: 'myWorld.chipCount', fg: color.faint, on: 'chip08', kind: 'text', at: [[F.myWorld, 'chipCount: { color: color.faint, fontSize: 12']] });
add({ id: 'myWorld.chipActive', fg: color.ink, on: 'selected', kind: 'text', at: [[F.myWorld, 'chipTextActive: { color: color.ink }'], [F.myWorld, 'chipActive: { backgroundColor: color.onInk }']] });
add({ id: 'myWorld.searchChipText', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.myWorld, '<Text style={styles.chipText}>Search my world</Text>']] });
// The outline is not the chip's only cue: its passing icon and label identify it (1.4.11).
add({ id: 'myWorld.searchChipOutline', fg: 'rgba(250,249,246,0.24)', on: 'ink', kind: 'decor', at: [[F.myWorld, "borderColor: 'rgba(250,249,246,0.24)',"]] });
add({ id: 'myWorld.searchIcons', fg: color.onInk, on: 'ink', kind: 'ui', at: [[F.myWorld, '<Search size={14} color={color.onInk}']] });
add({ id: 'myWorld.searchTitle', fg: color.onInk, on: 'ink', kind: 'text', at: [[F.myWorld, "searchTitle: { color: color.onInk, fontSize: 16, fontWeight: '800' }"]] });
add({ id: 'myWorld.modeNote', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.myWorld, 'modeNote: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'myWorld.placeholderTitle', fg: color.onInk, on: 'ink', kind: 'text', at: [[F.myWorld, 'placeholderTitle: { color: color.onInk, fontSize: 18']] });
add({ id: 'myWorld.placeholderBody', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.myWorld, 'placeholderBody: { color: color.onInkMute, fontSize: 14']] });

add({ id: 'places.intro', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.places, 'intro: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'places.placeName', fg: color.onInk, on: 'card', kind: 'text', at: [CARD(F.places), [F.places, 'placeName: { color: color.onInk, fontSize: 16']] });
add({ id: 'places.placeState', fg: color.onInkMute, on: 'card', kind: 'text', at: [[F.places, 'placeState: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'places.pinIcon', fg: color.onInkMute, on: 'card', kind: 'ui', at: [[F.places, '<MapPin size={18} color={color.onInkMute}']] });
add({ id: 'places.rowChevron', fg: color.faint, on: 'card', kind: 'ui', at: [[F.places, '<ChevronRight size={18} color={color.faint}']] });
add({ id: 'places.detailTitle', fg: color.onInk, on: 'ink', kind: 'text', at: [[F.places, 'detailTitle: { flex: 1, color: color.onInk, fontSize: 20']] });
add({ id: 'places.stateLabel', fg: color.onInk, on: 'ink', kind: 'text', at: [[F.places, 'stateLabel: { color: color.onInk, fontSize: 22']] });
add({ id: 'places.areaLabelAndCaveats', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.places, 'areaLabel: { color: color.onInkMute, fontSize: 13'], [F.places, '{cachedLabel ? <Text style={styles.areaLabel} accessibilityRole="text">{cachedLabel}</Text> : null}']] });
add({ id: 'places.coverage', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.places, 'coverage: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'places.headerIcons', fg: color.onInk, on: 'ink', kind: 'ui', at: [[F.places, '<ChevronLeft size={24} color={color.onInk}'], [F.places, '<Camera size={22} color={color.onInk}']] });

// ─ Media Map — the list screen (on the ground) and the canvas (over the in-tree dark map) ─
add({ id: 'mapScreen.title', fg: color.onInk, on: 'ink', kind: 'text', at: [ROUTE_GROUND(F.routeMap), [F.mapScreen, 'title: { flex: 1, color: color.onInk, fontSize: 16']] });
add({ id: 'mapScreen.total', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.mapScreen, 'total: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'mapScreen.note', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.mapScreen, 'note: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'mapScreen.legend', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.mapScreen, 'legend: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'mapScreen.layersIcon', fg: color.onInkMute, on: 'ink', kind: 'ui', at: [[F.mapScreen, '<Layers size={16} color={color.onInkMute}']] });
add({ id: 'mapScreen.selectedTitle', fg: color.onInk, on: 'chip07', kind: 'text', at: [[F.mapScreen, "backgroundColor: 'rgba(250,249,246,0.07)'"], [F.mapScreen, "selectedTitle: { color: color.onInk, fontSize: 16, fontWeight: '800' }"]] });
add({ id: 'mapScreen.selectedMeta', fg: color.onInkMute, on: 'chip07', kind: 'text', at: [[F.mapScreen, 'selectedMeta: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'mapScreen.openButton', fg: color.ink, on: 'selected', kind: 'text', at: [[F.mapScreen, 'openBtnText: { color: color.ink, fontSize: 13'], [F.mapScreen, 'backgroundColor: color.onInk,']] });
add({ id: 'mapScreen.subhead', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.mapScreen, /subhead: \{\s*color: color\.onInkMute,/]] });
add({ id: 'mapScreen.rowLabel', fg: color.onInk, on: 'card', kind: 'text', at: [CARD(F.mapScreen), [F.mapScreen, 'rowLabel: { flex: 1, color: color.onInk, fontSize: 15']] });
add({ id: 'mapScreen.rowCount', fg: color.onInkMute, on: 'card', kind: 'text', at: [[F.mapScreen, 'rowCount: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'mapScreen.rowLabel.selected', fg: color.onInk, on: 'rowSelected', kind: 'text', at: [[F.mapScreen, "rowSelected: { backgroundColor: 'rgba(250,249,246,0.12)' }"]] });
add({ id: 'mapScreen.rowCount.selected', fg: color.onInkMute, on: 'rowSelected', kind: 'text', at: [[F.mapScreen, "rowSelected: { backgroundColor: 'rgba(250,249,246,0.12)' }"]] });
add({ id: 'mapScreen.rowPin', fg: color.onInkMute, on: 'card', kind: 'ui', at: [[F.mapScreen, '<MapPin size={16} color={color.onInkMute}']] });
add({ id: 'mapScreen.gemDot', fg: '#10B981', on: 'card', kind: 'ui', at: [[F.mapScreen, "backgroundColor: '#10B981' }"]] });
const BUBBLE: Needle[] = [[F.mapCanvas, "backgroundColor: 'rgba(17,17,15,0.86)',"], [F.mapCanvas, "bubbleText: { color: color.onInk, fontSize: 12, fontWeight: '800' },"]];
add({ id: 'mapCanvas.bubbleCount.fallback', fg: color.onInk, on: 'mapBubbleFallback', kind: 'text', at: [...BUBBLE, [F.mapCanvas, "backgroundColor: '#1A1A17',"]] });
add({ id: 'mapCanvas.bubbleCount.mapFloor', fg: color.onInk, on: 'mapBubble', kind: 'text', at: BUBBLE });
add({ id: 'mapCanvas.bubbleCount.selected', fg: color.ink, on: 'selected', kind: 'text', at: [[F.mapCanvas, 'bubbleSelected: { backgroundColor: color.onInk },'], [F.mapCanvas, 'bubbleTextSelected: { color: color.ink },'], [F.mapCanvas, '<Text style={[styles.bubbleText, selected && tailStyles.bubbleTextSelected]}']] }); // FIXED by lane I (census-media §29.8): the selected count is `ink` on the `onInk` fill (was onInk on onInk, 1.00:1).
// The outline is not the bubble's only cue: its count text passes over the map (above).
add({ id: 'mapCanvas.bubbleOutline.mapFloor', fg: color.onInk, on: 'map', kind: 'decor', at: [[F.mapCanvas, 'borderColor: color.onInk,']] });
add({ id: 'mapCanvas.gemMarkerRing.mapFloor', fg: GEM_ACCENT, on: 'map', kind: 'ui', at: [[F.mapCanvas, 'borderColor: GEM_ACCENT,']] });
add({ id: 'mapCanvas.gemMarkerCore.mapFloor', fg: GEM_ACCENT, on: 'mapGemMarker', kind: 'ui', at: [[F.mapCanvas, "backgroundColor: 'rgba(16,185,129,0.12)',"], [F.mapCanvas, 'backgroundColor: GEM_ACCENT,']] });
// At 0.7 opacity it fell to 2.65 over a major-road casing (mapBase.roadCasing); drawn opaque, its floor is the casing's 3.87.
add({ id: 'mapCanvas.gemZoneContour.mapFloor', fg: GEM_ACCENT, on: 'map', kind: 'ui', at: [[F.mapCanvas, "paint={{ 'line-color': GEM_ACCENT, 'line-width': 1.5, 'line-opacity': 1,"]] }); // FIXED by lane K (census-media §31): 'line-opacity' 0.7 -> 1

// ─ Search (the Search lens entry, /media-search and My World search) ─
const SEARCH_FIELD: Needle = [F.search, "backgroundColor: 'rgba(250,249,246,0.08)',"];
add({ id: 'search.input', fg: color.onInk, on: 'chip08', kind: 'text', at: [ROUTE_GROUND(F.routeSearch), SEARCH_FIELD, [F.search, 'input: { flex: 1, color: color.onInk, fontSize: 15']] });
add({ id: 'search.placeholder', fg: color.faint, on: 'chip08', kind: 'text', at: [SEARCH_FIELD, [F.search, 'placeholderTextColor={color.faint}']] });
add({ id: 'search.clear', fg: color.onInkMute, on: 'chip08', kind: 'text', at: [[F.search, 'clear: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'search.fieldIcon', fg: color.onInkMute, on: 'chip08', kind: 'ui', at: [[F.search, '<Search size={18} color={color.onInkMute}']] });
add({ id: 'search.within', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.search, 'withinText: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'search.chip', fg: color.onInkMute, on: 'chip08', kind: 'text', at: [[F.search, 'chipText: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'search.chipActive', fg: color.ink, on: 'selected', kind: 'text', at: [[F.search, 'chipTextActive: { color: color.ink }'], [F.search, 'chipActive: { backgroundColor: color.onInk }']] });
add({ id: 'search.answer', fg: color.onInk, on: 'ink', kind: 'text', at: [[F.search, "answer: { color: color.onInk, fontSize: 18, fontWeight: '800'"]] });
add({ id: 'search.heading', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.search, /heading: \{\s*color: color\.onInkMute,/]] });
add({ id: 'search.rowTitle', fg: color.onInk, on: 'card', kind: 'text', at: [CARD(F.search), [F.search, 'rowTitle: { flex: 1, color: color.onInk, fontSize: 15']] });
add({ id: 'search.rowMeta', fg: color.onInkMute, on: 'card', kind: 'text', at: [[F.search, 'rowMeta: { color: color.onInkMute, fontSize: 12']] });
add({ id: 'search.rowIcons', fg: color.onInkMute, on: 'card', kind: 'ui', at: [[F.search, 'icon={<MapPin size={16} color={color.onInkMute}']] });
add({ id: 'search.gemMark', fg: '#10B981', on: 'card', kind: 'ui', at: [[F.search, "backgroundColor: '#10B981' }"]] });
add({ id: 'search.undetermined', fg: color.warn, on: 'ink', kind: 'text', at: [[F.search, 'undetermined: { color: color.warn, fontSize: 12']] });
add({ id: 'search.unsupported', fg: color.faint, on: 'ink', kind: 'text', at: [[F.search, 'unsupported: { color: color.faint, fontSize: 11']] });

// ─ Contribution — the sheet and /media-contribute ─
add({ id: 'contribution.title', fg: color.onInk, on: 'ink', kind: 'text', at: [ROUTE_GROUND(F.routeContribute), [F.contribution, 'title: { color: color.onInk, fontSize: 20']] });
add({ id: 'contribution.sub', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.contribution, 'sub: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'contribution.mediaHint', fg: color.onInkMute, on: 'chip06', kind: 'text', at: [[F.contribution, "backgroundColor: 'rgba(250,249,246,0.06)',"], [F.contribution, 'mediaHint: { color: color.onInkMute, fontSize: 14']] });
add({ id: 'contribution.label', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.contribution, 'label: { color: color.onInkMute, fontSize: 11']] });
add({ id: 'contribution.chip', fg: color.onInkMute, on: 'chip08', kind: 'text', at: [[F.contribution, "backgroundColor: 'rgba(250,249,246,0.08)' },"], [F.contribution, 'chipText: { color: color.onInkMute, fontSize: 13']] });
add({ id: 'contribution.chipActive', fg: color.ink, on: 'selected', kind: 'text', at: [[F.contribution, 'chipTextActive: { color: color.ink }'], [F.contribution, 'chipActive: { backgroundColor: color.onInk }']] });
add({ id: 'contribution.noteText', fg: color.onInk, on: 'chip06', kind: 'text', at: [[F.contribution, /note: \{[^}]*color: color\.onInk,[^}]*backgroundColor: 'rgba\(250,249,246,0\.06\)'/]] });
add({ id: 'contribution.notePlaceholder', fg: color.faint, on: 'chip06', kind: 'text', at: [[F.contribution, 'placeholderTextColor={color.faint}']] });
add({ id: 'contribution.blocker', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.contribution, 'blocker: { color: color.onInkMute, fontSize: 12 }']] });
add({ id: 'contribution.submit', fg: color.ink, on: 'selected', kind: 'text', at: [[F.contribution, 'submitText: { color: color.ink, fontSize: 15']] });
add({ id: 'contribution.submitSpinner', fg: color.ink, on: 'selected', kind: 'ui', at: [[F.contribution, '<ActivityIndicator color={color.ink} />']] });
add({ id: 'contribution.submitDisabled', fg: 'rgba(17,17,15,0.4)', on: 'disabledSubmit', kind: 'decor', at: [[F.contribution, 'submitDisabled: { opacity: 0.4 },']] });
add({ id: 'contributionScreen.failed', fg: color.warn, on: 'ink', kind: 'text', at: [[F.contributionScreen, 'failed: { color: color.warn, fontSize: 13']] });
add({ id: 'contributionScreen.doneTitle', fg: color.onInk, on: 'ink', kind: 'text', at: [[F.contributionScreen, "doneTitle: { color: color.onInk, fontSize: 18, fontWeight: '800'"]] });
add({ id: 'contributionScreen.doneButton', fg: color.ink, on: 'selected', kind: 'text', at: [[F.contributionScreen, 'doneBtnText: { color: color.ink, fontSize: 14'], [F.contributionScreen, 'backgroundColor: color.onInk },']] });

// ─ MediaPerspectiveViewerScreen — ground, top bar over the photo, bottom overlay over the photo ─
add({ id: 'viewer.emptyTitle', fg: color.onInk, on: 'ink', kind: 'text', at: [[F.viewer, 'screen: { flex: 1, backgroundColor: color.ink }'], [F.viewer, 'emptyTitle: { color: color.onInk, fontSize: 17']] });
add({ id: 'viewer.emptyBody', fg: color.onInkMute, on: 'ink', kind: 'text', at: [[F.viewer, 'emptyBody: { color: color.onInkMute, fontSize: 14']] });
const TOP_TITLE: Needle = [F.viewer, /topTitle: \{\s*flex: 1,\s*color: color\.onInk,/];
add({ id: 'viewer.topTitle.fallback', fg: color.onInk, on: 'viewerTitleFallback', kind: 'text', at: [TOP_TITLE, VIEWER_FALLBACK, [F.viewer, '<Text style={[styles.topTitle, tailStyles.topTitleScrim]}'], [F.viewer, "topTitleScrim: { flex: 0, flexShrink: 1, backgroundColor: 'rgba(17,17,15,0.59)'"]] }); // census-media §31: now on its badge
add({ id: 'viewer.topTitle.photoFloor', fg: color.onInk, on: 'viewerTitlePhoto', kind: 'text', at: [TOP_TITLE, [F.viewer, 'resizeMode="cover"'], [F.viewer, '<Text style={[styles.topTitle, tailStyles.topTitleScrim]}'], [F.viewer, "topTitleScrim: { flex: 0, flexShrink: 1, backgroundColor: 'rgba(17,17,15,0.59)'"]] }); // FIXED by lane K (census-media §31): was 1.00 with no scrim
add({ id: 'viewer.topBarIcons.photoFloor', fg: color.onInk, on: 'viewerIconBtnPhoto', kind: 'ui', at: [[F.viewer, '<ChevronLeft size={22} color={color.onInk}'], [F.viewer, "backgroundColor: 'rgba(17,17,15,0.55)'"]] });
const OVERLAY_TEXT: ReadonlyArray<readonly [id: string, fg: string, needle: Needle]> = [
  ['headline', color.onInk, [F.viewer, /headline: \{\s*color: color\.onInk,/]],
  ['contributorName', color.onInk, [F.viewer, 'contributorName: { color: color.onInk, fontSize: 14']],
  ['trustLabel', color.onInkMute, [F.viewer, 'trustLabel: { color: color.onInkMute, fontSize: 12']], // census-media §27 pinned its photo floor at 3.48
  ['note', color.onInk, [F.viewer, "note: { color: color.onInk, fontSize: 15, fontStyle: 'italic'"]],
  ['relatedHeading', color.onInkMute, [F.viewer, /relatedHeading: \{\s*color: color\.onInkMute,/]], // census-media §27 pinned its photo floor at 3.48
  ['intelPerspective', color.onInkMute, [F.intel, /perspective: \{\s*color: color\.onInkMute,/]], // census-media §27 pinned its photo floor at 3.48
];
for (const [id, fg, needle] of OVERLAY_TEXT) {
  add({ id: `viewer.${id}.fallback`, fg, on: 'viewerOverlayFallback', kind: 'text', at: [needle, VIEWER_OVERLAY, VIEWER_FALLBACK] });
  add({ id: `viewer.${id}.photoFloor`, fg, on: 'viewerOverlayPhoto', kind: 'text', at: [needle, VIEWER_OVERLAY] }); // FIXED by lane K (census-media §31): the three pinned rows above
}
const VIEWER_CHIP_TEXT: ReadonlyArray<readonly [id: string, fg: string, needle: Needle]> = [
  ['relatedChip', color.onInkMute, [F.viewer, 'chipText: { color: color.onInkMute, fontSize: 13']], // census-media §27 pinned its photo floor at 2.95
  ['relatedChipCount', color.faint, [F.viewer, 'chipCount: { color: color.faint, fontSize: 12']], // census-media §27 pinned it at 1.50; it sets the overlay's 0.96
  ['freshnessText', color.onInkMute, FRESH_TEXT], // census-media §27 pinned its photo floor at 2.95
];
for (const [id, fg, needle] of VIEWER_CHIP_TEXT) {
  add({ id: `viewer.${id}.fallback`, fg, on: 'viewerChipFallback', kind: 'text', at: [needle, VIEWER_CHIP, VIEWER_FALLBACK] });
  add({ id: `viewer.${id}.photoFloor`, fg, on: 'viewerChipPhoto', kind: 'text', at: [needle, VIEWER_CHIP, VIEWER_OVERLAY] }); // FIXED by lane K (census-media §31)
}
// Pinned by lane H (census-media §27) on the 0.62 overlay: live 2.39, fresh 1.69, recent 1.45, historical 1.29.
for (const [k, v] of Object.entries(FRESHNESS_COLOR)) {
  add({ id: `viewer.freshnessDot.${k}.photoFloor`, fg: v, on: 'viewerChipPhoto', kind: 'ui', at: [[F.freshness, '{ backgroundColor: dotColor }'], VIEWER_CHIP, VIEWER_OVERLAY] }); // FIXED by lane K (census-media §31)
}
add({ id: 'viewer.pill.fallback', fg: color.onInk, on: 'viewerPillFallback', kind: 'text', at: [[F.viewer, 'pillText: { color: color.onInk, fontSize: 13'], [F.viewer, "backgroundColor: 'rgba(250,249,246,0.14)'"]] });
add({ id: 'viewer.pill.photoFloor', fg: color.onInk, on: 'viewerPillPhoto', kind: 'text', at: [[F.viewer, 'pillText: { color: color.onInk, fontSize: 13'], [F.viewer, "backgroundColor: 'rgba(250,249,246,0.14)'"], VIEWER_OVERLAY] }); // FIXED by lane K (census-media §31): was 3.79 on 0.62
add({ id: 'viewer.chipActive', fg: color.ink, on: 'selected', kind: 'text', at: [[F.viewer, 'chipTextActive: { color: color.ink }'], [F.viewer, 'chipActive: { backgroundColor: color.onInk }']] });
add({ id: 'viewer.verifiedCheck', fg: color.ink, on: 'selected', kind: 'ui', at: [[F.viewer, '<Check size={10} color={color.ink}'], [F.viewer, 'backgroundColor: color.onInk,']] });
add({ id: 'viewer.caption.photoFloor', fg: color.onInk, on: 'viewerCaptionPhoto', kind: 'text', at: [[F.viewer, 'captionText: { color: color.onInk, fontSize: 14'], [F.viewer, "backgroundColor: 'rgba(17,17,15,0.74)'"]] });
add({ id: 'viewer.retryLabel.photoFloor', fg: color.onInk, on: 'viewerPlayBadgePhoto', kind: 'text', at: [[F.viewer, "controlLabel: { color: color.onInk, fontSize: 11, fontWeight: '700' }"], [F.viewer, /playBadge: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.59\)'/]] }); // FIXED by lane K (census-media §31): was 3.37 on 0.5
add({ id: 'viewer.playIcons.photoFloor', fg: color.onInk, on: 'viewerPlayBadgePhoto', kind: 'ui', at: [[F.viewer, '<RotateCcw size={18} color={color.onInk}'], [F.viewer, /playBadge: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.59\)'/]] }); // census-media §31: the badge was 0.5; the needle is anchored on its style block because the title badge also paints 0.59
add({ id: 'viewer.controlIcons.photoFloor', fg: color.onInk, on: 'viewerControlPhoto', kind: 'ui', at: [[F.viewer, '<Rewind size={16} color={color.onInk} />'], [F.viewer, "backgroundColor: 'rgba(17,17,15,0.7)'"]] });
add({ id: 'viewer.buffering.fallback', fg: color.onInkMute, on: 'viewerBufferingFallback', kind: 'text', at: [[F.viewer, /bufferingLabel: \{[^}]*color: color\.onInkMute,/], VIEWER_FALLBACK, [F.viewer, '<Text style={[styles.bufferingLabel, tailStyles.bufferingScrim]}>'], [F.viewer, "bufferingScrim: { backgroundColor: 'rgba(17,17,15,0.71)'"]] }); // census-media §31: now on its badge
add({ id: 'viewer.buffering.photoFloor', fg: color.onInkMute, on: 'viewerBufferingPhoto', kind: 'text', at: [[F.viewer, /bufferingLabel: \{[^}]*color: color\.onInkMute,/], [F.viewer, '<Text style={[styles.bufferingLabel, tailStyles.bufferingScrim]}>'], [F.viewer, "bufferingScrim: { backgroundColor: 'rgba(17,17,15,0.71)'"]] }); // FIXED by lane K (census-media §31): was 1.00 with no scrim
add({ id: 'viewer.progressFill.photoFloor', fg: color.signal, on: 'viewerProgressTrackPhoto', kind: 'ui', at: [[F.viewer, "backgroundColor: 'rgba(17,17,15,0.80)'"], [F.viewer, 'backgroundColor: color.signal,']] }); // FIXED by lane K (census-media §31): was 1.00 on a 0.26 light track

// ─ MediaContextSheet — "What this is part of", opened from the viewer ─
const CONTEXT_SHEET: Needle = [F.contextSheet, "backgroundColor: '#161614',"];
add({ id: 'context.title', fg: color.onInk, on: 'contextSheet', kind: 'text', at: [CONTEXT_SHEET, [F.contextSheet, 'title: { color: color.onInk, fontSize: 17']] });
add({ id: 'context.edgeKind', fg: color.onInkMute, on: 'contextSheet', kind: 'text', at: [[F.contextSheet, 'edgeKind: { width: 104, color: color.onInkMute, fontSize: 12']] });
add({ id: 'context.edgeLabel', fg: color.onInk, on: 'contextSheet', kind: 'text', at: [[F.contextSheet, 'edgeLabel: { flex: 1, color: color.onInk, fontSize: 15']] });
add({ id: 'context.unreadable', fg: color.warn, on: 'contextSheet', kind: 'text', at: [[F.contextSheet, 'note: { color: color.warn, fontSize: 12']] });
add({ id: 'context.whereTaken', fg: color.onInk, on: 'contextSheetButton', kind: 'text', at: [[F.contextSheet, "backgroundColor: 'rgba(250,249,246,0.1)',"], [F.contextSheet, 'whereText: { color: color.onInk, fontSize: 13']] });
add({ id: 'context.footer', fg: color.faint, on: 'contextSheet', kind: 'text', at: [[F.contextSheet, 'footer: { color: color.faint, fontSize: 11']] });
add({ id: 'context.edgeChevron', fg: color.faint, on: 'contextSheet', kind: 'ui', at: [[F.contextSheet, '<ChevronRight size={16} color={color.faint}']] });
add({ id: 'context.close', fg: color.onInk, on: 'contextSheet', kind: 'ui', at: [[F.contextSheet, '<X size={20} color={color.onInk}']] });

// ─ MediaActionRail — the media viewer's action sheet, on paper — and its panels ─
const RAIL_SHEET: Needle = [F.actionRail, 'backgroundColor: color.paper,'];
add({ id: 'rail.title', fg: color.ink, on: 'paper', kind: 'text', at: [RAIL_SHEET, [F.actionRail, /title: \{\s*\.\.\.t\.heading,\s*color: color\.ink,/]] });
add({ id: 'rail.notice', fg: color.mute, on: 'paper', kind: 'text', at: [RAIL_SHEET, [F.actionRail, /notice: \{[^}]*color: color\.mute,/]] });
add({ id: 'rail.empty', fg: color.mute, on: 'paper', kind: 'text', at: [RAIL_SHEET, [F.actionRail, /empty: \{\s*\.\.\.t\.body,\s*color: color\.mute,/]] });
add({ id: 'rail.rowLabel', fg: color.ink, on: 'paper', kind: 'text', at: [RAIL_SHEET, [F.actionRail, /rowLabel: \{\s*\.\.\.t\.body,\s*color: color\.ink,/]] });
add({ id: 'rail.rowLabel.active', fg: '#C43B23', on: 'paperSignalTint', kind: 'text', at: [[F.actionRail, /rowLabelActive: \{\s*color: ACTIVE_ON_PAPER,/], [F.actionRail, "const ACTIVE_ON_PAPER = '#C43B23';"], [F.actionRail, "backgroundColor: 'rgba(255,77,46,0.08)'"]] }); // FIXED by lane K (census-media §31): was `signal`, 2.85:1
add({ id: 'rail.rowIcon', fg: color.ink, on: 'paper', kind: 'ui', at: [[F.actionRail, 'color={active ? ACTIVE_ON_PAPER : color.ink}']] });
add({ id: 'rail.rowIcon.active', fg: '#C43B23', on: 'paperSignalTint', kind: 'ui', at: [[F.actionRail, 'color={active ? ACTIVE_ON_PAPER : color.ink}'], [F.actionRail, "fill={active ? ACTIVE_ON_PAPER : 'transparent'}"], [F.actionRail, "const ACTIVE_ON_PAPER = '#C43B23';"], [F.actionRail, "backgroundColor: 'rgba(255,77,46,0.08)'"]] }); // FIXED by lane K (census-media §31): was `signal`, 2.85:1
add({ id: 'rail.headerIcon', fg: color.deep, on: 'paper', kind: 'ui', at: [[F.actionRail, '<Compass size={iconToken.s20} color={color.deep}']] });
add({ id: 'rail.closeIcon', fg: color.mute, on: 'paper', kind: 'ui', at: [[F.actionRail, '<X size={iconToken.s20} color={color.mute}']] });
add({ id: 'rail.spinner', fg: color.mute, on: 'paper', kind: 'ui', at: [[F.actionRail, '<ActivityIndicator size="small" color={color.mute} />']] });
add({ id: 'rail.chevron', fg: color.haze, on: 'paper', kind: 'decor', at: [[F.actionRail, '<ChevronRight size={iconToken.s18} color={color.haze}']] });
add({ id: 'panels.backLabel', fg: color.mute, on: 'paper', kind: 'text', at: [RAIL_SHEET, [F.actionPanels, 'backLabel: { ...t.body, color: color.mute']] });
add({ id: 'panels.backIcon', fg: color.mute, on: 'paper', kind: 'ui', at: [[F.actionPanels, '<ChevronLeft size={iconToken.s18} color={color.mute}']] });
add({ id: 'panels.stopTime', fg: color.mute, on: 'paper', kind: 'text', at: [[F.actionPanels, 'stopTime: { ...t.body, color: color.mute']] });
add({ id: 'panels.stopTitle', fg: color.ink, on: 'paper', kind: 'text', at: [[F.actionPanels, 'stopTitle: { ...t.body, color: color.ink']] });
add({ id: 'panels.section', fg: color.ink, on: 'paper', kind: 'text', at: [[F.actionPanels, "section: { ...t.body, color: color.ink, fontWeight: '700'"]] });
add({ id: 'panels.caption', fg: color.mute, on: 'paper', kind: 'text', at: [[F.actionPanels, 'caption: { ...t.body, color: color.mute, fontSize: 13']] });
add({ id: 'panels.rowLabel', fg: color.ink, on: 'paper', kind: 'text', at: [[F.actionPanels, 'rowLabel: { ...t.body, color: color.ink']] });
add({ id: 'panels.inputText', fg: color.ink, on: 'paper', kind: 'text', at: [[F.actionPanels, /input: \{\s*\.\.\.t\.body,\s*color: color\.ink,/]] });
add({ id: 'panels.inputPlaceholder', fg: color.mute, on: 'paper', kind: 'text', at: [[F.actionPanels, 'placeholderTextColor={color.mute}']] });
// The border is not the field's only cue: its placeholder (5.27:1) and the panel's "Invite people" heading identify it.
add({ id: 'panels.inputBoundary', fg: color.haze, on: 'paper', kind: 'decor', at: [[F.actionPanels, /input: \{[^}]*borderColor: color\.haze,/]] });
add({ id: 'panels.invitedCheck', fg: color.signal, on: 'paper', kind: 'ui', at: [[F.actionPanels, '<Check size={iconToken.s18} color={color.signal}']] });

// ─ WhyThisSheet — rendered by the shell itself ─
add({ id: 'whyThis.title', fg: color.ink, on: 'paper', kind: 'text', at: [[F.shell, '<WhyThisSheet'], [F.whyThis, 'backgroundColor: color.paper,'], [F.whyThis, /title: \{\s*\.\.\.t\.heading,\s*color: color\.ink,/]] });
add({ id: 'whyThis.body', fg: color.ink, on: 'paper', kind: 'text', at: [[F.whyThis, /body: \{\s*\.\.\.t\.body,\s*color: color\.ink,/]] });
add({ id: 'whyThis.footnote', fg: color.mute, on: 'paper', kind: 'text', at: [[F.whyThis, /footnote: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
add({ id: 'whyThis.icons', fg: color.mute, on: 'paper', kind: 'ui', at: [[F.whyThis, '<X size={20} color={color.mute}']] });

// ─ RequestAViewPrompt — a features/media component on the light place page (outside the shell) ─
const RAV_CARD: Needle = [F.requestView, 'backgroundColor: color.paperRaised,'];
add({ id: 'requestView.freshness', fg: color.mute, on: 'paperRaised', kind: 'text', at: [RAV_CARD, [F.requestView, 'freshness: { ...t.small, color: color.mute']] });
add({ id: 'requestView.prompt', fg: color.ink, on: 'paperRaised', kind: 'text', at: [RAV_CARD, [F.requestView, 'prompt: { ...t.bodyStrong, color: color.ink }']] });
add({ id: 'requestView.chip', fg: color.deep, on: 'paper', kind: 'text', at: [[F.requestView, 'chipText: { ...t.small, color: color.deep'], [F.requestView, 'backgroundColor: color.paper,']] });
add({ id: 'requestView.resultOk', fg: color.success, on: 'paperRaised', kind: 'text', at: [RAV_CARD, [F.requestView, 'resultOk: { ...t.small, color: color.success }']] });
add({ id: 'requestView.resultMuted', fg: color.mute, on: 'paperRaised', kind: 'text', at: [RAV_CARD, [F.requestView, 'resultMuted: { ...t.small, color: color.mute }']] });
add({ id: 'requestView.eyeIcon', fg: color.deep, on: 'paperRaised', kind: 'ui', at: [[F.requestView, "<Eye size={16} color={tone === 'ink' ? color.onInkMute : color.deep}"]] });
// Integration (census-media §28.6): lane G (§26) gave the prompt an 'ink' tone for
// the Media World shell's dark surface, and "Mixed reports" lines on the zone
// surfaces. Measured here like every other pair: the same rules, no relief.
const RAV_INK_CARD: Needle = [F.requestView, /ink = StyleSheet\.create\(\{\s*card: \{\s*backgroundColor: color\.ink,/];
add({ id: 'requestView.ink.freshness', fg: color.onInkMute, on: 'ink', kind: 'text', at: [RAV_INK_CARD, [F.requestView, 'freshness: { ...t.small, color: color.onInkMute, flexShrink: 1 }']] });
add({ id: 'requestView.ink.prompt', fg: color.onInk, on: 'ink', kind: 'text', at: [RAV_INK_CARD, [F.requestView, 'prompt: { ...t.bodyStrong, color: color.onInk }']] });
add({ id: 'requestView.ink.chip', fg: color.onInk, on: 'ink', kind: 'text', at: [RAV_INK_CARD, [F.requestView, "chipText: { ...t.small, color: color.onInk, fontWeight: '700' }"]] });
add({ id: 'requestView.ink.resultOk', fg: color.onInk, on: 'ink', kind: 'text', at: [RAV_INK_CARD, [F.requestView, 'resultOk: { ...t.small, color: color.onInk },']] });
add({ id: 'requestView.ink.resultMuted', fg: color.onInkMute, on: 'ink', kind: 'text', at: [RAV_INK_CARD, [F.requestView, 'resultMuted: { ...t.small, color: color.onInkMute }']] });
add({ id: 'requestView.ink.eyeIcon', fg: color.onInkMute, on: 'ink', kind: 'ui', at: [[F.requestView, "<Eye size={16} color={tone === 'ink' ? color.onInkMute : color.deep}"]] });
add({ id: 'changing.uncertainty', fg: color.warn, on: 'card', kind: 'text', at: [CARD(F.changing), [F.changing, 'uncertainty: { ...typography.label, color: color.warn }']] });
add({ id: 'pulse.uncertainty', fg: color.warn, on: 'card', kind: 'text', at: [CARD(F.pulse), [F.pulse, 'uncertainty: { ...typography.label, color: color.warn, marginTop: -space.xs']] });
add({ id: 'places.zoneUncertainty', fg: color.warn, on: 'card', kind: 'text', at: [CARD(F.places), [F.places, 'zoneUncertainty: { ...typography.label, color: color.warn, marginTop: space.xs }']] });

// ── Measurement ──────────────────────────────────────────────────────────────

interface Measured {
  pair: Pair;
  ratio: number;
  threshold: number | null;
  floor: boolean;
}

const MEASURED: Measured[] = PAIRS.map(measurePair); function measurePair(pair: Pair): Measured { // census-media §31.12: named, so the tail can measure the pairs it adds
  const layers = surfaceLayers(pair.on);
  const floor = layers[0] === PHOTO || layers[0] === MAP;
  const ratio = floor ? floorRatio(pair.fg, layers) : ratioOn(pair.fg, layers);
  const threshold = pair.kind === 'decor' ? null : THRESHOLD[pair.kind];
  return { pair, ratio, threshold, floor };
}

const sourceCache = new Map<string, string>();
function source(file: string): string {
  let text = sourceCache.get(file);
  if (text === undefined) {
    text = readFileSync(join(APP_ROOT, file), 'utf8');
    sourceCache.set(file, text);
  }
  return text;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('the pair list is not vacuous', () => {
  assert.ok(PAIRS.length >= 300, `expected >= 300 pairs, got ${PAIRS.length}`);
  const ids = new Set(PAIRS.map((p) => p.id));
  assert.equal(ids.size, PAIRS.length, 'pair ids must be unique');
  // Every file listed is actually cited by some pair.
  const cited = new Set(PAIRS.flatMap((p) => p.at.map(([file]) => file)));
  for (const file of Object.values(F)) assert.ok(cited.has(file), `${file} is listed but no pair cites it`);
  // The gem contour enumeration found all three §46.1 treatments.
  assert.deepEqual([...contourKinds.keys()].sort(), ['glow', 'muted', 'protective']);
});

test('every pair is anchored in the source: each needle is found in its file', () => {
  const missing: string[] = [];
  for (const p of PAIRS) {
    for (const [file, needle] of p.at) {
      const text = source(file);
      const hit = typeof needle === 'string' ? text.includes(needle) : needle.test(text);
      if (!hit) missing.push(`${p.id}: ${file} does not contain ${String(needle)}`);
    }
  }
  assert.deepEqual(missing, [], 'a component changed a colour or a style this file measures — re-measure the pair');
});

test('WCAG helpers reproduce known reference values', () => {
  assert.equal(contrast(parseColor('#000000'), parseColor('#FFFFFF')).toFixed(2), '21.00');
  assert.equal(contrast(parseColor('#777777'), parseColor('#FFFFFF')).toFixed(2), '4.48');
  // Alpha is composited, not ignored: 50% white over black is mid-grey.
  const mid = over(parseColor('rgba(255,255,255,0.5)'), parseColor('#000000'));
  assert.equal(Math.round(mid.r), 128);
  // The floor over any photo can never exceed the ratio over its own lightest underlay.
  const f = floorRatio(color.onInk, [PHOTO, 'rgba(17,17,15,0.55)']);
  assert.ok(f <= ratioOn(color.onInk, [PHOTO, 'rgba(17,17,15,0.55)'], parseColor('#FFFFFF')) + 1e-9);
  // The map palette is the style's: every mapBase entry plus the three translucent fills and the gem wash.
  assert.equal(MAP_PAINTS.length, MAP_AREA_KEYS.length + 4);
  assert.equal(MAP_AREA_KEYS.length, Object.keys(mapBase).length - 4, 'exactly the four label colours are excluded');
  assert.ok(MAP_PAINTS.some((p) => contrast(p, MAP_GROUND) === 1), 'the ground itself is an underlay');
});

test('every solid-ground and fallback pair meets WCAG AA (text 4.5:1, state indicators 3:1)', () => {
  const failures = MEASURED.filter((m) => m.threshold !== null && m.pair.finding === undefined && m.ratio < m.threshold)
    .map((m) => `${m.pair.id}: ${m.ratio.toFixed(2)} < ${m.threshold}`);
  assert.deepEqual(failures, []);
});

test('pinned findings are still below threshold and still measure what the census records', () => {
  const drift: string[] = [];
  for (const m of MEASURED) {
    const pinned = m.pair.finding;
    if (pinned === undefined) continue;
    assert.notEqual(m.threshold, null, `${m.pair.id}: a decorative pair cannot carry a finding`);
    if (m.threshold !== null && m.ratio >= m.threshold) {
      drift.push(`${m.pair.id}: now ${m.ratio.toFixed(2)} >= ${m.threshold} — FIXED; delete its \`finding\` so it is asserted as a pass`);
    } else if (Math.abs(m.ratio - pinned) > 0.005) {
      drift.push(`${m.pair.id}: measures ${m.ratio.toFixed(2)}, pinned ${pinned.toFixed(2)} — re-measure and update the census`);
    }
  }
  assert.deepEqual(drift, []);
});

test('the shell ground is dark and every state map clears its bar on every ground it is painted on', () => {
  // "Dark/night-friendly": the ground the shell paints is near-black.
  assert.ok(luminance(parseColor(color.ink)) < 0.01);
  for (const [k, v] of Object.entries(OBSERVATION_COLOR)) {
    for (const ground of ['ink', 'viewerOverlayFallback'] as const) {
      assert.ok(ratioOn(v, S[ground]) >= 4.5, `OBSERVATION_COLOR.${k} ${v} is a text colour on ${ground}`);
    }
  }
  for (const [k, v] of Object.entries(ZONE_COLOR)) {
    assert.ok(ratioOn(v, S.card) >= 4.5, `ZONE_COLOR.${k} ${v} is a text colour on the pulse card`);
  }
  for (const [k, v] of Object.entries(FRESHNESS_COLOR)) {
    for (const ground of ['pill10', 'pill10OnCard', 'pill10OnRowSelected'] as const) {
      assert.ok(ratioOn(v, S[ground]) >= 3, `FRESHNESS_COLOR.${k} ${v} is a state dot on ${ground}`);
    }
  }
});

// ── Dynamic type (the code-checkable half) ───────────────────────────────────

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(join(APP_ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
}

const MEDIA_TEXT_FILES = (() => {
  const files: string[] = [];
  walk('src/features/media', files);
  files.push(
    F.whyThis,
    'app/media-world/index.tsx',
    'app/media-perspective/[id].tsx',
    F.routeMap,
    F.routeSearch,
    F.routeTimeline,
    F.routeContribute,
  );
  return files;
})();

test('dynamic type: no Media Text opts out of, or caps, OS font scaling', () => {
  let textElements = 0;
  const offenders: string[] = [];
  for (const file of MEDIA_TEXT_FILES) {
    const text = source(file);
    textElements += (text.match(/<Text\b/g) ?? []).length;
    if (/allowFontScaling\s*=\s*\{\s*false\s*\}/.test(text)) offenders.push(`${file}: allowFontScaling={false}`);
    if (/maxFontSizeMultiplier/.test(text)) offenders.push(`${file}: maxFontSizeMultiplier`);
  }
  // Anti-vacuity: the scan read the real surfaces, not an empty directory.
  assert.ok(MEDIA_TEXT_FILES.length >= 70, `scanned ${MEDIA_TEXT_FILES.length} files`);
  assert.ok(textElements >= 150, `found ${textElements} <Text elements`);
  assert.deepEqual(offenders, []);
});

test('dynamic type: no global Text default overrides font scaling for the whole app', () => {
  const files: string[] = [];
  walk('app', files);
  walk('src', files);
  const offenders = files.filter((file) => /Text\.defaultProps|setCustomText|react-native-global-props/.test(source(file)));
  assert.ok(files.length >= 500, `scanned ${files.length} files`);
  assert.deepEqual(offenders, []);
});

// ── The table, on request ────────────────────────────────────────────────────

test('print the measured table when MEDIA_CONTRAST_TABLE=1', () => {
  if (process.env.MEDIA_CONTRAST_TABLE !== '1') return;
  const rows = MEASURED.map((m) => {
    const verdict = m.threshold === null ? 'decor' : m.ratio >= m.threshold ? 'PASS' : 'FAIL';
    return `| ${m.pair.id} | ${m.pair.fg} | ${m.pair.on}${m.floor ? ' (floor)' : ''} | ${m.ratio.toFixed(2)} | ${m.threshold ?? '—'} | ${verdict} |`;
  });
  console.log(['| pair | fg | surface | ratio | threshold | result |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n'));
});

// ═══ census-media §31.12 — appended at the TAIL so no line cited above moves ═══
// (census-media cites :197, :808, :835, :841, :856 and :903 of this file.)
//
// Lane K's second pass measures three things the pairs above did not:
//   1. Two World-shell state marks over photographs that had no floor (the
//      perspective tile's evidence-class edge; the viewer's captions toggle when
//      it is on), lane I's cover-count badge on the Media Map, and the shared
//      StampButton the viewer renders.
//   2. The shipped Media tab: every component under src/components/media, the
//      tab route app/(tabs)/media.tsx, and the add-gem route's sheet.
//   3. The shared components those surfaces render on a photograph or a Media
//      sheet (PlaceQuickActions, FeaturedBadge, VerifiedStamp, StampIcon,
//      StampButton, GemStateBadge, AppHeader's overlay, EmptyState). They are
//      read here, and edited only to add an optional prop (§31.13): a pair that only a change to one of them can fix
//      is PINNED, and the guard at the end requires every pinned pair to cite
//      the shared file that blocks it.
//
// Same rules as above: WCAG 2.x AA, text 4.5:1, state indicators 3:1, photo
// floors over the 16-level grid, no large-text relief, every colour tied to its
// file by a needle. `decor` is used for an icon whose meaning a visible text
// label beside it already carries, an outline, a backdrop, a disabled control,
// and the transient stamp-burst animation (1.4.3: pure decoration; the stamped
// state is the rail's button, measured here).
//
// The pairs below are added at module evaluation and measured into MEASURED by
// the last statement of this block. node:test runs every test() above only after
// this module has finished evaluating, so the tests above see them; the first
// test below fails if any pair was left unmeasured.

const FT = {
  watchOverlay: 'src/components/media/WatchItemOverlay.tsx',
  videoCell: 'src/components/media/WatchVideoCell.tsx',
  feedList: 'src/components/media/WatchFeedList.tsx',
  watchFeed: 'src/components/media/WatchFeed.tsx',
  modeSelector: 'src/components/media/MediaModeSelector.tsx',
  gemsOverlay: 'src/components/media/GemsItemOverlay.tsx',
  gemsFilter: 'src/components/media/GemsFilterBar.tsx',
  gemsFeed: 'src/components/media/GemsFeed.tsx',
  gridTile: 'src/components/media/GridTile.tsx',
  gridFilter: 'src/components/media/GridFilterBar.tsx',
  masonry: 'src/components/media/MasonryGrid.tsx',
  gridFeed: 'src/components/media/GridFeed.tsx',
  locationStamp: 'src/components/media/VerifiedLocationStamp.tsx',
  radial: 'src/components/media/WatchRadialMenu.tsx',
  burst: 'src/components/media/StampItBurst.tsx',
  moreMenu: 'src/components/media/MediaMoreMenu.tsx',
  quickCreate: 'src/components/media/MediaQuickCreateSheet.tsx',
  routeIt: 'src/components/media/RouteItPlaceSheet.tsx',
  addGem: 'src/components/media/AddGemForm.tsx', creationAssist: 'src/platform/input-assistance/creation/CreationAssist.tsx', correctionBanner: 'src/platform/input-assistance/components/CorrectionBanner.tsx', entityRow: 'src/platform/input-assistance/components/EntitySuggestionRow.tsx', // §31.13 (pass 4): CreationAssist, inline in the add-gem sheet
  addGemRoute: 'app/media/add-gem.tsx',
  tab: 'app/(tabs)/media.tsx', mediaViewer: 'app/media-viewer/[id].tsx', // the Grid's full-screen viewer (§31.13)
  // Shared components the Media surfaces render — read here; §31.13 adds an optional prop to StampButton, AppHeader and EmptyState.
  placeQuickActions: 'src/components/PlaceQuickActions.tsx',
  featuredBadge: 'src/components/FeaturedBadge.tsx',
  verifiedBadge: 'src/components/ui/VerifiedStamp.tsx',
  stampIcon: 'src/components/stamps/StampIcon.tsx',
  stampButton: 'src/components/stamps/StampButton.tsx',
  gemStateBadge: 'src/components/gems/GemStateBadge.tsx',
  appHeader: 'src/components/ui/AppHeader.tsx',
  emptyState: 'src/components/ui/EmptyState.tsx', cachedImage: 'src/components/CachedImage.tsx', mediaFallback: 'src/components/ui/DisplayMediaImage.tsx', avatar: 'src/components/ui/Avatar.tsx', gemContribute: 'src/components/gems/GemContributeSection.tsx', // §31.13
} as const;

/** The shared files a pinned pair may name as its blocker. */
const SHARED_BLOCKERS: readonly string[] = [FT.stampButton, FT.stampIcon, FT.appHeader, FT.emptyState];

const W_ = (alpha: string) => `rgba(255,255,255,${alpha})`;
const S_TAIL = {
  // World shell.
  tileEdgePhoto: [PHOTO, 'rgba(17,17,15,0.80)'],
  tileEdgeFallback: ['#22221E', 'rgba(17,17,15,0.80)'],
  coverCountPhoto: [PHOTO, 'rgba(17,17,15,0.92)'],
  coverCountMap: [MAP, 'rgba(17,17,15,0.92)'],
  // Watch: the overlay's two column backings, its create button, the cell, the list, the feed toggle.
  watchLeftPhoto: [PHOTO, 'rgba(17,17,15,0.71)'],
  watchLeftChip: [PHOTO, 'rgba(17,17,15,0.71)', W_('0.12')],
  watchLeftFollowActive: [PHOTO, 'rgba(17,17,15,0.71)', W_('0.08')],
  watchLeftFeatured: [PHOTO, 'rgba(17,17,15,0.71)', 'rgba(212, 160, 23, 0.22)'],
  locationStampPhoto: [PHOTO, 'rgba(17,17,15,0.66)'],
  watchRailPhoto: [PHOTO, 'rgba(17,17,15,0.80)'],
  watchCreatePhoto: [PHOTO, 'rgba(17,17,15,0.58)'],
  videoFailurePhoto: [PHOTO, 'rgba(17,17,15,0.71)'],
  videoFailureFallback: [color.ink, 'rgba(17,17,15,0.71)'],
  videoSpinnerPhoto: [PHOTO, 'rgba(17,17,15,0.52)'],
  feedTrackPhoto: [PHOTO, 'rgba(17,17,15,0.80)'],
  feedPausePhoto: [PHOTO, 'rgba(17,17,15,0.57)'],
  feedMutePhoto: [PHOTO, 'rgba(17,17,15,0.55)'],
  feedHintPhoto: [PHOTO, 'rgba(0,0,0,0.59)'],
  feedTogglePhoto: [PHOTO, 'rgba(17,17,15,0.71)'],
  feedToggleEmpty: [color.ink, 'rgba(17,17,15,0.71)'],
  modeRowPhoto: [PHOTO, 'rgba(0,0,0,0.66)'],
  // Gems.
  gemsBottomPhoto: [PHOTO, 'rgba(0,0,0,0.81)'],
  gemsTypeBadge: [PHOTO, 'rgba(0,0,0,0.81)', W_('0.18')],
  gemsChip: [PHOTO, 'rgba(0,0,0,0.81)', 'rgba(0,0,0,0.30)'],
  gemsQuickActions: [PHOTO, 'rgba(0,0,0,0.81)', W_('0.12')],
  gemStateConfirmed: [PHOTO, 'rgba(0,0,0,0.81)', 'rgba(46,125,91,0.20)'],
  gemStateHidden: [PHOTO, 'rgba(0,0,0,0.81)', 'rgba(10,61,74,0.42)'],
  gemStateCalm: [PHOTO, 'rgba(0,0,0,0.81)', 'rgba(76,139,245,0.16)'],
  gemStateAware: [PHOTO, 'rgba(0,0,0,0.81)', 'rgba(200,133,26,0.16)'],
  gemStateCaution: [PHOTO, 'rgba(0,0,0,0.81)', 'rgba(200,133,26,0.20)'],
  gemStateProtective: [PHOTO, 'rgba(0,0,0,0.81)', 'rgba(230,120,80,0.18)'],
  gemsRailPhoto: [PHOTO, 'rgba(0,0,0,0.89)'],
  gemsBannerPhoto: [PHOTO, 'rgba(0,0,0,0.83)'],
  gemsFilterPhoto: [PHOTO, 'rgba(17,17,15,0.81)'],
  gemsFilterArea: [PHOTO, 'rgba(17,17,15,0.81)', W_('0.12')],
  gemsFilterCat: [PHOTO, 'rgba(17,17,15,0.81)', W_('0.10')],
  signalFill: [color.signal],
  // Grid.
  gridScrimPhoto: [PHOTO, 'rgba(0,0,0,0.55)'],
  gridScrimFallback: [color.haze, 'rgba(0,0,0,0.55)'],
  gridProcessingPhoto: [PHOTO, 'rgba(17,17,15,0.65)'],
  gridStampPhoto: [PHOTO, 'rgba(17,17,15,0.80)'], // §31.13: was 0.95, for the idle `mute` icon
  // Sheets and forms, and the tab's own buttons.
  errorTint: ['#FEF2F2'],
  gemGreen: ['#0C875E'],
  vermilionOnPaper: ['#C43B23'],
  quickCreateHighlight: [color.paper, 'rgba(16,185,129,0.0314)'],
  routeItMapThumb: ['#D6E8F0'],
  radialPurple: ['#8558EC'],
  radialSignal: ['#D64127'],
  radialSky: ['#0B7DB1'],
  radialGreen: ['#0C875E'],
  addGemBadgePhoto: [PHOTO, 'rgba(17,17,15,0.65)'], mediaFallbackGround: [color.mute], gemContributeCard: ['#13213A'], gemContributeDoneGreen: ['#13213A', 'rgba(111,211,154,0.1333)'], gemContributeDoneBlue: ['#13213A', 'rgba(157,184,232,0.1333)'], gemContributeDoneAmber: ['#13213A', 'rgba(232,178,77,0.1333)'], // §31.13
  worldPillPhoto: [PHOTO, 'rgba(17,17,15,0.58)'],
  mvTopButtonPhoto: [PHOTO, 'rgba(17,17,15,0.55)'], mvLeftPhoto: [PHOTO, 'rgba(17,17,15,0.71)'], mvLeftChip: [PHOTO, 'rgba(17,17,15,0.71)', W_('0.12')], mvRightPhoto: [PHOTO, 'rgba(17,17,15,0.80)'], mvSpinnerPhoto: [PHOTO, 'rgba(17,17,15,0.47)'], mvDotsPhoto: [PHOTO, 'rgba(17,17,15,0.87)'], mvCloseOnInk: [color.ink, 'rgba(17,17,15,0.6)'], // §31.13: the Grid's full-screen viewer. Then shared components on a photograph.
  appHeaderOverlayPhoto: [PHOTO, 'rgba(17,17,15,0.58)'], // §31.13: the tab's overlayTint; the header's own default is 0.28 black
  burstPhoto: [PHOTO, 'rgba(255,60,60,0.12)'],
  radialBackdropPhoto: [PHOTO, 'rgba(0,0,0,0.35)'], ...SHEET_SURFACES, ...NESTED_SURFACES, // census-media §33 and §33.13: the grounds of the shared sheets Media opens (imported at the tail)
} as const satisfies Record<string, readonly string[]>;

/** Layers for a surface id — the tail's surfaces as well as the ones above. Hoisted; S_TAIL is read only for tail ids. */
function surfaceLayers(id: SurfaceId): readonly string[] {
  return Object.prototype.hasOwnProperty.call(S, id) ? S[id as keyof typeof S] : S_TAIL[id as keyof typeof S_TAIL];
}

const WHITE = '#FFFFFF'; // the source writes '#fff'; parseColor reads six digits

// ─ 1. World shell ─
// The perspective tile's evidence-class edge, now on a 0.80 ink casing (was straight on the photo: 1.00).
const TILE_EDGE: Needle[] = [
  [F.tile, 'const accent = OBSERVATION_COLOR[media.observationClass];'],
  [F.tile, '<View style={tailStyles.edgeCasing} /><View style={[styles.edge, { backgroundColor: accent }]} />'],
  [F.tile, "edgeCasing: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, backgroundColor: 'rgba(17,17,15,0.80)' },"],
];
for (const [k, v] of Object.entries(OBSERVATION_COLOR)) {
  add({ id: `tile.edge.${k}.photoFloor`, fg: v, on: 'tileEdgePhoto', kind: 'ui', at: TILE_EDGE });
  add({ id: `tile.edge.${k}.fallback`, fg: v, on: 'tileEdgeFallback', kind: 'ui', at: [...TILE_EDGE, [F.tile, "fallback: { backgroundColor: '#22221E' }"]] });
}
// The viewer's captions toggle: ON is an opaque onInk badge under an ink icon (was onInk on a 0.32 light wash: 1.00).
const CAPTIONS_ICON: Needle = [F.viewer, '<Captions size={16} color={showCaptions ? color.ink : color.onInk} />'];
add({ id: 'viewer.captionsToggle.on', fg: color.ink, on: 'selected', kind: 'ui', at: [CAPTIONS_ICON, [F.viewer, 'controlButtonActive: { backgroundColor: color.onInk },']] });
add({ id: 'viewer.captionsToggle.off.photoFloor', fg: color.onInk, on: 'viewerControlPhoto', kind: 'ui', at: [CAPTIONS_ICON, [F.viewer, "backgroundColor: 'rgba(17,17,15,0.7)'"]] });
// Lane I's cover-count badge and the selected cover ring on the Media Map.
const COVER_COUNT: Needle[] = [[F.mapCanvas, "coverCountText: { color: color.onInk, fontSize: 11, fontWeight: '800' },"], [F.mapCanvas, "backgroundColor: 'rgba(17,17,15,0.92)',"]];
add({ id: 'mapCanvas.coverCount.photoFloor', fg: color.onInk, on: 'coverCountPhoto', kind: 'text', at: COVER_COUNT });
add({ id: 'mapCanvas.coverCount.mapFloor', fg: color.onInk, on: 'coverCountMap', kind: 'text', at: COVER_COUNT });
add({ id: 'mapCanvas.coverRing.selected.mapFloor', fg: color.onInk, on: 'map', kind: 'ui', at: [[F.mapCanvas, /coverBubble: \{[^}]*borderColor: color\.onInk,/], [F.mapCanvas, 'coverBubbleSelected: { borderWidth: 3, transform: [{ scale: 1.15 }] },']] });
// The shared StampButton in the viewer's action row, on the 0.96 overlay.
const STAMP_ICON_COLOUR: Needle = [FT.stampIcon, 'const c = colorProp ?? (active ? tokens.signal : tokens.mute);'];
const STAMP_BUTTON_ICON: Needle = [FT.stampButton, "<StampIcon size={iconSize} active={visualIsStamped} {...(tone === 'onDark' && !visualIsStamped ? { color: color.onInk } : {})} />"];
const STAMP_COUNT_TONE: Needle = [FT.stampButton, "style={tone === 'onDark' ? [s.count, onDark.count] : [s.count, visualIsStamped && s.countActive]}"]; // §31.13: under tone="onDark" the count is onDark.count, idle or stamped
const STAMP_COUNT_ON_DARK: Needle = [FT.stampButton, /const onDark = StyleSheet\.create\(\{\s*count: \{ color: color\.onInk \},/];
const VIEWER_STAMP: Needle = [F.viewer, /<StampButton[^>]*tone="onDark"/];
add({ id: 'viewer.stampButton.icon.idle.photoFloor', fg: color.onInk, on: 'viewerOverlayPhoto', kind: 'ui', at: [VIEWER_STAMP, STAMP_BUTTON_ICON, VIEWER_OVERLAY] });
add({ id: 'viewer.stampButton.icon.active.photoFloor', fg: color.signal, on: 'viewerOverlayPhoto', kind: 'ui', at: [VIEWER_STAMP, STAMP_BUTTON_ICON, STAMP_ICON_COLOUR, VIEWER_OVERLAY] });
add({ id: 'viewer.stampButton.count.active.photoFloor', fg: color.onInk, on: 'viewerOverlayPhoto', kind: 'text', at: [VIEWER_STAMP, STAMP_COUNT_TONE, STAMP_COUNT_ON_DARK, VIEWER_OVERLAY] });
// FIXED by lane K (census-media §31.13): was pinned at 3.12 — `mute` can never reach 4.5:1 on a dark ground (3.79 on black). The viewer now passes StampButton's optional tone="onDark", so the count is onInk.
add({ id: 'viewer.stampButton.count.idle.photoFloor', fg: color.onInk, on: 'viewerOverlayPhoto', kind: 'text', at: [VIEWER_STAMP, STAMP_COUNT_TONE, STAMP_COUNT_ON_DARK, VIEWER_OVERLAY] });

// ─ 2. The shipped Media tab ─
// WatchItemOverlay — the left column and the action rail each on an ink backing (the gradient is kept, and not relied on).
const WATCH_LEFT: Needle = [FT.watchOverlay, "paddingRight: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: 'rgba(17,17,15,0.71)',"];
const WATCH_CHIP: Needle = [FT.watchOverlay, /chip: \{[^}]*backgroundColor: 'rgba\(255,255,255,0\.12\)'/];
add({ id: 'watch.displayName', fg: color.onInk, on: 'watchLeftPhoto', kind: 'text', at: [WATCH_LEFT, [FT.watchOverlay, /displayName: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.onInk,/]] });
add({ id: 'watch.username', fg: color.onInkMute, on: 'watchLeftPhoto', kind: 'text', at: [WATCH_LEFT, [FT.watchOverlay, /username: \{\s*\.\.\.t\.stamp,\s*color: color\.onInkMute,/]] });
add({ id: 'watch.follow', fg: color.onInk, on: 'watchLeftChip', kind: 'text', at: [WATCH_LEFT, [FT.watchOverlay, /followBtn: \{[^}]*backgroundColor: 'rgba\(255,255,255,0\.12\)'/], [FT.watchOverlay, /followBtnText: \{\s*\.\.\.t\.stamp,\s*color: color\.onInk,/]] });
add({ id: 'watch.follow.following', fg: color.onInk, on: 'watchLeftFollowActive', kind: 'text', at: [WATCH_LEFT, [FT.watchOverlay, /followBtnActive: \{[^}]*backgroundColor: 'rgba\(255,255,255,0\.08\)'/]] });
add({ id: 'watch.caption', fg: color.onInk, on: 'watchLeftPhoto', kind: 'text', at: [WATCH_LEFT, [FT.watchOverlay, /caption: \{\s*\.\.\.t\.body,\s*color: color\.onInk,/]] });
add({ id: 'watch.captionMore', fg: color.onInkMute, on: 'watchLeftPhoto', kind: 'text', at: [WATCH_LEFT, [FT.watchOverlay, /captionMore: \{\s*\.\.\.t\.small,\s*color: color\.onInkMute,/]] });
add({ id: 'watch.hashtags', fg: 'rgba(250,249,246,0.85)', on: 'watchLeftPhoto', kind: 'text', at: [WATCH_LEFT, [FT.watchOverlay, /hashtags: \{[^}]*color: color\.onInk,[^}]*opacity: 0\.85,/]] });
add({ id: 'watch.placeAndEntityChip', fg: W_('0.9'), on: 'watchLeftChip', kind: 'text', at: [WATCH_LEFT, WATCH_CHIP, [FT.watchOverlay, /chipText: \{\s*\.\.\.t\.stamp,\s*color: 'rgba\(255,255,255,0\.9\)'/]] });
add({ id: 'watch.chipIcons', fg: W_('0.85'), on: 'watchLeftChip', kind: 'decor', at: [[FT.watchOverlay, '<MapPin size={11} color="rgba(255,255,255,0.85)" />']] });
add({ id: 'watch.audio', fg: W_('0.75'), on: 'watchLeftPhoto', kind: 'text', at: [WATCH_LEFT, [FT.watchOverlay, /audioText: \{\s*\.\.\.t\.stamp,\s*color: 'rgba\(255,255,255,0\.75\)'/]] });
add({ id: 'watch.featuredBadge', fg: '#FDE68A', on: 'watchLeftFeatured', kind: 'text', at: [WATCH_LEFT, [FT.watchOverlay, '<FeaturedBadge category={item.featuredByPortava} size="sm" dark />'], [FT.featuredBadge, "const bg = dark ? 'rgba(212, 160, 23, 0.22)' : '#FEF3C7';"], [FT.featuredBadge, "const textColor = dark ? '#FDE68A' : '#92400E';"]] });
add({ id: 'watch.verifiedCreator', fg: 'rgba(250,249,246,0.92)', on: 'watchLeftPhoto', kind: 'ui', at: [WATCH_LEFT, [FT.watchOverlay, '<VerifiedStamp size="sm" dark />'], [FT.verifiedBadge, "const ink = dark ? 'rgba(250,249,246,0.92)' : '#1A3A5C';"]] });
const QUICK_ACTIONS_DARK: Needle[] = [[FT.placeQuickActions, /chipDark: \{[^}]*backgroundColor: 'rgba\(255,255,255,0\.12\)'/], [FT.placeQuickActions, /chipTextDark: \{[^}]*color: 'rgba\(255,255,255,0\.92\)'/]];
add({ id: 'watch.placeQuickActions', fg: W_('0.92'), on: 'watchLeftChip', kind: 'text', at: [WATCH_LEFT, [FT.watchOverlay, 'variant="dark"'], ...QUICK_ACTIONS_DARK] });
// VerifiedLocationStamp — now opaque (was opacity 0.38) on its own 0.66 ink backing; also drawn on grid tiles.
const LOCATION_STAMP: Needle[] = [[FT.locationStamp, 'opacity: 1,'], [FT.locationStamp, "borderStyle: 'dashed', backgroundColor: 'rgba(17,17,15,0.66)',"]];
add({ id: 'locationStamp.eyebrow.photoFloor', fg: '#E8DFC8', on: 'locationStampPhoto', kind: 'text', at: [...LOCATION_STAMP, [FT.locationStamp, /eyebrow: \{[^}]*color: '#E8DFC8',/], [FT.watchOverlay, '<VerifiedLocationStamp locationName={item.place.name} />']] });
add({ id: 'locationStamp.name.photoFloor', fg: '#E8DFC8', on: 'locationStampPhoto', kind: 'text', at: [...LOCATION_STAMP, [FT.locationStamp, /name: \{[^}]*color: '#E8DFC8',/], [FT.gridTile, '<VerifiedLocationStamp']] });
const WATCH_RAIL: Needle = [FT.watchOverlay, "paddingBottom: space.sm, paddingTop: space.md, paddingHorizontal: space.xs, borderRadius: radius.pill, backgroundColor: 'rgba(17,17,15,0.80)',"];
add({ id: 'watch.rail.counts', fg: color.onInk, on: 'watchRailPhoto', kind: 'text', at: [WATCH_RAIL, [FT.watchOverlay, /actionCount: \{\s*\.\.\.t\.stamp,\s*color: color\.onInk,/]] });
add({ id: 'watch.rail.icons', fg: WHITE, on: 'watchRailPhoto', kind: 'ui', at: [WATCH_RAIL, [FT.watchOverlay, '<MessageCircle size={28} color="#fff"'], [FT.watchOverlay, '<PortavaShareIcon size={26} color="#fff" />'], [FT.watchOverlay, '<MoreVertical size={26} color="#fff"']] });
add({ id: 'watch.rail.saved', fg: color.signal, on: 'watchRailPhoto', kind: 'ui', at: [WATCH_RAIL, [FT.watchOverlay, "color={isSaved ? color.signal : '#fff'}"]] });
const WATCH_STAMP: Needle = [FT.watchOverlay, "<StampIcon size={28} active={stampVisualIsStamped} color={stampVisualIsStamped ? color.signal : '#fff'} />"];
add({ id: 'watch.rail.stamp.idle', fg: WHITE, on: 'watchRailPhoto', kind: 'ui', at: [WATCH_RAIL, WATCH_STAMP] });
add({ id: 'watch.rail.stamp.active', fg: color.signal, on: 'watchRailPhoto', kind: 'ui', at: [WATCH_RAIL, WATCH_STAMP] });
add({ id: 'watch.rail.stampItCount', fg: 'rgba(255,220,80,0.9)', on: 'watchRailPhoto', kind: 'text', at: [WATCH_RAIL, [FT.watchOverlay, /stampCount: \{[^}]*color: 'rgba\(255,220,80,0\.9\)'/]] });
const WATCH_CREATE: Needle = [FT.watchOverlay, "backgroundColor: 'rgba(17,17,15,0.58)',"];
add({ id: 'watch.create.label', fg: WHITE, on: 'watchCreatePhoto', kind: 'text', at: [WATCH_CREATE, [FT.watchOverlay, /createBtnText: \{\s*\.\.\.t\.stamp,\s*color: '#fff',/]] });
add({ id: 'watch.create.icon', fg: WHITE, on: 'watchCreatePhoto', kind: 'ui', at: [WATCH_CREATE, [FT.watchOverlay, '<Camera size={16} color="#fff"']] });
// WatchVideoCell — the failure overlay (poster, or the ink cell) and the buffering spinner's badge.
const VIDEO_FAILURE: Needle[] = [[FT.videoCell, "backgroundColor: 'rgba(17,17,15,0.71)',"], [FT.videoCell, /failureText: \{\s*\.\.\.t\.small,\s*color: 'rgba\(255,255,255,0\.7\)'/]];
add({ id: 'videoCell.failure.photoFloor', fg: W_('0.7'), on: 'videoFailurePhoto', kind: 'text', at: VIDEO_FAILURE });
add({ id: 'videoCell.failure.fallback', fg: W_('0.7'), on: 'videoFailureFallback', kind: 'text', at: [...VIDEO_FAILURE, [FT.videoCell, /cell: \{[^}]*backgroundColor: color\.ink,/]] });
add({ id: 'videoCell.failureIcon', fg: W_('0.7'), on: 'videoFailurePhoto', kind: 'decor', at: [[FT.videoCell, '<PlayCircle size={40} color="rgba(255,255,255,0.7)" />']] });
add({ id: 'videoCell.spinner.photoFloor', fg: W_('0.8'), on: 'videoSpinnerPhoto', kind: 'ui', at: [[FT.videoCell, '<View style={tailStyles.spinnerBadge}><ActivityIndicator size="large" color="rgba(255,255,255,0.8)" /></View>'], [FT.videoCell, "spinnerBadge: { padding: 10, borderRadius: 999, backgroundColor: 'rgba(17,17,15,0.52)' },"]] });
// WatchFeedList — the progress bar, the pause mark, the mute button, the swipe hint.
const FEED_TRACK: Needle = [FT.feedList, "backgroundColor: 'rgba(17,17,15,0.80)',"];
add({ id: 'feedList.progressFill.photoFloor', fg: color.signal, on: 'feedTrackPhoto', kind: 'ui', at: [FEED_TRACK, [FT.feedList, /progressFill: \{[^}]*backgroundColor: color\.signal,/]] });
add({ id: 'feedList.scrubHandle.photoFloor', fg: WHITE, on: 'feedTrackPhoto', kind: 'ui', at: [FEED_TRACK, [FT.feedList, /scrubHandle: \{[^}]*backgroundColor: '#fff',/]] });
add({ id: 'feedList.pauseBars.photoFloor', fg: W_('0.7'), on: 'feedPausePhoto', kind: 'ui', at: [[FT.feedList, "width: 44, borderRadius: radius.md, backgroundColor: 'rgba(17,17,15,0.57)',"], [FT.feedList, /pauseBar: \{[^}]*backgroundColor: 'rgba\(255,255,255,0\.7\)'/]] });
add({ id: 'feedList.muteIcon.photoFloor', fg: WHITE, on: 'feedMutePhoto', kind: 'ui', at: [[FT.feedList, /muteBtn: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.55\)'/], [FT.feedList, '<VolumeX size={18} color="#fff" />']] });
const FEED_HINT: Needle = [FT.feedList, "backgroundColor: 'rgba(0,0,0,0.59)',"];
add({ id: 'feedList.swipeHint.arrow.photoFloor', fg: W_('0.85'), on: 'feedHintPhoto', kind: 'text', at: [FEED_HINT, [FT.feedList, /swipeHintArrow: \{[^}]*color: 'rgba\(255,255,255,0\.85\)'/]] });
add({ id: 'feedList.swipeHint.label.photoFloor', fg: W_('0.85'), on: 'feedHintPhoto', kind: 'text', at: [FEED_HINT, [FT.feedList, /swipeHintLabel: \{[^}]*color: 'rgba\(255,255,255,0\.85\)'/]] });
// WatchFeed — the For You / Following toggle (over the feed, and on the empty feed), the empty and error states.
const FEED_TOGGLE: Needle = [FT.watchFeed, "gap: space.md, paddingHorizontal: space.md, paddingTop: space.xs, borderRadius: 999, backgroundColor: 'rgba(17,17,15,0.71)',"];
for (const [where, on] of [['photoFloor', 'feedTogglePhoto'], ['emptyFeed', 'feedToggleEmpty']] as const) {
  add({ id: `watchFeed.toggle.label.${where}`, fg: color.onInkMute, on, kind: 'text', at: [FEED_TOGGLE, [FT.watchFeed, /label: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.onInkMute,/]] });
  add({ id: `watchFeed.toggle.labelActive.${where}`, fg: color.onInk, on, kind: 'text', at: [FEED_TOGGLE, [FT.watchFeed, /labelActive: \{\s*color: color\.onInk,/]] });
  add({ id: `watchFeed.toggle.underline.${where}`, fg: color.onInk, on, kind: 'ui', at: [FEED_TOGGLE, [FT.watchFeed, /tabActive: \{\s*borderBottomColor: color\.onInk,/]] });
}
const FEED_EMPTY: Needle = [FT.watchFeed, /container: \{[^}]*backgroundColor: color\.ink,/];
add({ id: 'watchFeed.empty.title', fg: color.onInk, on: 'ink', kind: 'text', at: [FEED_EMPTY, [FT.watchFeed, /title: \{\s*\.\.\.t\.heading,\s*color: color\.onInk,/]] });
add({ id: 'watchFeed.empty.subtitle', fg: color.onInkMute, on: 'ink', kind: 'text', at: [FEED_EMPTY, [FT.watchFeed, /subtitle: \{\s*\.\.\.t\.body,\s*color: color\.onInkMute,/]] });
add({ id: 'watchFeed.empty.retry', fg: color.onInk, on: 'ink', kind: 'text', at: [FEED_EMPTY, [FT.watchFeed, /btnText: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.onInk,/]] });
add({ id: 'watchFeed.empty.icon', fg: color.onInkMute, on: 'ink', kind: 'decor', at: [[FT.watchFeed, '<WifiOff size={48} color={color.onInkMute} />']] });
add({ id: 'watchFeed.loading', fg: color.signal, on: 'ink', kind: 'ui', at: [[FT.watchFeed, '<ActivityIndicator size="large" color={color.signal} />'], [FT.watchFeed, /centered: \{[^}]*backgroundColor: color\.ink,/]] });
// MediaModeSelector — immersive (Watch/Gems, over the frame) and solid (Grid, on haze).
const MODE_ROW: Needle = [FT.modeSelector, "backgroundColor: 'rgba(0,0,0,0.66)',"];
add({ id: 'modeSelector.label.photoFloor', fg: color.onInkMute, on: 'modeRowPhoto', kind: 'text', at: [MODE_ROW, [FT.modeSelector, /labelImmersive: \{\s*color: color\.onInkMute,/]] });
add({ id: 'modeSelector.selectedFill.photoFloor', fg: color.onInk, on: 'modeRowPhoto', kind: 'ui', at: [MODE_ROW, [FT.modeSelector, /itemActiveImmersive: \{\s*backgroundColor: color\.onInk,/]] });
add({ id: 'modeSelector.labelActive', fg: color.ink, on: 'selected', kind: 'text', at: [[FT.modeSelector, /itemActiveImmersive: \{\s*backgroundColor: color\.onInk,/], [FT.modeSelector, /labelActiveImmersive: \{\s*color: color\.ink,/]] });
add({ id: 'modeSelector.solid.label', fg: '#696660', on: 'haze', kind: 'text', at: [[FT.modeSelector, /rowSolid: \{\s*backgroundColor: color\.haze,/], [FT.modeSelector, /labelSolid: \{\s*color: '#696660',/]] });
add({ id: 'modeSelector.solid.selectedFill', fg: color.ink, on: 'haze', kind: 'ui', at: [[FT.modeSelector, /rowSolid: \{\s*backgroundColor: color\.haze,/], [FT.modeSelector, /itemActiveSolid: \{\s*backgroundColor: color\.ink,/]] });
add({ id: 'modeSelector.solid.labelActive', fg: color.onInk, on: 'ink', kind: 'text', at: [[FT.modeSelector, /itemActiveSolid: \{\s*backgroundColor: color\.ink,/], [FT.modeSelector, /labelActiveSolid: \{\s*color: color\.onInk,/]] });
// GemsItemOverlay — the bottom content and the action column each on a black backing; the illustrative banner.
const GEMS_BOTTOM: Needle = [FT.gemsOverlay, "gap: space.sm, paddingTop: space.md, backgroundColor: 'rgba(0,0,0,0.81)',"];
const GEMS_TYPE_BADGE: Needle = [FT.gemsOverlay, /placeTypeBadge: \{[^}]*backgroundColor: 'rgba\(255,255,255,0\.18\)'/];
add({ id: 'gems.placeType', fg: color.onInk, on: 'gemsTypeBadge', kind: 'text', at: [GEMS_BOTTOM, GEMS_TYPE_BADGE, [FT.gemsOverlay, /placeTypeBadgeText: \{\s*\.\.\.t\.stamp,\s*color: color\.onInk,/]] });
add({ id: 'gems.verifiedPlaceMark', fg: '#B6D2C6', on: 'gemsTypeBadge', kind: 'text', at: [GEMS_BOTTOM, GEMS_TYPE_BADGE, [FT.gemsOverlay, /verifiedDot: \{\s*\.\.\.t\.stamp,\s*color: '#B6D2C6',/]] });
add({ id: 'gems.placeName', fg: color.onInk, on: 'gemsBottomPhoto', kind: 'text', at: [GEMS_BOTTOM, [FT.gemsOverlay, /placeName: \{\s*\.\.\.t\.title,\s*color: color\.onInk,/]] });
add({ id: 'gems.placeArea', fg: color.onInkMute, on: 'gemsBottomPhoto', kind: 'text', at: [GEMS_BOTTOM, [FT.gemsOverlay, /placeArea: \{\s*\.\.\.t\.small,\s*color: color\.onInkMute,/]] });
add({ id: 'gems.viewPlaceChip', fg: color.onInk, on: 'gemsChip', kind: 'text', at: [GEMS_BOTTOM, [FT.gemsOverlay, /chip: \{[^}]*backgroundColor: 'rgba\(0,0,0,0\.30\)'/], [FT.gemsOverlay, /chipText: \{\s*\.\.\.t\.stamp,\s*color: color\.onInk,/]] });
add({ id: 'gems.placeQuickActions', fg: W_('0.92'), on: 'gemsQuickActions', kind: 'text', at: [GEMS_BOTTOM, [FT.gemsOverlay, 'variant="dark"'], ...QUICK_ACTIONS_DARK] });
add({ id: 'gems.creatorName', fg: color.onInk, on: 'gemsBottomPhoto', kind: 'text', at: [GEMS_BOTTOM, [FT.gemsOverlay, /creatorName: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.onInk,/]] });
add({ id: 'gems.creatorUsername', fg: color.onInkMute, on: 'gemsBottomPhoto', kind: 'text', at: [GEMS_BOTTOM, [FT.gemsOverlay, /creatorUsername: \{\s*\.\.\.t\.small,\s*color: color\.onInkMute,/]] });
add({ id: 'gems.follow', fg: color.onInk, on: 'gemsBottomPhoto', kind: 'text', at: [GEMS_BOTTOM, [FT.gemsOverlay, /followBtnText: \{\s*\.\.\.t\.stamp,\s*color: color\.onInk,/]] });
add({ id: 'gems.caption', fg: color.onInkMute, on: 'gemsBottomPhoto', kind: 'text', at: [GEMS_BOTTOM, [FT.gemsOverlay, /caption: \{\s*\.\.\.t\.small,\s*color: color\.onInkMute,/]] });
const GEM_STATE_TONES: ReadonlyArray<readonly [tone: string, fg: string, bg: string, on: SurfaceId]> = [
  ['confirmed', '#6FD39A', 'rgba(46,125,91,0.20)', 'gemStateConfirmed'],
  ['hidden', '#7FD4E0', 'rgba(10,61,74,0.42)', 'gemStateHidden'],
  ['calm', '#9DB8E8', 'rgba(76,139,245,0.16)', 'gemStateCalm'],
  ['aware', '#E0B36A', 'rgba(200,133,26,0.16)', 'gemStateAware'],
  ['caution', '#E8B24D', 'rgba(200,133,26,0.20)', 'gemStateCaution'],
  ['protective', '#F0A98C', 'rgba(230,120,80,0.18)', 'gemStateProtective'],
];
for (const [tone, fg, bg, on] of GEM_STATE_TONES) {
  add({ id: `gems.gemState.${tone}`, fg, on, kind: 'text', at: [GEMS_BOTTOM, [FT.gemsOverlay, '<GemStateBadge'], [FT.gemStateBadge, `fg: '${fg}', bg: '${bg}'`]] });
}
for (const [tone, fg] of [['strong', '#6FD39A'], ['good', '#9DB8E8'], ['emerging', '#C9B382'], ['faint', '#8A9BB5']] as const) {
  add({ id: `gems.confidence.${tone}`, fg, on: 'gemsBottomPhoto', kind: 'text', at: [GEMS_BOTTOM, [FT.gemsOverlay, 'showConfidence'], [FT.gemStateBadge, new RegExp(`${tone}:\\s*'${fg}',`)]] });
}
const GEMS_RAIL: Needle = [FT.gemsOverlay, "gap: space.lg, paddingVertical: space.sm, paddingHorizontal: space.xs, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.89)',"];
add({ id: 'gems.rail.glyphs', fg: color.onInk, on: 'gemsRailPhoto', kind: 'ui', at: [GEMS_RAIL, [FT.gemsOverlay, /actionBtnIcon: \{\s*fontSize: 26,\s*color: color\.onInk,/], [FT.gemsOverlay, 'label="⋯"']] });
add({ id: 'gems.rail.counts', fg: color.onInkMute, on: 'gemsRailPhoto', kind: 'text', at: [GEMS_RAIL, [FT.gemsOverlay, /actionBtnSublabel: \{\s*\.\.\.t\.stamp,\s*color: color\.onInkMute,/]] });
const GEMS_STAMP: Needle = [FT.gemsOverlay, /<StampButton[^>]*tone="onDark"/];
add({ id: 'gems.rail.stampButton.icon.idle', fg: color.onInk, on: 'gemsRailPhoto', kind: 'ui', at: [GEMS_RAIL, GEMS_STAMP, STAMP_BUTTON_ICON] });
add({ id: 'gems.rail.stampButton.icon.active', fg: color.signal, on: 'gemsRailPhoto', kind: 'ui', at: [GEMS_RAIL, GEMS_STAMP, STAMP_BUTTON_ICON, STAMP_ICON_COLOUR] });
add({ id: 'gems.rail.stampButton.count.active', fg: color.onInk, on: 'gemsRailPhoto', kind: 'text', at: [GEMS_RAIL, GEMS_STAMP, STAMP_COUNT_TONE, STAMP_COUNT_ON_DARK] });
// FIXED by lane K (census-media §31.13): was pinned at 3.07, as viewer.stampButton.count.idle; the gems rail passes tone="onDark".
add({ id: 'gems.rail.stampButton.count.idle', fg: color.onInk, on: 'gemsRailPhoto', kind: 'text', at: [GEMS_RAIL, GEMS_STAMP, STAMP_COUNT_TONE, STAMP_COUNT_ON_DARK] });
add({ id: 'gems.illustrativeBanner', fg: color.warn, on: 'gemsBannerPhoto', kind: 'text', at: [[FT.gemsOverlay, "backgroundColor: 'rgba(0,0,0,0.83)',"], [FT.gemsOverlay, /illustrativeBannerText: \{\s*\.\.\.t\.stamp,\s*color: color\.warn,/]] });
const GEMS_MENU: Needle = [FT.gemsOverlay, /moreMenu: \{[^}]*backgroundColor: color\.paperRaised,/];
add({ id: 'gems.moreMenu.item', fg: color.ink, on: 'paperRaised', kind: 'text', at: [GEMS_MENU, [FT.gemsOverlay, /moreMenuItemText: \{\s*\.\.\.t\.body,\s*color: color\.ink,/]] });
add({ id: 'gems.moreMenu.cancel', fg: color.mute, on: 'paperRaised', kind: 'text', at: [GEMS_MENU, [FT.gemsOverlay, /moreMenuItemCancel: \{\s*color: color\.mute,/]] });
// GemsFilterBar — floats over the gem image, now on an ink backing.
const GEMS_FILTER: Needle = [FT.gemsFilter, "paddingTop: space.sm, paddingBottom: space.sm, backgroundColor: 'rgba(17,17,15,0.81)',"];
add({ id: 'gemsFilter.area.label', fg: color.onInkMute, on: 'gemsFilterArea', kind: 'text', at: [GEMS_FILTER, [FT.gemsFilter, /areaChip: \{[^}]*backgroundColor: 'rgba\(255,255,255,0\.12\)'/], [FT.gemsFilter, /areaChipLabel: \{\s*\.\.\.t\.stamp,\s*color: color\.onInkMute,/]] });
add({ id: 'gemsFilter.area.selectedFill', fg: color.onInk, on: 'gemsFilterPhoto', kind: 'ui', at: [GEMS_FILTER, [FT.gemsFilter, /areaChipActive: \{\s*backgroundColor: color\.onInk,/]] });
add({ id: 'gemsFilter.area.labelActive', fg: color.ink, on: 'selected', kind: 'text', at: [[FT.gemsFilter, /areaChipActive: \{\s*backgroundColor: color\.onInk,/], [FT.gemsFilter, /areaChipLabelActive: \{\s*color: color\.ink,/]] });
add({ id: 'gemsFilter.area.spinner', fg: color.onInk, on: 'gemsFilterArea', kind: 'ui', at: [GEMS_FILTER, [FT.gemsFilter, '<ActivityIndicator size="small" color={color.onInk} style={styles.chipSpinner} />']] });
add({ id: 'gemsFilter.category.label', fg: color.onInkMute, on: 'gemsFilterCat', kind: 'text', at: [GEMS_FILTER, [FT.gemsFilter, /catChip: \{[^}]*backgroundColor: 'rgba\(255,255,255,0\.10\)'/], [FT.gemsFilter, /catChipLabel: \{\s*\.\.\.t\.small,\s*color: color\.onInkMute,/]] });
add({ id: 'gemsFilter.category.selectedFill', fg: color.signal, on: 'gemsFilterPhoto', kind: 'ui', at: [GEMS_FILTER, [FT.gemsFilter, /catChipActive: \{\s*backgroundColor: color\.signal,/]] });
add({ id: 'gemsFilter.category.labelActive', fg: color.ink, on: 'signalFill', kind: 'text', at: [[FT.gemsFilter, /catChipActive: \{\s*backgroundColor: color\.signal,/], [FT.gemsFilter, /catChipLabelActive: \{\s*color: color\.ink,/]] });
// GemsFeed — its loaders and empty/error copy sit on the ink ground.
const GEMS_EMPTY: Needle = [FT.gemsFeed, /emptyState: \{[^}]*backgroundColor: color\.ink,/];
add({ id: 'gemsFeed.empty.title', fg: color.onInk, on: 'ink', kind: 'text', at: [GEMS_EMPTY, [FT.gemsFeed, /emptyTitle: \{\s*\.\.\.t\.heading,\s*color: color\.onInk,/]] });
add({ id: 'gemsFeed.empty.body', fg: color.onInkMute, on: 'ink', kind: 'text', at: [GEMS_EMPTY, [FT.gemsFeed, /emptyBody: \{\s*\.\.\.t\.body,\s*color: color\.onInkMute,/]] });
add({ id: 'gemsFeed.loading', fg: color.onInk, on: 'ink', kind: 'ui', at: [[FT.gemsFeed, '<ActivityIndicator size="large" color={color.onInk} />'], [FT.gemsFeed, /container: \{\s*flex: 1,\s*backgroundColor: color\.ink,/]] });
// GridTile — badges and meta row on black backings (poster, or the haze cell), the processing overlay, the stamp's backing.
const GRID_BADGE: Needle = [FT.gridTile, /badge: \{[^}]*backgroundColor: 'rgba\(0,0,0,0\.55\)'/];
const GRID_META: Needle[] = [[FT.gridTile, "const SCRIM_BOTTOM = 'rgba(0,0,0,0.55)';"], [FT.gridTile, 'backgroundColor: SCRIM_BOTTOM']];
add({ id: 'gridTile.badge.photoFloor', fg: color.onInk, on: 'gridScrimPhoto', kind: 'text', at: [GRID_BADGE, [FT.gridTile, /badgeText: \{[^}]*color: color\.onInk,/]] });
add({ id: 'gridTile.badge.fallback', fg: color.onInk, on: 'gridScrimFallback', kind: 'text', at: [GRID_BADGE, [FT.gridTile, /cell: \{[^}]*backgroundColor: color\.haze,/]] });
add({ id: 'gridTile.meta.photoFloor', fg: color.onInk, on: 'gridScrimPhoto', kind: 'text', at: [...GRID_META, [FT.gridTile, /metaText: \{[^}]*color: color\.onInk,/]] });
add({ id: 'gridTile.meta.fallback', fg: color.onInk, on: 'gridScrimFallback', kind: 'text', at: [...GRID_META, [FT.gridTile, /cell: \{[^}]*backgroundColor: color\.haze,/]] });
add({ id: 'gridTile.badgeIcons', fg: color.onInk, on: 'gridScrimPhoto', kind: 'decor', at: [[FT.gridTile, '<MapPin size={8} color={color.onInk}'], [FT.gridTile, '<VideoIcon size={8} color={color.onInk}']] });
const GRID_PROCESSING: Needle = [FT.gridTile, /processingOverlay: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.65\)'/];
add({ id: 'gridTile.processing.photoFloor', fg: 'rgba(250,249,246,0.85)', on: 'gridProcessingPhoto', kind: 'text', at: [GRID_PROCESSING, [FT.gridTile, /processingText: \{[^}]*color: color\.onInk,[^}]*opacity: 0\.85,/]] });
add({ id: 'gridTile.processingSpinner.photoFloor', fg: color.onInk, on: 'gridProcessingPhoto', kind: 'ui', at: [GRID_PROCESSING, [FT.gridTile, '<ActivityIndicator size="small" color={color.onInk} />']] });
const GRID_STAMP: Needle[] = [[FT.gridTile, "zIndex: 6, borderRadius: 999, backgroundColor: 'rgba(17,17,15,0.80)',"], [FT.gridTile, /<StampButton[^>]*tone="onDark"/]];
add({ id: 'gridTile.stampButton.icon.idle.photoFloor', fg: color.onInk, on: 'gridStampPhoto', kind: 'ui', at: [...GRID_STAMP, STAMP_BUTTON_ICON] });
add({ id: 'gridTile.stampButton.icon.active.photoFloor', fg: color.signal, on: 'gridStampPhoto', kind: 'ui', at: [...GRID_STAMP, STAMP_BUTTON_ICON, STAMP_ICON_COLOUR] });
add({ id: 'gridTile.stampButton.count.active.photoFloor', fg: color.onInk, on: 'gridStampPhoto', kind: 'text', at: [...GRID_STAMP, STAMP_COUNT_TONE, STAMP_COUNT_ON_DARK] });
// FIXED by lane K (census-media §31.13): was pinned at 3.04, as viewer.stampButton.count.idle; the tile passes tone="onDark", and its disc drops from 0.95 to 0.80.
add({ id: 'gridTile.stampButton.count.idle.photoFloor', fg: color.onInk, on: 'gridStampPhoto', kind: 'text', at: [...GRID_STAMP, STAMP_COUNT_TONE, STAMP_COUNT_ON_DARK] });
// GridFilterBar, MasonryGrid, GridFeed — on paper.
add({ id: 'gridFilter.chip', fg: '#696660', on: 'haze', kind: 'text', at: [[FT.gridFilter, /chip: \{[^}]*backgroundColor: color\.haze,/], [FT.gridFilter, /chipText: \{\s*\.\.\.t\.small,\s*color: '#696660',/]] });
add({ id: 'gridFilter.chipActive', fg: color.onInk, on: 'ink', kind: 'text', at: [[FT.gridFilter, /chipActive: \{\s*backgroundColor: color\.ink,/], [FT.gridFilter, /chipTextActive: \{\s*color: color\.onInk,/]] });
add({ id: 'gridFilter.selectedFill', fg: color.ink, on: 'paper', kind: 'ui', at: [[FT.gridFilter, /wrapper: \{\s*backgroundColor: color\.paper,/], [FT.gridFilter, /chipActive: \{\s*backgroundColor: color\.ink,/]] });
add({ id: 'gridFilter.nearbyIcon', fg: color.mute, on: 'haze', kind: 'decor', at: [[FT.gridFilter, 'color={active ? color.paper : color.mute}']] });
add({ id: 'gridFilter.locationError', fg: color.mute, on: 'paper', kind: 'text', at: [[FT.gridFilter, /locationErrorText: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
add({ id: 'masonry.refresh', fg: color.signal, on: 'paper', kind: 'ui', at: [[FT.masonry, 'tintColor={color.signal}'], [FT.masonry, /scroll: \{\s*flex: 1,\s*backgroundColor: color\.paper,/]] });
const EMPTY_STATE: Needle[] = [[FT.gridFeed, '<EmptyState'], [FT.gridFeed, /container: \{\s*flex: 1,\s*backgroundColor: color\.paper,/]];
add({ id: 'gridFeed.emptyState.title', fg: color.ink, on: 'paper', kind: 'text', at: [...EMPTY_STATE, [FT.emptyState, /title: \{\s*\.\.\.typography\.sectionTitle,\s*color: color\.ink,/]] });
add({ id: 'gridFeed.emptyState.description', fg: color.mute, on: 'paper', kind: 'text', at: [...EMPTY_STATE, [FT.emptyState, /description: \{\s*\.\.\.typography\.body,\s*color: color\.mute,/]] });
// FIXED by lane K (census-media §31.13): was pinned at 3.14 (onInk on `signal`). The Grid's error state passes EmptyState's optional primaryAction.fill, the Media-local vermilion #C43B23.
add({ id: 'gridFeed.emptyState.retryButton', fg: color.onInk, on: 'vermilionOnPaper', kind: 'text', at: [...EMPTY_STATE, [FT.gridFeed, "primaryAction={{ label: 'Try again', onPress: loadFeed, fill: '#C43B23'"], [FT.emptyState, '[styles.btn, { backgroundColor: primaryAction.fill }, pressed && { opacity: layout.pressedOpacity }]'], [FT.emptyState, /btnText: \{\s*\.\.\.typography\.button,\s*color: color\.onInk,/]] });
// WatchRadialMenu — each arc button's fill darkened in its own hue until its white 8 px label reads 4.5:1.
const RADIAL_LABEL: Needle = [FT.radial, /arcLabel: \{[^}]*color: '#fff',/];
for (const [id, fill, on] of [['gem', '#8558EC', 'radialPurple'], ['route', '#D64127', 'radialSignal'], ['announce', '#0B7DB1', 'radialSky'], ['verify', '#0C875E', 'radialGreen']] as const) {
  add({ id: `radial.${id}.label`, fg: WHITE, on, kind: 'text', at: [[FT.radial, `bgColor: '${fill}',`], RADIAL_LABEL] });
  add({ id: `radial.${id}.icon`, fg: WHITE, on, kind: 'decor', at: [[FT.radial, `bgColor: '${fill}',`], [FT.radial, "{item.icon(18, '#fff')}"]] });
}
add({ id: 'radial.hub', fg: WHITE, on: 'radialBackdropPhoto', kind: 'decor', at: [[FT.radial, /hubInner: \{[^}]*backgroundColor: '#fff',/], [FT.radial, "backgroundColor: 'rgba(0,0,0,0.35)',"]] });
// StampItBurst — a transient celebration; decorative (1.4.3). Measured and printed, not asserted.
add({ id: 'burst.stampedLabel', fg: color.signal, on: 'burstPhoto', kind: 'decor', at: [[FT.burst, /stampLabel: \{[^}]*color: color\.signal,/], [FT.burst, "backgroundColor: 'rgba(255,60,60,0.12)',"]] });
// MediaMoreMenu, MediaQuickCreateSheet, RouteItPlaceSheet — paper sheets.
const MORE_SHEET: Needle = [FT.moreMenu, /sheet: \{[^}]*backgroundColor: color\.paper,/];
add({ id: 'moreMenu.title', fg: color.ink, on: 'paper', kind: 'text', at: [MORE_SHEET, [FT.moreMenu, /sheetTitle: \{\s*\.\.\.t\.heading,\s*color: color\.ink,/]] });
add({ id: 'moreMenu.row', fg: color.ink, on: 'paper', kind: 'text', at: [MORE_SHEET, [FT.moreMenu, /rowLabel: \{\s*\.\.\.t\.body,\s*color: color\.ink,/]] });
add({ id: 'moreMenu.rowDestructive', fg: '#C43B23', on: 'paper', kind: 'text', at: [MORE_SHEET, [FT.moreMenu, /rowLabelDestructive: \{\s*color: '#C43B23',/]] });
add({ id: 'moreMenu.close', fg: color.mute, on: 'paper', kind: 'ui', at: [MORE_SHEET, [FT.moreMenu, '<X size={20} color={color.mute}']] });
add({ id: 'moreMenu.rowIcons', fg: color.ink, on: 'paper', kind: 'decor', at: [[FT.moreMenu, 'const iconColor = color.ink;']] });
const QC_SHEET: Needle = [FT.quickCreate, /sheet: \{\s*backgroundColor: color\.paper,/];
add({ id: 'quickCreate.title', fg: color.ink, on: 'paper', kind: 'text', at: [QC_SHEET, [FT.quickCreate, /headerTitle: \{\s*\.\.\.t\.heading,\s*color: color\.ink,/]] });
add({ id: 'quickCreate.rowLabel', fg: color.ink, on: 'paper', kind: 'text', at: [QC_SHEET, [FT.quickCreate, /rowLabel: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.ink,/]] });
add({ id: 'quickCreate.rowSub', fg: color.mute, on: 'paper', kind: 'text', at: [QC_SHEET, [FT.quickCreate, /rowSub: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
add({ id: 'quickCreate.gemLabel', fg: '#065F46', on: 'quickCreateHighlight', kind: 'text', at: [[FT.quickCreate, "backgroundColor: '#10B98108',"], [FT.quickCreate, /rowLabelHighlight: \{\s*color: '#065F46',/]] });
add({ id: 'quickCreate.gemSub', fg: color.mute, on: 'quickCreateHighlight', kind: 'text', at: [[FT.quickCreate, "backgroundColor: '#10B98108',"], [FT.quickCreate, /rowSub: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
add({ id: 'quickCreate.close', fg: color.ink, on: 'paperRaised', kind: 'ui', at: [[FT.quickCreate, '<X size={18} color={color.ink} />'], [FT.quickCreate, /closeBtn: \{[^}]*backgroundColor: color\.paperRaised,/]] });
add({ id: 'quickCreate.entryIcons', fg: color.signal, on: 'paper', kind: 'decor', at: [[FT.quickCreate, '<IconComponent size={20} color={entry.iconColor} strokeWidth={1.8} />']] });
add({ id: 'routeIt.title', fg: color.ink, on: 'paper', kind: 'text', at: [[FT.routeIt, /title: \{\s*\.\.\.t\.heading,\s*color: color\.ink,/]] });
add({ id: 'routeIt.placeName', fg: color.ink, on: 'paperRaised', kind: 'text', at: [[FT.routeIt, /placeCard: \{[^}]*backgroundColor: color\.paperRaised,/], [FT.routeIt, /placeName: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.ink,/]] });
add({ id: 'routeIt.placeMeta', fg: color.mute, on: 'paperRaised', kind: 'text', at: [[FT.routeIt, /placeMeta: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
add({ id: 'routeIt.mapLabel', fg: color.deep, on: 'routeItMapThumb', kind: 'text', at: [[FT.routeIt, "backgroundColor: '#D6E8F0',"], [FT.routeIt, /mapThumbLabel: \{\s*\.\.\.t\.small,\s*color: color\.deep,/]] });
add({ id: 'routeIt.addToTrip', fg: color.onInk, on: 'vermilionOnPaper', kind: 'text', at: [[FT.routeIt, "backgroundColor: '#C43B23',"], [FT.routeIt, /addBtnText: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.onInk,/]] });
add({ id: 'routeIt.emptyTitle', fg: color.ink, on: 'paper', kind: 'text', at: [[FT.routeIt, /emptyTitle: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.ink,/]] });
add({ id: 'routeIt.emptyBody', fg: color.mute, on: 'paper', kind: 'text', at: [[FT.routeIt, /emptyBody: \{\s*\.\.\.t\.body,\s*color: color\.mute,/]] });
add({ id: 'routeIt.close', fg: color.ink, on: 'paperRaised', kind: 'ui', at: [[FT.routeIt, '<X size={18} color={color.ink} />']] });
// AddGemForm — the add-gem route's paper sheet.
const ADD_GEM_SHEET: Needle = [FT.addGemRoute, /sheet: \{\s*backgroundColor: color\.paper,/];
const VERMILION = '#C43B23';
const ADD_GEM_TEXT: ReadonlyArray<readonly [id: string, fg: string, on: SurfaceId, needle: Needle, surface?: Needle]> = [
  ['stepTitle', color.ink, 'paper', [FT.addGem, /stepTitle: \{\s*\.\.\.t\.heading,\s*color: color\.ink,/]],
  ['stepSubtitle', color.mute, 'paper', [FT.addGem, /stepSubtitle: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]],
  ['back', VERMILION, 'paper', [FT.addGem, /backBtnText: \{\s*\.\.\.t\.small,\s*color: '#C43B23',/]],
  ['description', color.mute, 'paper', [FT.addGem, /stepDescription: \{\s*\.\.\.t\.body,\s*color: color\.mute,/]],
  ['mediaPicker', color.mute, 'paperRaised', [FT.addGem, /mediaPickerBtnText: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]],
  ['hint', color.mute, 'paper', [FT.addGem, /hint: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]],
  ['label', color.mute, 'paper', [FT.addGem, /label: \{[^}]*color: color\.mute,/]],
  ['requiredMark', VERMILION, 'paper', [FT.addGem, /required: \{\s*color: '#C43B23',/]],
  ['input', color.ink, 'paperRaised', [FT.addGem, /input: \{\s*\.\.\.t\.body,\s*color: color\.ink,\s*backgroundColor: color\.paperRaised,/]],
  ['placeholder', color.mute, 'paperRaised', [FT.addGem, 'placeholderTextColor={color.mute}']],
  ['fieldError', VERMILION, 'paper', [FT.addGem, /fieldError: \{\s*\.\.\.t\.small,\s*color: '#C43B23',/]],
  ['placeButton', color.ink, 'paperRaised', [FT.addGem, /placeBtnText: \{[^}]*color: color\.ink,/]],
  ['placeButtonPlaceholder', color.mute, 'paperRaised', [FT.addGem, /placeBtnPlaceholder: \{\s*color: color\.mute,/]],
  ['chip', color.ink, 'paperRaised', [FT.addGem, /chipText: \{\s*\.\.\.t\.small,\s*color: color\.ink,/]],
  ['chipActive', WHITE, 'gemGreen', [FT.addGem, /chipTextActive: \{\s*color: '#fff',/], [FT.addGem, /chipActive: \{\s*backgroundColor: '#0C875E',/]],
  ['confirm', color.ink, 'paperRaised', [FT.addGem, /checkboxText: \{\s*\.\.\.t\.body,\s*color: color\.ink,/]],
  ['confirmError', VERMILION, 'errorTint', [FT.addGem, /checkboxTextError: \{\s*color: '#C43B23',/], [FT.addGem, /checkboxRowError: \{[^}]*backgroundColor: '#FEF2F2',/]],
  ['optionalSection', color.mute, 'paper', [FT.addGem, /optionalSection: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]],
  ['optionalBadge', color.mute, 'paper', [FT.addGem, /optionalBadge: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]],
  ['error', VERMILION, 'errorTint', [FT.addGem, /errorText: \{\s*\.\.\.t\.small,\s*color: '#C43B23',/], [FT.addGem, /errorBox: \{\s*backgroundColor: '#FEF2F2',/]],
  ['primaryButton', WHITE, 'gemGreen', [FT.addGem, /primaryBtnText: \{\s*\.\.\.t\.bodyStrong,\s*color: '#fff',/], [FT.addGem, /primaryBtn: \{\s*backgroundColor: '#0C875E',/]],
  ['centeredTitle', color.ink, 'paper', [FT.addGem, /centeredTitle: \{\s*\.\.\.t\.heading,\s*color: color\.ink,/]],
  ['centeredBody', color.mute, 'paper', [FT.addGem, /centeredBody: \{\s*\.\.\.t\.body,\s*color: color\.mute,/]],
  ['closeText', VERMILION, 'paper', [FT.addGem, /closeTextBtnLabel: \{\s*\.\.\.t\.bodyStrong,\s*color: '#C43B23',/]],
];
for (const [id, fg, on, needle, surface] of ADD_GEM_TEXT) add({ id: `addGem.${id}`, fg, on, kind: 'text', at: surface ? [ADD_GEM_SHEET, needle, surface] : [ADD_GEM_SHEET, needle] });
add({ id: 'addGem.chipSelectedFill', fg: '#0C875E', on: 'paper', kind: 'ui', at: [ADD_GEM_SHEET, [FT.addGem, /chipActive: \{\s*backgroundColor: '#0C875E',/]] });
add({ id: 'addGem.confirmChecked', fg: '#0C875E', on: 'paperRaised', kind: 'ui', at: [[FT.addGem, '<CheckSquare size={20} color="#0C875E" strokeWidth={2} />'], [FT.addGem, /checkboxRow: \{[^}]*backgroundColor: color\.paperRaised,/]] });
add({ id: 'addGem.confirmUnchecked', fg: color.mute, on: 'paperRaised', kind: 'ui', at: [[FT.addGem, '<Square size={20} color={errors.confirms ? color.signal : color.mute} strokeWidth={1.8} />']] });
add({ id: 'addGem.confirmUncheckedError', fg: color.signal, on: 'errorTint', kind: 'ui', at: [[FT.addGem, '<Square size={20} color={errors.confirms ? color.signal : color.mute} strokeWidth={1.8} />'], [FT.addGem, "backgroundColor: '#FEF2F2',"]] });
add({ id: 'addGem.spinner', fg: color.signal, on: 'paper', kind: 'ui', at: [[FT.addGem, '<ActivityIndicator size="large" color={color.signal} />']] });
add({ id: 'addGem.submitSpinner', fg: WHITE, on: 'gemGreen', kind: 'ui', at: [[FT.addGem, '<ActivityIndicator size="small" color="#fff" />'], [FT.addGem, /primaryBtn: \{\s*backgroundColor: '#0C875E',/]] });
add({ id: 'addGem.close', fg: color.ink, on: 'paperRaised', kind: 'ui', at: [[FT.addGem, '<X size={18} color={color.ink} />'], [FT.addGem, /closeBtn: \{[^}]*backgroundColor: color\.paperRaised,/]] });
const ADD_GEM_PREVIEW: Needle = [FT.addGem, /durationBadge: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.65\)'/];
add({ id: 'addGem.duration.photoFloor', fg: WHITE, on: 'addGemBadgePhoto', kind: 'text', at: [ADD_GEM_PREVIEW, [FT.addGem, /durationText: \{[^}]*color: '#fff',/]] });
add({ id: 'addGem.removeMedia.photoFloor', fg: WHITE, on: 'addGemBadgePhoto', kind: 'ui', at: [[FT.addGem, /mediaRemoveBtn: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.65\)'/], [FT.addGem, '<X size={14} color="#fff" />']] });
add({ id: 'addGem.submitDisabled', fg: 'rgba(255,255,255,0.4)', on: 'gemGreen', kind: 'decor', at: [[FT.addGem, /btnDisabled: \{\s*opacity: 0\.4,/]] });
// The tab route — its floating buttons and the World pill.
add({ id: 'tab.fab.icon', fg: WHITE, on: 'signalFill', kind: 'ui', at: [[FT.tab, /fab: \{[^}]*backgroundColor: color\.signal,/], [FT.tab, '<Camera size={22} color="#fff"']] });
add({ id: 'tab.fabGems.icon', fg: WHITE, on: 'gemGreen', kind: 'ui', at: [[FT.tab, /fabGems: \{[^}]*backgroundColor: '#0C875E',/], [FT.tab, '<Gem size={22} color="#fff"']] });
add({ id: 'tab.worldPill.photoFloor', fg: WHITE, on: 'worldPillPhoto', kind: 'text', at: [[FT.tab, "backgroundColor: 'rgba(17,17,15,0.58)',"], [FT.tab, "<Text style={[styles.worldEntryText, { color: isImmersive ? '#fff' : color.ink }]}>World</Text>"]] });
add({ id: 'tab.worldPill.light', fg: color.ink, on: 'paperRaised', kind: 'text', at: [[FT.tab, /worldEntryBtnLight: \{\s*backgroundColor: color\.paperRaised,/], [FT.tab, "<Text style={[styles.worldEntryText, { color: isImmersive ? '#fff' : color.ink }]}>World</Text>"]] });
add({ id: 'tab.gridCreate.icon', fg: color.ink, on: 'paperRaised', kind: 'ui', at: [[FT.tab, /gridCreateBtn: \{[^}]*backgroundColor: color\.paperRaised,/], [FT.tab, '<Camera size={18} color={color.ink}']] });
// FIXED by lane K (census-media §31.13): was pinned at 1.99 (#fff on the header's 0.28 black tint over the frame). The tab passes AppHeader's optional overlayTint, an ink tint at 0.58.
add({ id: 'tab.appHeaderOverlay.title.photoFloor', fg: WHITE, on: 'appHeaderOverlayPhoto', kind: 'text', at: [[FT.tab, 'variant="overlay" overlayTint="rgba(17,17,15,0.58)"'], [FT.appHeader, 'backgroundColor: overlayTint !== undefined && !transparent ? overlayTint : overlayBg'], [FT.appHeader, "{centeredTitle('#fff')}"]] });

// Measure every pair added since MEASURED was first built.
MEASURED.push(...PAIRS.slice(MEASURED.length).map(measurePair));

test('census-media §31.12: every pair, the tail\'s included, is measured', () => {
  assert.equal(MEASURED.length, PAIRS.length);
  assert.deepEqual(MEASURED.map((m) => m.pair.id), PAIRS.map((p) => p.id));
  assert.ok(PAIRS.length >= 500, `expected >= 500 pairs, got ${PAIRS.length}`);
});

test('census-media §31.12: every file the tail lists is cited by a pair', () => {
  const cited = new Set(PAIRS.flatMap((p) => p.at.map(([file]) => file)));
  for (const file of Object.values(FT)) assert.ok(cited.has(file), `${file} is listed but no pair cites it`);
});

test('census-media §31.12: a pinned pair names the shared file that blocks its fix', () => {
  const unblocked = PAIRS.filter((p) => p.finding !== undefined && !p.at.some(([file]) => SHARED_BLOCKERS.includes(file))).map((p) => p.id);
  assert.deepEqual(unblocked, [], 'a failure inside Media\'s own files must be fixed, not pinned');
});

test('dynamic type (the shipped Media tab): no Text opts out of, or caps, OS font scaling', () => {
  const files: string[] = [];
  walk('src/components/media', files);
  files.push(FT.tab, FT.addGemRoute, FT.mediaViewer); // §31.13: the Grid's full-screen viewer too
  let textElements = 0;
  const offenders: string[] = [];
  for (const file of files) {
    const text = source(file);
    textElements += (text.match(/<Text\b/g) ?? []).length;
    if (/allowFontScaling\s*=\s*\{\s*false\s*\}/.test(text)) offenders.push(`${file}: allowFontScaling={false}`);
    if (/maxFontSizeMultiplier/.test(text)) offenders.push(`${file}: maxFontSizeMultiplier`);
  }
  assert.ok(files.length >= 20, `scanned ${files.length} files`);
  assert.ok(textElements >= 80, `found ${textElements} <Text elements`);
  assert.deepEqual(offenders, []);
});

// ═══ census-media §31.13 — appended at the TAIL so no line cited above moves ═══
//
// Lane K's third pass:
//   1. Unpins the five pairs above (StampButton ×3, EmptyState, AppHeader). Each
//      shared component gains an OPTIONAL prop that Media passes; with the prop
//      absent it renders exactly as before, so no other caller changes.
//   2. Measures the Grid's full-screen viewer, app/media-viewer/[id].tsx, under
//      the same rules, and fixes it in that file (backings and badges) and
//      through StampButton's tone.
//   3. Records the EmptyState icon as `decor` (the title beside it names it).
// The shared sheets opened from Media (CommentsSheet, ShareSheet, — SUPERSEDED by census-media §33: the owner ruled H7 YES on 2026-09-27, and they are measured at the tail —
// GlobalPlacePicker, CreationAssist, PlanPickerController) are not pairs here:
// census-media §31.13 records their measurement and the ruling that §46 does
// not govern them, with the spec text. (That was the case §31.13.6 put to the owner, not a ruling; the owner ruled the other way.)

const MV = FT.mediaViewer;
add({ id: 'gridFeed.emptyState.icon', fg: color.faint, on: 'paper', kind: 'decor', at: [...EMPTY_STATE, [FT.emptyState, '<Icon size={36} color={color.faint} strokeWidth={1.5} />']] });

// ─ The Grid's full-screen viewer ─
// Top bar: the back and mute buttons sit on their own 0.55 ink discs (unchanged; they clear).
const MV_TOP: Needle = [MV, /iconBtn: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.55\)'/];
add({ id: 'mediaViewer.back.photoFloor', fg: WHITE, on: 'mvTopButtonPhoto', kind: 'ui', at: [MV_TOP, [MV, '<ChevronLeft size={22} color="#fff" strokeWidth={2.5} />']] });
add({ id: 'mediaViewer.mute.photoFloor', fg: WHITE, on: 'mvTopButtonPhoto', kind: 'ui', at: [MV_TOP, [MV, '? <VolumeX size={18} color="#fff" />'], [MV, ': <Volume2 size={18} color="#fff" />']] });
// Left column: now on a 0.71 ink backing (was straight on the frame under a gradient: every line floored at 1.00).
const MV_LEFT: Needle = [MV, /leftCol: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.71\)'/];
const MV_CHIP: Needle = [MV, /placeChip: \{[^}]*backgroundColor: 'rgba\(255,255,255,0\.12\)'/];
add({ id: 'mediaViewer.authorName.photoFloor', fg: color.onInk, on: 'mvLeftPhoto', kind: 'text', at: [MV_LEFT, [MV, /authorName: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.onInk,/]] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.authorHandle.photoFloor', fg: color.onInkMute, on: 'mvLeftPhoto', kind: 'text', at: [MV_LEFT, [MV, /authorHandle: \{\s*\.\.\.t\.stamp,\s*color: color\.onInkMute,/]] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.caption.photoFloor', fg: color.onInk, on: 'mvLeftPhoto', kind: 'text', at: [MV_LEFT, [MV, /caption: \{\s*\.\.\.t\.body,\s*color: color\.onInk,/]] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.placeText.photoFloor', fg: W_('0.9'), on: 'mvLeftChip', kind: 'text', at: [MV_LEFT, MV_CHIP, [MV, /placeText: \{\s*\.\.\.t\.stamp,\s*color: 'rgba\(255,255,255,0\.9\)',/]] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.placePin', fg: W_('0.85'), on: 'mvLeftChip', kind: 'decor', at: [MV_CHIP, [MV, '<MapPin size={10} color="rgba(255,255,255,0.85)" />']] });
add({ id: 'mediaViewer.placeQuickActions.photoFloor', fg: W_('0.92'), on: 'mvLeftChip', kind: 'text', at: [MV_LEFT, [MV, 'variant="dark"'], ...QUICK_ACTIONS_DARK] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.locationStamp.name.photoFloor', fg: '#E8DFC8', on: 'locationStampPhoto', kind: 'text', at: [...LOCATION_STAMP, [MV, '<VerifiedLocationStamp locationName={locationName} />']] });
add({ id: 'mediaViewer.loading.photoFloor', fg: W_('0.5'), on: 'mvLeftPhoto', kind: 'ui', at: [MV_LEFT, [MV, '<ActivityIndicator size="small" color="rgba(255,255,255,0.5)" />']] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.avatarRing', fg: W_('0.6'), on: 'mvLeftPhoto', kind: 'decor', at: [[MV, /avatarRing: \{[^}]*borderColor: 'rgba\(255,255,255,0\.6\)'/]] });
// Right column: now on a 0.80 ink backing (was straight on the frame: every icon and count floored at 1.00).
const MV_RIGHT: Needle = [MV, /rightCol: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.80\)'/];
const MV_STAMP: Needle = [MV, /<StampButton[^>]*tone="onDark"/];
add({ id: 'mediaViewer.stampButton.icon.idle.photoFloor', fg: color.onInk, on: 'mvRightPhoto', kind: 'ui', at: [MV_RIGHT, MV_STAMP, STAMP_BUTTON_ICON] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.stampButton.icon.active.photoFloor', fg: color.signal, on: 'mvRightPhoto', kind: 'ui', at: [MV_RIGHT, MV_STAMP, STAMP_BUTTON_ICON, STAMP_ICON_COLOUR] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.stampButton.count.idle.photoFloor', fg: color.onInk, on: 'mvRightPhoto', kind: 'text', at: [MV_RIGHT, MV_STAMP, STAMP_COUNT_TONE, STAMP_COUNT_ON_DARK] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.stampButton.count.active.photoFloor', fg: color.onInk, on: 'mvRightPhoto', kind: 'text', at: [MV_RIGHT, MV_STAMP, STAMP_COUNT_TONE, STAMP_COUNT_ON_DARK] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.comment.photoFloor', fg: WHITE, on: 'mvRightPhoto', kind: 'ui', at: [MV_RIGHT, [MV, '<MessageCircle size={28} color="#fff" strokeWidth={1.8} />']] }); // FIXED by lane K (census-media §31.13)
const MV_BOOKMARK: Needle = [MV, "<Bookmark size={28} color={isSaved ? color.signal : '#fff'} fill={isSaved ? color.signal : 'transparent'}"];
add({ id: 'mediaViewer.save.idle.photoFloor', fg: WHITE, on: 'mvRightPhoto', kind: 'ui', at: [MV_RIGHT, MV_BOOKMARK] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.save.saved.photoFloor', fg: color.signal, on: 'mvRightPhoto', kind: 'ui', at: [MV_RIGHT, MV_BOOKMARK] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.counts.photoFloor', fg: color.onInk, on: 'mvRightPhoto', kind: 'text', at: [MV_RIGHT, [MV, /actionCount: \{\s*\.\.\.t\.stamp,\s*color: color\.onInk,/]] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.creatorStamps.photoFloor', fg: 'rgba(255,220,80,0.9)', on: 'mvRightPhoto', kind: 'ui', at: [MV_RIGHT, [MV, '<Zap size={26} color="rgba(255,220,80,0.9)"']] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.share.photoFloor', fg: WHITE, on: 'mvRightPhoto', kind: 'ui', at: [MV_RIGHT, [MV, '<PortavaShareIcon size={26} color="#fff" />']] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.actions.photoFloor', fg: WHITE, on: 'mvRightPhoto', kind: 'ui', at: [MV_RIGHT, [MV, '<Compass size={28} color="#fff" strokeWidth={1.8} />']] }); // FIXED by lane K (census-media §31.13)
// The page: the loading spinner on a badge over the poster, the page dots on a pill over the frame.
add({ id: 'mediaViewer.pageSpinner.photoFloor', fg: color.onInk, on: 'mvSpinnerPhoto', kind: 'ui', at: [[MV, '<View style={tailStyles.spinnerBadge}><ActivityIndicator size="large" color={color.onInk} /></View>'], [MV, "spinnerBadge: { padding: 10, borderRadius: 999, backgroundColor: 'rgba(17,17,15,0.47)' },"]] }); // FIXED by lane K (census-media §31.13)
const MV_DOTS: Needle[] = [[MV, '<View style={tailStyles.dotsPill}>{items.map((_, i) => ('], [MV, /dotsPill: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.87\)'/]];
add({ id: 'mediaViewer.pageDot.active.photoFloor', fg: WHITE, on: 'mvDotsPhoto', kind: 'ui', at: [...MV_DOTS, [MV, /dotActive: \{\s*backgroundColor: '#fff',/]] }); // FIXED by lane K (census-media §31.13)
add({ id: 'mediaViewer.pageDot.inactive.photoFloor', fg: W_('0.35'), on: 'mvDotsPhoto', kind: 'ui', at: [...MV_DOTS, [MV, /dot: \{[^}]*backgroundColor: 'rgba\(255,255,255,0\.35\)'/]] }); // FIXED by lane K (census-media §31.13)
// The "Media not available" state, on the ink screen.
add({ id: 'mediaViewer.unavailable.text', fg: W_('0.45'), on: 'ink', kind: 'text', at: [[MV, /errText: \{\s*color: 'rgba\(255,255,255,0\.45\)',/], [MV, /screen: \{\s*flex: 1,\s*backgroundColor: color\.ink,/]] });
add({ id: 'mediaViewer.unavailable.close', fg: color.onInk, on: 'mvCloseOnInk', kind: 'ui', at: [[MV, '<X size={20} color={color.onInk} strokeWidth={2.5} />'], [MV, /closeBtnInner: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.6\)'/]] });

// ─ Shared components drawn inside Media's own layouts that no pass had measured ─
// The image-error fallback. CachedImage and DisplayMediaImage draw MediaFallback when an image
// fails: a box with the caption "Image unavailable" in paper on `haze` (1.19:1). Each Media site
// that shows the caption now passes a `mute` ground (CachedImage's optional fallbackBg, §31.13;
// DisplayMediaImage already had one). Sites that pass fallbackLabel="" show no caption.
const FALLBACK_CAPTION: Needle[] = [[FT.mediaFallback, "label: { ...t.small, color: color.paper, fontWeight: '600'"], [FT.mediaFallback, 'bg ? { backgroundColor: bg } : undefined']];
const CACHED_BG: Needle = [FT.cachedImage, '{...(fallbackBg !== undefined ? { bg: fallbackBg } : {})}'];
for (const [id, file, line] of [
  ['world.gemCard', F.gemCard, '<CachedImage source={{ uri: gem.imageUrl }} style={styles.tileImg} resizeMode="cover" fallbackBg={color.mute} />'],
  ['world.changingNow', F.changing, '<CachedImage source={{ uri: hero.thumbnailUrl }} style={styles.heroImg} resizeMode="cover" fallbackBg={color.mute} />'],
  ['world.contribution', F.contribution, '<CachedImage source={{ uri: draft.media.uri }} style={styles.preview} resizeMode="cover" fallbackBg={color.mute} />'],
  ['world.perspectiveTile', F.tile, '<CachedImage source={{ uri: media.thumbnailUrl }} style={styles.img} resizeMode="cover" fallbackBg={color.mute} />'],
  ['world.experienceMosaic', F.expMosaic, '<CachedImage source={{ uri: m.thumbnailUrl }} style={styles.heroImg} resizeMode="cover" fallbackBg={color.mute} />'],
  ['world.people', F.people, '<CachedImage source={{ uri: c.avatarUrl }} style={styles.avatar} resizeMode="cover" fallbackBg={color.mute} />'],
  ['mediaViewer', MV, '<CachedImage source={{ uri: mediaUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" fallbackBg={color.mute} />'],
] as const) {
  add({ id: `${id}.imageFallback.caption`, fg: color.paper, on: 'mediaFallbackGround', kind: 'text', at: [[file, line], CACHED_BG, ...FALLBACK_CAPTION] }); // FIXED by lane K (census-media §31.13): was 1.19 (paper on haze)
}
add({ id: 'gridTile.imageFallback.caption', fg: color.paper, on: 'mediaFallbackGround', kind: 'text', at: [[FT.gridTile, 'resizeMode="cover" fallbackBg={color.mute}'], [FT.mediaFallback, 'bg={fallbackBg}'], ...FALLBACK_CAPTION] }); // FIXED by lane K (census-media §31.13): was 1.19
add({ id: 'imageFallback.dot', fg: 'rgba(250,249,246,0.6)', on: 'mediaFallbackGround', kind: 'decor', at: [[FT.mediaFallback, 'backgroundColor: color.paper, opacity: 0.6 }']] });
// Avatar: with no photo, initials in ink on a `haze` disc (its own ground). The name beside it is the label.
const AVATAR_INITIALS: Needle[] = [[FT.avatar, "initial: { ...t.small, fontWeight: '700', color: color.ink },"], [FT.avatar, /fallback: \{\s*backgroundColor: color\.haze,/]];
for (const [id, file] of [['watch', FT.watchOverlay], ['gems', FT.gemsOverlay], ['viewer', F.viewer], ['mediaViewer', MV]] as const) {
  add({ id: `${id}.avatar.initials`, fg: color.ink, on: 'haze', kind: 'text', at: [[file, '<Avatar'], ...AVATAR_INITIALS] });
}
// GemContributeSection, inside the action rail's "Update this gem" panel: its own navy card.
const GEM_CARD: Needle = [FT.gemContribute, "backgroundColor: '#13213A',"];
add({ id: 'railPanel.gemContribute.title', fg: '#E8F0FE', on: 'gemContributeCard', kind: 'text', at: [[F.actionPanels, '<GemContributeSection'], GEM_CARD, [FT.gemContribute, "color: '#E8F0FE',"]] });
add({ id: 'railPanel.gemContribute.subtitle', fg: '#8A9BB5', on: 'gemContributeCard', kind: 'text', at: [GEM_CARD, [FT.gemContribute, /subtitle: \{[^}]*color: '#8A9BB5',/]] });
add({ id: 'railPanel.gemContribute.signedOut', fg: '#8A9BB5', on: 'gemContributeCard', kind: 'text', at: [GEM_CARD, [FT.gemContribute, /signedOutText: \{[^}]*color: '#8A9BB5',/]] });
for (const [tone, fg, done] of [['positive', '#6FD39A', 'gemContributeDoneGreen'], ['neutral', '#9DB8E8', 'gemContributeDoneBlue'], ['caution', '#E8B24D', 'gemContributeDoneAmber']] as const) {
  const toneNeedle: Needle = [FT.gemContribute, `${tone}: '${fg}',`];
  add({ id: `railPanel.gemContribute.chip.${tone}`, fg, on: 'gemContributeCard', kind: 'text', at: [GEM_CARD, toneNeedle, [FT.gemContribute, '<Text style={[styles.chipText, { color: fg }]}>']] });
  add({ id: `railPanel.gemContribute.chip.${tone}.done`, fg, on: done, kind: 'text', at: [GEM_CARD, toneNeedle, [FT.gemContribute, 'isDoneThis && { backgroundColor: `${fg}22`']] });
  add({ id: `railPanel.gemContribute.spinner.${tone}`, fg, on: 'gemContributeCard', kind: 'ui', at: [GEM_CARD, toneNeedle, [FT.gemContribute, '<ActivityIndicator size="small" color={fg} />']] });
}
add({ id: 'railPanel.gemContribute.feedback', fg: '#6FD39A', on: 'gemContributeCard', kind: 'text', at: [GEM_CARD, [FT.gemContribute, /feedback: \{[^}]*color: '#6FD39A',/]] });
add({ id: 'railPanel.gemContribute.error', fg: '#FF6B6B', on: 'gemContributeCard', kind: 'text', at: [GEM_CARD, [FT.gemContribute, /feedbackError: \{[^}]*color: '#FF6B6B',/]] });

// ─ Lane K pass 4 (census-media §31.13) ─
// The gems rail's comment and save controls were colour emoji (💬, 🔖/🏷), whose colours come from
// the platform font and could not be measured. They are now lucide glyphs in source colours, as on
// the Watch rail and the Grid viewer: comment and idle save in onInk, saved a filled `signal` bookmark.
const GEMS_ICON: Needle = [FT.gemsOverlay, '{icon ?? <Text style={[styles.actionBtnIcon, active && styles.actionBtnIconActive]}>'];
const GEMS_BOOKMARK: Needle = [FT.gemsOverlay, "icon={<Bookmark size={26} color={(isSaved ?? item.viewerState.hasSaved) ? color.signal : color.onInk} fill={(isSaved ?? item.viewerState.hasSaved) ? color.signal : 'transparent'}"];
add({ id: 'gems.rail.comment.icon', fg: color.onInk, on: 'gemsRailPhoto', kind: 'ui', at: [GEMS_RAIL, GEMS_ICON, [FT.gemsOverlay, 'icon={<MessageCircle size={26} color={color.onInk} strokeWidth={1.8} />}']] }); // FIXED by lane K (census-media §31.13): was an unmeasurable emoji
add({ id: 'gems.rail.save.idle', fg: color.onInk, on: 'gemsRailPhoto', kind: 'ui', at: [GEMS_RAIL, GEMS_ICON, GEMS_BOOKMARK] }); // FIXED by lane K (census-media §31.13): was an unmeasurable emoji
add({ id: 'gems.rail.save.saved', fg: color.signal, on: 'gemsRailPhoto', kind: 'ui', at: [GEMS_RAIL, GEMS_ICON, GEMS_BOOKMARK] }); // FIXED by lane K (census-media §31.13): was an unmeasurable emoji swap
// CreationAssist, inline in the add-gem sheet on its `paperRaised` card. The sheet passes
// quietColor={color.mute}; CreationAssist hands it to CorrectionBanner (dismissColor) and to
// EntitySuggestionRow (reasonColor). The banner's accept button is not drawn here (no accept handler).
const ASSIST: Needle = [FT.addGem, 'onPickExisting={pickExistingGem} quietColor={color.mute}'];
const ASSIST_CARD: Needle = [FT.creationAssist, /dupCard: \{[^}]*backgroundColor: color\.paperRaised,/];
const BANNER: Needle = [FT.correctionBanner, /banner: \{[^}]*backgroundColor: color\.paperRaised,/];
const BANNER_ACCENT: Needle = [FT.correctionBanner, "const accent = tone === 'error' ? color.signal : color.warn;"];
add({ id: 'addGem.creationAssist.bannerDismiss', fg: color.mute, on: 'paperRaised', kind: 'ui', at: [ASSIST, BANNER, [FT.creationAssist, '{...(quietColor !== undefined ? { dismissColor: quietColor } : {})}'], [FT.correctionBanner, 'color={dismissColor ?? color.faint}']] }); // FIXED by lane K (census-media §31.13): was `faint`, 2.88
add({ id: 'addGem.creationAssist.duplicateReason', fg: color.mute, on: 'paperRaised', kind: 'text', at: [ASSIST, ASSIST_CARD, [FT.creationAssist, '{...(quietColor !== undefined ? { reasonColor: quietColor } : {})}'], [FT.entityRow, '[styles.reason, { color: reasonColor }]']] }); // FIXED by lane K (census-media §31.13): was `faint`, 2.88
add({ id: 'addGem.creationAssist.bannerMessage', fg: color.ink, on: 'paperRaised', kind: 'text', at: [ASSIST, BANNER, [FT.correctionBanner, /message: \{[^}]*color: color\.ink,/]] });
add({ id: 'addGem.creationAssist.bannerBorder.warning', fg: color.warn, on: 'paperRaised', kind: 'ui', at: [ASSIST, BANNER, BANNER_ACCENT, [FT.correctionBanner, 'style={[styles.banner, { borderColor: accent }]}']] });
add({ id: 'addGem.creationAssist.bannerBorder.error', fg: color.signal, on: 'paperRaised', kind: 'ui', at: [ASSIST, BANNER, BANNER_ACCENT, [FT.correctionBanner, 'style={[styles.banner, { borderColor: accent }]}']] });
add({ id: 'addGem.creationAssist.bannerIcon', fg: color.warn, on: 'paperRaised', kind: 'decor', at: [BANNER_ACCENT, [FT.correctionBanner, '<AlertCircle size={iconToken.s16} color={accent} />']] });
add({ id: 'addGem.creationAssist.header', fg: color.deep, on: 'paperRaised', kind: 'text', at: [ASSIST, ASSIST_CARD, [FT.creationAssist, /dupHeaderText: \{[^}]*color: color\.deep,/]] });
add({ id: 'addGem.creationAssist.headerIcon', fg: color.deep, on: 'paperRaised', kind: 'decor', at: [ASSIST_CARD, [FT.creationAssist, '<Copy size={iconToken.s16} color={color.deep} />']] });
add({ id: 'addGem.creationAssist.seeAll', fg: color.deep, on: 'paperRaised', kind: 'text', at: [ASSIST, ASSIST_CARD, [FT.creationAssist, /dupActionText: \{[^}]*color: color\.deep,/]] });
add({ id: 'addGem.creationAssist.keepCreating', fg: color.mute, on: 'paperRaised', kind: 'text', at: [ASSIST, ASSIST_CARD, [FT.creationAssist, /dupDismissText: \{[^}]*color: color\.mute,/]] });
add({ id: 'addGem.creationAssist.rowTitle', fg: color.ink, on: 'paperRaised', kind: 'text', at: [ASSIST, ASSIST_CARD, [FT.entityRow, /title: \{[^}]*color: color\.ink,/]] });
add({ id: 'addGem.creationAssist.rowSubtitle', fg: color.mute, on: 'paperRaised', kind: 'text', at: [ASSIST, ASSIST_CARD, [FT.entityRow, /subtitle: \{[^}]*color: color\.mute,/]] });
add({ id: 'addGem.creationAssist.rowBadge', fg: color.deep, on: 'paper', kind: 'text', at: [ASSIST, [FT.entityRow, /badge: \{[^}]*backgroundColor: color\.paper,/], [FT.entityRow, /badgeText: \{[^}]*color: color\.deep,/]] });
add({ id: 'addGem.creationAssist.rowFresh', fg: color.deep, on: 'paper', kind: 'text', at: [ASSIST, [FT.entityRow, /freshBadge: \{[^}]*backgroundColor: color\.paper,/], [FT.entityRow, /freshText: \{[^}]*color: color\.deep,/]] });
add({ id: 'addGem.creationAssist.rowIcon', fg: color.deep, on: 'paper', kind: 'decor', at: [[FT.entityRow, '<EntityIcon entityType={suggestion.entityType} tint={color.deep} />']] });

// Measure every pair added since the last push.
MEASURED.push(...PAIRS.slice(MEASURED.length).map(measurePair));

test('census-media §31.13: no pair is pinned, and every StampButton on a Media surface passes the dark tone', () => {
  assert.deepEqual(PAIRS.filter((p) => p.finding !== undefined).map((p) => p.id), []);
  // All four sit on a dark backing, where the default `mute` count cannot reach 4.5:1.
  const callers: string[] = [F.viewer, FT.gemsOverlay, FT.gridTile, MV];
  for (const file of callers) {
    const calls = source(file).match(/<StampButton\b[^>]*/g) ?? [];
    assert.equal(calls.length, 1, `${file}: expected one StampButton`);
    assert.match(calls[0], /tone="onDark"/, `${file}: a StampButton on a dark backing must pass tone="onDark"`);
  }
  const shipped: string[] = [];
  walk('src/components/media', shipped);
  const unlisted = shipped.filter((f) => /<StampButton\b/.test(source(f)) && !callers.includes(f));
  assert.deepEqual(unlisted, [], 'a new StampButton on a Media surface must be measured and given the tone its ground needs');
});

// ═══ census-media §33 (lane T, H7) — appended at the TAIL so no line cited above moves ═══
//
// The owner ruled H7 YES on 2026-09-27: "Include comments, share, place picker,
// and plan picker in Media's contrast requirement." The four shared sheets, and
// the DisambiguationSheet that CreationAssist opens from the add-gem sheet, are
// now MEASURED surfaces: every text and state pair they paint as they render
// when opened from Media, including the shared components drawn inside their
// own layouts, asserted like every pair above (same helpers, thresholds,
// needles and `decor` rules; no large-text relief).
//
// The pairs live in src/theme/__tests__/sharedSheetContrast.pairs.ts, because
// the design-system regression guard reads the same list: the fix is in the
// design system (tokens.signalStrong and tokens.muteStrong, and the shared
// components moved onto them or onto mute), not in Media's files, and that
// guard measures every other consumer of each change before and after.
// OS-drawn UI the sheets hand off to (Alert dialogs, the OS share sheet, the
// native date and time picker) is not in the source and is not paired.
import { MEDIA_SHEET_PAIRS, SF, SHEET_SURFACES, NESTED_SURFACES, SF_NESTED } from '../../../theme/__tests__/sharedSheetContrast.pairs.ts';

for (const p of MEDIA_SHEET_PAIRS) add({ id: `sheets.${p.id}`, fg: p.fg, on: p.on, kind: p.kind, at: p.at });

// Measure every pair added since the last push.
MEASURED.push(...PAIRS.slice(MEASURED.length).map(measurePair));

/** The five sheets and every file they draw from, less the token module (read through `color`). */
const SHEET_FILES: readonly string[] = Object.values(SF).filter((f) => f !== SF.tokens);

test('census-media §33: the shared sheets Media opens are measured surfaces, and every file they draw from is cited', () => {
  const sheet = MEASURED.filter((m) => m.pair.id.startsWith('sheets.'));
  assert.equal(sheet.length, MEDIA_SHEET_PAIRS.length, 'every sheet pair is measured');
  assert.ok(sheet.length >= 150, `expected >= 150 sheet pairs, got ${sheet.length}`);
  // Each of the five is reached from a Media surface, and the needle says where.
  for (const opener of ['src/components/media/MediaCommentSheet.tsx', 'src/components/media/AddGemForm.tsx', 'src/features/media/components/MediaActionRail.tsx', 'src/platform/input-assistance/creation/CreationAssist.tsx']) {
    assert.ok(sheet.some((m) => m.pair.at.some(([file]) => file === opener)), `${opener}: no pair says the sheet is opened from here`);
  }
  assert.ok(source('src/components/media/WatchItemOverlay.tsx').includes('<ShareSheet'), 'Watch opens the ShareSheet');
  assert.ok(source('src/features/media/components/MediaActionPanels.tsx').includes('<ShareSheet'), 'the World shell opens the ShareSheet');
  const cited = new Set(sheet.flatMap((m) => m.pair.at.map(([file]) => file)));
  for (const file of SHEET_FILES) assert.ok(cited.has(file), `${file} is listed but no pair cites it`);
  // Asserted, not pinned: every non-decor sheet pair meets its bar (the AA test above covers them too).
  assert.deepEqual(sheet.filter((m) => m.pair.finding !== undefined).map((m) => m.pair.id), []);
  assert.deepEqual(sheet.filter((m) => m.threshold !== null && m.ratio < m.threshold).map((m) => `${m.pair.id}: ${m.ratio.toFixed(2)}`), []);
});

test('census-media §33: dynamic type — no Text in the shared sheets opts out of, or caps, OS font scaling', () => {
  // Avatar's monogram opts out of scaling so it cannot overflow its disc: Avatar's own app-wide
  // choice, recorded in §31.13.5 item 2; the name beside it scales. It is the only exception.
  const files = SHEET_FILES.filter((f) => f !== SF.avatar);
  let textElements = 0;
  const offenders: string[] = [];
  for (const file of files) {
    const text = source(file);
    textElements += (text.match(/<Text\b/g) ?? []).length;
    if (/allowFontScaling\s*=\s*\{\s*false\s*\}/.test(text)) offenders.push(`${file}: allowFontScaling={false}`);
    if (/maxFontSizeMultiplier/.test(text)) offenders.push(`${file}: maxFontSizeMultiplier`);
  }
  assert.ok(files.length >= 15, `scanned ${files.length} files`);
  assert.ok(textElements >= 100, `found ${textElements} <Text elements`);
  assert.deepEqual(offenders, []);
});

// ═══ census-media §33.13 — the nested sheets, appended at the TAIL ═══
// The four sheets the comment sheet opens from inside itself, and what ReportSheet opens for a
// safety photo, are Media-flow surfaces under H7 (the owner: "Shared ownership does not exclude a
// surface users encounter in the Media flow"). Their pairs are in the same fixture and were added
// to MEDIA_SHEET_PAIRS before this module evaluated, so the loop above measured them; this block
// checks that they are there, that their files are cited, and that none of their Text caps scaling.
const NESTED_PREFIXES = ['sheets.tagPreview.', 'sheets.profilePreview.', 'sheets.likers.', 'sheets.report.'] as const;
const NESTED_FILES: readonly string[] = Object.values(SF_NESTED);

test('census-media §33.13: the nested sheets the comment sheet opens are measured surfaces, and every file they draw from is cited', () => {
  const nested = MEASURED.filter((m) => NESTED_PREFIXES.some((p) => m.pair.id.startsWith(p)));
  for (const p of NESTED_PREFIXES) assert.ok(nested.some((m) => m.pair.id.startsWith(p)), `no pair measures ${p}`);
  assert.ok(nested.length >= 90, `expected >= 90 nested-sheet pairs, got ${nested.length}`);
  // Each is opened from inside the comment sheet, and the needle says where.
  for (const [opener, needle] of [
    ['src/components/CommentsSheet.tsx', '<ProfilePreviewCard'],
    ['src/components/CommentsSheet.tsx', '<EngagementUserListSheet'],
    ['src/components/CommentsSheet.tsx', '<ReportSheet'],
    ['src/components/RichText.tsx', '<TagPreviewSheet'],
    ['src/components/ReportSheet.tsx', '<MediaPickerButton'],
    ['src/components/ReportSheet.tsx', '<MediaAttachmentTray'],
    ['src/components/ui/MediaPickerButton.tsx', '<MediaSourceSheet'],
  ] as const) {
    assert.ok(nested.some((m) => m.pair.at.some(([file, n]) => file === opener && n === needle)), `${opener}: no pair anchors ${needle}`);
  }
  const cited = new Set(nested.flatMap((m) => m.pair.at.map(([file]) => file)));
  for (const file of NESTED_FILES) assert.ok(cited.has(file), `${file} is listed but no pair cites it`);
  // Over the picked photo, the tray's marks are floors, as every photo pair above is.
  assert.ok(nested.filter((m) => m.floor).length >= 7, 'the attachment tray is floored over any photo');
  assert.ok(Object.keys(NESTED_SURFACES).every((k) => Object.prototype.hasOwnProperty.call(S_TAIL, k)), 'every nested ground is a surface here');
  assert.deepEqual(nested.filter((m) => m.pair.finding !== undefined).map((m) => m.pair.id), []);
  assert.deepEqual(nested.filter((m) => m.threshold !== null && m.ratio < m.threshold).map((m) => `${m.pair.id}: ${m.ratio.toFixed(2)}`), []);
});

test('census-media §33.13: dynamic type — no Text in the nested sheets opts out of, or caps, OS font scaling', () => {
  let textElements = 0;
  const offenders: string[] = [];
  for (const file of NESTED_FILES) {
    const text = source(file);
    textElements += (text.match(/<Text\b/g) ?? []).length;
    if (/allowFontScaling\s*=\s*\{\s*false\s*\}/.test(text)) offenders.push(`${file}: allowFontScaling={false}`);
    if (/maxFontSizeMultiplier/.test(text)) offenders.push(`${file}: maxFontSizeMultiplier`);
  }
  assert.ok(textElements >= 60, `found ${textElements} <Text elements`);
  assert.deepEqual(offenders, []);
});
