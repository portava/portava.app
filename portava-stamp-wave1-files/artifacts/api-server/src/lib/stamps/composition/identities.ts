/**
 * Destination identity resolution — Stamp Wave 1.
 *
 * Every stamp's colors are DELIBERATE, never invented per-generation:
 *   1. catalog.identity_key override → destination_identities row
 *   2. city/country match against destination_identities
 *   3. deterministic curated fallback palette (hash of the location key picks
 *      one of eight hand-built palettes — same destination always gets the
 *      same palette, and every palette was chosen by a human)
 *
 * HONESTY NOTE: fallback palettes are labeled source:'fallback' in the
 * composition manifest so admin tooling can surface which destinations still
 * need a hand-authored identity.
 */

export interface StampPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  border: string;
  highlight: string;
  paper: string;
}

export interface DestinationIdentity {
  identityKey: string;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  palette: StampPalette;
  motif: string;
  wideFocus: number;
  /** 'db' = destination_identities row; 'seed' = built-in launch identity; 'fallback' = curated generic palette */
  source: "db" | "seed" | "fallback";
}

// ── Launch seeds (mirror the 0177 destination_identities seed rows) ──────────
// Kept in code as well so composition works even before 0177 has run, and in
// tests without a DB. DB rows always win when present.

export const SEED_IDENTITIES: Record<string, Omit<DestinationIdentity, "source">> = {
  "tokyo-jp": {
    identityKey: "tokyo-jp", city: "Tokyo", country: "Japan", countryCode: "JP",
    palette: { primary: "#2B3A67", secondary: "#C63D2F", accent: "#F5B7C5", background: "#1A2447", border: "#2B3A67", highlight: "#E8B04B", paper: "#F6F1E7" },
    motif: "tokyo", wideFocus: 0.48,
  },
  "cebu-ph": {
    identityKey: "cebu-ph", city: "Cebu", country: "Philippines", countryCode: "PH",
    palette: { primary: "#0E7490", secondary: "#14B8A6", accent: "#F4A73B", background: "#0A5A73", border: "#0E7490", highlight: "#FCD34D", paper: "#F4FAF8" },
    motif: "cebu", wideFocus: 0.52,
  },
  "paris-fr": {
    identityKey: "paris-fr", city: "Paris", country: "France", countryCode: "FR",
    palette: { primary: "#1F2A50", secondary: "#7C2D3E", accent: "#C9A227", background: "#EFE7D5", border: "#1F2A50", highlight: "#C9A227", paper: "#F7F2E6" },
    motif: "paris", wideFocus: 0.66,
  },
  "bangkok-th": {
    identityKey: "bangkok-th", city: "Bangkok", country: "Thailand", countryCode: "TH",
    palette: { primary: "#8C2F1B", secondary: "#D97706", accent: "#EBB434", background: "#5C1A10", border: "#8C2F1B", highlight: "#F3C969", paper: "#FBF4E4" },
    motif: "bangkok", wideFocus: 0.5,
  },
  "reykjavik-is": {
    identityKey: "reykjavik-is", city: "Reykjavík", country: "Iceland", countryCode: "IS",
    palette: { primary: "#0B3B5A", secondary: "#0FA3B1", accent: "#7CE577", background: "#071B2E", border: "#0B3B5A", highlight: "#B7F0EE", paper: "#EFF6F9" },
    motif: "iceland", wideFocus: 0.45,
  },
};

// ── Curated fallback palettes ────────────────────────────────────────────────
// Eight hand-built palettes spanning warm/cool/neutral moods. A destination
// without an authored identity hashes onto one of these deterministically.

const FALLBACK_PALETTES: StampPalette[] = [
  { primary: "#1E3A5F", secondary: "#3B82A0", accent: "#E8B04B", background: "#152C49", border: "#1E3A5F", highlight: "#9FD0E8", paper: "#F2F6F8" }, // harbor blue
  { primary: "#5B3A29", secondary: "#A0653B", accent: "#E0A94F", background: "#402818", border: "#5B3A29", highlight: "#F0C987", paper: "#F8F2E9" }, // terracotta
  { primary: "#284B3C", secondary: "#3F7D5C", accent: "#D9A441", background: "#1B3A2C", border: "#284B3C", highlight: "#A8D5B9", paper: "#F1F7F2" }, // rainforest
  { primary: "#4A2C5B", secondary: "#7B4B9E", accent: "#E8C24B", background: "#351F44", border: "#4A2C5B", highlight: "#CBA8E0", paper: "#F6F2F8" }, // dusk violet
  { primary: "#7A2E35", secondary: "#B04A4A", accent: "#E8B85A", background: "#571F26", border: "#7A2E35", highlight: "#F0A8A0", paper: "#FAF2EE" }, // spice red
  { primary: "#1F5F63", secondary: "#2E8C8C", accent: "#F0A345", background: "#144548", border: "#1F5F63", highlight: "#8FD8D0", paper: "#F0F8F7" }, // lagoon teal
  { primary: "#3D4A21", secondary: "#6B7F3A", accent: "#D9B23D", background: "#2B3517", border: "#3D4A21", highlight: "#C2CF8F", paper: "#F6F8EE" }, // olive grove
  { primary: "#33415C", secondary: "#5C6B8C", accent: "#D98E4A", background: "#242E42", border: "#33415C", highlight: "#AEBBD6", paper: "#F3F5F8" }, // slate coast
];

