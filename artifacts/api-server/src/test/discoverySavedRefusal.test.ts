/**
 * `type=saved` — the eighteenth searcher, and the last one that could not tell
 * a failed read from an empty shelf.
 *
 * WHAT WAS WRONG
 * ==============
 * census-discovery §21.4 named the hazard that outlives §18/§20/§21 in so many
 * words:
 *
 *   "A bucket that fails without rejecting. … A per-type searcher that swallows
 *    its own error and returns `[]` — the original defect, in the shape all 17
 *    had before §18 — is still invisible to the fan-out, which can only see a
 *    rejection."
 *
 * `searchSaved` was that searcher. It landed with census-map M201 AFTER §18
 * swept the file, so it never got the sweep: `discoveryRefusalD11.test.ts`'s
 * `SWALLOWED` table enumerates ten types and the `saved` lane is in none of
 * them, because the lane did not exist when the table was written.
 *
 * Three swallows, all in `searchSaved` (`routes/discoverySearch.ts`):
 *
 *   1. `const wishRows = Array.isArray(wishRes?.data) ? wishRes.data : []`, and
 *      the same shape for `discovery_place_saves`. `wishRes.error` is never
 *      bound. When BOTH save tables were unreadable the lane answered `[]` —
 *      byte-identical to a person who has saved nothing.
 *   2. `if (error || !Array.isArray(data)) continue;` on the authoritative
 *      `discovery_places` page read. A failed page dropped every save in it
 *      with no signal, and there is no second source to compensate: every
 *      OTHER reader of `discovery_places` in this file — `searchPlaces`
 *      (`:1174`), `searchActivities` (`:1883`) — throws `DiscoverySearchReadError`
 *      on exactly this read. `searchSaved` was the one that continued past it.
 *   3. `catch { return []; }` — a bare arm that swallowed the named error too,
 *      where every sibling searcher re-raises it (`searchPlans`, `:1128`).
 *
 * WHAT A USER SAW. `saved` is the viewer's OWN saves and it is what the map's
 * search sheet asks for by name (`components/map/MapSearchSheet.tsx`). During a
 * database outage the "Saved items" heading did not go missing or grey — it
 * answered, with `200 { results: [] }` and no `refusal` key, that this person
 * has saved nothing. That is `11` §9's masquerade, on the one heading whose
 * contents the user knows for a fact are not empty.
 *
 * WHAT IS PINNED, AND WHAT IS DELIBERATELY NOT
 * ============================================
 * A FULL outage of the save tables now rejects, so the route's catch arm turns
 * it into `transient_db` / `search_failed` / `coverage: "nothing"` — which is
 * the truth, because nothing was read.
 *
 * ONE unreadable save table still serves the other's rows and does NOT reject
 * (R5). That is not an oversight and it is not this file being lenient: the two
 * tables are written by two paths that never write each other's, one being
 * unreadable is a genuine half-answer, and turning it into `coverage: "nothing"`
 * would be a second lie in the opposite direction. R5 is the guard that keeps
 * the fix from over-reaching into it.
 *
 * THE SILENCE AROUND THAT HALF-ANSWER IS NOW CLOSED (R6–R10). This header used
 * to end by naming it as the live remaining gap — "a single-table outage is
 * still silent", closable only by a partial channel on `dispatchSearch`, "a
 * signature 18 call sites wide". The channel was built, and NOT by widening
 * that signature: `dispatchSearchWithCoverage` is a sibling export returning
 * `{ results, degradedSources }`, `dispatchSearch` is now a thin projection
 * onto `results`, and the eighteen call sites are untouched — which R10 pins.
 * `GET /discovery/search` reads the coverage form and answers a half-read shelf
 * with `coverage: "partial"` and `failedSources`, so the person is told their
 * saves may be short instead of being shown a list that looks whole.
 *
 * R6/R7 pin that each table names itself when unreadable; R8/R9 are the vacuity
 * guards that keep `partial` meaningful — a lane that reported a degraded
 * source unconditionally would satisfy R6 and R7 and make every healthy search
 * cry wolf. Both directions were watched red by mutation before this landed.
 *
 * VACUITY GUARDS. R3 and R4 are as load-bearing as R1 and R2: a searcher that
 * rejected unconditionally would satisfy "rejects on an unreadable table" and
 * fail both. R4 in particular pins that an empty-but-READABLE shelf still
 * answers `[]` with no rejection, which is the distinction the whole file is
 * about. The fake client throws on any operator it does not model, so a filter
 * that silently matched everything surfaces as a wrong id list, not a pass.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoverySavedRefusal.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { dispatchSearch, dispatchSearchWithCoverage, DiscoverySearchReadError } from "../routes/discoverySearch.js";
import { _clearPlaceIdBridgeCache } from "../lib/placeIdBridge.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const STRANGER = "bb000000-0000-4000-a000-000000000002";

const V_CAFE = "dd000000-0000-4000-a000-000000000010";   // saved via discovery_place_saves
const V_MUSEUM = "dd000000-0000-4000-a000-000000000011"; // saved via wishlist_places

// ── A PostgREST-shaped read double, narrow on purpose ────────────────────────
//
// Only the operators this lane issues are modelled. An unmodelled one throws: a
// fake that answers every call with "all rows" makes every filter assertion
// vacuous. `unreadable` RESOLVES with `{ data: null, error }`, which is what
// supabase-js actually does on a failed read — building it to REJECT is how a
// fail-open bug gets written and then tested green.

interface FakeOpts { unreadable?: string[] }

function ilikeToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/\\([%_])/g, "\u0000$1")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".")
    .replace(/\u0000\\?([%_])/g, "$1");
  return new RegExp(`^${body}$`, "i");
}

function splitOutsideParens(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") { depth++; cur += ch; }
    else if (ch === ")") { depth--; cur += ch; }
    else if (ch === "," && depth === 0) { if (cur.trim() !== "") out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

function makeClient(state: Record<string, any[]>, opts: FakeOpts = {}) {
  const reads: string[] = [];
  const client = {
    from(table: string) {
      reads.push(table);
      const unreadable = (opts.unreadable ?? []).includes(table);
      let rows = [...(state[table] ?? [])];
      const q: any = {
        select() { return q; },
        eq(col: string, val: unknown) { rows = rows.filter((r) => r[col] === val); return q; },
        in(col: string, vals: unknown[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
        order() { return q; },
        limit(n: number) { rows = rows.slice(0, n); return q; },
        or(expr: string) {
          const preds = splitOutsideParens(expr).map((part) => {
            const m = /^([\w.]+)\.(\w+)\.(.*)$/.exec(part.trim());
            if (!m) throw new Error(`fake: unparseable or() clause ${part}`);
            const [, col, op, val] = m as unknown as [string, string, string, string];
            if (op === "ilike") {
              const re = ilikeToRegExp(val);
              return (r: any) => typeof r[col] === "string" && re.test(r[col]);
            }
            if (op === "in") {
              // `resolvePlaceIdBridge` reaches `discovery_places` through an
              // `or(... .in.(…))`. Leaving it unmodelled does NOT surface as a
              // loud failure, because the bridge resolves ANY error to "no
              // mapping" — so every wishlist save quietly degraded to a
              // snapshot row and R3 failed on the served-id spelling instead.
              const list = val.replace(/^\(/, "").replace(/\)$/, "").split(",").map((v) => v.trim());
              return (r: any) => typeof r[col] === "string" && list.includes(r[col]);
            }
            throw new Error(`fake: unsupported or() operator ${op}`);
          });
          rows = rows.filter((r) => preds.some((p) => p(r)));
          return q;
        },
        then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
          const result = unreadable
            ? { data: null, error: { message: `simulated unreadable ${table}` } }
            : { data: rows, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client, reads };
}

function baseState(): Record<string, any[]> {
  return {
    discovery_places: [
      { id: V_CAFE, name: "Cafe Lumina", city: "Da Nang", blurb: "quiet mornings", image_url: null, primary_category: "cafe", category: "cafe", lat: 16.05, lng: 108.2, status: "active", submitted_by: STRANGER, canonical_location_id: null, osm_id: null },
      { id: V_MUSEUM, name: "Lumina Museum", city: "Hoi An", blurb: null, image_url: null, primary_category: "museum", category: "museum", lat: 15.88, lng: 108.33, status: "active", submitted_by: STRANGER, canonical_location_id: null, osm_id: null },
    ],
    discovery_place_saves: [
      { user_id: ME, place_id: V_CAFE, saved_at: "2026-03-01T00:00:00Z" },
    ],
    wishlist_places: [
      { user_id: ME, place_id: `db/${V_MUSEUM}`, place_data: { name: "Lumina Museum" }, saved_at: "2026-03-04T00:00:00Z" },
    ],
  };
}

function savedLane(
  state: Record<string, any[]>,
  q = "Lumina",
  opts: FakeOpts = {},
): Promise<Array<{ id: string }>> {
  const { client } = makeClient(state, opts);
  return dispatchSearch(client as any, q, ME, new Set<string>(), new Set<string>(), "saved", 0, 20) as any;
}

/** The same lane through the coverage-bearing form, so R6–R8 can read it. */
function savedLaneCoverage(
  state: Record<string, any[]>,
  q = "Lumina",
  opts: FakeOpts = {},
): Promise<{ results: Array<{ id: string }>; degradedSources: string[] }> {
  const { client } = makeClient(state, opts);
  return dispatchSearchWithCoverage(
    client as any, q, ME, new Set<string>(), new Set<string>(), "saved", 0, 20,
  ) as any;
}

