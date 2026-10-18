/**
 * census-layover L296 — Appendix C5: "Never certify a recommendation against a
 * snapshot other than the one returned with it." Appendix A names the refusal:
 * RECOMMENDATION_EXPIRED, "Recommendation certified under stale snapshot".
 *
 * WHAT IS PINNED, OVER HTTP, AGAINST THE REAL ROUTER
 *
 *   A. Every response that certifies cards names the snapshot they were
 *      certified under — `GET /:id/recommendations`, on the regenerate path
 *      (safety engine ON, both id paths) and on the stored path (safety engine
 *      OFF), which names the NEWEST GENERATION's snapshot and only when that
 *      generation certified exactly the rows it serves.
 *   B. `POST /:id/stops/from-recommendation` adds a card only when the request
 *      names the snapshot of the session's newest `recommendation_generated`
 *      event AND that generation certified this card as it now stands. Any
 *      other snapshot — none, a stale one, the snapshot GET /:id/safety
 *      published a moment later, garbage — is 409 RECOMMENDATION_EXPIRED and
 *      writes nothing.
 *   C. An unreadable event read is 503, never a pass.
 *   D. A lost `recommendation_generated` event (its insert is non-fatal) fails
 *      CLOSED in BOTH directions: the snapshot the lost generation returned is
 *      refused, and the snapshot before it is refused for any card the lost
 *      generation rewrote.
 *
 * The clock is NOT pinned: `inputHash` contains `nowMs`, so every generation is
 * its own snapshot, which is the property under test. `tick()` waits a few
 * milliseconds between requests so two generations never share an instant.
 *
 * Run: node --import tsx/esm --test src/test/layoverRecommendationSnapshotPairing.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { snapshotIdFor } from "../services/airport/layoverLedger.js";

const TOKEN = "pairing-token";
const USER = "user-1";
const SESSION = "session-1";
const EXPIRED = "Recommendation certified under stale snapshot";
const LOUNGE = "Airport Lounge / Rest Area";

let server: http.Server;
let base = "";

function call(method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(p, base);
    const payload = body === undefined ? "" : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const tick = () => new Promise<void>((r) => setTimeout(r, 6));

interface Staged {
  tables: Record<string, any[]>;
  failures: Record<string, { message: string }>;
}

function stage(opts: { safety?: boolean; stableIds?: boolean; vibes?: string[] } = {}): Staged {
  const flags = [
    { flag: "airport_mode_enabled", enabled: true },
    { flag: "layover_plans_enabled", enabled: true },
  ];
  if (opts.safety !== false) flags.push({ flag: "layover_safety_engine_enabled", enabled: true });
  if (opts.stableIds !== false) flags.push({ flag: "layover_stable_recommendation_ids_enabled", enabled: true });
  const tables: Record<string, any[]> = {
    feature_flags: flags,
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ id: SESSION, user_id: USER, vibe_chips: opts.vibes ?? ["food"] })],
    discovery_places: [],
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
  };
  const failures: Record<string, { message: string }> = {};
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER }, failures }) as any, true);
  return { tables, failures };
}

const recsPath = `/api/airport/sessions/${SESSION}/recommendations`;
const addPath = `/api/airport/sessions/${SESSION}/stops/from-recommendation`;

async function getRecs(): Promise<any> {
  const r = await call("GET", recsPath);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  return r.body;
}

function card(body: any, title = LOUNGE): any {
  const c = (body.recommendations as any[]).find((x) => x.title === title);
  assert.ok(c, `no "${title}" card in ${JSON.stringify((body.recommendations as any[]).map((x) => x.title))}`);
  return c;
}

function generations(t: Staged): any[] {
  return t.tables.layover_events.filter((e) => e.event_type === "recommendation_generated");
}

function assertExpired(r: { status: number; body: any }, t: Staged, what: string): void {
  assert.equal(r.status, 409, `${what}: expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error, "conflict", what);
  assert.equal(r.body.reason, "RECOMMENDATION_EXPIRED", what);
  assert.equal(r.body.message, EXPIRED, what);
  assert.equal(t.tables.layover_plan_stops.length, 0, `${what}: a stop was written under a snapshot the card was not certified under`);
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("A. every response that certifies cards names the snapshot they were certified under", () => {
  it("A1. regenerate path, stable ids: snapshotId is the generation's — snapshotIdFor(session, the event's inputHash)", async () => {
    const t = stage();
    const body = await getRecs();
    const gens = generations(t);
    assert.equal(gens.length, 1, "positive control: one generation, one event");
    assert.match(String(body.snapshotId), /^snap:[0-9a-f]{32}$/, `no snapshot on the response: ${JSON.stringify(Object.keys(body))}`);
    assert.equal(body.snapshotId, snapshotIdFor(SESSION, gens[0].metadata.inputHash));
  });

  it("A2. regenerate path, legacy ids (production's FALSE flag): the cards carry no id, and the snapshot is still named", async () => {
    const t = stage({ stableIds: false });
    const body = await getRecs();
    assert.ok((body.recommendations as any[]).every((c) => c.id === undefined), "legacy path: cards carry no id");
    assert.equal(body.snapshotId, snapshotIdFor(SESSION, generations(t)[0].metadata.inputHash));
  });

  it("A3. two generations are two snapshots (inputHash carries nowMs): the second response names the second", async () => {
    const t = stage();
    const first = await getRecs();
    await tick();
    const second = await getRecs();
    assert.notEqual(first.snapshotId, second.snapshotId);
    assert.equal(second.snapshotId, snapshotIdFor(SESSION, generations(t)[1].metadata.inputHash));
  });

  it("A4. stored path (safety engine OFF): serves the NEWEST GENERATION's snapshot with the rows it certified", async () => {
    const t = stage({ safety: false });
    const first = await getRecs();
    await tick();
    const stored = await getRecs();
    assert.equal(generations(t).length, 1, "the second GET must take the stored path, not regenerate");
    assert.match(String(stored.snapshotId), /^snap:[0-9a-f]{32}$/, "the stored path named no snapshot");
    assert.equal(stored.snapshotId, first.snapshotId);
  });

  it("A5. stored path: rows the newest generation did not certify as they stand are regenerated, not labelled", async () => {
    const t = stage({ safety: false });
    const first = await getRecs();
    // A later writer changed a stored card without a generation event saying so
    // (the lost-event case, or any out-of-band edit). Labelling it with the
    // newest event's snapshot would certify it under a snapshot it was not
    // computed in.
    const row = t.tables.layover_recommendations.find((r) => r.title === LOUNGE)!;
    row.activity_time_min = 95;
    await tick();
    const second = await getRecs();
    const gens = generations(t);
    assert.equal(gens.length, 2, "an unpaired stored set must be regenerated");
    assert.notEqual(second.snapshotId, first.snapshotId);
    assert.equal(second.snapshotId, snapshotIdFor(SESSION, gens[1].metadata.inputHash));
  });

  it("A6. stored path: an unreadable event read is 503, not cards with no snapshot", async () => {
    const t = stage({ safety: false });
    await getRecs();
    t.failures["layover_events:select"] = { message: "layover_events unavailable" };
    const r = await call("GET", recsPath);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
  });
});

describe("B. the add names the generation's snapshot, or it is refused RECOMMENDATION_EXPIRED", () => {
  it("B1. positive control: the snapshot returned with the card adds it", async () => {
    const t = stage();
    const body = await getRecs();
    const r = await call("POST", addPath, { recommendationId: card(body).id, snapshotId: body.snapshotId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(t.tables.layover_plan_stops.length, 1);
    assert.equal(t.tables.layover_plan_stops[0].recommendation_id, card(body).id);
  });

  it("B2. an add that names NO snapshot is refused", async () => {
    const t = stage();
    const body = await getRecs();
    assertExpired(await call("POST", addPath, { recommendationId: card(body).id }), t, "no snapshot");
  });

  it("B3. an add that names a snapshot that is not this session's is refused", async () => {
    const t = stage();
    const body = await getRecs();
    assertExpired(await call("POST", addPath, { recommendationId: card(body).id, snapshotId: "snap:" + "0".repeat(32) }), t, "foreign snapshot");
    assertExpired(await call("POST", addPath, { recommendationId: card(body).id, snapshotId: 42 }), t, "non-string snapshot");
  });

  it("B4. the snapshot of an EARLIER generation is refused once the cards were regenerated — the card id is the same", async () => {
    const t = stage();
    const first = await getRecs();
    await tick();
    const second = await getRecs();
    assert.equal(card(first).id, card(second).id, "positive control: stable ids survive the regeneration");
    assertExpired(await call("POST", addPath, { recommendationId: card(first).id, snapshotId: first.snapshotId }), t, "superseded snapshot");
    const ok = await call("POST", addPath, { recommendationId: card(second).id, snapshotId: second.snapshotId });
    assert.equal(ok.status, 200, `the current snapshot must still add: ${JSON.stringify(ok.body)}`);
  });

  it("B5. the snapshot GET /:id/safety published AFTER the cards is a real snapshot of this session — and not the cards'", async () => {
    const t = stage();
    const body = await getRecs();
    await tick();
    const safety = await call("GET", `/api/airport/sessions/${SESSION}/safety`);
    assert.equal(safety.status, 200, JSON.stringify(safety.body).slice(0, 300));
    assert.match(String(safety.body.snapshotId), /^snap:/);
    assert.notEqual(safety.body.snapshotId, body.snapshotId, "positive control: the safety answer is its own computation");
    assertExpired(await call("POST", addPath, { recommendationId: card(body).id, snapshotId: safety.body.snapshotId }), t, "overview snapshot");
  });

  it("B6. a card the newest generation did not produce is refused under that generation's snapshot", async () => {
    // Generation 1 offers duty-free (the traveller chose "shopping"); generation
    // 2 does not, and its stale-row delete fails (non-fatal), so the row and its
    // id survive. Naming generation 2's snapshot for it would certify it under a
    // computation that never produced it.
    const t = stage({ vibes: ["food", "shopping"] });
    const first = await getRecs();
    const duty = card(first, "Duty-Free & Airport Shops");
    t.tables.layover_sessions[0].vibe_chips = ["food"];
    t.failures["layover_recommendations:delete"] = { message: "delete failed" };
    await tick();
    const second = await getRecs();
    delete t.failures["layover_recommendations:delete"];
    assert.ok(t.tables.layover_recommendations.some((r) => r.id === duty.id), "positive control: the stale row survived");
    assertExpired(await call("POST", addPath, { recommendationId: duty.id, snapshotId: second.snapshotId }), t, "card outside the snapshot");
    const ok = await call("POST", addPath, { recommendationId: card(second).id, snapshotId: second.snapshotId });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it("B7. stored path: the snapshot it served adds a legacy row (no rec_key) it served", async () => {
    const t = stage({ safety: false, stableIds: false });
    await getRecs();
    await tick();
    const stored = await getRecs();
    const lounge = card(stored);
    assert.ok(lounge.id, "positive control: the stored path serves ids");
    const r = await call("POST", addPath, { recommendationId: lounge.id, snapshotId: stored.snapshotId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(t.tables.layover_plan_stops.length, 1);
  });
});

describe("C. an unreadable generation event is 503, never a pass", () => {
  it("C1. the event read fails → 503 degraded_unavailable, retryable, and nothing is written", async () => {
    const t = stage();
    const body = await getRecs();
    t.failures["layover_events:select"] = { message: "layover_events unavailable" };
    const r = await call("POST", addPath, { recommendationId: card(body).id, snapshotId: body.snapshotId });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
    assert.equal(t.tables.layover_plan_stops.length, 0);
  });
});

describe("D. a lost recommendation_generated event fails closed", () => {
  it("D1. the snapshot the lost generation returned cannot add — until the next GET records one", async () => {
    const t = stage();
    await getRecs();
    await tick();
    t.failures["layover_events:insert"] = { message: "events insert failed" };
    const lost = await getRecs();
    delete t.failures["layover_events:insert"];
    assert.equal(generations(t).length, 1, "positive control: the second generation's event was lost");
    assertExpired(await call("POST", addPath, { recommendationId: card(lost).id, snapshotId: lost.snapshotId }), t, "lost generation's snapshot");
    await tick();
    const next = await getRecs();
    const ok = await call("POST", addPath, { recommendationId: card(next).id, snapshotId: next.snapshotId });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it("D2. the snapshot BEFORE a lost generation cannot add a card that generation rewrote", async () => {
    const t = stage();
    const first = await getRecs();
    // The traveller's flights move: every card's certified deadline moves with
    // them. The regeneration rewrites the rows in place (stable ids) and its
    // event is lost, so the newest RECORDED generation is still the first.
    const s = t.tables.layover_sessions[0];
    s.departure_time = new Date(new Date(s.departure_time).getTime() + 90 * 60_000).toISOString();
    s.layover_minutes = Number(s.layover_minutes) + 90;
    t.failures["layover_events:insert"] = { message: "events insert failed" };
    await tick();
    await getRecs();
    delete t.failures["layover_events:insert"];
    const row = t.tables.layover_recommendations.find((r) => r.id === card(first).id)!;
    assert.notEqual(new Date(row.hard_return_time).toISOString(), card(first).hardReturnTime, "positive control: the row was rewritten");
    assertExpired(await call("POST", addPath, { recommendationId: card(first).id, snapshotId: first.snapshotId }), t, "rewritten card under the older snapshot");
  });

  it("D3. control for D2: a lost generation that rewrote nothing leaves the earlier snapshot's cards addable", async () => {
    const t = stage();
    const first = await getRecs();
    t.failures["layover_events:insert"] = { message: "events insert failed" };
    await tick();
    await getRecs();
    delete t.failures["layover_events:insert"];
    const r = await call("POST", addPath, { recommendationId: card(first).id, snapshotId: first.snapshotId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});
