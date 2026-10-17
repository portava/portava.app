/**
 * Every stamp READ site, enumerated and classified — census-highlights-memories
 * H4, the reader half (wave 5, lane 5). The award half is
 * stampAwardCallSites.test.ts.
 *
 * H4: "Planned/saved/nearby never represented as 'experienced' without
 * occurrence evidence or user confirmation." §BD.6 left H4 at W because "the
 * other 22 of §K.4's 26 read sites were not re-read". This file is that read,
 * made executable: it walks every non-test source file, finds every
 * `.from("user_stamps").select(...)` and every code literal naming the table,
 * and fails when one appears that is not in REGISTRY / LITERALS below, when one
 * in them disappears, or when a site's stated guard is gone.
 *
 * A NEW READER MUST BE ADDED HERE WITH ITS VERDICT. That is the ratchet.
 *
 * THE VERDICTS (what the read can say about where a person has been)
 *   gated        it names, counts, pins or keys a feed by a stamp's place, and
 *                applies services/passport/stampPresenceView.ts: the place only
 *                for a presence stamp whose own source's occurrence evidence
 *                holds. Must SELECT what the verdict reads (`mustSelect`): an
 *                unselected column reads `undefined` against a real database
 *                (§L.5's survivor G), so a fixture cannot vouch for it.
 *   no_place     selects no city/country/lat/lng: it cannot place anybody.
 *   count_only   a head count of rows: a number of stamps, no place, no name.
 *   writer       the award engine's own reads (it is the path, not a display).
 *   maintenance  catalog/artwork upkeep or an admin backfill: not served to a
 *                traveller, and its effect on a display is gated where shown.
 *   admin_raw    the admin console shows the stored row so it can be revoked
 *                or repaired; not a claim to the traveller or the public.
 *   open         a display that does NOT yet apply the rule, in a file another
 *                lane owns. Named with the change it needs. The set may only
 *                shrink.
 *
 * Run: node --import tsx/esm --test src/test/stampReaderCallSites.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Verdict = "gated" | "no_place" | "count_only" | "writer" | "maintenance" | "admin_raw" | "open";

interface ReadSite {
  file: string;
  /** Matches the select argument text of the read(s) this entry covers. */
  select: RegExp;
  /** How many reads in the file this entry covers (identical selects). */
  count?: number;
  verdict: Verdict;
  /** Text that must be in the file: the gate (or the fact) the verdict rests on. */
  guard?: RegExp;
  /** Columns the read must select for its verdict to be computable on a real database. */
  mustSelect?: readonly string[];
  why: string;
}

/** What a `gated` read must select: the person, the source the evidence is named by, and the slug. */
const GATED = ["user_id", "source_type", "source_id", "slug"] as const;

