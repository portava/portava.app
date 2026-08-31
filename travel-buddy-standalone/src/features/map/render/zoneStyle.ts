/**
 * zoneStyle — §6's semantic visual language, expressed as data.
 *
 * WHAT THIS IS
 * ============
 * §6 gives the map a vocabulary rather than a palette:
 *
 *   Soft filled zone   → current aggregate activity
 *   Pulsing outline    → meaningful recent change
 *   Dashed boundary    → predicted state or forecast zone
 *   Directional arrows → aggregate crowd flow
 *
 * Those four sentences are the entire contract, and they are meaningless if the
 * mapping from state to pixels is scattered across component files as inline
 * colour literals. So the mapping lives here, once, as tables — and the
 * components below it (`ActivityZone`, `CrowdFlowLine`) own no colours at all.
 *
 * THE ONE STRUCTURAL GUARANTEE
 * ============================
 * §37: "Do not make predictions look like observations."
 *
 * `resolveOutlineStyle` returns `'dashed'` for a forecast kind on its FIRST
 * line, before it has looked at activity, trend, confidence or freshness. There
 * is no combination of inputs — including ones invented later — that produces a
 * solid or pulsing outline for a forecast. That is asserted exhaustively over
 * the full input cross-product in the tests, not sampled.
 *
 * §10 AND THE FLOW STATES
 * =======================
 * "Observed movement and inferred cause must be separately represented."
 *
 * `flowStateStyle` describes OBSERVED movement and can never return a dash
 * array. `inferredCauseStyle` describes the INFERRED cause and is always
 * dashed with no arrowheads. The two are structurally different objects, so a
 * component cannot accidentally draw a guess in the vocabulary of a
 * measurement.
 *
 * DARK MODE FIRST (§4)
 * ====================
 * The base map recedes; Portava overlays are bright and semantic. Every colour
 * here is a saturated mid-tone chosen to read on a near-black/navy base, and
 * every fill opacity is low — §6: zones "should not imply scientifically exact
 * borders", so a zone is a wash, never a plate.
 */

import {
  ACTIVITY_LABELS,
  CONFIDENCE_LABELS,
  TREND_LABELS,
  isForecastKind,
  mayRenderAsLive,
} from '../../../types/mapObjects.ts';
import type {
  ActivityLevel,
  ConfidenceState,
  FreshnessState,
  MapObject,
  MapObjectKind,
  TrendState,
} from '../../../types/mapObjects.ts';
import { confidenceAtLeast } from './collision.ts';

// ── Vocabulary ────────────────────────────────────────────────────────────────

/** §6's three boundary treatments. There is no fourth. */
export const OUTLINE_STYLES = ['solid', 'pulsing', 'dashed'] as const;
export type OutlineStyle = (typeof OUTLINE_STYLES)[number];

/**
 * §6's "directional arrows". Direction is semantic, not a bearing: the geometry
 * already carries the bearing, and a dispersal has no single destination to
 * point at.
 */
export const ARROW_DIRECTIONS = ['none', 'forward', 'reverse', 'outward'] as const;
export type ArrowDirection = (typeof ARROW_DIRECTIONS)[number];

/** The kinds this module styles as an area. */
export const ZONE_KINDS = ['activity_zone', 'social_zone', 'buddy_zone', 'prediction'] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

export function isZoneKind(kind: MapObjectKind): kind is ZoneKind {
  return (ZONE_KINDS as readonly MapObjectKind[]).includes(kind);
}

/** §10's five flow states, verbatim. */
export const FLOW_STATES = ['strong', 'moderate', 'emerging', 'dispersing', 'unusual'] as const;
export type FlowState = (typeof FLOW_STATES)[number];

export const FLOW_STATE_LABELS: Record<FlowState, string> = {
  strong: 'Strong movement',
  moderate: 'Moderate movement',
  emerging: 'Emerging movement',
  dispersing: 'Dispersing',
  unusual: 'Unusual movement',
};

// ── Colour ramps ──────────────────────────────────────────────────────────────

