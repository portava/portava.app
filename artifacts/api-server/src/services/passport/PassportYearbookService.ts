/**
 * PassportYearbookService — §9 / Phase 9 "Intelligence": the Passport Yearbook.
 *
 * WHAT IT IS
 * ----------
 * A per-YEAR aggregation over the traveller's OWN already-built material — the
 * Journeys projection (§14), the unified Stamps collection (§12), passport
 * Memories (§15) and the inferred Travel DNA (§19) — turned into a small set of
 * explainable "lines". Every line states a claim AND the concrete facts it was
 * derived from, so the yearbook never shows an unexplained number:
 *
 *     "3 countries · 5 cities"      ← Vietnam — Trip "30 Days in Vietnam"; …
 *     "Reached 10 stamps"           ← Stamp #10: "Da Nang" (2025-03-30)
 *     "Discovery: Balanced → Hidden gems"  ← 2024: …; 2025: 3 hidden-gem stamps
 *
 * It is a PURE READ. It stores nothing (§34 "not a duplicate database"), writes
 * nothing, and creates no query of its own against trips / stamps / memories:
 * every fact comes back through the existing passport readers, which is what
 * makes the privacy story below hold by construction rather than by review.
 *
 * PRIVACY — no new disclosure path
 * --------------------------------
 * The yearbook is OWNER-PRIVATE by default (the route requires the caller to be
 * the owner unless the owner's own passport projection would already have shown
 * the material to that viewer). Every input is taken from a reader that has
 * ALREADY applied the passport boundary for this viewer:
 *
 *   • journeys  — `buildJourneys(...)`: trip visibility + `show_on_profile`,
 *     date coarsening, the per-MEMORY visibility gate, and §24 block filtering
 *     of companions in both directions. The yearbook re-uses its output verbatim
 *     and never re-reads `trips`.
 *   • memories  — `loadMemories` + `filterMemories(callerCtx)`: the exact §29
 *     step-9 gate, PLUS the collection tier (`memories_visible`).
 *   • stamps    — `buildUnifiedStamps` behind the collection tier
 *     (`stamps_visible`) via `loadCollectionVisibility` — the same function the
 *     aggregate's step 7 gate is built from.
 *   • travel DNA — `buildTravelIdentity` + `filterTravelIdentityForViewer`, so
 *     an axis the owner marked Hidden / "Not Me" is absent for a viewer here
 *     exactly as it is absent from the aggregate.
 *
 * Consequences that are asserted by tests: a viewer's yearbook is a SUBSET of
 * what the same viewer's passport projection already exposes; a blocked
 * companion, a private trip and a private memory never appear; and no place is
 * ever finer than the country / city labels the projection already carries —
 * there are no coordinates anywhere in this file (§23 / TABLE 25).
 *
 * TRUTH BOUNDARY (§37)
 * --------------------
 * Every line carries `basis`. `observed` lines restate recorded facts (trips,
 * stamps, memories). `inferred` lines are model readings (Travel DNA shifts) and
 * are ALWAYS labelled as such — an inference is never presented as a record. No
 * trust score, reputation number or other derived score is read here, and
 * nothing the yearbook computes is fed back into any confidence model: it is a
 * leaf of the graph.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildJourneys,
  durationDaysOf,
  journeyWeight,
  type JourneyPermissions,
  type JourneyProjection,
  type JourneysProjection,
} from "./PassportJourneyService.js";
import { buildUnifiedStamps, type UnifiedStamp } from "./UnifiedStampService.js";
import { loadMemories } from "./PassportMemoryService.js";
import { filterMemories, type CallerContext } from "./PassportPrivacyGuard.js";
import {
  buildTravelIdentity,
  filterTravelIdentityForViewer,
  loadTravelDnaPrefs,
  type TravelDimension,
  type TravelDnaPrefs,
  type TravelTrait,
} from "./PassportTravelIdentityService.js";
import { deriveTravelSignals, loadCollectionVisibility } from "./PassportProjectionService.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §37 truth boundary. `observed` = a restatement of recorded facts.
 * `inferred` = a model reading. The client MUST label inferred lines; the
 * server never emits an inference with basis "observed".
 */
