/**
 * PR-R-L163a — a layover session's events lose their name 30 days after it ends
 * (census-layover L163; lead ruling 2026-10-07; OD-MAP-4), behind a flag seeded
 * FALSE, dead-lettered on failure.
 *
 * The fake below EXECUTES the filters the pass sends — including the inner
 * embed's `layover_sessions.departure_time` filter and the parked-session
 * `not in` — over rows it holds, so every assertion is about the rows that
 * result, not about the calls made.
 *
 * Run: node --import tsx/esm --test src/test/layoverPostSessionPseudonymisation.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runLayoverPostSessionPseudonymisation,
  layoverEventPseudonymPatch,
  LAYOVER_AUDIT_RETENTION_DAYS,
  LAYOVER_PSEUDONYMISATION_DEAD_LETTER_CEILING,
} from "../lib/layoverEventPseudonymisation.js";
import {
  runLayoverAuditRetentionTick,
  getLayoverAuditRetentionStatus,
  _resetLayoverAuditRetentionStatus,
  startLayoverAuditRetentionScheduler,
  stopLayoverAuditRetentionScheduler,
} from "../lib/layoverAuditRetentionScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

type Row = Record<string, any>;
const NOW = new Date("2027-03-15T12:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const FLAG = "layover_events_post_session_pseudonymisation_enabled";
const DL = "layover_event_pseudonymisation_dead_letters";

interface World {
  flag?: "on" | "off" | "error" | "throw";
  sessions: Array<{ id: string; departure_time: string }>;
  events: Row[];
  letters?: Row[];
  /** Session ids whose events UPDATE fails. */
  failUpdate?: Set<string>;
  failLetterRead?: { code: string; message: string };
  failLetterWrite?: boolean;
  failEventRead?: { code: string; message: string };
}

