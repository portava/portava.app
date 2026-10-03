/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; sweep, D-W11X2-172's saved_count class): POST
 * /discovery/community/:placeId/save never keeps a lost saved_count write.
 *
 * The route upserts the saver's discovery_place_saves row, then wrote `saved_count = snapshot + 1` for a first save.
 * When that update failed it answered `unavailable` — but the save row had committed, so the saver's retry found an
 * existing save and never wrote the count: the save was lost for good (and two first saves reading the same snapshot
 * both wrote snapshot + 1). Every save of the place now writes the MEASURED number of savers (an exact count of
 * discovery_place_saves), so the retry repairs it; where the server answers no count, a first save is snapshot + 1 as
 * before (discoveryCommunitySaveCount's FEED-1 cases, unchanged).
 *
 *   CS0 CONTROL: A and B saved, saved_count 2; C saves → 3
 *   CS1 A and B saved but saved_count 1 (B's write was lost); B retries → 2
 *   CS2 the same lost write; C saves → 3, never 2
 *   CS3 the saver count read FAILS → `unavailable`, nothing written
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

const PLACE = "11111111-1111-1111-1111-111111111111";
const [A, B, C] = ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "cccccccc-cccc-cccc-cccc-cccccccccccc"];

function fake(me: string, w: { saves: Set<string>; savedCount: number; writes: number[]; countFails?: boolean }) {
  const chain = (table: string) => {
    const eq: Record<string, unknown> = {}; let op = "select"; let row: any = null; let counted = false;
    const q: any = {
      select: (_c?: string, o?: { count?: string }) => { counted = o?.count === "exact"; return q; },
      update: (r: any) => { op = "update"; row = r; return q; },
      upsert: (r: any) => { op = "upsert"; row = r; return q; },
      eq: (c: string, v: unknown) => { eq[c] = v; return q; },
      maybeSingle: () => run(), then: (f: any, r: any) => run().then(f, r),
    };
    async function run(): Promise<any> {
      if (table === "profiles") return { data: { account_status: "active" }, error: null };
      if (table === "discovery_places") {
        if (op === "update") { w.savedCount = row.saved_count; w.writes.push(row.saved_count); return { data: null, error: null }; }
        return { data: { id: PLACE, saved_count: w.savedCount }, error: null };
      }
      if (table === "discovery_place_saves") {
        if (op === "upsert") { w.saves.add(`${row.user_id}|${row.place_id}`); return { data: null, error: null }; }
        if (counted) return w.countFails ? { data: null, error: { message: "canceling statement due to statement timeout" }, count: null } : { data: null, error: null, count: [...w.saves].filter((k) => k.endsWith(`|${eq.place_id}`)).length };
        return { data: w.saves.has(`${eq.user_id ?? me}|${eq.place_id ?? PLACE}`) ? { place_id: PLACE } : null, error: null };
      }
      return { data: null, error: null };
    }
    return q;
  };
  return { from: chain, auth: { getUser: async () => ({ data: { user: { id: me } }, error: null }) } };
}
let server: Server | null = null;
async function save(me: string, w: Parameters<typeof fake>[1]) {
  _setTestClient(fake(me, w) as any, true);
  server = createServer(app); await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/discovery/community/${PLACE}/save`, { method: "POST", headers: { authorization: `Bearer t-${me}`, "content-type": "application/json" }, body: "{}" });
    return (await res.json()) as { ok?: boolean; reason?: string };
  } finally { await new Promise<void>((r) => server!.close(() => r())); server = null; }
}
const world = (savers: string[], savedCount: number, countFails = false) => ({ saves: new Set(savers.map((u) => `${u}|${PLACE}`)), savedCount, writes: [] as number[], countFails });

describe("census-discovery §119 (sweep): a community place's saved_count is the measured number of savers", () => {
  afterEach(() => _setTestClient(null as any, false));
  it("CS0 CONTROL: A and B saved (2); C saves → 3", async () => {
    const w = world([A, B], 2); const r = await save(C, w);
    assert.deepEqual({ ok: r.ok, count: w.savedCount }, { ok: true, count: 3 });
  });
  it("CS1 B's write was lost (1 stored, 2 savers); B retries → repaired to 2", async () => {
    const w = world([A, B], 1); const r = await save(B, w);
    assert.deepEqual({ ok: r.ok, count: w.savedCount }, { ok: true, count: 2 });
  });
  it("CS2 the same lost write; C saves → 3, never 2", async () => {
    const w = world([A, B], 1); await save(C, w);
    assert.equal(w.savedCount, 3);
  });
  it("CS3 the saver count read FAILS → unavailable, nothing written", async () => {
    const w = world([A, B], 2, true); const r = await save(C, w);
    assert.deepEqual({ ok: r.ok, reason: r.reason, writes: w.writes }, { ok: false, reason: "unavailable", writes: [] });
  });
});
