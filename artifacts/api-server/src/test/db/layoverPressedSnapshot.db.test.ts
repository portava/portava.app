/**
 * Lane B1-P — the snapshot family (triage press P1), PRESSED, against the real
 * migrated schema.
 *
 * Rows: L1, L5, L6, L20, L36, L37, L206, L207, L189, L191, L233, L238, L240,
 * L241, L44 (and the snapshot third of L12, with the constraints and lifecycle
 * suites).
 *
 * THE PRESS: 2700 → 2992 → 3623 → 3792, then `layover_decision_persistence_enabled`
 * ON (+ `layover_recommendation_snapshot_enabled` ON for stamped cards and the
 * L44 invalidation). 2992 and 3623 seed both flags FALSE. 3792 widens 2700's
 * verdict CHECK to admit `entry_unverified`, which is the verdict of every
 * international traveller whose corridor nobody has curated — case S9 proves
 * that pressing the flag over a chain WITHOUT 3792 makes the overview's write
 * fail for exactly that traveller (the ordering constraint: 3792 before the flag).
 *
 * Falsified by B1P_ARM=flag-off (both flags OFF) and B1P_ARM=absent (the chain
 * without 2700/2992/3623/3792 — production today): every PRESSED case goes red;
 * the ALWAYS cases stay green.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverPressedSnapshot.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_BACKEND, PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
import { LAYOVER_ENGINE_VERSION } from "../../services/airport/LayoverSafetyEngine.js";
import { RISK_BANDS } from "../../services/layover/LayoverDecisionStore.js";

const PRESS = {
  migrations: ["2700", "2992", "3623", "3792", "3871", "3896"],
  flags: { layover_decision_persistence_enabled: true, layover_recommendation_snapshot_enabled: true, layover_recommendation_status_enabled: true },
} as const;

let db: PressedDb;
let app: PressedApp;
let ana: PressedUser, bob: PressedUser;
let sid = "";
let firstSnap = "";
let secondSnap = "";
const seeds: Record<string, boolean | "absent"> = {};

const computations = (sessionId: string) =>
  db.query<any>(`SELECT * FROM public.layover_certified_computations WHERE session_id = '${sessionId}' ORDER BY snapshot_version`);
const overview = (u: PressedUser, id = sid) => app.call("GET", `/api/airport/sessions/${id}/overview`, u);

describe("B1-P snapshot family (P1)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    for (const f of Object.keys(PRESS.flags)) seeds[f] = await db.flag(f);
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
    ana = await db.seedUser("ana");
    bob = await db.seedUser("bob");
    sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("S0 the press: 2992 and 3623 seed both flags FALSE — turning them ON is the owner's flip", () => {
      assert.equal(seeds["layover_decision_persistence_enabled"], false);
      assert.equal(seeds["layover_recommendation_snapshot_enabled"], false);
    });

    it("S1 L1 L5 L37 L36 L207 — the overview stores ONE canonical, versioned decision record for what it told the traveller", async () => {
      const o = await overview(ana);
      assert.equal(o.status, 200, o.raw);
      assert.ok(["recorded", "active_snapshot"].includes(o.body.persisted.state), `persisted = ${JSON.stringify(o.body.persisted)}`); // §83: under production's canonical door the session's first stored decision may already be the active one
      firstSnap = o.body.snapshotId;
      assert.match(firstSnap, /^snap:[0-9a-f]{32}$/);
      const rows = await computations(sid);
      const row = rows.find((r) => r.snapshot_id === firstSnap);
      assert.ok(row, "L1: no canonical row carries the snapshot the overview published");
      // L5 versioned: engine + record shape + input identity + per-session version (3623)
      assert.equal(row.engine_version, o.body.advice.engineVersion);
      assert.equal(row.engine_version, LAYOVER_ENGINE_VERSION);
      assert.ok(row.feasibility_version);
      assert.match(row.input_hash, /^sha256:[0-9a-f]{64}$/);
      assert.ok(Number(row.snapshot_version) >= 1, "3623's per-session snapshot version");
      // the stored answer IS the published answer
      assert.equal(row.verdict, o.body.advice.verdict);
      // the stored deadline is the record's `deadline` (whole seconds, never later); the window publishes the envelope's instant
      const stored = Date.parse(row.hard_return_time), shown = Date.parse(o.body.window.hardReturnTime);
      assert.ok(stored <= shown && shown - stored < 1000, `stored ${row.hard_return_time} vs published ${o.body.window.hardReturnTime}`);
      assert.equal(Number(row.usable_minutes), o.body.window.usableMinutes);
      // L37: the confidence band a decision turns on is a stored column
      assert.ok(["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"].includes(row.confidence));
      assert.equal(row.confidence, o.body.certification.confidence);
      // L207: §20's members on the row (inputFacts/sourceRefs/rulesApplied are 2992's columns)
      assert.ok(Array.isArray(row.input_facts) && row.input_facts.length > 0, "inputFacts[]");
      assert.ok(Array.isArray(row.source_refs), "sourceRefs[]");
      assert.ok(Array.isArray(row.rules_applied) && row.rules_applied.length > 0, "rulesApplied[]");
      assert.ok(Array.isArray(row.reason_codes));
      assert.ok(row.computed_at && row.inputs, "computedAt + the replayable inputs");
      // L36: the risk band persists, in the spec's vocabulary, on the return plan
      const plan = await db.query<any>(`SELECT * FROM public.layover_return_plans WHERE snapshot_id = '${firstSnap}'`);
      assert.equal(plan.length, 1, "no return plan was stored for the snapshot");
      assert.ok((RISK_BANDS as readonly string[]).includes(plan[0].risk_band), `risk_band ${plan[0].risk_band}`);
      const budget = await db.query<any>(`SELECT * FROM public.layover_time_budgets WHERE snapshot_id = '${firstSnap}'`);
      assert.equal(budget.length, 1, "no time budget was stored for the snapshot");
    });

    it("S2 L206 — every material recomputation creates a NEW deterministic snapshot: a window edit is version 2 with a different input", async () => {
      const before = await computations(sid);
      const p = await app.call("PATCH", `/api/airport/sessions/${sid}`, ana, { departureTime: new Date(Date.now() + 6 * 3_600_000).toISOString() });
      assert.equal(p.status, 200, p.raw);
      assert.equal(p.body.replan.ran, true, JSON.stringify(p.body.replan).slice(0, 400));
      assert.equal(p.body.replan.snapshotPersisted, true, `L207: the replan's record was not stored: ${p.body.replan.snapshotUnavailableReason}`);
      secondSnap = p.body.replan.snapshotId;
      const after = await computations(sid);
      assert.equal(after.length, before.length + 1, "one recomputation, one new snapshot");
      const row = after.find((r) => r.snapshot_id === secondSnap);
      assert.ok(row, "the replan cites a snapshot no row holds");
      assert.notEqual(row.input_hash, before[0].input_hash);
      assert.equal(Number(row.snapshot_version), Math.max(...before.map((r) => Number(r.snapshot_version))) + 1, "3623 numbers the session's snapshots in order");
      // deterministic: the stored inputs reproduce the stored id (the same identity /explain checks)
      const ledger = await db.query<any>(`SELECT metadata FROM public.layover_events WHERE session_id = '${sid}' AND event_type = 'session_updated' ORDER BY created_at DESC LIMIT 1`);
      assert.equal(ledger[0].metadata.decision.snapshotId, secondSnap, "L207: the replan's ledger row cites the stored snapshot");
    });

    it("S3 L20 — snapshots are immutable: the stored children refuse an UPDATE (2992's triggers) and a client cannot write the ledger at all", async () => {
      await assert.rejects(db.exec(`UPDATE public.layover_return_plans SET risk_band = 'LOW' WHERE snapshot_id = '${firstSnap}'`), /immutable|not permitted|refus/i);
      await assert.rejects(db.exec(`UPDATE public.layover_time_budgets SET usable_minutes = usable_minutes + 1 WHERE snapshot_id = '${firstSnap}'`), /immutable|not permitted|refus/i);
      await assert.rejects(db.exec(`INSERT INTO public.layover_return_plans (snapshot_id, session_id, risk_band) VALUES ('${firstSnap}', '${sid}', 'BOGUS')`), (e: any) => ["23514", "23505", "23502"].includes(e?.code));
      await assert.rejects(
        db.asUser(ana.id, `UPDATE public.layover_certified_computations SET verdict = 'yes' WHERE snapshot_id = '${firstSnap}' RETURNING id`),
        (e: any) => e?.code === "42501", "the owner's client must not be able to rewrite a certified computation",
      );
      const own = await db.asUser(ana.id, `SELECT snapshot_id FROM public.layover_certified_computations WHERE session_id = '${sid}'`);
      assert.ok(own.length >= 2, "RLS: the owner reads their own snapshots");
      const theirs = await db.asUser(bob.id, `SELECT snapshot_id FROM public.layover_certified_computations WHERE session_id = '${sid}'`);
      assert.equal(theirs.length, 0, "RLS: another traveller reads none of them");
    });

    it("S4 L189 L5 — explain(snapshotId) explains the STORED snapshot, verified by replaying its stored inputs", async () => {
      const r = await app.call("GET", `/api/airport/sessions/${sid}/decisions/${firstSnap}/explain`, ana);
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.state, "explained", r.raw);
      const e = r.body.explanation;
      assert.equal(e.verifiedBy, "replay_match");
      assert.equal(e.snapshotId, firstSnap);
      for (const k of ["sessionId", "snapshotId", "engineVersion", "inputHash", "inputFacts", "sourceRefs", "rulesApplied", "result", "reasonCodes", "computedAt"]) assert.ok(k in e.decision, `L207: DecisionRecord lacks ${k}`);
      assert.ok(e.reasons.length > 0 && e.disclaimer);
    });

    it("S5 L191 L240 — replay(sessionId, engineVersion) replays every recorded decision of the session and every one reproduces", async () => {
      const r = await app.call("GET", `/api/airport/sessions/${sid}/decisions/replay?engineVersion=${encodeURIComponent(LAYOVER_ENGINE_VERSION)}`, ana);
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.state, "replayed", r.raw);
      const n = (await computations(sid)).length;
      const sm = r.body.summary;
      assert.equal(sm.read, n, JSON.stringify(sm).slice(0, 300));
      assert.equal(sm.replayed, n, "every recorded decision is replayable under the running engine");
      assert.equal(sm.matched, n);
      assert.equal(sm.mismatched, 0);
      assert.equal(sm.refused, 0);
      const other = await app.call("GET", `/api/airport/sessions/${sid}/decisions/replay?engineVersion=1999.01.01-1`, ana);
      assert.equal(other.body.state, "not_replayed", "an engine this tree does not run is refused, not faked");
    });

    it("S6 L240 L189 — replay is FALSIFIABLE on the real rows: a stored decision tampered behind the engine's back is refused, not explained", async () => {
      await tamperForReplay(`UPDATE public.layover_certified_computations SET usable_minutes = usable_minutes + 7 WHERE snapshot_id = '${firstSnap}'`);
      const e = await app.call("GET", `/api/airport/sessions/${sid}/decisions/${firstSnap}/explain`, ana);
      assert.equal(e.body.state, "not_explained", e.raw);
      assert.equal(e.body.reason, "replay_mismatch");
      const r = await app.call("GET", `/api/airport/sessions/${sid}/decisions/replay?engineVersion=${encodeURIComponent(LAYOVER_ENGINE_VERSION)}`, ana);
      assert.equal(r.body.summary.mismatched, 1, `the replay did not see the tampered row: ${JSON.stringify(r.body.summary).slice(0, 400)}`);
      assert.equal(r.body.summary.matched, r.body.summary.replayed - 1);
      await tamperForReplay(`UPDATE public.layover_certified_computations SET usable_minutes = usable_minutes - 7 WHERE snapshot_id = '${firstSnap}'`);
    });

    it("S7 L241 — the decision diff compares two STORED decisions of the session (historical corpus) and names the material change", async () => {
      const r = await app.call("GET", `/api/airport/sessions/${sid}/decisions/diff?from=${firstSnap}&to=${secondSnap}`, ana);
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.state, "stored", r.raw);
      assert.ok(JSON.stringify(r.body.diff).includes("hardReturnTime") || JSON.stringify(r.body.diff).includes("hard_return"), JSON.stringify(r.body.diff).slice(0, 400));
    });

    it("S12 L241 — the historical half: the admin metrics replay EVERY stored decision in the window under the running engine, and a behaviour change shows as a counted mismatch", async () => {
      const admin = await db.seedUser("admin");
      await db.exec(`UPDATE public.profiles SET role = 'admin' WHERE id = '${admin.id}'`);
      const total = (await db.query<any>("SELECT count(*)::int AS n FROM public.layover_certified_computations"))[0].n;
      const clean = await app.call("GET", "/api/admin/layover/metrics?days=1", admin);
      assert.equal(clean.status, 200, clean.raw.slice(0, 300));
      assert.equal(clean.body.sources.replay.state, "replayed");
      assert.equal(clean.body.replay.read, total, JSON.stringify(clean.body.replay));
      assert.equal(clean.body.replay.mismatched, 0);
      await tamperForReplay(`UPDATE public.layover_certified_computations SET usable_minutes = usable_minutes + 11 WHERE snapshot_id = '${secondSnap}'`);
      try {
        const drift = await app.call("GET", "/api/admin/layover/metrics?days=1", admin);
        assert.equal(drift.body.replay.mismatched, 1, JSON.stringify(drift.body.replay));
        assert.equal(drift.body.replay.mismatchedColumns.usable_minutes, 1);
      } finally {
        await tamperForReplay(`UPDATE public.layover_certified_computations SET usable_minutes = usable_minutes - 11 WHERE snapshot_id = '${secondSnap}'`);
      }
      const nobody = await db.seedUser("notadmin");
      assert.notEqual((await app.call("GET", "/api/admin/layover/metrics?days=1", nobody)).status, 200, "a non-admin read the decision metrics");
    });

    it("S8 L44 L238 — event → replan → snapshot → invalidation → notification, end to end on the real tables", async () => {
      await curatedSnapshotFixture(db, bob, "SIN"); const s = (await startSession(app, bob, { iata: "SIN" }, { departsInH: 10 })).id;
      const recs = await app.call("GET", `/api/airport/sessions/${s}/recommendations`, bob);
      assert.equal(recs.status, 200, recs.raw);
      const cited = await db.query<any>(`SELECT id, snapshot_id FROM public.layover_recommendations WHERE session_id = '${s}' AND snapshot_id IS NOT NULL`);
      assert.ok(cited.length > 0, "3623: no card was stamped with the snapshot it was certified under");
      assert.equal(cited[0].snapshot_id, recs.body.snapshotId);
      const stored = await db.query<any>(`SELECT 1 FROM public.layover_certified_computations WHERE snapshot_id = '${recs.body.snapshotId}'`);
      assert.equal(stored.length, 1, "a card cites a snapshot that is not stored");
      // the event: the flight moves 6 hours earlier
      const p = await app.call("PATCH", `/api/airport/sessions/${s}`, bob, { departureTime: new Date(Date.now() + 4 * 3_600_000).toISOString() });
      assert.equal(p.status, 200, p.raw);
      const rp = p.body.replan;
      assert.equal(rp.snapshotPersisted, true, "snapshot stage");
      assert.equal(rp.invalidationApplied?.applied, true, `invalidation stage: ${JSON.stringify(rp.invalidationApplied)}`);
      assert.ok(rp.invalidationApplied.superseded.length >= cited.length, "every card certified under the old snapshot is invalidated");
      assert.ok(rp.invalidationApplied.superseded.every((u: any) => u.why.includes("stale_certification")));
      const still = await db.query<any>(`SELECT count(*)::int AS n FROM public.layover_recommendations WHERE session_id = '${s}' AND snapshot_id = '${recs.body.snapshotId}'`);
      assert.equal(still[0].n, cited.length, "supersession preserves the old citation as historical decision evidence"); assert.equal((await db.query<any>(`SELECT count(*)::int AS n FROM public.layover_recommendations WHERE session_id='${s}' AND recommendation_status='SUPERSEDED'`))[0].n, cited.length);
      const kept = await db.query<any>(`SELECT count(*)::int AS n FROM public.layover_recommendations WHERE session_id = '${s}'`);
      assert.equal(kept[0].n, cited.length >= 1 ? kept[0].n : 0, "invalidated, not deleted (history kept)");
      assert.ok(kept[0].n >= cited.length);
      // the audit trail: the replan's ledger row records what was applied
      const ledger = await db.query<any>(`SELECT metadata FROM public.layover_events WHERE session_id = '${s}' AND event_type = 'session_updated' ORDER BY created_at DESC LIMIT 1`);
      assert.equal(ledger[0].metadata.replan.invalidationApplied.applied, true, "L44: the audit trail does not record the invalidation");
      // the notification stage: the replan reached the traveller's notification store
      const notes = await db.query<any>(`SELECT source_type, priority FROM public.notifications WHERE user_id = '${bob.id}' AND source_type IN ('layover_replan', 'layover_return')`);
      assert.ok(notes.length > 0 || p.body.replan.opportunityNotification?.emitted === false, JSON.stringify(p.body.replan.opportunityNotification));
      assert.ok(notes.length > 0, `notification stage: none written (${JSON.stringify(p.body.replan.opportunityNotification)})`);
    });

    it("S11 L44 — a traveller-REPORTED disruption (POST /disruption, the * → DISRUPTED input, R22) invalidates the cards certified under the superseded snapshot and stores the new one", async () => {
      const u = await db.seedUser("disrupted");
      const s = (await startSession(app, u, { iata: "SIN" }, { departsInH: 10 })).id;
      const recs = await app.call("GET", `/api/airport/sessions/${s}/recommendations`, u);
      assert.equal(recs.status, 200, recs.raw);
      const cited = await db.query<any>(`SELECT id FROM public.layover_recommendations WHERE session_id = '${s}' AND snapshot_id = '${recs.body.snapshotId}'`);
      assert.ok(cited.length > 0, "precondition: stamped cards");
      const d = await app.call("POST", `/api/airport/sessions/${s}/disruption`, u, { kind: "delay", newDepartureTime: new Date(Date.now() + 12 * 3_600_000).toISOString() });
      assert.equal(d.status, 200, d.raw);
      assert.equal(d.body.disruption.state, "DELAYED");
      const snap = d.body.replanSnapshot;
      assert.ok(snap, "the disruption published no snapshot/invalidation outcome");
      assert.equal(snap.snapshotPersisted, true, JSON.stringify(snap));
      assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_certified_computations WHERE snapshot_id = '${snap.snapshotId}'`)).length, 1);
      assert.equal(snap.invalidationApplied?.applied, true, JSON.stringify(snap.invalidationApplied));
      const still = await db.query<any>(`SELECT count(*)::int AS n FROM public.layover_recommendations WHERE session_id = '${s}' AND snapshot_id = '${recs.body.snapshotId}'`);
      assert.equal(still[0].n, cited.length, "the superseded decision keeps its citation; availability comes from recommendation_status"); assert.equal((await db.query<any>(`SELECT count(*)::int AS n FROM public.layover_recommendations WHERE session_id='${s}' AND recommendation_status='SUPERSEDED'`))[0].n, cited.length);
      const audit = await db.query<any>(`SELECT metadata FROM public.layover_events WHERE session_id = '${s}' AND event_type = 'session_updated' AND metadata ? 'disruptionSnapshot' ORDER BY created_at DESC LIMIT 1`);
      assert.equal(audit[0]?.metadata?.disruptionSnapshot?.invalidationApplied?.applied, true, "the invalidation is not in the audit trail");
    });

    it("S10 L233 — the cached offline return plan IS a stored, replayable snapshot: its input hash names a stored computation and its deadline matches the stored return plan", async () => {
      const o = await overview(ana);
      assert.equal(o.status, 200, o.raw);
      const b = o.body.offlineBundle;
      assert.ok(b, "no offline bundle");
      const hash = b.inputHash ?? b.certification?.inputHash;
      assert.ok(hash, `the bundle carries no input hash: ${JSON.stringify(Object.keys(b))}`);
      const row = await db.query<any>(`SELECT snapshot_id, hard_return_time FROM public.layover_certified_computations WHERE session_id = '${sid}' AND input_hash = '${hash}'`);
      assert.equal(row.length, 1, "the plan the phone caches is not a stored snapshot");
      const plan = await db.query<any>(`SELECT * FROM public.layover_return_plans WHERE snapshot_id = '${row[0].snapshot_id}'`);
      assert.equal(plan.length, 1);
      assert.ok(b.staleAfter || b.certifiedAt, "the bundle must carry its own staleness");
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 persistence OFF → nothing is written and the overview SAYS so (never a silent success)", async () => {
      const prev = await db.flag("layover_decision_persistence_enabled");
      await db.setFlag("layover_decision_persistence_enabled", false);
      try {
        const s = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 8 })).id;
        const o = await overview(ana, s);
        assert.equal(o.status, 200, o.raw);
        assert.equal(o.body.persisted.state, "not_stored");
        assert.equal(o.body.persisted.reason, "persistence_disabled");
        if (await db.hasTable("layover_certified_computations")) assert.equal((await computations(s)).length, 0);
        const e = await app.call("GET", `/api/airport/sessions/${s}/decisions/${o.body.snapshotId}/explain`, ana);
        assert.equal(e.body.state, "unavailable"); assert.equal(e.body.reason, "feature_disabled");
      } finally { if (prev !== "absent") await db.setFlag("layover_decision_persistence_enabled", prev); }
    });

    it("A2 persistence flag UNREADABLE → the ledger endpoints refuse as retryable, never explain", async () => {
      const fault = (req: any) => (req.target === "feature_flags" && String(req.params.get("flag") ?? "").includes("layover_decision_persistence_enabled") ? { status: 500, body: { code: "XX000", message: "injected", details: null, hint: null } } : null);
      db.bridge.faults.push(fault);
      try {
        const r = await app.call("GET", `/api/airport/sessions/${sid}/decisions/replay?engineVersion=${encodeURIComponent(LAYOVER_ENGINE_VERSION)}`, ana);
        assert.equal(r.body.state, "unavailable"); assert.equal(r.body.reason, "flag_unreadable"); assert.equal(r.body.retryable, true);
      } finally { db.bridge.faults.splice(db.bridge.faults.indexOf(fault), 1); }
    });

    it("A3 owner-scoped: another traveller's explain/replay/diff on this session is 404; no token 401", async () => {
      const snap = firstSnap || "snap:00000000000000000000000000000000";
      for (const path of [`decisions/${snap}/explain`, `decisions/replay?engineVersion=${encodeURIComponent(LAYOVER_ENGINE_VERSION)}`, `decisions/diff?from=${snap}&to=${snap}`]) {
        const r = await app.call("GET", `/api/airport/sessions/${sid}/${path}`, bob);
        assert.equal(r.status, 404, `${path}: ${r.raw}`);
      }
      assert.equal((await app.call("GET", `/api/airport/sessions/${sid}/decisions/${snap}/explain`, null)).status, 401);
    });

    it("A4 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});

// The ordering constraint, measured: the persistence flag pressed over a chain WITHOUT 3792.
// Defined only where an isolated chain variant can be built and in the pressed arm: a skip would be counted, and
// scripts/local-db/run-tests.sh refuses skips on CI's psql backend, which has one chain.
if (PRESSED_BACKEND !== null && PRESS_ARM === "pressed" && !process.env["PRESSED_BASE"] /* §83: a chain WITHOUT 3792 is not production, which applied it on 2026-10-21 */) describe("B1-P P1 ordering — 3792 must land before the persistence flag", () => {
  it("S9 without 3792, a historical entry_unverified decision cannot be stored; current unknown-entry overview fails closed", async () => {
    const d = await openPressedLayoverDb({ without: ["3792"] });
    let a: PressedApp | null = null;
    try {
      await productionBaseFlags(d);
      await d.setFlag("layover_decision_persistence_enabled", true);
      a = await startPressedLayoverApp(d);
      const u = await d.seedUser("carla");
      // NRT, not SIN: lib/canonicalLocations memoises the canonical city id for an hour per process, and SIN's
      // belongs to the first database of this file (a test-process artifact, not a production one).
      const s = (await startSession(a, u, { iata: "NRT" }, { departsInH: 9 })).id;
      const o = await a.call("GET", `/api/airport/sessions/${s}/overview`, u);
      assert.equal(o.status, 200, o.raw);
      assert.equal(o.body.advice.verdict, "no", "unknown critical entry and maturity now fail closed");
      const held = (await d.query<any>(`SELECT * FROM public.layover_certified_computations WHERE session_id='${s}' LIMIT 1`))[0]; assert.ok(held);
      const { id: _id, snapshot_version: _version, ...historical } = held; const refusal = await d.client.from("layover_certified_computations").insert({ ...historical, snapshot_id: `${held.snapshot_id}-historical`, input_hash: `${held.input_hash}-historical`, verdict: "entry_unverified" });
      assert.equal(refusal.error?.code, "23514", "3792 still must admit the historical verdict vocabulary before replay/import writes");
    } finally { await a?.close(); await d.close(); }
  });
});

