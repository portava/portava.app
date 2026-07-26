/**
 * Server-side visual style system.
 *
 * Clients send only an approved style ID; the actual style instruction text lives
 * here and never leaves the server. Unknown/unsafe styles fall back to the default.
 */
import type { VisualStyle } from "./types.js";

export const DEFAULT_STYLE: VisualStyle = "portava_editorial";

const STYLE_INSTRUCTIONS: Record<VisualStyle, string> = {
  portava_editorial:
    "premium realistic editorial travel-lifestyle photography, natural light, refined color grade, magazine-quality composition",
  cinematic_travel:
    "cinematic travel photography, dramatic natural lighting, wide anamorphic feel, rich but believable color",
  premium_nightlife:
    "upscale nightlife atmosphere, warm ambient and neon accent lighting, elegant crowd energy, tasteful and non-explicit",
  tropical_social:
    "bright tropical coastal mood, golden-hour warmth, relaxed social atmosphere, lush natural tones",
  urban_explorer:
    "modern urban exploration, clean architectural lines, street-level energy, contemporary editorial look",
  food_and_dining:
    "appetizing food-and-dining editorial, fresh plating, warm inviting interior light, shallow depth of field",
  outdoor_adventure:
    "expansive outdoor adventure landscape, crisp natural light, active exploratory mood",
  minimal_illustration:
    "clean minimal vector-style illustration, flat cohesive palette, simple iconic shapes, no photographic realism",
  passport_poster:
    "vintage travel-poster illustration, bold flat shapes, limited retro palette, stamp-and-passport aesthetic",
  colorful_festival:
    "vibrant festival atmosphere, saturated celebratory color, dynamic energetic composition",
};

const KNOWN = new Set(Object.keys(STYLE_INSTRUCTIONS) as VisualStyle[]);

export function isKnownStyle(style: string): style is VisualStyle {
  return KNOWN.has(style as VisualStyle);
}

/** Coerce any client-supplied style to a safe, known one. */
export function coerceStyle(style: string | null | undefined): VisualStyle {
  return style && isKnownStyle(style) ? style : DEFAULT_STYLE;
}

export function styleInstruction(style: VisualStyle): string {
  return STYLE_INSTRUCTIONS[style] ?? STYLE_INSTRUCTIONS[DEFAULT_STYLE];
}

/** true when the style is illustrated rather than photographic. */
export function styleIsIllustrated(style: VisualStyle): boolean {
  return style === "minimal_illustration" || style === "passport_poster";
}
