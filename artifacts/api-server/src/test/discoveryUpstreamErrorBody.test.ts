/**
 * census-discovery §102 (DV-83 round 6, lane W11-X2; D-W11X2-39, D-W11X2-45):
 * an upstream that answers HTTP 200 with an error body is a failed read, never
 * a cached "missing". GET /discovery/wikidata/:id (the integrator's break 4) and
 * the Nominatim geocode behind GET /discovery and the counts (this round's sweep).
 *
 * Wikidata's API answers some failures with HTTP 200 and an `error` body (the
 * `maxlag` back-off is the common one). Before §102 the route read that body's
 * absent `entities` as "the entity does not exist", answered the empty
 * enrichment, and cached it for the full 24 h TTL (the verifier's V5-W1 at
 * 0db25c816): one busy moment upstream erased a place's description, Wikipedia
 * link and Commons image for a day.
 *
 *   W1  the verifier's probe: 200 + `error` (maxlag) → 502 upstream_error, and
 *       the next request asks upstream again (nothing cached)
 *   W2  200 with no `entities` object at all → the same
 *   W3  an `error` body is not trusted even beside an entity → 502, not cached
 *   C1  control: an entity Wikidata reports `missing` → the empty enrichment,
 *       cached (a real absence is still an absence)
 *   C2  control: a real entity → its enrichment, cached
 *   N1  Nominatim 200 with an error OBJECT (not the array it answers with) → the
 *       counts refuse as upstream_unavailable, and the next request asks again
 *   NC  control: Nominatim's empty array is "no such place" — the counts' plain empty answer
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryWikidataUpstreamError.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { newWorld, worldClient } from "./helpers/fakeDiscoveryWorld.js";

let upstreamBody: (id: string) => unknown = () => ({});
let upstreamCalls = 0;
let nominatimBody: unknown = [];
let nominatimCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("nominatim.openstreetmap.org")) {
    nominatimCalls += 1;
    return new Response(JSON.stringify(nominatimBody), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (s.includes("overpass-api.de")) return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { "content-type": "application/json" } });
  if (s.includes("wikidata.org")) {
    upstreamCalls += 1;
    const id = new URL(s).searchParams.get("ids") ?? "";
    return new Response(JSON.stringify(upstreamBody(id)), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, init);
}) as typeof globalThis.fetch;

let server: Server;
let base = "";
before(async () => {
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(discoveryRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => { upstreamCalls = 0; nominatimCalls = 0; });

async function get(id: string): Promise<{ status: number; body: any }> {
  const r = await realFetch(`${base}/discovery/wikidata/${id}`);
  return { status: r.status, body: await r.json() };
}

const MAXLAG = { error: { code: "maxlag", info: "Waiting for all: 5.2 seconds lagged.", lag: 5.2 }, servedby: "mw1" };

describe("§102 — a Wikidata failure is an upstream error, never a cached 'missing'", () => {
  it("W1 (the verifier's V5-W1) 200 + error body → 502 upstream_error, not cached", async () => {
    upstreamBody = () => MAXLAG;
    const first = await get("Q9100001");
    assert.equal(first.status, 502, JSON.stringify(first.body));
    assert.equal(first.body.error?.code ?? first.body.code ?? first.body.error, "upstream_error", JSON.stringify(first.body));
    const second = await get("Q9100001");
    assert.equal(second.status, 502);
    assert.equal(upstreamCalls, 2, "the failed read was cached");
  });

  it("W2 200 with no entities object → 502, and the recovered upstream is asked next time", async () => {
    upstreamBody = () => ({ success: 1 });
    assert.equal((await get("Q9100002")).status, 502);
    upstreamBody = (id) => ({ entities: { [id]: { id, descriptions: { en: { value: "a square" } } } } });
    const next = await get("Q9100002");
    assert.equal(next.status, 200);
    assert.equal(next.body.description, "a square");
    assert.equal(upstreamCalls, 2);
  });

  it("W3 an error body is not trusted even beside an entity → 502, not cached", async () => {
    upstreamBody = (id) => ({ ...MAXLAG, entities: { [id]: { id, descriptions: { en: { value: "half an answer" } } } } });
    assert.equal((await get("Q9100005")).status, 502);
    assert.equal((await get("Q9100005")).status, 502);
    assert.equal(upstreamCalls, 2);
  });

  it("C1 control: an entity Wikidata reports missing → the empty enrichment, cached", async () => {
    upstreamBody = (id) => ({ entities: { [id]: { id, missing: "" } } });
    const first = await get("Q9100003");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { description: null, wikipediaUrl: null, commonsImageUrl: null });
    await get("Q9100003");
    assert.equal(upstreamCalls, 1);
  });

  it("C2 control: a real entity → its enrichment, cached", async () => {
    upstreamBody = (id) => ({ entities: { [id]: { id, descriptions: { en: { value: "palace" } }, sitelinks: { enwiki: { title: "Some Palace" } } } } });
    const first = await get("Q9100004");
    assert.equal(first.status, 200);
    assert.equal(first.body.description, "palace");
    assert.equal(first.body.wikipediaUrl, "https://en.wikipedia.org/wiki/Some%20Palace");
    await get("Q9100004");
    assert.equal(upstreamCalls, 1);
  });
});

describe("§102 sweep — a Nominatim 200 carrying an error is an outage, never a cached 'no such place'", () => {
  before(() => { _setTestServiceClient(worldClient(newWorld({ tables: { geocode_cache: [], feature_flags: [] } })) as any); });
  after(() => { _setTestServiceClient(null); });
  it("N1 an error object → the counts refuse upstream_unavailable, and the next request asks Nominatim again", async () => {
    nominatimBody = { error: { code: 503, message: "Service temporarily unavailable" } };
    const first = await realFetch(`${base}/discovery/counts?destination=Errortown-N1`);
    const body: any = await first.json();
    assert.equal(body.refusal?.class, "upstream_unavailable", JSON.stringify(body));
    const second = await realFetch(`${base}/discovery/counts?destination=Errortown-N1`);
    await second.json();
    assert.equal(nominatimCalls, 2, "the failed geocode was cached as 'no such place'");
  });

  it("NC control: Nominatim's empty array is 'no such place' — a plain empty answer, cached", async () => {
    nominatimBody = [];
    const first = await realFetch(`${base}/discovery/counts?destination=Nowhere-NC`);
    const body: any = await first.json();
    assert.equal(body.refusal, undefined, JSON.stringify(body));
    assert.deepEqual(body.counts, {});
    await (await realFetch(`${base}/discovery/counts?destination=Nowhere-NC`)).json();
    assert.equal(nominatimCalls, 1);
  });
});
