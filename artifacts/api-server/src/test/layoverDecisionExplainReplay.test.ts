/**
 * census-layover L189 / L191 — layover lane 5 (2026-10-18).
 *
 *   L189  `LayoverDecisionService.explain(snapshotId)` → `explainSnapshot`
 *   L191  `LayoverDecisionService.replay(sessionId, engineVersion)` → `replaySessionDecisions`
 *
 * Both read STORED computations (2700 + 2992 + 3792), so both are press-
 * dependent. Each half is pinned:
 *   - persistence ON (the test double carries the ledger): the spec's words are
 *     met — a stored snapshot is explained; a session's stored decisions under
 *     an engine version are replayed and compared column for column;
 *   - persistence OFF / absent / unreadable, or the ledger absent: a named
 *     refusal, NO ledger table touched, and NOTHING written on any path.
 *
 * Stored rows are JSON round-tripped before they are read, as a JSONB column
 * would hand them back — a replay that only matched live objects would be
 * asserting nothing about the database.
 *
 * Run: node --import tsx/esm --test src/test/layoverDecisionExplainReplay.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  certifySessionFeasibility,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "../services/airport/LayoverFeasibility.js";
import { snapshotIdFor } from "../services/airport/layoverLedger.js";
import { LAYOVER_ENGINE_VERSION } from "../services/airport/LayoverSafetyEngine.js";
import { DECISION_PERSISTENCE_FLAG, persistDecision } from "../services/layover/LayoverDecisionStore.js";
import {
  SESSION_REPLAY_LIMIT,
  explainSnapshot,
  replaySessionDecisions,
} from "../services/layover/LayoverDecisionService.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const INTL = { flightType: "international" as const, immigrationRequired: true };

function airport(): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: true,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  };
}

function session(hours: number, id = "session-1"): FeasibilitySession {
  return {
    id,
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + hours * HOUR).toISOString(),
    boardingTime: null,
    checkedBags: false,
    wantsToLeave: true,
    ...INTL,
  } as FeasibilitySession;
}

const record = (hours: number, nowMs = NOW, id = "session-1") =>
  certifySessionFeasibility(airport(), session(hours, id), { nowMs, liveConditions: null });

const flagsOn = () => [{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }];
const LEDGER = ["layover_certified_computations", "layover_time_budgets", "layover_return_plans"];

/** Store records with persistence ON, then hand back the tables as a database would (JSONB round trip). */
async function ledger(entries: Array<{ hours: number; nowMs: number; id?: string }>) {
  const t: Record<string, any[]> = { feature_flags: flagsOn() };
  const ids: string[] = [];
  for (const e of entries) {
    const out = await persistDecision(makeLayoverDb(t) as any, "user-1", e.id ?? "session-1", record(e.hours, e.nowMs, e.id));
    assert.equal(out.ok, true, JSON.stringify(out));
    ids.push(out.ok ? out.snapshotId : "");
  }
  for (const name of LEDGER) t[name] = JSON.parse(JSON.stringify(t[name] ?? []));
  return { t, ids };
}

/** A db whose every `.from()` is recorded, so "nothing touched" is an assertion, not a hope. */
function spied(t: Record<string, any[]>, opts: Parameters<typeof makeLayoverDb>[1] = {}) {
  const db = makeLayoverDb(t, opts) as any;
  const touched: string[] = [];
  return { touched, db: { ...db, from: (name: string) => { touched.push(name); return db.from(name); } } };
}

const frozen = (t: Record<string, any[]>) => JSON.stringify(t);

// ── L189 — explain(snapshotId) ───────────────────────────────────────────────

