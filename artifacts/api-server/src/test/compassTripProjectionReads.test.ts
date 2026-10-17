/**
 * census-compass CT-02 — "stop duplicating the trip tables", held to the two
 * Compass modules this lane owns: `compass/CompassTools.ts` and
 * `compass/CompassCurrentTrip.ts`.
 *
 * THE CENSUS FINDING, VERBATIM
 * ============================
 *   "`TripCompassProjection` is consumed by ONE tool, but a grep for
 *    `.from("trip` across `compass/` returns raw reads of `trips`,
 *    `trip_members` and `trip_plan_items` from eight further modules. One tool
 *    consumes the projection; the rest of Compass still reads the tables."
 *
 * WHAT THIS SUITE PINS, AND WHAT IT DELIBERATELY DOES NOT CLAIM
 * ============================================================
 * Case A is a SOURCE grep, scoped to the two owned files, with an explicit
 * allow-list of the reads that survive and the reason each one survives. It is
 * not a "zero raw reads in compass/" assertion, because that would be false:
 * seven other modules still read those three tables and they belong to other
 * lanes. A test that asserted the row closed would be the same defect the row
 * is about — a claim nothing checks. What case A stops is a NEW raw read
 * appearing in these two files, and a listed one being quietly kept once its
 * reason has gone.
 *
 * Case B is the behaviour the duplication was hiding, which is the part that
 * matters to a traveller: the two paths that were re-deriving trip rows for
 * themselves bound no `error`, so an unreadable table came out as a confident
 * "no trip" / "no conflicts".
 *
 * TEST-FIRST, AND WHAT RED LOOKED LIKE:
 *   A — red with `CompassTools.ts` holding SIX raw reads against the four
 *       allowed: the extra `.from("trips")` inside `get_current_trip`'s named
 *       path (the projection reads that very row, one line later, from the same
 *       id) and `check_trip_conflicts`'s own `trip_members` + `trips` + `trips`
 *       copy of the owner ∪ accepted-member union.
 *   B — red: `check_trip_conflicts` answered `{ conflicts: [] }` — "no
 *       overlapping trips in that date range" — while `trip_members` was
 *       returning an error. It bound no `error` on any of its four reads, the
 *       same defect `CompassCurrentTrip.ts`'s header describes at length for
 *       the selection it replaced.
 *
 * MUTATION LOG — each applied ALONE, this suite re-run, the source restored.
 * Baseline: 9 pass / 0 fail.
 *   M6  `projectCurrentTrip` given back a `.from("trips")` read of its own
 *                                                          → RED 7/2 — A (a new raw read)
 *                                                                 and B ("one read, not two")
 *   M7  check_trip_conflicts re-derives the membership union raw beside the
 *        seam                                              → RED 8/1 — A
 *   M8  the `unread` branch of check_trip_conflicts replaced by
 *        `{ conflicts: [], info: "No overlapping trips…" }` → RED 8/1 — B
 *   M9  the conflicts plan-item read's `error` left unbound → RED 8/1 — B
 *   M10 an allow-list entry deleted while its read stayed   → RED 8/1 — the list is a
 *        (a mutation of THIS file, not the source)                list, not a comment
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassTripProjectionReads.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { toolGetCurrentTrip, executeCompassTool } from "../compass/CompassTools.js";
import { resolveCurrentTrip, resolveUserTrips } from "../compass/CompassCurrentTrip.js";
import { buildTripCompassProjection } from "../domain/trips/projections/TripCompassProjection.js";
import { stripComments } from "../scripts/lib/stripComments.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");

const ALICE = "a0000002-0000-0000-0000-000000000001";
const TRIP_ID = "b0000002-0000-0000-0000-000000000001";

/** The three tables the census finding names. */
const DUPLICATED_TABLES = ["trips", "trip_members", "trip_plan_items"] as const;

// ── A. The source grep, with every survivor named and justified ───────────────

/**
 * Every raw read of the three tables that is still ALLOWED in the two owned
 * files, and why. A read not on this list fails; a list entry with no read
 * fails too, so the justifications cannot outlive the code they justify.
 */
const ALLOWED: Array<{ file: string; table: string; why: string }> = [
  // CompassCurrentTrip.ts held three sanctioned copies (membership, owned trips,
  // member trips) while no Trip projection answered a USER-scoped question. Trips
  // now publishes those (TripCompassMembershipProjection, TripCompassTripSummary-
  // Projection) and the module consumes them, so its entries are gone: case D
  // holds it — and every other compass/ module — to zero.
  // CompassTools.ts's last survivor (add_to_trip's title read) now comes from
  // TripCompassTripSummaryProjection — one read, the same as before — so the
  // list is empty and both owned files hold zero raw reads.
];