beforeEach(() => { _clearPlaceIdBridgeCache(); });

describe("§21.4 — `type=saved` rejects an outage instead of reporting an empty shelf", () => {
  it("R1 — BOTH save tables unreadable REJECTS, rather than answering `[]`", async () => {
    // The whole defect in one case. Before the fix this RESOLVED with `[]`,
    // which the route serves as `200 { results: [] }` with no `refusal` — a
    // claim that this person has saved nothing, made without reading either
    // table that holds their saves.
    await assert.rejects(
      () => savedLane(baseState(), "Lumina", {
        unreadable: ["wishlist_places", "discovery_place_saves"],
      }),
      (err: unknown) => {
        assert.ok(
          err instanceof DiscoverySearchReadError,
          `expected DiscoverySearchReadError so the route's catch arm can refuse; got ${String(err)}`,
        );
        return true;
      },
      "a total outage of the save tables answered as an empty shelf",
    );
  });

  it("R2 — an unreadable `discovery_places` REJECTS, rather than dropping the saves it could not resolve", async () => {
    // `discovery_places` is the authoritative row behind every venue save. The
    // loop `continue`d past a failed page, so the saves in it vanished with no
    // signal — and unlike R5 there is no second source to compensate.
    await assert.rejects(
      () => savedLane(baseState(), "Lumina", { unreadable: ["discovery_places"] }),
      (err: unknown) => {
        assert.ok(
          err instanceof DiscoverySearchReadError,
          `expected DiscoverySearchReadError; got ${String(err)}`,
        );
        assert.equal(
          (err as DiscoverySearchReadError).relation, "discovery_places",
          "the refusal must name the relation that could not be read, for the log and the alert",
        );
        return true;
      },
      "an unreadable discovery_places silently dropped the viewer's saves",
    );
  });

  it("R3 CONTROL — a readable shelf with saves on it still returns them", async () => {
    // Without this, "rejects on an unreadable table" is satisfied by rejecting
    // on everything.
    const results = await savedLane(baseState());
    assert.deepEqual(
      results.map((r) => r.id).sort(),
      [V_CAFE, V_MUSEUM].sort(),
      "the healthy path stopped returning the viewer's saves",
    );
  });

  it("R4 CONTROL — a readable shelf that matches nothing resolves `[]` and does NOT reject", async () => {
    // The distinction the file exists for: an empty answer that was READ is a
    // real answer, and must stay a 200 with no refusal on it.
    const results = await savedLane(baseState(), "Reykjavik");
    assert.deepEqual(results, [], "a genuinely non-matching query stopped being empty");
  });

  it("R5 CONTROL — ONE unreadable save table still serves the other's saves and does NOT reject", async () => {
    // Deliberate, and the boundary of this fix. The two save tables are written
    // by paths that never write each other's, so one being unreadable is a real
    // half-answer rather than an outage. Rejecting here would replace a silent
    // partial with a false "nothing was readable".
    //
    // STILL TRUE, AND NO LONGER THE WHOLE STORY. R5 pins that the half-answer is
    // SERVED; R6 pins that it is no longer served SILENTLY. The two are the
    // guard pair: R5 alone is satisfied by a lane that hides the failure, R6
    // alone by a lane that throws the surviving rows away.
    const results = await savedLane(baseState(), "Lumina", { unreadable: ["wishlist_places"] });
    assert.deepEqual(
      results.map((r) => r.id), [V_CAFE],
      "the readable save table's rows were lost with the unreadable one",
    );
  });

  it("R6 — ONE unreadable save table is REPORTED as a degraded source, not served silently", async () => {
    // The gap R5's own comment used to describe as open. `dispatchSearch`
    // returned a bare array, so a half-read shelf and a whole one were the same
    // value and the route answered both with a plain 200 — a SHORT list of the
    // person's own saves, presented as complete.
    const { results, degradedSources } =
      await savedLaneCoverage(baseState(), "Lumina", { unreadable: ["wishlist_places"] });
    assert.deepEqual(
      results.map((r) => r.id), [V_CAFE],
      "the surviving table's rows must still be served — reporting the gap must not empty the shelf",
    );
    assert.deepEqual(
      degradedSources, ["wishlist_places"],
      "the unreadable save table was not named, so the route cannot say `coverage: \"partial\"`",
    );
  });

  it("R7 — the OTHER save table unreadable is reported too, and names itself", async () => {
    // Not symmetric by accident: the two tables are read by two different
    // branches, and a guard that only watched one would pass R6 while leaving
    // half the defect in place.
    const { results, degradedSources } =
      await savedLaneCoverage(baseState(), "Lumina", { unreadable: ["discovery_place_saves"] });
    assert.deepEqual(
      results.map((r) => r.id), [V_MUSEUM],
      "the wishlist save was lost when the Discovery bookmark table was unreadable",
    );
    assert.deepEqual(
      degradedSources, ["discovery_place_saves"],
      "the unreadable bookmark table was not named",
    );
  });

  it("R8 VACUITY GUARD — a fully readable shelf reports NO degraded sources", async () => {
    // Without this, "names the unreadable table" is satisfied by a lane that
    // names a table on every request, which would make every healthy search
    // answer `coverage: "partial"` and train the person to ignore the notice.
    const { results, degradedSources } = await savedLaneCoverage(baseState());
    assert.deepEqual(
      results.map((r) => r.id).sort(), [V_CAFE, V_MUSEUM].sort(),
      "the healthy path stopped returning the viewer's saves",
    );
    assert.deepEqual(
      degradedSources, [],
      "a healthy shelf claimed a degraded source, so `partial` would mean nothing",
    );
  });

  it("R9 VACUITY GUARD — an empty-but-READABLE shelf reports no degraded sources either", async () => {
    // The distinction the whole file is about, restated on the new channel: a
    // query that genuinely matches nothing is a complete answer, and must not
    // acquire a `partial` just because it is empty.
    const { results, degradedSources } = await savedLaneCoverage(baseState(), "Reykjavik");
    assert.deepEqual(results, [], "a genuinely non-matching query stopped being empty");
    assert.deepEqual(
      degradedSources, [],
      "an empty-but-read shelf was reported as partial, which would make emptiness untrustworthy",
    );
  });

  it("R10 — `dispatchSearch` still returns a bare array, so its 18 call sites are unchanged", async () => {
    // The coverage channel was added ALONGSIDE the old signature rather than by
    // widening it. This pins that choice: if `dispatchSearch` ever starts
    // returning the envelope, every existing caller silently starts treating an
    // object as an array and this is the case that says so.
    const results = await savedLane(baseState());
    assert.ok(Array.isArray(results), "dispatchSearch stopped returning an array");
    assert.deepEqual(
      results.map((r) => r.id).sort(), [V_CAFE, V_MUSEUM].sort(),
      "the unchanged form stopped agreeing with the coverage form's results",
    );
  });
});
