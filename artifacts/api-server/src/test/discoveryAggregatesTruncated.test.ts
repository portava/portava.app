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
 *
 * §111 (round 14): V13-AK37, V13-AK41 (the verifier's kills for X37, X41), and B7 — V13-AM0..2, AM1b, AM3, AM4, AMc
 * (a failed sibling read's count is null, never 0; D-W11X2-114), and AM5, AM6 (a generated row: absent, never 0).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { batchFetchVoteAndRatingAggregates } from "../lib/discoveryPlaceAggregates.js";
import { materialiseCandidates } from "../lib/discoveryCandidates/materialize.js";
import { makeFakeCandidateDb } from "./helpers/fakeCandidateDb.js";
import { P as CP, VIEWER as CVIEWER, world as candidateWorld } from "./helpers/candidateWorld.js";
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

// ── census-discovery §111 (DV-83 round 14, lane W11-X2): the round-13 verifier's kills and B7 ──
// V13-AK37 / V13-AK41 pin X37 (`count <= rows + 1`) and X41 (the Hidden Gems copy's reviews read unguarded).
// B7 (D-W11X2-114; D-W11X2-103's "states no count" corrected): whichever loop ran first created the entry
// `{ worthItCount: 0, avgRating: null, reviewCount: 0 }`, so the OTHER read's failed or cut count was served as
// 0. Each field now starts null and is set only from its own complete read.
describe("v13: kills for the aggregate survivors (§111)", () => {
  it("V13-AK37 votes cut one row short of the count (1000 of 1001) → no worth-it count stated", async () => {
    const agg = await batchFetchVoteAndRatingAggregates(client(1001, 0), [PLACE], "place");
    assert.notEqual(agg.get(PLACE)?.worthItCount, MAX_ROWS, JSON.stringify(agg.get(PLACE)));
  });
  it("V13-AK41 GET /hidden-gems?submittedBy=… over a cut REVIEWS read → no review count of 1000", async () => {
    const gem = { id: PLACE, submitted_by: "g", status: "active", created_at: new Date().toISOString(), city: "Paris", name: "Gem" };
    const c = client(0, 1200, { hidden_gems: [gem] });
    _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const r = await fetch(`${base}/hidden-gems?submittedBy=g`, { headers: { Authorization: "Bearer t" } });
    const body = await r.json() as any;
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.notEqual(body.gems?.[0]?.reviewCount, MAX_ROWS, JSON.stringify(body.gems?.[0]));
  });
});

const AM_ERR = { code: "57014", message: "canceling statement due to statement timeout" };
function amClient(fail: { votes?: boolean; reviews?: boolean }, extra: Record<string, any[]> = {}) {
  const b = (table: string): any => {
    const answer = (single: boolean) => {
      if (table === "feature_flags") return { data: single ? { enabled: true } : [{ enabled: true }], error: null };
      if (table === "profiles" && single) return { data: { id: "v", account_status: "active" }, error: null };
      if (table === "place_votes") return fail.votes ? { data: null, error: AM_ERR, count: null } : { data: [{ entity_id: PLACE, vote: "worth_it" }], error: null, count: 1 };
      if (table === "reviews") return fail.reviews ? { data: null, error: AM_ERR, count: null } : { data: [{ entity_id: PLACE, rating: 4 }, { entity_id: PLACE, rating: 5 }], error: null, count: 2 };
      const rows = extra[table] ?? [];
      return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      return () => p;
    } });
    return p;
  };
  return { auth: { getUser: async () => ({ data: { user: { id: "v" } }, error: null }) }, from: b, rpc: () => Promise.resolve({ data: [], error: null }) } as any;
}
describe("v13b: a place's vote and review counts over one failed read (§111, D-W11X2-114)", () => {
  it("V13-AM0 CONTROL: both reads healthy → the measured counts", async () => {
    const a = (await batchFetchVoteAndRatingAggregates(amClient({}), [PLACE], "place")).get(PLACE);
    assert.deepEqual(a, { worthItCount: 1, avgRating: 4.5, reviewCount: 2 });
  });
  it("V13-AM1 votes healthy, the reviews read fails → reviewCount is not stated as 0", async () => {
    const a = (await batchFetchVoteAndRatingAggregates(amClient({ reviews: true }), [PLACE], "place")).get(PLACE);
    assert.ok(!(a && a.reviewCount === 0), `a failed reviews read served as a count of 0: ${JSON.stringify(a)}`);
  });
  it("V13-AM2 reviews healthy, the votes read fails → worthItCount is not stated as 0", async () => {
    const a = (await batchFetchVoteAndRatingAggregates(amClient({ votes: true }), [PLACE], "place")).get(PLACE);
    assert.ok(!(a && a.worthItCount === 0), `a failed votes read served as a count of 0: ${JSON.stringify(a)}`);
  });
  it("AM1b the same, exactly: the failed field is null and the read one keeps its count", async () => {
    assert.deepEqual((await batchFetchVoteAndRatingAggregates(amClient({ reviews: true }), [PLACE], "place")).get(PLACE), { worthItCount: 1, avgRating: null, reviewCount: null });
    assert.deepEqual((await batchFetchVoteAndRatingAggregates(amClient({ votes: true }), [PLACE], "place")).get(PLACE), { worthItCount: null, avgRating: 4.5, reviewCount: 2 });
  });
  it("AM3 GET /hidden-gems?submittedBy=…: the reviews read fails → the gem carries no reviewCount of 0; its worth-it count stands", async () => {
    const gem = { id: PLACE, submitted_by: "g", status: "active", created_at: new Date().toISOString(), city: "Paris", name: "Gem" };
    const c = amClient({ reviews: true }, { hidden_gems: [gem] });
    _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const body = await (await fetch(`${base}/hidden-gems?submittedBy=g`, { headers: { Authorization: "Bearer t" } })).json() as any;
    assert.notEqual(body.gems?.[0]?.reviewCount, 0, JSON.stringify(body.gems?.[0]));
    assert.equal(body.gems?.[0]?.worthItCount, 1, JSON.stringify(body.gems?.[0]));
  });
  it("AM4 GET /hidden-gems?submittedBy=…: the votes read fails → the gem carries no worthItCount of 0; its review count stands", async () => {
    const gem = { id: PLACE, submitted_by: "g", status: "active", created_at: new Date().toISOString(), city: "Paris", name: "Gem" };
    const c = amClient({ votes: true }, { hidden_gems: [gem] });
    _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const body = await (await fetch(`${base}/hidden-gems?submittedBy=g`, { headers: { Authorization: "Bearer t" } })).json() as any;
    assert.notEqual(body.gems?.[0]?.worthItCount, 0, JSON.stringify(body.gems?.[0]));
    assert.equal(body.gems?.[0]?.reviewCount, 2, JSON.stringify(body.gems?.[0]));
  });
  it("AMc CONTROL: a place with votes and a COMPLETE, empty reviews read → reviewCount 0 is a fact and stays", async () => {
    const c = amClient({});
    const orig = c.from; c.from = (t: string) => (t === "reviews" ? new Proxy({}, { get(_t, k: string) { if (k === "then") return (f: any, r: any) => Promise.resolve({ data: [], error: null, count: 0 }).then(f, r); return () => c.from("reviews"); } }) : orig(t));
    assert.deepEqual((await batchFetchVoteAndRatingAggregates(c, [PLACE], "place")).get(PLACE), { worthItCount: 1, avgRating: null, reviewCount: 0 });
  });
});

