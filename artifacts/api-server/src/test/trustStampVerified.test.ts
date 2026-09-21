/**
 * stamp_verified — the one Trust event that is live the moment it deploys.
 *
 *   services/passport/StampAwardEngine._awardStampCore, `awarded: true` return
 *     → recordStampVerifiedTrustEvent (Trust-owned half; +3 passport_authenticity)
 *     → recordTrustEvent → trust_events row (status applied; minor)
 *     → runTrustMaintenance (dirty user) → recalculateTrustScore
 *     → trust_profiles row
 *
 * ── WHY THIS SUITE EXISTS ────────────────────────────────────────────────────
 * Production, 2026-09-07 (read, not remembered): trust_engine_enabled TRUE,
 * trust_events 5 rows, stamp_verified 0 rows, 47 live user_stamps, 2 trust
 * profiles. The helper existed with no caller; passport_authenticity could only
 * go DOWN (stamp_disputed, on revoke). This suite drives the REAL award engine —
 * awardStamp(), not the helper — and follows every award to the ledger, then
 * through the maintenance pass to a persisted profile.
 *
 * The emitter is fire-and-forget by design (a stamp must never be lost to trust
 * bookkeeping), so `awarded: true` says nothing about the ledger; every test
 * inspects the in-memory trust_events table after the promise chain drains.
 *
 * What is pinned, and what each assertion fails against:
 *   1. PROVENANCE — subject = the stamp OWNER; source = the user_stamps row;
 *      an admin who awarded it is metadata, never the subject.
 *   2. IDEMPOTENCY — awardStamp twice (the engine short-circuits) and the
 *      helper replayed for the same stamp id (the Trust dedup key) both leave
 *      ONE event and one score.
 *   3. THE CHAIN — event → maintenance → profile, evidence measured.
 *   4. FAIL-CLOSED FLAG — off, and UNREADABLE, both mean no event and a
 *      successful award. supabase-js resolves `{ error }`; the fake injects
 *      exactly that shape, never a throw.
 *   5. NON-FATAL, NOT SILENT — a ledger insert failure leaves the award
 *      awarded and is logged by the engine (stamp.award.trust_event_failed).
 *   6. ONLY A GENUINE AWARD — self-reported provenance, revoke, restore and the
 *      recalculateForUser backfill write nothing; the heal of a partial failure
 *      writes exactly once (it is the first row for that award).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/trustStampVerified.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  awardStamp,
  revokeStamp,
  restoreStamp,
  recalculateForUser,
  type AwardInput,
} from "../services/passport/StampAwardEngine.js";
import {
  recordStampVerifiedTrustEvent,
  TRUST_EVENT_TYPES,
} from "../services/trust/TrustEventService.js";
import { recalculateTrustScore, getTrustProfile } from "../services/trust/TrustScoreService.js";
import { runTrustMaintenance } from "../lib/trustMaintenanceScheduler.js";

// ── Ids ──────────────────────────────────────────────────────────────────────

const OWNER   = "10000000-0000-4000-8000-000000000001";
const ADMIN   = "10000000-0000-4000-8000-00000000000a";
const DEF_ID  = "cccccccc-0000-4000-8000-000000000001";
const DEF_SLUG = "first_trip_completed";
const TRIP_ID = "f1f1f1f1-0000-4000-8000-000000000033";

// ── Fake client: in-memory tables, resolved-error injection ──────────────────

type Row = Record<string, any>;
type Store = Record<string, Row[]>;
type Op = "select" | "insert" | "update" | "upsert" | "delete";
type Filter = [col: string, val: unknown];

interface Fake {
  client: any;
  tables: Store;
  /**
   * Make the NEXT `op` on `table` resolve `{ data: null, error }` — never
   * throw. `when` narrows it to a query whose recorded filters match, so a
   * single flag read can fail without failing the engine's own flag reads.
   */
  failNext(table: string, op: Op, error: { code?: string; message: string }, when?: (filters: Filter[]) => boolean): void;
}