export type YearbookBasis = "observed" | "inferred";

export type YearbookLineKind =
  | "places"
  | "journey"
  | "stamp_milestone"
  | "memories"
  | "dna_shift";

/** One explainable claim about a year. `evidence` is never empty. */
export interface YearbookLine {
  /** Stable within a year, e.g. "countries", "journey:trip-1", "dna:discovery". */
  key: string;
  kind: YearbookLineKind;
  /** The claim, e.g. "3 countries · 5 cities". */
  headline: string;
  /** §37 — observed fact vs model reading. */
  basis: YearbookBasis;
  /** What the claim was derived from. Guaranteed non-empty. */
  evidence: string[];
}

export interface YearbookYear {
  year: number;
  /** Coarse place labels only (§23) — country names. */
  countries: string[];
  /** Coarse place labels only (§23) — city names. */
  cities: string[];
  journeyCount: number;
  stampCount: number;
  memoryCount: number;
  lines: YearbookLine[];
  /** True when nothing this viewer may see happened in this year. */
  empty: boolean;
  /** Honest empty-state copy; null when the year has content. */
  emptyMessage: string | null;
}

export interface YearbookProjection {
  userId: string;
  /** Newest first. Only years with permitted content, unless one was requested. */
  years: YearbookYear[];
  empty: boolean;
  emptyMessage: string | null;
  /**
   * Which collections this viewer was permitted to aggregate over. A `false`
   * here is why a line is missing — the yearbook says so rather than silently
   * under-counting.
   *
   * This is a PERMISSION/AVAILABILITY flag, never a has-content flag: a
   * collection that is fully included but simply empty stays `true`, so an
   * owner with no trips is never told their trips were withheld.
   */
  included: Record<YearbookCollection, boolean>;
  /**
   * One entry per collection whose `included` is false, naming WHY. Without
   * this the surface can only guess at a reason, and guessing produced a false
   * explanation ("hidden by your visibility settings") for owners who simply
   * had no content in a collection.
   */
  exclusions: YearbookExclusion[];
}

/** The four collections a yearbook aggregates over. */
export type YearbookCollection = "journeys" | "stamps" | "memories" | "travelDna";

/** Stable render order for the exclusion list. */
const YEARBOOK_COLLECTIONS: readonly YearbookCollection[] = [
  "journeys",
  "stamps",
  "memories",
  "travelDna",
];

export interface YearbookExclusion {
  collection: YearbookCollection;
  /**
   * `visibility` — the owner's passport visibility settings (or, for a viewer,
   * the trips gate) forbid this viewer the collection.
   * `unavailable`  — the underlying reader failed, so the collection could not
   * be counted at all. NOT a privacy statement.
   */
  reason: "visibility" | "unavailable";
}

/**
 * Turn the permission flags plus the set of readers that failed into the
 * per-collection reasons the surface renders. A failed read always wins: it is
 * the true reason the collection is absent, and calling it a visibility choice
 * would tell the owner something untrue about their own settings.
 */
function exclusionsFor(
  included: Record<YearbookCollection, boolean>,
  failed: ReadonlySet<YearbookCollection>,
): YearbookExclusion[] {
  const out: YearbookExclusion[] = [];
  for (const collection of YEARBOOK_COLLECTIONS) {
    if (included[collection]) continue;
    out.push({ collection, reason: failed.has(collection) ? "unavailable" : "visibility" });
  }
  return out;
}

/** Viewer permissions, mirroring the Journeys surface plus the caller context. */
export interface YearbookPermissions {
  isSelf: boolean;
  canSeeTrips: boolean;
  /** Viewer may see friends-only trips (friend / crew-level relationship). */
  canSeeRestricted: boolean;
  /** Per-item visibility context — the same one the §29 aggregate uses. */
  callerCtx: CallerContext;
  /** Viewer's id (null when unauthenticated) — used for §24 block filtering. */
  viewerId: string | null;
}