/**
 * Every `.from("<table>")` in a source file's CODE, in order. Comments are
 * stripped first: `CompassCurrentTrip.ts`'s header quotes the unbound read it
 * replaced (`const { data: memberRows } = await sc.from("trip_members")...`),
 * and a grep that counts a quotation as a read cannot tell a record of a fixed
 * defect from the defect.
 */
function rawReads(file: string): string[] {
  const src = stripComments(SRC(file));
  const found: string[] = [];
  const re = /\.from\(\s*"([a-z_]+)"\s*\)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if ((DUPLICATED_TABLES as readonly string[]).includes(m[1]!)) found.push(m[1]!);
  }
  return found;
}

describe("CT-02 A — the two owned Compass modules read the trip tables only where nothing projects them", () => {
  for (const file of ["compass/CompassTools.ts", "compass/CompassCurrentTrip.ts"]) {
    it(`${file} holds exactly its allow-listed raw reads of trips / trip_members / trip_plan_items`, () => {
      const actual = rawReads(file).sort();
      const allowed = ALLOWED.filter((a) => a.file === file).map((a) => a.table).sort();
      assert.deepEqual(
        actual, allowed,
        `${file}: raw trip-table reads changed.\n` +
        `  found:   ${actual.join(", ") || "(none)"}\n` +
        `  allowed: ${allowed.join(", ") || "(none)"}\n` +
        "  A NEW read means CT-02 went backwards: consume the projection instead.\n" +
        "  A MISSING one means an allow-list entry outlived its read: delete the entry.",
      );
    });
  }

  it("every allow-list entry carries a reason a reader can check, not the word 'legacy'", () => {
    for (const a of ALLOWED) {
      assert.ok(a.why.length > 40, `${a.file} ${a.table}: the reason must say WHY no projection covers it`);
      assert.doesNotMatch(a.why, /\b(legacy|todo|for now|temporary)\b/i, `${a.file} ${a.table}: "${a.why}"`);
    }
  });

  it("CompassTools.ts consumes the typed selection seam rather than re-deriving the membership union", () => {
    const src = SRC("compass/CompassTools.ts");
    assert.match(src, /resolveUserTrips/, "check_trip_conflicts must take its trips from CompassCurrentTrip's union");
    assert.match(src, /resolveCurrentTrip/, "get_current_trip must take its selection from the same seam");
    assert.match(src, /buildTripCompassProjection/, "the trip's CONTENT comes from the §19.1 projection");
  });
});

// ── B. What the duplication was hiding: an unread table read as an empty one ──

interface FakeState { trips?: any[]; tripMembers?: any[]; tripPlanItems?: any[]; errorTables?: string[] }

/**
 * Returns a POSTGREST ERROR for a named table — `{ data: null, error }` from an
 * awaited builder, which is how the real failure arrives. A fake that can only
 * THROW cannot see this defect at all: the code under test never threw, it read
 * `{ data: undefined }` and carried on.
 */
