/**
 * census-compass CPH-15 — "destination behaviour varies by time/season/event",
 * the EVENT leg, which was the last failing criterion of the clause.
 *
 * Time varied (weekday × daypart slices) and season varied (month profiles +
 * `seasonBoostForItem`). Event did NOT: the census reading was "no event
 * dimension exists in the world model; events feed the same day-of-week ×
 * daypart slice as everything else". A festival week in Cebu scored exactly
 * like an ordinary week, and the only thing that changed was prose.
 *
 * The event dimension is built in the SAME shape the season one is already
 * proven in, from data the graph ALREADY holds (the `events` read in
 * buildGraphFromSources — no new table, no migration):
 *   - the events site writes an EVENT edge beside its time-slice and month
 *     edges: `active_during_event:<category>` onto `<city>|ev:<MM-DD>`, keyed
 *     on the city's LOCAL day-of-year (`localEventDayKey`), so "the night of
 *     the festival" is a real, distinct bucket;
 *   - `buildCityWorldModels` folds those into per-window profiles the world
 *     model carries (under the `ev:` namespace of `monthly`, because
 *     compass_city_models has no column to add without a migration and a month
 *     key is exactly two digits — the two key spaces cannot collide);
 *   - `eventBoostForItem` is a THIRD bounded addend in `worldModelBoostForItem`,
 *     so the SAME item scores differently while a notable event is on; and
 *   - with no event signal there is no boost and no invented factor, and the
 *     destination line says nothing about an event.
 *
 * TEST-FIRST: this file was written before the implementation and run against
 * the unchanged engine. It failed at import — `localEventDayKey`,
 * `eventWindowProfile`, `eventBoostForItem`, `EVENT_BOOST_MAX` and
 * `MIN_EVENT_SAMPLE` did not exist — which is the right first red: the census
 * finding is precisely that no event dimension existed.
 *
 * Mutation log (each applied ALONE, the suite run, the source restored;
 * every line below was actually run, and the suite is 8 tests green):
 *   M1 the event addend dropped from the RHYTHM return of
 *      worldModelBoostForItem (`rhythm + season.boost + evt.boost`
 *      → `rhythm + season.boost`)                             7/1 → red
 *   M2 the event addend dropped from the `none` return of
 *      worldModelBoostForItem (`season.boost + evt.boost`
 *      → `season.boost`)                                      7/1 → red
 *   M3 the event edge not written at the events site (the
 *      `eventEdge(...)` call deleted from buildGraphFromSources §3)
 *                                                             7/1 → red
 *   M4 the event fold in buildCityWorldModels reads the MONTH edges
 *      (`.like("edge_type", "active_during_event:%")`
 *      → `"active_during_month:%"`)                           7/1 → red
 *   M5 the MIN_EVENT_SAMPLE floor removed from eventBoostForItem
 *      (a single scheduled thing becomes a "notable event")   7/1 → red
 *   M6 localEventDayKey ignores the city clock (the local-parts
 *      branch deleted — UTC month/day always)                 7/1 → red
 *   M7 the addend's ceiling widened (EVENT_BOOST_MAX 3 → 50), so the
 *      world model could DECIDE a rank instead of nudging it   7/1 → red
 *   M8 the event line in buildDestinationContextLines never emitted
 *      (its guard forced false)                               7/1 → red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassEventDimension.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVENT_BOOST_MAX,
  EVENT_WINDOW_KEY_PREFIX,
  MIN_EVENT_SAMPLE,
  SEASON_BOOST_MAX,
  WORLD_MODEL_BOOST_MAX,
  buildCityWorldModels,
  buildDestinationContextLines,
  eventBoostForItem,
  eventWindowProfile,
  localEventDayKey,
  localMonthKey,
  monthProfile,
  timeSliceKey,
  worldModelBoostForItem,
  type CityWorldModel,
} from "../compass/CompassGraphEngine.js";
import type { CompassItem } from "../compass/types.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CITY = "Cebu"; // Asia/Manila, UTC+8 — a local day that is not the UTC day
const item = (category: string): CompassItem =>
  ({ id: "i1", type: "place", category, interestTags: [category] } as unknown as CompassItem);

function model(over: Partial<CityWorldModel> = {}): CityWorldModel {
  return {
    city: CITY, timeSlices: {}, monthly: {}, topCategories: [],
    sampleSize: 0, builtAt: new Date().toISOString(), ...over,
  };
}

/** Minimal supabase-shaped fake: `rows` keyed by table, no filtering beyond eq. */
function fakeDb(rows: Record<string, any[]>): any {
  return {
    from(table: string) {
      let out = [...(rows[table] ?? [])];
      const b: any = {
        select: () => b,
        like: () => b,
        gt: () => b,
        ilike: () => b,
        limit: () => b,
        eq: (c: string, v: unknown) => { out = out.filter((r) => r[c] === v); return b; },
        maybeSingle: () => Promise.resolve({ data: out[0] ?? null, error: null }),
        then: (res: (x: unknown) => void) => res({ data: out, error: null }),
      };
      return b;
    },
  };
}

