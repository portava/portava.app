/**
 * What a stamp READER may say about where a person has been —
 * census-highlights-memories H4, the reader half (wave 5, lane 5).
 *
 * H4: "Planned/saved/nearby never represented as 'experienced' without
 * occurrence evidence or user confirmation."
 *
 * The writers now hold that for every NEW award: a non-presence stamp carries
 * no place (§BD/§BG, the engine strip), a completion stamp needs a check-in on
 * its trip (wave 5, 60d199e2d), and the generic endpoints need evidence for a
 * place (presenceAwardEvidence.ts). The ROWS ALREADY WRITTEN do not:
 *
 *   - planning / contribution stamps (`trip_planner`, `first_trip_created`,
 *     `hidden_gem_explorer`, `first_postcard`) written before §BD carry the
 *     destination or the gem's city;
 *   - the nine completion stamps written before 60d199e2d were minted for every
 *     member of any trip whose end date passed, checked in or not;
 *   - a presence stamp an admin granted with a typed-in place carries it.
 *
 * Their repair is a production data change the owner has not made
 * (OD-1012-STAMP-4). Until then the readers are where the claim is made, so
 * this module is the ONE rule every reader applies:
 *
 *   A reader shows a stamp's PLACE — names it, counts it, pins it, keys a feed
 *   by it — only when the stamp is a presence stamp AND the occurrence evidence
 *   its own source names is read and holds for this person (stampOccurrence
 *   Evidence.ts: a check-in on the trip for a `trips` source, a GPS stamp-
 *   eligible unrevoked postcard for a `posts` source).
 *
 * Verdicts, per row:
 *   evidenced     presence slug, evidence read and present  → place shown
 *   not_presence  any other slug (unknown slugs included)   → place withheld
 *   unevidenced   presence slug, no evidence (or a source    → place withheld
 *                 that names none: admin, criteria, system)
 *   unverifiable  presence slug, its evidence table could    → place withheld
 *                 not be read
 *
 * WHAT A READER DOES WITH IT, by the shape of its output:
 *   - every reader: the place is withheld (`place`, `withPresencePlaces`);
 *   - a reader KEYED BY A PLACE (a city feed, a country feed, a Countries
 *     count, a "visited" edge, a "places you have both been" set, "a stamp
 *     earned in <place>") drops the rows whose place it may not show;
 *   - a reader that hands stamps to SOMEONE ELSE, or to a narrative, and is not
 *     paged by row offset drops a presence stamp whose evidence does not hold
 *     (`presenceClaimHolds`): its name alone claims the occurrence;
 *   - the OWNER's own row-offset-paged list (`GET /stamps/me`, usePassport
 *     pages on the number of rows received) keeps every row, place withheld: a
 *     hidden row would shift every later page. The residual there — the NAME
 *     of a historical completion stamp for a trip nobody took, shown to its
 *     owner — is the data repair's (OD-1012-STAMP-4), stated, not hidden.
 *
 * FAIL CLOSED. A missing slug reads as not presence. An unreadable evidence
 * table withholds the place of the rows it would have decided and is reported
 * in `unreadable`; it is never read as "evidenced", and never as "nobody".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPresenceStamp } from "./nonPresenceStampAwards.js";
import { evidenceKey, evidencePairOf, readOccurrenceEvidence, type EvidencePair } from "./stampOccurrenceEvidence.js";

export type StampPlaceVerdict = "evidenced" | "not_presence" | "unevidenced" | "unverifiable";

/** The fields a reader must select for a verdict. */
export interface StampPresenceRow {
  user_id?: unknown;
  source_type?: unknown;
  source_id?: unknown;
  /** The definition: an embed (`stamp_definitions(slug, …)`), possibly an array, or a slug string. */
  stamp_definitions?: unknown;
  /** A slug the reader resolved itself (when it reads definitions separately). */
  slug?: unknown;
}

/** The definition slug of a row, from an embed (object or one-element array) or a resolved `slug`. */
export function stampRowSlug(row: StampPresenceRow): string {
  if (typeof row.slug === "string") return row.slug;
  const def = Array.isArray(row.stamp_definitions) ? row.stamp_definitions[0] : row.stamp_definitions;
  return def && typeof (def as Record<string, unknown>).slug === "string" ? String((def as Record<string, unknown>).slug) : "";
}

/**
 * Presence by BOTH classifications when the reader has both: the code registry
 * (2970's presence-TRUE block, `isPresenceStamp`) and, when selected, the
 * database's own `evidences_presence`. Either saying "not presence" is enough.
 */
function isPresenceRow(row: StampPresenceRow): boolean {
  if (!isPresenceStamp(stampRowSlug(row))) return false;
  const def = Array.isArray(row.stamp_definitions) ? row.stamp_definitions[0] : row.stamp_definitions;
  const flag = def && typeof def === "object" ? (def as Record<string, unknown>).evidences_presence : undefined;
  return flag !== false;
}

