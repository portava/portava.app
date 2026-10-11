/**
 * census-layover L25 / L64 / L190 / L261 — lane L-DATA (2026-10-10).
 *
 *   L25   the snapshot's per-session `version` (3623 trigger) and snapshot
 *         determinism: the same inputs give the same input_hash and snapshot id.
 *   L64   recommendations cite the stored snapshot they were rated against
 *         (`recommendationSnapshotStamp`, flag `layover_recommendation_snapshot_enabled`).
 *   L190  `diffSnapshots(prevId, nextId)` over STORED snapshots + the owner route.
 *   L261  `compactSessionDecisions` / `runSnapshotCompactionSweep` (flag 3624).
 *
 * fakeLayoverDb models no trigger, FK or unique index; those are asserted on
 * the migration text here and enforced by 3623's own postconditions on apply.
 *
 * Run: node --import tsx/esm --test src/test/layoverSnapshotPersistence.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import {
  certifySessionFeasibility,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "../services/airport/LayoverFeasibility.js";
import { snapshotIdFor } from "../services/airport/layoverLedger.js";
import {
  DECISION_PERSISTENCE_FLAG,
  RECOMMENDATION_SNAPSHOT_FLAG,
  persistDecision,
  recommendationSnapshotStamp,
} from "../services/layover/LayoverDecisionStore.js";
import {
  SNAPSHOT_COMPACTION_FLAG,
  SNAPSHOT_RETENTION_POLICY,
  COMPACTION_SWEEP_ROW_LIMIT,
  compactSessionDecisions,
  diffSnapshots,
  runSnapshotCompactionSweep,
  _resetSnapshotCompactionCursor,
} from "../services/layover/LayoverDecisionService.js";
import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const INTL = { flightType: "international" as const, immigrationRequired: true };

function airport(over: Partial<FeasibilityAirport> = {}): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: true,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    ...over,
  };
}

function session(hours: number, over: Partial<FeasibilitySession> = {}, id = "session-1"): FeasibilitySession {
  return {
    id,
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + hours * HOUR).toISOString(),
    boardingTime: null,
    flightType: "domestic",
    immigrationRequired: false,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
}

function record(hours: number, nowMs = NOW, id = "session-1") {
  return certifySessionFeasibility(airport(), session(hours, INTL, id), { nowMs, liveConditions: null });
}

const flags = (...on: string[]) => on.map((flag) => ({ flag, enabled: true }));
const ledgerTables = ["layover_certified_computations", "layover_time_budgets", "layover_return_plans"];

/** Persist a record as of `nowMs`, with the persistence flag on, into `tables`. */
async function stored(tables: Record<string, any[]>, hours: number, nowMs: number, id = "session-1") {
  const out = await persistDecision(makeLayoverDb(tables) as any, "user-1", id, record(hours, nowMs, id));
  assert.equal(out.ok, true);
  return out.ok ? out.snapshotId : "";
}

// ── L25 — determinism ────────────────────────────────────────────────────────

describe("L25 — a snapshot's identity is a pure function of its inputs", () => {
  it("the same inputs give the same input_hash and the same snapshot id", () => {
    const a = record(6);
    const b = record(6);
    assert.equal(a.inputHash, b.inputHash);
    assert.equal(snapshotIdFor("session-1", a.inputHash), snapshotIdFor("session-1", b.inputHash));
  });

  it("a different instant, a different session or a different window is a different snapshot", () => {
    const base = record(6);
    assert.notEqual(record(6, NOW + 60_000).inputHash, base.inputHash);
    assert.notEqual(record(9).inputHash, base.inputHash);
    assert.notEqual(snapshotIdFor("session-2", base.inputHash), snapshotIdFor("session-1", base.inputHash));
  });

  it("two stores of the same computation write ONE row's worth of identity", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const first = await stored(t, 6, NOW);
    const second = await persistDecision(makeLayoverDb(t) as any, "user-1", "session-1", record(6));
    assert.equal(second.ok && second.state, "already_recorded");
    assert.equal(second.ok && second.snapshotId, first);
    assert.equal(t.layover_certified_computations.length, 1);
  });

  it("3623 numbers snapshots per session in the DATABASE and creates no second snapshot table", () => {
    const sql = readFileSync(new URL("../migrations/3623_layover_snapshot_version_and_recommendation_snapshot.sql", import.meta.url), "utf8");
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(code, /CREATE TABLE/i, "layover_certified_computations IS the snapshot table (2992); no fork");
    assert.match(code, /BEFORE INSERT ON public\.layover_certified_computations/);
    assert.match(code, /pg_advisory_xact_lock/);
    assert.match(code, /COALESCE\(MAX\(c\.snapshot_version\), 0\) \+ 1/);
    assert.match(code, /layover_certcomp_session_version_uidx\s+ON public\.layover_certified_computations\(session_id, snapshot_version\)/);
    assert.match(code, /REFERENCES public\.layover_certified_computations\(snapshot_id\)\s+ON DELETE SET NULL/);
    assert.match(code, /'layover_recommendation_snapshot_enabled',\s+false,/);
    assert.doesNotMatch(code, /\bUPDATE\s+public\.|\bDELETE\s+FROM/i, "additive only: no data rewritten");
  });
});