describe("L189 — explainSnapshot over a STORED snapshot (persistence ON)", () => {
  it("explains exactly what the stored snapshot published: §9 reasons, unknowns, disclaimer, and §20's record", async () => {
    const { t, ids: [snap] } = await ledger([{ hours: 9, nowMs: NOW }]);
    const before = frozen(t);
    const out = await explainSnapshot(makeLayoverDb(t) as any, "session-1", snap);
    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) return;
    const live = record(9, NOW);
    const e = out.explanation;
    assert.equal(e.snapshotId, snap);
    assert.equal(e.snapshotId, snapshotIdFor("session-1", live.inputHash));
    assert.equal(e.sessionId, "session-1");
    assert.deepEqual(e.reasons, live.reasons);
    assert.deepEqual(e.unknowns, live.unknowns);
    assert.equal(e.disclaimer, live.disclaimer);
    assert.deepEqual(e.breakdown, JSON.parse(JSON.stringify(live.deadline.breakdown)));
    assert.equal(e.bufferPercentile, live.inputs.bufferPercentile);
    assert.equal(e.verifiedBy, "replay_match");
    // §20's ten members, the snapshot id among them.
    assert.equal(e.decision.snapshotId, snap);
    assert.equal(e.decision.inputHash, live.inputHash);
    assert.equal(e.decision.result.verdict, live.verdict);
    assert.equal(e.decision.result.hardReturnTime, live.deadline.hardReturnTime.toISOString());
    assert.ok(e.decision.rulesApplied.length > 0);
    assert.equal(frozen(t), before, "explain writes nothing");
  });

  it("two snapshots of one session explain differently — it is the SNAPSHOT that is explained, not a live computation", async () => {
    const { t, ids: [roomy, tight] } = await ledger([{ hours: 9, nowMs: NOW }, { hours: 9, nowMs: NOW + 6 * HOUR }]);
    const a = await explainSnapshot(makeLayoverDb(t) as any, "session-1", roomy);
    const b = await explainSnapshot(makeLayoverDb(t) as any, "session-1", tight);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.explanation.decision.result.usableMinutes, b.explanation.decision.result.usableMinutes);
    assert.deepEqual(b.explanation.reasons, record(9, NOW + 6 * HOUR).reasons);
  });

  it("another session's snapshot is not_found, indistinguishable from a missing one", async () => {
    const { t, ids: [, theirs] } = await ledger([{ hours: 9, nowMs: NOW }, { hours: 9, nowMs: NOW, id: "session-2" }]);
    const cross = await explainSnapshot(makeLayoverDb(t) as any, "session-1", theirs);
    const missing = await explainSnapshot(makeLayoverDb(t) as any, "session-1", "snap:" + "0".repeat(32));
    assert.deepEqual(cross, { ok: false, reason: "not_found", detail: [] });
    assert.deepEqual(missing, cross);
  });

  it("a stored decision that does not follow from its stored inputs is REFUSED, never explained", async () => {
    const { t, ids: [snap] } = await ledger([{ hours: 9, nowMs: NOW }]);
    const row = t.layover_certified_computations[0];
    row.hard_return_time = new Date(Date.parse(row.hard_return_time) + 30 * 60_000).toISOString();
    row.verdict = row.verdict === "no" ? "yes" : "no";
    const out = await explainSnapshot(makeLayoverDb(t) as any, "session-1", snap);
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.reason, "replay_mismatch");
    assert.ok(!out.ok && out.detail.includes("hard_return_time") && out.detail.includes("verdict"), JSON.stringify(out));
  });

  it("a snapshot written by other arithmetic is not_replayable — explaining it with THIS engine would explain a different answer", async () => {
    const { t, ids: [snap] } = await ledger([{ hours: 9, nowMs: NOW }]);
    t.layover_certified_computations[0].engine_version = "1999.01.01-1";
    const out = await explainSnapshot(makeLayoverDb(t) as any, "session-1", snap);
    assert.deepEqual(out, { ok: false, reason: "not_replayable", detail: ["ENGINE_VERSION_CHANGED"] });
  });
});

