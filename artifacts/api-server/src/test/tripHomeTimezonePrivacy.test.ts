/**
 * Owner ruling 2026-10-12 (verbatim): "Keep `home_timezone` private by default.
 * Public schedules may show their destination/event timezone."
 * census-trips §94; the verifier's N1 on 3768 (VERIFY-STG e9c124100).
 *
 * `trips.home_timezone` (3768) is the OWNER's home zone: a fact about a person,
 * not about the trip. `trips.timezone` and `trip_stages.timezone` are the
 * destination's and the event's, and those are what schedules show.
 *
 * WHAT THIS FILE PINS
 * ===================
 * 1. ONE READER. Outside tests, migrations and census scripts, the tokens
 *    `home_timezone` / `homeTimezone` occur only in the files listed below. A
 *    new file naming them (a serializer, a projection, a schedule, the mobile
 *    app) fails here and has to be reviewed against the ruling. This is also
 *    why no schedule can show the home zone: none can name it.
 * 2. THE TRIP SERIALIZERS are allow-lists. Fed a row carrying the zone, neither
 *    the authorized view nor the private preview emits it.
 * 3. THE `select("*")` READS of `trips` in the server are an inventory. Each one
 *    is mapped through an allow-list serializer or never leaves the server; a
 *    new one fails here (it would carry the zone the moment its result is sent).
 * 4. 3769 strips the zone from every trip event, and its rollback exists.
 *
 * The visibility rule itself (owner only, by trips.owner_id) is pinned in
 * tripStageAnchors.test.ts and, through the route, in tripStructureRoute.test.ts.
 *
 * Run: node --import tsx/esm --test src/test/tripHomeTimezonePrivacy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { toAuthorizedTripView, toPrivateTripPreview } from "../lib/privacy/tripSerializers.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const API_SRC = join(ROOT, "artifacts/api-server/src");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

const isTestOrTooling = (rel: string) =>
  /(^|\/)(test|tests|__tests__|e2e|__mocks__)\//.test(rel) || /\.test\.(ts|tsx|js|mjs)$/.test(rel)
  || rel.startsWith("artifacts/api-server/src/migrations/") || rel.startsWith("artifacts/api-server/src/scripts/");

/** Every non-test source file that may name the home zone, and why. */
const HOME_TIMEZONE_READERS: Record<string, string> = {
  "artifacts/api-server/src/domain/trips/services/tripStageAnchors.ts":
    "the one read door; withholds the value from anyone but trips.owner_id",
  "artifacts/api-server/src/routes/tripStructure.ts":
    "serves it only when the anchors say the viewer is the owner",
  "artifacts/api-server/src/routes/trips.ts":
    "PATCH /trips/:id, owner-only (canEditTrip), echoes what the owner sent",
  "artifacts/api-server/src/domain/trips/contracts/tripReasonCodes.ts":
    "a comment naming the column in the availability marker's description",
};

describe("1. the home zone has one reader", () => {
  const roots = [API_SRC, join(ROOT, "lib"), join(ROOT, "travel-buddy-standalone/src"), join(ROOT, "travel-buddy-standalone/app")];
  const files = roots.flatMap((r) => walk(r));

  it("the scan saw the server and the app (not a vacuous pass)", () => {
    assert.ok(files.some((f) => f.endsWith("routes/trips.ts")), "routes/trips.ts was scanned");
    assert.ok(files.some((f) => f.includes("travel-buddy-standalone/src/services/trips.ts")), "the app's trips service was scanned");
  });

  it("only the listed files name home_timezone / homeTimezone", () => {
    const naming = files
      .map((f) => relative(ROOT, f))
      .filter((rel) => !isTestOrTooling(rel))
      .filter((rel) => /home_timezone|homeTimezone/.test(readFileSync(join(ROOT, rel), "utf8")))
      .sort();
    assert.deepEqual(naming, Object.keys(HOME_TIMEZONE_READERS).sort(),
      "a file outside the list names the owner's home zone. Owner ruling 2026-10-12: it is private by default — serve it to trips.owner_id only (domain/trips/services/tripStageAnchors.ts homeTimezoneVisibleTo), then add the file here with the reason.");
  });

  it("the structure route serves the value only under the anchors' visibility verdict", () => {
    const src = readFileSync(join(API_SRC, "routes/tripStructure.ts"), "utf8");
    assert.match(src, /readTripStageAnchors\(sc, tripId, user\.id\)/, "the route says who is looking");
    assert.match(src, /anchors\.homeTimezoneVisible\s*\?/, "the zone is behind the visibility verdict");
  });

  it("Today never asks for it (no viewer is named, so the reader withholds it)", () => {
    const src = readFileSync(join(API_SRC, "domain/trips/projections/TripTodayProjection.ts"), "utf8");
    assert.match(src, /readTripStageAnchors\(sc, tripId, null\)/);
  });
});

