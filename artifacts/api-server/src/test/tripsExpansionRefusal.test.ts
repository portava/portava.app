/**
 * trips-expansion — a read that did not answer, and a write that did not land,
 * must not be reported as an answer or as success.
 *
 * WHAT THIS FILE MEASURES, AND WHY IT EXISTS
 * ==========================================
 * Two defect classes were live in routes/trips-expansion.ts:
 *
 *   1. READS. supabase-js RESOLVES on a database error — `{ data: null, error }`
 *      is what a failed read looks like, byte-identical to "no such row" unless
 *      `error` is bound. Sixty sites dropped `.error` and turned `null` into a
 *      confident sentence: "Trip not found", `items: []`, `budget: null`,
 *      `trips: []`, `[]` for the owner's invite links. Two of them failed OPEN
 *      (`isFull: false` in the invite-link preview and in POST accept's
 *      capacity pre-flight).
 *
 *   2. WRITES. Eighteen writes bound no `.error`; eight of those were UPDATEs
 *      with no `.select()`, which returns `data: null` and so reports NO
 *      affected-row count. `error === null` was read as "it worked" for writes
 *      that failed outright AND for writes that matched nothing.
 *
 * THE INSTRUMENT
 * ==============
 * A fake supabase client that models what the real one does and NOTHING it does
 * not:
 *   - it can return `{ data: null, error }` per (table, verb), which is the
 *     whole point — a double that only ever models `{ error: null }` cannot
 *     fail any of these tests;
 *   - a write chain carrying `.select()` returns the AFFECTED ROWS, and one
 *     without it returns `data: null`, so "updated one row" and "matched
 *     nothing" are distinguishable exactly where the real client makes them so;
 *   - `matchNothing` makes an UPDATE match zero rows while the preceding SELECT
 *     still sees the row — the concurrent-delete / refused-write shape, and the
 *     only way to exercise the zero-row branch honestly;
 *   - every chain that reaches its terminal is recorded in `issued`, so a write
 *     is proven SENT by counting requests at runtime rather than by reading the
 *     source. (`void builder` sends nothing; nothing here relies on believing a
 *     line of code was reached.)
 *
 * The routes run inside the real `app`, so the real global error handler
 * (lib/errorEnvelope.ts) is what turns a thrown refusal into its response, and
 * `req.log` is the real pino-http logger — a route that crashed for want of a
 * log shim would surface as a 500 with `error: "INTERNAL_ERROR"`, which every
 * assertion below would reject, rather than passing as a fail-closed 503.
 *
 * Runtime: node:test + node:assert/strict. The verdict is the exit code.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tripsExpansionRefusal.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── IDs ──────────────────────────────────────────────────────────────────────
const OWNER = "11111111-2222-3333-4444-555555555551";
const OTHER = "11111111-2222-3333-4444-555555555552";
const TRIP  = "aaaaaaa1-bbbb-cccc-dddd-eeeeeeeeeee1";
const DOC   = "aaaaaaa2-bbbb-cccc-dddd-eeeeeeeeeee2";
const LINK  = "aaaaaaa3-bbbb-cccc-dddd-eeeeeeeeeee3";
const JREQ  = "aaaaaaa4-bbbb-cccc-dddd-eeeeeeeeeee4";
const LIST  = "aaaaaaa5-bbbb-cccc-dddd-eeeeeeeeeee5";
const DEST1 = "aaaaaaa6-bbbb-cccc-dddd-eeeeeeeeeee6";
const DEST2 = "aaaaaaa7-bbbb-cccc-dddd-eeeeeeeeeee7";
const TOKEN = "invite-token-abc";

type Verb = "select" | "insert" | "update" | "upsert" | "delete";

/**
 * VACUITY METER. A fresh fake is installed before every test, so no single
 * fake's `issued` list can prove the file measured anything. These accumulate
 * across the whole run and are asserted non-zero at the end: a build where the
 * routes never reached the client, or where `assertRefused` was never called,
 * fails instead of printing a green nothing.
 */
const METER = { issued: 0, refusalsAsserted: 0, writesObserved: 0 };