interface RampEntry {
  fill: string;
  outline: string;
  /** Fill opacity before the confidence / freshness / forecast factors. */
  baseFillOpacity: number;
}

/**
 * Activity ramp — cool for quiet, warm for busy.
 *
 * The hue carries the level so the level survives being read at a glance on a
 * moving map; the opacity carries it a second time so the ramp still works for
 * a red/green colour-blind viewer, for whom the amber→red end of the ramp
 * collapses. Two channels for one meaning is deliberate redundancy, not waste.
 */
export const ACTIVITY_RAMP: Record<ActivityLevel, RampEntry> = {
  very_quiet: { fill: '#60A5FA', outline: '#93C5FD', baseFillOpacity: 0.10 },
  quiet: { fill: '#38BDF8', outline: '#7DD3FC', baseFillOpacity: 0.14 },
  moderate: { fill: '#34D399', outline: '#6EE7B7', baseFillOpacity: 0.20 },
  busy: { fill: '#FBBF24', outline: '#FCD34D', baseFillOpacity: 0.26 },
  very_busy: { fill: '#FB923C', outline: '#FDBA74', baseFillOpacity: 0.32 },
  peak: { fill: '#F87171', outline: '#FCA5A5', baseFillOpacity: 0.38 },
};

/**
 * Social ramp — a violet→rose family for `social_zone` / `buddy_zone`.
 *
 * Social opportunity is a different QUESTION from crowd level (§39: "Who is
 * relevant?" vs "What is happening?"), so it gets its own hue family rather
 * than a second reading of the same one. A busy street and a place where
 * travellers are gathering must not look like the same claim.
 */
export const SOCIAL_RAMP: Record<ActivityLevel, RampEntry> = {
  very_quiet: { fill: '#818CF8', outline: '#A5B4FC', baseFillOpacity: 0.10 },
  quiet: { fill: '#A78BFA', outline: '#C4B5FD', baseFillOpacity: 0.14 },
  moderate: { fill: '#C084FC', outline: '#D8B4FE', baseFillOpacity: 0.20 },
  busy: { fill: '#E879F9', outline: '#F0ABFC', baseFillOpacity: 0.26 },
  very_busy: { fill: '#F472B6', outline: '#F9A8D4', baseFillOpacity: 0.32 },
  peak: { fill: '#FB7185', outline: '#FDA4AF', baseFillOpacity: 0.38 },
};

/** The level assumed when the projection supplied none. Lowest visual weight. */
export const DEFAULT_ACTIVITY: ActivityLevel = 'moderate';

function rampFor(kind: MapObjectKind): Record<ActivityLevel, RampEntry> {
  return kind === 'social_zone' || kind === 'buddy_zone' ? SOCIAL_RAMP : ACTIVITY_RAMP;
}

// ── Opacity factors ───────────────────────────────────────────────────────────

/**
 * Confidence and freshness multiply the fill down, never up. A zone can only
 * get quieter as its evidence weakens — §37: "Do not let stale claims remain
 * visually live."
 */
export const CONFIDENCE_OPACITY_FACTOR: Record<ConfidenceState, number> = {
  strong: 1.0,
  live: 1.0,
  likely_current: 0.85,
  provisional: 0.7,
  unverified: 0.55,
};

export const FRESHNESS_OPACITY_FACTOR: Record<FreshnessState, number> = {
  live: 1.0,
  recent: 0.95,
  aging: 0.8,
  stale: 0.6,
  historical: 0.45,
  // `unknown` is the fail-closed default; it must not read as more current than
  // an explicitly stale claim.
  unknown: 0.5,
};

/** A forecast is dimmer as well as dashed — two independent signals, not one. */
export const FORECAST_OPACITY_FACTOR = 0.6;

export const MIN_FILL_OPACITY = 0.05;
export const MAX_FILL_OPACITY = 0.42;

/**
 * §6: a zone "should not imply scientifically exact borders". These two
 * constants are what enforces that in pixels — an outline can never be fully
 * opaque and can never be perfectly sharp, whatever the state says.
 */
export const MAX_ZONE_OUTLINE_OPACITY = 0.55;
export const MIN_ZONE_OUTLINE_BLUR_PX = 2;