describe("a generated Discovery row over one failed aggregate read (§111, D-W11X2-114)", () => {
  it("AM5 the reviews read fails → the generated row states its worth-it count and no review count (never 0)", async () => {
    const w = candidateWorld();
    w["place_votes"] = [{ entity_type: "place", entity_id: CP.FOLLOWED, vote: "worth_it" }, { entity_type: "place", entity_id: CP.FOLLOWED, vote: "worth_it" }];
    const db = makeFakeCandidateDb(w);
    const from = db.from.bind(db);
    const failing: any = new Proxy({}, { get(_t, k: string) { if (k === "then") return (f: any, r: any) => Promise.resolve({ data: null, error: AM_ERR, count: null }).then(f, r); return () => failing; } });
    (db as { from: (t: string) => unknown }).from = (t: string) => (t === "reviews" ? failing : from(t));
    const out = await materialiseCandidates(db, [`db/${CP.FOLLOWED}`], { viewerId: CVIEWER, cityPrefix: "miami", admitted: null });
    const f = out.rows.get(`db/${CP.FOLLOWED}`)!;
    assert.equal(f.worthItCount, 2, JSON.stringify(f));
    assert.equal(f.reviewCount, undefined, JSON.stringify(f));
    assert.equal(JSON.parse(JSON.stringify(f)).reviewCount, undefined, "not on the wire");
  });
  it("AM6 the votes read fails → the generated row states its review count and no worth-it count (never 0)", async () => {
    const w = candidateWorld();
    w["reviews"] = [{ entity_type: "place", entity_id: CP.FOLLOWED, rating: 4, state: "published" }];
    const db = makeFakeCandidateDb(w);
    const from = db.from.bind(db);
    const failing: any = new Proxy({}, { get(_t, k: string) { if (k === "then") return (f: any, r: any) => Promise.resolve({ data: null, error: AM_ERR, count: null }).then(f, r); return () => failing; } });
    (db as { from: (t: string) => unknown }).from = (t: string) => (t === "place_votes" ? failing : from(t));
    const out = await materialiseCandidates(db, [`db/${CP.FOLLOWED}`], { viewerId: CVIEWER, cityPrefix: "miami", admitted: null });
    const f = out.rows.get(`db/${CP.FOLLOWED}`)!;
    assert.equal(f.reviewCount, 1, JSON.stringify(f));
    assert.equal(f.worthItCount, undefined, JSON.stringify(f));
  });
});