// ── L64 — the stamp ──────────────────────────────────────────────────────────

describe("L64 — recommendationSnapshotStamp", () => {
  it("OFF (the seed): no stamp, `{}` column, and NO ledger table is touched", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const s = await recommendationSnapshotStamp(makeLayoverDb(t) as any, "user-1", "session-1", record(6));
    assert.equal(s.snapshotId, null);
    assert.deepEqual(s.column, {});
    assert.equal(s.snapshotId === null && s.reason, "stamp_disabled");
    for (const name of ledgerTables) assert.equal((t[name] ?? []).length, 0, `${name} written with the stamp OFF`);
  });

  it("ON but decision persistence OFF: refused, uncited — a card never cites an unstored snapshot", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(RECOMMENDATION_SNAPSHOT_FLAG) };
    const s = await recommendationSnapshotStamp(makeLayoverDb(t) as any, "user-1", "session-1", record(6));
    assert.deepEqual(s.column, {});
    assert.equal(s.snapshotId === null && s.reason, "persistence_disabled");
  });

  it("ON: the computation is stored and the column cites exactly it", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(RECOMMENDATION_SNAPSHOT_FLAG, DECISION_PERSISTENCE_FLAG) };
    const r = record(6);
    const s = await recommendationSnapshotStamp(makeLayoverDb(t) as any, "user-1", "session-1", r);
    assert.equal(s.snapshotId, snapshotIdFor("session-1", r.inputHash));
    assert.deepEqual(s.column, { snapshot_id: s.snapshotId });
    assert.equal(t.layover_certified_computations[0].snapshot_id, s.snapshotId);
  });

  it("ON and the parent write fails: uncited (the FK could never be satisfied)", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(RECOMMENDATION_SNAPSHOT_FLAG, DECISION_PERSISTENCE_FLAG) };
    const db = makeLayoverDb(t, { failures: { "layover_certified_computations:insert": { message: "down" } } }) as any;
    const s = await recommendationSnapshotStamp(db, "user-1", "session-1", record(6));
    assert.deepEqual(s.column, {});
    assert.equal(s.snapshotId === null && s.reason, "write_failed");
  });
});

