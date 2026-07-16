/**
 * Stamp motif resolver (Level 1 art).
 *
 * A stamp's look comes from:
 *   1. City-specific motif (if the stamp references a known city) — icon + accent
 *      derived from provisional knowledge. Marked provisional so UI can show
 *      "Starter city notes".
 *   2. Category motif fallback (kind-based) — always available, never provisional.
 *
 * Returns icon KEYS (resolved to lucide components in the component) so this
 * file stays presentation-free and portable. Level 2 (custom SVG frames per
 * city) can later extend StampMotif without touching callers.
 */
import type { PassportStamp, StampKind, StampMotif } from '../types/models.ts';
import { knowledgeFor } from '../data/knowledge.ts';

/* City slug -> signature icon + accent. Hand-seeded, provisional. */
const CITY_MOTIF: Record<string, { iconKey: string; accent: string; caption: string }> = {
  cebu: { iconKey: 'Fish', accent: '#0A3D4A', caption: 'DIVING' },
  manila: { iconKey: 'Landmark', accent: '#7A4DBF', caption: 'HISTORY' },
  tokyo: { iconKey: 'TorusIcon', accent: '#C0392B', caption: 'TEMPLES' },
  bangkok: { iconKey: 'Soup', accent: '#C8851A', caption: 'STREET FOOD' },
};

/* Category fallback motif by stamp kind. Never provisional. */
const KIND_MOTIF: Record<StampKind, { iconKey: string; accent: string }> = {
  city: { iconKey: 'MapPin', accent: '#0A3D4A' },
  plan: { iconKey: 'Users', accent: '#FF4D2E' },
  gem: { iconKey: 'Gem', accent: '#7A4DBF' },
  safe: { iconKey: 'ShieldCheck', accent: '#2E7D5B' },
  host: { iconKey: 'Crown', accent: '#11110F' },
  perk: { iconKey: 'Ticket', accent: '#C8851A' },
};

/**
 * Try to read a city slug from a stamp. City stamps encode the place in
 * label/sublabel; we match against known cities. Loose by design — falls back
 * to category motif when no city is recognized.
 */
function citySlugFromStamp(stamp: PassportStamp): string | undefined {
  const hay = `${stamp.label} ${stamp.sublabel ?? ''}`.toLowerCase();
  for (const slug of Object.keys(CITY_MOTIF)) {
    if (hay.includes(slug)) return slug;
  }
  return undefined;
}

export function motifFor(stamp: PassportStamp): StampMotif {
  // City stamps get the city motif when recognized.
  if (stamp.kind === 'city') {
    const slug = citySlugFromStamp(stamp);
    if (slug) {
      const m = CITY_MOTIF[slug];
      const k = knowledgeFor(slug);
      return {
        iconKey: m.iconKey,
        accent: m.accent,
        frame: 'oval',
        caption: m.caption,
        provisional: k ? k.status !== 'verified' : true,
      };
    }
  }
  // Fallback: category motif (rectangular frame to visually differ from cities).
  const k = KIND_MOTIF[stamp.kind];
  return { iconKey: k.iconKey, accent: k.accent, frame: 'rect', provisional: false };
}
