/**
 * Off-app solicitation SUSPENSION THRESHOLD — failure-visibility and counting tests.
 *
 * These cover the three ways the threshold computation was wrong. Each one is a
 * way for an abuse control to switch itself off without saying so:
 *
 *   (1a) the offense-count read dropped its `.error`. supabase-js RESOLVES on a
 *        database error, so an unreadable buddy_booking_events yielded
 *        `count: null` -> `(count ?? 0)` -> zero offenses -> nobody suspended,
 *        and not one line of log said the control had stopped working.
 *   (1b) the booking-id list feeding `.in(...)` was UNBOUNDED. PostgREST caps an
 *        unbounded collection at db-max-rows (Supabase ships 1000), so a busy
 *        buddy's older bookings fell off the end and the offense count was taken
 *        over a truncated set -- more wrongly the more the buddy had done.
 *   (1c) the warning row was inserted BEFORE the count, so the local named
 *        `priorCount` never held prior offenses. Behaviour is three strikes; the
 *        name said otherwise. Behaviour kept, name corrected -- these tests pin
 *        the behaviour from both sides so a later "fix" of the name cannot
 *        quietly turn it into four strikes.
 *
 * The fake below models the two things that actually bite here and that no
 * in-memory double in src/test/helpers models: PostgREST's ROW CAP, and
 * per-query ERROR INJECTION. Every query is recorded so assertions can be made
 * about what was issued rather than about what the code looks like.
 *
 * Run: node --import tsx/esm --test src/test/messagingOffAppThreshold.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import messagingRouter, {
  BUDDY_BOOKING_SCAN_CAP,
  offAppSuspensionThreshold,
  OFF_APP_SUSPENSION_THRESHOLD_DEFAULT,
} from "../routes/messaging.js";

const BUDDY_TOKEN = "offapp-threshold-buddy-token";
const BUDDY_USER = "buddy-threshold-user-1";
const TRAVELER_ID = "traveler-threshold-1";
const BUDDY_PROF = "buddy-threshold-profile-1";
const BOOKING_ID = "booking-threshold-1";
const THREAD_ID = "b1c2d3e4-f5a6-7890-bcde-f12345678901";

/** PostgREST's server-side collection cap. Supabase ships db-max-rows = 1000. */
const POSTGREST_ROW_CAP = 1000;

const FLAGGED = "Just pay me directly, my whatsapp is easier than the app.";

interface Query {
  table: string;
  kind: "select" | "insert" | "update";
  filters: Array<[string, string, unknown]>;
  limit: number | null;
  count: boolean;
  head: boolean;
}

interface State {
  profiles: Record<string, any>;
  buddyProfiles: Record<string, any>;
  bookings: any[];
  threadMembers: any[];
  bookingEvents: any[];
  messages: any[];
  blocks: any[];
  /** table -> forced error for SELECTs against it. */
  selectErrors: Record<string, { message: string } | undefined>;
  /** table -> forced error for INSERTs against it. */
  insertErrors: Record<string, { message: string } | undefined>;
  queries: Query[];
}

let state: State;
let logs: Array<{ level: string; obj: any; msg: string }> = [];
let server: http.Server;
let base: string;

