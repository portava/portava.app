/**
 * The layover audit retention sweep and migration 3621 — census-layover L163,
 * OD-MAP-4's "then delete it", and the schema that keeps a departed traveller's
 * layover_events pseudonymised and bounded.
 *
 * Sweep (lib/layoverAuditRetentionScheduler.ts): deletes pseudonymised rows
 * whose retain_until has passed, never a named row and never one still inside
 * its window; a missing 3621 is inert, a failed read is a failure, not "0 due".
 * Migration (3621): the session FK becomes SET NULL, user and session become
 * nullable, and the identity-or-pseudonym CHECK refuses a half-identified row
 * and a retention past 12 months; the postconditions are the last statement.
 *
 * Run: node --import tsx/esm --test src/test/layoverAuditRetention.test.ts
 */
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runLayoverAuditRetentionSweep, runLayoverAuditRetentionTick, getLayoverAuditRetentionStatus, _resetLayoverAuditRetentionStatus, startLayoverAuditRetentionScheduler, stopLayoverAuditRetentionScheduler, LAYOVER_AUDIT_RETENTION_INTERVAL_MS } from "../lib/layoverAuditRetentionScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

type Row = Record<string, any>;
const NOW = new Date("2027-10-08T00:00:00.000Z");

function fakeDb(rows: Row[], opts: { schema?: boolean; failProbe?: boolean; failRead?: boolean; failDelete?: boolean } = {}) {
  const deleted: string[] = [];
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "delete" = "select";
    let head = false;
    let limitN: number | null = null;
    let cols = "";
    const run = async () => {
      if (table !== "layover_events") throw new Error(`unexpected table ${table}`);
      if (opts.schema === false && cols.includes("retain_until") && head) return { data: null, error: { code: "42703", message: "column retain_until does not exist" } };
      if (opts.failProbe && cols.includes("retain_until") && head) return { data: null, error: { code: "08006", message: "connection failure" } };
      if (op === "select" && head) return { data: null, error: null };
      if (op === "select" && opts.failRead) return { data: null, error: { code: "57014", message: "timeout" } };
      if (op === "delete" && opts.failDelete) return { data: null, error: { code: "42501", message: "denied" } };
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "select") {
        hit = [...hit].sort((a, b) => String(a.retain_until).localeCompare(String(b.retain_until)));
        if (limitN !== null) hit = hit.slice(0, limitN);
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      for (const r of hit) { deleted.push(r.id); rows.splice(rows.indexOf(r), 1); }
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    };
    const b: any = {
      select(c: string, o?: { head?: boolean }) { cols = c; head = o?.head === true; return b; },
      delete() { op = "delete"; return b; },
      not(c: string, o: string, v: unknown) { assert.equal(o, "is"); filters.push((r) => (r[c] ?? null) !== v); return b; },
      lt(c: string, v: string) { filters.push((r) => r[c] != null && String(r[c]) < v); return b; },
      in(c: string, vs: string[]) { filters.push((r) => vs.includes(r[c])); return b; },
      order() { return b; },
      limit(n: number) { limitN = n; return b; },
      then(f: any, r: any) { return run().then(f, r); },
    };
    return b;
  }
  return { from, deleted };
}

const named = (id: string): Row => ({ id, user_id: "u", session_id: "s", pseudonymised_at: null, retain_until: null });
const pseudo = (id: string, retainUntil: string): Row => ({ id, user_id: null, session_id: null, pseudonymised_at: "2026-10-07T00:00:00.000Z", retain_until: retainUntil });

