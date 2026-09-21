/**
 * Event lifecycle — the transition into `started` (lib/eventLifecycle.ts,
 * migration 2600, and the POST /events/:id/complete gate it opens).
 *
 * Pins, in this order:
 *   1. The pure rule: only open | full | waitlist with a non-null, parseable,
 *      due starts_at start; draft / cancelled / archived / completed / started
 *      never do, whatever their starts_at.
 *   2. Gated off is inert: flag FALSE, flag row ABSENT, flag read erroring,
 *      flag read throwing — each makes exactly one feature_flags read, reads
 *      no events, writes nothing.
 *   3. Gated on: a mixed fixture — only the eligible rows move; every other
 *      row is byte-identical afterwards; each transition leaves one audit row.
 *   4. Idempotency: a second pass over the same table changes nothing.
 *   5. The due-events read RESOLVING with `.error` is reason=error with zero
 *      writes — distinguishable from a clean "no events" pass.
 *   6. An update that resolves with `.error` is counted as failed, the pass
 *      continues, and the row is not reported as started.
 *   7. A state change between read and write (cancel racing the scheduler) is
 *      not overwritten.
 *   8. The scheduler arms once and stops.
 *   9. 2600 seeds the flag FALSE under the name the module reads.
 *  10. Route level: POST /events/:id/complete refuses an `open` event, the
 *      pass moves it to `started`, and the same request then succeeds — the
 *      path that was impossible becoming possible. And the complete route's
 *      own UPDATE `.error` is checked (db_error, state unchanged), not read
 *      as success.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventLifecycle.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { Server } from "node:http";
import {
  decideEventStart,
  runEventStartPass,
  startEventLifecycleScheduler,
  stopEventLifecycleScheduler,
  _eventLifecycleSchedulerArmed,
  EVENT_START_TRANSITION_FLAG,
  EVENT_STARTABLE_STATES,
  EVENT_STARTED_STATE,
  EVENT_STARTED_ACTIVITY_ACTION,
} from "../lib/eventLifecycle.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read2600 = () =>
  readFileSync(path.join(here, "../migrations/2600_event_start_transition_flag.sql"), "utf8");

const NOW = new Date("2026-09-07T12:00:00.000Z");
const PAST = "2026-09-07T11:00:00.000Z";
const FUTURE = "2026-09-07T13:00:00.000Z";
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

// ── In-memory fake: only what the pass and the complete route touch ──────────

type Row = Record<string, any>;

interface FakeCfg {
  /** undefined = no flag row at all (maybeSingle → data:null). */
  flag?: boolean | "error" | "throw";
  events?: Row[];
  /** The due-events read resolves with this `.error`. */
  eventsReadError?: { message: string } | null;
  /** The due-events read rejects. */
  eventsReadThrows?: boolean;
  /** UPDATE on these event ids resolves with `.error`. */
  updateErrorFor?: Set<string>;
  /** Called with the table before an UPDATE is applied — used to race the pass. */
  onBeforeUpdate?: (events: Row[], id: string) => void;
  extraTables?: Record<string, Row[]>;
}

