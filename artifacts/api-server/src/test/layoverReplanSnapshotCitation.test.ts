/**
 * census-layover L207 / L44 — layover lane 5 (2026-10-18).
 *
 *   L207  the replan's §20 DecisionRecord persists its snapshot and CITES the
 *         ledger's snapshotId (it hard-coded `snapshotId: null`).
 *   L44   `* → DISRUPTED`: "invalidate stale recommendations" is APPLIED
 *         server-side on a replan, not only decided.
 *
 * Both are reached from the route a traveller already calls —
 * `PATCH /api/airport/sessions/:id` → `replanAfterSessionEdit` →
 * `recordReplanDecision` — so these cases go through the REAL router. Each half
 * is pinned:
 *   - the press ON in the double (ledger + `layover_decision_persistence_enabled`
 *     for L207; 3623's citation column + `layover_recommendation_snapshot_enabled`
 *     for L44): the spec's words are met;
 *   - the press absent (production today), OFF or UNREADABLE: the record and
 *     the publication are BYTE-IDENTICAL to what the replan computed, nothing is
 *     written, or the refusal is named.
 *
 * Run (loopback): node --import tsx/esm --test src/test/layoverReplanSnapshotCitation.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { snapshotIdFor } from "../services/airport/layoverLedger.js";
import {
  recordReplanDecision,
  replanForWindowChange,
  type LayoverDecisionRecord,
} from "../services/airport/LayoverReplanService.js";
import type { FeasibilityAirport, FeasibilitySession } from "../services/airport/LayoverFeasibility.js";

let server: http.Server;
let base: string;
const TOKEN = "lane5-token";
const USER_ID = "user-1";
const PERSIST = "layover_decision_persistence_enabled";
const STAMP = "layover_recommendation_snapshot_enabled"; const STATUS = "layover_recommendation_status_enabled";

function req(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
    if (payload) headers["content-length"] = Buffer.byteLength(payload).toString();
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function stopRow(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: "stop-1", session_id: "session-1", title: "Old town walk", description: null,
    stop_order: 1, duration_min: 60, travel_min: 20, place_id: null, recommendation_id: null,
    lat: null, lng: null, location_label: null, inside_airport: false, source: "user",
    created_at: new Date().toISOString(),
    ...over,
  };
}

function recRow(id: string, snapshot_id: string | null, session_id = "session-1"): Record<string, any> {
  return { id, session_id, rec_type: "food", title: id, status: "active", snapshot_id, superseded_at: null };
}

function stage(
  flags: Array<{ flag: string; enabled: boolean }>,
  opts: { stops?: Record<string, any>[]; recs?: Record<string, any>[]; failures?: Record<string, { message: string; code?: string }> } = {},
) {
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }, ...flags],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER_ID })],
    layover_events: [],
    layover_plan_stops: opts.stops ?? [],
    layover_recommendations: opts.recs ?? [],
    trip_plan_items: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID }, failures: opts.failures }), true);
  return tables;
}

const shift = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

async function delayDeparture(t: Record<string, any[]>, minutes = 90) {
  const dep = t.layover_sessions[0].departure_time as string;
  const r = await req("PATCH", "/api/airport/sessions/session-1", { departureTime: shift(dep, minutes) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replan?.ran, true, JSON.stringify(r.body.replan));
  const rows = t.layover_events.filter((e) => e.event_type === "session_updated" && e.metadata?.decision);
  assert.equal(rows.length, 1, "exactly one ledger row carries the decision");
  return { body: r.body, decision: rows[0].metadata.decision, published: rows[0].metadata.replan };
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── L207 — the replan's record cites the ledger snapshot ─────────────────────

describe("L207 — the replan path stores its snapshot and cites it (persistence ON)", () => {
  it("all ten §20 members carry real values: snapshotId is the stored computation's, and no unavailable-reason remains", async () => {
    const t = stage([{ flag: PERSIST, enabled: true }]);
    const { body, decision, published } = await delayDeparture(t);

    assert.equal(t.layover_certified_computations.length, 1, "the replan's certified record was stored");
    const stored = t.layover_certified_computations[0];
    assert.equal(decision.snapshotId, snapshotIdFor("session-1", decision.inputHash));
    assert.equal(decision.snapshotId, stored.snapshot_id, "the record cites exactly the stored row");
    assert.equal(stored.input_hash, decision.inputHash);
    assert.ok(!("snapshotUnavailableReason" in decision), JSON.stringify(decision));
    for (const k of ["sessionId", "snapshotId", "engineVersion", "inputHash", "inputFacts", "sourceRefs", "rulesApplied", "result", "reasonCodes", "computedAt"]) {
      assert.ok(decision[k] !== null && decision[k] !== undefined, `member ${k} is empty`);
    }
    assert.equal(published.snapshotPersisted, true);
    assert.equal(published.snapshotId, decision.snapshotId);
    assert.ok(!("snapshotUnavailableReason" in published));
    // The traveller's response carries the same citation.
    assert.equal(body.replan.snapshotPersisted, true);
    assert.equal(body.replan.snapshotId, decision.snapshotId);
    // Its children too: one decision, one budget, one return plan.
    assert.equal(t.layover_time_budgets.length, 1);
    assert.equal(t.layover_return_plans.length, 1);
  });

  it("ON but the ledger write is refused: NO citation — the reason is persistDecision's own, and the edit still commits", async () => {
    const t = stage([{ flag: PERSIST, enabled: true }], { failures: { "layover_certified_computations:insert": { message: "check violation" } } });
    const { decision, published } = await delayDeparture(t);
    assert.equal(decision.snapshotId, null);
    assert.equal(decision.snapshotUnavailableReason, "write_failed");
    assert.equal(published.snapshotPersisted, false);
    assert.equal(published.snapshotUnavailableReason, "write_failed");
    assert.ok(!("snapshotId" in published));
  });
});

describe("L207 — without the press the replan record is byte-identical and nothing is stored", () => {
  for (const [label, flags] of [
    ["ABSENT (production today)", []],
    ["OFF", [{ flag: PERSIST, enabled: false }]],
  ] as Array<[string, Array<{ flag: string; enabled: boolean }>]>) {
    it(`persistence ${label}: snapshotId null with the original reason, no ledger table written`, async () => {
      const t = stage(flags);
      const { decision, published } = await delayDeparture(t);
      assert.equal(decision.snapshotId, null);
      assert.equal(decision.snapshotUnavailableReason, "no_snapshot_storage");
      assert.equal(published.snapshotPersisted, false);
      assert.equal(published.snapshotUnavailableReason, "no_snapshot_storage");
      assert.ok(!("snapshotId" in published) && !("invalidationApplied" in published));
      for (const name of ["layover_certified_computations", "layover_time_budgets", "layover_return_plans"]) {
        assert.equal((t[name] ?? []).length, 0, `${name} written without the press`);
      }
    });
  }
});

// ── direct: byte-identity and the unreadable flag ────────────────────────────

const AIRPORT: FeasibilityAirport = {
  id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: false,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
};
const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const BEFORE: FeasibilitySession = {
  id: "session-1", arrivalTime: new Date(NOW + 5 * 60_000).toISOString(), departureTime: new Date(NOW + 8 * 3_600_000).toISOString(),
  boardingTime: null, flightType: "international", immigrationRequired: true, checkedBags: false, wantsToLeave: true,
} as FeasibilitySession;
const AFTER: FeasibilitySession = { ...BEFORE, departureTime: new Date(NOW + 9.5 * 3_600_000).toISOString() };

function replanned() {
  const r = replanForWindowChange({ airport: AIRPORT, airportRef: "TPE", before: BEFORE, after: AFTER, status: "active", candidates: [], nowMs: NOW });
  assert.equal(r.ran, true);
  if (!r.ran) throw new Error("no replan");
  return r;
}

describe("recordReplanDecision — the production path changes nothing", () => {
  it("flags ABSENT: the ledger row's metadata is deep-equal to what the replan computed, and only feature_flags and layover_events are touched", async () => {
    const r = replanned();
    const expected = JSON.parse(JSON.stringify({ replan: r.publication, decision: r.decision }));
    const t: Record<string, any[]> = { feature_flags: [], layover_events: [] };
    const db = makeLayoverDb(t) as any;
    const touched: string[] = [];
    await recordReplanDecision({ ...db, from: (n: string) => { touched.push(n); return db.from(n); } } as any, USER_ID, r.publication, r.decision);
    assert.equal(t.layover_events.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(t.layover_events[0].metadata)), expected);
    assert.deepEqual([...new Set(touched)].sort(), ["feature_flags", "layover_events"]);
  });

  it("persistence flag UNREADABLE: not stored, and the reason says the flag could not be read — not that storage is off", async () => {
    const r = replanned();
    const t: Record<string, any[]> = { feature_flags: [{ flag: PERSIST, enabled: true }], layover_events: [] };
    await recordReplanDecision(makeLayoverDb(t, { failures: { "feature_flags:select": { message: "down" } } }) as any, USER_ID, r.publication, r.decision);
    const d: LayoverDecisionRecord = t.layover_events[0].metadata.decision;
    assert.equal(d.snapshotId, null);
    assert.equal(d.snapshotUnavailableReason, "persistence_flag_unreadable");
    assert.equal((t.layover_certified_computations ?? []).length, 0);
    assert.deepEqual(t.layover_events[0].metadata.replan.invalidationApplied, { applied: false, reason: "flag_unreadable" });
  });

  it("a decision this module did not produce is never stored: no_certified_record", async () => {
    const r = replanned();
    const forged = JSON.parse(JSON.stringify(r.decision)) as LayoverDecisionRecord;
    const t: Record<string, any[]> = { feature_flags: [{ flag: PERSIST, enabled: true }], layover_events: [] };
    await recordReplanDecision(makeLayoverDb(t) as any, USER_ID, r.publication, forged);
    assert.equal(t.layover_events[0].metadata.decision.snapshotUnavailableReason, "no_certified_record");
    assert.equal((t.layover_certified_computations ?? []).length, 0);
  });
});

// ── L44 — step 6 applied ─────────────────────────────────────────────────────

/** Size a stop so it fits the current window and stops fitting after a 60-minute earlier departure. */
async function fittingStopMinutes(): Promise<number> {
  stage([]);
  const r = await req("GET", "/api/airport/sessions/session-1/overview");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const usable = r.body.window.usableMinutes as number;
  assert.ok(usable > 120, `staged session is too tight to test with: ${usable}`);
  return usable - 25;
}

