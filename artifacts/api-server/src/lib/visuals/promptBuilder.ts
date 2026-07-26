/**
 * Deterministic prompt builders for events and places.
 *
 * Raw user text is NEVER sent as the complete provider prompt. Everything is routed
 * through a controlled template + the server-side style instruction. Shared negative
 * constraints keep output safe for UI overlay and truthful for real places.
 *
 * ## Specific real-place policy
 * When `snapshot.isSpecificRealPlace` is true, text-only generation is BLOCKED.
 * `buildPlacePrompt` returns `null` unless `snapshot.referenceImageUrls` contains
 * at least one verified reference image URL. When references are present, the prompt
 * is reference-grounded and follows strict truthfulness rules.
 */
import type { VisualInputSnapshot } from "./types.js";
import { styleInstruction, styleIsIllustrated } from "./styles.js";

export const EVENT_PROMPT_VERSION = "event-header-v1";
export const PLACE_PROMPT_VERSION = "place-header-v1";
export const GENERIC_PROMPT_VERSION = "generic-header-v1";

/** Composition + safety constraints applied to every generated header. */
export const NEGATIVE_PROMPT = [
  "no readable text",
  "no logos",
  "no watermarks",
  "no app interface or UI chrome",
  "no close-up identifiable faces",
  "no real business signage",
  "no misleading documentary claim",
].join(", ");

const COMPOSITION = [
  "Wide landscape composition for a mobile card and detail-page hero.",
  "Clear focal point with safe negative space for UI overlays.",
  "No readable text, logos, watermarks, or app interface.",
  "No close-up identifiable faces.",
  "High-quality, polished travel-editorial appearance.",
].join(" ");

function peopleClause(s: VisualInputSnapshot): string {
  if (s.people === "no_people") return "Show the setting without people.";
  if (s.people === "people")
    return "Where people appear, depict diverse adults naturally; this is an adult social context.";
  return "If people appear, depict diverse adults naturally.";
}

function lines(pairs: Array<[string, string | null | undefined]>): string {
  return pairs
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([label, v]) => `${label}: ${v}`)
    .join("\n");
}