function fake(w: World) {
  const letters: Row[] = w.letters ?? [];
  const touched: string[] = [];
  const queries: Array<{ table: string; select?: string; filters: string[] }> = [];
  function from(table: string) {
    touched.push(table);
    if (table === "feature_flags") {
      const f: any = {
        select: () => f, eq: () => f,
        maybeSingle: () => {
          if (w.flag === "throw") throw new Error("socket hang up");
          if (w.flag === "error") return Promise.resolve({ data: null, error: { code: "57014", message: "timeout" } });
          return Promise.resolve({ data: { flag: FLAG, enabled: w.flag === "on" }, error: null });
        },
      };
      return f;
    }
    const preds: Array<(r: Row) => boolean> = [];
    const filters: string[] = [];
    let op: "select" | "update" | "upsert" = "select";
    let payload: Row = {};
    let selectCols = "";
    let returning = false;
    let limitN: number | null = null;
    let orderCol: string | null = null;
    const q = { table, filters, select: undefined as string | undefined };
    queries.push(q);
    const col = (r: Row, c: string) => {
      if (c.startsWith("layover_sessions.")) {
        const s = w.sessions.find((x) => x.id === r.session_id);
        return s ? (s as Row)[c.slice("layover_sessions.".length)] : undefined;
      }
      return r[c];
    };
    const run = async () => {
      const rows = table === "layover_events" ? w.events : table === DL ? letters : null;
      if (rows === null) throw new Error(`unexpected table ${table}`);
      if (table === DL && op === "select" && w.failLetterRead) return { data: null, error: w.failLetterRead };
      if (table === DL && op !== "select" && w.failLetterWrite) return { data: null, error: { code: "42501", message: "denied" } };
      if (table === "layover_events" && op === "select" && w.failEventRead) return { data: null, error: w.failEventRead };
      if (op === "upsert") {
        const existing = letters.find((l) => l.session_id === payload.session_id);
        if (existing) Object.assign(existing, payload); else letters.push({ ...payload });
        return { data: null, error: null };
      }
      let hit = rows.filter((r) => preds.every((p) => p(r)));
      if (op === "update") {
        if (table === "layover_events" && w.failUpdate?.has(String(hit[0]?.session_id ?? filters.find((f) => f.startsWith("eq session_id="))?.slice(15)))) {
          return { data: null, error: { code: "40P01", message: "deadlock detected" } };
        }
        for (const r of hit) Object.assign(r, payload);
        return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (orderCol) hit = [...hit].sort((a, b) => String(a[orderCol!]).localeCompare(String(b[orderCol!])));
      if (limitN !== null) hit = hit.slice(0, limitN);
      if (table === "layover_events") {
        assert.match(selectCols, /layover_sessions!inner\(departure_time\)/, "the pass must let the DATABASE pick ended sessions (inner embed)");
        return { data: hit.map((r) => ({ session_id: r.session_id, layover_sessions: { departure_time: col(r, "layover_sessions.departure_time") } })), error: null };
      }
      return { data: hit.map((r) => ({ session_id: r.session_id, letters: r.letters })), error: null };
    };
    const b: any = {
      select(c?: string) { if (op === "select") { selectCols = String(c ?? ""); q.select = selectCols; } else returning = true; return b; },
      update(p: Row) { op = "update"; payload = p; return b; },
      upsert(p: Row, o?: { onConflict?: string }) { assert.equal(o?.onConflict, "session_id"); op = "upsert"; payload = p; return b; },
      eq(c: string, v: unknown) { filters.push(`eq ${c}=${v}`); preds.push((r) => col(r, c) === v); return b; },
      is(c: string, v: null) { filters.push(`is ${c}=null`); preds.push((r) => (col(r, c) ?? null) === v); return b; },
      not(c: string, o: string, v: unknown) {
        filters.push(`not ${c} ${o} ${v}`);
        if (o === "is") preds.push((r) => (col(r, c) ?? null) !== v);
        else if (o === "in") { const ids = String(v).replace(/^\(|\)$/g, "").split(","); preds.push((r) => !ids.includes(String(col(r, c)))); }
        else throw new Error(`unsupported not.${o}`);
        return b;
      },
      lt(c: string, v: string) { filters.push(`lt ${c}=${v}`); preds.push((r) => { const x = col(r, c); return x != null && String(x) < v; }); return b; },
      order(c: string) { orderCol = c; return b; },
      limit(n: number) { limitN = n; return b; },
      then(f: any, r: any) { return run().then(f, r); },
    };
    return b;
  }
  return { client: { from } as any, letters, touched, queries };
}

const named = (id: string, session: string, at: string, meta: Row = { k: "v" }): Row =>
  ({ id, session_id: session, user_id: "traveller-1", event_type: "session_created", metadata: meta, created_at: at, pseudonymised_at: null, erasure_pseudonym: null, retain_until: null });

/** OLD departed 31 days ago (due), RECENT 29 days ago (not yet), LIVE departs tomorrow. */
function world(over: Partial<World> = {}): World {
  return {
    flag: "on",
    sessions: [
      { id: "OLD", departure_time: iso(NOW.getTime() - 31 * DAY) },
      { id: "OLD2", departure_time: iso(NOW.getTime() - 40 * DAY) },
      { id: "RECENT", departure_time: iso(NOW.getTime() - 29 * DAY) },
      { id: "LIVE", departure_time: iso(NOW.getTime() + DAY) },
    ],
    events: [
      named("e1", "OLD", iso(NOW.getTime() - 32 * DAY)),
      named("e2", "OLD", iso(NOW.getTime() - 31 * DAY)),
      named("e3", "OLD2", iso(NOW.getTime() - 41 * DAY)),
      named("e4", "RECENT", iso(NOW.getTime() - 30 * DAY)),
      named("e5", "LIVE", iso(NOW.getTime() - DAY)),
    ],
    ...over,
  };
}

describe("PR-R-L163a — the flag gates everything (seeded FALSE: destructive)", () => {
  it("OFF: nothing but the flag is read, and no event changes", async () => {
    const w = world({ flag: "off" }); const f = fake(w);
    const r = await runLayoverPostSessionPseudonymisation(f.client, NOW);
    assert.deepEqual([r.outcome, r.reason, r.sessions], ["off", null, 0]);
    assert.deepEqual(f.touched, ["feature_flags"]);
    assert.ok(w.events.every((e) => e.user_id === "traveller-1" && e.pseudonymised_at === null));
  });
  it("an UNREADABLE flag (error or throw) is a FAILURE, not 'off', and acts on nothing", async () => {
    for (const flag of ["error", "throw"] as const) {
      const w = world({ flag }); const f = fake(w);
      const r = await runLayoverPostSessionPseudonymisation(f.client, NOW);
      assert.deepEqual([r.outcome, r.reason], ["failed", "flag_unreadable"], flag);
      assert.deepEqual(f.touched, ["feature_flags"], flag);
      assert.ok(w.events.every((e) => e.pseudonymised_at === null), flag);
    }
  });
});

describe("PR-R-L163a — the events of a session 30+ days past its departure are pseudonymised as account deletion does", () => {
  it("OLD and OLD2 lose user, session and metadata; RECENT and LIVE keep their name", async () => {
    const w = world(); const f = fake(w);
    const r = await runLayoverPostSessionPseudonymisation(f.client, NOW);
    assert.deepEqual([r.outcome, r.reason, r.sessions, r.events, r.failedSessions], ["pseudonymised", null, 2, 3, 0]);
    const by = new Map(w.events.map((e) => [e.id, e]));
    for (const id of ["e1", "e2", "e3"]) {
      const e = by.get(id)!;
      assert.equal(e.user_id, null, id); assert.equal(e.session_id, null, id); assert.deepEqual(e.metadata, {}, id);
      assert.equal(e.pseudonymised_at, NOW.toISOString(), id);
      assert.equal(e.retain_until, iso(NOW.getTime() + LAYOVER_AUDIT_RETENTION_DAYS * DAY), id);
      assert.match(String(e.erasure_pseudonym), /^[0-9a-f-]{36}$/, id);
    }
    for (const id of ["e4", "e5"]) {
      assert.equal(by.get(id)!.user_id, "traveller-1", id);
      assert.equal(by.get(id)!.pseudonymised_at, null, id);
    }
    assert.equal(by.get("e1")!.erasure_pseudonym, by.get("e2")!.erasure_pseudonym, "one pseudonym per session: its trail stays consistent");
    assert.notEqual(by.get("e1")!.erasure_pseudonym, by.get("e3")!.erasure_pseudonym, "two sessions are never joinable by pseudonym");
  });

  it("the boundary: departed EXACTLY 30 days ago is not yet due; a millisecond more is", async () => {
    const at = (ms: number) => world({ sessions: [{ id: "OLD", departure_time: iso(NOW.getTime() - ms) }], events: [named("e1", "OLD", iso(NOW.getTime() - ms))] });
    const exact = at(30 * DAY); await runLayoverPostSessionPseudonymisation(fake(exact).client, NOW);
    assert.equal(exact.events[0].pseudonymised_at, null);
    const past = at(30 * DAY + 1); await runLayoverPostSessionPseudonymisation(fake(past).client, NOW);
    assert.equal(past.events[0].pseudonymised_at, NOW.toISOString());
  });

  it("an already-pseudonymised row is never rewritten (its retain_until stays)", async () => {
    const w = world(); const prior = { ...named("e0", "OLD", iso(NOW.getTime() - 33 * DAY)), user_id: null, session_id: null, erasure_pseudonym: "p-old", pseudonymised_at: "2026-12-01T00:00:00.000Z", retain_until: "2027-12-01T00:00:00.000Z", metadata: {} };
    w.events.push(prior);
    await runLayoverPostSessionPseudonymisation(fake(w).client, NOW);
    assert.deepEqual([prior.erasure_pseudonym, prior.pseudonymised_at, prior.retain_until], ["p-old", "2026-12-01T00:00:00.000Z", "2027-12-01T00:00:00.000Z"]);
  });

  it("at most maxSessions sessions per pass, oldest events first; the next pass takes the rest", async () => {
    const w = world(); const f = fake(w);
    const r1 = await runLayoverPostSessionPseudonymisation(f.client, NOW, { maxSessions: 1 });
    assert.equal(r1.sessions, 1);
    assert.equal(w.events.find((e) => e.id === "e3")!.pseudonymised_at, NOW.toISOString(), "OLD2's event is the oldest, so OLD2 goes first");
    assert.equal(w.events.find((e) => e.id === "e1")!.pseudonymised_at, null);
    const r2 = await runLayoverPostSessionPseudonymisation(f.client, NOW, { maxSessions: 1 });
    assert.equal(r2.sessions, 1);
    assert.equal(w.events.find((e) => e.id === "e1")!.pseudonymised_at, NOW.toISOString());
    assert.equal((await runLayoverPostSessionPseudonymisation(f.client, NOW)).outcome, "idle");
  });

  it("the transform IS the one account deletion uses: same six keys, same retention, a fresh pseudonym unless shared", () => {
    const a = layoverEventPseudonymPatch(NOW.toISOString(), "P");
    assert.deepEqual(a, { user_id: null, session_id: null, erasure_pseudonym: "P", pseudonymised_at: NOW.toISOString(), retain_until: iso(NOW.getTime() + 365 * DAY), metadata: {} });
    assert.notEqual(layoverEventPseudonymPatch(NOW.toISOString()).erasure_pseudonym, layoverEventPseudonymPatch(NOW.toISOString()).erasure_pseudonym);
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../services/accountDeletion/AccountDeletionService.ts"), "utf8");
    assert.match(src, /const lp = layoverEventPseudonymPatch\(executedAt, layoverPseudonym\)/, "account deletion must build its update from the one definition");
    for (const k of ["user_id", "session_id", "erasure_pseudonym", "pseudonymised_at", "retain_until", "metadata"]) {
      assert.match(src, new RegExp(`${k}: lp\\.${k},`), `account deletion's ${k} must be the one definition's`);
    }
  });
});

describe("PR-R-L163a — failures are dead-lettered, retried, then parked; a success resolves", () => {
  it("one session's update fails: it is dead-lettered (letters 1), the others still go, the pass is FAILED", async () => {
    const w = world({ failUpdate: new Set(["OLD"]) }); const f = fake(w);
    const r = await runLayoverPostSessionPseudonymisation(f.client, NOW);
    assert.deepEqual([r.outcome, r.reason, r.sessions, r.failedSessions], ["failed", "session_failed", 1, 1]);
    assert.equal(w.events.find((e) => e.id === "e3")!.pseudonymised_at, NOW.toISOString(), "OLD2 still pseudonymised");
    assert.equal(w.events.find((e) => e.id === "e1")!.user_id, "traveller-1", "OLD keeps its name until it succeeds");
    assert.equal(f.letters.length, 1);
    assert.deepEqual([f.letters[0].session_id, f.letters[0].letters, f.letters[0].resolved_at], ["OLD", 1, null]);
    assert.match(f.letters[0].detail, /^40P01: deadlock detected/);
  });

  it("consecutive failures count up; at the ceiling the session is PARKED: excluded in the query and not attempted", async () => {
    const w = world({ failUpdate: new Set(["OLD"]) }); const f = fake(w);
    // THREE, written out: a loop bound read off the constant would follow any change to it.
    assert.equal(LAYOVER_PSEUDONYMISATION_DEAD_LETTER_CEILING, 3, "the documented ceiling (3622's header, lib/layoverEventPseudonymisation.ts)");
    for (let i = 1; i <= 3; i++) {
      await runLayoverPostSessionPseudonymisation(f.client, new Date(NOW.getTime() + i * 3_600_000));
      assert.equal(f.letters[0].letters, i, `after failure ${i}`);
    }
    const before = f.letters[0].letters;
    const r = await runLayoverPostSessionPseudonymisation(f.client, new Date(NOW.getTime() + 10 * 3_600_000));
    assert.equal(r.parked, 1);
    assert.equal(r.failedSessions, 0, "a parked session is not retried");
    assert.equal(f.letters[0].letters, before, "nor counted again");
    const eventsQuery = f.queries.filter((q) => q.table === "layover_events" && q.select).pop()!;
    assert.ok(eventsQuery.filters.includes("not session_id in (OLD)"), `the parked session must be excluded IN THE QUERY: ${eventsQuery.filters.join(" | ")}`);
  });

  it("a later success stamps resolved_at on the open letter", async () => {
    const w = world({ letters: [{ session_id: "OLD", letters: 2, first_failed_at: "x", last_failed_at: "x", resolved_at: null, detail: "40P01" }] });
    const f = fake(w);
    const r = await runLayoverPostSessionPseudonymisation(f.client, NOW);
    assert.equal(r.outcome, "pseudonymised");
    assert.equal(f.letters[0].resolved_at, NOW.toISOString());
    assert.equal(w.events.find((e) => e.id === "e1")!.user_id, null);
  });

  it("a failure after a RESOLVED letter reopens it at 1 (it does not add to a count an operator closed)", async () => {
    const w = world({ failUpdate: new Set(["OLD"]), letters: [{ session_id: "OLD", letters: 3, first_failed_at: "x", last_failed_at: "x", resolved_at: "2027-01-01T00:00:00.000Z", detail: "old" }] });
    const f = fake(w);
    await runLayoverPostSessionPseudonymisation(f.client, NOW);
    assert.deepEqual([f.letters.length, f.letters[0].letters, f.letters[0].resolved_at, f.letters[0].first_failed_at], [1, 1, null, NOW.toISOString()]);
  });

  it("a dead letter that cannot be written is a FAILURE of its own kind", async () => {
    const f = fake(world({ failUpdate: new Set(["OLD"]), failLetterWrite: true }));
    const r = await runLayoverPostSessionPseudonymisation(f.client, NOW);
    assert.deepEqual([r.outcome, r.reason], ["failed", "dead_letter_write_failed"]);
  });
});

describe("PR-R-L163a — a failed or missing read is never 'nothing due'", () => {
  it("3622 not applied (no dead-letter table): REFUSED, no event touched", async () => {
    const w = world({ failLetterRead: { code: "42P01", message: "relation does not exist" } });
    const r = await runLayoverPostSessionPseudonymisation(fake(w).client, NOW);
    assert.deepEqual([r.outcome, r.reason], ["refused", "dead_letters_absent"]);
    assert.ok(w.events.every((e) => e.pseudonymised_at === null));
  });
  it("an unreadable dead-letter table: FAILED, no event touched (it would not know what is parked)", async () => {
    const w = world({ failLetterRead: { code: "57014", message: "timeout" } });
    const r = await runLayoverPostSessionPseudonymisation(fake(w).client, NOW);
    assert.deepEqual([r.outcome, r.reason], ["failed", "dead_letter_read_failed"]);
    assert.ok(w.events.every((e) => e.pseudonymised_at === null));
  });
  it("an unreadable events read is FAILED; 3621's columns missing is REFUSED", async () => {
    const a = await runLayoverPostSessionPseudonymisation(fake(world({ failEventRead: { code: "57014", message: "timeout" } })).client, NOW);
    assert.deepEqual([a.outcome, a.reason], ["failed", "read_failed"]);
    const b = await runLayoverPostSessionPseudonymisation(fake(world({ failEventRead: { code: "42703", message: "column pseudonymised_at does not exist" } })).client, NOW);
    assert.deepEqual([b.outcome, b.reason], ["refused", "schema_absent"]);
  });
});

describe("the retention tick runs the post-session phase first, and neither phase can stop the other", () => {
  afterEach(() => { _resetLayoverAuditRetentionStatus(); });
  /** Both phases on one fake: the delete sweep's probe and read are answered too. */
  function both(w: World) {
    const f = fake(w);
    const from = (t: string) => {
      const b = f.client.from(t);
      if (t !== "layover_events") return b;
      let updating = false;
      const upd = b.update.bind(b);
      b.update = (p: Row) => { updating = true; upd(p); return b; };
      const sel = b.select.bind(b);
      // The sweep's probe (head) and its due-row read ("id") are answered here;
      // the post-session phase's embed read and its update's returning select
      // go to the stateful fake.
      b.select = (c: string, o?: { head?: boolean }) => {
        if (updating) return sel(c);
        if (o?.head) return { limit: () => Promise.resolve({ data: null, error: null }) };
        return c === "id" ? idRead() : sel(c);
      };
      return b;
    };
    const idRead = () => { const r: any = { not: () => r, lt: () => r, order: () => r, limit: () => Promise.resolve({ data: [], error: null }) }; return r; };
    return { client: { from } as any, f };
  }

  it("a failing post-session phase counts against the job while the delete sweep still runs", async () => {
    const { client } = both(world({ failUpdate: new Set(["OLD"]) }));
    const r = await runLayoverAuditRetentionTick({ client, now: NOW });
    assert.equal(r.outcome, "idle", "the delete sweep ran");
    const s = getLayoverAuditRetentionStatus();
    assert.equal(s.lastPostSession?.outcome, "failed");
    assert.equal(s.consecutiveFailures, 1, "a dead-lettered session is a failure of the job, visible on /healthz/schedulers");
    assert.equal(s.lastSuccessAt, null);
  });
  it("a clean post-session phase and a clean sweep are a success", async () => {
    const { client } = both(world());
    await runLayoverAuditRetentionTick({ client, now: NOW });
    const s = getLayoverAuditRetentionStatus();
    assert.deepEqual([s.lastPostSession?.outcome, s.lastPostSession?.sessions, s.consecutiveFailures, s.lastSuccessAt], ["pseudonymised", 2, 0, NOW.toISOString()]);
  });
  it("a post-session phase that THROWS is caught, counted, and the sweep still runs", async () => {
    const { client } = both(world());
    const throwing = { from: (t: string) => { if (t === DL) throw new Error("boom"); return client.from(t); } };
    const r = await runLayoverAuditRetentionTick({ client: throwing, now: NOW });
    assert.equal(r.outcome, "idle");
    assert.deepEqual([getLayoverAuditRetentionStatus().lastPostSession?.reason, getLayoverAuditRetentionStatus().consecutiveFailures], ["threw", 1]);
  });
  it("flag OFF (the seed): the phase reports 'off' and the job is healthy", async () => {
    const { client } = both(world({ flag: "off" }));
    await runLayoverAuditRetentionTick({ client, now: NOW });
    const s = getLayoverAuditRetentionStatus();
    assert.deepEqual([s.lastPostSession?.outcome, s.consecutiveFailures, s.lastSuccessAt], ["off", 0, NOW.toISOString()]);
  });
});

// ── PR #652's generation check, proved as #652's own suite proves it ─────────

describe("the retention scheduler: one loop after stop()/start() mid-pass, none after stop()", () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let live = new Map<number, () => void>();
  let nextId = 1;
  function intercept() {
    live = new Map();
    (globalThis as any).setTimeout = function (fn: unknown, ms?: number, ...rest: unknown[]) {
      if (typeof fn === "function" && fn.name === "tick") {
        const id = nextId++; live.set(id, fn as () => void);
        return { __tick: id, unref() { return this; }, ref() { return this; }, hasRef() { return false; } };
      }
      return (realSetTimeout as any)(fn, ms, ...rest);
    };
    (globalThis as any).clearTimeout = function (h: any) {
      if (h && typeof h === "object" && "__tick" in h) { live.delete(h.__tick); return; }
      return (realClearTimeout as any)(h);
    };
  }
  function fire() { const [[id, fn]] = [...live.entries()]; assert.equal(live.size, 1); live.delete(id); fn(); }
  function held() {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const node = (): any => new Proxy(function () { /* callable */ }, {
      get(_t, p) { if (p === "then") return (ok: any, bad: any) => gate.then(() => ({ data: null, error: { code: "XX000", message: "released" } })).then(ok, bad); if (p === "catch" || p === "finally") return undefined; return () => node(); },
      apply() { return node(); },
    });
    return { client: node(), release };
  }
  async function drain() { for (let i = 0; i < 25; i++) { for (let j = 0; j < 20; j++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); } }
  afterEach(() => {
    stopLayoverAuditRetentionScheduler();
    (globalThis as any).setTimeout = realSetTimeout; (globalThis as any).clearTimeout = realClearTimeout;
    _setTestServiceClient(null as any); _resetLayoverAuditRetentionStatus();
  });

  it("stop() + start() in the same turn as the tick: exactly ONE loop; a final stop() leaves none", async () => {
    const c = held(); _setTestServiceClient(c.client); intercept();
    startLayoverAuditRetentionScheduler(); fire();
    stopLayoverAuditRetentionScheduler(); startLayoverAuditRetentionScheduler();
    assert.equal(live.size, 1);
    c.release(); await drain();
    assert.equal(live.size, 1, "the old pass re-armed its loop beside the new one: two loops");
    stopLayoverAuditRetentionScheduler();
    assert.equal(live.size, 0);
  });
  it("stop() + start() while the pass waits on the database: exactly ONE loop", async () => {
    const c = held(); _setTestServiceClient(c.client); intercept();
    startLayoverAuditRetentionScheduler(); fire(); await drain();
    stopLayoverAuditRetentionScheduler(); startLayoverAuditRetentionScheduler();
    c.release(); await drain();
    assert.equal(live.size, 1, "two loops after a mid-pass restart");
    stopLayoverAuditRetentionScheduler();
    assert.equal(live.size, 0);
  });
});