function errorClient(state: FakeState) {
  const db: Record<string, any[]> = {
    trips: state.trips ?? [], trip_members: state.tripMembers ?? [], trip_plan_items: state.tripPlanItems ?? [],
  };
  const errs = new Set(state.errorTables ?? []);
  function builder(table: string, rows: any[]): any {
    let filtered = [...rows];
    const err = errs.has(table) ? { message: `${table} unavailable`, code: "57014" } : null;
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { filtered = filtered.filter((r) => r[c] === v); return b; },
      neq: (c: string, v: any) => { filtered = filtered.filter((r) => r[c] !== v); return b; },
      is: (c: string, v: any) => { filtered = filtered.filter((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      in: (c: string, vs: any[]) => { filtered = filtered.filter((r) => vs.includes(r[c])); return b; },
      gte: () => b, lte: () => b, gt: () => b, lt: () => b, or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve(err ? { data: null, error: err } : { data: filtered[0] ?? null, error: null }),
      then: (res: any) => res(err ? { data: null, error: err } : { data: filtered, error: null }),
    };
    return b;
  }
  return { from: (t: string) => builder(t, db[t] ?? []) } as any;
}

const trip = (o: Record<string, unknown> = {}) => ({
  id: TRIP_ID, owner_id: ALICE, title: "Cebu", destination_city: "Cebu", destination_country: "PH",
  start_date: "2026-08-01", end_date: "2026-08-07", status: "upcoming", timezone: null, version: 4, ...o,
});

describe("CT-02 B — an unreadable trip table is never answered as an empty one", () => {
  it("check_trip_conflicts says the trips could not be READ, rather than 'nothing overlaps'", async () => {
    const c = errorClient({ trips: [trip()], errorTables: ["trip_members"] });
    const out: any = await executeCompassTool(c, ALICE, null, "check_trip_conflicts", { startDate: "2026-08-05", endDate: "2026-08-10" });
    assert.equal(out.conflicts, null, "an unread union is not an empty union");
    assert.match(String(out.info), /could not be read/i);
    assert.doesNotMatch(String(out.info), /No overlapping trips/i,
      "an unreadable trip_members must never be reported as 'no conflicts' — the traveller double-books on that sentence");
  });

  it("check_trip_conflicts still finds a real overlap, and still says so honestly when there is none", async () => {
    const c = errorClient({ trips: [trip()] });
    const hit: any = await executeCompassTool(c, ALICE, null, "check_trip_conflicts", { startDate: "2026-08-05", endDate: "2026-08-10" });
    assert.equal(hit.conflicts.length, 1);
    assert.equal(hit.conflicts[0].id, TRIP_ID);
    assert.equal(hit.conflicts[0].start_date, "2026-08-01", "the wire shape the model was trained on is unchanged");
    assert.match(hit.conflicts[0].title, /^<portava:ugc>/, "a trip title is user content");

    const miss: any = await executeCompassTool(c, ALICE, null, "check_trip_conflicts", { startDate: "2026-12-01", endDate: "2026-12-05" });
    assert.deepEqual(miss.conflicts, []);
    assert.match(String(miss.info), /No overlapping trips/i);
  });

  it("an unreadable trip_plan_items is disclosed rather than passed off as 'no planned items'", async () => {
    const c = errorClient({ trips: [trip()], errorTables: ["trip_plan_items"] });
    const out: any = await executeCompassTool(c, ALICE, null, "check_trip_conflicts", { startDate: "2026-08-05", endDate: "2026-08-10" });
    assert.equal(out.conflicts.length, 1, "the overlap itself was readable and is still reported");
    assert.deepEqual(out.plannedItems, [], "no items are invented");
    assert.match(String(out.info), /planned items could not be read/i,
      "the empty plannedItems list must be labelled as unread, not left to read as 'the days are free'");
  });

  it("get_current_trip's named path takes the trip row from the projection — one read of `trips`, not two", async () => {
    let tripReads = 0;
    const inner = errorClient({ trips: [trip()], tripMembers: [{ trip_id: TRIP_ID, user_id: ALICE, role: "member", status: "accepted" }] });
    const counting = { from: (t: string) => { if (t === "trips") tripReads += 1; return inner.from(t); } } as any;
    const out: any = await toolGetCurrentTrip(counting, ALICE, TRIP_ID);
    assert.equal(out.trip.id, TRIP_ID);
    assert.equal(out.trip.destination_city, "Cebu", "the projection's summary, on the wire shape the tool has always used");
    assert.equal(out.projection.sourceTripVersion, 4, "and it is the PROJECTION's row — it carries the version");
    assert.equal(tripReads, 1,
      `the named path read \`trips\` ${tripReads} times; the projection reads that row itself, so a second read is the duplication CT-02 is about`);
  });

  it("a trip that does not exist is still 'no such trip', and an unreadable one is still said to be unreadable", async () => {
    const members = [{ trip_id: TRIP_ID, user_id: ALICE, role: "member", status: "accepted" }];
    const gone: any = await toolGetCurrentTrip(errorClient({ trips: [], tripMembers: members }), ALICE, TRIP_ID);
    assert.equal(gone.trip, null);
    assert.match(String(gone.info), /No such trip/i);
  });
});

type TripReadStage = "membership" | "owned" | "member" | "plan";

function transportClient(failedStage?: TripReadStage, failedBody = "") {
  const reads: URL[] = [];
  const client = createClient("http://127.0.0.1:9", "offline-test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, "http://127.0.0.1:9");
        assert.equal(init?.method ?? "GET", "GET");
        reads.push(url);
        const table = url.pathname.split("/").at(-1);
        const stage = table === "trip_members" ? "membership"
          : table === "trip_plan_items" ? "plan"
          : table === "trips" && url.searchParams.has("owner_id") ? "owned"
          : table === "trips" && url.searchParams.get("id")?.startsWith("in.") ? "member"
          : null;
        const rows = table === "trip_members"
          ? [{ trip_id: TRIP_ID, user_id: ALICE, role: "member", status: "accepted" }]
          : table === "trips" ? [trip()] : [];
        return new Response(stage === failedStage ? failedBody : JSON.stringify(rows), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  return { client, reads };
}

describe("CT-02 C — real client transport shapes retain the unread state", () => {
  it("an empty HTTP body is data:null/error:null, unlike a readable empty array", async () => {
    const { client } = transportClient("membership");
    const result = await client.from("trip_members").select("trip_id");
    assert.equal(result.data, null);
    assert.equal(result.error, null);
    const readable = await client.from("trip_plan_items").select("id");
    assert.deepEqual(readable.data, []);
    assert.equal(readable.error, null);
  });

  for (const [label, body] of [["empty body", ""], ["JSON null", "null"], ["object", "{}"], ["string", '"not rows"']] as const) {
    for (const stage of ["membership", "owned", "member"] as const) {
      it(`${stage}: ${label} refuses the entire selection instead of selecting a partial union`, async () => {
        const { client } = transportClient(stage, body);
        const result = await resolveUserTrips(client, ALICE);
        assert.deepEqual(result, {
          status: "unread",
          reason: stage === "membership" ? "trip_members could not be read" : "trips could not be read",
        });
        assert.equal((await resolveCurrentTrip(client, ALICE)).status, "unread");
      });
    }

    it(`plan: ${label} keeps the real trip but marks its plan unread`, async () => {
      const { client } = transportClient("plan", body);
      const result = await buildTripCompassProjection(client, TRIP_ID);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.projection.trip.id, TRIP_ID);
      assert.equal(result.projection.sourceTripVersion, 4);
      assert.equal(result.projection.planItems.status, "unread");
    });
  }

  it("does not continue to owned-trip selection after unread membership", async () => {
    const { client, reads } = transportClient("membership");
    assert.equal((await resolveCurrentTrip(client, ALICE)).status, "unread");
    assert.deepEqual(reads.map((url) => url.pathname), ["/rest/v1/trip_members"]);
  });

  it("readable arrays still select a trip and project a genuinely empty plan", async () => {
    const { client } = transportClient();
    const selected = await resolveCurrentTrip(client, ALICE);
    assert.equal(selected.status, "ok");
    if (selected.status === "ok") assert.equal(selected.trip.id, TRIP_ID);
    const result = await buildTripCompassProjection(client, TRIP_ID);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.projection.planItems, { status: "ok", items: [] });
  });

  it("the current-trip and conflict tools disclose unread membership rather than asserting absence", async () => {
    const { client } = transportClient("membership");
    const current: any = await toolGetCurrentTrip(client, ALICE);
    assert.equal(current.trip, null);
    assert.match(current.info, /context unavailable.*could not be read/i);
    const conflicts: any = await executeCompassTool(client, ALICE, null, "check_trip_conflicts", {
      startDate: "2026-08-05", endDate: "2026-08-10",
    });
    assert.equal(conflicts.conflicts, null);
    assert.match(conflicts.info, /could not be read/i);
  });

  it("transport fixtures never call ambient fetch for valid or malformed trip reads", async (context) => {
    const ambientFetch = context.mock.method(globalThis, "fetch", async () => {
      throw new Error("Unexpected ambient network request");
    });
    for (const failedStage of [undefined, "membership", "owned", "member", "plan"] as const) {
      const { client, reads } = transportClient(failedStage);
      await resolveCurrentTrip(client, ALICE);
      await resolveUserTrips(client, ALICE);
      await buildTripCompassProjection(client, TRIP_ID);
      await executeCompassTool(client, ALICE, null, "check_trip_conflicts", {
        startDate: "2026-08-05", endDate: "2026-08-10",
      });
      assert.ok(reads.length > 0);
      assert.equal(ambientFetch.mock.callCount(), 0);
    }
  });
});

// ── D. The WHOLE of compass/: no module reads a Trip table (CT-02 closed) ─────
//
// Cases A–C held CT-02 to the two modules one lane owned, with an allow-list,
// because "zero raw reads in compass/" was false: census-compass §62 measured 22
// literal selects of `trips` / `trip_members` / `trip_plan_items` across 12
// compass/ files. This case is that census measure as a test — the same AST
// count (literal `.from(<table>)` call chains, comments and string examples
// excluded) — over EVERY source file under compass/, and it asserts zero.
//
// It is stricter than the census measure in two ways, both on purpose:
//   - it counts every Trip-aggregate table (`trips`, `trip_*`), not only the
//     three §62 named — a raw `trip_commitments` read is the same duplication;
//   - a `.from(<expression>)` whose table is not a literal must resolve, or be
//     named below with what it can be, so a dynamic read cannot hide a trip table.
//
// The ONE named exception is the Autopilot's own store. `trip_autopilot_settings`
// and `trip_autopilot_proposals` are created by 20260728_compass_autopilot.sql
// for Compass's autopilot and read by nothing in Trips; their WRITE path is
// census-compass CT-01's row (the kernel), not this one. Every other `trip*`
// read in compass/ must come through a Trips-owned projection.
//
// TEST-FIRST — what red looked like before the migration: 21 literal selects in
// 12 files (§62's 22, less one migrated since) plus `trip_commitments` in
// CompassTools: 22 offending reads in 12 files.
import ts from "typescript";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const COMPASS_DIR = resolve(HERE, "..", "compass");
const COMPASS_OWNED_TRIP_TABLES: Record<string, string> = {
  trip_autopilot_settings: "Compass's autopilot store (20260728_compass_autopilot.sql); its writes are CT-01's kernel row",
  trip_autopilot_proposals: "Compass's autopilot store (20260728_compass_autopilot.sql); its writes are CT-01's kernel row",
};
/** Non-literal `.from(x)` sites that cannot be resolved to a constant, and what they can be. */
const DYNAMIC_FROM_SITES: Record<string, { count: number; why: string }> = {
  "CompassGraphEngine.ts|table": { count: 4, why: "the graph's own deletion/cleanup helpers; every caller passes a compass_graph_* / compass_city_* literal" },
};
const BUILTIN_RECEIVERS = new Set(["Array", "Buffer", "Object", "Set", "Map", "String", "Uint8Array", "Int8Array", "Float32Array", "Float64Array"]);

function compassSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "__tests__" && name !== "node_modules") out.push(...compassSources(p)); continue; }
    if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out.sort();
}

