/**
 * discoveryTrendNormalisedParity — census-discovery §84 (lane W10-R1), against
 * PostgreSQL 16 with migrations 3475–3477 applied.
 *
 * `rebuild_place_momentum` with `discovery_trend_normalised_enabled` ON is the
 * SQL twin of lib/discoveryTrendNormalised. This suite EXECUTES it over a
 * controlled corpus and holds every stored row equal to the TypeScript over the
 * loader's own rows and the context read from the same tables:
 *
 *   N0  the flag OFF: the dispatcher writes exactly what 3435's own function
 *       writes at the same instant (3477's rollback restores it inside a
 *       rolled-back transaction), and no v2 column is set
 *   N1  the context: discovery_trend_place_context() equals
 *       buildPlaceTrendContext over the same discovery_places / Trail rows
 *   N2  every stored v2 place row equals computeTrendStates(…, { model: "v2" }):
 *       state, lifecycle, driver, the four rates, exposures, groups, velocity,
 *       time-of-day and peer factors, travellers, the stored sentence, versions
 *   N3  every stored Local Pulse row equals computeAreaTrendStates
 *   N4  the cases the model exists for classify as designed (not vacuous):
 *       one account and one synchronised burst are NOT claims (DV-32, DV-34),
 *       a place below the exposure floor is not a reading (DV-30), a launch
 *       burst is not history (content age), a peer surge is divided out
 *       (creator / location / Trail), `03` §4's lifecycle and the driver
 *   N5  3477's rollback restores 3435 and re-applying 3477 is idempotent
 *
 * Controlled data on the harness only: no production claim.
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/discoveryTrendNormalisedParity.db.test.ts
 * Rows are timed in July 2031 so no other suite's rows can enter a window.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, rows, seedUser, deleteUser } from "./localDb.js";
import { computeTrendStates, explainTrendReading, TREND_STATE_MODEL_VERSION_V2, TREND_FEATURE_VERSION_V2, TREND_PRIOR_MS } from "../../lib/discoveryTrendState.js";
import type { MomentumRow } from "../../lib/discoveryLocalMomentum.js";
import {
  buildPlaceTrendContext, computeAreaTrendStates, type ContextPlaceRow, type ContextMembershipRow, type PlaceTrendContext,
} from "../../lib/discoveryTrendNormalised.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIG_3477 = resolve(__dir, "../../migrations/3477_discovery_trend_v2_rebuild.sql");
const RB_3477 = resolve(__dir, "../../../../../db/rollback/2026-09-28-3477-discovery-trend-v2-rebuild-rollback.sql");

const P_NOW = "2031-07-15T00:00:00.000Z";
const NOW_MS = Date.parse(P_NOW);
const HOUR = 3_600_000;
const TAG = `w10r1${randomUUID().slice(0, 6)}`;
const CITY = `${TAG}city`;
const ts = (msAgo: number) => `'${new Date(NOW_MS - msAgo).toISOString()}'::timestamptz`;

const users: string[] = [];
const places: Record<string, string> = {};   // label → discovery_places uuid
const trailId = randomUUID();
const item = (label: string) => (label.startsWith("osm:") ? `${TAG}${label}` : `db/${places[label]}`);

type Ev = { u: number; p: string; o: string; sH: number; oH?: number | null };
const EV: Ev[] = [];
/** n impressions served over [fromH, fromH + n·stepH) hours ago, rotating through users. */
const imps = (p: string, n: number, fromH: number, stepH = 0.5, u0 = 0) => {
  for (let i = 0; i < n; i++) EV.push({ u: (u0 + i) % 40, p, o: "impression", sH: fromH + i * stepH });
};
/** One converted row per user, each at `atH + k·gapH` hours ago (gaps ≫ 30 s unless asked). */
const acts = (p: string, o: string, us: number[], atH: number, gapH = 0.25) => {
  us.forEach((u, k) => { const at = atH + k * gapH; EV.push({ u, p, o, sH: at + 0.1, oH: at }); });
};

const flag = (on: boolean) =>
  exec(`UPDATE public.feature_flags SET enabled = ${on} WHERE flag = 'discovery_trend_normalised_enabled';`);