describe("L64 — generateRecommendations writes the citation on every row", () => {
  const AIRPORT: AirportProfile = {
    id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
    country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
    domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
  };
  function liveSession(): LayoverSession {
    const now = Date.now();
    return {
      id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
      arrivalTime: new Date(now + 5 * 60_000).toISOString(),
      departureTime: new Date(now + 9 * HOUR).toISOString(),
      boardingTime: null, layoverMinutes: 535,
      flightType: "international", immigrationRequired: false, checkedBags: false,
      loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
      manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
      canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    } as LayoverSession;
  }
  const tables = (fl: Array<{ flag: string; enabled: boolean }>): Record<string, any[]> => ({
    feature_flags: fl,
    discovery_places: [
      { id: "place-1", name: "Night Market", place_type: "attraction", category: "food", neighborhood: "Zhongli", blurb: "Snacks", verified: true, city: "Taoyuan", status: "active" },
    ],
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
  });

  it("ON: every row cites the stored snapshot, and the audit event names it", async () => {
    const t = tables(flags(RECOMMENDATION_SNAPSHOT_FLAG, DECISION_PERSISTENCE_FLAG));
    const out = await generateRecommendations(makeLayoverDb(t) as any, AIRPORT, liveSession(), Date.now(), { stableIds: true });
    assert.equal(out.ok, true);
    assert.ok(t.layover_recommendations.length > 0);
    const ids = new Set(t.layover_recommendations.map((r) => r.snapshot_id));
    assert.equal(ids.size, 1, "one request, one certified record, one citation");
    const [id] = [...ids];
    assert.equal(t.layover_certified_computations.length, 1);
    assert.equal(id, t.layover_certified_computations[0].snapshot_id);
    const evt = t.layover_events.find((e) => e.event_type === "recommendation_generated");
    assert.equal(evt?.metadata.snapshotId, id);
    assert.equal(evt?.metadata.inputHash, t.layover_certified_computations[0].input_hash);
  });

  it("OFF (the seed): no row carries the key at all, nothing is stored, and the event is unchanged", async () => {
    for (const stableIds of [true, false]) {
      const t = tables(flags(DECISION_PERSISTENCE_FLAG));
      await generateRecommendations(makeLayoverDb(t) as any, AIRPORT, liveSession(), Date.now(), { stableIds });
      assert.ok(t.layover_recommendations.length > 0);
      for (const row of t.layover_recommendations) assert.ok(!("snapshot_id" in row), "OFF must send the pre-3623 payload");
      assert.equal((t.layover_certified_computations ?? []).length, 0);
      const evt = t.layover_events.find((e) => e.event_type === "recommendation_generated");
      assert.ok(!("snapshotId" in evt!.metadata) && !("snapshotStampRefused" in evt!.metadata));
    }
  });

  it("ON but storage refused: rows are written uncited and the refusal is audited", async () => {
    const t = tables(flags(RECOMMENDATION_SNAPSHOT_FLAG));
    await generateRecommendations(makeLayoverDb(t) as any, AIRPORT, liveSession(), Date.now(), { stableIds: true });
    assert.ok(t.layover_recommendations.length > 0);
    for (const row of t.layover_recommendations) assert.ok(!("snapshot_id" in row));
    const evt = t.layover_events.find((e) => e.event_type === "recommendation_generated");
    assert.equal(evt?.metadata.snapshotStampRefused, "persistence_disabled");
  });
});

// ── L190 — diff(previousSnapshotId, nextSnapshotId) ──────────────────────────

describe("L190 — diffSnapshots over stored snapshots", () => {
  it("diffs two stored snapshots of the session: a shorter window is a material change", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const roomy = await stored(t, 9, NOW);
    const later = await stored(t, 9, NOW + 5 * HOUR);
    const out = await diffSnapshots(makeLayoverDb(t) as any, "session-1", roomy, later);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.diff.previousSnapshotId, roomy);
    assert.equal(out.diff.nextSnapshotId, later);
    assert.ok(out.diff.changed.includes("result.usableMinutes"));
    assert.equal(out.diff.materiallyChanged, true);
  });

  it("a snapshot diffed against itself changes nothing", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const a = await stored(t, 6, NOW);
    const out = await diffSnapshots(makeLayoverDb(t) as any, "session-1", a, a);
    assert.deepEqual(out.ok && out.diff.changed, []);
    assert.equal(out.ok && out.diff.materiallyChanged, false);
  });

  it("another session's snapshot is NOT FOUND, indistinguishable from a missing one", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const mine = await stored(t, 6, NOW);
    const theirs = await stored(t, 6, NOW, "session-2");
    const cross = await diffSnapshots(makeLayoverDb(t) as any, "session-1", mine, theirs);
    const missing = await diffSnapshots(makeLayoverDb(t) as any, "session-1", mine, "snap:" + "0".repeat(32));
    assert.deepEqual(cross, { ok: false, reason: "not_found" });
    assert.deepEqual(missing, cross);
  });

  it("OFF: refuses as not stored and reads no ledger table", async () => {
    const t: Record<string, any[]> = { feature_flags: [] };
    const touched: string[] = [];
    const db = makeLayoverDb(t) as any;
    const spy = { ...db, from: (name: string) => { touched.push(name); return db.from(name); } };
    const out = await diffSnapshots(spy, "session-1", "snap:a", "snap:b");
    assert.deepEqual(out, { ok: false, reason: "persistence_disabled" });
    assert.ok(!touched.includes("layover_certified_computations"));
  });

  it("an unreadable ledger is read_failed, never an empty diff", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const a = await stored(t, 6, NOW);
    const db = makeLayoverDb(t, { failures: { "layover_certified_computations:select": { message: "down" } } }) as any;
    assert.deepEqual(await diffSnapshots(db, "session-1", a, a), { ok: false, reason: "read_failed" });
  });
});