interface FromSite { file: string; line: number; table: string | null; expr: string }

function fromSites(path: string): FromSite[] {
  const text = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const consts = new Map<string, string>();
  const sites: FromSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
      consts.set(node.name.text, node.initializer.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "from"
      && node.arguments.length >= 1
      && !(ts.isIdentifier(node.expression.expression) && BUILTIN_RECEIVERS.has(node.expression.expression.text))) {
      const arg = node.arguments[0]!;
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const literal = ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : null;
      sites.push({ file: relative(COMPASS_DIR, path), line, table: literal, expr: arg.getText(sf) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // Resolve identifiers bound to a string constant in the same file.
  return sites.map((s) => (s.table === null && consts.has(s.expr) ? { ...s, table: consts.get(s.expr)! } : s));
}

const isTripTable = (table: string) => /^trips$|^trip_/.test(table);

describe("CT-02 D — no compass/ module reads a Trip table; every one comes through a Trips projection", () => {
  const files = compassSources(COMPASS_DIR);
  const sites = files.flatMap(fromSites);

  it("the scan sees the directory (a vacuous scan proves nothing)", () => {
    assert.ok(files.length >= 50, `only ${files.length} compass/ source files were scanned`);
    assert.ok(files.some((f) => f.endsWith("CompassTools.ts")) && files.some((f) => f.endsWith("CompassGraphEngine.ts")));
    assert.ok(sites.filter((s) => s.table !== null).length >= 100, `only ${sites.length} .from() sites were found — the parser is not reading the code`);
    assert.ok(sites.some((s) => s.table === "trip_autopilot_settings"), "the scan no longer sees the one table it exempts by name — re-check the exemption");
  });

  it("zero literal reads of trips / trip_* in compass/, other than the Autopilot's own store", () => {
    const offending = sites.filter((s) => s.table !== null && isTripTable(s.table) && !(s.table in COMPASS_OWNED_TRIP_TABLES));
    assert.deepEqual(
      offending.map((s) => `${s.file}:${s.line} ${s.table}`), [],
      `${offending.length} raw Trip-table read(s) in compass/ across ${new Set(offending.map((s) => s.file)).size} file(s). ` +
      "Consume a Trips projection (domain/trips/projections/TripCompass*Projection.ts) instead of reading the table.",
    );
  });

  it("every non-literal .from(x) in compass/ resolves to a non-trip table, or is a named dynamic site with the count it has", () => {
    const dynamic = sites.filter((s) => s.table === null);
    const byKey = new Map<string, number>();
    for (const s of dynamic) byKey.set(`${s.file}|${s.expr}`, (byKey.get(`${s.file}|${s.expr}`) ?? 0) + 1);
    assert.deepEqual(
      Object.fromEntries([...byKey].sort()),
      Object.fromEntries(Object.entries(DYNAMIC_FROM_SITES).map(([k, v]) => [k, v.count]).sort()),
      "an unresolvable .from(expression) appeared or vanished in compass/: resolve it to a literal, or name it here with what it can be",
    );
    for (const s of sites) if (s.table !== null && s.expr !== JSON.stringify(s.table) && isTripTable(s.table)) {
      assert.fail(`${s.file}:${s.line} reads ${s.table} through the constant ${s.expr}`);
    }
  });

  it("the exemptions carry reasons, and name only tables a Trips module does not read", () => {
    for (const [table, why] of Object.entries(COMPASS_OWNED_TRIP_TABLES)) {
      assert.ok(why.length > 40, `${table}: say why it is Compass's`);
      assert.match(why, /compass_autopilot\.sql/);
    }
  });
});

// ── D2. The Compass ROUTE files read no Trip table either ─────────────────────
//
// census-compass measured CT-02 over compass/ (§61/§62), but census-compass also
// watches the Compass route files, and four raw reads lived there: the traveller
// match's two destination-overlap reads, the trip-surface feed's member list, and
// the thread context's trip city. They come through Trips projections too. A
// WRITE is not this row's subject — the one in routes/compass.ts is the
// `trip-kernel:legacy-path` flag-off twin of ADD_PLAN, which CT-01 (the kernel
// write path) grades — so writes are reported, not counted, and named exactly.
const ROUTES_DIR = resolve(HERE, "..", "routes");
const COMPASS_ROUTE_WRITES: Record<string, string> = {
  "compass.ts|trip_plan_items|insert": "the `trip-kernel:legacy-path` flag-off twin of ADD_PLAN — census-compass CT-01's write path, not a read",
};

function routeFromSites(path: string): Array<{ file: string; line: number; table: string; op: string }> {
  const text = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: Array<{ file: string; line: number; table: string; op: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "from"
      && node.arguments.length === 1 && (ts.isStringLiteral(node.arguments[0]!) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]!))) {
      const ops: string[] = [];
      for (let p: ts.Node | undefined = node.parent; p && (ts.isPropertyAccessExpression(p) || ts.isCallExpression(p)); p = p.parent) {
        if (ts.isPropertyAccessExpression(p)) ops.push(p.name.text);
      }
      const write = ops.find((o) => ["insert", "update", "upsert", "delete"].includes(o));
      out.push({ file: relative(ROUTES_DIR, path), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        table: (node.arguments[0] as ts.StringLiteral).text, op: write ?? "select" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("CT-02 D2 — the Compass route files read no Trip table; their trip facts come through Trips projections", () => {
  const files = readdirSync(ROUTES_DIR).filter((f) => /^compass[A-Za-z]*\.ts$/.test(f)).map((f) => join(ROUTES_DIR, f));
  const sites = files.flatMap(routeFromSites).filter((s) => isTripTable(s.table) && !(s.table in COMPASS_OWNED_TRIP_TABLES));

  it("the scan sees the route files", () => {
    assert.ok(files.some((f) => f.endsWith("/compass.ts")) && files.length >= 5, `scanned: ${files.join(", ")}`);
  });

  it("zero literal Trip-table READS in routes/compass*.ts", () => {
    const reads = sites.filter((s) => s.op === "select");
    assert.deepEqual(reads.map((s) => `${s.file}:${s.line} ${s.table}`), [], "consume a Trips projection instead of reading the table");
  });

  it("the Trip-table WRITES there are exactly the named kernel-twin ones (CT-01's, not this row's)", () => {
    const writes = sites.filter((s) => s.op !== "select").map((s) => `${s.file}|${s.table}|${s.op}`).sort();
    assert.deepEqual(writes, Object.keys(COMPASS_ROUTE_WRITES).sort());
  });
});