export interface BuildYearbookOptions {
  /** Restrict to one year. An empty requested year still returns an honest entry. */
  year?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Most recent years rendered in one response. */
const MAX_YEARS = 20;
/** Items listed verbatim in one evidence array before it says "+N more". */
const MAX_EVIDENCE_ITEMS = 24;
/** Defining journeys highlighted per year. */
const MAX_JOURNEY_LINES = 3;
/** DNA shift lines per year. */
const MAX_DNA_LINES = 8;
/** Cumulative stamp totals worth calling out when crossed. */
const STAMP_MILESTONES = [1, 5, 10, 25, 50, 100, 250];
/** Cumulative distinct-country totals worth calling out when crossed. */
const COUNTRY_MILESTONES = [1, 3, 5, 10, 25, 50];

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function yearOfIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t).getUTCFullYear();
}

/** Trim a list for one evidence array, appending an honest overflow note. */
function listEvidence(items: string[], cap = MAX_EVIDENCE_ITEMS): string[] {
  if (items.length <= cap) return items;
  const hidden = items.length - cap;
  return [...items.slice(0, cap), `+${hidden} more not listed`];
}

/** Distinct, order-preserving, blank-free. */
function distinct(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Flatten the grouped Journeys projection back to a flat, already-gated list. */
export function flattenJourneys(p: JourneysProjection): JourneyProjection[] {
  return p.years
    .flatMap((y) => y.countries)
    .flatMap((c) => c.cities)
    .flatMap((c) => c.journeys);
}

/**
 * Is this unified stamp a hidden-gem discovery? Read from the stamp's own type
 * / name — the only hidden-gem signal the unified read carries. Used solely to
 * feed the year's Discovery DNA axis, whose evidence quotes this exact count.
 */
export function isHiddenGemStamp(s: UnifiedStamp): boolean {
  const t = `${norm(s.stampType)} ${norm(s.name)}`;
  return t.includes("hidden gem") || t.includes("hidden_gem") || t.includes("hiddengem");
}

/** A short, coarse place label for a stamp or journey (never finer than a city). */
function placeLabel(city: string | null, country: string | null): string | null {
  const parts = [city, country].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return parts.length ? parts.join(", ") : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-year buckets
// ─────────────────────────────────────────────────────────────────────────────

interface YearBucket {
  year: number;
  journeys: JourneyProjection[];
  stamps: UnifiedStamp[];
  memories: Array<{ id: string; title: string | null; city: string | null; country: string | null; earnedAt: string | null }>;
}

function bucketFor(map: Map<number, YearBucket>, year: number): YearBucket {
  let b = map.get(year);
  if (!b) {
    b = { year, journeys: [], stamps: [], memories: [] };
    map.set(year, b);
  }
  return b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Line builders — each one returns lines whose evidence is non-empty
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Countries + cities of the year, each attributed to the record it came from.
 * The two counts in the headline are exactly the lengths of the two attributed
 * lists, so the number can always be walked back to its sources.
 */
function placesLines(bucket: YearBucket, includeStamps: boolean, includeMemories: boolean): YearbookLine[] {
  const countrySource = new Map<string, string>();
  const citySource = new Map<string, string>();
  const note = (map: Map<string, string>, value: string | null | undefined, source: string) => {
    const v = typeof value === "string" ? value.trim() : "";
    if (!v) return;
    if (!map.has(v)) map.set(v, source);
  };

  for (const j of bucket.journeys) {
    const label = j.title || "Trip";
    note(countrySource, j.country, `Trip "${label}"`);
    note(citySource, j.city, `Trip "${label}"`);
    for (const m of j.memories) {
      note(countrySource, m.country, `Memory "${m.title ?? "untitled"}"`);
      note(citySource, m.city, `Memory "${m.title ?? "untitled"}"`);
    }
  }
  if (includeStamps) {
    for (const s of bucket.stamps) {
      const label = s.name ?? s.stampType ?? "stamp";
      note(countrySource, s.country, `Stamp "${label}"`);
      note(citySource, s.city, `Stamp "${label}"`);
    }
  }
  if (includeMemories) {
    for (const m of bucket.memories) {
      note(countrySource, m.country, `Memory "${m.title ?? "untitled"}"`);
      note(citySource, m.city, `Memory "${m.title ?? "untitled"}"`);
    }
  }

  const countries = [...countrySource.keys()];
  const cities = [...citySource.keys()];
  if (countries.length === 0 && cities.length === 0) return [];

  const parts: string[] = [];
  if (countries.length) parts.push(plural(countries.length, "country", "countries"));
  if (cities.length) parts.push(plural(cities.length, "city", "cities"));

  return [
    {
      key: "places",
      kind: "places",
      headline: parts.join(" · "),
      basis: "observed",
      evidence: listEvidence([
        ...countries.map((c) => `${c} — ${countrySource.get(c)}`),
        ...cities.map((c) => `${c} — ${citySource.get(c)}`),
      ]),
    },
  ];
}

/**
 * The defining journeys of the year, ranked by the SHARED journey weight
 * (`journeyWeight`) the Featured Journey pick uses. The weight's four inputs are
 * emitted verbatim as evidence, so the ranking is never a black box.
 */
function journeyLines(bucket: YearBucket): YearbookLine[] {
  const ranked = bucket.journeys
    .map((j) => {
      const days = durationDaysOf(j.startDate, j.endDate);
      return {
        j,
        days,
        weight: journeyWeight({
          memoryCount: j.memoryCount,
          stampCount: j.stampCount,
          durationDays: days ?? 0,
          completed: j.status === "completed",
        }),
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_JOURNEY_LINES);

  return ranked.map(({ j, days }) => {
    const evidence: string[] = [];
    if (j.memoryCount > 0) evidence.push(plural(j.memoryCount, "memory", "memories"));
    if (j.stampCount > 0) evidence.push(plural(j.stampCount, "stamp"));
    if (days !== null) evidence.push(j.durationLabel ?? plural(days, "day"));
    evidence.push(`Trip status: ${j.status}`);
    if (j.people.length > 0) {
      // `people` is already §24 block-filtered in BOTH directions and carries
      // coarse identity only — reproduced here, never re-derived.
      evidence.push(
        `Travelled with ${listEvidence(j.people.map((p) => p.name ?? p.handle ?? "a fellow traveller"), 6).join(", ")}`,
      );
    }
    const place = placeLabel(j.city, j.country);
    return {
      key: `journey:${j.tripId}`,
      kind: "journey" as const,
      headline: place ? `${j.title} — ${place}` : j.title,
      basis: "observed" as const,
      evidence,
    };
  });
}

/**
 * Stamp milestones. Two kinds, both anchored to a specific stamp:
 *   • the first stamp the traveller ever earned in a country;
 *   • a crossing of a cumulative total (1st, 5th, 10th, … stamp / country),
 *     attributed to the exact stamp that crossed it.
 *
 * `orderedStamps` is the viewer-permitted stamp collection sorted OLDEST first,
 * so the running totals are true cumulative history, not a per-year restart.
 * Only dated stamps count toward those totals — see the guard in the loop.
 */
function stampMilestoneLines(
  year: number,
  orderedStamps: UnifiedStamp[],
): YearbookLine[] {
  const lines: YearbookLine[] = [];
  const seenCountries = new Set<string>();
  const newCountriesThisYear: string[] = [];
  const newCountryEvidence: string[] = [];
  let total = 0;
  let countryTotal = 0;

  for (const s of orderedStamps) {
    const y = yearOfIso(s.earnedAt);
    // A stamp with no usable date is anchored to no year card and counted in no
    // `year.stampCount`; letting it advance the running total would number a
    // milestone over stamps that appear nowhere in the yearbook.
    if (y === null) continue;
    total += 1;
    const label = s.name ?? s.stampType ?? "stamp";
    const country = typeof s.country === "string" ? s.country.trim() : "";
    const isNewCountry = country.length > 0 && !seenCountries.has(country.toLowerCase());
    if (isNewCountry) {
      seenCountries.add(country.toLowerCase());
      countryTotal += 1;
    }

    if (y !== year) continue;

    if (isNewCountry) {
      newCountriesThisYear.push(country);
      newCountryEvidence.push(
        `${country} — first stamp "${label}"${s.earnedAt ? ` (${s.earnedAt.slice(0, 10)})` : ""}`,
      );
    }
    if (STAMP_MILESTONES.includes(total)) {
      lines.push({
        key: `stamps-total:${total}`,
        kind: "stamp_milestone",
        headline: total === 1 ? "First stamp earned" : `Reached ${total} stamps`,
        basis: "observed",
        evidence: [
          `Stamp #${total}: "${label}"${s.earnedAt ? ` (${s.earnedAt.slice(0, 10)})` : ""}`,
          ...(placeLabel(s.city, s.country) ? [`Earned in ${placeLabel(s.city, s.country)}`] : []),
        ],
      });
    }
    if (isNewCountry && COUNTRY_MILESTONES.includes(countryTotal)) {
      lines.push({
        key: `countries-total:${countryTotal}`,
        kind: "stamp_milestone",
        headline: countryTotal === 1 ? "First country stamped" : `Reached ${countryTotal} countries`,
        basis: "observed",
        evidence: [`Country #${countryTotal}: ${country} — stamp "${label}"`],
      });
    }
  }

  if (newCountriesThisYear.length > 0) {
    lines.unshift({
      key: "new-countries",
      kind: "stamp_milestone",
      headline: `${plural(newCountriesThisYear.length, "new country", "new countries")} stamped`,
      basis: "observed",
      evidence: listEvidence(newCountryEvidence),
    });
  }
  return lines;
}

/** Memories of the year, each named. */
function memoryLines(bucket: YearBucket): YearbookLine[] {
  const all = [...bucket.memories, ...bucket.journeys.flatMap((j) => j.memories)];
  const byId = new Map<string, { title: string | null; city: string | null; country: string | null }>();
  for (const m of all) if (m.id && !byId.has(m.id)) byId.set(m.id, m);
  if (byId.size === 0) return [];
  const evidence = [...byId.values()].map((m) => {
    const place = placeLabel(m.city, m.country);
    const title = m.title ?? "Untitled memory";
    return place ? `${title} — ${place}` : title;
  });
  return [
    {
      key: "memories",
      kind: "memories",
      headline: `${plural(byId.size, "memory", "memories")} recorded`,
      basis: "observed",
      evidence: listEvidence(evidence),
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Travel DNA, year over year
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A year's DNA reading: the Travel DNA inference run over ONLY that year's
 * stamps.
 *
 * The owner's `profiles` row is deliberately NOT passed: profile fields
 * (travel pace, planning style, spend style, languages…) describe the traveller
 * TODAY, not that year, and attributing them to a past year would be a
 * fabricated history. Passing null leaves those axes evidence-free and they are
 * dropped below — so a year only ever reports an axis its own activity supports.
 *
 * The owner's Show / Hide / "Not Me" state is applied by `buildTravelIdentity` +
 * `filterTravelIdentityForViewer`, the same pair the aggregate uses, so a
 * suppressed axis cannot resurface through the yearbook.
 */
async function readingForYear(
  sc: SupabaseClient,
  userId: string,
  bucket: YearBucket,
  isSelf: boolean,
  prefs: TravelDnaPrefs,
): Promise<{ dimensions: Map<string, TravelDimension>; traits: Map<string, TravelTrait> }> {
  const countries = distinct(bucket.stamps.map((s) => s.country)).length;
  const hiddenGems = bucket.stamps.filter(isHiddenGemStamp).length;
  const signals = deriveTravelSignals(bucket.stamps, countries, hiddenGems);
  const built = await buildTravelIdentity(sc, userId, null, signals, { isSelf, prefs });
  const visible = filterTravelIdentityForViewer(built, isSelf);

  const dimensions = new Map<string, TravelDimension>();
  for (const d of visible.dimensions) {
    // An axis with no evidence in this year is not a reading — it is a default.
    if (d.evidence.length > 0) dimensions.set(d.key, d);
  }
  const traits = new Map<string, TravelTrait>();
  for (const t of visible.traits) {
    if (t.evidence.length > 0) traits.set(t.key, t);
  }
  return { dimensions, traits };
}

type YearReading = Awaited<ReturnType<typeof readingForYear>>;

/**
 * Turn this year's reading and the previous year's into labelled shift lines.
 * Every line is `basis: "inferred"` — a Travel DNA reading is a model output and
 * is never presented as an observation (§37).
 */
function dnaShiftLines(
  year: number,
  current: YearReading,
  previous: { year: number; reading: YearReading } | null,
): YearbookLine[] {
  const lines: YearbookLine[] = [];

  for (const [key, dim] of current.dimensions) {
    const prev = previous?.reading.dimensions.get(key) ?? null;
    if (prev && prev.value === dim.value) continue; // no shift to report
    const evidence: string[] = [`${year}: ${dim.value} — ${dim.evidence.join("; ")}`];
    let headline: string;
    if (!previous) {
      headline = `${dim.label}: ${dim.value} (first reading)`;
      evidence.push(`No earlier year to compare against`);
    } else if (!prev) {
      headline = `${dim.label}: ${dim.value} (new signal)`;
      evidence.push(`${previous.year}: no supporting activity for this reading`);
    } else {
      headline = `${dim.label}: ${prev.value} → ${dim.value}`;
      evidence.push(`${previous.year}: ${prev.value} — ${prev.evidence.join("; ")}`);
    }
    lines.push({ key: `dna:${key}`, kind: "dna_shift", basis: "inferred", headline, evidence });
  }

  for (const [key, trait] of current.traits) {
    const prev = previous?.reading.traits.get(key) ?? null;
    if (prev) continue; // already held last year — not a shift
    lines.push({
      key: `dna-trait:${key}`,
      kind: "dna_shift",
      basis: "inferred",
      headline: previous ? `${trait.label} emerged` : `${trait.label} (first reading)`,
      evidence: [
        `${year}: ${trait.evidence.join("; ")}`,
        previous
          ? `${previous.year}: not enough activity for this trait`
          : `No earlier year to compare against`,
      ],
    });
  }

  if (previous) {
    for (const [key, trait] of previous.reading.traits) {
      if (current.traits.has(key)) continue;
      lines.push({
        key: `dna-trait-faded:${key}`,
        kind: "dna_shift",
        basis: "inferred",
        headline: `${trait.label} faded`,
        evidence: [
          `${previous.year}: ${trait.evidence.join("; ")}`,
          `${year}: not enough activity for this trait`,
        ],
      });
    }
  }

  return lines.slice(0, MAX_DNA_LINES);
}

// ─────────────────────────────────────────────────────────────────────────────
// buildYearbook
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_MESSAGE =
  "No travel recorded yet. Your yearbook fills in as you take trips, earn stamps and save memories.";

function emptyYear(year: number): YearbookYear {
  return {
    year,
    countries: [],
    cities: [],
    journeyCount: 0,
    stampCount: 0,
    memoryCount: 0,
    lines: [],
    empty: true,
    emptyMessage: `Nothing recorded for ${year}.`,
  };
}

/**
 * Build the yearbook for `userId` as seen by the viewer described by `perms`.
 *
 * Never throws for missing data: an owner with no history gets an explicitly
 * empty yearbook with an honest message rather than a fabricated one.
 */
export async function buildYearbook(
  sc: SupabaseClient,
  userId: string,
  perms: YearbookPermissions,
  opts: BuildYearbookOptions = {},
): Promise<YearbookProjection> {
  const requestedYear =
    typeof opts.year === "number" && Number.isInteger(opts.year) ? opts.year : null;

  const journeyPerms: JourneyPermissions = {
    isSelf: perms.isSelf,
    canSeeTrips: perms.canSeeTrips,
    canSeeRestricted: perms.canSeeRestricted,
    callerCtx: perms.callerCtx,
    viewerId: perms.viewerId,
  };

  // Readers that failed. A fail-closed fallback below drops the collection, and
  // this set is what lets the projection say "unavailable" rather than blaming
  // the owner's visibility settings for a read error.
  const failed = new Set<YearbookCollection>();

  const [visibility, journeysProjection, unified, rawMemories, dnaPrefs] = await Promise.all([
    loadCollectionVisibility(sc, userId, perms.callerCtx).catch(() => {
      failed.add("stamps");
      failed.add("memories");
      return { stamps: false, memories: false };
    }),
    buildJourneys(sc, userId, journeyPerms).catch(() => {
      failed.add("journeys");
      return { userId, years: [], featured: null, totalJourneys: 0 } as JourneysProjection;
    }),
    buildUnifiedStamps(sc, userId).catch(() => {
      failed.add("stamps");
      return { stamps: [] as UnifiedStamp[], count: 0, breakdown: { v1: 0, v2: 0, deduped: 0 } };
    }),
    loadMemories(sc, userId).catch(() => {
      failed.add("memories");
      return [] as any[];
    }),
    // Prefs only refine the DNA reading; losing them narrows nothing the owner
    // can see, so it is not a collection-level exclusion.
    loadTravelDnaPrefs(sc, userId).catch(() => ({ prefs: new Map(), applied: false }) as TravelDnaPrefs),
  ]);

  const canSeeStamps = visibility.stamps === true && !failed.has("stamps");
  const canSeeMemories = visibility.memories === true && !failed.has("memories");
  // Journeys are gated by the trips permission, NOT by whether any trip exists:
  // an owner with zero trips is fully included and simply has an empty year.
  const canSeeJourneys = (perms.isSelf === true || perms.canSeeTrips === true) && !failed.has("journeys");

  // Stamps: gated by the collection tier, oldest first so cumulative milestones
  // are real running totals rather than a per-year restart.
  //
  // Only stamps that carry a parseable date take part: an undated stamp lands
  // in no year card and in no `year.stampCount`, so counting it in the running
  // milestone total would number a milestone over stamps the yearbook never
  // shows — the total and the per-year counts must agree by construction.
  const orderedStamps = canSeeStamps
    ? (unified.stamps as UnifiedStamp[])
        .filter((s) => yearOfIso(s.earnedAt) !== null)
        .sort((a, b) => Date.parse(a.earnedAt as string) - Date.parse(b.earnedAt as string))
    : [];

  // Memories: the §29 step-9 per-item gate AND the collection tier.
  const memories = canSeeMemories
    ? (filterMemories(rawMemories as any[], perms.callerCtx) as any[]).map((m) => ({
        id: String(m.id),
        title: m.title ?? null,
        city: m.city ?? null,
        country: m.country ?? null,
        earnedAt: m.earned_at ?? null,
      }))
    : [];

  // ── Bucket everything by year ──────────────────────────────────────────────
  const buckets = new Map<number, YearBucket>();
  for (const j of flattenJourneys(journeysProjection)) {
    if (j.year === null) continue; // a journey with no permitted year anchors nowhere
    bucketFor(buckets, j.year).journeys.push(j);
  }
  for (const s of orderedStamps) {
    const y = yearOfIso(s.earnedAt);
    if (y === null) continue;
    bucketFor(buckets, y).stamps.push(s);
  }
  for (const m of memories) {
    const y = yearOfIso(m.earnedAt);
    if (y === null) continue;
    bucketFor(buckets, y).memories.push(m);
  }

  const orderedYears = [...buckets.keys()].sort((a, b) => a - b); // oldest → newest
  const included: Record<YearbookCollection, boolean> = {
    journeys: canSeeJourneys,
    stamps: canSeeStamps,
    memories: canSeeMemories,
    travelDna: true,
  };

  if (orderedYears.length === 0) {
    return {
      userId,
      years: requestedYear !== null ? [emptyYear(requestedYear)] : [],
      empty: true,
      emptyMessage:
        requestedYear !== null ? `Nothing recorded for ${requestedYear}.` : EMPTY_MESSAGE,
      included,
      exclusions: exclusionsFor(included, failed),
    };
  }

  // ── DNA readings, oldest → newest, so each year can look back one year ─────
  const readings = new Map<number, YearReading>();
  try {
    for (const y of orderedYears) {
      readings.set(y, await readingForYear(sc, userId, buckets.get(y)!, perms.isSelf, dnaPrefs));
    }
  } catch {
    readings.clear();
    included.travelDna = false;
    failed.add("travelDna"); // a reading failure, never a visibility choice
  }

  // ── Assemble each year ─────────────────────────────────────────────────────
  const built: YearbookYear[] = [];
  for (let i = 0; i < orderedYears.length; i += 1) {
    const year = orderedYears[i];
    const bucket = buckets.get(year)!;
    const lines: YearbookLine[] = [
      ...placesLines(bucket, canSeeStamps, canSeeMemories),
      ...journeyLines(bucket),
      ...(canSeeStamps ? stampMilestoneLines(year, orderedStamps) : []),
      ...memoryLines(bucket),
    ];
    const reading = readings.get(year);
    if (reading) {
      const prevYear = i > 0 ? orderedYears[i - 1] : null;
      const prevReading = prevYear !== null ? readings.get(prevYear) : undefined;
      lines.push(
        ...dnaShiftLines(
          year,
          reading,
          prevYear !== null && prevReading ? { year: prevYear, reading: prevReading } : null,
        ),
      );
    }

    const countries = distinct([
      ...bucket.journeys.map((j) => j.country),
      ...bucket.journeys.flatMap((j) => j.memories.map((m) => m.country)),
      ...(canSeeStamps ? bucket.stamps.map((s) => s.country) : []),
      ...(canSeeMemories ? bucket.memories.map((m) => m.country) : []),
    ]);
    const cities = distinct([
      ...bucket.journeys.map((j) => j.city),
      ...bucket.journeys.flatMap((j) => j.memories.map((m) => m.city)),
      ...(canSeeStamps ? bucket.stamps.map((s) => s.city) : []),
      ...(canSeeMemories ? bucket.memories.map((m) => m.city) : []),
    ]);
    const memoryIds = new Set<string>([
      ...bucket.memories.map((m) => m.id),
      ...bucket.journeys.flatMap((j) => j.memories.map((m) => m.id)),
    ]);

    built.push({
      year,
      countries,
      cities,
      journeyCount: bucket.journeys.length,
      stampCount: bucket.stamps.length,
      memoryCount: memoryIds.size,
      lines,
      empty: lines.length === 0,
      emptyMessage: lines.length === 0 ? `Nothing recorded for ${year}.` : null,
    });
  }

  built.reverse(); // newest first for presentation

  if (requestedYear !== null) {
    const one = built.find((y) => y.year === requestedYear);
    return {
      userId,
      years: [one ?? emptyYear(requestedYear)],
      empty: !one || one.empty,
      emptyMessage: one && !one.empty ? null : `Nothing recorded for ${requestedYear}.`,
      included,
      exclusions: exclusionsFor(included, failed),
    };
  }

  const years = built.slice(0, MAX_YEARS);
  const anyContent = years.some((y) => !y.empty);
  return {
    userId,
    years,
    empty: !anyContent,
    emptyMessage: anyContent ? null : EMPTY_MESSAGE,
    included,
    exclusions: exclusionsFor(included, failed),
  };
}
