/**
 * Zero matched rows reported as success — the route sites found in the second
 * pass of the audit.
 *
 *   POST /rent-a-buddy/admin/safety/flags/:flagId/confirm   (routes/rentABuddy.ts)
 *     Confirming a CRITICAL policy flag puts the flagged buddy on `risk_hold`
 *     and sets `admin_status:"disabled"`. The statement's only predicate is
 *     user_id, so zero matched rows means the flagged user has no buddy profile
 *     at all — a flagged TRAVELLER, which is legitimate — but the handler
 *     discarded the result entirely (no `error`, no row count) and answered
 *     `{ok:true}` for all three outcomes: hold applied, nobody to hold, hold
 *     failed. The safety control being OFF looked exactly like it being ON.
 *
 *   PATCH /events/:id/requests/:userId                      (routes/events.ts)
 *     Nothing in that handler reads event_join_requests before writing it. An
 *     "approve" for a user who never requested to join matched zero rows,
 *     resolved `{ data: null, error: null }` like a successful approval, and
 *     the handler carried on to SEAT them: an unrequested `going` RSVP, a
 *     going_count bump, a chat-thread add and a "You're in! 🎉" push.
 *
 *   POST /shared-moments/:id/respond                        (routes/sharedMoments.ts)
 *     `.eq("status","invited")` is a compare-and-swap against a value read a
 *     moment earlier. Losing it is not an error, so an invitation revoked in
 *     between still answered `{ok:true, status:"accepted"}` and wrote an
 *     `invite_accepted` audit row — the caller was told they had joined a
 *     Moment they are not a member of.
 *
 * THE FAKE
 * ========
 * Rows are real, filters are really applied, and an UPDATE resolves to the rows
 * it MATCHED — `[]` when it matched none, and `null` when `.select()` was not
 * chained. A fake that only ever produced `{ error: null }` cannot express this
 * defect: the passing and the failing case are the same value.
 *
 * The `req.log` shim the real server installs is on the app below. Without it
 * these routes CRASH on `req.log.warn(...)`, and a 500-from-crash reads exactly
 * like a deliberate refusal — which is how a vacuous version of this test
 * passes. Every case therefore asserts the SPECIFIC status and body shape, and
 * every refusal case is paired with the happy path in the same describe block
 * so a 404 that came from a dead route would fail its twin.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/zeroRowMutations.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentBuddyRouter from "../routes/rentABuddy.js";
import eventsRouter from "../routes/events.js";
import sharedMomentsRouter from "../routes/sharedMoments.js";

const ADMIN_ID  = "bbbbbbbb-0000-0000-0000-000000000002";
const HOST_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const TARGET_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const FLAG_ID   = "cccccccc-0000-0000-0000-000000000003";
const EVENT_ID  = "dddddddd-0000-0000-0000-000000000004";
const MOMENT_ID = "eeeeeeee-0000-0000-0000-000000000005";

type Row = Record<string, any>;
interface Db {
  tables: Record<string, Row[]>;
  inserts: Array<{ table: string; row: Row }>;
  /**
   * One-shot race hook: runs ONCE, immediately after the next SELECT on that
   * table resolves and before the caller can issue its UPDATE. It is the only
   * honest way to reach a compare-and-swap that LOSES — the handler's
   * pre-check must really see the row in its expected state, or the test
   * proves something about the pre-check instead of about the write.
   */
  afterSelect: Record<string, (db: Db) => void>;
}