/** Zone fills are blurred at their edge so the boundary reads as approximate. */
export const ZONE_FILL_BLUR_PX = 12;

// ── Outline style ─────────────────────────────────────────────────────────────

/**
 * Trends that count as "meaningful recent change" and therefore earn a pulse.
 *
 * `stable` obviously does not. `cooling` deliberately does not either: §32 says
 * "Avoid constant bouncing markers or animation without semantic meaning", and
 * a city at 11 PM is mostly cooling — if cooling pulsed, the whole map would
 * pulse and the pulse would stop meaning anything.
 */
export const MEANINGFUL_CHANGE_TRENDS: readonly TrendState[] = [
  'increasing_quickly',
  'getting_busier',
  'getting_quieter',
  'rapidly_dispersing',
];

export interface PulseSpec {
  /** One full dim→bright→dim cycle, in ms. */
  periodMs: number;
  minOpacity: number;
  maxOpacity: number;
}

export const DEFAULT_PULSE_PERIOD_MS = 2400;

/**
 * The §6 boundary decision.
 *
 * The forecast branch is FIRST and unconditional. Nothing below it can run for
 * a forecast kind, so no combination of activity, trend, confidence or
 * freshness — present or future — can give a prediction a solid or pulsing
 * boundary.
 */
export function resolveOutlineStyle(
  kind: MapObjectKind,
  trend: TrendState | undefined,
  freshness: FreshnessState | undefined,
): OutlineStyle {
  if (isForecastKind(kind)) return 'dashed';
  // A pulse asserts that something is changing RIGHT NOW. A claim that is not
  // live may not make that assertion (§37).
  if (!mayRenderAsLive(freshness)) return 'solid';
  if (trend != null && MEANINGFUL_CHANGE_TRENDS.includes(trend)) return 'pulsing';
  return 'solid';
}

/** Dash pattern for a forecast boundary, in line-width multiples. */
export const FORECAST_DASH_ARRAY: readonly number[] = [2, 1.6];

// ── The zone style ────────────────────────────────────────────────────────────

export interface ZoneStyleInput {
  kind: MapObjectKind;
  activity?: ActivityLevel;
  trend?: TrendState;
  confidence?: ConfidenceState;
  freshness?: FreshnessState;
}

export interface ZoneVisualStyle {
  fillColor: string;
  fillOpacity: number;
  /** Edge softness of the fill, in points. Always > 0 for a zone (§6). */
  fillBlurPx: number;

  outlineColor: string;
  outlineOpacity: number;
  outlineWidth: number;
  outlineStyle: OutlineStyle;
  /** Always > 0 — a zone never gets a hard stroke (§6). */
  outlineBlurPx: number;
  /** Non-null if and only if `outlineStyle === 'dashed'`. */
  dashArray: readonly number[] | null;
  /** Non-null if and only if `outlineStyle === 'pulsing'`. */
  pulse: PulseSpec | null;

  arrowDirection: ArrowDirection;

  /** True for forecast kinds. Callers must label these; §15/§37. */
  isForecast: boolean;
  /** Short legend string, e.g. "Predicted · Busy · Getting busier". */
  legend: string;
}

