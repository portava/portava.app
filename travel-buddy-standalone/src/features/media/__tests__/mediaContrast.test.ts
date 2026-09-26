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
  tileScrimFallback: ['#22221E', 'rgba(17,17,15,0.55)'],
  tileScrimPhoto: [PHOTO, 'rgba(17,17,15,0.55)'],
  tilePlayFallback: ['#22221E', 'rgba(17,17,15,0.5)'],
  tilePlayPhoto: [PHOTO, 'rgba(17,17,15,0.5)'],
  cardChipFallback: ['#22221E', 'rgba(17,17,15,0.55)'],
  cardChipPhoto: [PHOTO, 'rgba(17,17,15,0.55)'],
  viewerOverlayFallback: ['#1B1B18', 'rgba(17,17,15,0.62)'],
  viewerOverlayPhoto: [PHOTO, 'rgba(17,17,15,0.62)'],
  viewerChipFallback: ['#1B1B18', 'rgba(17,17,15,0.62)', WASH('0.10')],
  viewerChipPhoto: [PHOTO, 'rgba(17,17,15,0.62)', WASH('0.10')],
  viewerPillFallback: ['#1B1B18', 'rgba(17,17,15,0.62)', WASH('0.14')],
  viewerPillPhoto: [PHOTO, 'rgba(17,17,15,0.62)', WASH('0.14')],
  viewerBareFallback: ['#1B1B18'],
  viewerBarePhoto: [PHOTO],
  viewerIconBtnPhoto: [PHOTO, 'rgba(17,17,15,0.55)'],
  viewerControlPhoto: [PHOTO, 'rgba(17,17,15,0.7)'],
  viewerPlayBadgePhoto: [PHOTO, 'rgba(17,17,15,0.5)'],
  viewerCaptionPhoto: [PHOTO, 'rgba(17,17,15,0.74)'],
  viewerProgressTrackPhoto: [PHOTO, WASH('0.26')],

  // Over the in-tree dark map.
  map: [MAP],
  mapBubble: [MAP, 'rgba(17,17,15,0.86)'],
  mapBubbleFallback: ['#1A1A17', 'rgba(17,17,15,0.86)'],
  mapGemMarker: [MAP, 'rgba(16,185,129,0.12)'],
} as const satisfies Record<string, readonly string[]>;

