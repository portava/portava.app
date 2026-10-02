/**
 * discoveryRankIntent — A18: explicit current intent, as a ranking term.
 * census-discovery §78 (lane W10-R2).
 *
 * THE ROW, VERBATIM (Passport `:94`)
 *   "Compass and Discovery should weight explicit current intent more heavily
 *    than generic interests."
 *
 * §69.3 restated it precisely: the request-scoped live layer (A05, DV-42) moves
 * a row at most LIVE_RANK_MAX_POSITIONS over the taste order, "so by
 * construction it cannot weight explicit intent MORE heavily than the
 * generic-interest order it bounds", and "Passport's explicit intent, the
 * supply the row names, is still read by no ranker".
 *
 * WHAT THIS MODULE DOES
 * =====================
 * It resolves the viewer's explicit current intent into plain data
 * (portavaRank `RankIntent`), and portavaRank scores it as `intentMatch` with
 * INTENT_TERM_WEIGHT 0.75 — above `interestTag` 0.3 + `categoryAffinity` 0.4
 * stacked — INSIDE the taste score, not as a bounded layer over it.
 *
 * Two sources, in this order (decision D-W10-R2-5):
 *
 *   1. the REQUEST's declared mode (`?intentMode=`, the eight §8 modes — the
 *      sender lane P31 built) — the most current statement there is;
 *   2. otherwise the viewer's own ACTIVE, EXPLICIT §8 availability window
 *      (services/passport/OpenToPlansService.getActiveWindows, `source =
 *      'explicit'` only — a plan-derived window is an inference, not a
 *      statement, and Passport's own `explicitIntentBoost` makes the same cut).
 *
 * Generic long-term interests (`compass_user_preferences.interests`) are NOT an
 * intent source: they are what the intent must outweigh.
 *
 * THE EIGHT PROFILES ARE CONSUMED, NOT RESTATED. Each mode's axis weights are
 * copied from lib/discoveryLiveRank INTENT_MODE_PROFILES at call time; this
 * file adds only what that table cannot say for a place with no live state:
 * which category/tag slugs ARE a mode's crowd preference (MODE_KEYWORDS), for
 * the three modes whose profile weights compatibility at all. `explore` weights
 * it 0 ("no crowd preference at all"), so Explore ranks on its other axes —
 * reachability and timing — exactly as its profile says, and no novelty
 * preference is invented for it.
 *
 * NOTHING HERE REACHES A PUBLIC REASON. `intentMatch` is listed as NO CODE in
 * lib/discoveryReasonCodes UNMAPPED_SIGNALS: the viewer's own chip is not a
 * reason `01` §11's nine describe, and a window's intents are §8 private
 * context.
 */
import { INTENT_MODE_PROFILES } from "./discoveryLiveRank.js";
import { parseIntentMode, type IntentMode } from "./intentModes.js";
import type { RankIntent, RankIntentMode } from "./portavaRank.js";
import { getActiveWindows, type IntentType } from "../services/passport/OpenToPlansService.js";

/**
 * The category/tag slugs whose presence is a mode's declared crowd preference.
 * Only the three modes whose profile weights `compatibility` above zero need
 * one (quiet, social, high_energy); every other mode's compatibility weight is
 * 0 in INTENT_MODE_PROFILES, so a list there would be read by nothing.
 */
export const MODE_KEYWORDS: Readonly<Partial<Record<IntentMode, readonly string[]>>> = Object.freeze({
  quiet: ["cafe", "library", "museum", "gallery", "park", "garden", "viewpoint", "spa", "bookshop", "place_of_worship", "temple", "culture", "nature_reserve", "tea"],
  social: ["bar", "pub", "restaurant", "food", "food_court", "market", "marketplace", "biergarten", "beer_garden", "community_centre", "events"],
  high_energy: ["nightlife", "nightclub", "club", "live_music", "music_venue", "festival", "theme_park", "stadium", "karaoke", "dance"],
});

/** One mode, resolved from its own profile. */
export function resolveIntentMode(mode: IntentMode): RankIntentMode {
  const p = INTENT_MODE_PROFILES[mode];
  return {
    mode,
    weights: { ...p.weights },
    keywords: MODE_KEYWORDS[mode] ?? [],
  };
}

/**
 * §8 window intents (OpenToPlansService INTENT_TYPES) → modes and direct hints.
 * A hint is a thing to DO (Food → food); a mode is how it should FEEL (Nightlife
 * → High Energy). Total over the six types.
 */
export const WINDOW_INTENT_TO_RANK: Readonly<Record<IntentType, { mode: IntentMode | null; hints: readonly string[] }>> = Object.freeze({
  Food: { mode: null, hints: ["food", "restaurant", "cafe"] },
  Drinks: { mode: "social", hints: ["bar", "pub"] },
  Nightlife: { mode: "high_energy", hints: ["nightlife"] },
  Explore: { mode: "explore", hints: [] },
  Events: { mode: null, hints: ["events"] },
  MeetTravelers: { mode: "social", hints: [] },
});

/** Build the intent from a request mode. Unknown / absent ⇒ null. */
export function intentFromRequestMode(raw: unknown): RankIntent | null {
  const mode = parseIntentMode(raw);
  if (!mode) return null;
  return { source: "request", modes: [resolveIntentMode(mode)], categoryHints: [] };
}

/** Build the intent from a window's declared intents. None ⇒ null. */
export function intentFromWindowIntents(intents: readonly string[]): RankIntent | null {
  const modes = new Map<IntentMode, RankIntentMode>();
  const hints = new Set<string>();
  for (const i of intents) {
    const m = (WINDOW_INTENT_TO_RANK as Record<string, { mode: IntentMode | null; hints: readonly string[] }>)[i];
    if (!m) continue;
    if (m.mode && !modes.has(m.mode)) modes.set(m.mode, resolveIntentMode(m.mode));
    for (const h of m.hints) hints.add(h);
  }
  if (modes.size === 0 && hints.size === 0) return null;
  return { source: "passport_window", modes: [...modes.values()], categoryHints: [...hints] };
}

export interface ViewerIntentRead {
  intent: RankIntent | null;
  /** Which source answered; `none` when neither did. */
  source: "request" | "passport_window" | "none";
}

/**
 * The viewer's explicit current intent. Never throws: a window read that fails
 * is logged by OpenToPlansService and reads as "no window", which is today's
 * behaviour — no intent term at all — never a guessed one.
 */
export async function loadViewerIntent(
  sc: any, viewerId: string, requestMode: unknown, nowMs: number,
): Promise<ViewerIntentRead> {
  const fromRequest = intentFromRequestMode(requestMode);
  if (fromRequest) return { intent: fromRequest, source: "request" };
  if (!sc || !viewerId) return { intent: null, source: "none" };
  try {
    const windows = await getActiveWindows(sc, viewerId, nowMs);
    const explicit = windows.filter((w) => w.source === "explicit");
    const intent = intentFromWindowIntents(explicit.flatMap((w) => w.intents));
    return intent ? { intent, source: "passport_window" } : { intent: null, source: "none" };
  } catch {
    return { intent: null, source: "none" };
  }
}