function makeFake(seed: Partial<Store> = {}): Fake {
  const tables: Store = {
    feature_flags: [
      { flag: "stamp_system_v2_enabled", enabled: true },
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: false },
    ],
    trust_settings: [{ id: 1, decay_half_life_days: 90 }],
    stamp_definitions: [{
      id: DEF_ID, slug: DEF_SLUG, name: "First Trip", stamp_type: "trip", is_active: true,
      is_repeatable: false, max_awards_per_user: null, visibility_default: "public",
      criteria_type: "count", criteria: null,
    }],
    trips: [{ id: TRIP_ID, status: "completed" }],
    profiles: [{ id: OWNER, role: "user", account_status: "active" }, { id: ADMIN, role: "admin", account_status: "active" }],
    user_stamps: [], stamp_award_events: [], stamp_progress: [], stamp_milestones: [],
    universal_stamp_catalog: [], stamp_generation_queue: [], passport_telemetry_events: [],
    trust_events: [], trust_caps: [], trust_restrictions: [], trust_profiles: [],
    trust_reviews: [], trust_admin_actions: [], plan_attendance_events: [],
    ...seed,
  };
  const failures: Array<{ key: string; error: { code?: string; message: string }; when?: (f: Filter[]) => boolean }> = [];
  let seq = 1;

  function from(table: string) {
    const store = (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    const recorded: Filter[] = [];
    let op: Op = "select";
    let payload: any = null;
    let limitN: number | null = null;
    let order: { col: string; asc: boolean } | null = null;

    const b: any = {
      select() { return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      update(p: any)   { op = "update"; payload = p;   return b; },
      upsert(row: any, opts?: any) { op = "upsert"; payload = { row, key: String(opts?.onConflict ?? "id") }; return b; },
      delete()         { op = "delete"; return b; },
      eq(c: string, v: any)    { recorded.push([c, v]); filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any)   { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any)    { recorded.push([c, v]); filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      gt(c: string, v: any)    { filters.push((r) => r[c] > v); return b; },
      gte(c: string, v: any)   { filters.push((r) => r[c] >= v); return b; },
      lt(c: string, v: any)    { filters.push((r) => r[c] < v); return b; },
      lte(c: string, v: any)   { filters.push((r) => r[c] <= v); return b; },
      not(c: string, o: string, v: any) { filters.push((r) => (o === "is" && v === null ? r[c] != null : r[c] !== v)); return b; },
      or(expr: string) {
        const m = /^(\w+)\.is\.null,\1\.gt\.(.+)$/.exec(expr);
        if (m) { const col = m[1]; const iso = m[2]; filters.push((r) => r[col] == null || r[col] > iso); }
        return b;
      },
      ilike() { return b; }, like() { return b; },
      order(col: string, o?: any) { order = { col, asc: o?.ascending !== false }; return b; },
      limit(n: number) { limitN = n; return b; },
      range() { return b; },
      maybeSingle() { return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })); },
      single()      { return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };

    function matched(): Row[] {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (order) rows = [...rows].sort((a, b2) => (a[order!.col] < b2[order!.col] ? -1 : 1) * (order!.asc ? 1 : -1));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }
    async function run(): Promise<{ data: any; error: any; count?: number }> {
      const key = `${table}:${op}`;
      const i = failures.findIndex((f) => f.key === key && (!f.when || f.when(recorded)));
      if (i >= 0) { const [f] = failures.splice(i, 1); return { data: null, error: f.error }; }
      if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((p: any) => ({ id: `fake-${seq++}`, created_at: new Date().toISOString(), ...p }));
        store.push(...rows); return { data: rows, error: null };
      }
      if (op === "upsert") {
        const { row, key: k } = payload as { row: Row; key: string };
        const cols = k.split(",").map((c) => c.trim());
        const j = store.findIndex((r) => cols.every((c) => r[c] === row[c]));
        if (j >= 0) { store[j] = { ...store[j], ...row }; return { data: [store[j]], error: null }; }
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r); return { data: [r], error: null };
      }
      if (op === "update") {
        const rows = matched(); rows.forEach((r) => Object.assign(r, payload));
        return { data: rows, error: null };
      }
      if (op === "delete") {
        const rows = matched(); for (const r of rows) store.splice(store.indexOf(r), 1);
        return { data: rows, error: null };
      }
      const rows = matched().map((r) => ({ ...r }));
      return { data: rows, error: null, count: rows.length };
    }
    return b;
  }

  const client = {
    from,
    // increment_stamp_progress is only called for repeatable definitions; report
    // it absent (PGRST202) so the engine's legacy fallback runs on the fake.
    rpc: async () => ({ data: null, error: { code: "PGRST202", message: "function not found" } }),
  };
  return {
    client, tables,
    failNext(table, op, error, when) { failures.push({ key: `${table}:${op}`, error, when }); },
  };
}

