/**
 * reportOsmTagCoverage — how often do the Tier 1 OSM tags actually occur?
 *
 * Tier 1 stopped discarding six Overpass tags. This answers the question that
 * makes that change legible: **on what share of real places is each one
 * present?** The owner's ruling makes this part of the unit rather than a
 * follow-up, and the workstream's standing rail is the reason it is a script
 * rather than a paragraph:
 *
 *   > **Enumerate populations, do not estimate them.** "1 of 464 rows" is a
 *   > finding; "coverage seems good" is not.
 *
 * ── TWO THINGS THAT MAKE THIS A REAL MEASUREMENT ─────────────────────────────
 *
 * 1. **It queries what production queries.** The Overpass filter comes from
 *    `overpassFilter()` in the Discovery route itself, not a filter written for
 *    this script. A coverage number taken over a different filter is a number
 *    about a different population.
 *
 * 2. **It maps what production maps.** Every element goes through
 *    `mapOsmElementToPlace()` — the same function the route uses — so what is
 *    counted is what a card would actually RECEIVE, not what the raw tag set
 *    happens to contain. Those differ: `image` values that are not absolute
 *    URLs and `wikidata` values that are not entity ids are dropped by the
 *    mapping on purpose, and a raw tag count would overstate coverage by
 *    exactly that amount.
 *
 * ── ON SAMPLING, STATED RATHER THAN HIDDEN ───────────────────────────────────
 *
 * This measures the destinations named in `DESTINATIONS`, at the radius given,
 * at the moment it runs. It is a census of THAT population, not of OSM. The
 * output says so, prints the exact query parameters, and prints the endpoint it
 * used — a report that silently truncates its own scope reads as "we covered
 * everything" when it did not.
 *
 * Usage:
 *   node --import tsx/esm src/scripts/reportOsmTagCoverage.ts
 *   OVERPASS_URL=https://overpass.kumi.systems/api/interpreter \
 *     node --import tsx/esm src/scripts/reportOsmTagCoverage.ts --json
 *
 * `OVERPASS_URL` exists because some environments cannot reach the default
 * endpoint. Whichever is used is printed with the results.
 */
import { pathToFileURL } from "node:url";
import { overpassFilter, mapOsmElementToPlace, type OsmElement } from "../routes/discovery.js";

const DEFAULT_OVERPASS = "https://overpass-api.de/api/interpreter";
const OVERPASS = process.env.OVERPASS_URL || DEFAULT_OVERPASS;

/** Politeness gap between Overpass calls — this is a free shared service. */
const THROTTLE_MS = Number(process.env.COVERAGE_THROTTLE_MS ?? 5_000);

/** Attempts per cell before it is recorded as unmeasured. */
const MAX_ATTEMPTS = Number(process.env.COVERAGE_ATTEMPTS ?? 4);

/** Linear backoff step between attempts. */
const BACKOFF_BASE_MS = Number(process.env.COVERAGE_BACKOFF_MS ?? 20_000);

const RADIUS_M = Number(process.env.COVERAGE_RADIUS_M ?? 1500);
const MAX_ELEMENTS = Number(process.env.COVERAGE_MAX ?? 200);

/**
 * Destinations chosen to be UNLIKE each other, because a coverage number
 * averaged over five European capitals would describe Europe and be quietly
 * presented as describing the product. The complete matrix justified that
 * choice: attribute coverage ranges from 47% (Berlin) to 1.8% (Cebu).
 *
 * Cebu and Bangkok are deliberately included even though they are seeded
 * cities: seeding affects the DB path, not the OSM tag density, and leaving out
 * the regions the app is actually aimed at would bias the result toward the
 * best-mapped places on earth.
 *
 * The first two carry a standing QA role. They are listed first because the
 * pair is the point, not their alphabetical position.
 */