function makeClient(tables: Record<string, Row[]>): { db: Db; client: any } {
  const db: Db = { tables, inserts: [], afterSelect: {} };
  const src = (t: string) => (db.tables[t] ??= []);

  function from(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let verb: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: any = null;
    let onConflict: string[] = [];
    let returning = false;
    let single = false;
    const b: any = {
      select() { returning = true; return b; },
      insert(p: any) { verb = "insert"; payload = p; return b; },
      upsert(p: any, opts?: any) {
        verb = "upsert"; payload = p;
        onConflict = String(opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        return b;
      },
      update(p: any) { verb = "update"; payload = p; return b; },
      delete() { verb = "delete"; return b; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { preds.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      lt() { return b; }, gt() { return b; }, gte() { return b; }, lte() { return b; },
      not() { return b; }, ilike() { return b; }, or() { return b; }, contains() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };
    const match = () => src(table).filter((r) => preds.every((p) => p(r)));
    async function run(): Promise<{ data: any; error: any; count?: number }> {
      if (verb === "select") {
        const m = match();
        const out = { data: single ? (m[0] ?? null) : m, error: null, count: m.length };
        const hook = db.afterSelect[table];
        if (hook) { delete db.afterSelect[table]; hook(db); }
        return out;
      }
      if (verb === "insert" || verb === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]);
        const out: Row[] = [];
        for (const r of rows) {
          const hit = onConflict.length > 0
            ? src(table).find((e) => onConflict.every((c) => e[c] === r[c]))
            : undefined;
          if (hit) { Object.assign(hit, r); out.push(hit); }
          else {
            const row = { id: `gen-${src(table).length + 1}`, ...r };
            src(table).push(row); db.inserts.push({ table, row }); out.push(row);
          }
        }
        return { data: single ? (out[0] ?? null) : out, error: null };
      }
      const m = match();
      // Snapshot BEFORE mutating: RETURNING answers with the rows the statement
      // matched, and `[]` is the answer under test.
      const snapshot = m.map((r) => ({ ...r }));
      if (verb === "update") for (const r of m) Object.assign(r, payload);
      else db.tables[table] = src(table).filter((r) => !m.includes(r));
      return { data: returning ? (single ? (snapshot[0] ?? null) : snapshot) : null, error: null, count: snapshot.length };
    }
    return b;
  }

  return {
    db,
    client: {
      from,
      rpc: async () => ({ data: null, error: null }),
      auth: { getUser: async () => ({ data: { user: { id: CURRENT_USER } }, error: null }) },
      storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    },
  };
}

/** Who the bearer token belongs to for the next install(). */
let CURRENT_USER = ADMIN_ID;

function install(tables: Record<string, Row[]>, asUser = ADMIN_ID): Db {
  CURRENT_USER = asUser;
  const { db, client } = makeClient({
    profiles: [
      { id: ADMIN_ID, role: "admin", handle: "adm", display_name: "Adm" },
      { id: TARGET_ID, role: "user", handle: "tgt", display_name: "Tgt" },
    ],
    feature_flags: [],
    ...tables,
  });
  _setTestClient(client, true);
  _setTestServiceClient(client);
  return db;
}

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // The req.log shim the real server installs. Without it every route that logs
  // CRASHES, and the 500 reads like a refusal.
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => r.log };
    next();
  });
  app.use(rentBuddyRouter);
  app.use(eventsRouter);
  app.use(sharedMomentsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server.close());

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, body: parsed };
}

// ── Rent-A-Buddy critical policy flag → risk hold ───────────────────────────

