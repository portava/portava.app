/**
 * Stamp Art Direction — master prompt templates.
 *
 * All stamp artwork is generated via a single canonical prompt family so the
 * visual language is consistent across the whole catalog.
 *
 * Version this file: bump STYLE_VERSION whenever the prompt changes so the
 * generation worker can detect stale artwork.
 */

export const STYLE_VERSION = "v1.0";

/**
 * Returns true when an existing artwork row was generated with a different
 * style version than the current one, meaning the prompt has changed since
 * the row was produced and the artwork should be regenerated.
 *
 * A null / missing `prompt_template_version` is always treated as stale
 * (rows pre-dating the versioning scheme must be regenerated).
 */
export function isArtworkStale(
  row: { prompt_template_version?: string | null },
  currentVersion: string = STYLE_VERSION,
): boolean {
  return row.prompt_template_version !== currentVersion;
}

/** Number of candidate images generated per missing stamp. */
export const CANDIDATE_COUNT = 3;

export interface CatalogEntryForPrompt {
  id: string;
  display_name: string | null;
  country: string | null;
  country_code: string | null;
  region?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  stamp_type: string;
  canonical_location_key: string;
}

// ── Shared visual style instructions ─────────────────────────────────────────

const STYLE_PREAMBLE = `
Create a single premium collectible travel passport stamp with a transparent PNG background.
Visual style: vibrant destination-specific illustration, recognizable cultural and geographic motifs,
strong iconic silhouette, subtle authentic passport ink texture, modern polished finish.
Colors: bold, saturated palette true to the destination. No frames, no white borders.
The stamp must look like a physical ink stamp impression — circular ink bleed at the edges,
slight texture variation across the ink fill, authentic distressed-yet-premium feel.
`.trim();

const STYLE_SUFFIX = `
Output format: single stamp graphic on pure transparent background, square canvas 1024×1024 px.
No text outside the stamp boundary. No watermarks. No UI elements. No photography — illustration only.
`.trim();

// ── Type-specific shape instructions ─────────────────────────────────────────

function shapeInstruction(stampType: string): string {
  switch (stampType) {
    case "city":
    case "check_in":
      return "Shape: bold circular badge with concentric ring border detail.";
    case "country":
      return "Shape: rectangular passport-visa frame with ornate corner flourishes.";
    case "region":
      return "Shape: large oval with decorative border featuring regional motifs.";
    case "neighborhood":
      return "Shape: compact hexagonal badge with clean single-line border.";
    case "landmark":
      return "Shape: irregular organic silhouette echoing the landmark's form, with ink-splatter edge.";
    case "hidden_gem":
      return "Shape: diamond or irregular star with rough hand-carved edge.";
    case "special_event":
      return "Shape: festive pennant or ribbon-banner shape with dynamic edge.";
    default:
      return "Shape: classic circular stamp with double-ring border.";
  }
}

// ── Destination content instructions ─────────────────────────────────────────

function destinationInstruction(entry: CatalogEntryForPrompt): string {
  const parts: string[] = [];

  // Fallback chain: display_name → city → region → generic label.
  // A null display_name must never produce a literal "null" in the prompt.
  const destinationLabel =
    entry.display_name ?? entry.city ?? entry.region ?? "Unknown Destination";

  parts.push(`Destination: ${destinationLabel}`);

  if (entry.city) parts.push(`City: ${entry.city}`);
  if (entry.region) parts.push(`Region: ${entry.region}`);
  const countryCodeUpper = entry.country_code?.toUpperCase() ?? null;

  if (entry.country) {
    const codeLabel = countryCodeUpper ? ` (${countryCodeUpper})` : "";
    parts.push(`Country: ${entry.country}${codeLabel}`);
  } else if (countryCodeUpper) {
    parts.push(`Country: ${countryCodeUpper}`);
  }

  const typeHints: Record<string, string> = {
    city:          "Include iconic city skyline or landmark silhouette, local cultural symbol, and destination name in bold uppercase serif font prominently at center.",
    country:       "Include national symbol, flag colors as accent palette, country name in official script style. Use the country's most recognized single icon (e.g., Eiffel Tower for France, Mount Fuji for Japan).",
    region:        "Include regional landscape or natural feature, regional name in arched text along the top.",
    neighborhood:  "Include a street-level scene or local architectural detail unique to this neighborhood. Neighborhood name in clean sans-serif.",
    landmark:      "Feature the landmark as the dominant illustration filling most of the stamp area. Name beneath in small label text.",
    hidden_gem:    "Mysterious, intimate illustration — a secret alley, hidden waterfall, or local haunt. Evokes discovery and authenticity.",
    special_event: "Dynamic, celebratory imagery — confetti, lights, movement. Event name featured prominently.",
  };

  const hint = typeHints[entry.stamp_type] ?? typeHints.city;
  parts.push(hint);

  // Typography guidance
  const countryLabel = countryCodeUpper ? `Country label "${countryCodeUpper}" smaller below. ` : "";
  parts.push(
    `Typography: destination name "${destinationLabel}" prominent at center or arch-top. ` +
    `${countryLabel}Year optional.`
  );

  return parts.join("\n");
}

// ── Well-known landmark hints ─────────────────────────────────────────────────
// For country stamps, inject a single well-known landmark for recognizable destinations.

const COUNTRY_LANDMARK_HINTS: Record<string, string> = {
  PH: "Philippine archipelago coastline, jeepney, or sampaguita flowers",
  JP: "Mount Fuji silhouette and cherry blossom",
  FR: "Eiffel Tower",
  IT: "Colosseum",
  US: "Statue of Liberty or Grand Canyon",
  GB: "Big Ben clock tower",
  AU: "Sydney Opera House",
  TH: "Wat Arun temple spires",
  ID: "Borobudur temple or Bali rice terraces",
  SG: "Marina Bay Sands and merlion",
  MY: "Petronas Twin Towers",
  VN: "Ha Long Bay karst limestone islands",
  KR: "Gyeongbokgung Palace gates",
  ES: "Sagrada Família or flamenco dancer",
  DE: "Brandenburg Gate",
  IN: "Taj Mahal",
  CN: "Great Wall of China",
  MX: "Chichén Itzá pyramid",
  BR: "Christ the Redeemer statue",
  NZ: "Milford Sound fjord",
  CA: "Rocky Mountains and maple leaf",
};

function landmarkHint(entry: CatalogEntryForPrompt): string {
  if (entry.stamp_type !== "country") return "";
  if (!entry.country_code) return "Use a generalized destination motif representing the country's most iconic natural or cultural feature.";
  const hint = COUNTRY_LANDMARK_HINTS[entry.country_code.toUpperCase()];
  if (!hint) return "Use a generalized destination motif representing the country's most iconic natural or cultural feature.";
  return `Suggested landmark / motif: ${hint}.`;
}

// ── Main prompt builder ───────────────────────────────────────────────────────

/**
 * Build the DALL-E 3 prompt for a given catalog entry.
 *
 * Returns a single string ready to be passed to the image generation API.
 */
export function buildStampPrompt(entry: CatalogEntryForPrompt): string {
  const sections = [
    STYLE_PREAMBLE,
    shapeInstruction(entry.stamp_type),
    destinationInstruction(entry),
  ];

  const lm = landmarkHint(entry);
  if (lm) sections.push(lm);

  sections.push(STYLE_SUFFIX);

  return sections.join("\n\n");
}
