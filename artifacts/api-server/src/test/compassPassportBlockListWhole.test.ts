/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the sweep beside the round-23 verifier's B43): GET
 * /compass/recommendations?surface=passport applies the viewer's WHOLE block list.
 *
 * The passport surface re-reads the viewer's block list on every request and drops every candidate authored by someone
 * on it. That re-read is the surface's own filter: it is what hides a person the viewer blocked AFTER the Compass
 * profile's snapshot of the same list was taken. It was one unbounded request, and PostgREST cuts a response at
 * db-max-rows (1000 here) without saying so, so for a viewer with more than 1000 blocks the surface filtered on the
 * first 1000 and recommended a place submitted by someone in the rows past the cut.
 *
 * The double answers the profile's own read with an empty list (the snapshot predates the blocks) and every later read
 * of the viewer's blocks the way PostgREST does: the plain read cut at 1000 with its exact count, the keyed read by
 * `order` / `gt` / `limit`.
 *
 *   PP0  CONTROL: the viewer blocked nobody → the place is recommended
 *   PP0b CONTROL: one block row naming the submitter → the place is not recommended
 *   PP1  1200 blocks, the submitter past the cap → the place is not recommended
 *   PP2  the list is cut and its keyed re-read FAILS → refused `block_check_failed`, never the list filtered on a prefix
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassPassportBlockListWhole.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import compassRouter from "../routes/compass.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearL1Cache } from "../compass/CompassCacheEngine.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const VIEWER = "ab000000-0000-4000-a000-000000000041";
const SUBMITTER = "ab000000-0000-4000-a000-0000000000f1";
const TOKEN = "tok-r24-passport";
const DB_ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const PLACE = { id: "11111111-1111-4111-a111-1111111111f1", city: "Paris", name: "Le Bloque", category: "food", status: "active", rating: 4, created_at: new Date().toISOString(), submitted_by: SUBMITTER, lat: 48.85, lng: 2.35 };
const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** `n` rows of the viewer's blocks in insertion order; the submitter's row at index `at`. */
const blocks = (n: number, at: number) => Array.from({ length: n }, (_, i) => ({ blocker_id: VIEWER, blocked_id: i === at ? SUBMITTER : id(i) }));

interface World { rows: Array<{ blocker_id: string; blocked_id: string }>; keyedFails?: boolean }
/** Reads of the viewer's own blocks (`eq("blocker_id", VIEWER)`) seen so far; the first is the profile's snapshot. */
let viewerBlockReads = 0;
function world(w: World) {
  function builder(table: string) {
    const calls: Record<string, unknown[]> = {};
    const answer = (single: boolean): { data: unknown; error: unknown; count?: number | null } => {
      if (table === "feature_flags" && calls.like) return { data: [{ flag: "COMPASS_ENABLED", enabled: true }, { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true }], error: null };
      if (table === "feature_flags") return { data: null, error: null };
      if (table === "profiles" && calls.select?.[0] === "account_status") return { data: { account_status: "active" }, error: null };
      if (table === "profiles") return { data: single ? { id: VIEWER, account_status: "active" } : [{ id: SUBMITTER, account_status: "active" }], error: null };
      if (table === "user_location_state") return { data: single ? { city: "Paris" } : [], error: null };
      if (table === "discovery_places") return { data: [PLACE], error: null };
      if (table === "blocks" && calls.eq?.[0] === "blocker_id" && calls.eq?.[1] === VIEWER) {
        viewerBlockReads++;
        if (viewerBlockReads === 1) return { data: [], error: null, count: 0 };  // the profile's snapshot, taken before the blocks
        if (!calls.order) return { data: w.rows.slice(0, 1000), error: null, count: w.rows.length };  // the plain read, cut at db-max-rows
        if (w.keyedFails) return { data: null, error: DB_ERR, count: null };
        const after = (calls.gt?.[1] as string | undefined) ?? null;
        const rest = [...w.rows].sort((a, b) => (a.blocked_id < b.blocked_id ? -1 : 1)).filter((r) => after === null || r.blocked_id > after);
        const size = Math.min(Number(calls.limit?.[0] ?? 1000), 1000);
        return { data: rest.slice(0, size), error: null, count: rest.length };
      }
      return { data: single ? null : [], error: null, count: 0 };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(answer(true));
        return (...args: unknown[]) => { calls[prop] = args; return b; };
      },
    });
    return b;
  }
  return {
    auth: { getUser: async (tok: string) => (tok === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app); await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => { _setTestClient(null as any, false); server.close(); });
beforeEach(() => { clearL1Cache(); invalidateFlagsCache(); clearCompassProfileCache(); _resetRateLimit(); viewerBlockReads = 0; });

async function passport(w: World) {
  _setTestClient(world(w) as any, true);
  const r = await fetch(`${base}/compass/recommendations?surface=passport&city=Paris&limit=8`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await r.json() as any;
  return { status: r.status, recommended: JSON.stringify(body.recommendations ?? []).includes(PLACE.id), refusal: body.refusal?.code ?? null, body };
}

describe("census-discovery §123: the passport surface applies the viewer's whole block list", () => {
  it("PP0 CONTROL: the viewer blocked nobody → the place is recommended", async () => {
    const r = await passport({ rows: [] });
    assert.deepEqual({ status: r.status, recommended: r.recommended, refusal: r.refusal }, { status: 200, recommended: true, refusal: null }, JSON.stringify(r.body).slice(0, 300));
  });
  it("PP0b CONTROL: one block row naming the submitter → the place is not recommended", async () => {
    const r = await passport({ rows: blocks(1, 0) });
    assert.deepEqual({ recommended: r.recommended, refusal: r.refusal }, { recommended: false, refusal: null });
  });
  it("PP1 1200 blocks, the submitter past the cap → the place is not recommended", async () => {
    const r = await passport({ rows: blocks(1200, 1100) });
    assert.equal(r.recommended, false, "the passport surface recommended a place submitted by someone the viewer blocked");
    assert.equal(r.refusal, null);
  });
  it("PP2 the list is cut and its keyed re-read FAILS → refused block_check_failed", async () => {
    const r = await passport({ rows: blocks(1200, 1100), keyedFails: true });
    assert.equal(r.recommended, false);
    assert.equal(r.refusal, "block_check_failed", JSON.stringify(r.body).slice(0, 300));
  });
});
