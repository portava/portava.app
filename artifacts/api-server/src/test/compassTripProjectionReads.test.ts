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

import { toolGetCurrentTrip, executeCompassTool } from "../compass/CompassTools.js";
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
  // CompassCurrentTrip.ts IS the sanctioned copy. "Which trip is this user on"
  // is a USER-scoped question and no Trip projection answers it: every trip
  // projection is built FROM a tripId. CT-02's remedy for selection was to make
  // the duplication one module instead of five, which is what these three are.
  { file: "compass/CompassCurrentTrip.ts", table: "trip_members", why: "selection: the owner ∪ accepted-member union, in the ONE module CT-02 moved it to" },
  { file: "compass/CompassCurrentTrip.ts", table: "trips",        why: "selection: the owned trips in the requested statuses" },
  { file: "compass/CompassCurrentTrip.ts", table: "trips",        why: "selection: the member trips in the requested statuses" },
  // The survivors in CompassTools.ts, each with the reason no projection covers it.
  { file: "compass/CompassTools.ts", table: "trip_plan_items", why: "check_trip_conflicts: a cross-trip day_date RANGE query. TripCompassProjection windows ONE trip around a focus day and caps it at ten items, so consuming it here would silently drop items inside the asked-for range — a narrower answer dressed as a cleaner one" },
  { file: "compass/CompassTools.ts", table: "trips",            why: "add_to_trip: the trip's title for the proposal card. Documented in place as defence-in-depth behind canEditPlan; building a whole context projection (two reads) on a write path to read one column is a worse trade, not a better one" },
  { file: "compass/CompassTools.ts", table: "trip_members",     why: "the group-recommendation roster — the trip's MEMBER LIST. No Trip projection exposes it: the crew map is presence-gated and would NARROW the roster, and CT-02 never licences narrowing an authorization set to remove a read" },
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