const rebuild = () => exec(`SET LOCAL ROLE service_role;\nSELECT public.rebuild_place_momentum('${P_NOW}'::timestamptz);`, { single: true });

function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

const MINE_ITEMS = () => [...Object.values(places).map((id) => `db/${id}`), `${TAG}osm:node1`];
const inList = (xs: string[]) => xs.map((x) => `'${x}'`).join(",");
const storedPlaces = () => rows<Record<string, any>>(
  `SELECT * FROM public.place_momentum WHERE computed_at = '${P_NOW}'::timestamptz AND place_id IN (${inList(MINE_ITEMS())}) ORDER BY place_id`);
const loaderRows = () => rows<MomentumRow>(
  `SELECT item_id, outcome, served_at, outcome_at, user_id FROM public.rank_events
    WHERE surface = 'discovery' AND outcome <> 'analytics' AND user_id IN (${inList(users)})
      AND served_at >= '${new Date(NOW_MS - TREND_PRIOR_MS).toISOString()}'::timestamptz`);
const contextRows = () => ({
  places: rows<ContextPlaceRow>(`SELECT id::text, submitted_by::text, city, neighborhood, lat, lng, created_at, category, place_type FROM public.discovery_places`),
  members: rows<ContextMembershipRow>(`SELECT ct.trail_id::text, ct.source_id::text FROM public.content_trails ct JOIN public.trails t ON t.id = ct.trail_id
                                        WHERE ct.source_type = 'place' AND t.lifecycle_status <> 'archived'`),
});
const close = (a: unknown, b: number | null) =>
  b === null ? a === null : typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