describe("L189 — explainSnapshot without the press: a named refusal, nothing read, nothing written", () => {
  it("flag ABSENT (production today): persistence_disabled, and no ledger table is touched", async () => {
    const t: Record<string, any[]> = { feature_flags: [] };
    const { db, touched } = spied(t);
    const before = frozen(t);
    assert.deepEqual(await explainSnapshot(db, "session-1", "snap:a"), { ok: false, reason: "persistence_disabled", detail: [] });
    assert.deepEqual(touched, ["feature_flags"]);
    assert.equal(frozen(t), before);
  });

  it("flag OFF: persistence_disabled, and no ledger table is touched", async () => {
    const t: Record<string, any[]> = { feature_flags: [{ flag: DECISION_PERSISTENCE_FLAG, enabled: false }] };
    const { db, touched } = spied(t);
    assert.deepEqual(await explainSnapshot(db, "session-1", "snap:a"), { ok: false, reason: "persistence_disabled", detail: [] });
    assert.deepEqual(touched, ["feature_flags"]);
  });

  it("flag UNREADABLE: flag_unreadable — not 'off' — and no ledger table is touched", async () => {
    const t: Record<string, any[]> = { feature_flags: flagsOn() };
    const { db, touched } = spied(t, { failures: { "feature_flags:select": { message: "down" } } });
    assert.deepEqual(await explainSnapshot(db, "session-1", "snap:a"), { ok: false, reason: "flag_unreadable", detail: [] });
    assert.deepEqual(touched, ["feature_flags"]);
  });

  it("flag ON over a database without the ledger (2700 unapplied): storage_unavailable, not read_failed", async () => {
    const t: Record<string, any[]> = { feature_flags: flagsOn() };
    const db = makeLayoverDb(t, { failures: { "layover_certified_computations:select": { code: "PGRST205", message: "Could not find the table 'public.layover_certified_computations' in the schema cache" } } }) as any;
    assert.deepEqual(await explainSnapshot(db, "session-1", "snap:a"), { ok: false, reason: "storage_unavailable", detail: [] });
    assert.equal((t.layover_certified_computations ?? []).length, 0);
  });

  it("flag ON and the read fails for any other reason: read_failed, never an empty explanation", async () => {
    const { t, ids: [snap] } = await ledger([{ hours: 9, nowMs: NOW }]);
    const db = makeLayoverDb(t, { failures: { "layover_certified_computations:select": { message: "timeout" } } }) as any;
    assert.deepEqual(await explainSnapshot(db, "session-1", snap), { ok: false, reason: "read_failed", detail: [] });
  });
});

// ── L191 — replay(sessionId, engineVersion) ──────────────────────────────────