// ── Migration 3622 and its rollback, statically ─────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const M = strip(readFileSync(join(HERE, "../migrations/3622_layover_post_session_pseudonymisation.sql"), "utf8"));
const RB = strip(readFileSync(join(HERE, "../../../../db/rollback/2026-10-07-3622-layover-post-session-pseudonymisation-rollback.sql"), "utf8"));

describe("migration 3622 — dead letters a client cannot reach, and a flag seeded FALSE", () => {
  it("one transaction; it refuses to run without 3621; its postconditions are the last statement", () => {
    const end = M.indexOf("END $post$;");
    assert.ok(M.indexOf("BEGIN;") >= 0 && end > 0 && M.lastIndexOf("COMMIT;") > end);
    assert.equal(M.slice(end + "END $post$;".length, M.lastIndexOf("COMMIT;")).trim(), "");
    assert.match(M.slice(M.indexOf("DO $pre$"), M.indexOf("END $pre$;")), /WHERE conname = 'layover_events_identity_or_pseudonym' AND conrelid = 'public\.layover_events'::regclass\s*\) THEN\s*RAISE EXCEPTION/);
  });
  it("the table: one row per session, erased with it, no user id, no event content", () => {
    const t = M.slice(M.indexOf("CREATE TABLE IF NOT EXISTS public.layover_event_pseudonymisation_dead_letters"), M.indexOf(");", M.indexOf("CREATE TABLE")));
    assert.match(t, /session_id\s+uuid PRIMARY KEY REFERENCES public\.layover_sessions\(id\) ON DELETE CASCADE/);
    assert.doesNotMatch(t, /user_id|metadata|event_type/);
    assert.match(t, /letters\s+integer NOT NULL DEFAULT 1 CHECK \(letters >= 1\)/);
  });
  it("RLS on, every client role revoked, service_role may not DELETE (a resolved letter is stamped, not removed)", () => {
    assert.match(M, /ENABLE ROW LEVEL SECURITY/);
    assert.match(M, /REVOKE ALL ON public\.layover_event_pseudonymisation_dead_letters FROM PUBLIC, anon, authenticated, service_role;/);
    assert.match(M, /GRANT SELECT, INSERT, UPDATE ON public\.layover_event_pseudonymisation_dead_letters TO service_role;/);
    assert.doesNotMatch(M, /GRANT[^;]*DELETE[^;]*layover_event_pseudonymisation_dead_letters/);
    assert.doesNotMatch(M, /CREATE POLICY/);
  });
  it("the flag is seeded FALSE and never set TRUE here", () => {
    assert.match(M, /'layover_events_post_session_pseudonymisation_enabled',\s*false,/);
    assert.doesNotMatch(M, /UPDATE public\.feature_flags/);
  });
  it("the rollback drops the table and the flag, and un-pseudonymises nothing", () => {
    assert.match(RB, /DROP TABLE IF EXISTS public\.layover_event_pseudonymisation_dead_letters;/);
    assert.match(RB, /DELETE FROM public\.feature_flags WHERE flag = 'layover_events_post_session_pseudonymisation_enabled';/);
    assert.doesNotMatch(RB, /UPDATE public\.layover_events/);
  });
});
