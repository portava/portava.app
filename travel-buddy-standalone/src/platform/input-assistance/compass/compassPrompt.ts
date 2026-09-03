/**
 * Global Input Intelligence — Phase 7 (Compass + AI): the compass-prompt
 * starters (spec §56, §14).
 *
 * §56: a compass prompt field ("where should I…") offers SUGGESTED PROMPTS
 * (starters) plus, separately, an opt-in AI continuation. This module owns the
 * DETERMINISTIC starter set: a fixed, curated list of well-formed prompts the
 * traveler can tap to seed the field. They are NOT AI output and NOT flag-gated —
 * `buildCompassStarters` returns the same list whether or not the AI-writing flag
 * is on (the AI continuation is the flag-gated half, handled by `aiWriting.ts`).
 *
 * Pure module (no React, no network, no randomness) — so its output is a pure
 * function of its inputs and is unit-testable under node:test.
 */
import type { InputContext } from '../types/inputContext.ts';

/** A single tappable starter prompt (§56). `prompt` is the full text to seed. */
export interface CompassStarter {
  id: string;
  /** Short chip label. */
  label: string;
  /** The full, well-formed prompt the tap seeds into the field. */
  prompt: string;
}

/**
 * The curated, deterministic base starters. Fixed intent set (present-moment,
 * tonight, meet people, plan the day, surprise, trip status) — the same spine
 * the Compass Home zero-state offers, owned here so it is testable and reusable
 * independent of any screen component.
 */
export const COMPASS_STARTERS: readonly CompassStarter[] = [
  { id: 'right_now', label: 'Right now', prompt: 'What should I do right now?' },
  { id: 'tonight', label: 'Tonight', prompt: 'What should I do tonight?' },
  { id: 'meet', label: 'Meet people', prompt: "Help me meet people nearby — who's around and what's social right now?" },
  { id: 'build_day', label: 'Build my day', prompt: 'Build my day — plan out the rest of today for me.' },
  { id: 'surprise', label: 'Surprise me', prompt: "Surprise me with something I wouldn't have thought of." },
  { id: 'my_trip', label: 'My trip', prompt: "What's the status of my trip and what should I do next on it?" },
] as const;

export interface BuildCompassStartersOptions {
  /** Current surface (e.g. 'compass') — reserved for future surface-specific tuning. */
  surface?: string;
  /** Coarse city name for a city-scoped starter. No coordinates (§29). */
  cityName?: string | null;
  /** An active trip's id — presence adds a trip-scoped starter. */
  tripId?: string | null;
  /** Explicit "user has an active trip" signal (equivalent to a tripId). */
  hasTrip?: boolean;
  /** Cap on the number of starters returned (default 6). */
  limit?: number;
}

/**
 * Build the deterministic starter list for a compass prompt (§56). Context-aware
 * but DETERMINISTIC and FLAG-INDEPENDENT: given the same options it always
 * returns the same list, with no AI call and no randomness. A `cityName`
 * prepends a city-scoped starter and a trip signal prepends a trip-scoped one —
 * both are plain string templates, never model output.
 */
export function buildCompassStarters(opts: BuildCompassStartersOptions = {}): CompassStarter[] {
  const { cityName, tripId, hasTrip, limit = 6 } = opts;
  const out: CompassStarter[] = [];

  const city = typeof cityName === 'string' ? cityName.trim() : '';
  if (city) {
    out.push({
      id: 'in_city',
      label: `In ${city}`,
      prompt: `What should I do in ${city} right now?`,
    });
  }
  if (hasTrip === true || (typeof tripId === 'string' && tripId.trim().length > 0)) {
    out.push({
      id: 'trip_next',
      label: 'Next on my trip',
      prompt: "What should I do next on my current trip?",
    });
  }

  // Append the curated base set, skipping any id already added by a scoped
  // starter (trip_next supersedes my_trip so the list never duplicates intent).
  const seen = new Set(out.map((s) => s.id));
  const superseded = new Set<string>();
  if (seen.has('trip_next')) superseded.add('my_trip');
  for (const s of COMPASS_STARTERS) {
    if (seen.has(s.id) || superseded.has(s.id)) continue;
    out.push(s);
    seen.add(s.id);
  }

  return limit > 0 ? out.slice(0, limit) : out;
}

/** True for the compass prompt context. */
export function isCompassPromptContext(context: InputContext): boolean {
  return context === 'compass_prompt';
}