// ── L261 — compaction ────────────────────────────────────────────────────────

describe("L261 — compactSessionDecisions", () => {
  const OLD = NOW - (SNAPSHOT_RETENTION_POLICY.retentionDays + 10) * DAY;

  async function corpus() {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG, SNAPSHOT_COMPACTION_FLAG) };
    const ancient = await stored(t, 9, OLD);
    const older = await stored(t, 9, OLD + HOUR);
    const recent = await stored(t, 9, NOW - HOUR);
    return { t, ancient, older, recent };
  }

  it("ON: records past retention leave WITH their children; the recent one stays", async () => {
    const { t, ancient, older, recent } = await corpus();
    const out = await compactSessionDecisions(makeLayoverDb(t) as any, "session-1", NOW);
    assert.equal(out.ok, true);
    assert.deepEqual([...out.dropped].sort(), [ancient, older].sort());
    for (const name of ledgerTables) {
      assert.deepEqual(t[name].map((r) => r.snapshot_id), [recent], `${name} kept the wrong rows`);
    }
  });

  it("the newest record of a session is kept however old it is", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG, SNAPSHOT_COMPACTION_FLAG) };
    const a = await stored(t, 9, OLD);
    const b = await stored(t, 9, OLD + HOUR);
    const out = await compactSessionDecisions(makeLayoverDb(t) as any, "session-1", NOW);
    assert.deepEqual(out.ok && out.dropped, [a]);
    assert.deepEqual(t.layover_certified_computations.map((r) => r.snapshot_id), [b]);
  });

  it("only THIS session's rows are touched", async () => {
    const { t } = await corpus();
    await stored(t, 9, OLD, "session-2");
    await stored(t, 9, OLD + HOUR, "session-2");
    await compactSessionDecisions(makeLayoverDb(t) as any, "session-1", NOW);
    assert.equal(t.layover_certified_computations.filter((r) => r.session_id === "session-2").length, 2);
  });

  it("OFF (the seed): nothing is read or deleted", async () => {
    const { t } = await corpus();
    t.feature_flags = flags(DECISION_PERSISTENCE_FLAG);
    const out = await compactSessionDecisions(makeLayoverDb(t) as any, "session-1", NOW);
    assert.deepEqual(out, { ok: false, reason: "compaction_disabled", dropped: [] });
    assert.equal(t.layover_certified_computations.length, 3);
  });

  it("an unreadable history deletes NOTHING", async () => {
    const { t } = await corpus();
    const db = makeLayoverDb(t, { failures: { "layover_certified_computations:select": { message: "down" } } }) as any;
    const out = await compactSessionDecisions(db, "session-1", NOW);
    assert.equal(out.ok === false && out.reason, "read_failed");
    for (const name of ledgerTables) assert.equal(t[name].length, 3);
  });

  it("a failed child delete stops before the parent: no budget is left citing a deleted computation", async () => {
    const { t } = await corpus();
    const db = makeLayoverDb(t, { failures: { "layover_return_plans:delete": { message: "down" } } }) as any;
    const out = await compactSessionDecisions(db, "session-1", NOW);
    assert.equal(out.ok === false && out.reason, "delete_failed");
    assert.equal(t.layover_certified_computations.length, 3, "parents kept");
    assert.equal(t.layover_return_plans.length, 3);
  });
});

