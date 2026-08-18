/**
 * nominatimName — choose the name a user should read.
 *
 * searchNominatim sends `Accept-Language: en`, and Nominatim honours it: for
 * Bangkok it returns display_name "Bangkok, Thailand" and address.city
 * "Bangkok". It ALSO returns namedetails.name — the raw local-script name,
 * "กรุงเทพมหานคร" — which is the one field in the response that is not
 * localised.
 *
 * normalizeNominatim read that field FIRST. So a user in an English UI
 * searching for their own city was offered a Thai-script row they may not
 * recognise, on the one query path that worked at all. The header asked for a
 * language and the code then preferred the field that ignores it.
 *
 * Order below: the exact localised name, then the localised primary label, then
 * localised address components, and only then the local-script name — reached
 * when no localisation exists at all, which is the case the header cannot help
 * with.
 *
 * The local name is NOT discarded. It is returned alongside as `localName`, so
 * a surface that wants to show "Bangkok (กรุงเทพมหานคร)" can, and a user who
 * recognises only the local script is not left without it.
 */

export interface NominatimNameInput {
  namedetails?: Record<string, string> | null;
  display_name?: string | null;
  address?: Record<string, string | undefined> | null;
}

export interface ChosenName {
  /** What to show. Localised when any localisation exists. */
  name: string;
  /**
   * The local-script name, when it differs from `name`. Null when there is no
   * distinct local name — never a duplicate of `name`, so a caller can render
   * it unconditionally without producing "Paris (Paris)".
   */
  localName: string | null;
}

const UNKNOWN = "Unknown";

/**
 * @param lang BCP-47 primary subtag matching the Accept-Language sent with the
 *             request. Defaults to "en" because that is what searchNominatim
 *             asks for.
 */
export function pickLocalisedName(raw: NominatimNameInput, lang = "en"): ChosenName {
  const nd = raw.namedetails ?? {};
  const addr = raw.address ?? {};
  const localName = typeof nd.name === "string" && nd.name.trim() ? nd.name.trim() : null;

  const localisedExact = nd[`name:${lang}`];
  const displayPrimary = (raw.display_name ?? "").split(",")[0]?.trim() || undefined;
  const addressName =
    addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? undefined;

  const name =
    firstNonEmpty(localisedExact, displayPrimary, addressName, localName ?? undefined) ?? UNKNOWN;

  return {
    name,
    // Only surface the local name when it actually differs from what is shown.
    localName: localName && localName !== name ? localName : null,
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}
