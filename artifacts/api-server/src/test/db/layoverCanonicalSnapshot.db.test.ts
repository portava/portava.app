/** B2-RECS-A: canonical snapshots, stale-writer refusal and preserved card evidence on the actual migration chain. */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { PRESSED_BACKEND, PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { lit } from "./postgrestSqlBridge.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
import { canonicalLayoverRecord, canonicalOutcomeOf } from "../../services/layover/LayoverActiveSnapshot.js";
import { readActiveSnapshot } from "../../services/layover/layoverActiveSnapshotRead.js";
import { persistDecision, certifiedComputationRowFor } from "../../services/layover/LayoverDecisionStore.js";
import { replayFeasibility } from "../../services/airport/LayoverFeasibility.js";
import { supersedeCards, storedStatusProjector, recommendationStamp } from "../../services/layover/LayoverRecommendationStatus.js";

let db: PressedDb, app: PressedApp, owner: PressedUser, stranger: PressedUser, sid: string;
const realNow = Date.now;
let now = Math.floor(realNow() / 60_000) * 60_000 + 10_000;
const rows = () => db.query<any>(`SELECT * FROM public.layover_certified_computations WHERE session_id = '${sid}' ORDER BY snapshot_version`);
const active = async () => { const r = await readActiveSnapshot(db.client, sid); assert.ok(r.ok && r.active, JSON.stringify(r)); return r.active; };

describe("B2-RECS-A canonical snapshot real-schema proof", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    Date.now = () => now;
    db = await openPressedLayoverDb();
    await productionBaseFlags(db);
    await db.setFlags({ layover_decision_persistence_enabled: true, layover_canonical_snapshot_enabled: true, layover_recommendation_snapshot_enabled: true, layover_recommendation_status_enabled: true });
    owner = await db.seedUser("canonical_owner"); stranger = await db.seedUser("canonical_stranger");
    app = await startPressedLayoverApp(db);
    sid = (await startSession(app, owner)).id;
  });
  after(async () => { Date.now = realNow; await app?.close(); await db?.close(); });

  it("L6/L175 overview and safety publish the same stored snapshot across different instants", async (t) => {
    const start = performance.now();
    const overview = await app.call("GET", `/api/airport/sessions/${sid}/overview`, owner);
    const firstMs = performance.now() - start;
    assert.equal(overview.status, 200, overview.raw);
    now += 100;
    const startRead = performance.now();
    const safety = await app.call("GET", `/api/airport/sessions/${sid}/safety`, owner);
    assert.equal(safety.status, 200, safety.raw);
    assert.equal(safety.body.snapshotId, overview.body.snapshotId);
    assert.equal(safety.body.persisted.state, "active_snapshot");
    assert.equal((await rows()).length, 1);
    assert.equal((await active()).snapshotId, overview.body.snapshotId);
    t.diagnostic(`overview ${firstMs.toFixed(1)}ms; subsequent safety ${ (performance.now() - startRead).toFixed(1)}ms; one stored computation`);
  });

  it("L20 service-role UPDATE cannot rewrite the parent; owner-only RLS still holds", async () => {
    const a = await active();
    const write = await db.client.from("layover_certified_computations").update({ usable_minutes: 99999 }).eq("snapshot_id", a.snapshotId);
    assert.equal(write.error?.code, "55000");
    assert.match(write.error?.message ?? "", /IMMUTABLE/);
    assert.equal((await db.asUser(owner.id, `SELECT snapshot_id FROM public.layover_certified_computations WHERE session_id='${sid}'`)).length, 1);
    assert.equal((await db.asUser(stranger.id, `SELECT snapshot_id FROM public.layover_certified_computations WHERE session_id='${sid}'`)).length, 0);
  });

  it("L264 two writers read version N; committed writer wins, later stale writer is named and rejected", async (t) => {
    const a = await active();
    // Both reads occur before either write. PGlite serializes transactions: this tests interleaving, not lock contention.
    const expectedA = await active(), expectedB = await active();
    const newer = replayFeasibility({ ...a.record.inputs, nowMs: now + 120_000 });
    const older = replayFeasibility({ ...a.record.inputs, nowMs: now + 60_000 });
    const first = await persistDecision(db.client, owner.id, sid, newer, { canonical: { expectedActive: expectedA } });
    assert.ok(first.ok, JSON.stringify(first));
    const stale = await persistDecision(db.client, owner.id, sid, older, { canonical: { expectedActive: expectedB } });
    assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.reason, "stale_snapshot_write");
    assert.equal((await active()).snapshotId, first.snapshotId);
    assert.equal((await rows()).length, 2);
    t.diagnostic(`backend=${db.backend}; PGlite proves explicit transaction interleaving; separate-process PostgreSQL contention is not exercised here`);
  });

  it("L264 canonical conflict does not retry the old certification against the winner's new version", async () => {
    const before = await active();
    const candidate = replayFeasibility({ ...before.record.inputs, nowMs: now + 180_000 });
    const winner = replayFeasibility({ ...before.record.inputs, nowMs: now + 240_000 });
    const result = await canonicalLayoverRecord(db.client, { id: sid, userId: owner.id }, async () => {
      const won = await persistDecision(db.client, owner.id, sid, winner, { canonical: { expectedActive: before } });
      assert.ok(won.ok, JSON.stringify(won));
      return candidate;
    });
    assert.ok(result);
    assert.equal(canonicalOutcomeOf(result)?.canonical, false);
    assert.equal((await active()).record.inputHash, winner.inputHash);
  });

  it("L264 missing expectation and stale session inputs fail closed in the database", async () => {
    const a = await active();
    const candidate = replayFeasibility({ ...a.record.inputs, nowMs: now + 300_000 });
    const missing = await db.client.from("layover_certified_computations").insert(certifiedComputationRowFor(owner.id, sid, candidate));
    assert.equal(missing.error?.code, "LY428");
    const changed = replayFeasibility({ ...candidate.inputs, session: { ...candidate.inputs.session, checkedBags: !candidate.inputs.session.checkedBags } });
    const stale = await persistDecision(db.client, owner.id, sid, changed, { canonical: { expectedActive: a } });
    assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.reason, "stale_session_inputs");
  });

  it("L264 a legacy writer cannot republish an existing historical snapshot or an older unstored calculation", async () => {
    const history = await rows(), current = await active();
    const existing = replayFeasibility(history[0].inputs);
    const stale = await persistDecision(db.client, owner.id, sid, existing);
    assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.reason, "stale_snapshot_write");
    const unstored = replayFeasibility({ ...existing.inputs, nowMs: existing.inputs.nowMs + 1 });
    const rejected = await persistDecision(db.client, owner.id, sid, unstored);
    assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.reason, "stale_snapshot_write");
    assert.equal((await active()).snapshotId, current.snapshotId);
  });

  it("3873/3896 rollbacks refuse to erase an expectation or remove immutability from stored evidence", async () => {
    await db.setFlag("layover_canonical_snapshot_enabled", false);
    try {
      const rollback = (file: string) => readFileSync(new URL(`../../../../../db/rollback/${file}`, import.meta.url), "utf8");
      // 3908 (route fan-out) depends on 3873's compare-and-swap schema and has no rollback of its own, so 3873 refuses for it FIRST.
      try { await assert.rejects(db.exec(rollback("2026-10-18-3873-layover-active-snapshot-compare-and-swap-rollback.sql")), /later migration 3908 still depends/); }
      finally { await db.exec("ROLLBACK"); }
      // With 3908's objects gone (in this transaction, undone by the ROLLBACK), the data refusals are what stand in the way.
      const without3908 = "BEGIN; DROP TABLE public.layover_route_work, public.layover_route_dispatches CASCADE; DO $d$ DECLARE f regprocedure; BEGIN FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('layover_route_fanout_ready','layover_route_watch_state','layover_route_fanout_claim','layover_route_fanout_retry','layover_route_fanout_settle') LOOP EXECUTE format('DROP FUNCTION %s', f); END LOOP; END $d$;";
      for (const [file, reason, setup] of [["2026-10-18-3873-layover-active-snapshot-compare-and-swap-rollback.sql", /expectation data/, without3908], ["2026-10-18-3896-layover-certified-computations-immutable-rollback.sql", /computation data/, ""]] as const) {
        try { if (setup) await db.exec(setup); await assert.rejects(db.exec(rollback(file)), reason); }
        finally { await db.exec("ROLLBACK"); }
      }
    } finally { await db.setFlag("layover_canonical_snapshot_enabled", true); }
    assert.equal((await rows()).length, 3);
  });

  it("L26/L38/L44/L97 classified card supersession preserves the prior decision and is idempotent", async () => {
    const all = await rows(), current = await active(), id = randomUUID();
    const plan = { snapshotId: all[0].snapshot_id, candidateIds: ["airport-rest"] };
    const inserted = await db.client.from("layover_recommendations").insert({ id, session_id: sid, rec_type: "rest", title: "Rest", inside_airport: true, safety_rating: "safe", snapshot_id: all[0].snapshot_id, plan_json: plan, utility_score: 0.5, risk_band: "LOW", confidence: "HIGH", expires_at: new Date(now + 3_600_000).toISOString(), recommendation_status: "ELIGIBLE" });
    assert.equal(inserted.error, null, JSON.stringify(inserted.error));
    const result = await supersedeCards(db.client, { sessionId: sid, currentSnapshotId: current.snapshotId, cause: "reported_disruption" });
    assert.ok(result.applied, JSON.stringify(result));
    const card = (await db.query<any>(`SELECT * FROM public.layover_recommendations WHERE id='${id}'`))[0];
    assert.equal(card.recommendation_status, "SUPERSEDED");
    assert.equal(card.snapshot_id, all[0].snapshot_id);
    assert.deepEqual(card.plan_json, plan);
    assert.equal(card.superseded_by_snapshot_id, current.snapshotId);
    const history = await db.query<any>(`SELECT * FROM public.layover_recommendation_supersessions WHERE recommendation_id='${id}'`);
    assert.equal(history.length, 1); assert.equal(history[0].card.recommendation_status, "ELIGIBLE");
    assert.equal(history[0].cause, "reported_disruption"); assert.deepEqual(history[0].card.plan_json, plan);
    assert.equal(history[0].superseding_snapshot_version, current.version);
    await supersedeCards(db.client, { sessionId: sid, currentSnapshotId: current.snapshotId, cause: "regeneration" });
    assert.equal((await db.query(`SELECT id FROM public.layover_recommendation_supersessions WHERE recommendation_id='${id}'`)).length, 1);
    await assert.rejects(db.exec(`UPDATE public.layover_recommendation_supersessions SET cause='window_edit' WHERE recommendation_id='${id}'`), /IMMUTABLE/);
    await assert.rejects(db.asUser(owner.id, `SELECT * FROM public.layover_recommendation_supersessions WHERE session_id='${sid}'`), (e: any) => e.code === "42501");
  });

  it("L50 UNSAFE cannot be stored as available and BLOCKED has a non-restricted explanation", async () => {
    const id = randomUUID();
    const base = { id, session_id: sid, rec_type: "rest", title: "Too late", inside_airport: true, safety_rating: "not_recommended", risk_band: "UNSAFE", recommendation_status: "ELIGIBLE" };
    const refused = await db.client.from("layover_recommendations").insert(base);
    assert.equal(refused.error?.code, "23514");
    const inserted = await db.client.from("layover_recommendations").insert({ ...base, recommendation_status: "BLOCKED", status_reason: "unsafe_return_risk" });
    assert.equal(inserted.error, null, JSON.stringify(inserted.error));
    const card = (await db.query<any>(`SELECT * FROM public.layover_recommendations WHERE id='${id}'`))[0];
    const projector = await storedStatusProjector(db.client, sid, [card]);
    assert.deepEqual({ status: projector(card).status, available: projector(card).available }, { status: "BLOCKED", available: false });
    assert.ok(projector(card).statusExplanation);
    await assert.rejects(db.asUser(owner.id, `UPDATE public.layover_recommendations SET recommendation_status='ELIGIBLE',risk_band='LOW' WHERE id='${id}' RETURNING id`), (e: any) => e.code === "42501");
  });

  it("L97 regeneration refuses to overwrite cards when preserving their history fails", async () => {
    const a = await active();
    await db.exec(`INSERT INTO public.layover_recommendations (session_id, rec_type, title, snapshot_id) VALUES ('${sid}', 'rest', 'Old evidence', '${(await rows())[0].snapshot_id}')`);
    const broken = { from: (name: string) => name === "layover_recommendation_supersessions" ? { insert: async () => ({ error: { code: "XX000", message: "injected history failure" } }) } : db.client.from(name) } as any;
    await assert.rejects(recommendationStamp(broken, { id: sid, userId: owner.id }, a.record), /supersession/);
  });

  if (PRESSED_BACKEND === "psql") it("L264 PostgreSQL: two separate connections contend for the lock; the stale writer loses", async () => {
    const a = await active();
    const types = new Map((await db.query<{ column_name: string; udt_name: string }>(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'layover_certified_computations'`)).map((c) => [c.column_name, c.udt_name]));
    const insert = (clock: number) => {
      const record = replayFeasibility({ ...a.record.inputs, nowMs: clock });
      const row = { ...certifiedComputationRowFor(owner.id, sid, record), expected_active_version: a.version };
      const entries = Object.entries(row).filter(([, value]) => value !== undefined);
      return `INSERT INTO public.layover_certified_computations (${entries.map(([key]) => `"${key}"`).join(",")}) VALUES (${entries.map(([key, value]) => value === null ? "NULL" : types.get(key) === "_text" && Array.isArray(value) ? `ARRAY[${value.map((v) => lit(String(v))).join(",")}]::text[]` : typeof value === "object" ? `${lit(JSON.stringify(value))}::jsonb` : lit(String(value))).join(",")});`;
    };
    let ready!: () => void;
    const signalled = new Promise<void>((resolve) => { ready = resolve; });
    const first = concurrentPsql(db.databaseUrl!, `BEGIN; ${insert(now + 600_000)} SELECT 'writer_ready'; SELECT pg_sleep(0.4); COMMIT;`, ready);
    await signalled;
    const second = concurrentPsql(db.databaseUrl!, `BEGIN; ${insert(now + 540_000)} COMMIT;`);
    const [winner, loser] = await Promise.all([first, second]);
    assert.equal(winner.code, 0, winner.stderr);
    assert.notEqual(loser.code, 0); assert.match(loser.stderr, /LY409.*stale_snapshot_write/s);
    assert.equal((await active()).version, a.version + 1);
  });
});

/** A second connection to the handle's OWN database: the isolated clone, not LOCAL_DB_URL's base database. */
function concurrentPsql(url: string, sql: string, ready?: () => void): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", url], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "", stdout = "";
    const timeout = setTimeout(() => { child.kill(); ready?.(); reject(new Error("local PostgreSQL contention test timed out")); }, 15_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); if (stdout.includes("writer_ready")) ready?.(); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timeout); ready?.(); reject(error); });
    child.on("exit", (code) => { clearTimeout(timeout); ready?.(); resolve({ code, stderr }); });
    child.stdin.end(`\\set VERBOSITY verbose\n${sql}`);
  });
}