describe("layover audit retention sweep (OD-MAP-4: then delete it)", () => {
  it("deletes pseudonymised rows past retain_until, and only those", async () => {
    const rows = [named("n1"), pseudo("p-due", "2027-10-07T00:00:00.000Z"), pseudo("p-later", "2027-10-09T00:00:00.000Z")];
    const db = fakeDb(rows);
    const r = await runLayoverAuditRetentionSweep({ client: db, now: NOW });
    assert.deepEqual(r, { outcome: "swept", reason: null, deleted: 1, complete: true });
    assert.deepEqual(db.deleted, ["p-due"]);
    assert.deepEqual(rows.map((x) => x.id).sort(), ["n1", "p-later"]);
  });

  it("a named row whose retain_until were somehow past is never deleted", async () => {
    const rows = [{ ...named("n-odd"), retain_until: "2020-01-01T00:00:00.000Z" }];
    const db = fakeDb(rows);
    const r = await runLayoverAuditRetentionSweep({ client: db, now: NOW });
    assert.equal(r.outcome, "idle");
    assert.deepEqual(db.deleted, []);
  });

  it("nothing due is IDLE; a full batch is not complete", async () => {
    assert.equal((await runLayoverAuditRetentionSweep({ client: fakeDb([named("n")]), now: NOW })).outcome, "idle");
    const rows = [pseudo("a", "2027-01-01T00:00:00.000Z"), pseudo("b", "2027-02-01T00:00:00.000Z"), pseudo("c", "2027-03-01T00:00:00.000Z")];
    const r = await runLayoverAuditRetentionSweep({ client: fakeDb(rows), now: NOW, batchSize: 2 });
    assert.deepEqual(r, { outcome: "swept", reason: null, deleted: 2, complete: false });
  });

  it("without 3621 the sweep is inert (refused, schema_absent) and deletes nothing", async () => {
    const db = fakeDb([pseudo("p", "2020-01-01T00:00:00.000Z")], { schema: false });
    assert.deepEqual(await runLayoverAuditRetentionSweep({ client: db, now: NOW }), { outcome: "refused", reason: "schema_absent", deleted: 0, complete: false });
    assert.deepEqual(db.deleted, []);
  });

  it("a probe that fails for any reason but a MISSING COLUMN is FAILED (probe_failed), not 'schema absent'", async () => {
    const db = fakeDb([pseudo("p", "2020-01-01T00:00:00.000Z")], { failProbe: true });
    assert.deepEqual(await runLayoverAuditRetentionSweep({ client: db, now: NOW }), { outcome: "failed", reason: "probe_failed", deleted: 0, complete: false });
    assert.deepEqual(db.deleted, []);
    const throwing = { from() { throw new Error("socket"); } };
    assert.equal((await runLayoverAuditRetentionSweep({ client: throwing, now: NOW })).reason, "probe_failed");
  });

  it("a failed read is FAILED, never 'nothing due'; a failed delete is FAILED", async () => {
    assert.equal((await runLayoverAuditRetentionSweep({ client: fakeDb([], { failRead: true }), now: NOW })).reason, "read_failed");
    const r = await runLayoverAuditRetentionSweep({ client: fakeDb([pseudo("p", "2020-01-01T00:00:00.000Z")], { failDelete: true }), now: NOW });
    assert.deepEqual(r, { outcome: "failed", reason: "delete_failed", deleted: 0, complete: false });
  });

  it("no client is refused, and the tick never rejects", async () => {
    assert.equal((await runLayoverAuditRetentionSweep({ client: null, now: NOW })).reason, "no_client");
    const throwing = { from() { throw new Error("socket"); } };
    const r = await runLayoverAuditRetentionTick({ client: throwing, now: NOW });
    assert.equal(r.outcome, "failed", "a throw is a failure, not a refusal that names a cause it did not have");
  });
});