describe("L44 — a replan invalidates stale and no-longer-feasible cards server-side (3623 + flags ON)", () => {
  it("every card citing another snapshot, and the card behind a stop that no longer fits, keeps its citation and is marked SUPERSEDED; the audit row says which", async () => {
    const duration = await fittingStopMinutes();
    const t = stage(
      [{ flag: PERSIST, enabled: true }, { flag: STAMP, enabled: true }, { flag: STATUS, enabled: true }],
      {
        stops: [stopRow({ travel_min: 10, duration_min: duration, recommendation_id: "rec-planned" })],
        recs: [
          recRow("rec-planned", "snap:old"),
          recRow("rec-other", "snap:old"),
          recRow("rec-uncited", null),
          recRow("rec-elsewhere", "snap:old", "session-2"),
        ],
      },
    );
    const dep = t.layover_sessions[0].departure_time as string;
    const r = await req("PATCH", "/api/airport/sessions/session-1", { departureTime: shift(dep, -60) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.replan.invalidation.noLongerFeasible, ["stop-1"]);

    const byId = Object.fromEntries(t.layover_recommendations.map((x) => [x.id, x]));
    assert.equal(byId["rec-planned"].snapshot_id, "snap:old", "the old decision citation is retained"); assert.equal(byId["rec-planned"].recommendation_status, "SUPERSEDED");
    assert.equal(byId["rec-other"].snapshot_id, "snap:old", "the old decision citation is retained"); assert.equal(byId["rec-other"].recommendation_status, "SUPERSEDED");
    assert.equal(byId["rec-uncited"].snapshot_id, null, "an uncited card stays uncited");
    assert.equal(byId["rec-elsewhere"].snapshot_id, "snap:old", "another session's card is untouched");
    assert.equal(t.layover_recommendations.length, 4, "invalidated, NOT deleted (L97)");
    assert.equal(byId["rec-planned"].status, "active", "invalidation is not the moderation state");
    assert.equal(t.layover_plan_stops.length, 1, "the traveller's plan is untouched");

    const applied = r.body.replan.invalidationApplied;
    const decision = t.layover_events.find((e) => e.metadata?.decision)!.metadata;
    assert.deepEqual(decision.replan.invalidationApplied, applied, "the audit row records what was applied");
    assert.equal(applied.applied, true);
    assert.equal(applied.currentSnapshotId, decision.decision.snapshotId, "stale relative to the snapshot THIS replan stored");
    const uncited = Object.fromEntries(applied.superseded.map((u: any) => [u.recommendationId, u]));
    assert.deepEqual(Object.keys(uncited).sort(), ["rec-other", "rec-planned"]);
    assert.deepEqual(uncited["rec-planned"].why, ["stale_certification", "no_longer_feasible"]);
    assert.deepEqual(uncited["rec-other"].why, ["stale_certification"]);
    assert.equal(uncited["rec-other"].citedSnapshotId, "snap:old");
  });

  it("a card citing the replan's OWN snapshot is kept unless its stop no longer fits", async () => {
    const r = replanned();
    const current = snapshotIdFor("session-1", r.decision.inputHash);
    const t: Record<string, any[]> = {
      feature_flags: [{ flag: STAMP, enabled: true }, { flag: STATUS, enabled: true }, { flag: PERSIST, enabled: true }],
      layover_events: [],
      layover_plan_stops: [],
      layover_recommendations: [recRow("rec-current", current), recRow("rec-stale", "snap:old")],
    };
    await recordReplanDecision(makeLayoverDb(t) as any, USER_ID, r.publication, r.decision);
    assert.equal(t.layover_recommendations[0].snapshot_id, current);
    assert.equal(t.layover_recommendations[1].snapshot_id, "snap:old"); assert.equal(t.layover_recommendations[1].recommendation_status, "SUPERSEDED");
  });

  it("each supersession mark is a compare-and-set: a card re-certified between the read and the write keeps its new citation", async () => {
    const r = replanned();
    const t: Record<string, any[]> = {
      feature_flags: [{ flag: STAMP, enabled: true }, { flag: STATUS, enabled: true }, { flag: PERSIST, enabled: true }],
      layover_events: [],
      layover_plan_stops: [],
      layover_recommendations: [recRow("rec-a", "snap:old"), recRow("rec-b", "snap:old")],
    };
    const inner = makeLayoverDb(t) as any;
    const racing = {
      ...inner,
      from: (name: string) => {
        const b = inner.from(name);
        if (name === "layover_recommendations") {
          const update = b.update;
          b.update = (patch: any) => { t.layover_recommendations[1].snapshot_id = "snap:recertified"; return update(patch); };
        }
        return b;
      },
    };
    await recordReplanDecision(racing as any, USER_ID, r.publication, r.decision);
    assert.equal(t.layover_recommendations[0].snapshot_id, "snap:old"); assert.equal(t.layover_recommendations[0].recommendation_status, "SUPERSEDED");
    assert.equal(t.layover_recommendations[1].snapshot_id, "snap:recertified");
  });
});

describe("L44 — without the press nothing is invalidated, and every refusal is named", () => {
  it("stamp flag ABSENT (production today): every citation stands and the publication carries no invalidationApplied", async () => {
    const duration = await fittingStopMinutes();
    const t = stage([], {
      stops: [stopRow({ travel_min: 10, duration_min: duration, recommendation_id: "rec-planned" })],
      recs: [recRow("rec-planned", "snap:old"), recRow("rec-other", "snap:old")],
    });
    const dep = t.layover_sessions[0].departure_time as string;
    const r = await req("PATCH", "/api/airport/sessions/session-1", { departureTime: shift(dep, -60) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.replan.invalidation.noLongerFeasible, ["stop-1"], "step 6 still DECIDES");
    assert.ok(!("invalidationApplied" in r.body.replan));
    assert.deepEqual(t.layover_recommendations.map((x) => x.snapshot_id), ["snap:old", "snap:old"]);
  });

  it("stamp flag OFF: same — decided, not applied", async () => {
    const r = replanned();
    const t: Record<string, any[]> = { feature_flags: [{ flag: STAMP, enabled: false }], layover_events: [], layover_recommendations: [recRow("rec-a", "snap:old")] };
    await recordReplanDecision(makeLayoverDb(t) as any, USER_ID, r.publication, r.decision);
    assert.equal(t.layover_recommendations[0].snapshot_id, "snap:old");
    assert.ok(!("invalidationApplied" in t.layover_events[0].metadata.replan));
  });

  it("3623's column absent (flag seeded by hand without the migration): storage_unavailable, nothing written", async () => {
    const r = replanned();
    const t: Record<string, any[]> = { feature_flags: [{ flag: STAMP, enabled: true }, { flag: STATUS, enabled: true }, { flag: PERSIST, enabled: true }], layover_events: [], layover_recommendations: [recRow("rec-a", "snap:old")] };
    await recordReplanDecision(
      makeLayoverDb(t, { failures: { "layover_recommendations:select": { code: "42703", message: "column layover_recommendations.snapshot_id does not exist" } } }) as any,
      USER_ID, r.publication, r.decision,
    );
    assert.deepEqual(t.layover_events[0].metadata.replan.invalidationApplied, { applied: false, reason: "storage_unavailable" });
    assert.equal(t.layover_recommendations[0].snapshot_id, "snap:old");
  });

  it("the mark is refused: write_failed names preserved history whose card remains unmarked", async () => {
    const r = replanned();
    const t: Record<string, any[]> = { feature_flags: [{ flag: STAMP, enabled: true }, { flag: STATUS, enabled: true }, { flag: PERSIST, enabled: true }], layover_events: [], layover_recommendations: [recRow("rec-a", "snap:old")] };
    await recordReplanDecision(
      makeLayoverDb(t, { failures: { "layover_recommendations:update": { message: "permission denied" } } }) as any,
      USER_ID, r.publication, r.decision,
    );
    assert.deepEqual(t.layover_events[0].metadata.replan.invalidationApplied, { applied: false, reason: "write_failed", historyRecordedButUnmarked: ["rec-a"] });
    assert.equal(t.layover_recommendations[0].snapshot_id, "snap:old");
  });

  it("the plan stops cannot be read: read_failed, nothing written", async () => {
    const r = replanned();
    r.publication.invalidation.noLongerFeasible = ["stop-1"];
    const t: Record<string, any[]> = { feature_flags: [{ flag: STAMP, enabled: true }, { flag: STATUS, enabled: true }, { flag: PERSIST, enabled: true }], layover_events: [], layover_recommendations: [recRow("rec-a", "snap:old")] };
    await recordReplanDecision(
      makeLayoverDb(t, { failures: { "layover_plan_stops:select": { message: "down" } } }) as any,
      USER_ID, r.publication, r.decision,
    );
    assert.deepEqual(t.layover_events[0].metadata.replan.invalidationApplied, { applied: false, reason: "read_failed" });
    assert.equal(t.layover_recommendations[0].snapshot_id, "snap:old");
  });
});
