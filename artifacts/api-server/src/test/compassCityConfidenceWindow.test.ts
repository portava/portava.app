/**
 * compassCityConfidenceWindow — census-discovery §85 (lane W10-R3), H-P21-4.
 *
 * §75.3 blockers 1 and 2: `computeCityConfidenceIndex` read its corpus with
 * `.limit(20000)` and no `order`, so no window could be stated, and dropped
 * `error`, so a failed read scored a city as empty. §85 puts ordered, paged,
 * windowed reads behind `compass_city_confidence_windowed_reads_enabled`
 * (3484, seeded FALSE) and records the four `10` §5 facts on the reading.
 *
 *   W0  flag OFF: every upsert payload and the return value are byte-identical
 *       to `6d1e7090b` (hash captured there, before any §85 edit)
 *   W1  flag ON: every producer read is ordered and paged
 *   W2  flag ON: a failed read scores NO city and says which read failed
 *   W3  flag ON: the reading records model version, feature version, window
 *       and computation clock, and the window is `unbounded_start` when every
 *       row was read
 *   W4  flag ON: a corpus beyond the old 20000-row cap is counted in full —
 *       `depth_score` moves, which is exactly why this is behind a new flag
 *   W5  flag ON: a read that hits CITY_DEPTH_MAX_ROWS records a BOUNDED window
 *       starting at the oldest row it reached, and `truncated: true`
 *
 * Runtime: node:test + node:assert/strict.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { computeCityConfidenceIndex, scoreCityDepth } from "../compass/CompassGraphEngine.js";
import { makeFakeCandidateDb, flagRow, type Row } from "./helpers/fakeCandidateDb.js";

const FLAG = "compass_city_confidence_windowed_reads_enabled";
const NOW = Date.parse("2026-09-28T09:30:00Z");
const DAY = 86_400_000;

/** The hash of W0's writes and result, captured at 6d1e7090b. */
const GOLDEN_W0 = "e66d06b55736aac70e507c436d1a071445d3e8b89ac752229a82c5ab647017ee";

function corpus(edgeCount: number): Record<string, Row[]> {
  const edges: Row[] = [];
  for (let i = 0; i < edgeCount; i++) {
    edges.push({
      id: `e-${String(i).padStart(6, "0")}`, src_type: "person", src_key: `p-${i}`, dst_type: "city",
      dst_key: i % 3 === 0 ? "lisbon" : "porto", edge_type: i % 10 === 0 ? "returned_to" : "visited",
      observed_count: 1, last_seen: new Date(NOW - (i % 400) * DAY).toISOString(),
    });
  }
  edges.push({ id: "o-1", src_type: "person", src_key: "p-x", dst_type: "event", dst_key: "ev-1", edge_type: "outcome:attended", observed_count: 1, last_seen: new Date(NOW - DAY).toISOString() });
  return {
    compass_city_models: [
      { city: "lisbon", time_slices: { "fri:evening": { count: 9 } }, sample_size: 120, built_at: new Date(NOW).toISOString() },
      { city: "porto", time_slices: {}, sample_size: 12, built_at: new Date(NOW).toISOString() },
    ],
    compass_graph_edges: edges,
    compass_graph_nodes: [
      { id: "n-1", node_type: "event", node_key: "ev-1", city: "Lisbon", updated_at: new Date(NOW - DAY).toISOString() },
      { id: "n-2", node_type: "event", node_key: "ev-2", city: "Porto", updated_at: new Date(NOW - 2 * DAY).toISOString() },
    ],
    compass_city_confidence: [],
  };
}

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** The upserts, with the computation clock replaced so the hash names the values. */
function upserts(db: ReturnType<typeof makeFakeCandidateDb>) {
  return db.writes.filter((w) => w.table === "compass_city_confidence").map((w) => {
    const p = { ...(w.payload as Row) };
    if (typeof p["computed_at"] === "string") p["computed_at"] = "<clock>";
    return { op: w.op, payload: p, options: w.options };
  });
}

