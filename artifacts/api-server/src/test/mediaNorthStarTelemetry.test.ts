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
import { MEDIA_NORTH_STAR_EVENT_TYPES, MEDIA_SERVER_OUTCOME_SIGNAL_TYPES } from "../lib/mediaAnalytics.js";

const TOKEN = "north-star-token";
const USER_ID = "d0000000-0000-4000-a000-0000000000a7";

interface RecordedEvent { event_type: string; payload: Record<string, unknown> }

let recorded: RecordedEvent[] = [];
let flagEnabled = true;

function makeClient() {
  function builder(table: string) {
    let inserted: any[] | null = null;
    const b: any = {
      select() { return b; },
      insert(row: any) {
        inserted = (Array.isArray(row) ? row : [row]).map((value, index) => ({ id: `event-${recorded.length}-${index}`, ...value }));
        if (table === "media_events") recorded.push(...inserted as RecordedEvent[]);
        return b;
      },
      update() { return b; },
      eq() { return b; },
      maybeSingle() {
        if (table === "feature_flags") {
          return Promise.resolve({ data: { enabled: flagEnabled }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) { return Promise.resolve({ data: inserted ?? [], error: null }).then(onF, onR); },
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
  it("accepts client north-star events but cannot forge server-confirmed arrival or contribution", async () => {
    assert.equal(MEDIA_NORTH_STAR_EVENT_TYPES.length, 8, "§45 defines eight transitions");

    const events = MEDIA_NORTH_STAR_EVENT_TYPES.map((type) => ({
      type,
      payload: { media_id: "m-1", action_id: "add_to_trip", entity_kind: "place", surface: "action_rail" },
    }));
    const r = await postBatch(events);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(
      r.body.accepted, 6,
      "the endpoint must ACCEPT these, not answer ok:true while dropping them",
    );
    await waitForRecords(6);
    assert.deepEqual(
      recorded.map((e) => e.event_type).sort(),
      MEDIA_NORTH_STAR_EVENT_TYPES.filter(type => !MEDIA_SERVER_OUTCOME_SIGNAL_TYPES.includes(type)).sort(),
      "only client-observable north-star events may arrive through the client batch",
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

  it("rejects raw text and coordinate keys before recording any event", async () => {
    const response = await postBatch([{
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
    assert.equal(response.status, 400);
    assert.equal(recorded.length, 0, "unknown fields reject the whole event");
  });

  it("refuses raw errors, spoofed viewers, oversized identifiers and invalid numeric values", async () => {
    for (const payload of [
      { failure_reason: 'draft: meet me at my home address' },
      { viewer_id: USER_ID }, { media_id: 'x'.repeat(129) },
      { watched_ms: -1 }, { completion_fraction: 2 }, { position: 0.5 },
      { place_id: { address: 'private address' } },
    ]) {
      const r = await postBatch([{ type: 'place_open', payload }]);
      assert.equal(r.status, 400, JSON.stringify(payload));
    }
    assert.equal(recorded.length, 0);
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

  it("does not let generic batches bypass bound view admission", async () => {
    const response = await postBatch(["impression", "qualified_view", "completion", "rewatch"].map(type => ({ type, payload: { media_id: "m-1", watched_ms: 20000 } })));
    assert.equal(response.body.accepted, 0);
    assert.equal(response.body.rejected, 4);
    assert.equal(recorded.length, 0);
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