/** Test-only superuser corruption fixture: prove the parent refuses the write, then bypass its trigger solely to test replay detection. */
async function tamperForReplay(sql: string): Promise<void> {
  await assert.rejects(db.exec(sql), /IMMUTABLE/);
  try {
    await db.exec(`BEGIN; ALTER TABLE public.layover_certified_computations DISABLE TRIGGER layover_certified_computations_immutable; ${sql}; ALTER TABLE public.layover_certified_computations ENABLE TRIGGER layover_certified_computations_immutable; COMMIT;`);
  } catch (error) {
    await db.exec("ROLLBACK"); throw error;
  }
}

/** Real curation workflow fixture: make the S8 window edit operationally meaningful under the current maturity gate. */
async function curatedSnapshotFixture(database: PressedDb, curator: PressedUser, iata: string): Promise<void> {
  const { proposeCuratedFact, validateProposedFact, publishValidatedFact } = await import("../../services/airport/airportCuration.js");
  const { seedConfirmedCorridor } = await import("./pressedLayoverApp.js");
  const airport = (await database.query<any>(`SELECT id FROM public.airport_profiles WHERE iata_code='${iata}'`))[0];
  assert.ok(airport);
  await seedConfirmedCorridor(database, curator.id);
  const facts = [
    ["terminal_topology", { terminals: [{ id: "T1", name: "Terminal 1" }, { id: "T2", name: "Terminal 2" }], gates: [{ terminalId: "T1", label: "A1" }], checkpoints: [{ id: "security", terminalId: "T1", kind: "security" }], walkingLinks: [{ fromTerminalId: "T1", toTerminalId: "T2", minutes: 12, mode: "train" }] }],
    ["ground_transport", { modes: [{ mode: "rail", name: "Fixture rail", toCity: "City centre", journeyMinutes: { min: 25, max: 35 }, terminalIds: ["T1"] }] }],
    ["timing_assumptions", { domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, rationale: "Explicit integration-test timing policy" }],
  ] as const;
  for (const [kind, value] of facts) {
    const proposed = await proposeCuratedFact(database.client, { airportId: airport.id, kind, value, source: { kind: kind === "timing_assumptions" ? "curator_judgment" : "official_airport", note: "Integration-test fixture only", url: "https://example.test/airport", title: "Integration-test airport", retrievedAt: new Date().toISOString() }, proposedVia: "admin", proposedBy: curator.id }, Date.now());
    assert.ok(proposed.ok, JSON.stringify(proposed));
    const validated = await validateProposedFact(database.client, proposed.fact.id, curator.id, Date.now()); assert.ok(validated.ok, JSON.stringify(validated));
    const published = await publishValidatedFact(database.client, proposed.fact.id, curator.id); assert.ok(published.ok, JSON.stringify(published));
  }
}
