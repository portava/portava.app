/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's note on D-W11X2-172): the saved_count
 * write path for an OSM place never keeps a lost write.
 *
 * POST /wishlist answers 201 once the wishlist row is committed and runs trackOsmPlaceSave after it (`void`): it records
 * the saver in discovery_place_saves and wrote `saved_count = snapshot + 1` from a value read before the insert. A
 * failed update (logged, never retried: a repeat save is a no-op) lost that save for good, and two savers who read the
 * same snapshot both wrote snapshot + 1. D-W11X2-172 said every failure on this path answers the saver `unavailable`;
 * it does not (the save itself did commit). Now every save of the place — a new saver or a repeat — writes the MEASURED
 * number of savers (an exact count of discovery_place_saves), so a lost or raced write is repaired by the next save
 * rather than kept. Where the server answers no count, a new saver is counted as before (snapshot + 1).
 *
 *   SC0 CONTROL: 2 savers, saved_count 2, a third saves → 3
 *   SC1 2 savers but saved_count 1 (an earlier write was lost), a third saves → 3, never 2
 *   SC2 the same lost write, a saver saves AGAIN (a repeat) → repaired to 2
 *   SC3 a server that answers no count → a new saver is snapshot + 1, as before; a repeat writes nothing
 *   SC4 the count read FAILS → nothing is written over the stored count
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { trackOsmPlaceSave } from "../routes/wishlist.js";

const OSM = "node/424242"; const DP = "dp-424242";
type Row = Record<string, unknown>;
function fake(o: { savedCount: number; savers: string[]; noCount?: boolean; countFails?: boolean }) {
  const dp: Row[] = [{ id: DP, osm_id: OSM, saved_count: o.savedCount }];
  const dps: Row[] = o.savers.map((u) => ({ user_id: u, place_id: DP }));
  const writes: number[] = [];
  const chain = (table: string, rows: Row[]) => {
    const filters: Array<(r: Row) => boolean> = []; let op = "select"; let data: Row | null = null; let opts: Row = {}; let counted = false; let afterWrite = false;
    const q: any = {
      select: (_c?: string, so?: { count?: string }) => { if (op === "upsert" || op === "update") afterWrite = true; else counted = so?.count === "exact"; return q; },
      upsert: (d: Row, uo?: Row) => { op = "upsert"; data = d; opts = uo ?? {}; return q; },
      update: (d: Row) => { op = "update"; data = d; return q; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      filter: () => q, gt: () => q, order: () => q, limit: () => q,
      maybeSingle: () => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
      then: (res: any, rej: any) => {
        let out: any;
        if (op === "upsert" && data) {
          const keys = String(opts.onConflict ?? "id").split(",");
          const hit = rows.find((r) => keys.every((k) => r[k] === data![k]));
          if (hit) out = { data: afterWrite ? [] : null, error: null }; else { const nr = { id: DP, ...data }; rows.push(nr); out = { data: afterWrite ? [nr] : null, error: null }; }
        } else if (op === "update" && data) {
          rows.filter((r) => filters.every((f) => f(r))).forEach((r) => Object.assign(r, data)); if (table === "discovery_places") writes.push(Number(data.saved_count)); out = { data: null, error: null };
        } else {
          const m = rows.filter((r) => filters.every((f) => f(r)));
          if (counted && table === "discovery_place_saves" && o.countFails) out = { data: null, error: { message: "canceling statement due to statement timeout" }, count: null };
          else out = { data: counted ? null : m, error: null, ...(counted && !o.noCount ? { count: m.length } : {}) };
        }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  return {
    dp, writes,
    from: (t: string) => (t === "discovery_places" ? chain(t, dp) : t === "discovery_place_saves" ? chain(t, dps) : chain(t, [])),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}
const save = async (f: ReturnType<typeof fake>, user: string) => { _setTestClient(f as any, true); await trackOsmPlaceSave(user, OSM, { name: "Harbour bar", category: "food" }); return f.dp[0].saved_count; };

describe("census-discovery §119 (D-W11X2-172): saved_count is the measured number of savers", () => {
  afterEach(() => _clearTestClient());
  it("SC0 CONTROL: 2 savers, saved_count 2, a third saves → 3", async () => {
    assert.equal(await save(fake({ savedCount: 2, savers: ["u1", "u2"] }), "u3"), 3);
  });
  it("SC1 an earlier write was lost (1 stored, 2 savers), a third saves → 3, never 2", async () => {
    assert.equal(await save(fake({ savedCount: 1, savers: ["u1", "u2"] }), "u3"), 3);
  });
  it("SC2 the same lost write, a saver saves again → repaired to 2", async () => {
    assert.equal(await save(fake({ savedCount: 1, savers: ["u1", "u2"] }), "u2"), 2);
  });
  it("SC3 no count answered → a new saver is snapshot + 1; a repeat writes nothing", async () => {
    assert.equal(await save(fake({ savedCount: 5, savers: [], noCount: true }), "u1"), 6);
    const f = fake({ savedCount: 1, savers: ["u1", "u2"], noCount: true });
    assert.equal(await save(f, "u2"), 1); assert.deepEqual(f.writes, []);
  });
  it("SC4 the count read FAILS → nothing written over the stored count", async () => {
    const f = fake({ savedCount: 2, savers: ["u1", "u2"], countFails: true });
    assert.equal(await save(f, "u3"), 2); assert.deepEqual(f.writes, []);
  });
});