export interface CoverageDestination {
  name: string;
  lat: number;
  lng: number;
  /**
   * Standing QA role, where one exists. Measured 2026-08-15 over 2121 places.
   * These two are a PAIR and answer different questions — see
   * `docs/discovery/test-destination-fixtures.md`.
   */
  fixture?: "high-coverage" | "low-coverage";
}

export const DESTINATIONS: CoverageDestination[] = [
  // The ENRICHMENT-POSITIVE fixture. The only measured city where all six
  // Tier 1 fields are non-zero, so it is the one that can answer "does
  // enrichment work when the source has data".
  { name: "Berlin",    lat: 52.5200, lng: 13.4050, fixture: "high-coverage" },

  // The DEGRADATION fixture, KEPT DELIBERATELY. Flattest destination measured:
  // 0.9% neighbourhood, 1.8% on both attributes, 0.0% wikidata, 0.0% image.
  // Removing it would discard the only case that can answer "does the product
  // degrade gracefully when the source has nothing". Do not solve Cebu by
  // hiding it.
  { name: "Cebu",      lat: 10.3157, lng: 123.8854, fixture: "low-coverage" },

  { name: "Paris",     lat: 48.8566, lng: 2.3522 },
  { name: "New York",  lat: 40.7580, lng: -73.9855 },
  { name: "Bangkok",   lat: 13.7563, lng: 100.5018 },
  { name: "Nairobi",   lat: -1.2864, lng: 36.8172 },
  { name: "Lima",      lat: -12.0464, lng: -77.0428 },
];

/** The Discovery tabs an OSM-only destination actually serves. */
const CATEGORIES = ["places", "food", "nightlife", "activities"];

