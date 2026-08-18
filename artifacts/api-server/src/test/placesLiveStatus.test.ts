/**
 * GET /api/places/live-status — live open-now for Explore / place detail.
 *
 * Verifies the endpoint reuses getLiveVenueStatus and returns the same
 * confidence-labeled liveStatus shape as the Compass get_place_details tool:
 *  1. Source reachable + hours present → available:true, openNow boolean,
 *     verified_live confidence.
 *  2. Source outage → available:false, openNow:null, honest dataNote,
 *     historical confidence — never an invented status.
 *  3. Source responded but no hours data → available:true, openNow:null
 *     (honest unknown).
 *  4. Missing name → 400 invalid_payload.
 *
 * Run: node --import tsx/esm --test src/test/placesLiveStatus.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import placesRouter from "../routes/places.js";
import {
  _setSimulatedOutage,
  _clearLiveCache,
  CANT_VERIFY_NOTE,
} from "../lib/liveIntelligence.js";
import { FOURSQUARE_KEY_VARS, snapshotKeyEnv, restoreKeyEnv, clearKeyEnv, setKeyEnv } from "./helpers/apiKeyEnv.js";

// ── fetch stub (Foursquare only) ──────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fsqResponder: (() => any) | null = null;

function stubFsq(responder: () => any) {
  fsqResponder = responder;
}

const originalFsqEnv = snapshotKeyEnv(FOURSQUARE_KEY_VARS);

let server: Server;
let port = 0;

before(async () => {
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(typeof url === "string" ? url : url?.href ?? url);
    if (u.includes("places-api.foursquare.com")) {
      const body = fsqResponder ? fsqResponder() : { results: [] };
      if (body instanceof Error) throw body;
      return { ok: true, status: 200, json: async () => body } as any;
    }
    return originalFetch(url, init);
  }) as any;

  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = pino({ level: "silent" });
    next();
  });
  app.use(placesRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  port = (server.address() as any).port as number;
});

after(async () => {
  globalThis.fetch = originalFetch;
  restoreKeyEnv(originalFsqEnv);
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  _clearLiveCache();
  _setSimulatedOutage("places_live", false);
  setKeyEnv(FOURSQUARE_KEY_VARS, "test-key");
  fsqResponder = null;
});

afterEach(() => {
  _setSimulatedOutage("places_live", false);
});

async function get(path: string) {
  const res = await originalFetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

describe("GET /api/places/live-status", () => {
  it("returns verified_live openNow when the source has hours data", async () => {
    stubFsq(() => ({
      results: [{ fsq_place_id: "abc", name: "Cafe Uno", hours: { open_now: true } }],
    }));
    const { status, body } = await get("/places/live-status?name=Cafe%20Uno&city=Lisbon");
    assert.equal(status, 200);
    const ls = body.liveStatus;
    assert.equal(ls.available, true);
    assert.equal(ls.openNow, true);
    assert.equal(ls.source, "foursquare");
    assert.equal(typeof ls.checkedAt, "string");
    assert.equal(ls.confidence.sourceClass, "verified_live");
  });

  it("degrades honestly on a source outage — no invented status", async () => {
    _setSimulatedOutage("places_live", true);
    const { status, body } = await get("/places/live-status?name=Cafe%20Uno");
    assert.equal(status, 200);
    const ls = body.liveStatus;
    assert.equal(ls.available, false);
    assert.equal(ls.openNow, null);
    assert.equal(ls.dataNote, CANT_VERIFY_NOTE);
    assert.equal(ls.confidence.sourceClass, "historical");
    // No fabricated live fields
    assert.equal(ls.source, undefined);
  });

  it("keeps openNow null when the source responds without hours (honest unknown)", async () => {
    stubFsq(() => ({ results: [{ fsq_place_id: "xyz", name: "Mystery Bar" }] }));
    const { body } = await get("/places/live-status?name=Mystery%20Bar");
    const ls = body.liveStatus;
    assert.equal(ls.available, true);
    assert.equal(ls.openNow, null);
    assert.equal(ls.confidence.sourceClass, "verified_live");
  });

  it("rejects a missing name with 400 invalid_payload", async () => {
    const { status, body } = await get("/places/live-status?name=");
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });
});