describe("2. the trip serializers are allow-lists", () => {
  const row = {
    id: "t1", owner_id: "u1", title: "T", destination_city: "Lisboa", destination_country: "Portugal",
    status: "planning", visibility: "public", timezone: "Europe/Lisbon", home_timezone: "Pacific/Chatham",
    show_destination_city: true, show_exact_dates: true, start_date: "2026-11-01", end_date: "2026-11-05",
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
  it("the authorized view keeps the destination zone and drops the home zone", () => {
    const v = toAuthorizedTripView(row) as unknown as Record<string, unknown>;
    assert.equal(v.timezone, "Europe/Lisbon");
    assert.equal(JSON.stringify(v).includes("Pacific/Chatham"), false);
  });
  it("the private preview drops it", () => {
    const v = toPrivateTripPreview(row, null, {});
    assert.equal(JSON.stringify(v).includes("Pacific/Chatham"), false);
  });
});

describe("3. select(\"*\") on trips in the server is an inventory", () => {
  /** file → number of `.from("trips")…select("*")` reads, and where each result goes. */
  const EXPECTED: Record<string, { count: number; why: string }> = {
    "artifacts/api-server/src/domain/trips/services/tripReadiness.ts": { count: 1, why: "computeReadiness reads dates/country/owner; the row is never returned" },
    "artifacts/api-server/src/lib/mapProjectionTripRead.ts": { count: 1, why: "mapped through toAuthorizedTripView" },
    "artifacts/api-server/src/routes/trips-expansion.ts": { count: 7, why: "every one mapped through toAuthorizedTripView / toPrivateTripPreview" },
  };
  it("no new select(\"*\") read of trips", () => {
    const found: Record<string, number> = {};
    for (const f of walk(API_SRC)) {
      const rel = relative(ROOT, f);
      if (isTestOrTooling(rel)) continue;
      const s = readFileSync(f, "utf8");
      const re = /from\(\s*["'`]trips["'`]\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const tail = s.slice(m.index, m.index + 400);
        const sel = /\.select\(\s*([^,)]*)/.exec(tail);
        if (sel && /^["'`]\s*\*/.test(sel[1]!.trim())) found[rel] = (found[rel] ?? 0) + 1;
      }
    }
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v.count]));
    assert.deepEqual(found, expected,
      "a select(\"*\") on trips carries trips.home_timezone (the owner's home zone). Name the columns, or map the row through an allow-list serializer and add it here.");
  });
  it("trips-expansion.ts answers trips only through the allow-list serializers", () => {
    const s = readFileSync(join(API_SRC, "routes/trips-expansion.ts"), "utf8");
    // every response that names a trips row variable goes through a serializer
    for (const m of s.matchAll(/res\.json\(\s*\{?\s*trips?\s*:\s*([^)}]*)/g)) {
      assert.match(m[1]!, /toAuthorizedTripView|toPrivateTripPreview|\[\]/, `unserialized trips response: ${m[0]}`);
    }
  });
});

describe("4. 3769 strips the zone from every trip event", () => {
  const sql = readFileSync(join(API_SRC, "migrations/3769_trip_events_home_timezone_minimised.sql"), "utf8");
  it("a BEFORE INSERT trigger on trip_events, its own (3976 replaces trip_event_minimised after it on a fresh chain)", () => {
    assert.match(sql, /CREATE TRIGGER trg_trip_events_home_timezone_minimise\s+BEFORE INSERT ON public\.trip_events\s+FOR EACH ROW EXECUTE FUNCTION public\.trip_events_home_timezone_minimise_on_insert/); assert.match(sql, /tgtype FROM pg_trigger[^\n]*<> 7 THEN/);
    assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.trip_event_minimised\b/);
  });
  it("result, payload, payload.patch and the top level", () => {
    assert.match(sql, /r := r - 'home_timezone';/);
    assert.match(sql, /'\{result\}', \(r->'result'\) - 'home_timezone'/);
    assert.match(sql, /'\{payload\}', \(r->'payload'\) - 'home_timezone'/);
    assert.match(sql, /'\{payload,patch\}', \(r->'payload'->'patch'\) - 'home_timezone'/);
  });
  it("no client role may execute it; postconditions recompute from the catalog", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.trip_event_home_timezone_removed\(jsonb\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.trip_events_home_timezone_minimise_on_insert\(\) FROM PUBLIC, anon, authenticated;/);
    const post = sql.slice(sql.indexOf("DO $post$"));
    assert.ok(post.length > 0 && !/pg_temp|current_setting\(/.test(post));
  });
  it("does not weaken append-only or any policy", () => {
    assert.doesNotMatch(sql, /trip_events_refuse_update|DROP POLICY|GRANT SELECT|DISABLE TRIGGER/);
  });
  it("its rollback exists and removes every object", () => {
    const rb = readFileSync(join(ROOT, "db/rollback/2026-10-12-3769-trip-events-home-timezone-minimised-rollback.sql"), "utf8");
    for (const t of ["DROP TRIGGER IF EXISTS trg_trip_events_home_timezone_minimise", "DROP FUNCTION IF EXISTS public.trip_events_home_timezone_minimise_on_insert()",
      "DROP FUNCTION IF EXISTS public.trip_event_home_timezone_removed(jsonb)", "a trace of 3769 survived"]) {
      assert.ok(rb.includes(t), t);
    }
  });
});