describe("POST /rent-a-buddy/admin/safety/flags/:flagId/confirm — critical risk hold", () => {
  const criticalFlag = {
    id: FLAG_ID, severity: "critical", status: "open",
    flagged_user_id: TARGET_ID, category: "safety",
  };

  it("says no_buddy_profile when the flagged user has no buddy profile to hold", async () => {
    const db = install({
      rent_buddy_policy_flags: [{ ...criticalFlag }],
      rent_buddy_profiles: [],                 // the flagged user is a traveller
      rent_buddy_admin_actions: [],
      trust_events: [],
    });

    const { status, body } = await call("POST", `/rent-a-buddy/admin/safety/flags/${FLAG_ID}/confirm`, { notes: "confirmed" });

    assert.equal(status, 200, `expected the handler to run; got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.ok, true, "the flag WAS confirmed — that part really happened");
    assert.equal(
      body.riskHold,
      "no_buddy_profile",
      "no profile was held, and the admin must be told that rather than shown a bare ok:true",
    );
    assert.notEqual(body.riskHold, "applied");
    // The flag itself is still resolved: this is a truthful report, not a refusal.
    assert.equal(db.tables.rent_buddy_policy_flags[0]!.status, "resolved");
  });

  it("says applied — and really holds the profile — when the buddy exists", async () => {
    const db = install({
      rent_buddy_policy_flags: [{ ...criticalFlag }],
      rent_buddy_profiles: [{ user_id: TARGET_ID, risk_hold: false, admin_status: "active" }],
      rent_buddy_admin_actions: [],
      trust_events: [],
    });

    const { status, body } = await call("POST", `/rent-a-buddy/admin/safety/flags/${FLAG_ID}/confirm`, { notes: "confirmed" });

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.riskHold, "applied");
    assert.equal(db.tables.rent_buddy_profiles[0]!.risk_hold, true);
    assert.equal(db.tables.rent_buddy_profiles[0]!.admin_status, "disabled");
  });

  it("says not_applicable for a non-critical flag, which calls for no hold", async () => {
    install({
      rent_buddy_policy_flags: [{ ...criticalFlag, severity: "medium" }],
      rent_buddy_profiles: [{ user_id: TARGET_ID, risk_hold: false, admin_status: "active" }],
      rent_buddy_admin_actions: [],
      trust_events: [],
    });

    const { status, body } = await call("POST", `/rent-a-buddy/admin/safety/flags/${FLAG_ID}/confirm`, {});

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.riskHold, "not_applicable");
  });
});

// ── Event join requests ─────────────────────────────────────────────────────

describe("PATCH /events/:id/requests/:userId — approving a request nobody made", () => {
  const eventRow = {
    id: EVENT_ID, host_id: HOST_ID, state: "open", visibility: "public",
    max_attendees: null, waitlist_enabled: false, chat_enabled: false,
    chat_thread_id: null, going_count: 0, min_age: null, requires_verification: false,
  };

  it("refuses with the route's own not_found and creates no RSVP", async () => {
    const db = install({
      events: [{ ...eventRow }],
      event_join_requests: [],           // this user never asked to join
      event_rsvps: [],
      event_attendees: [],
      user_blocks: [],
    }, HOST_ID);

    const { status, body } = await call("PATCH", `/events/${EVENT_ID}/requests/${TARGET_ID}`, { action: "approve" });

    assert.equal(status, 404, `expected a refusal, got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.error, "not_found");
    assert.notEqual(body.ok, true);
    assert.equal(
      db.tables.event_rsvps.length,
      0,
      "a user who never requested to join must not be seated by an approval that matched nothing",
    );
  });

  it("approves a real request, and seats that user", async () => {
    const db = install({
      events: [{ ...eventRow }],
      event_join_requests: [{ event_id: EVENT_ID, user_id: TARGET_ID, status: "pending" }],
      event_rsvps: [],
      event_attendees: [],
      user_blocks: [],
    }, HOST_ID);

    const { status, body } = await call("PATCH", `/events/${EVENT_ID}/requests/${TARGET_ID}`, { action: "approve" });

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    assert.equal(db.tables.event_join_requests[0]!.status, "approved");
    assert.equal(db.tables.event_rsvps.length, 1, "the real approval really seats the user");
    assert.equal(db.tables.event_rsvps[0]!.status, "going");
  });

  it("refuses a deny for a request nobody made", async () => {
    install({
      events: [{ ...eventRow }],
      event_join_requests: [],
      event_rsvps: [],
      user_blocks: [],
    }, HOST_ID);

    const { status, body } = await call("PATCH", `/events/${EVENT_ID}/requests/${TARGET_ID}`, { action: "deny" });

    assert.equal(status, 404, `expected a refusal, got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.error, "not_found");
  });
});

// ── Shared Moment invitation response ───────────────────────────────────────

describe("POST /shared-moments/:id/respond — an invitation that vanished", () => {
  const moment = { id: MOMENT_ID, owner_id: ADMIN_ID, status: "active", join_policy: "invite_only" };
  // The whole Shared Moments surface is behind a capability gate that requires
  // its three parents as well. Without them every request here answers 404
  // `feature_disabled` — a refusal that has NOTHING to do with this fix and
  // would make the not_found case below pass for the wrong reason, which is
  // exactly why each case asserts `body.error` and not just the status.
  const momentFlags = [
    { flag: "external_places_enabled", enabled: true },
    { flag: "live_places_enabled",     enabled: true },
    { flag: "place_days_enabled",      enabled: true },
    { flag: "shared_moments_enabled",  enabled: true },
  ];

  it("accepting an invitation revoked between the read and the write is a not_found", async () => {
    const db = install({
      shared_moments: [{ ...moment }],
      shared_moment_memberships: [
        { moment_id: MOMENT_ID, user_id: TARGET_ID, status: "invited", role: "member" },
      ],
      shared_moment_audit_events: [],
      feature_flags: momentFlags,
    }, TARGET_ID);

    // The handler's pre-check really reads `invited` — so it passes, and the
    // compare-and-swap really runs. The owner revokes the invitation in that
    // window, so the CAS matches zero rows and (before the fix) resolved
    // `{ data: null, error: null }`: identical to a successful acceptance.
    db.afterSelect.shared_moment_memberships = (d) => {
      d.tables.shared_moment_memberships[0]!.status = "removed";
    };

    const { status, body } = await call("POST", `/shared-moments/${MOMENT_ID}/respond`, { response: "accept" });

    assert.equal(status, 404, `expected a refusal, got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.error, "not_found", "the route's own not-found, NOT a feature_disabled gate refusal");
    assert.notEqual(body.ok, true, "the caller must not be told they joined a Moment they are not in");
    assert.equal(
      db.tables.shared_moment_memberships[0]!.status,
      "removed",
      "the revoked membership is untouched",
    );
    assert.equal(
      db.inserts.filter((i) => i.table === "shared_moment_audit_events").length,
      0,
      "and no invite_accepted audit row records an acceptance that never happened",
    );
  });

  it("a live invitation is still accepted, and audited", async () => {
    const db = install({
      shared_moments: [{ ...moment }],
      shared_moment_memberships: [
        { moment_id: MOMENT_ID, user_id: TARGET_ID, status: "invited", role: "member" },
      ],
      shared_moment_audit_events: [],
      feature_flags: momentFlags,
    }, TARGET_ID);

    const { status, body } = await call("POST", `/shared-moments/${MOMENT_ID}/respond`, { response: "accept" });

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.status, "accepted");
    assert.equal(db.tables.shared_moment_memberships[0]!.status, "accepted");
  });
});