/** Deterministic non-crypto hash (FNV-1a) so palette choice is stable per key. */
export function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface IdentityLookupEntry {
  identity_key?: string | null;
  display_name?: string | null;
  city?: string | null;
  country?: string | null;
  country_code?: string | null;
  canonical_location_key?: string | null;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** Match a catalog entry against the seed identities (city or country-level). */
export function matchSeedIdentity(entry: IdentityLookupEntry): DestinationIdentity | null {
  const city = norm(entry.city) || norm(entry.display_name);
  const cc = norm(entry.country_code);
  for (const seed of Object.values(SEED_IDENTITIES)) {
    if (city && norm(seed.city) === city && (!cc || norm(seed.countryCode) === cc)) {
      return { ...seed, source: "seed" };
    }
  }
  return null;
}

/** Deterministic curated fallback identity for destinations without an authored one. */
export function fallbackIdentity(entry: IdentityLookupEntry): DestinationIdentity {
  const key =
    norm(entry.canonical_location_key) ||
    `${norm(entry.display_name)}|${norm(entry.country_code)}` ||
    "unknown";
  const palette = FALLBACK_PALETTES[stableHash(key) % FALLBACK_PALETTES.length];
  return {
    identityKey: `fallback:${key}`,
    city: entry.city ?? entry.display_name ?? null,
    country: entry.country ?? null,
    countryCode: entry.country_code?.toUpperCase() ?? null,
    palette,
    motif: "generic",
    wideFocus: 0.45,
    source: "fallback",
  };
}

function isPalette(v: unknown): v is StampPalette {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return ["primary", "secondary", "accent", "background", "border", "highlight", "paper"]
    .every((k) => typeof p[k] === "string" && /^#[0-9a-fA-F]{6}$/.test(p[k] as string));
}

/**
 * Resolve the identity for a catalog entry. `sc` may be null (tests / pre-0177
 * environments) — resolution then uses seeds + fallback only. Any DB error
 * degrades silently to seed/fallback (composition must never fail on identity
 * lookup).
 */
export async function resolveIdentity(sc: any, entry: IdentityLookupEntry): Promise<DestinationIdentity> {
  if (sc) {
    try {
      // 1. Explicit identity_key override on the catalog row.
      if (entry.identity_key) {
        const { data } = await sc
          .from("destination_identities")
          .select("identity_key, city, country, country_code, palette, motif, wide_focus")
          .eq("identity_key", entry.identity_key)
          .eq("status", "active")
          .maybeSingle();
        if (data && isPalette((data as any).palette)) return rowToIdentity(data);
      }
      // 2. City + country match.
      const city = (entry.city ?? entry.display_name ?? "").trim();
      const cc = (entry.country_code ?? "").trim().toUpperCase();
      if (city) {
        let q = sc
          .from("destination_identities")
          .select("identity_key, city, country, country_code, palette, motif, wide_focus")
          .ilike("city", city)
          .eq("status", "active")
          .limit(1);
        if (cc) q = q.eq("country_code", cc);
        const { data } = await q.maybeSingle();
        if (data && isPalette((data as any).palette)) return rowToIdentity(data);
      }
    } catch {
      // fall through to seed/fallback
    }
  }
  return matchSeedIdentity(entry) ?? fallbackIdentity(entry);
}

function rowToIdentity(row: any): DestinationIdentity {
  return {
    identityKey: row.identity_key,
    city: row.city ?? null,
    country: row.country ?? null,
    countryCode: row.country_code ?? null,
    palette: row.palette as StampPalette,
    motif: row.motif ?? "generic",
    wideFocus: typeof row.wide_focus === "number" ? row.wide_focus : Number(row.wide_focus ?? 0.45),
    source: "db",
  };
}
