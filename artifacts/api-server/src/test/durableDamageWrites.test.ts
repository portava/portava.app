/**
 * durableDamageWrites.test.ts
 *
 * The worst sub-class of the platform read-failure defect: a read fails, a
 * neutral DEFAULT is synthesised from the failure, and that default is then
 * WRITTEN. The outage ends; the wrong value is now the stored truth.
 *
 * The reason none of the existing tests catch this class is mechanical:
 * supabase-js RESOLVES `{ data, error }` — it does not throw — so `try/catch`
 * never fires and `data ?? default` silently converts "the database was
 * unreachable" into "there is nothing there". Every fake below therefore makes
 * the failing read RESOLVE `{ data: null, error: {...} }`, which is the real
 * failure shape, rather than rejecting.
 *
 * Each test asserts BOTH halves of the contract:
 *   (a) the request refuses with a specific NAMED error (not a bare 500 — a
 *       500 is indistinguishable from a crash), and
 *   (b) NO write was attempted — asserted against the fake's recorded write
 *       calls, not merely against the status code.
 *
 * Run: node --import tsx/esm --test src/test/durableDamageWrites.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

import profileRouter from "../routes/profile.js";
import adminFeaturedRouter from "../routes/adminFeatured.js";
import eventsRouter from "../routes/events.js";
import messagingRouter from "../routes/messaging.js";
import marketplaceRouter from "../routes/rentABuddyMarketplace.js";
import { awardStamp } from "../services/passport/StampAwardEngine.js";
import { createEarningsLedgerEntry } from "../lib/rentBuddyEarningsLedger.js";
import { syncTripChatMembers } from "../services/groupChatSync.js";
import { runBuddyRequestSweep, _resetStatus } from "../lib/rentBuddyRequestSweeper.js";

// ── Recording fake client ─────────────────────────────────────────────────────

export interface WriteCall {
  table: string;
  op: "insert" | "update" | "upsert" | "delete";
  payload: unknown;
}

/**
 * `ctx.ordered` distinguishes two reads that hit the same table with the same
 * projection — e.g. event_waitlist `select("position")` for "am I already on
 * it?" (unordered) vs. the `order("position").limit(1)` max-position probe.
 * Without it a test cannot pin which of the two guards it is exercising.
 */
type FailRead = (table: string, selectCols: string, ctx: { ordered: boolean }) => boolean;

const READ_FAILURE = {
  message: "simulated: could not connect to server",
  code: "08006",
  details: null,
  hint: null,
};

interface FakeOpts {
  tables: Record<string, any[]>;
  failRead?: FailRead;
  userId?: string;
  rpc?: (fn: string, args: any) => Promise<{ data: any; error: any }>;
}

