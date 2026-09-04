/**
 * mediaProjectionPlaceIdentity — buildPlaceProjection's coarse place-identity read.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS LOCKS DOWN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * buildPlaceProjection read `places` with
 *
 *     .select("id, name, city, country, neighborhood")
 *
 * The `places` table has `country_code` (migration 2028_canonical_places.sql);
 * it has NEVER had a `country` column, in CI or in production.
 *
 * PostgREST does not degrade a bad select-list column to null — it fails the
 * WHOLE read. And this read sits inside a try/catch whose comment reads
 * "Best-effort; a failed read leaves nulls". So one wrong column name did not
 * empty one field: it emptied place identity ENTIRELY, on every projection,
 * for as long as the line existed. Name, city, country and neighbourhood all
 * null, no error anywhere, and output indistinguishable from a place nobody
 * has labelled yet. THREE OF THE FOUR COLUMNS WERE CORRECT, which is exactly
 * why it never looked broken.
 *
 * Fixed in 14ec22d63. There was no test. This is it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS PROVEN, AND WHY IT IS NOT VACUOUS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   F1-F3  The fake models PostgREST: an unknown select-list column fails the
 *          WHOLE read with a PostgREST error and NO data. A fake that ignored
 *          the select list would make T1 pass under the original bug, so the
 *          fake is proven first, against itself, before anything uses it.
 *   T1     A real place row round-trips all four identity fields. This is the
 *          assertion the original bug fails: with `country` in the select the
 *          read dies and all four come back null.
 *   T2     A schema error still returns a projection (best-effort preserved)
 *          AND is surfaced to the log WITH ITS CODE.
 *   T2b    The surfaced code is whatever the driver returned, not a literal
 *          baked into the message.
 *   T3     A missing place row is SILENT. That is the whole reason the catch
 *          exists, and a schema warning on every unknown place would make the
 *          signal worthless inside a week.
 *   T4     THE COLLAPSE DETECTOR. T2 and T3 must produce DIFFERENT observable
 *          outcomes. T4 fails if the two paths are ever merged — in either
 *          direction: swallow both, or log both.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaProjectionPlaceIdentity.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildPlaceProjection,
  type ViewerResolved,
} from "../services/media/MediaProjectionService.js";
import { logger } from "../lib/logger.js";

// ── The live `places` column set ─────────────────────────────────────────────
//
// Transcribed from the migrations that define the table, so the fake rejects
// exactly what the real database rejects:
//
//   2028_canonical_places.sql              — CREATE TABLE places (...)
//   2030_postgis_spatial.sql               — + geog (generated)
//   2056_places_header_image_generated_id  — + header_image_generated_id
//   20260809_real_place_image_provenance   — + image_source_type,
//                                              image_accuracy_status
//
// `country` is absent because it has never existed. `country_code` is the
// real column. That one-word gap is the entire defect.
const PLACES_COLUMNS: readonly string[] = [
  "id",
  "name",
  "normalized_name",
  "primary_category",
  "latitude",
  "longitude",
  "address",
  "city",
  "neighborhood",
  "country_code",
  "canonical_location_id",
  "status",
  "merged_into_place_id",
  "field_freshness",
  "created_at",
  "updated_at",
  "geog",
  "header_image_generated_id",
  "image_source_type",
  "image_accuracy_status",
];

/**
 * Tables whose select list the fake actually validates. Everything else is
 * permissive and returns [] — this suite is about ONE read, and modelling the
 * whole schema would be fiction maintained by nobody.
 */
const MODELLED_SCHEMA: Record<string, readonly string[]> = {
  places: PLACES_COLUMNS,
};

