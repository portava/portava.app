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
 *  5. Lead ruling D-67 (2026-10-06): `lat`/`lng` are the place's own
 *     coordinates and the identity anchor. Without them the answer is the
 *     can't-verify one and Foursquare is not asked; given, they must come
 *     together and be valid; a namesake away from them is not verified live.
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
let fsqCalls: string[] = [];

// The place's own coordinates (Lisbon) and a provider record of it ~20 m away.
const LAT = 38.7139;
const LNG = -9.1394;
const HERE = { latitude: 38.7141, longitude: -9.1394 };
const AT = `lat=${LAT}&lng=${LNG}`;

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
      fsqCalls.push(u);
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
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
  fsqCalls = [];
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
      results: [{ fsq_place_id: "abc", name: "Cafe Uno", ...HERE, hours: { open_now: true } }],
    }));
    const { status, body } = await get(`/places/live-status?name=Cafe%20Uno&city=Lisbon&${AT}`);
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
    stubFsq(() => ({ results: [{ fsq_place_id: "abc", name: "Cafe Uno", ...HERE, hours: { open_now: true } }] }));
    const { status, body } = await get(`/places/live-status?name=Cafe%20Uno&${AT}`);
    assert.equal(status, 200);
    const ls = body.liveStatus;
    assert.equal(ls.available, false);
    assert.equal(ls.openNow, null);
    assert.equal(ls.dataNote, CANT_VERIFY_NOTE);
    assert.equal(ls.confidence.sourceClass, "historical");
    // No fabricated live fields
    assert.equal(ls.source, undefined);
    assert.equal(fsqCalls.length, 0, "the outage path, not the missing-anchor path, answered");
  });

  it("keeps openNow null when the source responds without hours (honest unknown)", async () => {
    stubFsq(() => ({ results: [{ fsq_place_id: "xyz", name: "Mystery Bar", ...HERE }] }));
    const { body } = await get(`/places/live-status?name=Mystery%20Bar&${AT}`);
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

describe("GET /api/places/live-status — lead ruling D-67 identity anchor", () => {
  it("passes the given lat/lng to the lookup as its anchor", async () => {
    stubFsq(() => ({ results: [{ fsq_place_id: "abc", name: "Cafe Uno", ...HERE, hours: { open_now: false } }] }));
    const { body } = await get(`/places/live-status?name=Cafe%20Uno&${AT}`);
    assert.equal(body.liveStatus.available, true);
    assert.equal(body.liveStatus.openNow, false);
    assert.equal(fsqCalls.length, 1);
    assert.equal(new URL(fsqCalls[0]!).searchParams.get("ll"), `${LAT},${LNG}`);
  });

  it("without lat/lng answers can't-verify and asks no provider", async () => {
    stubFsq(() => ({ results: [{ fsq_place_id: "abc", name: "Cafe Uno", ...HERE, hours: { open_now: true } }] }));
    const { status, body } = await get("/places/live-status?name=Cafe%20Uno&city=Lisbon");
    assert.equal(status, 200);
    const ls = body.liveStatus;
    assert.equal(ls.available, false);
    assert.equal(ls.openNow, null);
    assert.equal(ls.dataNote, CANT_VERIFY_NOTE);
    assert.equal(ls.confidence.sourceClass, "historical");
    assert.equal(fsqCalls.length, 0, "a name alone is never matched to a provider record");
  });

  it("a same-named record 2 km away is not verified live", async () => {
    stubFsq(() => ({ results: [{ fsq_place_id: "far", name: "Cafe Uno", latitude: LAT + 0.018, longitude: LNG, hours: { open_now: true } }] }));
    const { body } = await get(`/places/live-status?name=Cafe%20Uno&${AT}`);
    assert.equal(body.liveStatus.available, false);
    assert.equal(body.liveStatus.openNow, null);
    assert.equal(body.liveStatus.confidence.sourceClass, "historical");
    assert.equal(fsqCalls.length, 1);
  });

  for (const [label, qs] of [
    ["lat without lng", `lat=${LAT}`],
    ["lng without lat", `lng=${LNG}`],
    ["a non-numeric lat", `lat=abc&lng=${LNG}`],
    ["a trailing-garbage lat", `lat=${LAT}x&lng=${LNG}`],
    ["an empty lng", `lat=${LAT}&lng=`],
    ["an out-of-range lat", `lat=95&lng=${LNG}`],
    ["an out-of-range lng", `lat=${LAT}&lng=-181`],
  ] as const) {
    it(`rejects ${label} with 400 invalid_payload`, async () => {
      const { status, body } = await get(`/places/live-status?name=Cafe%20Uno&${qs}`);
      assert.equal(status, 400);
      assert.equal(body.error, "invalid_payload");
      assert.equal(fsqCalls.length, 0);
    });
  }
});