type SurfaceId = keyof typeof S;
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
const VIEWER_OVERLAY: Needle = [F.viewer, "backgroundColor: 'rgba(17,17,15,0.62)'"];
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
const CHIP_FINDING: Record<string, number> = {
  starting: 1.81, building: 2.31, peak: 2.02, moderate: 1.66, quiet: 1.4, winding_down: 1.45,
};
for (const [k, v] of Object.entries(ZONE_COLOR)) {
  const at: Needle[] = [
    [F.changing, '<Text style={[styles.stateChipText, { color: accent }]}>'],
    [F.changing, "backgroundColor: 'rgba(17,17,15,0.55)'"],
    [F.changing, "heroFallback: { backgroundColor: '#22221E' }"],
  ];
  add({ id: `changing.stateChip.${k}.fallback`, fg: v, on: 'cardChipFallback', kind: 'text', at });
  add({ id: `changing.stateChip.${k}.photoFloor`, fg: v, on: 'cardChipPhoto', kind: 'text', at, finding: CHIP_FINDING[k] });
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
add({ id: 'trust.description', fg: color.faint, on: 'paper', kind: 'text', at: [TRUST_CARD, [F.trust, 'desc: { fontSize: 11, lineHeight: 14, color: color.faint }']], finding: 2.73 });
add({ id: 'trust.percent', fg: color.mute, on: 'paper', kind: 'text', at: [TRUST_CARD, [F.trust, 'pct: { ...t.stamp, color: color.mute']] });
add({ id: 'trust.caption', fg: color.faint, on: 'paper', kind: 'text', at: [TRUST_CARD, [F.trust, 'caption: { fontSize: 11, lineHeight: 14, color: color.faint']], finding: 2.73 });
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
const INTEL_PHOTO_FINDING: Record<string, number> = {
  observed: 2.93, inferred: 2.11, user_claimed: 1.84, predicted: 2.56, generated: 1.58,
};
for (const [k, v] of Object.entries(OBSERVATION_COLOR)) {
  // The class chip's dot and border share this colour on the same ground.
  add({ id: `intel.class.${k}.onGround`, fg: v, on: 'ink', kind: 'text', at: [...INTEL_CLASS, [F.places, '<IntelligenceStrip']] });
  add({ id: `intel.class.${k}.viewerFallback`, fg: v, on: 'viewerOverlayFallback', kind: 'text', at: [...INTEL_CLASS, VIEWER_OVERLAY, VIEWER_FALLBACK] });
  add({ id: `intel.class.${k}.viewerPhotoFloor`, fg: v, on: 'viewerOverlayPhoto', kind: 'text', at: [...INTEL_CLASS, VIEWER_OVERLAY], finding: INTEL_PHOTO_FINDING[k] });
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
const TILE_SCRIM: Needle[] = [[F.tile, "backgroundColor: 'rgba(17,17,15,0.55)'"], [F.tile, "fallback: { backgroundColor: '#22221E' }"]];
add({ id: 'tile.perspective.fallback', fg: color.onInk, on: 'tileScrimFallback', kind: 'text', at: [...TILE_SCRIM, [F.tile, 'perspective: { color: color.onInk, fontSize: 13']] });
add({ id: 'tile.perspective.photoFloor', fg: color.onInk, on: 'tileScrimPhoto', kind: 'text', at: [...TILE_SCRIM, [F.tile, 'perspective: { color: color.onInk, fontSize: 13']], finding: 3.96 });
add({ id: 'tile.age.fallback', fg: color.onInkMute, on: 'tileScrimFallback', kind: 'text', at: [...TILE_SCRIM, [F.tile, 'age: { color: color.onInkMute, fontSize: 11']] });
add({ id: 'tile.age.photoFloor', fg: color.onInkMute, on: 'tileScrimPhoto', kind: 'text', at: [...TILE_SCRIM, [F.tile, 'age: { color: color.onInkMute, fontSize: 11']], finding: 2.87 });
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
add({ id: 'mapCanvas.bubbleCount.selected', fg: color.onInk, on: 'selected', kind: 'text', at: [[F.mapCanvas, 'bubbleSelected: { backgroundColor: color.onInk },'], [F.mapCanvas, '<Text style={styles.bubbleText}>{c.perspectiveCount}</Text>']], finding: 1 });
// The outline is not the bubble's only cue: its count text passes over the map (above).
add({ id: 'mapCanvas.bubbleOutline.mapFloor', fg: color.onInk, on: 'map', kind: 'decor', at: [[F.mapCanvas, 'borderColor: color.onInk,']] });
add({ id: 'mapCanvas.gemMarkerRing.mapFloor', fg: GEM_ACCENT, on: 'map', kind: 'ui', at: [[F.mapCanvas, 'borderColor: GEM_ACCENT,']] });
add({ id: 'mapCanvas.gemMarkerCore.mapFloor', fg: GEM_ACCENT, on: 'mapGemMarker', kind: 'ui', at: [[F.mapCanvas, "backgroundColor: 'rgba(16,185,129,0.12)',"], [F.mapCanvas, 'backgroundColor: GEM_ACCENT,']] });
// Below 3:1 only where it crosses a major-road casing (mapBase.roadCasing); >= 3.03 over every other paint.
add({ id: 'mapCanvas.gemZoneContour.mapFloor', fg: 'rgba(16,185,129,0.7)', on: 'map', kind: 'ui', at: [[F.mapCanvas, "paint={{ 'line-color': GEM_ACCENT, 'line-width': 1.5, 'line-opacity': 0.7"]], finding: 2.65 });

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
add({ id: 'viewer.topTitle.fallback', fg: color.onInk, on: 'viewerBareFallback', kind: 'text', at: [TOP_TITLE, VIEWER_FALLBACK] });
add({ id: 'viewer.topTitle.photoFloor', fg: color.onInk, on: 'viewerBarePhoto', kind: 'text', at: [TOP_TITLE, [F.viewer, 'resizeMode="cover"']], finding: 1.0 });
add({ id: 'viewer.topBarIcons.photoFloor', fg: color.onInk, on: 'viewerIconBtnPhoto', kind: 'ui', at: [[F.viewer, '<ChevronLeft size={22} color={color.onInk}'], [F.viewer, "backgroundColor: 'rgba(17,17,15,0.55)'"]] });
const OVERLAY_TEXT: ReadonlyArray<readonly [id: string, fg: string, needle: Needle, photoFinding?: number]> = [
  ['headline', color.onInk, [F.viewer, /headline: \{\s*color: color\.onInk,/]],
  ['contributorName', color.onInk, [F.viewer, 'contributorName: { color: color.onInk, fontSize: 14']],
  ['trustLabel', color.onInkMute, [F.viewer, 'trustLabel: { color: color.onInkMute, fontSize: 12'], 3.48],
  ['note', color.onInk, [F.viewer, "note: { color: color.onInk, fontSize: 15, fontStyle: 'italic'"]],
  ['relatedHeading', color.onInkMute, [F.viewer, /relatedHeading: \{\s*color: color\.onInkMute,/], 3.48],
  ['intelPerspective', color.onInkMute, [F.intel, /perspective: \{\s*color: color\.onInkMute,/], 3.48],
];
for (const [id, fg, needle, photoFinding] of OVERLAY_TEXT) {
  add({ id: `viewer.${id}.fallback`, fg, on: 'viewerOverlayFallback', kind: 'text', at: [needle, VIEWER_OVERLAY, VIEWER_FALLBACK] });
  add({ id: `viewer.${id}.photoFloor`, fg, on: 'viewerOverlayPhoto', kind: 'text', at: [needle, VIEWER_OVERLAY], finding: photoFinding });
}
const VIEWER_CHIP_TEXT: ReadonlyArray<readonly [id: string, fg: string, needle: Needle, photoFinding: number]> = [
  ['relatedChip', color.onInkMute, [F.viewer, 'chipText: { color: color.onInkMute, fontSize: 13'], 2.95],
  ['relatedChipCount', color.faint, [F.viewer, 'chipCount: { color: color.faint, fontSize: 12'], 1.5],
  ['freshnessText', color.onInkMute, FRESH_TEXT, 2.95],
];
for (const [id, fg, needle, photoFinding] of VIEWER_CHIP_TEXT) {
  add({ id: `viewer.${id}.fallback`, fg, on: 'viewerChipFallback', kind: 'text', at: [needle, VIEWER_CHIP, VIEWER_FALLBACK] });
  add({ id: `viewer.${id}.photoFloor`, fg, on: 'viewerChipPhoto', kind: 'text', at: [needle, VIEWER_CHIP], finding: photoFinding });
}
const FRESH_DOT_PHOTO_FINDING: Record<string, number> = { live: 2.39, fresh: 1.69, recent: 1.45, historical: 1.29 };
for (const [k, v] of Object.entries(FRESHNESS_COLOR)) {
  add({ id: `viewer.freshnessDot.${k}.photoFloor`, fg: v, on: 'viewerChipPhoto', kind: 'ui', at: [[F.freshness, '{ backgroundColor: dotColor }'], VIEWER_CHIP], finding: FRESH_DOT_PHOTO_FINDING[k] });
}
add({ id: 'viewer.pill.fallback', fg: color.onInk, on: 'viewerPillFallback', kind: 'text', at: [[F.viewer, 'pillText: { color: color.onInk, fontSize: 13'], [F.viewer, "backgroundColor: 'rgba(250,249,246,0.14)'"]] });
add({ id: 'viewer.pill.photoFloor', fg: color.onInk, on: 'viewerPillPhoto', kind: 'text', at: [[F.viewer, 'pillText: { color: color.onInk, fontSize: 13'], [F.viewer, "backgroundColor: 'rgba(250,249,246,0.14)'"]], finding: 3.79 });
add({ id: 'viewer.chipActive', fg: color.ink, on: 'selected', kind: 'text', at: [[F.viewer, 'chipTextActive: { color: color.ink }'], [F.viewer, 'chipActive: { backgroundColor: color.onInk }']] });
add({ id: 'viewer.verifiedCheck', fg: color.ink, on: 'selected', kind: 'ui', at: [[F.viewer, '<Check size={10} color={color.ink}'], [F.viewer, 'backgroundColor: color.onInk,']] });
add({ id: 'viewer.caption.photoFloor', fg: color.onInk, on: 'viewerCaptionPhoto', kind: 'text', at: [[F.viewer, 'captionText: { color: color.onInk, fontSize: 14'], [F.viewer, "backgroundColor: 'rgba(17,17,15,0.74)'"]] });
add({ id: 'viewer.retryLabel.photoFloor', fg: color.onInk, on: 'viewerPlayBadgePhoto', kind: 'text', at: [[F.viewer, "controlLabel: { color: color.onInk, fontSize: 11, fontWeight: '700' }"], [F.viewer, "backgroundColor: 'rgba(17,17,15,0.5)'"]], finding: 3.37 });
add({ id: 'viewer.playIcons.photoFloor', fg: color.onInk, on: 'viewerPlayBadgePhoto', kind: 'ui', at: [[F.viewer, '<RotateCcw size={18} color={color.onInk}'], [F.viewer, "backgroundColor: 'rgba(17,17,15,0.5)'"]] });
add({ id: 'viewer.controlIcons.photoFloor', fg: color.onInk, on: 'viewerControlPhoto', kind: 'ui', at: [[F.viewer, '<Rewind size={16} color={color.onInk} />'], [F.viewer, "backgroundColor: 'rgba(17,17,15,0.7)'"]] });
add({ id: 'viewer.buffering.fallback', fg: color.onInkMute, on: 'viewerBareFallback', kind: 'text', at: [[F.viewer, /bufferingLabel: \{[^}]*color: color\.onInkMute,/], VIEWER_FALLBACK] });
add({ id: 'viewer.buffering.photoFloor', fg: color.onInkMute, on: 'viewerBarePhoto', kind: 'text', at: [[F.viewer, /bufferingLabel: \{[^}]*color: color\.onInkMute,/]], finding: 1.0 });
add({ id: 'viewer.progressFill.photoFloor', fg: color.signal, on: 'viewerProgressTrackPhoto', kind: 'ui', at: [[F.viewer, "backgroundColor: 'rgba(250,249,246,0.26)'"], [F.viewer, 'backgroundColor: color.signal,']], finding: 1.0 });

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
add({ id: 'rail.rowLabel.active', fg: color.signal, on: 'paperSignalTint', kind: 'text', at: [[F.actionRail, /rowLabelActive: \{\s*color: color\.signal,/], [F.actionRail, "backgroundColor: 'rgba(255,77,46,0.08)'"]], finding: 2.85 });
add({ id: 'rail.rowIcon', fg: color.ink, on: 'paper', kind: 'ui', at: [[F.actionRail, 'color={active ? color.signal : color.ink}']] });
add({ id: 'rail.rowIcon.active', fg: color.signal, on: 'paperSignalTint', kind: 'ui', at: [[F.actionRail, 'color={active ? color.signal : color.ink}'], [F.actionRail, "backgroundColor: 'rgba(255,77,46,0.08)'"]], finding: 2.85 });
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

const MEASURED: Measured[] = PAIRS.map((pair) => {
  const layers = S[pair.on];
  const floor = layers[0] === PHOTO || layers[0] === MAP;
  const ratio = floor ? floorRatio(pair.fg, layers) : ratioOn(pair.fg, layers);
  const threshold = pair.kind === 'decor' ? null : THRESHOLD[pair.kind];
  return { pair, ratio, threshold, floor };
});

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