describe("A. the event window key is the city's LOCAL day-of-year", () => {
  it("a UTC evening that is already tomorrow in Cebu keys the NEXT day", () => {
    // 2026-01-15T17:00Z is 2026-01-16 01:00 in Manila.
    assert.equal(localEventDayKey(new Date("2026-01-15T12:00:00Z"), CITY), "01-15");
    assert.equal(localEventDayKey(new Date("2026-01-15T17:00:00Z"), CITY), "01-16");
    // Unknown city, no coords → honest UTC fallback, never a guess.
    assert.equal(localEventDayKey(new Date("2026-01-15T17:00:00Z"), "Nowhereville"), "01-15");
  });
});

describe("B. the world model carries event-window profiles", () => {
  it("eventWindowProfile reads the ev: namespace and never collides with a month", () => {
    const m = model({
      monthly: {
        "01": { count: 40, categories: { food: 40 } },
        [`${EVENT_WINDOW_KEY_PREFIX}01-15`]: { count: 12, categories: { festival: 9, food: 3 } },
        [`${EVENT_WINDOW_KEY_PREFIX}03-02`]: { count: 0, categories: {} },
      },
    });
    assert.deepEqual(eventWindowProfile(m, "01-15"), { count: 12, categories: { festival: 9, food: 3 } });
    assert.equal(eventWindowProfile(m, "03-02"), null, "an empty window is not a window");
    assert.equal(eventWindowProfile(m, "07-04"), null);
    // The month fold must not see the event keys, and vice versa.
    assert.deepEqual(monthProfile(m, "01"), { count: 40, categories: { food: 40 } });
    assert.equal(monthProfile(m, "01-15"), null);
    const eventsOnly = model({ monthly: { [`${EVENT_WINDOW_KEY_PREFIX}01-15`]: { count: 12, categories: { festival: 12 } } } });
    assert.equal(monthProfile(eventsOnly, "01"), null, "an event window must not read as a season");
  });
});