describe("what GET /healthz/schedulers reads for this job (job 'layoverAuditRetention')", () => {
  it("a swept or idle tick is a SUCCESS and clears the failure count", async () => {
    _resetLayoverAuditRetentionStatus();
    await runLayoverAuditRetentionTick({ client: fakeDb([], { failRead: true }), now: NOW });
    assert.equal(getLayoverAuditRetentionStatus().consecutiveFailures, 1);
    await runLayoverAuditRetentionTick({ client: fakeDb([pseudo("p", "2020-01-01T00:00:00.000Z")]), now: NOW });
    const s = getLayoverAuditRetentionStatus();
    assert.deepEqual([s.lastOutcome, s.lastDeleted, s.consecutiveFailures, s.lastSuccessAt, s.lastAttemptAt], ["swept", 1, 0, NOW.toISOString(), NOW.toISOString()]);
  });

  it("a failed read, a failed delete, no client, a throw and a failed probe each COUNT, and none is a success", async () => {
    _resetLayoverAuditRetentionStatus();
    await runLayoverAuditRetentionTick({ client: fakeDb([], { failRead: true }), now: NOW });
    await runLayoverAuditRetentionTick({ client: fakeDb([pseudo("p", "2020-01-01T00:00:00.000Z")], { failDelete: true }), now: NOW });
    await runLayoverAuditRetentionTick({ client: null, now: NOW });
    await runLayoverAuditRetentionTick({ client: { from() { throw new Error("socket"); } }, now: NOW });
    await runLayoverAuditRetentionTick({ client: fakeDb([], { failProbe: true }), now: NOW });
    const s = getLayoverAuditRetentionStatus();
    assert.equal(s.consecutiveFailures, 5);
    assert.equal(s.lastSuccessAt, null);
    assert.equal(s.lastAttemptAt, NOW.toISOString(), "the attempt is recorded even when the pass fails");
  });

  it("a sweep that THROWS after the probe (the tick's own catch) counts as a failure", async () => {
    _resetLayoverAuditRetentionStatus();
    const ok = fakeDb([]);
    let calls = 0;
    const flaky = { from(t: string) { calls += 1; if (calls === 1) return ok.from(t); throw new Error("socket closed mid-sweep"); } };
    const r = await runLayoverAuditRetentionTick({ client: flaky, now: NOW });
    assert.equal(r.outcome, "failed");
    const s = getLayoverAuditRetentionStatus();
    assert.deepEqual([s.consecutiveFailures, s.lastOutcome, s.lastSuccessAt], [1, "failed", null]);
  });

  it("without 3621 a tick is neither a success nor a failure: the attempt shows, the reason says why", async () => {
    _resetLayoverAuditRetentionStatus();
    await runLayoverAuditRetentionTick({ client: fakeDb([], { schema: false }), now: NOW });
    const s = getLayoverAuditRetentionStatus();
    assert.deepEqual([s.lastOutcome, s.lastReason, s.consecutiveFailures, s.lastSuccessAt], ["refused", "schema_absent", 0, null]);
    assert.equal(s.lastAttemptAt, NOW.toISOString());
  });
});

// ── The timer: when the sweep runs, and that stop() means stop ──────────────
// The same contract tests/schedulerStopDuringRun.test.ts pins on the schedulers
// that once hung the suite: one timer per start, the first pass after the
// startup delay, one pass per interval after it, and a stop() that lands while
// a pass is in flight is never followed by that pass arming another timer.

/** lib/layoverAuditRetentionScheduler.ts's STARTUP_DELAY_MS (not exported). */
const STARTUP_DELAY_MS = 90_000;

async function drain() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

/** A service client that counts sweeps (one probe per sweep); `pending` holds the probe until released. */
function timerClient(pending = false) {
  let release!: () => void;
  const gate = pending ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
  let probes = 0;
  const from = () => {
    let head = false;
    const b: any = {
      select(_c: string, o?: { head?: boolean }) { head = o?.head === true; if (head) probes += 1; return b; },
      not: () => b, lt: () => b, order: () => b, in: () => b, delete: () => b, limit: () => b,
      then(f: any, r: any) { return (head ? gate : Promise.resolve()).then(() => (head ? { data: null, error: null } : { data: [], error: null })).then(f, r); },
    };
    return b;
  };
  return { client: { from } as any, release: () => release?.(), probes: () => probes };
}

describe("the retention sweep's timer (startLayoverAuditRetentionScheduler)", () => {
  afterEach(() => {
    stopLayoverAuditRetentionScheduler();
    _resetLayoverAuditRetentionStatus();
    mock.timers.reset();
    _setTestServiceClient(null as any);
  });

  it("first sweep after the startup delay, then one per interval; a second start() arms nothing", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const c = timerClient(); _setTestServiceClient(c.client);
    startLayoverAuditRetentionScheduler();
    startLayoverAuditRetentionScheduler();
    mock.timers.tick(STARTUP_DELAY_MS - 1); await drain();
    assert.equal(c.probes(), 0, "nothing runs before the startup delay");
    mock.timers.tick(1); await drain();
    assert.equal(c.probes(), 1, "one sweep at the startup delay, not two (the second start() is a no-op)");
    assert.equal(getLayoverAuditRetentionStatus().lastOutcome, "idle");
    mock.timers.tick(LAYOVER_AUDIT_RETENTION_INTERVAL_MS - 1); await drain();
    assert.equal(c.probes(), 1);
    mock.timers.tick(1); await drain();
    assert.equal(c.probes(), 2, "the next sweep one interval later");
  });

  it("stop() while a sweep is in flight: the sweep settles and arms NOTHING, however long the clock runs", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const c = timerClient(true); _setTestServiceClient(c.client);
    startLayoverAuditRetentionScheduler();
    mock.timers.tick(STARTUP_DELAY_MS); await drain();
    assert.equal(c.probes(), 1, "the first sweep is in flight");
    stopLayoverAuditRetentionScheduler();
    c.release(); await drain();
    mock.timers.tick(LAYOVER_AUDIT_RETENTION_INTERVAL_MS * 5); await drain();
    assert.equal(c.probes(), 1, "a sweep that settled after stop() must not schedule another");
  });
});