interface PostgrestErrorShape {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

/**
 * Split a PostgREST select list on TOP-LEVEL commas, so an embedded resource
 * — `post_media(id, public_url)` — stays one token instead of exploding into
 * bogus column names.
 */
function splitSelectList(select: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of select) {
    if (ch === "(") { depth += 1; cur += ch; }
    else if (ch === ")") { depth -= 1; cur += ch; }
    else if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** `alias:column::cast` → `column`. Embedded resources and `*` return null. */
function bareColumn(token: string): string | null {
  if (token === "*" || token.includes("(")) return null;
  const withoutCast = token.split("::")[0]!.trim();
  const parts = withoutCast.split(":");
  return parts[parts.length - 1]!.trim();
}

/**
 * PostgREST's behaviour on a select list naming a column the table does not
 * have: the WHOLE request fails, `data` is null, and the error carries a code
 * the repo already treats as "column does not exist"
 * (src/lib/schemaDriftCheck.ts: 42703 / 42P01 / PGRST100 / PGRST204 / PGRST205).
 *
 * Returns null when the select list is clean.
 */
function rejectUnknownColumns(table: string, select: string): PostgrestErrorShape | null {
  const known = MODELLED_SCHEMA[table];
  if (!known) return null;
  for (const token of splitSelectList(select)) {
    const col = bareColumn(token);
    if (col && !known.includes(col)) {
      return {
        code: "PGRST100",
        message: `"failed to parse select parameter (${select})" (line 1, column 1)`,
        details: `column ${table}.${col} does not exist`,
        hint: null,
      };
    }
  }
  return null;
}

// ── A select-list-aware fake Supabase client ─────────────────────────────────

type Dataset = Record<string, any[]>;

interface ScOptions {
  /**
   * Force this error on every read of the named table, regardless of the
   * select list. Used to drive the schema-error path while the source is
   * CORRECT — the point of T2 is the handling, not the column name.
   */
  forceError?: { table: string; error: PostgrestErrorShape };
}

interface FakeSc {
  sc: any;
  /** Every select list the code under test asked for, in order. */
  selects: Array<{ table: string; select: string }>;
}

function makeSc(data: Dataset, opts: ScOptions = {}): FakeSc {
  const selects: Array<{ table: string; select: string }> = [];

  const builder = (table: string): any => {
    const filters: Array<{ op: string; col: string; val: any }> = [];
    let selectList = "*";

    /** Project down to the selected columns, the way PostgREST does. */
    const project = (row: any): any => {
      if (!MODELLED_SCHEMA[table] || selectList === "*") return { ...row };
      const out: any = {};
      for (const token of splitSelectList(selectList)) {
        const col = bareColumn(token);
        if (col) out[col] = row[col] ?? null;
      }
      return out;
    };

    const resolve = (): { data: any[] | null; error: PostgrestErrorShape | null } => {
      if (opts.forceError && opts.forceError.table === table) {
        return { data: null, error: opts.forceError.error };
      }
      const schemaError = rejectUnknownColumns(table, selectList);
      // The WHOLE read fails. Not "this column comes back null" — the request
      // returns no rows at all. A fake that returned partial data here could
      // not catch the defect this file exists for.
      if (schemaError) return { data: null, error: schemaError };

      let rows = (data[table] ?? []).map((r: any) => ({ ...r }));
      for (const f of filters) {
        if (f.op === "eq") rows = rows.filter((r: any) => String(r[f.col]) === String(f.val));
        else if (f.op === "in") rows = rows.filter((r: any) => (f.val as any[]).map(String).includes(String(r[f.col])));
        else if (f.op === "gt") rows = rows.filter((r: any) => r[f.col] != null && r[f.col] > f.val);
        else if (f.op === "ilike") {
          const needle = String(f.val).replace(/%/g, "").toLowerCase();
          rows = rows.filter((r: any) => String(r[f.col] ?? "").toLowerCase().includes(needle));
        }
      }
      return { data: rows.map(project), error: null };
    };

    const b: any = {
      select(list?: string) {
        selectList = typeof list === "string" && list.length > 0 ? list : "*";
        selects.push({ table, select: selectList });
        return b;
      },
      eq(col: string, val: any) { filters.push({ op: "eq", col, val }); return b; },
      in(col: string, val: any) { filters.push({ op: "in", col, val }); return b; },
      gt(col: string, val: any) { filters.push({ op: "gt", col, val }); return b; },
      ilike(col: string, val: any) { filters.push({ op: "ilike", col, val }); return b; },
      not() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      maybeSingle() {
        const { data: rows, error } = resolve();
        return Promise.resolve({ data: rows ? (rows[0] ?? null) : null, error });
      },
      single() {
        const { data: rows, error } = resolve();
        return Promise.resolve({ data: rows ? (rows[0] ?? null) : null, error });
      },
      then(onF: any, onR: any) {
        return Promise.resolve(resolve()).then(onF, onR);
      },
    };
    return b;
  };

  return { sc: { from: (table: string) => builder(table) } as any, selects };
}

// ── Log capture ──────────────────────────────────────────────────────────────
//
// Deliberately channel-agnostic: pino's shared `logger` AND bare console. The
// assertion under test is "the error was SURFACED with its code", not "it was
// surfaced through this particular function", so switching channels must not
// silently turn these tests green.

let captured: any[][] = [];

const realLoggerWarn = logger.warn.bind(logger);
const realLoggerError = logger.error.bind(logger);
const realConsoleWarn = console.warn;
const realConsoleError = console.error;

beforeEach(() => {
  captured = [];
  (logger as any).warn = (...a: any[]) => { captured.push(a); };
  (logger as any).error = (...a: any[]) => { captured.push(a); };
  console.warn = (...a: any[]) => { captured.push(a); };
  console.error = (...a: any[]) => { captured.push(a); };
});

afterEach(() => {
  (logger as any).warn = realLoggerWarn;
  (logger as any).error = realLoggerError;
  console.warn = realConsoleWarn;
  console.error = realConsoleError;
});

/** Flatten one captured call to text, so structured fields are searchable. */
function callText(args: any[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(" ");
}

/** Captured log lines that name the place-identity read. */
function placeIdentityLogs(): string[] {
  return captured.map(callText).filter((t) => /place identity/i.test(t));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VIEWER: ViewerResolved = {
  viewerId: "11111111-1111-1111-1111-111111111111",
  viewerCountry: null,
  viewerAge: null,
  followedCreatorIds: new Set<string>(),
  viewerTripIds: new Set<string>(),
};

const PLACE_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ABSENT_PLACE = "dddddddd-dddd-dddd-dddd-dddddddddddd";

/**
 * A fully labelled place row.
 *
 * NOTE THE TWO SIDES OF THE MISMATCH, stated here on purpose:
 *   DB COLUMN      places.country_code = "VN"
 *   PROJECTION     PlaceProjection.place.country
 * The projection renames the column. `country` is NOT a column and there is
 * deliberately no fixture key for it.
 */
const PLACE_ROW = {
  id: PLACE_1,
  name: "An Thuong Bar",
  normalized_name: "an thuong bar",
  primary_category: "nightlife",
  city: "Da Nang",
  neighborhood: "An Thuong",
  country_code: "VN",
  status: "active",
};

// ─────────────────────────────────────────────────────────────────────────────
// F. The fake is not a rubber stamp
// ─────────────────────────────────────────────────────────────────────────────

describe("the fake models PostgREST's select-list rejection", () => {
  it("F1: an unknown select-list column fails the WHOLE read — no partial data", async () => {
    const { sc } = makeSc({ places: [PLACE_ROW] });
    const res = await sc
      .from("places")
      .select("id, name, city, country, neighborhood")
      .eq("id", PLACE_1)
      .maybeSingle();

    assert.equal(res.data, null, "PostgREST returns NO data when the select list is bad");
    assert.ok(res.error, "a bad select-list column must produce an error");
    assert.equal(res.error.code, "PGRST100");
    assert.match(
      String(res.error.details),
      /country does not exist/,
      "the error must name the offending column",
    );
  });

  it("F2: a valid select returns only the selected columns", async () => {
    const { sc } = makeSc({ places: [PLACE_ROW] });
    const res = await sc
      .from("places")
      .select("id, name, city, country_code, neighborhood")
      .eq("id", PLACE_1)
      .maybeSingle();

    assert.equal(res.error, null);
    assert.deepEqual(Object.keys(res.data).sort(), [
      "city", "country_code", "id", "name", "neighborhood",
    ]);
    assert.equal(res.data.country_code, "VN");
    assert.equal(
      (res.data as any).country,
      undefined,
      "an unselected (and nonexistent) column must not materialise",
    );
  });

  it("F3: the modelled places schema has country_code and has never had country", () => {
    assert.ok(PLACES_COLUMNS.includes("country_code"), "country_code is the real column");
    assert.ok(
      !PLACES_COLUMNS.includes("country"),
      "places has never had a `country` column — that is the whole defect",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T1. A real place returns its identity
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlaceProjection: a real place returns its identity", () => {
  it("T1: name, city, country and neighborhood all come back populated", async () => {
    // No posts: the projection's media fallback (`if (!placeName) placeName =
    // media.find(...)`) must not be able to refill what the read dropped, or
    // the original bug could hide behind it.
    const { sc } = makeSc({ places: [PLACE_ROW], posts: [] });

    const p = await buildPlaceProjection(sc, VIEWER, PLACE_1, Date.now());

    assert.equal(p.place.id, PLACE_1);
    assert.equal(p.place.name, "An Thuong Bar");
    assert.equal(p.place.city, "Da Nang");
    assert.equal(p.place.neighborhood, "An Thuong");
    // THE RENAME, ASSERTED ON BOTH SIDES: the DB column is `country_code`,
    // the projection field is `country`. Same value, different names.
    assert.equal(
      p.place.country,
      PLACE_ROW.country_code,
      "projection.place.country must carry the value of the places.country_code COLUMN",
    );

    // Nothing was logged: a readable place is not an incident.
    assert.deepEqual(placeIdentityLogs(), []);
  });

  it("T1b: the select list names country_code and never names country", async () => {
    const { sc, selects } = makeSc({ places: [PLACE_ROW], posts: [] });
    await buildPlaceProjection(sc, VIEWER, PLACE_1, Date.now());

    const placesSelect = selects.find((s) => s.table === "places");
    assert.ok(placesSelect, "buildPlaceProjection must read the places table");
    const cols = splitSelectList(placesSelect.select).map(bareColumn);
    assert.ok(cols.includes("country_code"), `select list must name country_code; got: ${placesSelect.select}`);
    assert.ok(
      !cols.includes("country"),
      `places has no \`country\` column; select list was: ${placesSelect.select}`,
    );
  });

  it("T1c: under the ORIGINAL select list the whole identity would be empty", async () => {
    // Not a test of the service — a test of the CLAIM the fix rests on. The
    // bad column does not degrade one field; it empties all four. Modelled
    // directly so the claim is checkable without reverting the source.
    const { sc } = makeSc({ places: [PLACE_ROW] });
    const res = await sc
      .from("places")
      .select("id, name, city, country, neighborhood")
      .eq("id", PLACE_1)
      .maybeSingle();

    const asProjected = {
      name: (res.data as any)?.name ?? null,
      city: (res.data as any)?.city ?? null,
      country: (res.data as any)?.country ?? null,
      neighborhood: (res.data as any)?.neighborhood ?? null,
    };
    assert.deepEqual(asProjected, { name: null, city: null, country: null, neighborhood: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2. A schema error is surfaced, not swallowed
// ─────────────────────────────────────────────────────────────────────────────

const PGRST100_ERROR: PostgrestErrorShape = {
  code: "PGRST100",
  message: '"failed to parse select parameter (id,name,city,country,neighborhood)" (line 1, column 16)',
  details: "column places.country does not exist",
  hint: null,
};

describe("buildPlaceProjection: a schema error surfaces", () => {
  it("T2: the projection still returns (best-effort is preserved)", async () => {
    const { sc } = makeSc(
      { places: [PLACE_ROW], posts: [] },
      { forceError: { table: "places", error: PGRST100_ERROR } },
    );

    const p = await buildPlaceProjection(sc, VIEWER, PLACE_1, Date.now());

    // Best-effort: a well-formed projection, NOT a thrown error. Turning this
    // into a hard failure would break every caller for one unreadable label.
    assert.equal(p.place.id, PLACE_1);
    assert.equal(p.place.name, null);
    assert.equal(p.place.city, null);
    assert.equal(p.place.country, null);
    assert.equal(p.place.neighborhood, null);
    assert.ok(typeof p.generatedAt === "string" && p.generatedAt.length > 0);
  });

  it("T2a: the error is surfaced WITH its code and the place id", async () => {
    const { sc } = makeSc(
      { places: [PLACE_ROW], posts: [] },
      { forceError: { table: "places", error: PGRST100_ERROR } },
    );

    await buildPlaceProjection(sc, VIEWER, PLACE_1, Date.now());

    const logs = placeIdentityLogs();
    assert.equal(logs.length, 1, `expected exactly one place-identity log; got ${JSON.stringify(captured)}`);
    assert.match(logs[0]!, /PGRST100/, "the log must carry the PostgREST error code");
    assert.ok(
      logs[0]!.includes(PLACE_1),
      "the log must name the place id, or it cannot be acted on",
    );
  });

  it("T2b: the surfaced code is the driver's, not a literal baked into the message", async () => {
    // Postgres reports the same fault as 42703 (undefined_column) on some
    // paths — see src/lib/schemaDriftCheck.ts, which treats 42703, 42P01,
    // PGRST100, PGRST204 and PGRST205 alike. If the handler hardcoded
    // "PGRST100" the next occurrence would be mislabelled.
    const { sc } = makeSc(
      { places: [PLACE_ROW], posts: [] },
      {
        forceError: {
          table: "places",
          error: {
            code: "42703",
            message: "column places.country does not exist",
            details: null,
            hint: null,
          },
        },
      },
    );

    await buildPlaceProjection(sc, VIEWER, PLACE_1, Date.now());

    const logs = placeIdentityLogs();
    assert.equal(logs.length, 1, `expected exactly one place-identity log; got ${JSON.stringify(captured)}`);
    assert.match(logs[0]!, /42703/, "the log must carry the code the driver actually returned");
    assert.doesNotMatch(logs[0]!, /PGRST100/, "the code must not be a hardcoded literal");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3. A missing row stays silent
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlaceProjection: a missing place row is silent", () => {
  it("T3: an absent place logs NOTHING and still returns a projection", async () => {
    // The catch exists FOR this case. A place that simply is not there is
    // ordinary — pre-launch, most ids resolve to nothing. Warning here would
    // bury the schema signal within a week.
    const { sc } = makeSc({ places: [], posts: [] });

    const p = await buildPlaceProjection(sc, VIEWER, ABSENT_PLACE, Date.now());

    assert.equal(p.place.id, ABSENT_PLACE);
    assert.equal(p.place.name, null);
    assert.equal(p.place.country, null);
    assert.deepEqual(
      placeIdentityLogs(),
      [],
      "a missing row must NOT be reported as a schema failure",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4. THE COLLAPSE DETECTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("schema error and missing row are observably DIFFERENT", () => {
  it("T4: exactly one of the two paths logs — collapsing them fails this", async () => {
    // Same code, two inputs, one process. Whatever the handler does, these
    // two runs must not look the same from outside.

    // (a) schema error
    captured = [];
    const schemaSc = makeSc(
      { places: [PLACE_ROW], posts: [] },
      { forceError: { table: "places", error: PGRST100_ERROR } },
    );
    const schemaProjection = await buildPlaceProjection(schemaSc.sc, VIEWER, PLACE_1, Date.now());
    const loggedOnSchemaError = placeIdentityLogs().length > 0;

    // (b) missing row
    captured = [];
    const missingSc = makeSc({ places: [], posts: [] });
    const missingProjection = await buildPlaceProjection(missingSc.sc, VIEWER, ABSENT_PLACE, Date.now());
    const loggedOnMissingRow = placeIdentityLogs().length > 0;

    // ── THE ONE ASSERTION THAT FAILS IF THE TWO PATHS ARE EVER COLLAPSED ──
    // Swallow both  → false !== false → fails.
    // Log both      → true  !== true  → fails.
    // Only the correct split (log the schema error, stay silent on the
    // missing row) satisfies it. Note it is symmetric on purpose: it does not
    // merely check "something was logged", it checks the two cases DIVERGE.
    assert.notEqual(
      loggedOnSchemaError,
      loggedOnMissingRow,
      `an unreadable place must be distinguishable from an unlabelled one; ` +
        `schema-error logged=${loggedOnSchemaError}, missing-row logged=${loggedOnMissingRow}`,
    );

    // ...and it must diverge in the RIGHT direction.
    assert.equal(loggedOnSchemaError, true, "the schema error is the one that gets reported");
    assert.equal(loggedOnMissingRow, false, "the missing row is the one that stays quiet");

    // Both still return a well-formed, best-effort projection — the nulls are
    // identical, which is exactly why the LOG has to be the thing that differs.
    assert.deepEqual(
      { n: schemaProjection.place.name, c: schemaProjection.place.country },
      { n: missingProjection.place.name, c: missingProjection.place.country },
      "the payloads are indistinguishable — only the log separates the cases",
    );
  });
});