export interface StampPresenceView {
  verdict(row: StampPresenceRow): StampPlaceVerdict;
  /** True only for `evidenced`. */
  mayShowPlace(row: StampPresenceRow): boolean;
  /**
   * False for a PRESENCE stamp whose evidence is absent or unreadable: its very
   * name ("First trip completed", "City Explorer") claims an occurrence nobody
   * evidenced. A reader that hands stamps to SOMEONE ELSE (another person, a
   * public page, the AI, a journey narrative) and is not paged by row offset
   * drops these rows; an achievement (not presence) always holds.
   */
  presenceClaimHolds(row: StampPresenceRow): boolean;
  /** The row's city/country when its place may be shown; both null otherwise. */
  place<R extends StampPresenceRow & { city?: unknown; country?: unknown }>(row: R): { city: string | null; country: string | null };
  /** Evidence tables that could not be read (their rows' places are withheld). */
  unreadable: string[];
}

/** The verdict for rows whose evidence is already known. Pure. */
export function stampPresenceVerdict(
  row: StampPresenceRow,
  evidence: { present: ReadonlySet<string>; unverifiable: ReadonlySet<string> },
): StampPlaceVerdict {
  if (!isPresenceRow(row)) return "not_presence";
  const pair = evidencePairOf(row);
  if (!pair) return "unevidenced";
  const key = evidenceKey(pair);
  if (evidence.present.has(key)) return "evidenced";
  if (evidence.unverifiable.has(key)) return "unverifiable";
  return "unevidenced";
}

function makeView(evidence: { present: ReadonlySet<string>; unverifiable: ReadonlySet<string> }, unreadable: string[]): StampPresenceView {
  const verdict = (row: StampPresenceRow) => stampPresenceVerdict(row, evidence);
  return {
    verdict,
    mayShowPlace: (row) => verdict(row) === "evidenced",
    presenceClaimHolds: (row) => { const v = verdict(row); return v === "evidenced" || v === "not_presence"; },
    place(row) {
      if (verdict(row) !== "evidenced") return { city: null, country: null };
      return {
        city: typeof row.city === "string" && row.city ? row.city : null,
        country: typeof row.country === "string" && row.country ? row.country : null,
      };
    },
    unreadable,
  };
}

/**
 * Read the evidence `rows` need (at most three reads, none when no row is a
 * presence stamp with a re-checkable source) and return the view.
 *
 * Never throws: a read that throws is an unreadable table, and its rows'
 * places are withheld.
 */
export async function readStampPresenceView(
  sc: SupabaseClient | null | undefined,
  rows: ReadonlyArray<StampPresenceRow>,
  log?: { warn?: (o: object, m: string) => void },
): Promise<StampPresenceView> {
  const pairs: EvidencePair[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isPresenceRow(r)) continue;
    const p = evidencePairOf(r);
    if (!p) continue;
    const k = evidenceKey(p);
    if (!seen.has(k)) { seen.add(k); pairs.push(p); }
  }
  if (pairs.length === 0) return makeView({ present: new Set(), unverifiable: new Set() }, []);
  if (!sc) {
    return makeView({ present: new Set(), unverifiable: new Set(pairs.map(evidenceKey)) }, ["no_service_client"]);
  }
  try {
    const ev = await readOccurrenceEvidence(sc, pairs);
    if (ev.unreadable.length > 0) {
      log?.warn?.({ unreadable: ev.unreadable, pairs: pairs.length }, "stamps: occurrence evidence unreadable — those stamps' places are withheld, not shown");
    }
    return makeView(ev, ev.unreadable);
  } catch (err) {
    log?.warn?.({ err: String((err as Error)?.message ?? err) }, "stamps: occurrence evidence read threw — places withheld");
    return makeView({ present: new Set(), unverifiable: new Set(pairs.map(evidenceKey)) }, ["threw"]);
  }
}

/**
 * The rows with their place fields cleared wherever the view withholds the
 * place. `fields` names the place-bearing columns the reader serves (city,
 * country, and lat/lng where a reader selects them). Rows are copied, never
 * mutated, and none is removed.
 */
export function withPresencePlaces<R extends StampPresenceRow & Record<string, unknown>>(
  view: StampPresenceView,
  rows: ReadonlyArray<R>,
  fields: ReadonlyArray<string> = ["city", "country", "lat", "lng"],
): R[] {
  return rows.map((r) => {
    if (view.mayShowPlace(r)) return r;
    const out: Record<string, unknown> = { ...r };
    for (const f of fields) if (f in out) out[f] = null;
    return out as R;
  });
}