// ── 5. census-trips §94.4 step 1: the APPS name their `trips` columns ─────────────────
//
// §94.4 step 1 of 3. A column grant that withholds trips.home_timezone from
// client roles (step 3) makes PostgREST answer `select=*` on trips with
// "permission denied", so every installed build that still reads `*` would
// lose its trip screens. This section is the precondition for step 3: no
// client file may read `*` from trips — not `.select('*')`, not an implicit
// `.select()` after insert/update (supabase-js sends `*`), not an embedded
// `trips(*)` inside another table's select, and not through a table name or a
// select list this file cannot read. The lists the apps DO send must be
// exactly the columns their mapper reads, and never home_timezone or
// current_stage_id (3768).
//
// Section 3 pins the server; this pins the apps. `typescript` is imported here,
// not at the top, so the anchors cited into this file (census-trips §94.3) keep
// their line numbers.
const ts = (await import("typescript")).default;
type TsNode = import("typescript").Node;
type TsExpr = import("typescript").Expression;
type TsStr = import("typescript").StringLiteral | import("typescript").NoSubstitutionTemplateLiteral;

/** Every workspace directory that ships to a device or a browser with a client (anon/authenticated) token. */
const CLIENT_ROOTS = ["src", "app", "travel-buddy-standalone/src", "travel-buddy-standalone/app", "lib", "packages", "artifacts/mockup-sandbox/src"];

/** Top-level comma-separated items of a PostgREST select list (embedded resources kept whole). */
function topLevelItems(list: string): string[] {
  const out: string[] = []; let depth = 0; let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** `trips(...)` / `alias:trips!hint(...)` embedded anywhere in a select list whose own list reads `*`. */
function embedsTripsStar(list: string): boolean {
  const re = /(^|[\s,(:])trips(![\w]+)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(list))) {
    let depth = 1; let i = m.index + m[0].length; const start = i;
    while (i < list.length && depth > 0) { if (list[i] === "(") depth++; if (list[i] === ")") depth--; i++; }
    if (topLevelItems(list.slice(start, i - 1)).some((c) => c === "*")) return true;
  }
  return false;
}

type ClientTripsRead = { rel: string; line: number; list: string | null; problem: string | null };