describe("C. event is a RANKING input — the same item scores differently while an event is on", () => {
  const onFestival = new Date("2026-01-15T12:00:00Z"); // 01-15 local
  const ordinary = new Date("2026-03-10T12:00:00Z");   // 03-10 local
  const m = model({
    monthly: { [`${EVENT_WINDOW_KEY_PREFIX}${localEventDayKey(onFestival, CITY)}`]: { count: 10, categories: { festival: 8, food: 2 } } },
  });

  it("the festival item is boosted on the festival day and not on an ordinary day", () => {
    const on = eventBoostForItem(item("festival"), m, onFestival);
    const off = eventBoostForItem(item("festival"), m, ordinary);
    assert.ok(on.boost > 0, `expected a boost on the event day, got ${on.boost}`);
    assert.equal(off.boost, 0, "an ordinary day is not an event window");
    assert.equal(on.factor?.key, "city_event");
    assert.equal(off.factor, null, "no event signal ⇒ no invented factor");
    assert.ok(on.boost <= EVENT_BOOST_MAX, `${on.boost} <= ${EVENT_BOOST_MAX}`);
    // The ceiling is a tunable, so bound it absolutely too: the world model
    // NUDGES a rank, it never decides one, and an event window rests on
    // narrower evidence than the city's whole weekday × daypart history.
    assert.ok(EVENT_BOOST_MAX > SEASON_BOOST_MAX && EVENT_BOOST_MAX <= WORLD_MODEL_BOOST_MAX,
      `${SEASON_BOOST_MAX} < ${EVENT_BOOST_MAX} <= ${WORLD_MODEL_BOOST_MAX}`);
    // The category mix inside the window matters, not just the date.
    assert.ok(eventBoostForItem(item("food"), m, onFestival).boost < on.boost);
  });

  it("an under-sampled window, an unmatched category and a missing model all degrade to nothing", () => {
    const thin = model({
      monthly: { [`${EVENT_WINDOW_KEY_PREFIX}01-15`]: { count: MIN_EVENT_SAMPLE - 1, categories: { festival: MIN_EVENT_SAMPLE - 1 } } },
    });
    assert.equal(eventBoostForItem(item("festival"), thin, onFestival).boost, 0, "one scheduled thing is not a notable event");
    assert.equal(eventBoostForItem(item("museum"), m, onFestival).boost, 0);
    assert.equal(eventBoostForItem(item("festival"), null, onFestival).boost, 0);
    assert.equal(eventBoostForItem(item("festival"), model(), onFestival).factor, null);
  });

  it("the combined world-model boost carries the event addend separately and stays bounded", () => {
    const slice = timeSliceKey(onFestival, CITY);
    const day = localEventDayKey(onFestival, CITY);
    const month = localMonthKey(onFestival, CITY);
    const both = model({
      timeSlices: { [slice]: { count: 10, categories: { festival: 10 } } },
      monthly: {
        [month]: { count: 20, categories: { festival: 20 } },
        [`${EVENT_WINDOW_KEY_PREFIX}${day}`]: { count: 10, categories: { festival: 10 } },
      },
    });
    const a = worldModelBoostForItem(item("festival"), both, onFestival);
    assert.equal(a.eventBoost, EVENT_BOOST_MAX);
    assert.equal(a.eventFactor?.key, "city_event");
    assert.equal(a.boost, WORLD_MODEL_BOOST_MAX + SEASON_BOOST_MAX + EVENT_BOOST_MAX);

    // Event alone — no slice for the hour, no month profile: the boost IS the
    // event addend, and the rhythm factor stays honestly null.
    const eventOnly = model({ monthly: { [`${EVENT_WINDOW_KEY_PREFIX}${day}`]: { count: 10, categories: { festival: 10 } } } });
    const b = worldModelBoostForItem(item("festival"), eventOnly, onFestival);
    assert.equal(b.boost, EVENT_BOOST_MAX);
    assert.equal(b.seasonBoost, 0);
    assert.equal(b.factor, null);

    // The same model on an ordinary day: the event addend is gone.
    const c = worldModelBoostForItem(item("festival"), eventOnly, ordinary);
    assert.equal(c.boost, 0);
    assert.equal(c.eventBoost, 0);
    assert.equal(c.eventFactor, null);
  });
});