describe("L191 — replaySessionDecisions over STORED decisions (persistence ON)", () => {
  it("replays every decision the session stored under the engine version, each compared with its stored columns", async () => {
    const { t } = await ledger([
      { hours: 9, nowMs: NOW },
      { hours: 9, nowMs: NOW + HOUR },
      { hours: 9, nowMs: NOW + 2 * HOUR },
      { hours: 9, nowMs: NOW, id: "session-2" },
    ]);
    const before = frozen(t);
    const out = await replaySessionDecisions(makeLayoverDb(t) as any, "session-1", LAYOVER_ENGINE_VERSION);
    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) return;
    assert.equal(out.sessionId, "session-1");
    assert.equal(out.engineVersion, LAYOVER_ENGINE_VERSION);
    assert.equal(out.summary.read, 3, "only THIS session's decisions");
    assert.equal(out.summary.replayed, 3);
    assert.equal(out.summary.matched, 3);
    assert.equal(out.summary.mismatched, 0);
    assert.equal(out.truncated, false);
    assert.ok(out.summary.results.every((r) => r.sessionId === "session-1"));
    assert.equal(frozen(t), before, "replay writes nothing");
  });

  it("a stored decision that no longer follows from its inputs is a MISMATCH that names the field", async () => {
    const { t, ids } = await ledger([{ hours: 9, nowMs: NOW }, { hours: 9, nowMs: NOW + HOUR }]);
    const tampered = t.layover_certified_computations.find((r) => r.snapshot_id === ids[1])!;
    tampered.usable_minutes += 45;
    const out = await replaySessionDecisions(makeLayoverDb(t) as any, "session-1", LAYOVER_ENGINE_VERSION);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.summary.matched, 1);
    assert.equal(out.summary.mismatched, 1);
    const bad = out.summary.results.find((r) => r.status === "mismatch")!;
    assert.equal(bad.snapshotId, ids[1]);
    assert.deepEqual(bad.mismatchedFields, ["usable_minutes"]);
  });

  it("only decisions stored UNDER the requested engine version are read", async () => {
    const { t } = await ledger([{ hours: 9, nowMs: NOW }, { hours: 9, nowMs: NOW + HOUR }]);
    t.layover_certified_computations[0].engine_version = "1999.01.01-1";
    const out = await replaySessionDecisions(makeLayoverDb(t) as any, "session-1", LAYOVER_ENGINE_VERSION);
    assert.ok(out.ok);
    assert.equal(out.ok && out.summary.read, 1);
  });

  it("an engine version that is not the running one is refused BEFORE any ledger read — that question is L241's decision diff", async () => {
    const { t } = await ledger([{ hours: 9, nowMs: NOW }]);
    const { db, touched } = spied(t);
    const out = await replaySessionDecisions(db, "session-1", "1999.01.01-1");
    assert.deepEqual(out, { ok: false, reason: "engine_version_not_running", runningEngineVersion: LAYOVER_ENGINE_VERSION });
    assert.deepEqual(touched, ["feature_flags"]);
  });

  it(`bounded at ${SESSION_REPLAY_LIMIT}: one more stored decision is reported as truncated, not silently dropped`, async () => {
    const entries = Array.from({ length: SESSION_REPLAY_LIMIT + 1 }, (_, i) => ({ hours: 9, nowMs: NOW + i * 60_000 }));
    const { t } = await ledger(entries);
    const out = await replaySessionDecisions(makeLayoverDb(t) as any, "session-1", LAYOVER_ENGINE_VERSION);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.summary.read, SESSION_REPLAY_LIMIT);
    assert.equal(out.truncated, true);
  });
});

describe("L191 — replaySessionDecisions without the press: a named refusal, nothing read, nothing written", () => {
  it("flag ABSENT (production today): persistence_disabled, and no ledger table is touched", async () => {
    const t: Record<string, any[]> = { feature_flags: [] };
    const { db, touched } = spied(t);
    const before = frozen(t);
    assert.deepEqual(await replaySessionDecisions(db, "session-1", LAYOVER_ENGINE_VERSION), { ok: false, reason: "persistence_disabled", runningEngineVersion: LAYOVER_ENGINE_VERSION });
    assert.deepEqual(touched, ["feature_flags"]);
    assert.equal(frozen(t), before);
  });

  it("flag UNREADABLE: flag_unreadable, and no ledger table is touched", async () => {
    const t: Record<string, any[]> = { feature_flags: flagsOn() };
    const { db, touched } = spied(t, { failures: { "feature_flags:select": { message: "down" } } });
    assert.deepEqual(await replaySessionDecisions(db, "session-1", LAYOVER_ENGINE_VERSION), { ok: false, reason: "flag_unreadable", runningEngineVersion: LAYOVER_ENGINE_VERSION });
    assert.deepEqual(touched, ["feature_flags"]);
  });

  it("flag ON over a database without the ledger: storage_unavailable; any other failure: read_failed — never an empty history", async () => {
    const t: Record<string, any[]> = { feature_flags: flagsOn() };
    const absent = makeLayoverDb(t, { failures: { "layover_certified_computations:select": { code: "42P01", message: 'relation "public.layover_certified_computations" does not exist' } } }) as any;
    const down = makeLayoverDb(t, { failures: { "layover_certified_computations:select": { message: "timeout" } } }) as any;
    assert.deepEqual(await replaySessionDecisions(absent, "session-1", LAYOVER_ENGINE_VERSION), { ok: false, reason: "storage_unavailable", runningEngineVersion: LAYOVER_ENGINE_VERSION });
    assert.deepEqual(await replaySessionDecisions(down, "session-1", LAYOVER_ENGINE_VERSION), { ok: false, reason: "read_failed", runningEngineVersion: LAYOVER_ENGINE_VERSION });
  });
});
