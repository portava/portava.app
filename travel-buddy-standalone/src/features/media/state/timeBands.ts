/**
 * features/media — §17 Time-band presentation helpers (pure).
 *
 * Turns the sanitised timeline view-model (types/mediaTimeline.ts) into the
 * copy + visual-class the rail renders, WITHOUT re-deriving any truth:
 *   • a band's render class maps to an ObservationClass so it reuses the exact
 *     observed / inferred / predicted hues from stateColors.ts — the §46
 *     "distinct visual treatments" requirement, one source of colour;
 *   • a forecast's confidence renders as an honest "band · NN%" label (§17
 *     "forecasts carry confidence") — never as a fact and never as "live";
 *   • the Now band shows a current-state label ONLY when it is genuinely live;
 *     otherwise a neutral "No current read" (§46.2 no fake-live).
 *
 * No react-native imports — safe for node:test.
 */
import type { ObservationClass } from '../types/media.ts';
import type {
  TimeBandRenderClass,
  TimeConfidenceBand,
  TimelineBand,
} from '../types/mediaTimeline.ts';
import { OBSERVATION_COLOR, isForecastClass } from './stateColors.ts';

/**
 * Map the coarse timeline render class onto an ObservationClass so the three
 * bands read as three visually-distinct evidence classes (§46):
 *   observed  → observed  (teal)   — a firsthand capture / gated live read
 *   typical   → inferred  (indigo) — a derived historical pattern
 *   predicted → predicted (amber)  — a forecast, dashed / "Likely"
 */
export const RENDER_CLASS_OBSERVATION: Record<TimeBandRenderClass, ObservationClass> = {
  observed: 'observed',
  typical: 'inferred',
  predicted: 'predicted',
};

/** The semantic hue for a render class — routed through the §46 observation palette. */
export function renderClassColor(rc: TimeBandRenderClass): string {
  return OBSERVATION_COLOR[RENDER_CLASS_OBSERVATION[rc]];
}

/** Whether a render class should get the dashed / forecast treatment (§17). */
export function isForecastRenderClass(rc: TimeBandRenderClass): boolean {
  return isForecastClass(RENDER_CLASS_OBSERVATION[rc]);
}

/**
 * Human copy for a confidence band. Deliberately avoids the word "live" for the
 * `live` band — a forecast is never presented as a current observation (§46.2),
 * so the strongest a forecast band ever reads is "High confidence".
 */
const CONFIDENCE_BAND_LABEL: Record<TimeConfidenceBand, string> = {
  unverified: 'Unconfirmed',
  provisional: 'Provisional',
  likely_current: 'Likely',
  live: 'High confidence',
  strong: 'Strong',
};

export function confidenceBandLabel(band: TimeConfidenceBand | null): string {
  return band ? CONFIDENCE_BAND_LABEL[band] : 'Likely';
}

/**
 * The confidence chip copy a forecast carries, e.g. "Likely · 72%". A finite
 * confidence in [0,1] contributes the percentage; an absent one degrades to the
 * band word alone (the mapper drops confidence-less forecasts, so in practice
 * both are present).
 */
export function confidenceChipLabel(
  confidence: number | null,
  band: TimeConfidenceBand | null,
): string {
  const word = confidenceBandLabel(band);
  if (typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
    return `${word} · ${Math.round(confidence * 100)}%`;
  }
  return word;
}

/**
 * The Now band's current-state line. Honest by construction: a real label ONLY
 * when the band is genuinely live AND carries a live item; otherwise the neutral
 * "No current read" (§46.2 — cached / typical / predicted data is never dressed
 * up as a live now).
 */
export function nowStateLabel(now: TimelineBand): string {
  const live = now.live && now.items.some((it) => it.live);
  if (!live) return 'No current read';
  const labelled = now.items.find((it) => it.live && (it.label ?? '').trim().length > 0);
  return labelled?.label?.trim() || 'Live now';
}

/** True when the Now band should render its live treatment (never fabricated). */
export function nowIsLive(now: TimelineBand): boolean {
  return now.live && now.items.some((it) => it.live);
}