/** Every `.select(...)` in client code: trips reads, embedded trips(*), and anything it cannot read. */
function scanClientSelects(rel: string, text: string): ClientTripsRead[] {
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : rel.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const consts = new Map<string, string>();
  const isStr = (n: TsNode | undefined): n is TsStr =>
    !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
  const collect = (n: TsNode): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isStr(n.initializer)) consts.set(n.name.text, n.initializer.text);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const literal = (n: TsNode | undefined): string | null =>
    isStr(n) ? n.text : n && ts.isIdentifier(n) && consts.has(n.text) ? consts.get(n.text)! : null;
  const out: ClientTripsRead[] = [];
  const visit = (n: TsNode): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "select") {
      // nearest `.from(...)` down the receiver chain
      let cur: TsExpr = n.expression.expression; let table: string | null | undefined;
      while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
        if (cur.expression.name.text === "from" && cur.arguments.length === 1) { table = literal(cur.arguments[0]); break; }
        cur = cur.expression.expression;
      }
      if (table !== undefined) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        const list = n.arguments.length === 0 ? null : literal(n.arguments[0]);
        let problem: string | null = null;
        if (table === null) problem = "the table name is not a string literal, so this file cannot prove it is not trips";
        else if (table === "trips" && n.arguments.length === 0) problem = "an argument-less select() on trips reads every column";
        else if (list === null && table === "trips") problem = "the select list is not a literal or same-file string const";
        else if (table === "trips" && topLevelItems(list!).some((c) => c === "*")) problem = "select('*') on trips";
        else if (list !== null && embedsTripsStar(list)) problem = "an embedded trips(*) reads every trips column";
        if (table === "trips" || problem) out.push({ rel, line, list, problem });
      }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "from" && n.arguments.length === 1 && literal(n.arguments[0]) === "trips" && !ts.isPropertyAccessExpression(n.parent)) out.push({ rel, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, list: null, problem: "a trips query builder leaves its chain (stored or passed), so its select list cannot be read here" }); ts.forEachChild(n, visit); // the first clause: a builder stored in a variable or passed on hides its select list (verifier M14)
  };
  visit(sf);
  return out;
}

/** Columns a mapper reads off its raw row parameter `r` (`r.col` / `r.col ?? x`). */
function columnsMapperReads(text: string, fn: string): string[] {
  const start = text.indexOf(`function ${fn}(`);
  assert.ok(start >= 0, `${fn} not found`);
  const body = text.slice(start, text.indexOf("\n}\n", start));
  return [...new Set([...body.matchAll(/\br\.([a-z_][a-z0-9_]*)/g)].map((m) => m[1]!))].sort();
}

describe("5. the apps never read `*` from trips (census-trips §94.4 step 1)", () => {
  const files = CLIENT_ROOTS.flatMap((r) => walk(join(ROOT, r)))
    .map((f) => relative(ROOT, f)).filter((rel) => !isTestOrTooling(rel));
  const reads = files.flatMap((rel) => scanClientSelects(rel, readFileSync(join(ROOT, rel), "utf8")));

  /** file → number of trips reads (each one an explicit list); a new read must be added here and reviewed. */
  const EXPECTED_TRIPS_READS: Record<string, number> = {
    "src/services/trips.js": 4, // the committed tsc output of src/services/trips.ts, kept in step with it
    "src/services/trips.ts": 4, // listMyTrips, getTrip, createTrip (insert … RETURNING), updateTrip (UPDATE … RETURNING)
    "travel-buddy-standalone/src/services/trips.ts": 1, // getTrip
  };

  it("the scan saw both apps' trips services (not a vacuous pass)", () => {
    for (const f of Object.keys(EXPECTED_TRIPS_READS)) assert.ok(files.includes(f), `${f} was scanned`);
  });

  it("no client file reads `*` from trips, implicitly, embedded, or through a name it cannot read", () => {
    const bad = reads.filter((r) => r.problem).map((r) => `${r.rel}:${r.line} — ${r.problem}`);
    assert.deepEqual(bad, [],
      "trips.home_timezone (owner-only, OD-1012-PRIV-4) will be withheld from client roles by a column grant; a `*` read of trips then fails with permission denied on every installed build. Name the columns the mapper reads.");
  });

  it("the trips reads are the reviewed inventory", () => {
    const found: Record<string, number> = {};
    for (const r of reads) if (r.list !== null || r.problem) found[r.rel] = (found[r.rel] ?? 0) + 1;
    assert.deepEqual(found, EXPECTED_TRIPS_READS);
  });

  for (const svc of ["src/services/trips.ts", "src/services/trips.js", "travel-buddy-standalone/src/services/trips.ts"]) {
    it(`${svc}: every trips read sends exactly the columns mapTrip reads, never the owner's zone`, () => {
      const text = readFileSync(join(ROOT, svc), "utf8");
      const mapped = columnsMapperReads(text, "mapTrip");
      const lists = reads.filter((r) => r.rel === svc).map((r) => topLevelItems(r.list ?? "").sort());
      assert.ok(lists.length > 0, "found its trips reads");
      for (const cols of lists) {
        assert.deepEqual(cols, mapped, "the select list and mapTrip disagree: a column read but not selected is silently undefined; one selected but not read is exposure for nothing");
        assert.ok(!cols.includes("home_timezone") && !cols.includes("current_stage_id"), "home_timezone / current_stage_id are not the app's to read");
      }
    });
  }
});