function makeFake(cfg: FakeCfg = {}) {
  const tables: Record<string, Row[]> = {
    feature_flags: [],
    events: (cfg.events ?? []).map((r) => ({ ...r })),
    event_activity_log: [],
    profiles: [],
    event_roles: [],
    event_attendee_states: [],
    ...(cfg.extraTables ?? {}),
  };
  if (typeof cfg.flag === "boolean") tables.feature_flags.push({ flag: EVENT_START_TRANSITION_FLAG, enabled: cfg.flag });
  const calls: Array<{ table: string; op: string; args?: unknown }> = [];

  function chain(table: string) {
    let filtered: Row[] = [...(tables[table] ?? [])];
    let op: "select" | "update" | "insert" = "select";
    let patch: Row | null = null;
    let insertRows: Row[] = [];
    let limitN: number | null = null;
    let flagLookup: string | null = null;
    let eqId: string | null = null;

    const applyPending = (): { data: any; error: any } => {
      if (op === "insert") {
        for (const r of insertRows) tables[table].push({ id: `fake-${tables[table].length + 1}`, ...r });
        return { data: insertRows, error: null };
      }
      if (op === "update") {
        if (cfg.onBeforeUpdate && table === "events" && eqId) cfg.onBeforeUpdate(tables.events, eqId);
        if (cfg.updateErrorFor && eqId && cfg.updateErrorFor.has(eqId)) {
          return { data: null, error: { message: `update refused for ${eqId}` } };
        }
        // Re-filter against the CURRENT table (the UPDATE's WHERE runs at write time).
        const ids = new Set(filtered.map((r) => r.id));
        const changed: Row[] = [];
        for (const row of tables[table]) {
          if (!ids.has(row.id)) continue;
          if (!lastIn || lastIn.vals.includes(row[lastIn.col])) {
            Object.assign(row, patch);
            changed.push(row);
          }
        }
        return { data: changed, error: null };
      }
      return { data: null, error: null };
    };

    let lastIn: { col: string; vals: any[] } | null = null;
    const b: any = {
      select() { return b; },
      insert(rows: Row | Row[]) { op = "insert"; insertRows = Array.isArray(rows) ? rows : [rows]; calls.push({ table, op: "insert", args: insertRows }); return b; },
      update(p: Row) { op = "update"; patch = p; calls.push({ table, op: "update", args: p }); return b; },
      eq(col: string, val: any) { if (col === "flag") flagLookup = val; if (col === "id") eqId = val; filtered = filtered.filter((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { lastIn = { col, vals: [...vals] }; filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      not(col: string, o: string, val: any) { if (o === "is" && val === null) filtered = filtered.filter((r) => r[col] !== null && r[col] !== undefined); return b; },
      lte(col: string, val: any) { filtered = filtered.filter((r) => r[col] != null && r[col] <= val); return b; },
      gte() { return b; }, lt() { return b; }, gt() { return b; }, neq() { return b; }, is() { return b; }, or() { return b; }, ilike() { return b; },
      order() { return b; },
      limit(n: number) { limitN = n; return b; },
      range() { return b; },
      maybeSingle() {
        if (table === "feature_flags" && flagLookup === EVENT_START_TRANSITION_FLAG) {
          if (cfg.flag === "throw") return Promise.reject(new Error("flags unreachable"));
          if (cfg.flag === "error") return Promise.resolve({ data: null, error: { message: "relation missing" } });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() { return Promise.resolve(filtered[0] ? { data: filtered[0], error: null } : { data: null, error: { message: "No rows" } }); },
      then(res: any, rej: any) {
        if (op === "select" && table === "events") {
          calls.push({ table, op: "select" });
          if (cfg.eventsReadThrows) return Promise.reject(new Error("socket hang up")).then(res, rej);
          if (cfg.eventsReadError) return Promise.resolve({ data: null, error: cfg.eventsReadError }).then(res, rej);
        }
        if (op === "select") {
          const data = limitN !== null ? filtered.slice(0, limitN) : filtered;
          return Promise.resolve({ data, error: null }).then(res, rej);
        }
        return Promise.resolve(applyPending()).then(res, rej);
      },
    };
    return b;
  }

  return {
    from(table: string) {
      calls.push({ table, op: "from" });
      if (!tables[table]) tables[table] = [];
      return chain(table);
    },
    auth: {
      getUser: async (token: string) => {
        const id = token.startsWith("fake-token-") ? token.slice("fake-token-".length) : null;
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "bad token" } };
      },
    },
    _tables: tables,
    _calls: calls,
    _writes() { return calls.filter((c) => c.op === "update" || c.op === "insert"); },
    _eventReads() { return calls.filter((c) => c.table === "events" && c.op === "select"); },
  };
}

const ev = (id: string, state: string, starts_at: string | null, extra: Row = {}): Row =>
  ({ id, state, starts_at, updated_at: "2026-09-01T00:00:00.000Z", title: `E ${id}`, host_id: uuid(900), ...extra });

// ── 1. The pure rule ──────────────────────────────────────────────────────────

describe("decideEventStart — the pure transition rule", () => {
  it("exports the derivation the header claims: startable = open|full|waitlist, target = started", () => {
    assert.deepEqual([...EVENT_STARTABLE_STATES], ["open", "full", "waitlist"]);
    assert.equal(EVENT_STARTED_STATE, "started");
    assert.equal(EVENT_START_TRANSITION_FLAG, "event_start_transition_enabled");
  });

  it("starts each startable state with a due starts_at, and reports which state it came from", () => {
    for (const state of EVENT_STARTABLE_STATES) {
      assert.deepEqual(decideEventStart({ state, starts_at: PAST }, NOW), { start: true, from: state }, state);
      assert.deepEqual(decideEventStart({ state, starts_at: NOW.toISOString() }, NOW), { start: true, from: state }, `${state} at exactly now`);
      assert.deepEqual(decideEventStart({ state, starts_at: new Date(PAST) }, NOW), { start: true, from: state }, `${state} Date input`);
    }
  });

  it("never starts draft, cancelled, archived, completed or started — even with a due starts_at", () => {
    for (const state of ["draft", "cancelled", "archived", "completed", "started", "", "OPEN", "nonsense"]) {
      assert.deepEqual(decideEventStart({ state, starts_at: PAST }, NOW), { start: false, reason: "not_startable_state" }, JSON.stringify(state));
    }
    assert.deepEqual(decideEventStart({ state: null, starts_at: PAST }, NOW), { start: false, reason: "not_startable_state" });
    assert.deepEqual(decideEventStart({ state: 42, starts_at: PAST }, NOW), { start: false, reason: "not_startable_state" });
  });

  it("a NULL / missing / empty starts_at is never due (production has one such open event)", () => {
    assert.deepEqual(decideEventStart({ state: "open", starts_at: null }, NOW), { start: false, reason: "no_starts_at" });
    assert.deepEqual(decideEventStart({ state: "open", starts_at: undefined }, NOW), { start: false, reason: "no_starts_at" });
    assert.deepEqual(decideEventStart({ state: "open", starts_at: "" }, NOW), { start: false, reason: "no_starts_at" });
  });

  it("an unparseable starts_at is refused, not treated as the epoch", () => {
    assert.deepEqual(decideEventStart({ state: "open", starts_at: "not a date" }, NOW), { start: false, reason: "unparseable_starts_at" });
  });

  it("a future starts_at is not yet due, by one millisecond", () => {
    const oneMsLater = new Date(NOW.getTime() + 1).toISOString();
    assert.deepEqual(decideEventStart({ state: "open", starts_at: oneMsLater }, NOW), { start: false, reason: "not_yet_due" });
    assert.deepEqual(decideEventStart({ state: "open", starts_at: FUTURE }, NOW), { start: false, reason: "not_yet_due" });
  });
});

// ── 2. Gated off is inert ────────────────────────────────────────────────────

describe("runEventStartPass — gated off", () => {
  const dueFixture = [ev(uuid(1), "open", PAST), ev(uuid(2), "full", PAST)];

  it("no client → no_client, nothing called", async () => {
    const r = await runEventStartPass({ client: null, now: NOW });
    assert.equal(r.reason, "no_client");
    assert.equal(r.skipped, true);
    assert.equal(r.started, 0);
  });

  for (const [label, flag] of [
    ["flag FALSE", false],
    ["flag row ABSENT", undefined],
    ["flag read resolves with .error", "error"],
    ["flag read throws", "throw"],
  ] as const) {
    it(`${label} → exactly one feature_flags read, zero events reads, zero writes, every row untouched`, async () => {
      const db = makeFake({ flag: flag as any, events: dueFixture });
      const before = JSON.stringify(db._tables.events);
      const r = await runEventStartPass({ client: db, now: NOW });
      assert.equal(r.reason, "disabled", label);
      assert.equal(r.skipped, true, label);
      assert.equal(r.scanned, 0, label);
      assert.deepEqual(db._calls.filter((c) => c.op === "from").map((c) => c.table), ["feature_flags"], label);
      assert.deepEqual(db._eventReads(), [], label);
      assert.deepEqual(db._writes(), [], label);
      assert.equal(JSON.stringify(db._tables.events), before, `${label}: table changed while gated off`);
    });
  }
});

// ── 3–7. Gated on ────────────────────────────────────────────────────────────

describe("runEventStartPass — gated on", () => {
  function mixedFixture(): Row[] {
    return [
      ev(uuid(1), "open", PAST),                 // due → started
      ev(uuid(2), "full", PAST),                 // due → started
      ev(uuid(3), "waitlist", PAST),             // due → started
      ev(uuid(4), "open", FUTURE),               // not yet
      ev(uuid(5), "open", null),                 // no starts_at (production has one)
      ev(uuid(6), "draft", PAST),                // never
      ev(uuid(7), "cancelled", PAST),            // never
      ev(uuid(8), "archived", PAST),             // never
      ev(uuid(9), "completed", PAST),            // never
      ev(uuid(10), "started", PAST),             // already there; never re-written
    ];
  }

  it("only the eligible rows move; every other row is byte-identical; each transition leaves one audit row", async () => {
    const db = makeFake({ flag: true, events: mixedFixture() });
    const before = new Map(db._tables.events.map((r) => [r.id, JSON.stringify(r)]));

    const r = await runEventStartPass({ client: db, now: NOW });
    assert.equal(r.skipped, false);
    assert.equal(r.reason, null);
    assert.equal(r.scanned, 3, "the due-set read returns exactly the three eligible rows");
    assert.equal(r.started, 3);
    assert.equal(r.refused, 0);
    assert.equal(r.contended, 0);
    assert.equal(r.failed, 0);

    const byId = new Map(db._tables.events.map((r) => [r.id, r]));
    for (const id of [uuid(1), uuid(2), uuid(3)]) {
      assert.equal(byId.get(id)!.state, "started", id);
      assert.equal(byId.get(id)!.updated_at, NOW.toISOString(), `${id} updated_at is the pass clock`);
    }
    for (const id of [uuid(4), uuid(5), uuid(6), uuid(7), uuid(8), uuid(9), uuid(10)]) {
      assert.equal(JSON.stringify(byId.get(id)), before.get(id), `${id} must be untouched`);
    }

    const audit = db._tables.event_activity_log;
    assert.equal(audit.length, 3);
    assert.deepEqual(audit.map((a) => a.event_id).sort(), [uuid(1), uuid(2), uuid(3)]);
    for (const a of audit) {
      assert.equal(a.action, EVENT_STARTED_ACTIVITY_ACTION);
      assert.equal(a.actor_id, null, "a scheduler transition has no actor");
      assert.equal(a.metadata.source, EVENT_START_TRANSITION_FLAG);
      assert.ok(["open", "full", "waitlist"].includes(a.metadata.from_state));
    }
    // The UPDATE is conditional on the state still being startable.
    const upd = db._calls.filter((c) => c.op === "update");
    assert.equal(upd.length, 3);
    for (const u of upd) assert.deepEqual(u.args, { state: "started", updated_at: NOW.toISOString() });
  });

  it("is idempotent: a second pass over the same table scans nothing and writes nothing", async () => {
    const db = makeFake({ flag: true, events: mixedFixture() });
    const first = await runEventStartPass({ client: db, now: NOW });
    assert.equal(first.started, 3);
    const snapshot = JSON.stringify(db._tables.events);
    const writesAfterFirst = db._writes().length;

    const second = await runEventStartPass({ client: db, now: NOW });
    assert.equal(second.skipped, false);
    assert.equal(second.scanned, 0);
    assert.equal(second.started, 0);
    assert.equal(db._writes().length, writesAfterFirst, "no write on the second pass");
    assert.equal(JSON.stringify(db._tables.events), snapshot);
    assert.equal(db._tables.event_activity_log.length, 3, "no second audit row per event");
  });

  it("a clean pass with nothing due is NOT an error: reason null, skipped false, scanned 0", async () => {
    const db = makeFake({ flag: true, events: [ev(uuid(4), "open", FUTURE)] });
    const r = await runEventStartPass({ client: db, now: NOW });
    assert.deepEqual(r, { skipped: false, reason: null, scanned: 0, started: 0, refused: 0, contended: 0, failed: 0, lastError: null });
  });

  it("due-events read RESOLVES with .error → reason=error, zero writes (never read as 'no events')", async () => {
    const db = makeFake({ flag: true, events: mixedFixture(), eventsReadError: { message: 'column "starts_at" does not exist' } });
    const before = JSON.stringify(db._tables.events);
    const r = await runEventStartPass({ client: db, now: NOW });
    assert.equal(r.reason, "error");
    assert.equal(r.skipped, true);
    assert.equal(r.scanned, 0);
    assert.match(r.lastError ?? "", /starts_at/);
    assert.deepEqual(db._writes(), []);
    assert.equal(JSON.stringify(db._tables.events), before);
  });

  it("due-events read throws → reason=error, does not throw, zero writes", async () => {
    const db = makeFake({ flag: true, events: mixedFixture(), eventsReadThrows: true });
    const r = await runEventStartPass({ client: db, now: NOW });
    assert.equal(r.reason, "error");
    assert.equal(r.lastError, "socket hang up");
    assert.deepEqual(db._writes(), []);
  });

  it("an UPDATE that resolves with .error is counted failed and not started; the pass continues to the next row", async () => {
    const db = makeFake({ flag: true, events: mixedFixture(), updateErrorFor: new Set([uuid(2)]) });
    const r = await runEventStartPass({ client: db, now: NOW });
    assert.equal(r.skipped, false);
    assert.equal(r.scanned, 3);
    assert.equal(r.started, 2);
    assert.equal(r.failed, 1);
    assert.match(r.lastError ?? "", /refused for/);
    const byId = new Map(db._tables.events.map((x) => [x.id, x]));
    assert.equal(byId.get(uuid(1))!.state, "started");
    assert.equal(byId.get(uuid(2))!.state, "full", "the failed row keeps its prior state");
    assert.equal(byId.get(uuid(3))!.state, "started");
    assert.equal(db._tables.event_activity_log.length, 2, "no audit row for a failed transition");
  });

  it("a cancel that lands between the read and the write wins: the row is reported contended, not started", async () => {
    const db = makeFake({
      flag: true,
      events: [ev(uuid(1), "open", PAST), ev(uuid(2), "open", PAST)],
      onBeforeUpdate(events, id) {
        if (id === uuid(2)) { const row = events.find((x) => x.id === id)!; row.state = "cancelled"; }
      },
    });
    const r = await runEventStartPass({ client: db, now: NOW });
    assert.equal(r.scanned, 2);
    assert.equal(r.started, 1);
    assert.equal(r.contended, 1);
    const byId = new Map(db._tables.events.map((x) => [x.id, x]));
    assert.equal(byId.get(uuid(1))!.state, "started");
    assert.equal(byId.get(uuid(2))!.state, "cancelled", "a concurrent cancel must not be overwritten");
    assert.equal(db._tables.event_activity_log.length, 1);
  });

  it("the read predicate mirrors the rule: a row the query returns but the rule refuses is reported, not started", async () => {
    // Force the read to hand back a row the rule rejects (simulates predicate drift).
    const db = makeFake({ flag: true, events: [ev(uuid(1), "open", PAST)] });
    const realFrom = db.from.bind(db);
    (db as any).from = (t: string) => {
      const b = realFrom(t);
      if (t === "events") {
        const realThen = b.then;
        b.then = (res: any, rej: any) => realThen((r: any) => {
          if (Array.isArray(r.data)) r.data = r.data.map((x: Row) => ({ ...x, starts_at: FUTURE }));
          return r;
        }, rej).then(res, rej);
      }
      return b;
    };
    const r = await runEventStartPass({ client: db, now: NOW });
    assert.equal(r.scanned, 1);
    assert.equal(r.refused, 1);
    assert.equal(r.started, 0);
    assert.equal(db._tables.events[0].state, "open");
  });

  it("limit is clamped to [1, 1000]", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ev(uuid(100 + i), "open", PAST));
    const db = makeFake({ flag: true, events: many });
    const r = await runEventStartPass({ client: db, now: NOW, limit: 0 });
    assert.equal(r.scanned, 1, "limit 0 clamps to 1");
    assert.equal(r.started, 1);
  });
});

// ── 8. Scheduler ─────────────────────────────────────────────────────────────

describe("event lifecycle scheduler", () => {
  afterEach(() => stopEventLifecycleScheduler());

  it("arms once, is idempotent to a second start, and stops", () => {
    assert.equal(_eventLifecycleSchedulerArmed(), false);
    startEventLifecycleScheduler();
    assert.equal(_eventLifecycleSchedulerArmed(), true);
    startEventLifecycleScheduler();
    assert.equal(_eventLifecycleSchedulerArmed(), true);
    stopEventLifecycleScheduler();
    assert.equal(_eventLifecycleSchedulerArmed(), false);
  });
});

// ── 9. Migration 2600 ────────────────────────────────────────────────────────

describe("migration 2600", () => {
  it("seeds exactly the flag the module reads, FALSE, ON CONFLICT DO NOTHING, and refuses a database whose enum lacks 'started'", () => {
    const sql = read2600();
    assert.match(sql, new RegExp(`\\('${EVENT_START_TRANSITION_FLAG}', false,`));
    assert.match(sql, /ON CONFLICT \(flag\) DO NOTHING/);
    assert.match(sql, /enumlabel = 'started'/);
    assert.match(sql, /to_regclass\('public\.event_activity_log'\)/);
    // No DDL, no data change beyond the one seed row.
    const code = sql.replace(/--[^\n]*/g, "");
    assert.ok(!/\b(ALTER|CREATE|DROP)\s+(TABLE|TYPE|INDEX|POLICY|FUNCTION)\b/i.test(code), "2600 must be a seed, not DDL");
    assert.ok(!/UPDATE\s+public\.events/i.test(code), "2600 must not transition anything itself");
    assert.equal((code.match(/INSERT INTO/g) ?? []).length, 1);
  });
});

// ── 10. Route level: the path that was impossible becomes possible ───────────

describe("POST /events/:id/complete — reachable once the pass has run", () => {
  const HOST = uuid(900);
  const EVENT = uuid(1);

  async function withServer(db: ReturnType<typeof makeFake>, fn: (port: number) => Promise<void>) {
    const { _setTestClient, _clearTestClient } = await import("../lib/http.js");
    const { default: app } = await import("../app.js");
    _setTestClient(db, true);
    const srv: Server = createServer(app);
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
    const { port } = srv.address() as { port: number };
    try { await fn(port); }
    finally {
      await new Promise<void>((res) => srv.close(() => res()));
      _clearTestClient();
    }
  }

  const complete = (port: number) => fetch(`http://127.0.0.1:${port}/api/events/${EVENT}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer fake-token-${HOST}` },
    body: "{}",
  });

  function routeFake(extra: FakeCfg = {}) {
    const db = makeFake({
      flag: true,
      events: [ev(EVENT, "open", PAST, { host_id: HOST })],
      extraTables: { profiles: [{ id: HOST, account_status: "active" }] },
      ...extra,
    });
    // The route reads these flags through isFlagEnabled too; keep the trust
    // engine OFF so the fire-and-forget tail is a no-op, not a live emission.
    db._tables.feature_flags.push(
      { flag: "events_enabled", enabled: true },
      { flag: "trust_engine_enabled", enabled: false },
    );
    return db;
  }

  it("refuses an open event (400 invalid_payload); after the pass the same request completes it", async () => {
    const db = routeFake();
    await withServer(db, async (port) => {
      const r1 = await complete(port);
      assert.equal(r1.status, 400, "open events cannot be completed — the gate that made this route unreachable");
      const b1 = (await r1.json()) as { error?: string; message?: string };
      assert.equal(b1.error, "invalid_payload");
      assert.match(String(b1.message), /started/);
      assert.equal(db._tables.events[0].state, "open");

      const pass = await runEventStartPass({ client: db, now: NOW });
      assert.equal(pass.started, 1);
      assert.equal(db._tables.events[0].state, "started");

      const r2 = await complete(port);
      assert.equal(r2.status, 200);
      assert.deepEqual(await r2.json(), { ok: true });
      assert.equal(db._tables.events[0].state, "completed");
      const actions = db._tables.event_activity_log.map((a) => a.action);
      assert.deepEqual(actions, ["started", "completed"], "both transitions are audited, in order");
      // Let the route's fire-and-forget tail settle before the server closes.
      await new Promise((r) => setTimeout(r, 20));
    });
  });

  it("the complete route checks its own UPDATE .error: a refused write is db_error and the state is unchanged", async () => {
    const db = routeFake({ updateErrorFor: new Set([EVENT]) });
    db._tables.events[0].state = "started";
    await withServer(db, async (port) => {
      const r = await complete(port);
      assert.equal(r.status, 500, "a resolved database error must not be reported as ok:true");
      const body = (await r.json()) as { error?: string };
      assert.equal(body.error, "db_error");
      assert.equal(db._tables.events[0].state, "started");
      assert.deepEqual(db._tables.event_activity_log, [], "no 'completed' audit row for a write that did not happen");
      await new Promise((r) => setTimeout(r, 20));
    });
  });
});