describe("§85 H-P21-4 — the city-confidence producer's reads", () => {
  it("W0. flag OFF: the upserts and the result are byte-identical to 6d1e7090b", async () => {
    const db = makeFakeCandidateDb({ ...corpus(300), feature_flags: [flagRow(FLAG, false)] });
    const r = await computeCityConfidenceIndex(db as never);
    const h = sha({ r, w: upserts(db) });
    if (process.env["P85_PRINT_GOLDEN"] === "1") console.log("w0", h);
    assert.equal(h, GOLDEN_W0);
  });

  it("W1. flag ON: every producer read is ordered and paged", async () => {
    const db = makeFakeCandidateDb({ ...corpus(300), feature_flags: [flagRow(FLAG, true)] });
    await computeCityConfidenceIndex(db as never);
    const producerReads = db.reads.filter((x) => x.table !== "feature_flags");
    assert.ok(producerReads.length >= 4, `four reads at least (${producerReads.length})`);
    for (const read of producerReads) {
      assert.ok(read.ops.some((o) => o.startsWith("order(")), `${read.table} is ordered: ${read.ops.join(" ")}`);
      assert.ok(read.ops.some((o) => o.startsWith("range(")), `${read.table} is paged: ${read.ops.join(" ")}`);
      assert.ok(!read.ops.includes("limit(20000)"), `${read.table} carries no unordered cap`);
    }
  });

  it("W2. flag ON: a failed read scores no city, overwrites nothing, and names the read", async () => {
    const db = makeFakeCandidateDb({ ...corpus(300), feature_flags: [flagRow(FLAG, true)] }, { erroring: ["compass_graph_nodes"] });
    const r = await computeCityConfidenceIndex(db as never) as { scored: number; strongestCity: string | null; readErrors?: string[] };
    assert.equal(r.scored, 0);
    assert.equal(upserts(db).length, 0, "no reading is written over a corpus that could not be read");
    assert.deepEqual(r.readErrors, ["compass_graph_nodes.events"]);
  });

  it("W3. flag ON: the reading carries model version, feature version, window and computation time", async () => {
    const db = makeFakeCandidateDb({ ...corpus(300), feature_flags: [flagRow(FLAG, true)] });
    await computeCityConfidenceIndex(db as never);
    const w = db.writes.filter((x) => x.table === "compass_city_confidence");
    assert.equal(w.length, 2);
    for (const x of w) {
      const p = x.payload as Row;
      assert.equal(p["model_version"], "compass-city-depth-v1");
      assert.equal(p["feature_version"], "compass-city-depth-signals-v1");
      const win = p["source_window"] as { kind: string; startMs: number | null; endMs: number; truncated: boolean; rows: Record<string, number> };
      assert.equal(win.kind, "unbounded_start");
      assert.equal(win.startMs, null);
      assert.equal(win.truncated, false);
      assert.equal(new Date(win.endMs).toISOString(), p["computed_at"], "the window ends at the computation clock");
      assert.equal(win.rows["compass_graph_edges.visits"], 300);
    }
  });

  it("W4. flag ON: a corpus beyond the old 20000-row cap is counted in full, so depth_score moves", async () => {
    // 20000 Porto edges stored first, then 50 Lisbon edges: the unordered cap
    // returns the first 20000 rows the table yields, so Lisbon read as unvisited.
    const beyondCap = (): Record<string, Row[]> => {
      const c = corpus(0);
      const edges: Row[] = [];
      for (let i = 0; i < 20_050; i++) edges.push({ id: `e-${String(i).padStart(6, "0")}`, src_type: "person", src_key: `p-${i}`, dst_type: "city",
        dst_key: i < 20_000 ? "porto" : "lisbon", edge_type: "visited", observed_count: 1, last_seen: new Date(NOW - (i < 20_000 ? 300 : 1) * DAY).toISOString() });
      return { ...c, compass_graph_edges: edges };
    };
    const off = makeFakeCandidateDb({ ...beyondCap(), feature_flags: [] });
    const on = makeFakeCandidateDb({ ...beyondCap(), feature_flags: [flagRow(FLAG, true)] });
    await computeCityConfidenceIndex(off as never);
    await computeCityConfidenceIndex(on as never);
    const depth = (db: typeof off, city: string) => (db.writes.find((w) => (w.payload as Row)["city"] === city)!.payload as Row)["depth_score"];
    const signals = (db: typeof off, city: string) => (db.writes.find((w) => (w.payload as Row)["city"] === city)!.payload as Row)["signals"] as Record<string, number>;
    assert.equal(signals(off, "lisbon")["visitors"], 0, "precondition: the unordered cap hid every Lisbon visit");
    assert.equal(signals(on, "lisbon")["visitors"], 50, "every visit edge is counted");
    assert.equal(depth(on, "lisbon"), scoreCityDepth(signals(on, "lisbon") as never));
    assert.notEqual(depth(on, "lisbon"), depth(off, "lisbon"));
  });

  it("W5. flag ON: a read that reaches CITY_DEPTH_MAX_ROWS records a bounded window from the oldest row it read", async () => {
    const db = makeFakeCandidateDb({ ...corpus(100_500), feature_flags: [flagRow(FLAG, true)] });
    await computeCityConfidenceIndex(db as never);
    const p = db.writes.find((x) => x.table === "compass_city_confidence")!.payload as Row;
    const win = p["source_window"] as { kind: string; startMs: number | null; truncated: boolean; rows: Record<string, number> };
    assert.equal(win.kind, "bounded");
    assert.equal(win.truncated, true);
    assert.equal(win.rows["compass_graph_edges.visits"], 100_000);
    // Newest first, so the oldest row reached is the bound.
    const edges = (corpus(100_500).compass_graph_edges as Row[]).filter((e) => e["edge_type"] !== "outcome:attended")
      .map((e) => Date.parse(String(e["last_seen"]))).sort((a, b) => b - a);
    assert.equal(win.startMs, edges[99_999]);
  });
});
