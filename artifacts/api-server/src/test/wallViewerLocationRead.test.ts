/**
 * wallViewerLocationRead — the Wall's viewer-signal read from `profiles`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS LOCKS DOWN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * loadViewerContext (src/routes/wall.ts) read `profiles` with
 *
 *     .select("current_city, current_country, home_city, interests")
 *
 * `profiles` has no `current_country` column and never has. It belongs to
 * `compass_user_profiles` (migration 0051). The live snapshot this suite loads
 * (src/test/generated/liveColumns.json — information_schema.columns of the CI
 * project, 83 `profiles` columns) has `country`, `country_code`, `home_country`,
 * `home_country_verified_at` and `location_country` — and no `current_country`.
 *
 * PostgREST does not null out an unknown select-list column; it fails the WHOLE
 * request with PGRST100. The read sat inside a bare `catch` whose body was only
 * a "non-fatal" comment — the error was never bound, let alone logged — so the
 * failure was invisible: `currentCity`, `preferredCities` and `interests` were
 * ALL empty on every Wall request for the life of the feature, and nothing
 * anywhere said so. THREE OF THE FOUR COLUMNS WERE REAL, which is exactly why it
 * never looked broken. The Wall therefore never knew the viewer's city — a
 * first-order ranking and discovery-explanation signal (spec §13).
 *
 * Fixed on main in e9aadb35e + 02ff8fdea: the select drops the column, and the
 * error is bound and logged with its code. There was no test. The Wall route
 * fixtures still hand back rows CARRYING `current_country`, and their fake
 * ignores the select list entirely, which is precisely how the original read
 * stayed green. This is the guard.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS PROVEN, AND WHY IT IS NOT VACUOUS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   F1   The fake models PostgREST: an unknown select-list column fails the
 *        WHOLE read and returns NO data. Proven against the fake itself first —
 *        a fake that ignored the select list would let T1 pass under the
 *        original bug.
 *   F2   The live snapshot really lacks `current_country` and really has the
 *        three columns the fixed select names. If the snapshot is refreshed and
 *        this changes, the suite says so instead of quietly modelling fiction.
 *   T1   THE PROOF. The viewer's city, preferred cities and interests all come
 *        back populated. Under the original select every one of them is empty.
 *   T2   The select list never names `current_country`, and still names the
 *        three real columns the Wall needs.
 *   T3   `currentCountry` stays null and is NOT quietly substituted from
 *        `country` / `home_country` / `location_country` — all three exist on
 *        `profiles` and all three would be a different fact.
 *   T4   A schema error still yields a well-formed context (best-effort is
 *        preserved, the feed never dies for a missing ranking signal) AND is
 *        surfaced to the log WITH ITS CODE. Bare-catch-with-a-comment is the
 *        shape that hid this for the life of the feature.
 *   T5   A missing profile row yields a well-formed, empty context — SILENTLY.
 *        A warning on every viewer without a profile row would make the T4
 *        signal worthless inside a week.
 *   T6   THE COLLAPSE DETECTOR. T4 and T5 must produce DIFFERENT observable
 *        outcomes. T6 fails if the two paths are ever merged, in either
 *        direction: swallow both, or log both.
 *
 * Run (with the same environment the package `test` script sets — the route
 * module builds a Supabase client at import time and needs the dummy values):
 *   node --import tsx/esm --test src/test/wallViewerLocationRead.test.ts
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { logger } from "../lib/logger.js";
import { liveColumns } from "./helpers/liveColumns.ts";

// ── The unit under test ──────────────────────────────────────────────────────
//
// wall.ts derives a CHILD logger at module load (`rootLogger.child({ route:
// "wall" })`). A child created before the spies below are installed writes
// straight to pino's destination and bypasses them — T4 would then fail with
// "captured: []" while the real WARN line scrolls past on stdout. So the route
// module is loaded AFTER `child` is briefly redirected to the root: the child
// IS the root for the life of this process, and the per-test spies see every
// call. No pino internals are touched.
let loadViewerContext: (typeof import("../routes/wall.js"))["loadViewerContext"];

before(async () => {
  const realChild = logger.child.bind(logger);
  (logger as any).child = () => logger;
  try {
    ({ loadViewerContext } = await import("../routes/wall.js"));
  } finally {
    (logger as any).child = realChild;
  }
});

// ── The live `profiles` column set ───────────────────────────────────────────
//
// Read from the generated live-schema snapshot rather than transcribed by hand,
// so the fake rejects exactly what the real database rejects and there is one
// source of truth for "which columns exist". F2 pins the two facts this suite
// depends on, so a refreshed snapshot cannot silently change what is proven.
const PROFILES_COLUMNS: ReadonlySet<string> = liveColumns("profiles");

/**
 * Tables whose select list the fake actually validates. Everything else is
 * permissive and returns whatever the dataset holds — this suite is about ONE
 * read, and modelling the whole schema would be fiction maintained by nobody.
 */