function clamp01(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * §6's arrow rule. Zones never carry arrows; only `crowd_flow` does, and a
 * dispersal radiates rather than travelling, because pointing a dispersal at a
 * destination would assert a movement Portava did not observe.
 */
export function resolveArrowDirection(
  kind: MapObjectKind,
  trend: TrendState | undefined,
): ArrowDirection {
  if (kind !== 'crowd_flow') return 'none';
  if (trend === 'rapidly_dispersing' || trend === 'getting_quieter') return 'outward';
  return 'forward';
}

function legendFor(input: ZoneStyleInput, activity: ActivityLevel): string {
  const parts: string[] = [];
  if (isForecastKind(input.kind)) parts.push('Predicted');
  parts.push(ACTIVITY_LABELS[activity]);
  if (input.trend != null && input.trend !== 'stable') parts.push(TREND_LABELS[input.trend]);
  if (input.confidence != null) parts.push(CONFIDENCE_LABELS[input.confidence]);
  return parts.join(' · ');
}

/** `(kind, activity, trend, confidence, freshness)` → the §6 visual language. */
export function zoneStyle(input: ZoneStyleInput): ZoneVisualStyle {
  const activity = input.activity ?? DEFAULT_ACTIVITY;
  const entry = rampFor(input.kind)[activity] ?? rampFor(input.kind)[DEFAULT_ACTIVITY];
  const forecast = isForecastKind(input.kind);

  const confidenceFactor =
    input.confidence != null ? CONFIDENCE_OPACITY_FACTOR[input.confidence] : 0.7;
  const freshnessFactor =
    input.freshness != null ? FRESHNESS_OPACITY_FACTOR[input.freshness] : FRESHNESS_OPACITY_FACTOR.unknown;
  const forecastFactor = forecast ? FORECAST_OPACITY_FACTOR : 1;

  const fillOpacity = clamp01(
    entry.baseFillOpacity * confidenceFactor * freshnessFactor * forecastFactor,
    MIN_FILL_OPACITY,
    MAX_FILL_OPACITY,
  );

  const outlineStyle = resolveOutlineStyle(input.kind, input.trend, input.freshness);
  const outlineOpacity = clamp01(
    0.9 * confidenceFactor * freshnessFactor * forecastFactor,
    0.15,
    MAX_ZONE_OUTLINE_OPACITY,
  );
  const outlineWidth = outlineStyle === 'pulsing' ? 2.5 : outlineStyle === 'dashed' ? 2 : 1.5;

  return {
    fillColor: entry.fill,
    fillOpacity,
    fillBlurPx: ZONE_FILL_BLUR_PX,

    outlineColor: entry.outline,
    outlineOpacity,
    outlineWidth,
    outlineStyle,
    outlineBlurPx: MIN_ZONE_OUTLINE_BLUR_PX,
    dashArray: outlineStyle === 'dashed' ? FORECAST_DASH_ARRAY : null,
    pulse:
      outlineStyle === 'pulsing'
        ? {
            periodMs: DEFAULT_PULSE_PERIOD_MS,
            minOpacity: Math.max(0.12, outlineOpacity * 0.35),
            maxOpacity: outlineOpacity,
          }
        : null,

    arrowDirection: resolveArrowDirection(input.kind, input.trend),

    isForecast: forecast,
    legend: legendFor(input, activity),
  };
}

/** Convenience for the render path — pulls the five axes off a `MapObject`. */
export function zoneStyleForObject(obj: MapObject): ZoneVisualStyle {
  return zoneStyle({
    kind: obj.kind,
    activity: obj.activity,
    trend: obj.trend,
    confidence: obj.confidence,
    freshness: obj.freshness,
  });
}

// ── §10 crowd flow ────────────────────────────────────────────────────────────

export interface FlowVisualStyle {
  lineColor: string;
  lineWidth: number;
  lineOpacity: number;
  /**
   * ALWAYS null for observed flow. §6 reserves the dashed vocabulary for
   * forecasts, so an observed movement — however thin the evidence — may never
   * borrow it. Weak evidence is expressed with opacity and width instead.
   */
  lineDashArray: null;
  /** Distance between arrowheads along the line, in points. */
  arrowSpacingPx: number;
  arrowOpacity: number;
  /** Whether the line animates. §32: motion only where it carries meaning. */
  animated: boolean;
  /** Discriminant against `InferredCauseStyle`. §10. */
  representation: 'observed';
  label: string;
}

/**
 * §10's five flow states.
 *
 * Note what varies and what does not. Width, opacity and arrow density carry
 * strength; colour carries CHARACTER (cyan = movement, slate = draining, amber
 * = anomaly). Nothing here varies the dash pattern, because a dash would claim
 * the object is a forecast.
 */
export const FLOW_STATE_STYLE: Record<FlowState, FlowVisualStyle> = {
  strong: {
    lineColor: '#22D3EE',
    lineWidth: 5,
    lineOpacity: 0.9,
    lineDashArray: null,
    arrowSpacingPx: 46,
    arrowOpacity: 0.95,
    animated: true,
    representation: 'observed',
    label: FLOW_STATE_LABELS.strong,
  },
  moderate: {
    lineColor: '#22D3EE',
    lineWidth: 3.5,
    lineOpacity: 0.7,
    lineDashArray: null,
    arrowSpacingPx: 64,
    arrowOpacity: 0.8,
    animated: true,
    representation: 'observed',
    label: FLOW_STATE_LABELS.moderate,
  },
  emerging: {
    lineColor: '#A5F3FC',
    lineWidth: 2.25,
    lineOpacity: 0.45,
    lineDashArray: null,
    arrowSpacingPx: 92,
    arrowOpacity: 0.55,
    // An emerging signal is by definition not yet established; animating it
    // would overstate it.
    animated: false,
    representation: 'observed',
    label: FLOW_STATE_LABELS.emerging,
  },
  dispersing: {
    lineColor: '#94A3B8',
    lineWidth: 3,
    lineOpacity: 0.55,
    lineDashArray: null,
    arrowSpacingPx: 72,
    arrowOpacity: 0.7,
    animated: true,
    representation: 'observed',
    label: FLOW_STATE_LABELS.dispersing,
  },
  unusual: {
    lineColor: '#FACC15',
    lineWidth: 4,
    lineOpacity: 0.85,
    lineDashArray: null,
    arrowSpacingPx: 52,
    arrowOpacity: 0.9,
    animated: true,
    representation: 'observed',
    label: FLOW_STATE_LABELS.unusual,
  },
};

export function flowStateStyle(state: FlowState): FlowVisualStyle {
  return FLOW_STATE_STYLE[state] ?? FLOW_STATE_STYLE.emerging;
}

export interface InferredCauseStyle {
  lineColor: string;
  lineWidth: number;
  lineOpacity: number;
  /** Never null — the inferred half of §10 is always dashed. */
  lineDashArray: readonly number[];
  /** Never anything else — an inference has no measured direction to point. */
  arrowDirection: 'none';
  representation: 'inferred';
  label: string;
}

/**
 * §10: "Observed movement and inferred cause must be separately represented."
 *
 * This is the second, visually distinct treatment: a dashed leader from the
 * flow to whatever Portava believes caused it (an event, a closing time, a
 * spillover), with no arrowheads and no animation. It shares no field shape
 * with `FlowVisualStyle` beyond colour and width, so the two cannot be swapped
 * for one another by accident.
 */
export const INFERRED_CAUSE_STYLE: InferredCauseStyle = {
  lineColor: '#C4B5FD',
  lineWidth: 1.5,
  lineOpacity: 0.6,
  lineDashArray: [1.5, 2],
  arrowDirection: 'none',
  representation: 'inferred',
  label: 'Possible cause',
};

export function inferredCauseStyle(): InferredCauseStyle {
  return INFERRED_CAUSE_STYLE;
}

/**
 * Derive the §10 flow state from the axes the projection already stamped.
 *
 * `unusual` cannot be derived — an anomaly is a server-side judgement against a
 * baseline the client does not hold (§19) — so it arrives as an explicit flag
 * rather than being guessed from activity.
 */
export function flowStateOf(input: {
  activity?: ActivityLevel;
  trend?: TrendState;
  confidence?: ConfidenceState;
  freshness?: FreshnessState;
  anomalous?: boolean;
}): FlowState {
  if (input.anomalous) return 'unusual';
  if (
    input.trend === 'rapidly_dispersing' ||
    input.trend === 'getting_quieter' ||
    input.trend === 'cooling'
  ) {
    return 'dispersing';
  }
  const confident =
    confidenceAtLeast(input.confidence, 'live') && mayRenderAsLive(input.freshness);
  if (
    confident &&
    (input.activity === 'very_busy' || input.activity === 'peak' || input.trend === 'increasing_quickly')
  ) {
    return 'strong';
  }
  if (confident || input.activity === 'busy' || input.activity === 'moderate') return 'moderate';
  return 'emerging';
}