interface Fake {
  client: any;
  /** Every chain that reached its terminal, in order. Proof a write was SENT. */
  issued: Array<{ table: string; verb: Verb; selected: boolean }>;
  /** Inject `{ data: null, error }` for a (table, verb) pair. */
  failOn: (table: string, verb: Verb, message?: string) => void;
  /** Make UPDATEs on `table` match zero rows (SELECTs still see the rows). */
  matchNothing: (table: string) => void;
  tables: Record<string, any[]>;
}

function buildFake(): Fake {
  const tables: Record<string, any[]> = {
    profiles: [
      { id: OWNER, handle: "owner", name: "Owner", display_name: "Owner", account_status: null },
      { id: OTHER, handle: "other", name: "Other", display_name: "Other", account_status: null },
    ],
    trips: [{
      id: TRIP, owner_id: OWNER, title: "Lisbon", destination_city: "Lisbon",
      destination_country: "PT", start_date: "2030-01-01", end_date: "2030-01-10",
      status: "upcoming", visibility: "private", allow_join_requests: true,
      max_members: null, timezone: "UTC", created_at: "2026-01-01T00:00:00.000Z",
    }],
    trip_members: [{ trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" }],
    trip_documents: [{ id: DOC, trip_id: TRIP, creator_id: OWNER, title: "Visa", is_private: false, document_type: "visa" }],
    trip_invite_links: [{ id: LINK, trip_id: TRIP, token: TOKEN, created_by: OWNER, use_count: 0, max_uses: null, expires_at: null, revoked_at: null, created_at: "2026-01-01T00:00:00.000Z" }],
    trip_join_requests: [{ id: JREQ, trip_id: TRIP, user_id: OTHER, status: "pending", message: null, created_at: "2026-01-01T00:00:00.000Z" }],
    trip_checklists: [{ id: LIST, trip_id: TRIP, title: "Packing", created_by: OWNER, created_at: "2026-01-01T00:00:00.000Z" }],
    trip_checklist_items: [{ id: "item-1", checklist_id: LIST, trip_id: TRIP, label: "Passport", is_done: false, sort_order: 1 }],
    trip_destinations: [
      { id: DEST1, trip_id: TRIP, city: "Porto", position: 1 },
      { id: DEST2, trip_id: TRIP, city: "Faro",  position: 2 },
    ],
    trip_budget: [{ trip_id: TRIP, currency: "EUR", total_budget: 1000, spent: 0 }],
    trip_notes: [], trip_saved_places: [], trip_reminders: [], trip_activity_log: [],
    plan_editors: [], blocks: [], user_follows: [], trip_invite_link_attempts: [],
    feature_flags: [], discovery_places: [],
  };

  const errors = new Map<string, string>();
  const nothing = new Set<string>();
  const issued: Fake["issued"] = [];

  function rows(t: string): any[] { if (!tables[t]) tables[t] = []; return tables[t]; }

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let verb: Verb = "select";
    let payload: any = null;
    let selected = false;
    let single = false;

    const b: any = {
      select() { selected = true; return b; },
      insert(p: any) { verb = "insert"; payload = p; return b; },
      update(p: any) { verb = "update"; payload = p; return b; },
      upsert(p: any) { verb = "upsert"; payload = p; return b; },
      delete() { verb = "delete"; return b; },
      eq(c: string, v: any)  { preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { preds.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any)  { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      not(c: string, op: string, v: any) { if (op === "is") preds.push((r) => r[c] !== v); return b; },
      gte(c: string, v: any) { preds.push((r) => r[c] >= v); return b; },
      lte(c: string, v: any) { preds.push((r) => r[c] <= v); return b; },
      gt(c: string, v: any)  { preds.push((r) => r[c] >  v); return b; },
      lt(c: string, v: any)  { preds.push((r) => r[c] <  v); return b; },
      or()    { return b; },
      ilike() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      maybeSingle() { single = true; return run(); },
      single()      { single = true; return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };

    async function run(): Promise<{ data: any; error: any }> {
      issued.push({ table, verb, selected });
      METER.issued += 1;
      if (verb !== "select") METER.writesObserved += 1;
      const injected = errors.get(`${table}:${verb}`);
      // The real client RESOLVES on a database error; it does not throw.
      if (injected) return { data: null, error: { message: injected, code: "PGRST999" } };

      const match = () => rows(table).filter((r) => preds.every((p) => p(r)));

      if (verb === "select") {
        const m = match();
        return { data: single ? (m[0] ?? null) : m, error: null };
      }
      if (verb === "insert" || verb === "upsert") {
        const list = (Array.isArray(payload) ? payload : [payload])
          .map((r: any, i: number) => ({ id: `${table}-new-${rows(table).length + i + 1}`, created_at: "2026-02-01T00:00:00.000Z", ...r }));
        rows(table).push(...list);
        if (single) return { data: list[0] ?? null, error: null };
        return { data: selected ? list : null, error: null };
      }
      if (verb === "update") {
        const touched: any[] = [];
        if (!nothing.has(table)) {
          for (const r of rows(table)) if (preds.every((p) => p(r))) { Object.assign(r, payload); touched.push(r); }
        }
        if (single) return { data: touched[0] ?? null, error: null };
        // A write with NO `.select()` cannot report an affected-row count.
        return { data: selected ? touched : null, error: null };
      }
      tables[table] = rows(table).filter((r) => !preds.every((p) => p(r)));
      return { data: selected ? [] : null, error: null };
    }

    return b;
  }

  const client: any = {
    auth: {
      getUser: async (t: string) => {
        if (t === "owner-token") return { data: { user: { id: OWNER } }, error: null };
        if (t === "other-token") return { data: { user: { id: OTHER } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from,
    rpc: async (fn: string) => {
      if (fn === "claim_invite_link_slot_for_user") return { data: "claimed", error: null };
      if (fn === "release_invite_link_slot") return { data: null, error: null };
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
  };

  return {
    client, issued, tables,
    failOn: (t, v, m = `${t} ${v} unavailable`) => errors.set(`${t}:${v}`, m),
    matchNothing: (t) => nothing.add(t),
  };
}

// ── HTTP harness ─────────────────────────────────────────────────────────────
let server: Server;
let port: number;

before(async () => {
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; resolve(); });
  });
});
after(() => { server?.close(); });

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: any } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get("content-type") ?? "";
  let body: any = null;
  try { body = ct.includes("application/json") ? await res.json() : await res.text(); } catch { body = null; }
  return { status: res.status, body };
}

let fake: Fake;
function install(): Fake { fake = buildFake(); _setTestClient(fake.client, true); return fake; }
beforeEach(() => { install(); });

/** The refusal a read that did not answer must produce — never a 404 or a []. */
function assertRefused(r: { status: number; body: any }, where: string): void {
  METER.refusalsAsserted += 1;
  assert.equal(r.status, 503, `${where}: expected 503, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.error, "degraded_unavailable", `${where}: wrong code ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.retryable, true, `${where}: refusal must be retryable`);
}

// ═════════════════════════════════════════════════════════════════════════════
describe("trips-expansion: an unreadable table is not an empty one", () => {
  it("GET /trips/upcoming — an unreadable trip_members is NOT 'you have no trips'", async () => {
    fake.failOn("trip_members", "select");
    const r = await call("GET", "/trips/upcoming", { token: "owner-token" });
    assertRefused(r, "upcoming");
    assert.notDeepEqual(r.body, { trips: [] });
  });

  it("GET /trips/active and /trips/past refuse on the same read", async () => {
    fake.failOn("trip_members", "select");
    assertRefused(await call("GET", "/trips/active", { token: "owner-token" }), "active");
    assertRefused(await call("GET", "/trips/past",   { token: "owner-token" }), "past");
  });

  it("GET /trips/join-requests — an unreadable trips is NOT 'no pending requests'", async () => {
    fake.failOn("trips", "select");
    assertRefused(await call("GET", "/trips/join-requests", { token: "owner-token" }), "join-requests");
  });

  it("GET /trips/:id/checklists — an unreadable trip_checklist_items is NOT an empty checklist", async () => {
    fake.failOn("trip_checklist_items", "select");
    const r = await call("GET", `/trips/${TRIP}/checklists`, { token: "owner-token" });
    assertRefused(r, "checklists");
    // The specific false answer this replaces: a checklist rendered with items: [].
    assert.equal(Array.isArray(r.body?.checklists), false);
  });

  it("GET /trips/:id/budget — an unreadable trip_budget is NOT 'no budget set'", async () => {
    fake.failOn("trip_budget", "select");
    const r = await call("GET", `/trips/${TRIP}/budget`, { token: "owner-token" });
    assertRefused(r, "budget");
    assert.notDeepEqual(r.body, { budget: null });
  });

  it("GET /trips/:id/invite-links — an unreadable trip_invite_links is NOT '[]' on the owner's security surface", async () => {
    fake.failOn("trip_invite_links", "select");
    const r = await call("GET", `/trips/${TRIP}/invite-links`, { token: "owner-token" });
    assertRefused(r, "invite-links");
    assert.notDeepEqual(r.body, []);
  });

  it("POST /trips/:id/cancel — an unreadable trips is NOT 'Trip not found'", async () => {
    fake.failOn("trips", "select");
    const r = await call("POST", `/trips/${TRIP}/cancel`, { token: "owner-token" });
    assertRefused(r, "cancel");
    assert.notEqual(r.body?.error, "not_found");
  });

  it("GET /trips/:id (deep link, no auth) — an unreadable trips is NOT a 404", async () => {
    fake.failOn("trips", "select");
    const r = await call("GET", `/trips/${TRIP}`);
    assertRefused(r, "public trip GET");
    assert.notEqual(r.body?.error, "not_found");
  });

  it("GET /trips/:id/documents — an unreadable trip_documents refuses rather than showing an empty locker", async () => {
    fake.failOn("trip_documents", "select");
    const r = await call("GET", `/trips/${TRIP}/documents`, { token: "owner-token" });
    // This one already bound its error and answers db_error; either way it must
    // not be a 200 with an empty list.
    assert.notEqual(r.status, 200, `documents: got 200 ${JSON.stringify(r.body)}`);
    assert.ok(r.status === 500 || r.status === 503, `documents: unexpected ${r.status}`);
  });

  it("invite-link preview — an unreadable trip_members no longer answers isFull:false (the fail-OPEN one)", async () => {
    fake.tables.trips[0].max_members = 2;
    fake.failOn("trip_members", "select");
    const r = await call("GET", `/trips/invite-link/${TOKEN}/preview`, { token: "other-token" });
    assertRefused(r, "invite-link preview");
    assert.notEqual(r.body?.isFull, false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("trips-expansion: a write that did not land is not success", () => {
  it("POST /trips/:id/cancel — a FAILED trips UPDATE is not {status:'cancelled'}", async () => {
    fake.failOn("trips", "update");
    const r = await call("POST", `/trips/${TRIP}/cancel`, { token: "owner-token" });
    assert.equal(r.status, 500, `cancel: got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "db_error");
    assert.notEqual(r.body?.status, "cancelled");
    // The write really was SENT — counted, not inferred from the source.
    const writes = fake.issued.filter((w) => w.table === "trips" && w.verb === "update");
    assert.equal(writes.length, 1, "the cancel UPDATE must actually be issued");
    // And the trip is still not cancelled.
    assert.equal(fake.tables.trips[0].status, "upcoming");
  });

  it("POST /trips/:id/cancel — a ZERO-ROW trips UPDATE is not {status:'cancelled'}", async () => {
    fake.matchNothing("trips");
    const r = await call("POST", `/trips/${TRIP}/cancel`, { token: "owner-token" });
    assert.equal(r.status, 404, `cancel(0 rows): got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "not_found");
    const writes = fake.issued.filter((w) => w.table === "trips" && w.verb === "update");
    assert.equal(writes.length, 1);
    // The affected-row count is only observable because the chain carries .select().
    assert.equal(writes[0].selected, true, "the UPDATE must carry .select() or it cannot count rows");
  });

  it("POST /trips/:id/complete and /archive refuse a zero-row UPDATE the same way", async () => {
    fake.matchNothing("trips");
    const c = await call("POST", `/trips/${TRIP}/complete`, { token: "owner-token" });
    assert.equal(c.status, 404, `complete: ${c.status} ${JSON.stringify(c.body)}`);
    const a = await call("POST", `/trips/${TRIP}/archive`, { token: "owner-token" });
    assert.equal(a.status, 404, `archive: ${a.status} ${JSON.stringify(a.body)}`);
  });

  it("DELETE /trips/:id/invite-link/:linkId — a FAILED revoke is not 204", async () => {
    fake.failOn("trip_invite_links", "update");
    const r = await call("DELETE", `/trips/${TRIP}/invite-link/${LINK}`, { token: "owner-token" });
    assert.notEqual(r.status, 204, "a revoke that failed must not report 204");
    assert.equal(r.status, 500, `revoke: ${r.status} ${JSON.stringify(r.body)}`);
    // The link is still live — which is exactly why the 204 was dangerous.
    assert.equal(fake.tables.trip_invite_links[0].revoked_at, null);
    assert.equal(fake.issued.filter((w) => w.table === "trip_invite_links" && w.verb === "update").length, 1);
  });

  it("DELETE /trips/:id/invite-link/:linkId — a ZERO-ROW revoke is not 204", async () => {
    fake.matchNothing("trip_invite_links");
    const r = await call("DELETE", `/trips/${TRIP}/invite-link/${LINK}`, { token: "owner-token" });
    assert.equal(r.status, 404, `revoke(0 rows): ${r.status} ${JSON.stringify(r.body)}`);
  });

  it("POST .../join-requests/:id/approve — a FAILED status write is not {status:'approved'}", async () => {
    fake.failOn("trip_join_requests", "update");
    const r = await call("POST", `/trips/${TRIP}/join-requests/${JREQ}/approve`, { token: "owner-token" });
    assert.notEqual(r.status, 200, "approve must not answer 200 when the request row did not transition");
    assert.equal(r.body?.error, "db_error");
    assert.equal(fake.tables.trip_join_requests[0].status, "pending");
  });

  it("POST .../join-requests/:id/cancel — a ZERO-ROW write is not {status:'cancelled'}", async () => {
    fake.matchNothing("trip_join_requests");
    const r = await call("POST", `/trips/${TRIP}/join-requests/${JREQ}/cancel`, { token: "other-token" });
    assert.equal(r.status, 404, `jr cancel: ${r.status} ${JSON.stringify(r.body)}`);
    assert.notEqual(r.body?.status, "cancelled");
  });

  it("DELETE a document — a FAILED delete is not 204", async () => {
    fake.failOn("trip_documents", "delete");
    const r = await call("DELETE", `/trips/${TRIP}/documents/${DOC}`, { token: "owner-token" });
    assert.notEqual(r.status, 204, "a delete that failed must not report 204");
    assert.equal(r.status, 500, `doc delete: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(fake.tables.trip_documents.length, 1, "the document is still there");
    assert.equal(fake.issued.filter((w) => w.table === "trip_documents" && w.verb === "delete").length, 1);
  });

  it("DELETE a checklist — a FAILED items delete refuses BEFORE orphaning them", async () => {
    fake.failOn("trip_checklist_items", "delete");
    const r = await call("DELETE", `/trips/${TRIP}/checklists/${LIST}`, { token: "owner-token" });
    assert.equal(r.status, 500, `checklist delete: ${r.status} ${JSON.stringify(r.body)}`);
    // The parent list must still exist, or the items are unreachable.
    assert.equal(fake.tables.trip_checklists.length, 1, "the checklist must survive a failed item delete");
    assert.equal(fake.issued.filter((w) => w.table === "trip_checklists" && w.verb === "delete").length, 0,
      "the list delete must not be issued after the item delete failed");
  });

  it("POST .../destinations/reorder — a FAILED position write is not {status:'reordered'}", async () => {
    fake.failOn("trip_destinations", "update");
    const r = await call("POST", `/trips/${TRIP}/destinations/reorder`, {
      token: "owner-token", body: { order: [DEST2, DEST1] },
    });
    assert.notEqual(r.status, 200, "a reorder that wrote nothing must not answer 200");
    assert.equal(r.body?.error, "db_error");
    assert.notEqual(r.body?.status, "reordered");
    // Both position writes were ISSUED (a `void builder` would have sent none).
    const writes = fake.issued.filter((w) => w.table === "trip_destinations" && w.verb === "update");
    assert.equal(writes.length, 2, "one UPDATE per id must actually be issued");
    assert.ok(writes.every((w) => w.selected), "each reorder UPDATE must carry .select()");
    // Positions unchanged.
    assert.deepEqual(
      fake.tables.trip_destinations.map((d: any) => [d.id, d.position]),
      [[DEST1, 1], [DEST2, 2]],
    );
  });

  it("PATCH settings — a FAILED plan_editors insert does not answer 200 with an empty editor list", async () => {
    fake.failOn("plan_editors", "insert");
    const r = await call("PATCH", `/trips/${TRIP}/settings`, {
      token: "owner-token",
      body: { planEditPermission: "specific_members", planEditors: [OTHER] },
    });
    assert.notEqual(r.status, 200, "a settings save that lost the editor list must not answer 200");
    assert.equal(r.body?.error, "db_error");
    assert.equal(fake.tables.plan_editors.length, 0);
  });

  it("PATCH a document that matches no row answers 404, not 200 with a null body", async () => {
    fake.matchNothing("trip_documents");
    const r = await call("PATCH", `/trips/${TRIP}/documents/${DOC}`, {
      token: "owner-token", body: { title: "Renamed" },
    });
    assert.equal(r.status, 404, `doc patch: ${r.status} ${JSON.stringify(r.body)}`);
    assert.notEqual(r.body, null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("trips-expansion: the healthy path is unchanged", () => {
  it("cancel, revoke, approve and reorder still succeed against a working database", async () => {
    const cancel = await call("POST", `/trips/${TRIP}/cancel`, { token: "owner-token" });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.equal(cancel.body.status, "cancelled");
    assert.equal(fake.tables.trips[0].status, "cancelled");

    install();
    const revoke = await call("DELETE", `/trips/${TRIP}/invite-link/${LINK}`, { token: "owner-token" });
    assert.equal(revoke.status, 204);
    assert.notEqual(fake.tables.trip_invite_links[0].revoked_at, null);

    install();
    const approve = await call("POST", `/trips/${TRIP}/join-requests/${JREQ}/approve`, { token: "owner-token" });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.equal(fake.tables.trip_join_requests[0].status, "approved");

    install();
    const reorder = await call("POST", `/trips/${TRIP}/destinations/reorder`, {
      token: "owner-token", body: { order: [DEST2, DEST1] },
    });
    assert.equal(reorder.status, 200, JSON.stringify(reorder.body));
    assert.equal(reorder.body.status, "reordered");
    assert.deepEqual(
      fake.tables.trip_destinations.map((d: any) => [d.id, d.position]).sort(),
      [[DEST1, 2], [DEST2, 1]].sort(),
    );

    install();
    const lists = await call("GET", `/trips/${TRIP}/checklists`, { token: "owner-token" });
    assert.equal(lists.status, 200, JSON.stringify(lists.body));
    assert.equal(lists.body.checklists.length, 1);
    assert.equal(lists.body.checklists[0].items.length, 1);

    install();
    const budget = await call("GET", `/trips/${TRIP}/budget`, { token: "owner-token" });
    assert.equal(budget.status, 200);
    assert.equal(budget.body.budget.currency, "EUR");
  });

  it("a genuinely absent trip is still 404, not 503", async () => {
    const r = await call("POST", "/trips/aaaaaaa9-bbbb-cccc-dddd-eeeeeeeeeee9/cancel", { token: "owner-token" });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "not_found");
  });

  it("VACUITY GUARD — the instrument actually issued requests and asserted refusals", () => {
    // Counts, not vibes: this file is worthless if the routes never reached the
    // client or if no assertion ever looked at a refusal.
    assert.ok(METER.issued > 100, `only ${METER.issued} supabase chains reached a terminal`);
    assert.ok(METER.writesObserved > 15, `only ${METER.writesObserved} write chains were issued`);
    assert.equal(METER.refusalsAsserted, 10, `expected 10 fail-closed refusals asserted, saw ${METER.refusalsAsserted}`);
  });
});
