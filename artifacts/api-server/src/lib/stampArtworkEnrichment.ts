/**
 * stampArtworkEnrichment — pure helper that attaches AI universal artwork
 * URLs (from Stamp System v2 definitions) onto legacy PassportStamp rows
 * served by GET /me/stamps.
 *
 * Legacy stamps have no stamp_definition link, so matching is best-effort:
 *  - legacy `kind` maps to a v2 `stamp_type`
 *  - city stamps prefer a user_stamp in the same city (label vs city name)
 *  - otherwise fall back to any artwork for that stamp_type
 */

/** legacy PassportStamp.kind -> v2 stamp_type */
const KIND_TO_TYPE: Record<string, string> = {
  city: "city",
  plan: "plan",
  gem:  "hidden_gem",
  safe: "safe_return",
  host: "host",
  perk: "perk",
};

export interface ArtworkSourceRow {
  /** city of the user_stamp row, if any */
  city: string | null;
  /** stamp_type of the joined definition */
  stampType: string | null;
  /** AI universal artwork URL of the joined definition */
  universalArtworkUrl: string | null;
}

export interface LegacyStampLike {
  kind: string;
  label: string;
  [key: string]: unknown;
}

/**
 * Returns a new array where each legacy stamp gains `universalArtworkUrl`
 * when a matching artwork source exists (undefined otherwise, so JSON
 * serialization simply omits it).
 */
export function attachUniversalArtwork<T extends LegacyStampLike>(
  stamps: T[],
  sources: ArtworkSourceRow[],
): (T & { universalArtworkUrl?: string })[] {
  const byTypeAndCity = new Map<string, string>();
  const byType = new Map<string, string>();

  for (const s of sources) {
    if (!s.universalArtworkUrl || !s.stampType) continue;
    if (!byType.has(s.stampType)) byType.set(s.stampType, s.universalArtworkUrl);
    if (s.city) {
      const key = `${s.stampType}:${s.city.trim().toLowerCase()}`;
      if (!byTypeAndCity.has(key)) byTypeAndCity.set(key, s.universalArtworkUrl);
    }
  }

  return stamps.map((stamp) => {
    const type = KIND_TO_TYPE[stamp.kind] ?? stamp.kind;
    const cityKey = `${type}:${(stamp.label ?? "").trim().toLowerCase()}`;
    const url = byTypeAndCity.get(cityKey) ?? byType.get(type);
    return url ? { ...stamp, universalArtworkUrl: url } : stamp;
  });
}