const MODELLED_SCHEMA: Record<string, ReadonlySet<string>> = {
  profiles: PROFILES_COLUMNS,
};

interface PostgrestErrorShape {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

/** Split a PostgREST select list on TOP-LEVEL commas. */
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
 * PostgREST's behaviour on a select list naming a column the table lacks: the
 * WHOLE request fails, `data` is null, and the error carries PGRST100 — the
 * code src/lib/schemaDriftCheck.ts already treats as "column does not exist".
 */
function rejectUnknownColumns(table: string, select: string): PostgrestErrorShape | null {
  const known = MODELLED_SCHEMA[table];
  if (!known) return null;
  for (const token of splitSelectList(select)) {
    const col = bareColumn(token);
    if (col && !known.has(col)) {
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
   * Force this error on every read of the named table, whatever the select.
   * Drives the schema-error path while the source is CORRECT — T4 is about the
   * handling, not the column name.
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
      // The WHOLE read fails — not "this column comes back null". A fake that
      // returned partial data here could not catch the defect this file exists for.
      if (schemaError) return { data: null, error: schemaError };

      let rows = (data[table] ?? []).map((r: any) => ({ ...r }));
      for (const f of filters) {
        if (f.op === "eq") rows = rows.filter((r: any) => String(r[f.col]) === String(f.val));
        else if (f.op === "in") rows = rows.filter((r: any) => (f.val as any[]).map(String).includes(String(r[f.col])));
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
      gt() { return b; },
      ilike() { return b; },
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
// Channel-agnostic: pino's shared `logger` AND bare console. The assertion
// under test is "the error was SURFACED with its code", not "through this
// particular function", so switching channels must not silently turn T4 green.

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

/** Captured log lines that name the viewer-location read. */
function viewerLocationLogs(): string[] {
  return captured.map(callText).filter((t) => /viewer location/i.test(t));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VIEWER = "11111111-1111-1111-1111-111111111111";

/**
 * A fully populated viewer row.
 *
 * NOTE WHAT IS AND IS NOT HERE: `current_city`, `home_city` and `interests` are
 * real columns and carry values. `country`, `home_country` and `location_country`
 * are ALSO real and ALSO carry values — they are present precisely so T3 can
 * prove none of them is quietly promoted into `currentCountry`. There is no
 * `current_country` key, because there is no such column.
 */
const PROFILE_ROW = {
  id: VIEWER,
  account_status: "active",
  current_city: "Da Nang",
  home_city: "Hanoi",
  interests: ["Food", "Nightlife"],
  country: "Vietnam",
  home_country: "VN",
  location_country: "VN",
};

/** The other tables loadViewerContext reads; empty is a valid, quiet answer. */
const OTHER_TABLES = { user_follows: [], trip_members: [], trips: [] };

const SCHEMA_ERROR: PostgrestErrorShape = {
  code: "PGRST100",
  message: "failed to parse select parameter",
  details: "column profiles.current_country does not exist",
  hint: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// F. The fake is not a rubber stamp
// ─────────────────────────────────────────────────────────────────────────────

describe("the fake models PostgREST's select-list rejection", () => {
  it("F1: an unknown select-list column fails the WHOLE read — no partial data", async () => {
    const { sc } = makeSc({ profiles: [PROFILE_ROW] });
    const res = await sc
      .from("profiles")
      .select("current_city, current_country, home_city, interests")
      .eq("id", VIEWER)
      .maybeSingle();

    assert.equal(res.data, null, "PostgREST returns NO data when the select list is bad");
    assert.ok(res.error, "a bad select-list column must produce an error");
    assert.equal(res.error.code, "PGRST100");
    assert.match(
      String(res.error.details),
      /current_country does not exist/,
      "the error must name the offending column",
    );
  });

  it("F2: the live profiles snapshot lacks current_country and has the three real columns", () => {
    assert.ok(
      !PROFILES_COLUMNS.has("current_country"),
      "profiles has never had a `current_country` column — that is the whole defect. " +
        "If the live snapshot now says otherwise, the column was ADDED and this suite's premise is gone.",
    );
    for (const col of ["current_city", "home_city", "interests"]) {
      assert.ok(PROFILES_COLUMNS.has(col), `${col} is a real profiles column`);
    }
    // The tempting substitutes. All real, all a DIFFERENT fact.
    for (const col of ["country", "home_country", "location_country"]) {
      assert.ok(PROFILES_COLUMNS.has(col), `${col} exists and is not the same thing`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T1. THE PROOF — the Wall knows the viewer's city
// ─────────────────────────────────────────────────────────────────────────────

describe("loadViewerContext: the viewer's location signals are actually read", () => {
  it("T1: currentCity, preferredCities and interests all come back populated", async () => {
    const { sc } = makeSc({ profiles: [PROFILE_ROW], ...OTHER_TABLES });

    const ctx = await loadViewerContext(sc, VIEWER);

    // Under the original select list this is null — the whole read died.
    assert.equal(
      ctx.currentCity,
      "Da Nang",
      "the Wall must know the viewer's current city; null means the profiles read failed entirely",
    );
    assert.deepEqual(
      [...ctx.preferredCities].sort(),
      ["da nang", "hanoi"],
      "current_city and home_city both feed preferredCities",
    );
    assert.deepEqual(
      [...ctx.interests].sort(),
      ["food", "nightlife"],
      "interests are lowercased and loaded",
    );
    assert.equal(viewerLocationLogs().length, 0, "a clean read logs nothing");
  });

  it("T2: the profiles select list never names current_country", async () => {
    const { sc, selects } = makeSc({ profiles: [PROFILE_ROW], ...OTHER_TABLES });
    await loadViewerContext(sc, VIEWER);

    const profileSelect = selects.find((s) => s.table === "profiles");
    assert.ok(profileSelect, "loadViewerContext must read the profiles table");
    const cols = splitSelectList(profileSelect.select).map(bareColumn);
    assert.ok(
      !cols.includes("current_country"),
      `profiles has no \`current_country\` column; select list was: ${profileSelect.select}`,
    );
    // ...and it still asks for everything it legitimately needs.
    for (const col of ["current_city", "home_city", "interests"]) {
      assert.ok(cols.includes(col), `select list must still name ${col}; got: ${profileSelect.select}`);
    }
    // ...and every column it names is one the live table has. This is the
    // general form of T2: it catches the NEXT invented column, not just this one.
    for (const col of cols) {
      if (col) assert.ok(PROFILES_COLUMNS.has(col), `select names ${col}, which profiles does not have`);
    }
  });

  it("T3: currentCountry stays null — never substituted from a different column", async () => {
    const { sc } = makeSc({ profiles: [PROFILE_ROW], ...OTHER_TABLES });

    const ctx = await loadViewerContext(sc, VIEWER);

    // The row carries country="Vietnam", home_country="VN", location_country="VN".
    // Any of them appearing here would be the Wall asserting a fact the schema
    // does not record. The honest source is compass_user_profiles.current_country,
    // which is a different read with its own privacy posture.
    assert.equal(
      ctx.currentCountry,
      null,
      "currentCountry must be an honest null, not a stand-in for country/home_country/location_country",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4-T6. Best-effort is preserved, and a schema error is not a missing row
// ─────────────────────────────────────────────────────────────────────────────

describe("loadViewerContext: a failed or absent read degrades, never throws", () => {
  it("T4: a schema error still yields a well-formed context AND is surfaced with its code", async () => {
    const { sc } = makeSc(
      { profiles: [PROFILE_ROW], ...OTHER_TABLES },
      { forceError: { table: "profiles", error: SCHEMA_ERROR } },
    );

    // A missing ranking signal must never take the feed down (spec §34).
    const ctx = await loadViewerContext(sc, VIEWER);

    assert.equal(ctx.currentCity, null);
    assert.equal(ctx.currentCountry, null);
    assert.equal(ctx.preferredCities.size, 0);
    assert.equal(ctx.interests.size, 0);
    assert.ok(ctx.followedCreatorIds instanceof Set, "the context is still well-formed");

    // ...but silently is how this went unnoticed for the life of the feature.
    const logs = viewerLocationLogs();
    assert.ok(
      logs.length >= 1,
      `a rejected profiles read must be logged; captured: ${JSON.stringify(captured.map(callText))}`,
    );
    assert.ok(
      logs.some((t) => t.includes("PGRST100")),
      `the log line must carry the driver's error code; got: ${JSON.stringify(logs)}`,
    );
  });

  it("T5: a missing profile row yields a well-formed, empty context — silently", async () => {
    const { sc } = makeSc({ profiles: [], ...OTHER_TABLES });

    const ctx = await loadViewerContext(sc, VIEWER);

    assert.equal(ctx.currentCity, null);
    assert.equal(ctx.preferredCities.size, 0);
    assert.ok(ctx.viewerTripIds instanceof Set);
    assert.equal(
      viewerLocationLogs().length,
      0,
      "no profile row is normal (maybeSingle → null) and must not warn — or T4's signal drowns",
    );
  });

  it("T6: collapse detector — the schema-error path and the missing-row path stay distinguishable", async () => {
    const missing = makeSc({ profiles: [], ...OTHER_TABLES });
    await loadViewerContext(missing.sc, VIEWER);
    const missingLogs = viewerLocationLogs().length;

    captured = [];
    const rejected = makeSc(
      { profiles: [PROFILE_ROW], ...OTHER_TABLES },
      { forceError: { table: "profiles", error: SCHEMA_ERROR } },
    );
    await loadViewerContext(rejected.sc, VIEWER);
    const rejectedLogs = viewerLocationLogs().length;

    assert.equal(missingLogs, 0, "missing row: silent");
    assert.ok(rejectedLogs > 0, "schema error: logged");
    assert.notEqual(
      missingLogs,
      rejectedLogs,
      "if these ever match, `error` and `no row` have been folded into one path again",
    );
  });
});