function makeRecordingClient(opts: FakeOpts): { client: any; writes: WriteCall[] } {
  const writes: WriteCall[] = [];
  const failRead = opts.failRead ?? (() => false);

  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let selectCols = "";
    let op: WriteCall["op"] | null = null;
    let payload: any = null;
    let limit: number | null = null;
    let headOnly = false;
    let wantCount = false;
    let orderBy: { col: string; asc: boolean } | null = null;

    const rows = () => {
      const out = (opts.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const { col, asc } = orderBy;
        out.sort((a, b) => {
          const av = a[col], bv = b[col];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (asc ? 1 : -1);
        });
      }
      return out;
    };

    async function resolve(kind: "one" | "list"): Promise<any> {
      if (op === null) {
        if (failRead(table, selectCols, { ordered: orderBy !== null })) {
          return { data: null, error: { ...READ_FAILURE }, count: null };
        }
        let res = rows();
        if (limit !== null) res = res.slice(0, limit);
        if (headOnly) return { data: null, error: null, count: res.length };
        if (kind === "one") return { data: res[0] ?? null, error: null, count: wantCount ? res.length : undefined };
        return { data: res, error: null, count: wantCount ? res.length : undefined };
      }
      // Writes always succeed in these tests: the point of every assertion is
      // that the write never happened at all, not that it failed.
      const written = Array.isArray(payload) ? payload[0] : payload;
      const echoed = { id: `written-${table}`, ...(written ?? {}) };
      if (kind === "one") return { data: echoed, error: null };
      return { data: written ? [echoed] : [], error: null };
    }

    const b: any = {
      select(cols?: string, o?: any) {
        selectCols = cols ?? "";
        if (o?.count === "exact") wantCount = true;
        if (o?.head) headOnly = true;
        return b;
      },
      insert(row: any) { op = "insert"; payload = row; writes.push({ table, op: "insert", payload: row }); return b; },
      update(row: any) { op = "update"; payload = row; writes.push({ table, op: "update", payload: row }); return b; },
      upsert(row: any) { op = "upsert"; payload = row; writes.push({ table, op: "upsert", payload: row }); return b; },
      delete() { op = "delete"; writes.push({ table, op: "delete", payload: null }); return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return b; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      gt() { return b; },
      gte() { return b; },
      lt() { return b; },
      lte() { return b; },
      or() { return b; },
      not() { return b; },
      ilike() { return b; },
      contains() { return b; },
      order(col: string, o?: { ascending?: boolean }) {
        orderBy = { col, asc: o?.ascending !== false };
        return b;
      },
      range() { return b; },
      limit(n: number) { limit = n; return b; },
      head() { headOnly = true; return b; },
      maybeSingle() { return resolve("one"); },
      single() { return resolve("one"); },
      csv() { return resolve("list"); },
      then(onF: any, onR: any) { return resolve("list").then(onF, onR); },
    };
    return b;
  }

  const client: any = {
    from: (table: string) => chain(table),
    rpc: opts.rpc ?? (async () => ({ data: null, error: null })),
    auth: {
      getUser: async (token: string) => {
        if (!token) return { data: { user: null }, error: { message: "no token" } };
        return { data: { user: { id: opts.userId ?? USER_ID } }, error: null };
      },
    },
  };
  return { client, writes };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

const TOKEN   = "durable-damage-token";
const USER_ID = "11111111-2222-4333-8444-555555555555";

function makeApp(mount: (app: express.Express) => void): Promise<{ server: http.Server; base: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      next();
    });
    mount(app);
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function apiReq(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          ...(payload ? { "content-length": Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Every write the fake recorded, as `table:op` strings — for assertion messages. */
function describeWrites(writes: WriteCall[]): string {
  return writes.length === 0 ? "(none)" : writes.map((w) => `${w.table}:${w.op}`).join(", ");
}

// ── 1. PATCH /api/me/privacy — a failed read used to reset every other setting ─

describe("durable damage — PATCH /me/privacy merges a patch onto DEFAULTS when the current-settings read fails", () => {
  let server: http.Server;
  let base: string;

  before(async () => {
    ({ server, base } = await makeApp((app) => app.use("/api", profileRouter)));
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  it("refuses with degraded_unavailable and writes NOTHING when profile_privacy_settings is unreadable", async () => {
    const { client, writes } = makeRecordingClient({
      tables: {
        profile_privacy_settings: [{
          user_id: USER_ID,
          profile_visibility: "private",
          show_current_city: false,
          allow_profile_discovery: false,
          allow_messages_from: "nobody",
        }],
        profiles: [{ id: USER_ID, show_profile_picture_publicly: false }],
      },
      failRead: (table) => table === "profile_privacy_settings",
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "PATCH", "/api/me/privacy", { show_stamps: true });

    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable",
      "must name the degraded state — a bare 500 is indistinguishable from a crash");
    // Give any fire-and-forget sync a tick to (not) happen.
    await new Promise((r2) => setTimeout(r2, 30));
    assert.deepEqual(writes, [],
      `a failed settings read must write nothing; recorded: ${describeWrites(writes)}`);
  });

  it("still merges onto the caller's REAL settings when the read succeeds (the fix does not break the happy path)", async () => {
    const { client, writes } = makeRecordingClient({
      tables: {
        profile_privacy_settings: [{
          user_id: USER_ID,
          profile_visibility: "private",
          show_current_city: false,
          allow_profile_discovery: false,
        }],
        profiles: [{ id: USER_ID, show_profile_picture_publicly: false }],
      },
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "PATCH", "/api/me/privacy", { show_stamps: true });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    const upserted = writes.find((w) => w.table === "profile_privacy_settings" && w.op === "upsert");
    assert.ok(upserted, "the happy path must still persist the patch");
    const row = upserted!.payload as any;
    assert.equal(row.show_stamps, true, "the patched field is applied");
    assert.equal(row.profile_visibility, "private", "an unpatched field keeps the user's real value, not the default");
    assert.equal(row.allow_profile_discovery, false, "an unpatched opt-out is never silently re-enabled");
  });
});

// ── 2. Stamp progress — a failed read used to ERASE the accumulated counter ────

describe("durable damage — stamp progress increment writes 1 over the real count when the progress read fails", () => {
  const DEF_ID  = "dddddddd-0000-4000-8000-000000000022";
  const TRIP_ID = "f1f1f1f1-0000-4000-8000-000000000033";
  const SLUG    = "city_visited";

  function baseTables() {
    return {
      feature_flags: [{ flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: true }],
      stamp_definitions: [{
        id: DEF_ID, slug: SLUG, name: "City Visited", is_active: true,
        is_repeatable: true, max_awards_per_user: null, visibility_default: "public",
        criteria_type: "automatic", criteria: null,
      }],
      user_stamps: [] as any[],
      stamp_award_events: [] as any[],
      // The user has accumulated 41 awards of this repeatable stamp.
      stamp_progress: [{ user_id: USER_ID, stamp_definition_id: DEF_ID, progress_count: 41 }],
      trips: [{ id: TRIP_ID, status: "completed" }],
      profiles: [{ id: USER_ID }],
      universal_stamp_catalog: [] as any[],
      stamp_milestones: [] as any[],
    };
  }

  // migration 2075's RPC is absent (PGRST202) so the engine takes the legacy
  // read-modify-write path — exactly the path that carries the defect.
  const rpcMissing = async () => ({ data: null, error: { code: "PGRST202", message: "function not found" } });

  it("writes NO stamp_progress row when the progress read fails", async () => {
    const { client, writes } = makeRecordingClient({
      tables: baseTables(),
      rpc: rpcMissing,
      failRead: (table, cols) => table === "stamp_progress" && cols.includes("progress_count"),
    });

    const result = await awardStamp(client, {
      userId: USER_ID, definitionSlug: SLUG, sourceType: "trips", sourceId: TRIP_ID,
      awardReason: "trip completed",
    });
    assert.equal(result.awarded, true, "the award itself still succeeds — only the progress write is refused");

    // The progress update is fire-and-forget; let its microtask chain drain.
    await new Promise((r) => setTimeout(r, 50));

    const progressWrites = writes.filter((w) => w.table === "stamp_progress");
    assert.deepEqual(progressWrites, [],
      `an unreadable progress row must never be overwritten with 0+1; recorded: ${JSON.stringify(progressWrites)}`);
  });

  it("still increments from the real count when the progress read succeeds", async () => {
    const { client, writes } = makeRecordingClient({ tables: baseTables(), rpc: rpcMissing });

    await awardStamp(client, {
      userId: USER_ID, definitionSlug: SLUG, sourceType: "trips", sourceId: TRIP_ID,
      awardReason: "trip completed",
    });
    await new Promise((r) => setTimeout(r, 50));

    const progressWrite = writes.find((w) => w.table === "stamp_progress" && w.op === "upsert");
    assert.ok(progressWrite, "the happy path must still write progress");
    assert.equal((progressWrite!.payload as any).progress_count, 42,
      "must increment 41 → 42, never reset to 1");
  });
});

// ── 3. POST /admin/featured/approve — a failed read used to reset featured_count ─

describe("durable damage — featured approve resets an author's featured_count to 1 when the count read fails", () => {
  const ADMIN_ID  = USER_ID;
  const AUTHOR_ID = "aaaa0000-1111-4222-8333-444444444444";
  const POST_ID   = "bbbb0000-1111-4222-8333-444444444444";

  let server: http.Server;
  let base: string;

  before(async () => {
    ({ server, base } = await makeApp((app) => app.use("/api", adminFeaturedRouter)));
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });
  beforeEach(() => {
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  function tables() {
    return {
      profiles: [
        { id: ADMIN_ID, role: "admin" },
        { id: AUTHOR_ID, featured_count: 37 },
      ],
      posts: [{ id: POST_ID, author_id: AUTHOR_ID, status: "active", primary_media_type: "image", has_video: false }],
      portava_featured: [] as any[],
      feature_flags: [] as any[],
    };
  }

  it("refuses with degraded_unavailable and does not even create the featured row when featured_count is unreadable", async () => {
    const { client, writes } = makeRecordingClient({
      tables: tables(),
      userId: ADMIN_ID,
      failRead: (table, cols) => table === "profiles" && cols.includes("featured_count"),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "POST", `/api/admin/featured/approve/${POST_ID}`, { category: "best_photo" });

    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.deepEqual(writes, [],
      `the count read is hoisted above every write, so a failure writes nothing at all; recorded: ${describeWrites(writes)}`);
  });

  it("refuses and writes nothing when the existing-featured idempotency read fails", async () => {
    const { client, writes } = makeRecordingClient({
      tables: tables(),
      userId: ADMIN_ID,
      failRead: (table, cols) => table === "portava_featured" && cols.includes("status"),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "POST", `/api/admin/featured/approve/${POST_ID}`, { category: "best_photo" });

    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.deepEqual(writes, [],
      `an unreadable idempotency guard must not re-approve and double-count; recorded: ${describeWrites(writes)}`);
  });

  it("still increments from the real count when both reads succeed", async () => {
    const { client, writes } = makeRecordingClient({ tables: tables(), userId: ADMIN_ID });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "POST", `/api/admin/featured/approve/${POST_ID}`, { category: "best_photo" });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const countWrite = writes.find((w) => w.table === "profiles" && w.op === "update");
    assert.ok(countWrite, "the happy path must still bump featured_count");
    assert.equal((countWrite!.payload as any).featured_count, 38, "37 → 38, never reset to 1");
  });
});

// ── 4. POST /events/:id/waitlist — a failed read used to overwrite waitlist_count ─

describe("durable damage — waitlist join inserts at position 1 and overwrites waitlist_count when the waitlist read fails", () => {
  const EVENT_ID = "cccc0000-1111-4222-8333-444444444444";
  let server: http.Server;
  let base: string;

  before(async () => {
    ({ server, base } = await makeApp((app) => app.use("/api", eventsRouter)));
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  function tables() {
    return {
      events: [{
        id: EVENT_ID, state: "full", waitlist_enabled: true, visibility: "public",
        host_id: "hhhh0000-1111-4222-8333-444444444444", circle_id: null, trip_id: null,
        age_min: null, age_max: null, trust_score_min: null, verified_only: false,
        waitlist_count: 40,
      }],
      // 40 people are already queued; the newcomer belongs at position 41.
      event_waitlist: Array.from({ length: 40 }, (_, i) => ({
        event_id: EVENT_ID, user_id: `u${i}`, position: i + 1,
      })),
      event_roles: [] as any[],
      feature_flags: [] as any[],
      blocks: [] as any[],
      profiles: [{ id: USER_ID }],
    };
  }

  it("refuses with degraded_unavailable and writes nothing when the MAX-POSITION read fails", async () => {
    const { client, writes } = makeRecordingClient({
      tables: tables(),
      // Only the ordered max-position probe fails; the membership read succeeds,
      // so this pins the position guard and not the membership guard.
      failRead: (table, cols, ctx) => table === "event_waitlist" && cols.includes("position") && ctx.ordered,
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "POST", `/api/events/${EVENT_ID}/waitlist`, {});

    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.deepEqual(writes, [],
      `position 1 and waitlist_count=1 must never be written from a failed read; recorded: ${describeWrites(writes)}`);
  });

  it("refuses with degraded_unavailable and writes nothing when the MEMBERSHIP read fails", async () => {
    const { client, writes } = makeRecordingClient({
      tables: tables(),
      // Only the unordered "am I already queued?" read fails.
      failRead: (table, cols, ctx) => table === "event_waitlist" && cols.includes("position") && !ctx.ordered,
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "POST", `/api/events/${EVENT_ID}/waitlist`, {});

    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.deepEqual(writes, [],
      `an unreadable membership check must not insert a duplicate waitlist row; recorded: ${describeWrites(writes)}`);
  });

  it("still queues at the real next position when the read succeeds", async () => {
    const { client, writes } = makeRecordingClient({ tables: tables() });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "POST", `/api/events/${EVENT_ID}/waitlist`, {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.position, 41, "must queue behind the 40 already waiting");

    const insert = writes.find((w) => w.table === "event_waitlist" && w.op === "insert");
    assert.equal((insert!.payload as any).position, 41);
    const countUpdate = writes.find((w) => w.table === "events" && w.op === "update");
    assert.equal((countUpdate!.payload as any).waitlist_count, 41, "never 1");
  });
});

// ── 5. POST /threads/:id/messages — a failed read used to store E2EE plaintext ──

describe("durable damage — a failed is_e2ee read stores the caller's PLAINTEXT in an E2EE thread", () => {
  const THREAD_ID = "eeee0000-1111-4222-8333-444444444444";
  let server: http.Server;
  let base: string;

  before(async () => {
    ({ server, base } = await makeApp((app) => app.use("/api", messagingRouter)));
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  function tables() {
    return {
      message_threads: [{ id: THREAD_ID, is_e2ee: true }],
      message_thread_members: [
        { thread_id: THREAD_ID, user_id: USER_ID, left_at: null },
        { thread_id: THREAD_ID, user_id: "other-user", left_at: null },
      ],
      messages: [] as any[],
      feature_flags: [] as any[],
      blocks: [] as any[],
      profiles: [{ id: USER_ID }],
    };
  }

  it("refuses with degraded_unavailable and inserts no message when the thread's E2EE flag is unreadable", async () => {
    const { client, writes } = makeRecordingClient({
      tables: tables(),
      failRead: (table, cols) => table === "message_threads" && cols.includes("is_e2ee"),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "POST", `/api/threads/${THREAD_ID}/messages`, {
      body: "my bank password is hunter2",
    });

    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
    const inserted = writes.filter((w) => w.table === "messages");
    assert.deepEqual(inserted, [],
      `plaintext must never be persisted on a guessed encryption state; recorded: ${JSON.stringify(inserted)}`);
  });
});

// ── 6. Earnings ledger — a failed fee-rule read used to write a default fee ────

describe("durable damage — the earnings ledger writes a DEFAULT platform fee when the fee-rule read fails", () => {
  const BUDDY_PROFILE_ID = "9999aaaa-1111-4222-8333-444444444444";
  const BOOKING = { id: "book-1", traveler_id: USER_ID, total_usd: 400, tip_usd: 0, deposit_usd: 0, cash_balance_usd: 0, addons_total_usd: 0, pricing_type: "hourly" };

  function tables() {
    return {
      rent_buddy_profiles: [{ id: BUDDY_PROFILE_ID, user_id: "buddy-user", buddy_level: "elite" }],
      rent_buddy_fee_rules: [{ buddy_level: "elite", platform_fee_percent: 12, traveler_service_fee_usd: 9 }],
      rent_buddy_earnings_ledger: [] as any[],
    };
  }

  it("writes no ledger row when rent_buddy_fee_rules is unreadable", async () => {
    const { client, writes } = makeRecordingClient({
      tables: tables(),
      failRead: (table) => table === "rent_buddy_fee_rules",
    });

    await createEarningsLedgerEntry(client, BOOKING, BUDDY_PROFILE_ID);

    const ledgerWrites = writes.filter((w) => w.table === "rent_buddy_earnings_ledger");
    assert.deepEqual(ledgerWrites, [],
      `money must never be written from a guessed fee; recorded: ${JSON.stringify(ledgerWrites)}`);
  });

  it("still writes the real negotiated fee when the read succeeds", async () => {
    const { client, writes } = makeRecordingClient({ tables: tables() });

    await createEarningsLedgerEntry(client, BOOKING, BUDDY_PROFILE_ID);

    const ledger = writes.find((w) => w.table === "rent_buddy_earnings_ledger");
    assert.ok(ledger, "the happy path must still write the ledger row");
    assert.equal((ledger!.payload as any).platform_fee_percent, 12, "the elite rate, not the 22% default");
    assert.equal((ledger!.payload as any).traveler_service_fee_amount, 9, "the real service fee, not 0");
  });
});

// ── 7. Trip chat thread — a failed trip read used to name the thread 'Trip Chat' ─

describe("durable damage — a failed trip read names the trip's one and only chat thread after a placeholder", () => {
  const TRIP_ID = "7777aaaa-1111-4222-8333-444444444444";

  function tables() {
    return {
      trips: [{ id: TRIP_ID, title: "Da Nang, March", destination_city: "Da Nang" }],
      message_threads: [] as any[],
      trip_members: [{ trip_id: TRIP_ID, user_id: USER_ID, role: "owner" }],
      message_thread_members: [] as any[],
    };
  }

  it("throws and creates no thread when the trip row is unreadable", async () => {
    const { client, writes } = makeRecordingClient({
      tables: tables(),
      failRead: (table) => table === "trips",
    });

    await assert.rejects(
      () => syncTripChatMembers(client, TRIP_ID),
      /unreadable/,
      "a failed trip read must refuse, not fall back to the 'Trip Chat' placeholder",
    );
    const threadWrites = writes.filter((w) => w.table === "message_threads");
    assert.deepEqual(threadWrites, [],
      `the thread is created once and keeps its title forever; recorded: ${JSON.stringify(threadWrites)}`);
  });

  it("still names the thread after the trip when the read succeeds", async () => {
    const { client, writes } = makeRecordingClient({ tables: tables() });

    await syncTripChatMembers(client, TRIP_ID);

    const created = writes.find((w) => w.table === "message_threads" && w.op === "insert");
    assert.ok(created, "the happy path must still create the thread");
    assert.equal((created!.payload as any).title, "Da Nang, March");
  });
});

// ── 8. No-show sweep — a failed read used to misattribute / duplicate a dispute ─

describe("durable damage — the no-show sweep files a dispute against the wrong party when the reporter read fails", () => {
  const BOOKING_ID = "8888aaaa-1111-4222-8333-444444444444";
  const TRAVELER   = "traveler-1";
  const BUDDY_USER = "buddy-user-1";

  function tables() {
    return {
      rent_buddy_bookings: [{
        id: BOOKING_ID, status: "no_show_pending", traveler_id: TRAVELER,
        buddy_id: "bp-1", no_show_grace_expires_at: "2000-01-01T00:00:00Z",
      }],
      // The BUDDY filed the no-show, not the traveler.
      buddy_booking_events: [{
        booking_id: BOOKING_ID, event: "no_show_reported", actor_user_id: BUDDY_USER,
        created_at: "2000-01-01T00:00:00Z",
      }],
      rent_buddy_disputes: [] as any[],
      rent_buddy_requests: [] as any[],
      feature_flags: [] as any[],
    };
  }

  beforeEach(() => { _resetStatus(); });

  it("opens no dispute at all when the reporting event is unreadable", async () => {
    const { client, writes } = makeRecordingClient({
      tables: tables(),
      failRead: (table, cols) => table === "buddy_booking_events" && cols.includes("actor_user_id"),
    });

    await runBuddyRequestSweep(client);

    const disputeWrites = writes.filter((w) => w.table === "rent_buddy_disputes");
    assert.deepEqual(disputeWrites, [],
      `a dispute durably attributed to the wrong party is worse than a late one; recorded: ${JSON.stringify(disputeWrites)}`);
    const bookingUpdates = writes.filter((w) => w.table === "rent_buddy_bookings" && w.op === "update");
    assert.deepEqual(bookingUpdates, [],
      "the booking must stay no_show_pending so the next sweep can retry");
  });

  it("opens no SECOND dispute when the existing-dispute lookup is unreadable", async () => {
    const { client, writes } = makeRecordingClient({
      tables: {
        ...tables(),
        rent_buddy_disputes: [{ id: "d-1", booking_id: BOOKING_ID, reason: "no_show", status: "open" }],
      },
      failRead: (table) => table === "rent_buddy_disputes",
    });

    await runBuddyRequestSweep(client);

    const disputeWrites = writes.filter((w) => w.table === "rent_buddy_disputes" && w.op !== "update");
    assert.deepEqual(disputeWrites, [],
      `an unreadable idempotency lookup must not insert a duplicate dispute; recorded: ${JSON.stringify(disputeWrites)}`);
  });

  it("still attributes the dispute to the real reporter when the reads succeed", async () => {
    const { client, writes } = makeRecordingClient({ tables: tables() });

    await runBuddyRequestSweep(client);

    const dispute = writes.find((w) => w.table === "rent_buddy_disputes" && w.op === "insert");
    assert.ok(dispute, "the happy path must still open the dispute");
    assert.equal((dispute!.payload as any).raised_by, BUDDY_USER,
      "the buddy filed it — the traveler fallback is for a genuinely missing row only");
  });
});

// ── 9. Booking add-ons — a failed read used to double-charge the traveler ──────

describe("durable damage — attaching add-ons double-charges when the idempotency read fails", () => {
  const BOOKING_ID = "aaaa1111-2222-4333-8444-555555555555";
  const ADDON_ID   = "bbbb1111-2222-4333-8444-555555555555";

  let server: http.Server;
  let base: string;

  before(async () => {
    ({ server, base } = await makeApp((app) => app.use("/api", marketplaceRouter)));
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  function tables() {
    return {
      feature_flags: [{ flag: "rent_buddy_enabled", key: "rent_buddy_enabled", enabled: true }],
      rent_buddy_bookings: [{
        id: BOOKING_ID, traveler_id: USER_ID, status: "requested", buddy_id: "bp-1",
        total_usd: 300, deposit_usd: 60, cash_balance_usd: 240, addons_total_usd: 0,
        category: "city_tour", pricing_type: "hourly", is_group_booking: false,
      }],
      rent_buddy_addons: [{ id: ADDON_ID, is_active: true, title: "Airport pickup", price_usd: 50 }],
      // The add-on is ALREADY attached — a retry must not charge for it twice.
      rent_buddy_booking_addons: [{ booking_id: BOOKING_ID, addon_id: ADDON_ID }],
      rent_buddy_user_limits: [{ user_id: USER_ID, cash_balance_disabled: true, full_in_app_payment_required: true }],
      rent_buddy_profiles: [{ id: "bp-1", buddy_level: "elite", cash_balance_accepted: false, risk_hold: false }],
    };
  }

  it("refuses with degraded_unavailable and charges nothing when the already-attached read fails", async () => {
    const { client, writes } = makeRecordingClient({
      tables: tables(),
      failRead: (table) => table === "rent_buddy_booking_addons",
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/addons`, { addonIds: [ADDON_ID] });

    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.deepEqual(writes, [],
      `an unreadable idempotency guard must not re-insert join rows or re-add the price; recorded: ${describeWrites(writes)}`);
  });

  it("refuses and writes nothing when a deposit input (user limits) is unreadable", async () => {
    const { client, writes } = makeRecordingClient({
      tables: { ...tables(), rent_buddy_booking_addons: [] },
      failRead: (table) => table === "rent_buddy_user_limits",
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/addons`, { addonIds: [ADDON_ID] });

    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.deepEqual(writes, [],
      `pricing inputs are read before any write, so a failure charges nothing; recorded: ${describeWrites(writes)}`);
  });

  it("still short-circuits (charging nothing) when the read succeeds and the add-on is already attached", async () => {
    const { client, writes } = makeRecordingClient({ tables: tables() });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq(base, "POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/addons`, { addonIds: [ADDON_ID] });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.alreadyAttached, true);
    assert.deepEqual(writes, [], `a genuine retry must be a no-op; recorded: ${describeWrites(writes)}`);
  });
});