const REGISTRY: readonly ReadSite[] = [
  // ── Passport (services/passport) ─────────────────────────────────────────
  {
    file: "services/passport/PassportMapService.ts",
    select: /^"id, user_id, source_type, source_id, country, city, visibility, is_revoked, stamp_definitions\(category, slug, evidences_presence\)"$/,
    verdict: "gated", mustSelect: GATED,
    guard: /const evidencesPresence = def\?\.evidences_presence === true && view\.mayShowPlace\(r\);/,
    why: "buildStats — GET /me/passport/stats Countries/Cities (and the §29 projection). Counts a place only with occurrence evidence; unreadable evidence sets readFailed",
  },
  {
    file: "services/passport/SharedContextService.ts",
    select: /^"city, user_id, source_type, source_id, stamp_definitions\(slug, evidences_presence\)"$/,
    verdict: "gated", mustSelect: GATED,
    guard: /if \(!view\.mayShowPlace\(r\)\) continue;/,
    why: "shared_cities — 'places you have both been', told to another person",
  },
  {
    file: "services/passport/PassportJourneyService.ts",
    select: /^"user_id, source_type, source_id, city, country, earned_at, is_revoked, stamp_definitions\(slug, name\)"$/,
    verdict: "gated", mustSelect: GATED,
    guard: /withPresencePlaces\(view, \(\(data as any\[\]\) \?\? \[\]\)\.filter\(\(x\) => view\.presenceClaimHolds\(x\)\), \["city", "country"\]\)/,
    why: "journeys — stamps attached to a trip, shown to the owner and to viewers; drops an unevidenced completion stamp, withholds a non-presence place",
  },
  {
    file: "services/passport/UnifiedStampService.ts",
    select: /"id, user_id, stamp_definition_id, source_type, source_id, city, country, earned_at, is_revoked, visibility, catalog_id, "/,
    verdict: "gated", mustSelect: GATED,
    guard: /const view = await readStampPresenceView\(sc, data as any\[\]\); const rows = withPresencePlaces\(view, data as any\[\], \["city", "country"\]\);/,
    why: "the unified shelf (§29 projection, yearbook, /stamps/me/unified): place withheld, place-scoped art withheld, a withheld place dedupes by id, and a viewer other than the owner never sees an unevidenced presence claim (isUnifiedStampVisible)",
  },
  {
    file: "services/passport/StampAwardEngine.ts",
    select: /^"id"(, \{ count: "exact", head: true \})?$/,
    count: 6,
    verdict: "writer",
    why: "idempotency / heal / non-repeatable / max-awards checks inside the award path",
  },
  {
    file: "services/passport/StampAwardEngine.ts",
    select: /^"id, stamp_definition_id, source_type, source_id, is_revoked"$/,
    verdict: "writer",
    why: "recalculateForUser re-syncs rows with stamp_award_events; no display",
  },
  // ── Routes ───────────────────────────────────────────────────────────────
  {
    file: "routes/stamps.ts",
    select: /^(OWNER_STAMP_COLS|PUBLIC_STAMP_COLS|colSet) \+ ", stamp_definitions\(slug, /,
    count: 8,
    verdict: "gated",
    guard: /const view = await readStampPresenceView\(sc as any, rows\);\n\s*const kept = rows\.filter/,
    why: "GET /stamps/me, /stamps/user/:id (owner + public), /stamps/profile/:username, /stamps/recent, /stamps/city/:city, /stamps/country/:country, /stamps/:stampId — all through formatStamps: place and place art withheld; city/country feeds and ?city=/?country= keep only evidenced stamps; reads for someone else drop unevidenced presence claims",
  },
  {
    file: "routes/stamps.ts",
    select: /^"id", \{ count: "exact", head: true \}$/,
    verdict: "count_only",
    why: "GET /stamps/me pagination total; with ?city=/?country= the total is recomputed from the gated page",
  },
  {
    file: "routes/stamps.ts",
    select: /^"stamp_definition_id"$/,
    verdict: "no_place",
    why: "GET /stamps/me/collections — earned definitions per collection",
  },
  {
    file: "routes/stampShowcase.ts",
    select: /^STAMP_FIELDS$/,
    verdict: "gated",
    guard: /withPresencePlaces\(view, \(data \?\? \[\]\) as any\[\], \["city", "country"\]\)\.map\(\(r\) => \[r\.id, \{ \.\.\.r, presenceClaimHolds: view\.presenceClaimHolds\(r\) \}\]\)/,
    why: "own and public stamp showcase: place withheld; the public showcase drops an unevidenced presence claim (s.presenceClaimHolds !== false)",
  },
  {
    file: "routes/stampShowcase.ts",
    select: /^"id, user_id, is_revoked"$/,
    verdict: "no_place",
    why: "PUT /stamps/showcase ownership validation",
  },
  {
    file: "routes/stampAdmire.ts",
    select: /^"id, user_id, visibility, is_revoked, city, country, title_override, source_type, source_id, stamp_definitions\(slug, name\)"$/,
    verdict: "gated", mustSelect: GATED,
    guard: /const place = \(await readStampPresenceView\(sc, \[stamp as any\]\)\)\.place\(stamp as any\);/,
    why: "the 'admired your <place> stamp' notification names a place only for an evidenced presence stamp, else the stamp's name",
  },
  {
    file: "routes/wellKnownShare.ts",
    select: /^"title_override, visibility, is_revoked, city, country, stamp_definition_id, user_id, source_type, source_id, stamp_definitions\(slug\)"$/,
    verdict: "gated", mustSelect: GATED,
    guard: /if \(!view\.presenceClaimHolds\(data as any\)\) return null; const placed = view\.place\(data as any\);/,
    why: "the public share page 'a passport stamp earned in <place>': place only with evidence; no page for an unevidenced presence claim",
  },
  {
    file: "routes/passport.ts",
    select: /^`\$\{BASE_COLS\}, stamp_definitions\(slug, name, stamp_type/,
    count: 2,
    verdict: "gated",
    guard: /if \(!view\.presenceClaimHolds\(data\)\) return null; if \(!view\.mayShowPlace\(data\)\) \{ data = \{ \.\.\.data, city: null, country: null \};/,
    why: "the crawler stamp preview (OG card): place, palette and place-scoped art only with evidence; no preview for an unevidenced presence claim (BASE_COLS names user_id, source_type, source_id)",
  },
  {
    file: "routes/passport.ts",
    select: /^"city, stamp_definitions\(stamp_type, universal_artwork_url\)"$/,
    verdict: "no_place",
    why: "legacy GET /me/passport/stamps artwork enrichment: a v2 row's city is only a key to pick definition art for a v1 GPS stamp that already exists at that city; nothing new is claimed and the v2 city is never served. (Selects `city` as a lookup key, which is why this entry is exempt from the no-place column check.)",
  },
  {
    file: "routes/postcards.ts",
    select: /^'id'$/,
    verdict: "no_place",
    why: "overlay eligibility: has the caller earned this definition",
  },
  {
    file: "routes/postcards.ts",
    select: /^'stamp_definition_id, earned_at'$/,
    verdict: "no_place",
    why: "overlay options: the caller's own earned definitions",
  },
  {
    file: "routes/profile.ts",
    select: /^"id", \{ count: "exact", head: true \}$/,
    verdict: "count_only",
    why: "profile insights: lifetime stamps earned",
  },
  {
    file: "routes/adminStamps.ts",
    select: /^ "id, user_id, stamp_definition_id, earned_at, city, country, source_type, is_revoked, revoked_at, revoked_reason, stamp_definitions\(slug, name, stamp_type\)", \{ count: "exact" \}, $/,
    verdict: "admin_raw",
    guard: /const admin = await requireAdmin\(req, res\);/,
    why: "GET /admin/users/:userId/stamps — the stored row, so an admin can revoke or repair it (logAdminAccess)",
  },
  {
    file: "routes/stampCatalog.ts",
    select: /^"id, user_id, earned_at, source_type"$/,
    verdict: "admin_raw",
    why: "admin catalog detail: who earned this catalog entry; no place",
  },
  {
    file: "routes/stampCatalog.ts",
    select: /^"id, user_id, earned_at, source_type, profiles!user_stamps_user_id_fkey\(username, display_name\)", \{ count: "exact" \}$/,
    verdict: "admin_raw",
    why: "admin catalog earners list; no place",
  },
  {
    file: "routes/stampCatalog.ts",
    select: /^"user_id, country"$/,
    verdict: "maintenance",
    guard: /const result = await evaluateCriteria\(sc, userId, def\.criteria, \{\}\);/,
    why: "admin globe_trotter backfill PRE-FILTER only: each award is gated on evaluateCriteria(countries_visited), which counts evidenced presence stamps only (criteria/metrics.ts)",
  },
  // ── Compass ──────────────────────────────────────────────────────────────
  {
    file: "compass/CompassGraphEngine.ts",
    select: /^"user_id, city, country, earned_at, is_revoked, lat, lng, source_type, source_id, stamp_definitions\(slug, evidences_presence\)"$/,
    count: 2,
    verdict: "gated", mustSelect: GATED,
    guard: /if \(def\?\.evidences_presence !== true \|\| !presence\.mayShowPlace\(r\)\) continue;/,
    why: "person —visited→ city, active_in / rhythm slices; the build and its reconcile replay read the same columns; unreadable evidence is an unsound replay (retires nothing)",
  },
  {
    file: "compass/CompassStructuredContext.ts",
    select: /^"title_override, city, country, earned_at, is_revoked, user_id, source_type, source_id, stamp_definitions\(slug, name\)"$/,
    verdict: "gated", mustSelect: GATED,
    guard: /result\.recentStamps = withPresencePlaces\(stampView, \(\(stamps \?\? \[\]\) as any\[\]\)\.filter\(\(r\) => stampView\.presenceClaimHolds\(r\)\), \["city", "country"\]\)/,
    why: "the AI's 'Passport history' lines: no place without evidence, no unevidenced presence claim",
  },
  {
    file: "compass/PassportRemembersService.ts",
    select: /^"id, stamp_definition_id, earned_at, visibility, is_revoked, display_on_passport"$/,
    verdict: "no_place",
    why: "'What Portava Remembers' origin items: 'Stamp <id>', no place, no name",
  },
  // ── Trips ────────────────────────────────────────────────────────────────
  {
    file: "domain/trips/projections/TripPostTripProjections.ts",
    select: /^"id, user_id, source_type, source_id, stamp_definition_id, earned_at, city, country, is_revoked"$/,
    verdict: "gated", mustSelect: ["user_id", "source_type", "source_id"],
    guard: /const view = await readStampPresenceView\(sc as any, slugged, log\);/,
    why: "GET /trips/:id/passport-projection and trip closeout: 'stamps awarded for this trip' drops a completion stamp nobody checked in for and withholds a non-presence place (slug from its own definitions read)",
  },
  // ── lib/stamps ───────────────────────────────────────────────────────────
  {
    file: "lib/stamps/criteria/metrics.ts",
    select: /^`\$\{field\}, user_id, source_type, source_id, stamp_definitions\(slug, evidences_presence\)`$/,
    verdict: "gated", mustSelect: GATED,
    guard: /if \(def\?\.evidences_presence !== true \|\| !view\.mayShowPlace\(row\)\) continue;/,
    why: "countries_visited / cities_visited — what mints globe_trotter_5/10",
  },
  {
    file: "lib/stamps/generationWorker.ts",
    select: /^"stamp_definition_id"$/,
    count: 3,
    verdict: "maintenance",
    why: "artwork generation links a catalog entry to the awards that triggered it; no display",
  },
  {
    file: "lib/stamps/reconcileStampCatalog.ts",
    select: /^"stamp_definition_id, country, city, stamp_definitions!stamp_definition_id\(stamp_type\)"$/,
    verdict: "maintenance",
    why: "catalog reconcile (admin/operator): may link a HISTORICAL non-presence row to a place-scoped catalog entry; every reader above withholds place-scoped art for a withheld place, so the art never shows the place",
  },
  {
    file: "lib/stamps/reconcileStampCatalog.ts",
    select: /^"id, stamp_definition_id, stamp_definitions!stamp_definition_id\(slug, name, stamp_type\)"$/,
    verdict: "maintenance",
    why: "catalog reconcile of location-less rows; no place",
  },
  // ── services/stamps ──────────────────────────────────────────────────────
  {
    file: "services/stamps/ContentStampService.ts",
    select: /^"id", \{ count: "exact", head: true \}$/,
    verdict: "count_only",
    why: "Stamps Earned (owned + received)",
  },
  // ── OPEN — another lane's file ───────────────────────────────────────────
  {
    file: "services/telegraph/shareables.ts",
    select: /"id, user_id, stamp_definition_id, title_override, city, country, visibility, display_on_passport, is_revoked, earned_at",/,
    verdict: "open",
    why: "Telegraph STAMP share card subtitle `[r.city, r.country]` is shown to a conversation without the rule. Telegraph lane's file (in flight). Change needed: select user_id/source_type/source_id + stamp_definitions(slug); `const v = await readStampPresenceView(client, [r]); if (!v.presenceClaimHolds(r)) return UNAVAILABLE(\"not_found\"); const p = v.place(r);` and use p.city/p.country",
  },
];

/** Files whose code names `user_stamps` as a literal, and how many times — catches a dynamic `.from(table)`. */
const LITERALS: Readonly<Record<string, number>> = {
  "compass/CompassGraphEngine.ts": 2,
  "compass/CompassStructuredContext.ts": 1,
  "compass/PassportRemembersService.ts": 2,
  "domain/trips/projections/TripPostTripProjections.ts": 2,
  "lib/database.types.ts": 2,
  "lib/deletionDispositions.ts": 1,
  "lib/locationPurposes.ts": 1,
  "lib/stamps/criteria/metrics.ts": 2,
  "lib/stamps/generationWorker.ts": 3,
  "lib/stamps/reconcileStampCatalog.ts": 6,
  "lib/stamps/xxCatalogRepair.ts": 3,
  "routes/adminStamps.ts": 1,
  "routes/passport.ts": 3,
  "routes/postcards.ts": 2,
  "routes/profile.ts": 1,
  "routes/stampAdmire.ts": 1,
  "routes/stampCatalog.ts": 4,
  "routes/stampShowcase.ts": 2,
  "routes/stamps.ts": 12,
  "routes/wellKnownShare.ts": 1,
  "scripts/fix-demo-stamps.ts": 1,
  "scripts/rlsDispositions.ts": 1,
  "scripts/seed-demo-profile.ts": 1,
  "services/passport/PassportJourneyService.ts": 1,
  "services/passport/PassportMapService.ts": 2,
  "services/passport/SharedContextService.ts": 1,
  "services/passport/StampAwardEngine.ts": 15,
  "services/passport/UnifiedStampService.ts": 1,
  "services/stamps/ContentStampService.ts": 1,
  "services/telegraph/shareables.ts": 1,
};

/** Why each literal-only file (no `.from("user_stamps").select`) is not a display. */
const LITERAL_ONLY_WHY: Readonly<Record<string, string>> = {
  "lib/database.types.ts": "generated types",
  "lib/deletionDispositions.ts": "deletion fate registry",
  "lib/locationPurposes.ts": "location-purpose registry",
  "lib/stamps/xxCatalogRepair.ts": "XX-country catalog repair: updates catalog_id/country on ownership rows (operator)",
  "scripts/fix-demo-stamps.ts": "one-time demo data patch (operator script)",
  "scripts/rlsDispositions.ts": "RLS disposition registry",
  "scripts/seed-demo-profile.ts": "demo seed writer (operator script)",
};

// ── Source scanning ──────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "test" || e.name === "__tests__" || e.name === "node_modules") continue;
      walk(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

function selectArgsOf(src: string): string[] {
  const out: string[] = [];
  const re = /\.from\(\s*["'`]user_stamps["'`]\s*\)\s*\.\s*select\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
    }
    out.push(src.slice(start, i - 1).replace(/\s+/g, " "));
  }
  return out;
}

function scan() {
  const files = new Map<string, { src: string; raw: string; selects: string[]; literals: number }>();
  for (const abs of walk(SRC)) {
    const rel = path.relative(SRC, abs).split(path.sep).join("/");
    const raw = fs.readFileSync(abs, "utf8");
    const src = stripComments(raw);
    const selects = selectArgsOf(src);
    const literals = (src.match(/["'`]user_stamps["'`]/g) ?? []).length;
    if (selects.length || literals) files.set(rel, { src, raw, selects, literals });
  }
  return files;
}

const PLACE_COLUMN = /\b(city|country|lat|lng)\b/;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("H4 (wave 5): every stamp read site is enumerated and classified", () => {
  const found = scan();

  it("finds the read sites at all (non-vacuity)", () => {
    const n = [...found.values()].reduce((a, f) => a + f.selects.length, 0);
    assert.ok(n >= 40, `found only ${n} user_stamps reads — the scanner is broken`);
  });

  it("every file naming user_stamps is registered with its literal count (a new reader — or a dynamic .from(table) — must be classified)", () => {
    const problems: string[] = [];
    for (const [f, v] of found) {
      if (!(f in LITERALS)) problems.push(`${f}: names user_stamps ${v.literals}x and is not in LITERALS`);
      else if (LITERALS[f] !== v.literals) problems.push(`${f}: names user_stamps ${v.literals}x, LITERALS says ${LITERALS[f]}`);
    }
    for (const f of Object.keys(LITERALS)) if (!found.has(f)) problems.push(`${f}: in LITERALS but no longer names user_stamps`);
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  it("every read is claimed by exactly one registry entry, and every entry claims exactly its count", () => {
    const problems: string[] = [];
    for (const [f, v] of found) {
      const entries = REGISTRY.filter((s) => s.file === f);
      if (v.selects.length && entries.length === 0 && !(f in LITERAL_ONLY_WHY)) problems.push(`${f}: ${v.selects.length} reads, no registry entry`);
      for (const sel of v.selects) {
        const hits = entries.filter((e) => e.select.test(sel));
        if (hits.length !== 1) problems.push(`${f}: read ${JSON.stringify(sel.slice(0, 80))} matched ${hits.length} entries`);
      }
      for (const e of entries) {
        const n = v.selects.filter((sel) => e.select.test(sel)).length;
        if (n !== (e.count ?? 1)) problems.push(`${f}: ${e.select} claims ${n} reads, registered ${e.count ?? 1}`);
      }
    }
    for (const e of REGISTRY) if (!found.has(e.file)) problems.push(`${e.file}: registered but has no reads`);
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  it("a literal-only file has no read and a stated reason", () => {
    for (const f of Object.keys(LITERAL_ONLY_WHY)) {
      assert.equal(found.get(f)?.selects.length ?? 0, 0, `${f} now reads user_stamps: classify the read in REGISTRY`);
    }
  });

  it("each site's guard is still in its file", () => {
    const missing = REGISTRY.filter((s) => s.guard && !s.guard.test(found.get(s.file)?.src ?? "")).map((s) => `${s.file}: ${s.guard}`);
    assert.deepEqual(missing, [], "a classified reader lost the gate its verdict rests on:\n" + missing.join("\n"));
  });

  it("a gated read SELECTS what the presence verdict reads (an unselected column is undefined on a real database)", () => {
    const bad: string[] = [];
    for (const s of REGISTRY.filter((x) => x.verdict === "gated" && x.mustSelect)) {
      const v = found.get(s.file)!;
      for (const sel of v.selects.filter((x) => s.select.test(x))) {
        for (const col of s.mustSelect!) if (!new RegExp(`\\b${col}\\b`).test(sel)) bad.push(`${s.file}: ${col} not selected in ${sel.slice(0, 80)}`);
      }
    }
    // The routes/stamps.ts column sets are constants; check them where they are defined.
    const stamps = found.get("routes/stamps.ts")!.src;
    for (const k of ["OWNER_STAMP_COLS", "PUBLIC_STAMP_COLS"]) {
      const def = new RegExp(`const ${k} =\\s*\\n\\s*"([^"]*)"`).exec(stamps)?.[1] ?? "";
      for (const col of ["user_id", "source_type", "source_id"]) if (!new RegExp(`\\b${col}\\b`).test(def)) bad.push(`routes/stamps.ts ${k}: ${col} not selected`);
    }
    const showcase = found.get("routes/stampShowcase.ts")!.src;
    for (const col of ["user_id", "source_type", "source_id", "slug"]) if (!new RegExp(`const STAMP_FIELDS =[^;]*\\b${col}\\b`).test(showcase)) bad.push(`routes/stampShowcase.ts STAMP_FIELDS: ${col}`);
    const passport = found.get("routes/passport.ts")!.src;
    for (const col of ["user_id", "source_type", "source_id"]) if (!new RegExp(`const BASE_COLS = "[^"]*\\b${col}\\b`).test(passport)) bad.push(`routes/passport.ts BASE_COLS: ${col}`);
    assert.deepEqual(bad, [], bad.join("\n"));
  });

  it("a no_place / count_only read selects no place column", () => {
    const bad: string[] = [];
    for (const s of REGISTRY.filter((x) => x.verdict === "no_place" || x.verdict === "count_only")) {
      if (s.file === "routes/passport.ts") continue; // the artwork lookup key, stated in its `why`
      for (const sel of found.get(s.file)!.selects.filter((x) => s.select.test(x))) {
        if (PLACE_COLUMN.test(sel)) bad.push(`${s.file}: ${sel}`);
      }
    }
    assert.deepEqual(bad, [], bad.join("\n"));
  });

  it("routes/stamps.ts: every stamp it serves goes through formatStamps, and formatStamps applies the view", () => {
    const src = found.get("routes/stamps.ts")!.src;
    const direct = (src.match(/\bformatStamp\(/g) ?? []).length;
    assert.equal(direct, 2, "formatStamp is called only by its definition and by formatStamps");
    assert.equal((src.match(/await formatStamps\(sc, /g) ?? []).length, 9, "nine serving sites (me, user owner, user public, profile, recent, city, country, stamp owner, stamp public)");
    assert.equal((src.match(/formatStamps\(sc, visible, \{ placeKeyed: true \}\)/g) ?? []).length, 2, "the city and country feeds keep only evidenced stamps");
    assert.match(src, /formatStamps\(sc, rows, \{ placeKeyed \}\)/, "GET /stamps/me with ?city=/?country=");
    assert.match(src, /formatStamps\(sc, visible, \{ thirdParty: true \}\)/, "the public recent feed");
    assert.match(src, /formatStamps\(sc, \[publicStamp\], \{ thirdParty: true \}\)/, "a single stamp for someone else");
  });

  it("the one caller that hands buildStats a caller's RLS client also hands it the service client for the evidence", () => {
    const route = fs.readFileSync(path.join(SRC, "routes/passportStamps.ts"), "utf8");
    assert.match(route, /buildStats\(client, user\.id, \{ evidenceClient: sc \}\)/);
    const map = found.get("services/passport/PassportMapService.ts")!.src;
    assert.match(map, /readStampPresenceView\(opts\.evidenceClient \?\? db, rows, logger\)/);
  });

  it("the open set is exactly the one other-lane reader, and may only shrink", () => {
    assert.deepEqual(REGISTRY.filter((s) => s.verdict === "open").map((s) => s.file), ["services/telegraph/shareables.ts"]);
  });

  it("the verdict tally (the report's per-reader table is this registry)", () => {
    const tally: Record<string, number> = {};
    for (const s of REGISTRY) tally[s.verdict] = (tally[s.verdict] ?? 0) + (s.count ?? 1);
    assert.deepEqual(tally, { gated: 22, writer: 7, count_only: 3, no_place: 6, admin_raw: 3, maintenance: 6, open: 1 });
  });
});