describe("census-discovery §84 — the v2 rebuild IS lib/discoveryTrendNormalised", { skip: !HAVE_DB }, () => {
  before(() => {
    for (let i = 0; i < 40; i++) users.push(seedUser(`${TAG}u${i}`));
    const C1 = users[35]!, C2 = users[36]!;
    // ── places: label → [creator, neighbourhood, lat, lng, category, createdHoursAgo] ──
    const P: Record<string, [string | null, string | null, number | null, number | null, string, number]> = {
      A: [null, null, -80.101, 170.101, "cafe", 2000],        // emerging, breadth
      B: [null, null, -80.141, 170.141, "cafe", 2000],        // trending, trip adds
      C: [null, null, -80.181, 170.181, "cafe", 2000],        // cooling
      D: [null, null, -80.221, 170.221, "temple", 2000],      // established, enduring → evergreen
      E: [null, null, -80.261, 170.261, "cafe", 2000],        // rediscovered, saves
      F: [null, null, -80.301, 170.301, "cafe", 2000],        // one account
      G: [null, null, -80.341, 170.341, "cafe", 2000],        // one synchronised burst
      H: [null, null, -80.381, 170.381, "cafe", 2000],        // below the exposure floor
      I: [null, null, -80.421, 170.421, "cafe", 80],          // launch burst in mid
      N: [null, null, -80.461, 170.461, "festival", 2000],    // ephemeral, lapsed → inactive
      J1: [C1, null, -80.501, 170.501, "bar", 2000], J2: [C1, null, -80.541, 170.541, "bar", 2000],
      J3: [C1, null, -80.581, 170.581, "bar", 2000], J4: [C1, null, -80.621, 170.621, "bar", 2000],
      J5: [C1, null, -80.661, 170.661, "bar", 2000],          // creator peers: J1–J4 surge alike, J5 more
      K1: [C2, "Old Town", null, null, "food", 2000], K2: [null, "old town", null, null, "food", 2000],
      K3: [null, "Old Town ", null, null, "food", 2000], K4: [null, "Old Town", null, null, "food", 2000],
      L1: [null, null, -81.001, 171.001, "park", 2000], L2: [null, null, -81.101, 171.101, "park", 2000],
      L3: [null, null, -81.201, 171.201, "park", 2000], L4: [null, null, -81.301, 171.301, "park", 2000],
    };
    const inserts: string[] = [];
    for (const [label, [creator, hood, lat, lng, cat, createdH]] of Object.entries(P)) {
      places[label] = randomUUID();
      inserts.push(`('${places[label]}', '${CITY}', '${TAG} ${label}', 'venue', '${cat}', ${hood === null ? "NULL" : `'${hood}'`},
        ${creator === null ? "NULL" : `'${creator}'`}, ${lat === null ? "NULL" : lat}, ${lng === null ? "NULL" : lng}, ${ts(createdH * HOUR)})`);
    }
    exec(`INSERT INTO public.discovery_places (id, city, name, place_type, category, neighborhood, submitted_by, lat, lng, created_at) VALUES ${inserts.join(",\n")};`);
    exec(`INSERT INTO public.trails (id, slug, title) VALUES ('${trailId}', '${TAG}-trail', '${TAG} trail');
          INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, confidence, content_state) VALUES
          ${["L1", "L2", "L3", "L4"].map((l) => `('${trailId}', 'place', '${places[l]}', 'primary', 0.9, 'just_arrived')`).join(",\n")};`);

    const U = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
    // A emerging: 40 recent impressions, 4 independent taps; no history.
    imps("A", 40, 1); acts("A", "tap", U(0, 4), 3);
    // B trending: recent 40 imp + 5 trip adds; mid 60 imp + 3 taps.
    imps("B", 40, 1); acts("B", "trip_add", U(4, 9), 2); imps("B", 60, 50, 1.5); acts("B", "tap", U(9, 12), 60);
    // C cooling: recent 60 imp + 3 taps; mid 40 imp + 10 saves.
    imps("C", 60, 1, 0.7); acts("C", "tap", U(0, 3), 5); imps("C", 40, 50, 2); acts("C", "save", U(3, 13), 70, 1);
    // D established + evergreen: recent, mid and prior alike.
    imps("D", 40, 1); acts("D", "tap", U(0, 4), 4); imps("D", 100, 50, 1.1); acts("D", "tap", U(4, 14), 60, 3);
    imps("D", 60, 200, 3); acts("D", "tap", U(14, 20), 250, 5);
    // E rediscovered: recent 40 + 3 saves; mid exposure only; prior 40 + 4 saves.
    imps("E", 40, 1); acts("E", "save", U(20, 23), 6); imps("E", 40, 50, 2); imps("E", 40, 200, 3); acts("E", "save", U(23, 27), 300, 4);
    // F one account: 40 impressions and ten actions by ONE user.
    imps("F", 40, 1); acts("F", "save", Array(10).fill(30), 2, 0.5);
    // G a synchronised burst: four users save within 10 s of each other (one cluster).
    imps("G", 40, 1); acts("G", "save", U(0, 4), 7, 10 / 3600 / 3);
    // H below the exposure floor: 12 impressions, four taps.
    imps("H", 12, 1); acts("H", "tap", U(0, 4), 3);
    // I launch burst: created 80 h ago; a mid-window burst inside its first 48 h is not history.
    imps("I", 40, 1); acts("I", "tap", U(0, 4), 3); imps("I", 40, 50, 0.7); acts("I", "save", U(4, 14), 60, 1);
    // N ephemeral: exposure now, activity only 60 h ago → inactive after 12 h.
    imps("N", 40, 1); imps("N", 40, 50, 1); acts("N", "tap", U(0, 5), 60);
    // J creator peers: J1–J4 alike (recent 40 + 6 taps vs mid 40 + 3 taps), J5 recent 40 + 12 taps.
    for (const j of ["J1", "J2", "J3", "J4", "J5"]) {
      imps(j, 40, 1); acts(j, "tap", U(0, j === "J5" ? 12 : 6), 2, 0.3);
      imps(j, 40, 50, 2); acts(j, "tap", U(20, 23), 55, 2);
    }
    // K one neighbourhood: K1–K4 all rising.
    for (const k of ["K1", "K2", "K3", "K4"]) {
      imps(k, 40, 1); acts(k, "save", U(0, k === "K1" ? 10 : 5), 2, 0.3);
      imps(k, 40, 50, 2); acts(k, "tap", U(20, 23), 55, 2);
    }
    // L one Trail: L1–L4 steady, L4 falling.
    for (const l of ["L1", "L2", "L3", "L4"]) {
      imps(l, l === "L4" ? 60 : 40, 1, l === "L4" ? 0.6 : 0.9); acts(l, "tap", U(0, l === "L4" ? 3 : 5), 2, 0.3);
      imps(l, 40, 50, 2); acts(l, "tap", U(20, 25), 55, 2);
    }
    // An id with no discovery_places row (OSM-shaped): no context, no peers.
    imps("osm:node1", 40, 1); acts("osm:node1", "tap", U(0, 4), 3);
    // Noise the model must ignore: dismisses (exposure, never activity), analytics,
    // and a save on an impression served before the window.
    acts("A", "dismiss", U(30, 34), 4);
    EV.push({ u: 30, p: "A", o: "analytics", sH: 2 }, { u: 31, p: "A", o: "save", sH: 31 * 24, oH: 2 });

    const values = EV.map((e) =>
      `('${users[e.u]}', '${item(e.p)}', 'discovery', '${e.o}', ${ts(e.sH * HOUR)}, ${e.oH == null ? "NULL" : ts(e.oH * HOUR)})`);
    for (let i = 0; i < values.length; i += 500) {
      exec(`INSERT INTO public.rank_events (user_id, item_id, surface, outcome, served_at, outcome_at) VALUES ${values.slice(i, i + 500).join(",\n")};`);
    }
    flag(true);
    rebuild();
  });

  after(() => {
    flag(false);
    exec(`DELETE FROM public.place_momentum WHERE computed_at = '${P_NOW}'::timestamptz;
          DELETE FROM public.area_momentum WHERE computed_at = '${P_NOW}'::timestamptz;
          DELETE FROM public.content_trails WHERE trail_id = '${trailId}';
          DELETE FROM public.trails WHERE id = '${trailId}';
          DELETE FROM public.discovery_places WHERE city = '${CITY}';`);
    for (const u of users) deleteUser(u);   // cascades their rank_events
  });

  it("N0. flag OFF: the dispatcher writes exactly what 3435's own function writes, and no v2 column", () => {
    flag(false);
    try {
      const snap = `SELECT 'SNAP' || COALESCE(json_agg(to_jsonb(p) - 'id' - 'created_at' ORDER BY p.place_id), '[]'::json)::text FROM public.place_momentum p
                     WHERE computed_at = '${new Date(NOW_MS + 1_000).toISOString()}'::timestamptz AND place_id IN (${inList(MINE_ITEMS())});`;
      const at = `'${new Date(NOW_MS + 1_000).toISOString()}'::timestamptz`;
      const out = exec(`BEGIN;
SELECT public.rebuild_place_momentum(${at});
${snap}
DELETE FROM public.place_momentum WHERE computed_at = ${at};
${unwrapped(RB_3477)}
SELECT public.rebuild_place_momentum(${at});
${snap}
ROLLBACK;`).filter((l) => l.startsWith("SNAP")).map((l) => JSON.parse(l.slice(4)) as Array<Record<string, unknown>>);
      assert.equal(out.length, 2);
      const [dispatched, by3435] = out as [Array<Record<string, unknown>>, Array<Record<string, unknown>>];
      assert.ok(dispatched.length >= 20, "not vacuous: the corpus is stored");
      assert.deepEqual(dispatched, by3435, "flag OFF, 3477's dispatcher moved a value 3435 writes");
      for (const r of dispatched) {
        assert.equal(r["model_version"], "discovery-trend-state-v1");
        for (const c of ["recent_exposures", "recent_groups", "velocity", "lifecycle_state", "driver", "cell_key"]) assert.equal(r[c], null, `${String(r["place_id"])} ${c}`);
      }
    } finally { flag(true); }
  });

  it("N1. the context: discovery_trend_place_context() equals buildPlaceTrendContext over the same rows", () => {
    const { places: pr, members } = contextRows();
    const ts = buildPlaceTrendContext(pr, members);
    const sql = rows<Record<string, any>>(`SELECT * FROM public.discovery_trend_place_context() WHERE place_key IN (${inList(Object.values(places))})`);
    assert.equal(sql.length, Object.keys(places).length);
    for (const s of sql) {
      const t = ts[s.place_key] as PlaceTrendContext;
      assert.ok(t, s.place_key);
      assert.deepEqual(
        { creator: s.creator_id, cell: s.cell_key, label: s.cell_label, city: s.city, created: Date.parse(s.created_at), cls: s.content_class, trails: s.trail_ids },
        { creator: t.creatorId, cell: t.cellKey, label: t.cellLabel, city: t.city, created: t.createdAtMs, cls: t.contentClass, trails: [...t.trailIds] },
        s.place_key);
    }
    const k = ts[places["K3"]!]!;
    assert.equal(k.cellKey, `n:${CITY}:old town`, "a neighbourhood keys case- and space-insensitively within its city");
    assert.equal(k.cellLabel, "Old Town", "the label is the byte-least spelling");
    assert.equal(ts[places["D"]!]!.contentClass, "enduring");
    assert.equal(ts[places["N"]!]!.contentClass, "ephemeral");
    assert.deepEqual([...ts[places["L2"]!]!.trailIds], [trailId]);
  });

  it("N2. every stored v2 place row equals computeTrendStates(…, { model: 'v2' }) over the loader's rows", () => {
    const { places: pr, members } = contextRows();
    const t = computeTrendStates(loaderRows(), NOW_MS, { model: "v2", context: buildPlaceTrendContext(pr, members) });
    const sql = storedPlaces();
    assert.deepEqual(sql.map((r) => r.place_id).sort(), Object.keys(t).sort(), "the same places, no more, no fewer");
    for (const r of sql) {
      const x = t[r.place_id]!;
      const e = x.evidence as unknown as Record<string, number | null>;
      const where = `${r.place_id}`;
      assert.equal(r.trend_state, x.state, `${where} state`);
      assert.equal(r.lifecycle_state, x.lifecycle, `${where} lifecycle`);
      assert.equal(r.driver, x.driver, `${where} driver`);
      for (const [col, key] of [["recent_rate", "recentRate"], ["mid_rate", "midRate"], ["prior_rate", "priorRate"], ["total_weight", "totalWeight"],
        ["time_of_day_factor", "timeOfDayFactor"], ["peer_factor", "peerFactor"], ["velocity", "velocity"]] as const) {
        assert.ok(close(r[col], e[key] ?? null), `${where} ${col}: SQL ${r[col]} vs TS ${e[key]}`);
      }
      for (const [col, key] of [["recent_exposures", "recentExposures"], ["mid_exposures", "midExposures"], ["prior_exposures", "priorExposures"],
        ["recent_groups", "recentGroups"], ["mid_groups", "midGroups"], ["prior_groups", "priorGroups"],
        ["recent_unique_travelers", "recentTravelers"], ["window_unique_travelers", "windowTravelers"]] as const) {
        assert.equal(r[col], e[key], `${where} ${col}`);
      }
      assert.equal(r.reason, explainTrendReading(x.state, x.driver ?? null), `${where} sentence`);
      assert.equal(r.model_version, TREND_STATE_MODEL_VERSION_V2);
      assert.equal(r.feature_version, TREND_FEATURE_VERSION_V2);
      assert.equal(r.model_version, x.provenance.modelVersion);
      assert.equal(r.feature_version, x.provenance.featureVersion);
    }
  });

  it("N3. every stored Local Pulse row equals computeAreaTrendStates", () => {
    const { places: pr, members } = contextRows();
    const ctx = buildPlaceTrendContext(pr, members);
    const t = computeAreaTrendStates(loaderRows(), NOW_MS, ctx);
    const cells = [...new Set(Object.values(places).map((id) => ctx[id]!.cellKey).filter((c): c is string => c !== null))];
    const sql = rows<Record<string, any>>(`SELECT * FROM public.area_momentum WHERE computed_at = '${P_NOW}'::timestamptz AND cell_key IN (${inList(cells)})`);
    assert.deepEqual(sql.map((r) => r.cell_key).sort(), Object.keys(t).filter((k) => cells.includes(k)).sort());
    for (const r of sql) {
      const x = t[r.cell_key]!;
      assert.equal(r.trend_state, x.state, `${r.cell_key} state`);
      assert.equal(r.driver, x.driver, `${r.cell_key} driver`);
      assert.ok(close(r.velocity, x.evidence.velocity), `${r.cell_key} velocity ${r.velocity} vs ${x.evidence.velocity}`);
      assert.ok(close(r.time_of_day_factor, x.evidence.timeOfDayFactor), `${r.cell_key} tod`);
      assert.equal(r.recent_groups, x.evidence.recentGroups);
      assert.equal(r.recent_unique_travelers, x.evidence.recentTravelers);
    }
    const oldTown = sql.find((r) => r.cell_key === `n:${CITY}:old town`);
    assert.ok(oldTown, "the neighbourhood has a Local Pulse row");
    assert.equal(oldTown.cell_label, "Old Town");
    assert.equal(oldTown.trend_state, "trending", "K1–K4 all rising: the neighbourhood is rising");
  });

  it("N4. the designed cases classify as the model says they must", () => {
    const s = Object.fromEntries(storedPlaces().map((r) => [r.place_id, r]));
    const st = (label: string) => s[item(label)];
    if (process.env["W10R1_DUMP"] === "1") {
      for (const l of [...Object.keys(places), "osm:node1"]) {
        const r = st(l);
        console.log(l, r.trend_state, r.lifecycle_state, r.driver, "E", r.recent_exposures, r.mid_exposures, r.prior_exposures, "G", r.recent_groups, r.mid_groups, r.prior_groups,
          "r", r.recent_rate?.toFixed(3), r.mid_rate?.toFixed(3), "v", r.velocity, "tod", r.time_of_day_factor, "pf", r.peer_factor);
      }
    }
    assert.equal(st("A").trend_state, "emerging");
    assert.equal(st("A").driver, "independent_groups");
    assert.equal(st("A").recent_exposures, 40 + 4 + 4, "every served row is exposure — 40 impressions, 4 taps, 4 dismisses; not the analytics row, not the save served 31 days ago");
    assert.equal(st("B").trend_state, "trending");
    assert.equal(st("B").driver, "trip_adds");
    assert.equal(st("B").lifecycle_state, "growing");
    assert.equal(st("C").trend_state, "cooling");
    assert.equal(st("D").trend_state, "established");
    assert.equal(st("D").lifecycle_state, "evergreen", "an enduring place sustained over all three windows");
    assert.equal(st("E").trend_state, "rediscovered");
    assert.equal(st("E").driver, "saves");
    assert.equal(st("F").trend_state, "unknown", "DV-32: one account is not a trend, however often it acts");
    assert.equal(st("F").recent_groups, 1);
    assert.equal(st("G").trend_state, "unknown", "DV-34: four accounts saving within seconds are one independence cluster");
    assert.equal(st("G").recent_groups, 1);
    assert.equal(st("H").trend_state, "unknown", "DV-30: 16 exposures are below the floor, however many converted");
    assert.equal(st("I").trend_state, "emerging", "content age: the mid-window burst sits in the launch window, so there is no history");
    assert.equal(st("N").lifecycle_state, "inactive", "03 §4: an ephemeral place quiet for more than 12 h is inactive");
    assert.equal(st("J5").trend_state, "trending");
    assert.ok(Number(st("J1").peer_factor) > 1.5 && Number(st("J1").peer_factor) === Number(st("J2").peer_factor),
      "the creator's shared surge is the peer baseline");
    assert.equal(st("J1").trend_state, "established", "J1 rose exactly as its creator's other places did: divided out");
    assert.equal(st("K2").trend_state, "established", "a place rising exactly with its neighbourhood is not trending by itself");
    assert.equal(st("L4").trend_state, "cooling", "below its Trail's shared level");
    assert.equal(s[`${TAG}osm:node1`].peer_factor, 1, "no context, no peer baseline");
    assert.equal(s[`${TAG}osm:node1`].trend_state, "emerging");
  });

  it("N5. 3477's rollback restores 3435; 3477 re-applied is idempotent", () => {
    const out = exec(`BEGIN;
${unwrapped(RB_3477)}
SELECT 'RB:' || (position('rebuild_place_momentum_v2' IN pg_get_functiondef('public.rebuild_place_momentum(timestamptz)'::regprocedure)) = 0)::text;
${unwrapped(MIG_3477)}
${unwrapped(MIG_3477)}
SELECT 'RE:' || (position('rebuild_place_momentum_v2(p_now)' IN pg_get_functiondef('public.rebuild_place_momentum(timestamptz)'::regprocedure)) > 0)::text;
ROLLBACK;`);
    assert.ok(out.includes("RB:true"), out.join("\n"));
    assert.ok(out.includes("RE:true"), out.join("\n"));
  });
});