describe("D. the fold — event windows come from the event edges", () => {
  it("buildCityWorldModels folds active_during_event edges into ev: windows beside the months", async () => {
    const edges = [
      { src_key: "cebu", dst_key: "cebu|fri:evening", edge_type: "active_during:food", observed_count: 5 },
      { src_key: "cebu", dst_key: "cebu|m:01", edge_type: "active_during_month:food", observed_count: 5 },
      { src_key: "cebu", dst_key: "cebu|ev:01-15", edge_type: "active_during_event:festival", observed_count: 7 },
      { src_key: "cebu", dst_key: "cebu|ev:01-15", edge_type: "active_during_event:food", observed_count: 2 },
      { src_key: "cebu", dst_key: "cebu|ev:bogus", edge_type: "active_during_event:festival", observed_count: 9 },
    ];
    const upserts: any[] = [];
    const db: any = {
      from(table: string) {
        let rows: any[] = table === "compass_graph_edges" ? edges : [];
        const b: any = {
          select() { return b; },
          like(_c: string, pat: string) {
            const re = new RegExp("^" + pat.replace(/%/g, ".*") + "$");
            rows = rows.filter((r) => re.test(String(r.edge_type)));
            return b;
          },
          eq(c: string, v: unknown) { rows = rows.filter((r) => r[c] === v); return b; },
          limit() { return b; },
          then(res: (x: unknown) => void) { res({ data: rows, error: null }); },
          upsert(row: any) { upserts.push(row); return Promise.resolve({ error: null }); },
        };
        return b;
      },
    };
    const n = await buildCityWorldModels(db);
    assert.equal(n, 1);
    const monthly = upserts[0].monthly;
    assert.deepEqual(monthly[`${EVENT_WINDOW_KEY_PREFIX}01-15`], { count: 9, categories: { festival: 7, food: 2 } });
    assert.equal(monthly[`${EVENT_WINDOW_KEY_PREFIX}bogus`], undefined, "a malformed window key is dropped, not invented");
    // The season fold is untouched by the event edges and vice versa.
    assert.deepEqual(monthly["01"], { count: 5, categories: { food: 5 } });
    assert.equal(upserts[0].time_slices["fri:evening"].count, 5);
  });

  it("the events write site emits the event edge, from the same observation as its slice", () => {
    const src = strip(readFileSync(join(SRC, "compass", "CompassGraphEngine.ts"), "utf8"));
    assert.match(src, /eventEdge\(batch, city, new Date\(at\)/, "no event edge is written anywhere");
    // It is derived from the EVENTS read — the only source that knows an event
    // is on — and never invented for stamps or memories.
    const eventsSection = src.slice(src.indexOf('.from("events")'), src.indexOf('.from("compass_outcome_events")'));
    assert.match(eventsSection, /eventEdge\(batch, city, new Date\(at\)/, "the events read does not write the event dimension");
    assert.match(src, /edge_type: `active_during_event:\$\{category\}`/);
    assert.match(src, /const day = localEventDayKey\(at, city, coords\);/);
  });
});

describe("E. prose follows behaviour — and says nothing when there is no event", () => {
  const at = new Date("2026-01-15T12:00:00Z");
  const day = localEventDayKey(at, "cebu");

  it("names the event window when one is on, and stays silent when none is", async () => {
    const withEvent = fakeDb({
      compass_city_models: [{
        city: "cebu", time_slices: {}, top_categories: ["food"], sample_size: 9, built_at: "",
        monthly: { [`${EVENT_WINDOW_KEY_PREFIX}${day}`]: { count: 11, categories: { festival: 8, food: 3 } } },
      }],
    });
    const lines = await buildDestinationContextLines(withEvent, "Cebu", at);
    assert.ok(lines.some((l) => /Event window/i.test(l) && /festival/.test(l)), lines.join("\n"));

    const withoutEvent = fakeDb({
      compass_city_models: [{
        city: "cebu", time_slices: {}, monthly: {}, top_categories: ["food"], sample_size: 9, built_at: "",
      }],
    });
    const quiet = await buildDestinationContextLines(withoutEvent, "Cebu", at);
    assert.equal(quiet.some((l) => /Event window/i.test(l)), false, "an event line with no event is fabrication");
  });
});
