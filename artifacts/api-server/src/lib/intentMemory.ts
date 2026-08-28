/**
 * Intent memory — the request-time producer for layer L5 (spec §5.5, §9).
 *
 * The projector (2184/2186) derives DURABLE memory from canonical facts on a
 * 6-hour cadence. Intent is the opposite: it is what the traveller appears to
 * want RIGHT NOW, derived from the immediate request, and it must decay fast.
 * This module turns a Compass question into a bounded intent signal and hands it
 * to record_intent_memory (2189), which always writes it as ephemeral memory
 * with a clamped TTL.
 *
 * Why a deterministic classifier and not the model: intent capture runs on the
 * ask path, so it must be cheap, predictable and free of an extra network call
 * that could slow or fail a chat turn. A keyword classifier is also unit-testable
 * and cannot hallucinate an intent the user never expressed.
 *
 * Safety / spec rules honoured here:
 *  - §9 "decays aggressively": TTL defaults to 90 min and the SQL clamps it.
 *  - §24 "do not turn every short-term intent into a durable personality trait":
 *    the SQL hard-codes retention_class='ephemeral'; this module cannot override it.
 *  - §7 "do not equate exposure with awareness": only an explicit question
 *    produces intent — never a passive impression.
 *  - Flag-gated and fire-and-forget: never throws, never blocks a chat turn.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Intent categories, aligned with the vibe/category vocabulary already in use. */
export const INTENT_TYPES = [
  "nightlife", "food", "coffee", "outdoors", "culture",
  "shopping", "wellness", "social", "transit", "stay",
] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

/** Default lifetime of a captured intent, in minutes (SQL clamps to [5,720]). */
export const INTENT_TTL_MINUTES = 90;

/**
 * Keyword table. Ordered by specificity: the first category with a match wins,
 * so "coffee" beats the broader "food" for "where's good coffee".
 */
const INTENT_KEYWORDS: ReadonlyArray<readonly [IntentType, readonly string[]]> = [
  ["coffee",    ["coffee", "cafe", "café", "espresso", "flat white", "brunch spot"]],
  ["nightlife", ["nightlife", "night life", "bar", "bars", "club", "clubbing", "party", "drinks", "pub", "cocktail", "rooftop"]],
  ["food",      ["eat", "food", "restaurant", "dinner", "lunch", "breakfast", "hungry", "cuisine", "street food", "seafood", "vegan", "vegetarian"]],
  ["outdoors",  ["hike", "hiking", "beach", "trail", "outdoors", "nature", "waterfall", "sunrise", "sunset", "island", "dive", "diving", "surf"]],
  ["culture",   ["museum", "gallery", "temple", "history", "historic", "culture", "cultural", "art", "architecture", "monument"]],
  ["shopping",  ["shop", "shopping", "market", "mall", "souvenir", "boutique"]],
  ["wellness",  ["spa", "massage", "yoga", "gym", "wellness", "retreat", "meditation"]],
  ["social",    ["meet", "meetup", "people", "friends", "travellers", "travelers", "solo", "group", "hang out", "hangout"]],
  ["transit",   ["how do i get", "getting around", "transport", "taxi", "grab", "bus", "train", "metro", "airport", "flight"]],
  ["stay",      ["hotel", "hostel", "stay", "accommodation", "airbnb", "where to sleep", "guesthouse"]],
];

/**
 * Classify a free-text question into at most one intent type.
 * Returns null when nothing matches — silence is better than a wrong intent,
 * because a wrong intent would steer later answers.
 */
export function classifyIntent(text: string | null | undefined): IntentType | null {
  if (typeof text !== "string") return null;
  const t = text.toLowerCase();
  if (t.trim().length === 0) return null;
  for (const [type, words] of INTENT_KEYWORDS) {
    for (const w of words) {
      if (t.includes(w)) return type;
    }
  }
  return null;
}

/**
 * Capture intent from a Compass question. Fire-and-forget: resolves false and
 * never throws, so a failure here can never break a chat turn.
 *
 * `sc` must be the service-role client — record_intent_memory is service_role
 * only and takes the caller's id as a parameter, so `userId` must come from the
 * authenticated session, never from client input.
 */
export async function recordIntentFromQuery(
  sc: SupabaseClient,
  userId: string,
  question: string | null | undefined,
  opts: { city?: string | null; ttlMinutes?: number } = {},
): Promise<boolean> {
  try {
    const intent = classifyIntent(question);
    if (!intent) return false;

    const city = typeof opts.city === "string" ? opts.city.trim() : "";
    // Content is a short, derived label — never the raw question, which could
    // carry personal detail into a stored memory row.
    const content = city ? `Looking for ${intent} in ${city}` : `Looking for ${intent}`;

    const { data, error } = await sc.rpc("record_intent_memory", {
      p_user_id: userId,
      p_intent_type: intent,
      p_content: content,
      p_ttl_minutes: opts.ttlMinutes ?? INTENT_TTL_MINUTES,
      p_confidence: 0.6,
      p_enforce_flag: true,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false; // never fatal
  }
}
