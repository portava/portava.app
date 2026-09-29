/**
 * census-discovery §104 (lane W11-X2 round 8; DV-83, §103.11 "possible") — an UNREAD
 * rollout flag on the output-kinds and trending routes is a failed read, never
 * `404 feature_disabled`. Register D-W11X2-56.
 *
 * Both routes read their flags with `isFlagEnabled`, which answers `false` for an
 * error exactly as for an off flag. A timed-out `feature_flags` read therefore
 * answered "these recommendations are not enabled", and Discovery's output-kinds
 * rail hides a 404 exactly as it hides the feature being off: a failed read drawn
 * as an absence. The flags are now read strictly at the route (a literal per read
 * site, recorded in check:flag-polarity's DIRECT_READS). An unread flag answers
 * 503 degraded_unavailable with reason `flag_unreadable`, which the rail already
 * draws as its failed state. A flag that was READ and is off keeps its 404, byte
 * for byte.
 *
 *   FK1   output kinds: the flag read fails → 503 / flag_unreadable, never 404
 *   FK1c  CONTROL: the flag read, and off → the 404 body, byte-identical to an unflagged world
 *   FK2   output kinds: the flag read THROWS → the same 503
 *   FT1   trending explanations: the flag read fails → 503 / flag_unreadable
 *   FT2   trending lists: the flag reads fail → 503 / flag_unreadable
 *   FT2c  CONTROL: trending lists, the flags read and off → 404 feature_disabled
 *
 * CONTROLLED DATA. Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryFlagUnreadable.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import outputKindsRouter from "../routes/discoveryOutputKinds.js";
import trendingRouter from "../routes/discoveryTrending.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { _resetStopConditionsForTest } from "../lib/discoveryStopConditions.js";
import { makeFakeCandidateDb, type Row } from "./helpers/fakeCandidateDb.js";
import { VIEWER, world } from "./helpers/candidateWorld.js";

const TOK = "tok-flag-unreadable";
const asServiceClient = (c: object) => c as unknown as Parameters<typeof _setTestServiceClient>[0];

function serve(w: Record<string, Row[]>, erroring: string[] = [], throwFlags = false) {
  const d = makeFakeCandidateDb(w, { erroring });
  const auth = { getUser: async (t: string) => (t === TOK ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid token" } }) };
  const from = (d as unknown as { from: (t: string) => unknown }).from.bind(d);
  const client = Object.assign(d, {
    auth,
    from: (t: string) => { if (throwFlags && t === "feature_flags") throw new Error("socket hang up"); return from(t); },
  });
  _setTestServiceClient(asServiceClient(client)); _setTestClient(client, true);
}

let server: Server;
let base = "";
before(async () => {
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(outputKindsRouter)
    .use(trendingRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => { _resetStopConditionsForTest(); });

async function get(path: string) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOK}` } });
  return { status: res.status, raw: await res.text() };
}
const KINDS = "/v1/discovery/recommendations/trails?destination=Miami";
const flagless = (): Record<string, Row[]> => { const w = world(); w["feature_flags"] = []; return w; };

function assertUnreadable(r: { status: number; raw: string }) {
  assert.notEqual(r.status, 404, `an unread flag was answered as the feature being off: ${r.raw}`);
  assert.equal(r.status, 503, r.raw);
  assert.match(r.raw, /degraded_unavailable/);
  assert.match(r.raw, /"reason":"flag_unreadable"/);
}

describe("§104 — an unread rollout flag is a failed read, never feature_disabled (DV-83)", () => {
  it("FK1 output kinds: the flag read fails → 503 flag_unreadable, never 404", async () => {
    serve(flagless(), ["feature_flags"]);
    assertUnreadable(await get(KINDS));
  });

  it("FK1c CONTROL output kinds: the flag READ and off → the 404, byte-identical", async () => {
    serve(flagless());
    const off = await get(KINDS);
    assert.equal(off.status, 404);
    assert.match(off.raw, /feature_disabled/);
    serve(flagless());
    assert.equal((await get(KINDS)).raw, off.raw);
  });

  it("FK2 output kinds: the flag read THROWS → the same 503", async () => {
    serve(flagless(), [], true);
    assertUnreadable(await get(KINDS));
  });

  it("FT1 trending explanations: the flag read fails → 503 flag_unreadable", async () => {
    serve(flagless(), ["feature_flags"]);
    assertUnreadable(await get("/v1/discovery/trending/explanations?recommendationIds=a"));
  });

  it("FT2 trending lists: the flag reads fail → 503 flag_unreadable", async () => {
    serve(flagless(), ["feature_flags"]);
    assertUnreadable(await get("/v1/discovery/trending/places?destination=Miami"));
  });

  it("FT2c CONTROL trending lists: the flags READ and off → 404 feature_disabled", async () => {
    serve(flagless());
    const r = await get("/v1/discovery/trending/places?destination=Miami");
    assert.equal(r.status, 404, r.raw);
    assert.match(r.raw, /feature_disabled/);
    const e = await get("/v1/discovery/trending/explanations?recommendationIds=a");
    assert.equal(e.status, 404, e.raw);
  });
});