export function buildEventPrompt(s: VisualInputSnapshot): string {
  const style = styleInstruction(s.style);
  const body = lines([
    ["Event type", [s.category, s.subcategory].filter(Boolean).join(" / ") || null],
    ["Title context", s.title],
    ["Location context", [s.city, s.neighborhood, s.country].filter(Boolean).join(", ") || null],
    ["Time context", s.timeOfDay],
    ["Setting", s.setting],
    ["Activity", s.description],
  ]);
  return [
    `Create a premium, ${styleIsIllustrated(s.style) ? "illustrated" : "realistic"} editorial travel-lifestyle header image for a social event.`,
    body,
    `Visual style: ${style}.`,
    peopleClause(s),
    COMPOSITION,
    "Do not render the event title as text inside the image.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build a place prompt.
 *
 * Returns `null` when `snapshot.isSpecificRealPlace` is true and no reference
 * images are available — text-only AI generation is blocked for specific named
 * real-world places to prevent fabricated imagery.
 *
 * When reference images are present for a specific real place, returns a strict
 * reference-grounded prompt that follows all spec truthfulness rules.
 */
export function buildPlacePrompt(s: VisualInputSnapshot): string | null {
  const refUrls = s.referenceImageUrls ?? [];

  // ── Specific real-place policy ────────────────────────────────────────────
  if (s.isSpecificRealPlace) {
    if (refUrls.length === 0) {
      // Block: text-only generation is forbidden for specific named places.
      return null;
    }
    // Reference-grounded prompt: strictly preserves defining characteristics.
    return buildReferenceGroundedPlacePrompt(s, refUrls);
  }

  // ── Generic / category-based place (not a specific named real place) ──────
  const style = styleInstruction(s.style);
  const descriptor = [s.subcategory ?? s.category, s.venue].filter(Boolean).join(" ");
  const body = lines([
    ["Category", [s.category, s.subcategory].filter(Boolean).join(" / ") || null],
    ["Location context", [s.city, s.neighborhood, s.country].filter(Boolean).join(", ") || null],
    ["Setting", s.setting],
    ["Notable traits", s.traits && s.traits.length ? s.traits.join(", ") : null],
    ["Amenities", s.amenities && s.amenities.length ? s.amenities.join(", ") : null],
    ["Price level", s.priceLevel],
  ]);
  return [
    `Create a premium ${styleIsIllustrated(s.style) ? "illustrated" : "editorial"} representation of a ${descriptor || "place"}${
      s.city ? ` in ${s.city}${s.country ? `, ${s.country}` : ""}` : ""
    }.`,
    body,
    `Visual style: ${style}.`,
    peopleClause(s),
    "This is a category-based visual representation, not a documentary image of the actual venue.",
    COMPOSITION,
    "No claim that the scene is the real location; no real signage or business logo.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build a strict reference-grounded prompt for a specific named real place.
 *
 * Prompt rules (spec §PROMPT RULES):
 *   - Uses the supplied verified reference images as the visual foundation.
 *   - Preserves exact defining characteristics visible in the references.
 *   - Does NOT invent structures, landmarks, or features not in the references.
 *   - Does NOT alter the location, orientation, or setting.
 *   - Maintains photographic truthfulness throughout.
 *   - Signals the source count so the provider knows references were supplied.
 */
function buildReferenceGroundedPlacePrompt(
  s: VisualInputSnapshot,
  referenceImageUrls: string[],
): string {
  const style = styleInstruction(s.style);
  const placeName = s.title ?? s.venue ?? "this place";
  const locationStr = [s.city, s.country].filter(Boolean).join(", ");
  const refCount = referenceImageUrls.length;

  const body = lines([
    ["Place name", placeName],
    ["Location", locationStr || null],
    ["Category", [s.category, s.subcategory].filter(Boolean).join(" / ") || null],
    ["Setting", s.setting],
    ["Notable traits", s.traits && s.traits.length ? s.traits.join(", ") : null],
  ]);

  return [
    `Create a premium editorial header image of ${placeName}${locationStr ? ` in ${locationStr}` : ""}.`,
    `This image MUST be grounded in the ${refCount} verified reference image${refCount !== 1 ? "s" : ""} provided.`,
    body,
    "STRICT TRUTHFULNESS RULES:",
    "- Preserve the exact defining visual characteristics shown in the reference images.",
    "- Do NOT invent structures, landmarks, or features that are not present in the references.",
    "- Do NOT alter the location, geographical setting, or orientation of the place.",
    "- Do NOT replace, remove, or add major architectural or natural features.",
    "- Maintain photographic truthfulness: this must look like the actual place.",
    "- The output will be labelled as an AI-enhanced representation; ensure it is faithful.",
    `Visual style: ${style}.`,
    peopleClause(s),
    COMPOSITION,
    "No readable text or logos. Do not add signage that is not in the reference images.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildGenericPrompt(s: VisualInputSnapshot): string {
  const style = styleInstruction(s.style);
  const body = lines([
    ["Subject", s.title],
    ["Category", s.category],
    ["Location context", [s.city, s.country].filter(Boolean).join(", ") || null],
  ]);
  return [
    `Create a premium editorial travel header image.`,
    body,
    `Visual style: ${style}.`,
    peopleClause(s),
    COMPOSITION,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Dispatch by purpose.
 *
 * Returns `null` when generation is blocked — callers must handle null and
 * route to a category_fallback or map_fallback instead of calling the provider.
 */
export function buildPrompt(s: VisualInputSnapshot): string | null {
  switch (s.purpose) {
    case "event_header":
      return buildEventPrompt(s);
    case "place_header":
      return buildPlacePrompt(s);
    default:
      return buildGenericPrompt(s);
  }
}

export function promptVersionFor(purpose: VisualInputSnapshot["purpose"]): string {
  if (purpose === "event_header") return EVENT_PROMPT_VERSION;
  if (purpose === "place_header") return PLACE_PROMPT_VERSION;
  return GENERIC_PROMPT_VERSION;
}
