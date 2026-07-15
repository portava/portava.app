/**
 * Tests for POST /api/discovery/community — rating bounds validation
 *
 * Uses _setTestClient to inject a fake Supabase service client, bypassing the
 * real DB entirely. No network calls are made.
 *
 * Tests cover:
 *  - rating > 5 returns 400 invalid_payload
 *  - rating < 0 returns 400 invalid_payload
 *  - non-numeric rating string returns 400 invalid_payload
 *  - rating=0 (lower boundary) is accepted and returns 201
 *  - rating=5 (upper boundary) is accepted and returns 201
 *
 * Run: node --import tsx/esm --test src/test/discoveryCommunityRatingBounds.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "community-rating-bounds-test-token";
const USER_ID    = "user-community-rating-bounds-1";

const VALID_BODY = {
  city:       "Lisbon",
  name:       "Pastéis de Belém",
  place_type: "hidden_gem",
  category:   "food",
  lat:        38.6976,
  lng:        -9.2031,
};

// ── Fake client ────────────────────────────────────────────────────────────────

function makeFakeClient() {
  const insertedRow = {
    id:         "place-rating-bounds-1",
    name:       VALID_BODY.name,
    city:       VALID_BODY.city,
    place_type: VALID_BODY.place_type,
    status:     "active",
    created_at: "2025-07-01T00:00:00.000Z",
  };

  function chain() {
    let _singleMode      = false;
    let _maybeSingleMode = false;
    let _isInsert        = false;

    const obj: any = {
      select()      { return obj; },
      insert()      { _isInsert = true; return obj; },
      eq()          { return obj; },
      ilike()       { return obj; },
      limit()       { return obj; },
      single()      { _singleMode = true; return obj; },
      maybeSingle() { _maybeSingleMode = true; return obj; },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    async function resolve(): Promise<{ data: any; error: null }> {
      if (_maybeSingleMode) {
        return { data: null, error: null };
      }
      if (_isInsert) {
        return { data: _singleMode ? insertedRow : [insertedRow], error: null };
      }
      return { data: _singleMode ? insertedRow : [insertedRow], error: null };
    }

    return obj;
  }

  return {
    from(_table: string) { return chain(); },
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) {
          return { data: { user: { id: USER_ID } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function post(url: string, path: string, body: Record<string, unknown>) {
  const res = await fetch(`${url}${path}`, {
    method:  "POST",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${FAKE_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/discovery/community — rating bounds validation", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  // ── rating out of range ───────────────────────────────────────────────────────

  it("returns 400 when rating is greater than 5", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: 5.0001 });
    assert.equal(r.status, 400, `expected 400 for rating=5.0001, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when rating is the smallest IEEE 754 float above 5", async () => {
    // Number.EPSILON is 2^-52 (~2.22e-16) but the ULP of 5 in float64 is 4×Number.EPSILON
    // (2^-50, ~8.88e-16) because 5 = 1.01×2^2 and each mantissa bit at that exponent
    // is worth 2^(2−52) = 2^−50. Adding Number.EPSILON to 5 rounds back to exactly 5
    // (i.e. 5 + Number.EPSILON === 5 is true in JS). The smallest representable value
    // strictly above 5 is 5 + 4*Number.EPSILON, which this test uses to catch any future
    // guard change from `> 5` to `>= 5`.
    const rating = 5 + 4 * Number.EPSILON;
    assert.notEqual(rating, 5, "sanity: 5 + 4*Number.EPSILON must differ from 5 in float64");
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating });
    assert.equal(r.status, 400, `expected 400 for smallest float above 5 (${rating}), got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 for ULP-above-5 constructed via DataView bit-manipulation after JSON round-trip", async () => {
    // Construct the smallest IEEE 754 float64 strictly above 5 by writing 5.0
    // as raw bytes (big-endian: 40 14 00 00 00 00 00 00) and incrementing the
    // last (least-significant mantissa) byte by 1, yielding 40 14 00 00 00 00 00 01.
    // This is equivalent to 5 + 4*Number.EPSILON but avoids any risk of the
    // arithmetic expression being optimised or constant-folded differently across
    // runtimes.
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat64(0, 5.0, /* littleEndian= */ false); // big-endian representation
    view.setUint8(7, view.getUint8(7) + 1);             // increment LSB of mantissa
    const ulpAbove5 = view.getFloat64(0, false);

    // Sanity: the bit manipulation produced a value that is representable and
    // distinct from 5 in float64.
    assert.notEqual(ulpAbove5, 5,
      `sanity: DataView-constructed float must differ from 5.0 (got ${ulpAbove5})`);

    // Sanity: JSON.stringify → JSON.parse must not collapse the ULP back to 5.
    // If it did, the HTTP layer would receive exactly 5 and the guard would
    // (correctly) accept it — making this an invalid test.  On all V8/Node.js
    // versions used in this project the round-trip is lossless.
    const roundTripped = JSON.parse(JSON.stringify(ulpAbove5)) as number;
    assert.notEqual(roundTripped, 5,
      `sanity: JSON round-trip collapsed ${ulpAbove5} back to 5 — test is invalid on this runtime`);

    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: ulpAbove5 });
    assert.equal(r.status, 400,
      `expected 400 for DataView ULP-above-5 (${ulpAbove5}), got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when rating is less than 0", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: -0.0001 });
    assert.equal(r.status, 400, `expected 400 for rating=-0.0001, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when rating is the smallest IEEE 754 float below 0 (-Number.MIN_VALUE)", async () => {
    // Number.MIN_VALUE is the tiniest positive subnormal float64 (~5e-324).
    // Its negation is the closest representable value to 0 that is strictly less
    // than 0. A guard written as `ratingNum < 0` must reject it; this test would
    // catch any future weakening to `<= 0` (which would incorrectly accept it).
    assert.notEqual(-Number.MIN_VALUE, 0, "sanity: -Number.MIN_VALUE must differ from 0 in float64");
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: -Number.MIN_VALUE });
    assert.equal(r.status, 400, `expected 400 for rating=-Number.MIN_VALUE (${-Number.MIN_VALUE}), got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── non-numeric value ─────────────────────────────────────────────────────────

  it("returns 400 when rating is a non-numeric string", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: "not-a-number" });
    assert.equal(r.status, 400, `expected 400 for rating="not-a-number", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── valid boundary values ─────────────────────────────────────────────────────

  it("accepts rating=0 (lower boundary) and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: 0 });
    assert.equal(r.status, 201, `expected 201 for rating=0, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });

  it("accepts rating=5 (upper boundary) and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: 5 });
    assert.equal(r.status, 201, `expected 201 for rating=5, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });

  it("accepts rating=5.0 (float form of upper boundary) and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: 5.0 });
    assert.equal(r.status, 201, `expected 201 for rating=5.0, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });
});