/** The emitter is fire-and-forget; let its promise chain (and the engine's other side effects) drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 15));
}

const award = (f: Fake, over: Partial<AwardInput> = {}) =>
  awardStamp(f.client, { userId: OWNER, definitionSlug: DEF_SLUG, sourceType: "trips", sourceId: TRIP_ID, city: "Lisbon", country: "Portugal", ...over });

const stampVerifiedEvents = (f: Fake) => f.tables.trust_events.filter((e) => e.event_type === "stamp_verified");

// ── Log capture ──────────────────────────────────────────────────────────────
// The engine reports in its structured console vocabulary (stamp.award.*) —
// that line is the one this suite owns and asserts. Trust's helper ALSO warns
// through pino, but via a `.child()` of a transport-backed (pino-pretty worker)
// root logger, which no in-process patch of `logger.warn` or stdout observes;
// its warn is visible in this suite's run output, not assertable here.

let engineLog: Array<Record<string, unknown>> = [];
const realConsoleError = console.error;

beforeEach(() => {
  engineLog = [];
  console.error = (...a: any[]) => {
    try { engineLog.push(JSON.parse(String(a[0]))); } catch { /* non-JSON noise from other side effects */ }
  };
});
afterEach(() => { console.error = realConsoleError; });

// ── 1. Provenance ────────────────────────────────────────────────────────────

describe("stamp_verified — a genuine fresh award through StampAwardEngine.awardStamp", () => {
  let f: Fake;
  beforeEach(() => { f = makeFake(); });

  it("writes ONE applied event: the OWNER is the subject, the user_stamps row is the source, +3 passport_authenticity", async () => {
    const r = await award(f);
    assert.equal(r.awarded, true, r.reason);
    await settle();

    assert.equal(f.tables.user_stamps.length, 1, "the stamp itself was written");
    const evs = f.tables.trust_events;
    assert.equal(evs.length, 1, `exactly one trust event, got ${JSON.stringify(evs.map((e) => e.event_type))}`);
    const e = evs[0];
    assert.equal(e.user_id, OWNER, "the stamp owner is the subject");
    assert.equal(e.event_type, "stamp_verified");
    assert.equal(e.category, TRUST_EVENT_TYPES.STAMP_VERIFIED.category);
    assert.equal(e.category, "passport_authenticity");
    assert.equal(e.delta, TRUST_EVENT_TYPES.STAMP_VERIFIED.delta);
    assert.equal(e.severity, TRUST_EVENT_TYPES.STAMP_VERIFIED.severity);
    assert.equal(e.status, "applied", "minor → applied, never queued for review");
    assert.equal(e.source_type, "passport");
    assert.equal(e.source_id, r.userStampId, "keyed on the user_stamps row just inserted");
    assert.equal(e.source_id, f.tables.user_stamps[0].id);
    assert.equal(e.metadata.userStampId, r.userStampId);
    assert.equal(e.metadata.stampSourceType, "trips");
    assert.equal(e.metadata.stampDefinitionId, DEF_ID);
    assert.equal(e.metadata.awardedByAdminId, null, "no admin was involved");
    assert.equal(e.metadata.tier, "verified");
    assert.equal(engineLog.filter((l) => l.event === "stamp.award.trust_event_failed").length, 0, "success is not logged as a failure");
  });

  it("an ADMIN-awarded stamp credits the OWNER; the admin is provenance metadata and appears nowhere as the subject", async () => {
    const r = await award(f, { sourceType: "admin", sourceId: "none", adminId: ADMIN, awardReason: "Manual grant" });
    assert.equal(r.awarded, true, r.reason);
    await settle();

    assert.equal(f.tables.user_stamps[0].awarded_by_admin_id, ADMIN, "the stamp row records the admin");
    const evs = f.tables.trust_events;
    assert.equal(evs.length, 1);
    const e = evs[0];
    assert.equal(e.user_id, OWNER, "the owner earned it");
    assert.notEqual(e.user_id, ADMIN, "the admin is NEVER the subject");
    assert.equal(e.metadata.awardedByAdminId, ADMIN, "the admin is recorded as the actor who awarded it");
    assert.equal(e.metadata.stampSourceType, "admin");
    assert.equal(e.metadata.tier, "verified", "an admin grant is server-derived provenance, not self-reported");
    assert.equal(e.reviewed_by, undefined, "an award is not an adjudication — no reviewer column is set");
    const { metadata, ...rest } = e;
    assert.equal(JSON.stringify(rest).includes(ADMIN), false, "outside metadata the admin id appears nowhere on the row");
  });

  it("a SELF-REPORTED award is a decoration, not evidence: the award succeeds and nothing is written", async () => {
    const r = await award(f, { sourceType: "self_reported", sourceId: "none" });
    assert.equal(r.awarded, true, r.reason);
    await settle();
    assert.equal(f.tables.user_stamps.length, 1);
    assert.equal(f.tables.trust_events.length, 0);
    assert.equal(engineLog.filter((l) => l.event === "stamp.award.trust_event_failed").length, 0, "a rule skip is not a failure");
  });
});