const MIGRATION = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../migrations/3621_layover_erasure_audit_pseudonym.sql"), "utf8");
const code = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("migration 3621 — the shape that keeps the audit record pseudonymised and bounded", () => {
  it("is one transaction whose postconditions are the LAST statement", () => {
    const begin = code.indexOf("BEGIN;");
    const end = code.indexOf("END $post$;");
    const commit = code.lastIndexOf("COMMIT;");
    assert.ok(begin >= 0 && end > begin && commit > end);
    assert.equal(code.slice(end + "END $post$;".length, commit).trim(), "");
  });
  it("the session FK becomes ON DELETE SET NULL and user/session become nullable", () => {
    assert.match(code, /DROP CONSTRAINT layover_events_session_id_fkey;/);
    assert.match(code, /FOREIGN KEY \(session_id\) REFERENCES public\.layover_sessions\(id\) ON DELETE SET NULL;/);
    assert.match(code, /ALTER COLUMN user_id\s+DROP NOT NULL/);
    assert.match(code, /ALTER COLUMN session_id DROP NOT NULL/);
  });
  it("the CHECK allows only a named row or a fully pseudonymised one, kept at most 12 months", () => {
    const check = code.slice(code.indexOf("layover_events_identity_or_pseudonym CHECK"), code.indexOf("CREATE INDEX"));
    assert.match(check, /pseudonymised_at IS NULL\s+AND user_id IS NOT NULL\s+AND erasure_pseudonym IS NULL AND retain_until IS NULL/);
    assert.match(check, /pseudonymised_at IS NOT NULL\s+AND user_id IS NULL AND session_id IS NULL\s+AND erasure_pseudonym IS NOT NULL\s+AND retain_until IS NOT NULL\s+AND retain_until <= pseudonymised_at \+ INTERVAL '12 months'/);
  });
  it("its rollback deletes the pseudonymised rows BEFORE restoring NOT NULL (they cannot satisfy it), restores CASCADE, and checks both last", () => {
    const rb = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../db/rollback/2026-10-07-3621-layover-erasure-audit-pseudonym-rollback.sql"), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const del = rb.indexOf("DELETE FROM public.layover_events WHERE pseudonymised_at IS NOT NULL;");
    const notNullUser = rb.search(/ALTER COLUMN user_id\s+SET NOT NULL/);
    const notNullSession = rb.search(/ALTER COLUMN session_id\s+SET NOT NULL/);
    assert.ok(del >= 0, "the rollback must remove the rows a NOT NULL user/session cannot hold");
    assert.ok(notNullUser > del && notNullSession > del, "NOT NULL is restored only after those rows are gone");
    assert.match(rb, /FOREIGN KEY \(session_id\) REFERENCES public\.layover_sessions\(id\) ON DELETE CASCADE;/);
    const end = rb.indexOf("END $post$;");
    assert.ok(end > notNullSession && rb.slice(end + "END $post$;".length, rb.lastIndexOf("COMMIT;")).trim() === "", "postconditions are the last statement");
    assert.match(rb.slice(rb.indexOf("DO $post$"), end), /IS DISTINCT FROM 'c'/);
  });
  it("grants nothing, and its postconditions refuse a client that could write or read the record anonymously", () => {
    assert.doesNotMatch(code, /\bGRANT\b/);
    assert.match(code, /has_table_privilege\('authenticated', 'public\.layover_events', 'UPDATE'\)/);
    assert.match(code, /has_table_privilege\('anon', 'public\.layover_events', 'SELECT'\)/);
    assert.match(code, /confdeltype/);
  });
});