describe("L261 — runSnapshotCompactionSweep", () => {
  beforeEach(() => _resetSnapshotCompactionCursor());
  const OLD = NOW - (SNAPSHOT_RETENTION_POLICY.retentionDays + 10) * DAY;

  it("OFF: disabled, nothing read", async () => {
    const t: Record<string, any[]> = { feature_flags: [] };
    const out = await runSnapshotCompactionSweep(makeLayoverDb(t) as any, new Date(NOW));
    assert.equal(out.outcome, "disabled");
  });

  it("ON: compacts every session holding a record past retention", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG, SNAPSHOT_COMPACTION_FLAG) };
    for (const id of ["session-1", "session-2"]) {
      await stored(t, 9, OLD, id);
      await stored(t, 9, NOW - HOUR, id);
    }
    const out = await runSnapshotCompactionSweep(makeLayoverDb(t) as any, new Date(NOW));
    assert.deepEqual(out, { outcome: "swept", sessions: 2, dropped: 2, failedSessions: 0 });
    assert.equal(t.layover_certified_computations.length, 2);
  });

  it("a page full of KEPT old rows does not starve the sessions after it", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG, SNAPSHOT_COMPACTION_FLAG) };
    // COMPACTION_SWEEP_ROW_LIMIT stale sessions with ONE old row each (kept forever)…
    for (let i = 0; i < COMPACTION_SWEEP_ROW_LIMIT; i++) await stored(t, 9, OLD + i * 1000, `stale-${i}`);
    // …then one session whose old row CAN go.
    const dropMe = await stored(t, 9, OLD + DAY, "busy");
    await stored(t, 9, NOW - HOUR, "busy");
    const db = makeLayoverDb(t) as any;
    const first = await runSnapshotCompactionSweep(db, new Date(NOW));
    assert.equal(first.dropped, 0);
    const second = await runSnapshotCompactionSweep(db, new Date(NOW));
    assert.equal(second.dropped, 1);
    assert.ok(!t.layover_certified_computations.some((r) => r.snapshot_id === dropMe));
  });

  it("an unreadable due-row page is a failure and deletes nothing", async () => {
    const t: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG, SNAPSHOT_COMPACTION_FLAG) };
    await stored(t, 9, OLD);
    await stored(t, 9, NOW - HOUR);
    const db = makeLayoverDb(t, { failures: { "layover_certified_computations:select": { message: "down" } } }) as any;
    assert.equal((await runSnapshotCompactionSweep(db, new Date(NOW))).outcome, "failed");
    assert.equal(t.layover_certified_computations.length, 2);
  });
});

// ── L190 — the owner route ───────────────────────────────────────────────────

describe("L190 — GET /airport/sessions/:id/decisions/diff", () => {
  let server: http.Server;
  let base: string;
  const TOKEN = "diff-token";
  const USER_ID = "diff-user";

  const get = (path: string): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const url = new URL(path, base);
      const r = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            let p: any;
            try { p = JSON.parse(raw); } catch { p = raw; }
            resolve({ status: res.statusCode ?? 0, body: p });
          });
        },
      );
      r.on("error", reject);
      r.end();
    });

  async function stage(fl: Array<{ flag: string; enabled: boolean }>) {
    const tables: Record<string, any[]> = {
      feature_flags: [{ flag: "airport_mode_enabled", enabled: true }, ...fl],
      airport_profiles: [airportRow()],
      layover_sessions: [
        sessionRow({ user_id: USER_ID, id: "session-1" }),
        sessionRow({ user_id: "someone-else", id: "session-2" }),
      ],
    };
    const ledger: Record<string, any[]> = { feature_flags: flags(DECISION_PERSISTENCE_FLAG) };
    const a = await stored(ledger, 9, NOW);
    const b = await stored(ledger, 9, NOW + 5 * HOUR);
    const other = await stored(ledger, 9, NOW, "session-2");
    for (const name of ledgerTables) tables[name] = ledger[name];
    _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID } }), true);
    return { a, b, other };
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

  it("the owner gets the diff of their two stored snapshots", async () => {
    const { a, b } = await stage(flags(DECISION_PERSISTENCE_FLAG));
    const r = await get(`/api/airport/sessions/session-1/decisions/diff?from=${a}&to=${b}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "stored");
    assert.equal(r.body.diff.previousSnapshotId, a);
    assert.equal(r.body.diff.materiallyChanged, true);
  });

  it("another traveller's snapshot, through the owner's own session, is a 404", async () => {
    const { a, other } = await stage(flags(DECISION_PERSISTENCE_FLAG));
    const r = await get(`/api/airport/sessions/session-1/decisions/diff?from=${a}&to=${other}`);
    assert.equal(r.status, 404);
  });

  it("another traveller's session is a 404", async () => {
    const { other } = await stage(flags(DECISION_PERSISTENCE_FLAG));
    const r = await get(`/api/airport/sessions/session-2/decisions/diff?from=${other}&to=${other}`);
    assert.equal(r.status, 404);
  });

  it("a malformed id is refused before anything is read", async () => {
    await stage(flags(DECISION_PERSISTENCE_FLAG));
    const r = await get(`/api/airport/sessions/session-1/decisions/diff?from=snap:x&to=snap:y`);
    assert.equal(r.status, 400);
  });

  it("persistence OFF: 200 with state not_stored", async () => {
    const { a, b } = await stage([]);
    const r = await get(`/api/airport/sessions/session-1/decisions/diff?from=${a}&to=${b}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "not_stored");
  });
});