// ── 2. Idempotency ───────────────────────────────────────────────────────────

describe("stamp_verified — processed twice awards once and scores once", () => {
  let f: Fake;
  beforeEach(() => { f = makeFake(); });

  it("awardStamp twice with the same input: the second is already_earned and the ledger holds ONE event", async () => {
    const a = await award(f);
    assert.equal(a.awarded, true);
    await settle();
    const b = await award(f);
    assert.equal(b.awarded, false);
    assert.equal(b.reason, "already_awarded", "the idempotency key short-circuits before the emitter line");
    await settle();
    assert.equal(f.tables.user_stamps.length, 1);
    assert.equal(f.tables.trust_events.length, 1, "a retried request is not a second piece of evidence");
  });

  it("a retried request against a re-awardable state (no award event, a live stamp) is already_earned — still ONE event", async () => {
    await award(f);
    await settle();
    // Simulate a replay whose award-event row was lost but whose stamp row is live.
    f.tables.stamp_award_events.length = 0;
    const b = await award(f);
    assert.equal(b.reason, "already_earned");
    await settle();
    assert.equal(f.tables.trust_events.length, 1);
  });

  it("the Trust dedup key: the helper replayed for the same stamp id is a dedup skip; the score is unchanged", async () => {
    const a = await award(f);
    await settle();
    const first = await recalculateTrustScore(f.client, OWNER);

    // The exact call the engine makes, delivered again (a re-run, a double-processed job).
    const again = await recordStampVerifiedTrustEvent(f.client, {
      userId: OWNER, userStampId: a.userStampId!, tier: "verified", stampSourceType: "trips", stampDefinitionId: DEF_ID,
    });
    assert.deepEqual(again, { ok: false, skipped: true, skipReason: "dedup" });
    assert.equal(f.tables.trust_events.length, 1);

    const second = await recalculateTrustScore(f.client, OWNER);
    assert.equal(second.overall_score, first.overall_score);
    assert.equal(second.categories.passport_authenticity, first.categories.passport_authenticity);
    assert.equal(f.tables.trust_profiles.length, 1, "one profile row, not one per recalculation");
  });

  it("two DIFFERENT stamps for the same owner are two events (dedup is per stamp, not per user)", async () => {
    f.tables.stamp_definitions.push({
      id: "cccccccc-0000-4000-8000-000000000002", slug: "city_explorer", name: "City Explorer", stamp_type: "city",
      is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "count", criteria: null,
    });
    await award(f);
    await award(f, { definitionSlug: "city_explorer" });
    await settle();
    assert.equal(f.tables.user_stamps.length, 2);
    assert.equal(f.tables.trust_events.length, 2);
    assert.deepEqual(f.tables.trust_events.map((e) => e.source_id).sort(), f.tables.user_stamps.map((s) => s.id).sort());
  });
});

// ── 3. The chain ─────────────────────────────────────────────────────────────