function freshState(): State {
  return {
    profiles: {
      [BUDDY_USER]: { id: BUDDY_USER, preferred_language: "en" },
      [TRAVELER_ID]: { id: TRAVELER_ID, preferred_language: "en" },
    },
    buddyProfiles: {
      [BUDDY_PROF]: { id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active" },
    },
    bookings: [
      { id: BOOKING_ID, traveler_id: TRAVELER_ID, buddy_id: BUDDY_PROF, telegraph_thread_id: THREAD_ID, status: "accepted" },
    ],
    threadMembers: [
      { thread_id: THREAD_ID, user_id: BUDDY_USER, left_at: null },
      { thread_id: THREAD_ID, user_id: TRAVELER_ID, left_at: null },
    ],
    bookingEvents: [],
    messages: [],
    blocks: [],
    selectErrors: {},
    insertErrors: {},
    queries: [],
  };
}

function makeClient() {
  function table(t: string) {
    return {
      _t: t,
      _filters: [] as Array<[string, string, unknown]>,
      _insert: null as any,
      _update: null as any,
      _single: false,
      _count: false,
      _head: false,
      _limit: null as number | null,

      select(_cols?: string, opts?: any) {
        if (opts?.count) this._count = true;
        if (opts?.head) this._head = true;
        return this;
      },
      insert(d: any) { this._insert = d; return this; },
      update(d: any) { this._update = d; return this; },
      eq(c: string, v: any) { this._filters.push(["eq", c, v]); return this; },
      neq(c: string, v: any) { this._filters.push(["neq", c, v]); return this; },
      in(c: string, v: any[]) { this._filters.push(["in", c, v]); return this; },
      is(c: string, v: any) { this._filters.push(["eq", c, v]); return this; },
      or() { return this; },
      order() { return this; },
      limit(n: number) { this._limit = n; return this; },
      range() { return this; },
      maybeSingle() { this._single = true; return this; },
      single() { this._single = true; return this; },

      async then(resolve: (v: any) => void) {
        const r = await this._resolve();
        resolve(r);
        return r;
      },

      async _resolve(): Promise<any> {
        const kind: Query["kind"] =
          this._insert !== null ? "insert" : this._update !== null ? "update" : "select";
        state.queries.push({
          table: this._t,
          kind,
          filters: this._filters.slice(),
          limit: this._limit,
          count: this._count,
          head: this._head,
        });

        if (kind === "insert") {
          const forced = state.insertErrors[this._t];
          if (forced) return { data: null, error: forced };
          const rows = Array.isArray(this._insert) ? this._insert : [this._insert];
          const made = rows.map((r: any) => ({ id: `gen-${state.queries.length}-${Math.random().toString(36).slice(2)}`, ...r }));
          if (this._t === "buddy_booking_events") made.forEach((r) => state.bookingEvents.push(r));
          if (this._t === "messages") made.forEach((r) => state.messages.push(r));
          return this._single ? { data: made[0] ?? null, error: null } : { data: null, error: null };
        }

        if (kind === "update") {
          if (this._t === "rent_buddy_profiles") {
            for (const [, c, v] of this._filters) {
              if (c === "id" && state.buddyProfiles[v as string]) {
                Object.assign(state.buddyProfiles[v as string], this._update);
              }
            }
          }
          return { data: null, error: null };
        }

        const forced = state.selectErrors[this._t];
        if (forced) {
          // supabase-js RESOLVES on a database error. data null, count null.
          return { data: null, count: null, error: forced };
        }

        let rows: any[] = [];
        if (this._t === "profiles") rows = Object.values(state.profiles);
        else if (this._t === "message_thread_members") rows = state.threadMembers.slice();
        else if (this._t === "blocks") rows = state.blocks.slice();
        else if (this._t === "rent_buddy_bookings") rows = state.bookings.slice();
        else if (this._t === "buddy_booking_events") rows = state.bookingEvents.slice();
        else if (this._t === "rent_buddy_profiles") rows = Object.values(state.buddyProfiles);
        else return this._single ? { data: null, error: null } : { data: [], count: 0, error: null };

        for (const [op, c, v] of this._filters) {
          if (op === "eq") rows = rows.filter((r) => r[c] === v);
          else if (op === "neq") rows = rows.filter((r) => r[c] !== v);
          else if (op === "in") rows = rows.filter((r) => (v as any[]).includes(r[c]));
        }

        // The count header is computed over the FULL matching set -- PostgREST's
        // row cap truncates the returned rows, not `count: exact`. That is
        // exactly why a count taken over an id list built from a truncated
        // SELECT under-reports while the count itself looks healthy.
        const exact = rows.length;

        // PostgREST row cap: an unbounded collection is truncated server-side,
        // and an explicit .limit() above the cap is still clamped to it.
        const effective = this._limit === null ? POSTGREST_ROW_CAP : Math.min(this._limit, POSTGREST_ROW_CAP);
        const capped = rows.slice(0, effective);

        if (this._single) return { data: capped[0] ?? null, error: null };
        if (this._head) return { data: null, count: exact, error: null };
        return { data: capped, count: exact, error: null };
      },
    };
  }

  return {
    from: (t: string) => table(t),
    auth: {
      getUser: async (tok: string) =>
        tok === BUDDY_TOKEN
          ? { data: { user: { id: BUDDY_USER } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

function send(body: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ body });
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(new URL(base).port),
        path: `/api/threads/${THREAD_ID}/messages`,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${BUDDY_TOKEN}` },
      },
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
    r.write(payload);
    r.end();
  });
}

/**
 * The solicitation handler is fire-and-forget, so wait until the fake client has
 * been idle for a beat. Sleeping a fixed 80ms makes a slow machine produce a
 * green that examined nothing; idling on the query log does not.
 */
async function settle(idleMs = 60, maxMs = 4000): Promise<void> {
  const start = Date.now();
  let last = state.queries.length;
  let stableSince = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 15));
    if (state.queries.length !== last) {
      last = state.queries.length;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= idleMs) {
      return;
    }
    if (Date.now() - start > maxMs) return;
  }
}

const errorLogs = () => logs.filter((l) => l.level === "error");
const loggedMatching = (re: RegExp) => logs.filter((l) => re.test(l.msg));
const warningRows = () => state.bookingEvents.filter((e) => e.event === "off_app_solicitation_warning");
const suspendEvents = () => state.bookingEvents.filter((e) => e.event === "buddy_auto_suspended");
const isSuspended = () => state.buddyProfiles[BUDDY_PROF]?.status === "suspended";

function seedPriorWarnings(n: number, bookingIds?: string[]): void {
  for (let i = 0; i < n; i++) {
    state.bookingEvents.push({
      id: `prior-${i}`,
      booking_id: bookingIds ? bookingIds[i % bookingIds.length] : BOOKING_ID,
      actor_user_id: BUDDY_USER,
      event: "off_app_solicitation_warning",
    });
  }
}

before(async () => {
  const app = express();
  app.use(express.json());
  // req.log shim. Without it every error branch in the route THROWS, the
  // request dies, and a 500-from-crash is indistinguishable from fail-closed.
  app.use((req, _res, next) => {
    (req as any).log = {
      error: (obj: any, msg?: string) => logs.push({ level: "error", obj, msg: String(msg ?? obj) }),
      warn: (obj: any, msg?: string) => logs.push({ level: "warn", obj, msg: String(msg ?? obj) }),
      info: (obj: any, msg?: string) => logs.push({ level: "info", obj, msg: String(msg ?? obj) }),
      debug: () => {},
      child: () => (req as any).log,
    };
    next();
  });
  app.use("/api", messagingRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
  delete process.env["OFF_APP_SUSPENSION_THRESHOLD"];
});

beforeEach(() => {
  state = freshState();
  logs = [];
  delete process.env["OFF_APP_SUSPENSION_THRESHOLD"];
  const c = makeClient();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
});

// ─────────────────────────────────────────────────────────────────────────────

describe("off-app suspension threshold — the control cannot switch itself off silently", () => {
  it("harness sanity: a flagged buddy message reaches the solicitation handler", async () => {
    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();
    // Vacuity guard: if this ever stops being true, every test below is examining nothing.
    assert.equal(warningRows().length, 1, "the handler must have run and written its warning row");
    assert.ok(state.queries.length > 5, `expected the handler to issue queries, saw ${state.queries.length}`);
  });

  // ── (1a) dropped .error on the offense count ───────────────────────────────
  it("(1a) an unreadable buddy_booking_events LOGS the lost suspension decision", async () => {
    seedPriorWarnings(5);
    state.selectErrors["buddy_booking_events"] = { message: "57014 statement timeout" };

    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();

    const lost = loggedMatching(/offense count read FAILED/i);
    assert.equal(lost.length, 1, `expected exactly one 'offense count read FAILED' log, saw ${JSON.stringify(logs.map((l) => l.msg))}`);
    assert.equal(lost[0]!.level, "error", "a skipped suspension decision is an error, not a debug line");
    assert.ok(lost[0]!.obj?.err, "the log must carry the database error it swallowed");
    // And it must not have pretended the count was zero and moved on quietly.
    assert.equal(suspendEvents().length, 0, "no suspension may be recorded on an unknown count");
  });

  it("(1a) an unreadable rent_buddy_bookings LOGS that the flagged message went unattributed", async () => {
    state.selectErrors["rent_buddy_bookings"] = { message: "08006 connection failure" };

    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();

    const lost = loggedMatching(/booking lookup FAILED/i);
    assert.equal(lost.length, 1, `expected the booking lookup failure to be reported, saw ${JSON.stringify(logs.map((l) => l.msg))}`);
    assert.equal(lost[0]!.level, "error");
  });

  it("(1a) a REFUSED warning insert is logged and still counts as an offense", async () => {
    // Two prior offenses on record; this is the third. The audit insert fails.
    // The offense happened whether or not the audit row landed, so a broken
    // audit write must not buy a repeat offender an extra strike.
    seedPriorWarnings(2);
    state.insertErrors["buddy_booking_events"] = { message: "23505 duplicate key" };

    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();

    assert.equal(loggedMatching(/warning insert FAILED/i).length, 1, "the unaudited offense must be reported");
    assert.equal(isSuspended(), true, "third offense still suspends even when its audit row could not be written");
  });

  it("(1a) a healthy read produces NO failure logs (positive control)", async () => {
    seedPriorWarnings(2);
    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();
    // Scoped to this control: the fake does not model the translation tables, so
    // the translation pipeline logs its own (expected) error on every send.
    const solicitationErrors = errorLogs()
      .map((l) => l.msg)
      .filter((m) => /off-app|solicitation|auto-suspension|buddy_auto_suspended/i.test(m));
    assert.deepEqual(solicitationErrors, [], "clean path must be quiet");
    assert.equal(isSuspended(), true);
  });

  // ── (1b) unbounded booking-id list / PostgREST row cap ────────────────────
  it("(1b) the buddy-booking scan carries an EXPLICIT limit at our own cap", async () => {
    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();

    const scans = state.queries.filter(
      (q) => q.table === "rent_buddy_bookings" && q.kind === "select" &&
        q.filters.some(([op, c]) => op === "eq" && c === "buddy_id"),
    );
    assert.equal(scans.length, 1, "expected exactly one buddy-booking scan");
    assert.equal(scans[0]!.limit, BUDDY_BOOKING_SCAN_CAP,
      "the booking-id list must be bounded by a limit WE choose, not by PostgREST's invisible default");
  });

  it("(1b) offenses are counted by ACTOR, with no id list for a row cap to truncate", async () => {
    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();

    const actorCounts = state.queries.filter(
      (q) => q.table === "buddy_booking_events" && q.kind === "select" && q.count &&
        q.filters.some(([op, c, v]) => op === "eq" && c === "actor_user_id" && v === BUDDY_USER),
    );
    assert.equal(actorCounts.length, 1, "expected one actor-scoped, cap-immune offense count");
    assert.ok(
      !actorCounts[0]!.filters.some(([op]) => op === "in"),
      "the authoritative count must not depend on an id list at all",
    );
  });

  it("(1b) TRUNCATION: 1200 bookings with the old offenses beyond the row cap still suspends", async () => {
    // The shape that made this defect invisible in production: the offending
    // buddy is the BUSY one. Their oldest bookings -- which is where the old
    // warnings sit -- fall off the end of a 1000-row PostgREST response, so a
    // booking-scoped count sees almost none of them.
    const OLD = 3;
    const oldIds: string[] = [];
    state.bookings = [
      { id: BOOKING_ID, traveler_id: TRAVELER_ID, buddy_id: BUDDY_PROF, telegraph_thread_id: THREAD_ID, status: "accepted" },
    ];
    for (let i = 0; i < 1200; i++) {
      const id = `bulk-booking-${i}`;
      state.bookings.push({ id, buddy_id: BUDDY_PROF, telegraph_thread_id: null });
      // Past the cap, counting the one real booking already occupying slot 0.
      if (i >= POSTGREST_ROW_CAP && oldIds.length < OLD) oldIds.push(id);
    }
    assert.equal(oldIds.length, OLD, "fixture must place the old offenses beyond the row cap");
    seedPriorWarnings(OLD, oldIds);

    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();

    // Prove the fixture actually exercises truncation rather than passing by luck.
    const scan = state.queries.find(
      (q) => q.table === "rent_buddy_bookings" && q.kind === "select" &&
        q.filters.some(([op, c]) => op === "eq" && c === "buddy_id"),
    );
    assert.ok(scan, "the buddy-booking scan must have been issued");
    assert.equal(loggedMatching(/hit the scan cap/i).length, 1,
      "hitting the cap must be REPORTED -- a truncated count that says nothing is the whole defect");

    assert.equal(isSuspended(), true,
      "4 cumulative offenses must suspend even though the booking-scoped count is truncated to ~1");
    assert.equal(suspendEvents().length, 1, "the suspension must be audited");
    assert.equal((suspendEvents()[0]!.metadata as any).offense_count, OLD + 1,
      "the audited offense count must be the untruncated one");
  });

  // ── (1c) off-by-one: three strikes, pinned from both sides ────────────────
  it("(1c) the SECOND offense does NOT suspend", async () => {
    seedPriorWarnings(1);
    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();
    assert.equal(warningRows().length, 2, "fixture check: this is the second offense");
    assert.equal(isSuspended(), false, "two strikes must not suspend");
    assert.equal(suspendEvents().length, 0);
  });

  it("(1c) the THIRD offense DOES suspend, and the audited count includes it", async () => {
    seedPriorWarnings(2);
    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();
    assert.equal(warningRows().length, 3, "fixture check: this is the third offense");
    assert.equal(isSuspended(), true, "three strikes suspends");
    assert.equal(state.buddyProfiles[BUDDY_PROF]?.admin_status, "under_review");
    assert.equal((suspendEvents()[0]!.metadata as any).offense_count, 3,
      "the recorded count is CUMULATIVE and includes the offense being handled -- which is what 'three strikes' means");
  });

  it("(1c) the FIRST offense does NOT suspend", async () => {
    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();
    assert.equal(warningRows().length, 1);
    assert.equal(isSuspended(), false);
  });

  // ── threshold parsing ─────────────────────────────────────────────────────
  it("a malformed OFF_APP_SUSPENSION_THRESHOLD falls back instead of disabling suspension", () => {
    const seen: string[] = [];
    const log = { error: (_o: unknown, m: string) => seen.push(m) };
    process.env["OFF_APP_SUSPENSION_THRESHOLD"] = "three";
    assert.equal(offAppSuspensionThreshold(log), OFF_APP_SUSPENSION_THRESHOLD_DEFAULT);
    assert.equal(seen.length, 1, "a misconfigured abuse threshold must be reported");
    // Number('three') is NaN and `n >= NaN` is false for every n, so the old
    // expression disabled suspension permanently and silently.
    assert.equal(Number.isNaN(Number("three")), true);

    process.env["OFF_APP_SUSPENSION_THRESHOLD"] = "0";
    assert.equal(offAppSuspensionThreshold(log), OFF_APP_SUSPENSION_THRESHOLD_DEFAULT);
    process.env["OFF_APP_SUSPENSION_THRESHOLD"] = "5";
    assert.equal(offAppSuspensionThreshold(log), 5);
    delete process.env["OFF_APP_SUSPENSION_THRESHOLD"];
    assert.equal(offAppSuspensionThreshold(log), OFF_APP_SUSPENSION_THRESHOLD_DEFAULT);
  });

  it("a malformed threshold still suspends at the default through the live route", async () => {
    process.env["OFF_APP_SUSPENSION_THRESHOLD"] = "not-a-number";
    seedPriorWarnings(2);
    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();
    assert.equal(isSuspended(), true, "a typo in an env var must not silently disable the control");
  });

  it("a raised threshold is honoured (the control is tunable, not hardcoded)", async () => {
    process.env["OFF_APP_SUSPENSION_THRESHOLD"] = "5";
    seedPriorWarnings(2);
    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();
    assert.equal(isSuspended(), false, "3 offenses must not suspend when the threshold is 5");
  });

  // ── enforcement writes stay checked ───────────────────────────────────────
  it("a failed suspension UPDATE is reported rather than assumed to have worked", async () => {
    seedPriorWarnings(2);
    // Route the update through a client whose rent_buddy_profiles update fails.
    const c: any = makeClient();
    const origFrom = c.from.bind(c);
    c.from = (t: string) => {
      const b = origFrom(t);
      if (t === "rent_buddy_profiles") {
        const origResolve = b._resolve.bind(b);
        b._resolve = async () => {
          if (b._update !== null) {
            state.queries.push({ table: t, kind: "update", filters: b._filters.slice(), limit: null, count: false, head: false });
            return { data: null, error: { message: "42501 permission denied" } };
          }
          return origResolve();
        };
      }
      return b;
    };
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);

    const r = await send(FLAGGED);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();

    assert.equal(isSuspended(), false, "fixture check: the update really did fail");
    assert.equal(loggedMatching(/auto-suspension UPDATE failed/i).length, 1,
      "a repeat offender left active must not be a silent outcome");
  });
});
