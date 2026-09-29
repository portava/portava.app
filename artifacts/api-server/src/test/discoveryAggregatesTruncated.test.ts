/**
 * census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-103): the round-13 sweep of bounded reads
 * whose COUNT is stated as a fact. The per-row vote and review aggregates every served Discovery place
 * carries (`batchFetchVoteAndRatingAggregates`, lib/discoveryPlaceAggregates.ts) and the Hidden Gems
 * copy (routes/hiddenGems.ts) read `place_votes` and `reviews` with no range. PostgREST cuts every
 * response at db-max-rows (production 1000, census §67.3) silently, with `error: null` — the §108 BK6
 * shape — so a page whose places hold more votes than that was served "37 worth it" for a place with
 * more. Each read now asks for its exact count; a read that came back short of it (or failed) states no
 * count from it — the card shows no badge, as it does for a place with none — never a low one.
 *
 *   AG1  the votes read is cut at the cap (count 1 500, 1 000 rows) → no worth-it count stated
 *   AG2  the reviews read is cut at the cap → no rating or review count stated
 *   AG3  GET /hidden-gems?submittedBy=… over a cut votes read → the gem carries no worth-it count
 *   AGc  CONTROL: every row read (count = rows) → the counts are stated as before
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { batchFetchVoteAndRatingAggregates } from "../lib/discoveryPlaceAggregates.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const PLACE = "11111111-1111-4111-a111-111111111111";
const MAX_ROWS = 1000;
/** `votes`/`reviews` rows; `cut` answers at most MAX_ROWS rows with the whole count, as PostgREST does. */
function client(votes: number, reviews: number, extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    place_votes: Array.from({ length: votes }, (_, i) => ({ entity_id: PLACE, vote: "worth_it", i })),
    reviews: Array.from({ length: reviews }, (_, i) => ({ entity_id: PLACE, rating: 4, i })),
    ...extra,
  };
  const b = (table: string): any => {
    let count = false;
    const answer = (single: boolean) => {
      if (table === "feature_flags") return { data: single ? { enabled: true } : [{ enabled: true }], error: null };
      if (table === "profiles" && single) return { data: { id: "v", account_status: "active" }, error: null };
      const rows = tables[table] ?? [];
      return single ? { data: rows[0] ?? null, error: null } : { data: rows.slice(0, MAX_ROWS), count: count ? rows.length : null, error: null };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      if (k === "select") return (_c: string, o?: { count?: string }) => { if (o?.count === "exact") count = true; return p; };
      return () => p;
    } });
    return p;
  };
  return { auth: { getUser: async () => ({ data: { user: { id: "v" } }, error: null }) }, from: b, rpc: () => Promise.resolve({ data: [], error: null }) };
}

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", hiddenGemsRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());

describe("per-row vote and review counts over a read cut at db-max-rows (§110, D-W11X2-103)", () => {
  it("AG1 the votes read is cut at the cap → no worth-it count stated", async () => {
    const agg = await batchFetchVoteAndRatingAggregates(client(1500, 3), [PLACE], "place");
    assert.notEqual(agg.get(PLACE)?.worthItCount, MAX_ROWS, "a count cut at db-max-rows was stated as the count");
    assert.equal(agg.get(PLACE)?.worthItCount ?? 0, 0);
    assert.equal(agg.get(PLACE)?.reviewCount, 3, "the complete reviews read still states its count");
  });
  it("AG2 the reviews read is cut at the cap → no rating or review count stated", async () => {
    const agg = await batchFetchVoteAndRatingAggregates(client(5, 1200), [PLACE], "place");
    assert.equal(agg.get(PLACE)?.reviewCount ?? 0, 0);
    assert.equal(agg.get(PLACE)?.avgRating ?? null, null);
    assert.equal(agg.get(PLACE)?.worthItCount, 5);
  });
  it("AG3 GET /hidden-gems?submittedBy=… over a cut votes read → the gem carries no worth-it count", async () => {
    const gem = { id: PLACE, submitted_by: "g", status: "active", created_at: new Date().toISOString(), city: "Paris", name: "Gem" };
    const c = client(1500, 0, { hidden_gems: [gem] });
    _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const r = await fetch(`${base}/hidden-gems?submittedBy=g`, { headers: { Authorization: "Bearer t" } });
    const body = await r.json() as any;
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.notEqual(body.gems?.[0]?.worthItCount, MAX_ROWS, JSON.stringify(body.gems?.[0]));
  });
  it("AGc CONTROL: every row read → the counts are stated as before", async () => {
    const agg = await batchFetchVoteAndRatingAggregates(client(40, 3), [PLACE], "place");
    assert.deepEqual(agg.get(PLACE), { worthItCount: 40, avgRating: 4, reviewCount: 3 });
  });
});