describe("chain: award → trust_events → runTrustMaintenance → recalculateTrustScore → trust_profiles", () => {
  it("a verified award becomes a profile with passport_authenticity above neutral and evidence measured; a second pass finds nobody dirty", async () => {
    const f = makeFake();
    const r = await award(f);
    assert.equal(r.awarded, true, r.reason);
    await settle();
    assert.equal(f.tables.trust_events.length, 1);
    assert.equal(await getTrustProfile(f.client, OWNER), null, "no profile before the pass");

    const pass = await runTrustMaintenance(f.client);
    assert.equal(pass.eventsSeen, 1);
    assert.equal(pass.usersRecalculated, 1);
    const p = await getTrustProfile(f.client, OWNER);
    assert.ok(p, "the maintenance pass persisted a profile");
    assert.ok(p!.categories.passport_authenticity > 50, `passport_authenticity moved above neutral, got ${p!.categories.passport_authenticity}`);
    assert.equal(p!.evidenceCount, 1, "one stamp is one piece of evidence");
    assert.equal(f.tables.trust_profiles.length, 1);
    assert.equal(f.tables.trust_profiles[0].user_id, OWNER);

    const pass2 = await runTrustMaintenance(f.client);
    assert.equal(pass2.usersRecalculated, 0, "nothing new to score");
    assert.equal((await getTrustProfile(f.client, OWNER))!.categories.passport_authenticity, p!.categories.passport_authenticity);
  });

  it("the delta is the vocabulary's, not the engine's: a forced recompute N times does not compound", async () => {
    const f = makeFake();
    await award(f);
    await settle();
    const a = await recalculateTrustScore(f.client, OWNER);
    const b = await recalculateTrustScore(f.client, OWNER);
    const c = await recalculateTrustScore(f.client, OWNER);
    assert.equal(a.overall_score, b.overall_score);
    assert.equal(b.overall_score, c.overall_score);
    assert.ok(a.categories.passport_authenticity > 50);
  });
});

// ── 4. The flag, fail-closed ─────────────────────────────────────────────────

describe("trust_engine_enabled — respected, and fail-closed", () => {
  it("flag OFF: the award succeeds, nothing is written, nothing is logged as a failure", async () => {
    const f = makeFake();
    f.tables.feature_flags.find((r) => r.flag === "trust_engine_enabled")!.enabled = false;
    const r = await award(f);
    assert.equal(r.awarded, true, r.reason);
    await settle();
    assert.equal(f.tables.user_stamps.length, 1);
    assert.equal(f.tables.trust_events.length, 0);
    assert.equal(engineLog.filter((l) => l.event === "stamp.award.trust_event_failed").length, 0, "flag_off is a skip, not a failure");
  });

  it("flag ROW ABSENT: no default emission", async () => {
    const f = makeFake();
    f.tables.feature_flags = f.tables.feature_flags.filter((r) => r.flag !== "trust_engine_enabled");
    const r = await award(f);
    assert.equal(r.awarded, true, r.reason);
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
  });

  it("flag UNREADABLE (the read resolves { error }): the award succeeds and nothing is written — never a default emission", async () => {
    const f = makeFake();
    // Only the trust flag read fails; the engine's own stamp_system_v2 read must still succeed.
    f.failNext("feature_flags", "select", { code: "57014", message: "canceling statement" },
      (filters) => filters.some(([c, v]) => c === "flag" && v === "trust_engine_enabled"));
    const r = await award(f);
    assert.equal(r.awarded, true, r.reason);
    await settle();
    assert.equal(f.tables.user_stamps.length, 1);
    assert.equal(f.tables.trust_events.length, 0, "an unreadable flag means OFF");
    assert.equal(engineLog.filter((l) => l.event === "stamp.award.trust_event_failed").length, 0, "flag_off (the helper's answer to an unreadable flag) is a skip, not a failure");
  });
});

// ── 5. Non-fatal, not silent ─────────────────────────────────────────────────

describe("a Trust failure never fails the award — and is never silent", () => {
  it("trust_events insert resolves { error }: the stamp is awarded, no event exists, and the engine logs stamp.award.trust_event_failed", async () => {
    const f = makeFake();
    f.failNext("trust_events", "insert", { code: "57014", message: "canceling statement due to statement timeout" });
    const r = await award(f);
    assert.equal(r.awarded, true, r.reason);
    assert.ok(r.userStampId);
    await settle();

    assert.equal(f.tables.user_stamps.length, 1, "the award stands");
    assert.equal(f.tables.trust_events.length, 0, "the ledger write did fail");
    const failed = engineLog.filter((l) => l.event === "stamp.award.trust_event_failed");
    assert.equal(failed.length, 1, `the engine surfaced the failure once, got ${JSON.stringify(engineLog)}`);
    assert.equal(failed[0].user_id, OWNER);
    assert.equal(failed[0].stamp_id, r.userStampId);
    assert.equal(failed[0].definition_slug, DEF_SLUG);
    assert.equal(failed[0].source_type, "trips");
  });

  it("a 23505 from migration 2540's unique index is a dedup, not a failure: nothing is logged as failed", async () => {
    const f = makeFake();
    f.failNext("trust_events", "insert", { code: "23505", message: "duplicate key value violates unique constraint" });
    const r = await award(f);
    assert.equal(r.awarded, true);
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
    assert.equal(engineLog.filter((l) => l.event === "stamp.award.trust_event_failed").length, 0);
  });

  it("the dedup read failing is fail-closed: no event, and not reported by the engine as a failure (the helper says dedup_unverifiable)", async () => {
    const f = makeFake();
    f.failNext("trust_events", "select", { code: "57014", message: "canceling statement" });
    const r = await award(f);
    assert.equal(r.awarded, true);
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
    assert.equal(engineLog.filter((l) => l.event === "stamp.award.trust_event_failed").length, 0);
  });
});

