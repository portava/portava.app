/**
 * Media v2 §45 north-star telemetry — the client→server round trip.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * §45 defines success for Media as real-world OUTCOMES (place open, Compass,
 * trip add, plan, correction…), not minutes watched. The client emits exactly
 * those events (features/media/telemetry/mediaTelemetry.ts) and the server type
 * declared them — but POST /api/media/analytics/batch kept its own hand-written
 * allow-list that named none of them, and lib/mediaAnalytics.ts stripped
 * `action_id` and `entity_kind` from the payload. So every north-star event was
 * accepted with `{ ok: true }` and dropped: nothing failed, nothing logged, and
 * the funnel simply read zero. The legacy `place_open` / `add_to_trip` /
 * `directions_tap` events landed, which is what made the gap look like an empty
 * funnel rather than a broken one.
 *
 * The other half of the contract is that accepting these events must NOT relax
 * payload hygiene (§44): opaque ids and coarse enums only — never raw text,
 * never a coordinate. Both halves are asserted here, in the same round trip.
 *
 * Run: node --import tsx/esm --test src/test/mediaNorthStarTelemetry.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import mediaAnalyticsBatchRouter from "../routes/mediaAnalyticsBatch.js";
import { MEDIA_NORTH_STAR_EVENT_TYPES } from "../lib/mediaAnalytics.js";

const TOKEN = "north-star-token";
const USER_ID = "d0000000-0000-4000-a000-0000000000a7";

interface RecordedEvent { event_type: string; payload: Record<string, unknown> }

let recorded: RecordedEvent[] = [];
let flagEnabled = true;

function makeClient() {
  function builder(table: string) {
    const b: any = {
      select() { return b; },
      insert(row: any) {
        if (table === "media_events") recorded.push(row as RecordedEvent);
        return Promise.resolve({ data: row, error: null });
      },
      update() { return b; },
      eq() { return b; },
      maybeSingle() {
        if (table === "feature_flags") {
          return Promise.resolve({ data: { enabled: flagEnabled }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) { return Promise.resolve({ data: [], error: null }).then(onF, onR); },
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: async (t: string) => t === TOKEN
        ? { data: { user: { id: USER_ID } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
    },
  } as any;
}

let server: http.Server;
let base: string;

function postBatch(events: Array<{ type: string; payload?: Record<string, unknown> }>): Promise<{ status: number; body: any }> {
  const payload = Buffer.from(JSON.stringify({ events }));
  return new Promise((resolve, reject) => {
    const url = new URL("/api/media/analytics/batch", base);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "content-length": String(payload.length),
      },
    }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let p: any; try { p = JSON.parse(raw); } catch { p = raw; }
        resolve({ status: res.statusCode ?? 0, body: p });
      });
    });
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

/**
 * recordMediaEvent is deliberately fire-and-forget, so the HTTP response can
 * (and does) return before the insert. Wait for the writes rather than sleeping
 * a fixed amount, so the test is neither flaky nor artificially slow.
 */
async function waitForRecords(count: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (recorded.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", mediaAnalyticsBatchRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});

after(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  recorded = [];
  flagEnabled = true;
  const c = makeClient();
  _setTestClient(c, true);
  _setTestServiceClient(c);
});

describe("POST /api/media/analytics/batch — §45 north-star events", () => {
  it("accepts every north-star event type and writes it to media_events", async () => {
    assert.equal(MEDIA_NORTH_STAR_EVENT_TYPES.length, 8, "§45 defines eight transitions");

    const events = MEDIA_NORTH_STAR_EVENT_TYPES.map((type) => ({
      type,
      payload: { media_id: "m-1", action_id: "add_to_trip", entity_kind: "place", surface: "action_rail" },
    }));
    const r = await postBatch(events);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(
      r.body.accepted, 8,
      "the endpoint must ACCEPT these, not answer ok:true while dropping them",
    );
    await waitForRecords(8);
    assert.deepEqual(
      recorded.map((e) => e.event_type).sort(),
      [...MEDIA_NORTH_STAR_EVENT_TYPES].sort(),
      "every north-star type must reach media_events",
    );
  });

  it("preserves the funnel dimensions the §44/§45 report needs", async () => {
    await postBatch([{
      type: "media_trip_add",
      payload: {
        media_id: "m-42", action_id: "add_to_trip", entity_kind: "place",
        place_id: "p-7", trip_id: "t-9", surface: "action_rail",
      },
    }]);
    await waitForRecords(1);

    assert.equal(recorded.length, 1);
    const p = recorded[0].payload as Record<string, unknown>;
    // Without action_id the funnel cannot say WHICH transition fired; without
    // entity_kind it cannot say what kind of thing was acted on. Both were
    // stripped by the server allow-list.
    assert.equal(p.action_id, "add_to_trip", "action_id must survive the sanitiser");
    assert.equal(p.entity_kind, "place", "entity_kind must survive the sanitiser");
    assert.equal(p.media_id, "m-42");
    assert.equal(p.place_id, "p-7");
    assert.equal(p.trip_id, "t-9");
    assert.equal(p.surface, "action_rail");
    // viewer_id is stamped from the authenticated session, never the client.
    assert.equal(p.viewer_id, USER_ID);
  });

  it("still drops raw text and coordinate keys — hygiene is not relaxed", async () => {
    await postBatch([{
      type: "media_place_open",
      payload: {
        media_id: "m-1", action_id: "show_on_map", entity_kind: "place",
        // Everything below must never reach the row.
        caption: "dinner with Sam at the hidden bar",
        content: "raw note text",
        lat: 37.7749,
        lng: -122.4194,
        latitude: 37.7749,
        longitude: -122.4194,
        raw_coordinates: "37.7749,-122.4194",
        ranking_vector: "[0.1,0.2]",
        token: "secret-token",
      },
    }]);
    await waitForRecords(1);

    assert.equal(recorded.length, 1, "the event itself is still recorded");
    const p = recorded[0].payload as Record<string, unknown>;
    for (const forbidden of [
      "caption", "content", "lat", "lng", "latitude", "longitude",
      "raw_coordinates", "ranking_vector", "token",
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(p, forbidden), false,
        `${forbidden} must never be written to media_events`,
      );
    }
    // The coarse dimensions still came through in the same row.
    assert.equal(p.action_id, "show_on_map");
    assert.equal(p.entity_kind, "place");
  });

  it("remains a CLOSED allow-list — an invented media_* type is not accepted", async () => {
    const r = await postBatch([
      { type: "media_totally_made_up", payload: { media_id: "m-1" } },
      { type: "media_place_open", payload: { media_id: "m-1" } },
    ]);
    assert.equal(r.body.accepted, 1, "only the enumerated type may be accepted");
    await waitForRecords(1);
    assert.deepEqual(recorded.map((e) => e.event_type), ["media_place_open"]);
  });

  it("legacy event types keep working", async () => {
    const r = await postBatch([
      { type: "place_open", payload: { media_id: "m-1" } },
      { type: "add_to_trip", payload: { media_id: "m-1" } },
      { type: "directions_tap", payload: { media_id: "m-1" } },
    ]);
    assert.equal(r.body.accepted, 3);
    await waitForRecords(3);
    assert.equal(recorded.length, 3);
  });
});