/** Every field Tier 1 added, plus the ones it did not, so gains are visible in context. */
const FIELDS = [
  { key: "neighborhood",   label: "neighborhood",        tier1: true  },
  { key: "outdoorSeating", label: "chip: outdoor seat.", tier1: true  },
  { key: "wheelchair",     label: "chip: wheelchair",    tier1: true  },
  { key: "internet",       label: "chip: internet",      tier1: true  },
  { key: "wikidataId",     label: "wikidataId",          tier1: true  },
  { key: "osmImageUrl",    label: "osmImageUrl",         tier1: true  },
  { key: "website",        label: "website",             tier1: false },
  { key: "phone",          label: "phone",               tier1: false },
  { key: "openingHours",   label: "openingHours",        tier1: false },
  { key: "description",    label: "description",         tier1: false },
  { key: "address",        label: "address",             tier1: false },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

interface Counts { total: number; present: Record<FieldKey, number> }

function emptyCounts(): Counts {
  const present = {} as Record<FieldKey, number>;
  for (const f of FIELDS) present[f.key] = 0;
  return { total: 0, present };
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Overpass statuses that mean "busy, try again", not "this query is wrong". */
const RETRYABLE = new Set([429, 502, 503, 504]);

/**
 * One Overpass attempt.
 *
 * Failures are distinguished on purpose. A 504 is the public endpoint telling
 * us it is loaded; a 400 means the query itself is malformed. Retrying the
 * first is patience, retrying the second is a loop — and reporting either as
 * "no tags here" would turn a server condition into a false coverage finding.
 */
async function attemptOverpass(
  lat: number, lng: number, category: string,
): Promise<{ ok: true; elements: OsmElement[] } | { ok: false; status: number; retryable: boolean }> {
  const filter = overpassFilter(category, RADIUS_M, lat, lng);
  const query = `[out:json][timeout:90];\n${filter}\nout body center qt ${MAX_ELEMENTS};`;
  const url = `${OVERPASS}?data=${encodeURIComponent(query)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "TravelBuddy/1.0 (travel-buddy-app; discovery)" },
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    // Timeout or transport failure — indistinguishable from an overloaded
    // endpoint from here, so treated as retryable.
    return { ok: false, status: 0, retryable: true };
  }

  if (!res.ok) return { ok: false, status: res.status, retryable: RETRYABLE.has(res.status) };

  const data = (await res.json()) as { elements?: OsmElement[] };
  return { ok: true, elements: data.elements ?? [] };
}

/**
 * Query with patience.
 *
 * PACING IS THE POINT, not a workaround. The heavier category filters
 * (`places`, `activities` — several regexes over both nodes and ways) reliably
 * 504 on a loaded public endpoint at the first attempt and succeed on a later
 * one. Giving up after one try produced a matrix with holes in it, and holes in
 * a coverage matrix are worse than a slow run: an unmeasured cell and a
 * genuinely empty one look identical in the output.
 */
async function queryOverpass(
  lat: number, lng: number, category: string,
  onRetry?: (attempt: number, status: number, waitMs: number) => void,
): Promise<OsmElement[]> {
  let lastStatus = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await attemptOverpass(lat, lng, category);
    if (result.ok) return result.elements;

    lastStatus = result.status;
    if (!result.retryable) throw new Error(`Overpass HTTP ${result.status} (not retryable)`);
    if (attempt === MAX_ATTEMPTS) break;

    // Linear backoff, not exponential: this is a free shared service being
    // asked to do real work, and the goal is to stop crowding it rather than to
    // recover from a blip as fast as possible.
    const waitMs = BACKOFF_BASE_MS * attempt;
    onRetry?.(attempt, result.status, waitMs);
    await sleep(waitMs);
  }

  throw new Error(`Overpass HTTP ${lastStatus} after ${MAX_ATTEMPTS} attempts`);
}

/** Which Tier 1 chip, if any, an element produced. Read off the MAPPED place. */
function chipPresence(tags: string[]) {
  return {
    outdoorSeating: tags.includes("outdoor seating"),
    wheelchair: tags.includes("wheelchair accessible") || tags.includes("partial wheelchair access"),
    internet: tags.includes("wifi") || tags.includes("internet terminal"),
  };
}

function tally(counts: Counts, elements: OsmElement[], category: string, lat: number, lng: number) {
  for (const el of elements) {
    // Same filter the route applies: unnamed rows never become places at all,
    // so counting them would deflate every percentage by a population the user
    // never sees.
    if (!el.tags?.name || !el.tags.name.trim()) continue;

    const place = mapOsmElementToPlace(el, category, lat, lng);
    const chips = chipPresence(place.tags);

    counts.total++;
    if (place.neighborhood) counts.present.neighborhood++;
    if (chips.outdoorSeating) counts.present.outdoorSeating++;
    if (chips.wheelchair) counts.present.wheelchair++;
    if (chips.internet) counts.present.internet++;
    if (place.wikidataId) counts.present.wikidataId++;
    if (place.osmImageUrl) counts.present.osmImageUrl++;
    if (place.website) counts.present.website++;
    if (place.phone) counts.present.phone++;
    if (place.openingHours) counts.present.openingHours++;
    if (place.description) counts.present.description++;
    if (place.address) counts.present.address++;
  }
}

function pct(n: number, total: number): string {
  if (total === 0) return "  n/a";
  return `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

/**
 * Tally pre-captured Overpass responses instead of querying live.
 *
 * Exists because the two halves of this measurement have different
 * requirements: fetching needs network reach to Overpass, tallying needs the
 * Discovery route's mapping code. An environment that has one may not have the
 * other — this workspace cannot reach `overpass-api.de` at all — and forcing
 * them into one step would make the measurement impossible wherever either half
 * is missing, rather than merely inconvenient.
 *
 * Expects files named `<destination>_<category>.json`, each holding a raw
 * Overpass response. Directory mode reports the same numbers the live path
 * does, through the same tally.
 */
async function tallyFromDir(dir: string) {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const overall = emptyCounts();
  const perDestination = new Map<string, Counts>();
  const perCell = new Map<string, Counts>();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const measured: string[] = [];

  for (const file of files) {
    const [dest, category] = file.replace(/\.json$/, "").split("_");
    if (!dest || !category) continue;

    const raw = JSON.parse(await readFile(join(dir, file), "utf8")) as { elements?: OsmElement[] };
    const elements = raw.elements ?? [];
    // A capture with no elements is a FAILED capture, not an empty city. Left
    // out of the tally and named in the output rather than counted as zero.
    if (!elements.length) continue;

    const counts = perDestination.get(dest) ?? emptyCounts();
    const origin = DESTINATIONS.find((d) => d.name.toLowerCase().replace(/\s+/g, "") === dest.toLowerCase());
    const cell = emptyCounts();
    tally(cell, elements, category, origin?.lat ?? 0, origin?.lng ?? 0);
    perCell.set(`${dest}|${category}`, cell);
    tally(counts, elements, category, origin?.lat ?? 0, origin?.lng ?? 0);
    tally(overall, elements, category, origin?.lat ?? 0, origin?.lng ?? 0);
    perDestination.set(dest, counts);
    measured.push(`${dest}/${category}: ${elements.length}`);
  }

  report(overall, perDestination, perCell, [], `${dir} (pre-captured)`, measured);
}

async function main() {
  const dirArg = process.argv.indexOf("--dir");
  if (dirArg !== -1 && process.argv[dirArg + 1]) {
    await tallyFromDir(process.argv[dirArg + 1]!);
    return;
  }

  const wantJson = process.argv.includes("--json");
  const overall = emptyCounts();
  const perDestination = new Map<string, Counts>();
  // Per CELL — destination x category. The ruling is explicit that the result
  // must NOT be reduced to one percentage, and the partial matrix already
  // showed why: an aggregate of 15.2% neighbourhood coverage sat over a Berlin
  // at 50.0% and a Paris at 0.0%. Both true, and the aggregate useless.
  const perCell = new Map<string, Counts>();
  const failures: string[] = [];

  // Progress goes to stderr, so `--json` piped to a file stays clean while a
  // human watching the terminal can still see it working. A run that prints
  // nothing for several minutes is indistinguishable from a hung one — which
  // is the same failure this workstream keeps finding in other clothes.
  const started = Date.now();
  const step = (msg: string) =>
    process.stderr.write(`[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s] ${msg}\n`);

  step(`querying ${OVERPASS}`);

  for (const dest of DESTINATIONS) {
    const counts = emptyCounts();
    for (const category of CATEGORIES) {
      try {
        const elements = await queryOverpass(dest.lat, dest.lng, category, (attempt, status, waitMs) =>
          step(`${dest.name}/${category}: HTTP ${status} on attempt ${attempt} — waiting ${Math.round(waitMs / 1000)}s`),
        );
        const cell = emptyCounts();
        tally(cell, elements, category, dest.lat, dest.lng);
        perCell.set(`${dest.name}|${category}`, cell);
        tally(counts, elements, category, dest.lat, dest.lng);
        tally(overall, elements, category, dest.lat, dest.lng);
        step(`${dest.name}/${category}: ${elements.length} elements, ${cell.total} named`);
      } catch (err) {
        step(`${dest.name}/${category}: FAILED — ${(err as Error).message}`);
        // A failed query is NOT zero coverage. Recording it separately keeps a
        // network failure from being read as "these places have no tags".
        failures.push(`${dest.name}/${category}: ${(err as Error).message}`);
      }
      await sleep(THROTTLE_MS);
    }
    perDestination.set(dest.name, counts);
  }

  if (wantJson) {
    console.log(JSON.stringify({
      endpoint: OVERPASS,
      radiusM: RADIUS_M,
      maxElements: MAX_ELEMENTS,
      categories: CATEGORIES,
      failures,
      overall,
      perDestination: Object.fromEntries(perDestination),
      perCell: Object.fromEntries(perCell),
    }, null, 2));
    return;
  }

  report(overall, perDestination, perCell, failures, OVERPASS, null);
}

/**
 * Print the findings. Shared by the live and pre-captured paths on purpose: two
 * printers would eventually disagree, and a coverage report that renders
 * differently depending on how it was fed is a report nobody can compare
 * across runs.
 */
function report(
  overall: Counts,
  perDestination: Map<string, Counts>,
  perCell: Map<string, Counts>,
  failures: string[],
  endpoint: string,
  measured: string[] | null,
) {
  console.log("");
  console.log("OSM TIER 1 TAG COVERAGE");
  console.log("=".repeat(72));
  console.log(`source      ${endpoint}${endpoint === DEFAULT_OVERPASS ? "" : "   (NOT the production default endpoint)"}`);
  if (measured) {
    // Directory mode does not know the radius or cap the captures were taken
    // with, and printing this run's defaults would attribute parameters to data
    // that was not collected under them.
    console.log(`radius      unknown — set by whoever captured these files`);
    console.log(`cap         unknown — see the per-capture counts below`);
  } else {
    console.log(`radius      ${RADIUS_M} m`);
    console.log(`cap         ${MAX_ELEMENTS} elements per destination+category`);
    console.log(`categories  ${CATEGORIES.join(", ")}`);
  }
  console.log(`scope       ${perDestination.size} destination(s) — a census of THESE, not of OSM`);
  if (measured) {
    console.log("");
    console.log("CAPTURES TALLIED (anything not listed here was NOT measured):");
    for (const m of measured) console.log(`  ${m}`);
  }
  console.log("");

  console.log(`NAMED PLACES MEASURED: ${overall.total}`);
  console.log("");
  console.log("field                    present     share   Tier 1?");
  console.log("-".repeat(72));
  for (const f of FIELDS) {
    const n = overall.present[f.key];
    console.log(
      `${f.label.padEnd(24)} ${String(n).padStart(6)}   ${pct(n, overall.total)}   ${f.tier1 ? "NEW" : ""}`,
    );
  }

  console.log("");
  console.log("PER DESTINATION (share of named places carrying each Tier 1 field)");
  console.log("-".repeat(72));
  const t1 = FIELDS.filter((f) => f.tier1);
  console.log(`${"destination".padEnd(12)}${"n".padStart(6)}  ` + t1.map((f) => f.key.slice(0, 8).padStart(9)).join(""));
  for (const [name, c] of perDestination) {
    console.log(
      `${name.padEnd(12)}${String(c.total).padStart(6)}  ` +
      t1.map((f) => pct(c.present[f.key], c.total).padStart(9)).join(""),
    );
  }

  console.log("");
  console.log("PER DESTINATION x CATEGORY — the full matrix, NOT reduced to one number");
  console.log("-".repeat(88));
  console.log(
    `${"destination".padEnd(12)}${"category".padEnd(12)}${"n".padStart(6)}  ` +
    t1.map((f) => f.key.slice(0, 8).padStart(9)).join(""),
  );
  for (const [key, c] of [...perCell.entries()].sort()) {
    const [dest, category] = key.split("|");
    console.log(
      `${(dest ?? "").padEnd(12)}${(category ?? "").padEnd(12)}${String(c.total).padStart(6)}  ` +
      t1.map((f) => pct(c.present[f.key], c.total).padStart(9)).join(""),
    );
  }

  if (failures.length) {
    console.log("");
    console.log("QUERIES THAT FAILED — these are NOT zero coverage, they are unmeasured:");
    for (const f of failures) console.log(`  ${f}`);
  }
  console.log("");
}

/**
 * Run ONLY when invoked directly.
 *
 * Without this guard, importing anything from this module — the DESTINATIONS
 * fixture list, for instance — starts a live Overpass sweep as a side effect of
 * the import. A test that merely reads the fixture list would hang for an hour
 * hammering a free public endpoint, which is how this guard came to be written.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error("coverage report failed:", err);
    process.exit(1);
  });
}