// ── 6. Only a genuine fresh award ────────────────────────────────────────────

describe("only a genuine fresh award emits", () => {
  it("revoke then restore of an awarded stamp adds no stamp_verified event", async () => {
    const f = makeFake();
    const r = await award(f);
    await settle();
    assert.equal(stampVerifiedEvents(f).length, 1);

    const rv = await revokeStamp(f.client, r.userStampId!, ADMIN, "Not legitimately earned");
    assert.equal(rv.revoked, true, rv.reason);
    await settle();
    assert.equal(stampVerifiedEvents(f).length, 1, "revoke charges stamp_disputed, never re-credits stamp_verified");

    const rs = await restoreStamp(f.client, r.userStampId!, ADMIN, "Appeal upheld");
    assert.equal(rs.restored, true, rs.reason);
    await settle();
    assert.equal(stampVerifiedEvents(f).length, 1, "restore re-shows the same stamp; it is not a second verification");
  });

  it("the recalculateForUser backfill re-inserting a lost stamp row writes NO event (it never enters the award path)", async () => {
    const f = makeFake({
      stamp_award_events: [{
        id: "ev-1", user_id: OWNER, stamp_definition_id: DEF_ID, source_type: "trips", source_id: TRIP_ID,
        award_reason: null, admin_id: null, idempotency_key: `${OWNER}:${DEF_ID}:trips:${TRIP_ID}`, status: "awarded",
      }],
    });
    const res = await recalculateForUser(f.client, OWNER);
    assert.equal(res.awarded, 1, "the backfill did re-create the stamp row");
    await settle();
    assert.equal(f.tables.user_stamps.length, 1);
    assert.equal(f.tables.trust_events.length, 0, "a reconciliation is not a fresh verification");
  });

  it("the heal of a partial failure (award event committed, stamp row missing) emits exactly once — it is the FIRST row for that award", async () => {
    const f = makeFake({
      stamp_award_events: [{
        id: "ev-1", user_id: OWNER, stamp_definition_id: DEF_ID, source_type: "trips", source_id: TRIP_ID,
        award_reason: null, admin_id: null, idempotency_key: `${OWNER}:${DEF_ID}:trips:${TRIP_ID}`, status: "awarded",
      }],
    });
    const r = await award(f);
    assert.equal(r.awarded, true, r.reason);
    await settle();
    assert.equal(f.tables.stamp_award_events.length, 1, "no second award event — this was a heal");
    assert.equal(f.tables.user_stamps.length, 1);
    assert.equal(f.tables.trust_events.length, 1);
    assert.equal(f.tables.trust_events[0].source_id, r.userStampId);

    const again = await award(f);
    assert.equal(again.reason, "already_awarded");
    await settle();
    assert.equal(f.tables.trust_events.length, 1, "healed once, scored once");
  });

  it("an award refused before the insert (definition inactive, source cancelled, engine flag off) writes nothing", async () => {
    const f = makeFake();
    f.tables.stamp_definitions[0].is_active = false;
    assert.equal((await award(f)).reason, "definition_inactive");
    f.tables.stamp_definitions[0].is_active = true;
    f.tables.trips[0].status = "cancelled";
    assert.match((await award(f)).reason, /^source_invalid_status/);
    f.tables.trips[0].status = "completed";
    f.tables.feature_flags.find((r) => r.flag === "stamp_system_v2_enabled")!.enabled = false;
    assert.equal((await award(f)).reason, "feature_disabled");
    await settle();
    assert.equal(f.tables.user_stamps.length, 0);
    assert.equal(f.tables.trust_events.length, 0);
  });
});
