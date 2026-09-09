/**
 * The pending-restoration queue — making an owed restoration OPERATOR-VISIBLE
 * (services/appeals/pendingRestorations.ts;
 *  routes/appeals.ts GET /api/appeals/restorations/pending)
 *
 * THE DEFECT THIS CLOSES
 * ======================
 * `resolveAppeal` correctly refuses to invent a restoration: when the
 * `trip_members` row was DELETEd by REMOVE_PARTICIPANT it answers
 * `restore_requires_policy` with `restored: false`, the appeal still resolves
 * to `approved`, and the appellant is told a moderator must still act.
 *
 * All of which was recorded in ONE PLACE: a `req.log.error` line, emitted once,
 * at the moment of approval. Nobody could ask the system "which restorations do
 * we owe?" and get an answer. An unbounded queue of people who were told their
 * appeal succeeded, held in a log shipper, is not a queue anyone works.
 *
 * WHAT IS PROVEN
 * ==============
 *   unit  an approved trip_membership appeal whose member row is ABSENT is
 *         listed, carrying the appeal id, the trip, the appellant, the
 *         required command and the open owner decision;
 *         a member row that is present as 'member' clears it;
 *         a member row present as 'co_host' does NOT clear it (restoring means
 *         rewriting that role, which is the decision itself);
 *         a CROSS-PAIR row — user Y's legitimate membership of trip A, over a
 *         page asking about (A,X) and (B,Y) — clears NEITHER appeal: the
 *         `.in()` lookup is a cross product and pairs are re-checked exactly;
 *         an event_membership appeal with no RSVP row is listed too;
 *         appeals not in state 'approved' are not listed;
 *         a READ FAILURE returns ok:false — never an empty queue;
 *         the listing performs ZERO writes.
 *   route admin GET returns 200 and the pending entry;
 *         a non-admin gets 403 forbidden and NO queue contents;
 *         an unauthenticated caller gets 401;
 *         a failed read is 500 db_error with no `pending` key at all.
 *   e2e   approving a trip_membership appeal whose member row is gone makes it
 *         appear in the queue on the very next admin GET. This is the whole
 *         point: the two halves are wired to each other, not just individually
 *         correct.
 *
 * THE FAKE
 * ========
 * Rows are real, filters are really applied (including `.in()` and `.range()`),
 * and every write is recorded, so "the queue listed nothing because it wrote
 * nothing and read nothing" cannot pass as success. Reads can be made to
 * RESOLVE an error (never throw), because that is how PostgREST reports one and
 * it is the case in which an empty list would be a lie.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/appealRestorePendingQueue.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { listPendingRestorations } from "../services/appeals/pendingRestorations.js";

const APPELLANT = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER     = "bbbbbbbb-0000-0000-0000-000000000002";
const ADMIN     = "cccccccc-0000-0000-0000-000000000003";
const TRIP      = "33333333-0000-0000-0000-000000000001";
const TRIP_2    = "33333333-0000-0000-0000-000000000002";
const EVENT     = "44444444-0000-0000-0000-000000000001";
const APPEAL    = "99999999-0000-0000-0000-000000000001";
const APPEAL_2  = "99999999-0000-0000-0000-000000000002";

type Row = Record<string, any>;
interface Write { table: string; verb: string; matched: number }

interface Spec {
  tables: Record<string, Row[]>;
  writes: Write[];
  /** table -> resolved error for READS on that table. Never a throw. */
  failReadsOn?: Record<string, { message: string; code?: string }>;
}

function makeClient(spec: Spec): any {
  const T = spec.tables;
  const src = (t: string) => (T[t] ??= []);

  function from(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let verb: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: any = null;
    let returning = false;
    let single = false;
    let lo = 0;
    let hi = Number.MAX_SAFE_INTEGER;

    const b: any = {
      select() { returning = true; return b; },
      insert(p: any) { verb = "insert"; payload = p; return b; },
      upsert(p: any) { verb = "upsert"; payload = p; return b; },
      update(p: any) { verb = "update"; payload = p; return b; },
      delete() { verb = "delete"; return b; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { preds.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      not(c: string, op: string, v: any) { if (op === "is") preds.push((r) => r[c] !== v); return b; },
      order() { return b; },
      range(a: number, z: number) { lo = a; hi = z; return b; },
      limit() { return b; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };

    const match = () => src(table).filter((r) => preds.every((p) => p(r)));

    async function run(): Promise<{ data: any; error: any }> {
      if (verb === "select") {
        const e = spec.failReadsOn?.[table];
        if (e) return { data: null, error: e };
        const m = match().slice(lo, hi + 1);
        return { data: single ? (m[0] ?? null) : m, error: null };
      }
      if (verb === "insert" || verb === "upsert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        const made = rows.map((r) => ({ id: `gen-${src(table).length + 1}`, ...r }));
        src(table).push(...made);
        spec.writes.push({ table, verb, matched: made.length });
        return { data: single ? (made[0] ?? null) : made, error: null };
      }
      if (verb === "update") {
        const m = match();
        for (const r of m) Object.assign(r, payload);
        spec.writes.push({ table, verb, matched: m.length });
        if (!returning) return { data: null, error: null };
        return { data: single ? (m[0] ?? null) : m, error: null };
      }
      const m = match();
      T[table] = src(table).filter((r) => !m.includes(r));
      spec.writes.push({ table, verb, matched: m.length });
      return { data: null, error: null };
    }
    return b;
  }

  return {
    from,
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async (token: string) => {
        if (token === "appellant-token") return { data: { user: { id: APPELLANT } }, error: null };
        if (token === "admin-token") return { data: { user: { id: ADMIN } }, error: null };
        if (token === "user-token") return { data: { user: { id: OTHER } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
}

function appealRow(over: Row = {}): Row {
  return {
    id:              APPEAL,
    appellant_id:    APPELLANT,
    target_type:     "trip_membership",
    target_id:       TRIP,
    reason:          "I was removed from this trip without cause and would like it reviewed.",
    state:           "approved",
    evidence_url:    null,
    resolution_note: "Upheld — the removal was not justified.",
    moderator_id:    ADMIN,
    created_at:      "2026-01-01T00:00:00Z",
    updated_at:      "2026-01-02T00:00:00Z",
    ...over,
  };
}

function spec(over: Partial<Spec["tables"]> = {}, failReadsOn?: Spec["failReadsOn"]): Spec {
  return {
    tables: {
      appeals:       [],
      trip_members:  [],
      event_rsvps:   [],
      profiles:      [{ id: ADMIN, role: "admin" }, { id: APPELLANT, role: "user" }, { id: OTHER, role: "user" }],
      notifications: [],
      ...over,
    },
    writes: [],
    failReadsOn,
  };
}

// ── The unit ─────────────────────────────────────────────────────────────────

describe("listPendingRestorations — the restorations an approved appeal still owes", () => {
  it("lists an approved trip_membership appeal whose member row is GONE, with the ids and the open decision", async () => {
    const s = spec({ appeals: [appealRow()], trip_members: [] });
    const r = await listPendingRestorations(makeClient(s));

    assert.equal(r.ok, true, `expected a readable queue, got ${JSON.stringify(r)}`);
    if (!r.ok) return;
    assert.equal(r.pending.length, 1, "the restoration was promised and never performed");
    assert.equal(r.scanned, 1);

    const p = r.pending[0];
    assert.equal(p.appealId, APPEAL);
    assert.equal(p.appellantId, APPELLANT);
    assert.equal(p.targetType, "trip_membership");
    assert.equal(p.targetId, TRIP);
    assert.equal(p.moderatorId, ADMIN, "an operator needs to know who approved it");
    assert.equal(p.approvedAt, "2026-01-02T00:00:00Z", "and how long it has been owed");
    assert.equal(p.requiredCommand, "ADMIN_RESTORE_PARTICIPANT");
    assert.equal(p.blockedOn, "APPEAL_RESTORE_SEMANTICS");
    assert.match(p.reason, /trip_members row absent/);

    // Listing the queue must never be the thing that performs the restoration.
    assert.deepEqual(s.writes, [], `the queue is read-only; saw ${JSON.stringify(s.writes)}`);
  });

  it("an intact 'member' row clears the entry — the queue empties on ground truth, not on a flag", async () => {
    const s = spec({
      appeals: [appealRow()],
      trip_members: [{ trip_id: TRIP, user_id: APPELLANT, role: "member", status: "accepted" }],
    });
    const r = await listPendingRestorations(makeClient(s));

    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.pending, []);
    assert.equal(r.scanned, 1, "it was examined and found already restored — not skipped");
  });

  it("a row present as co_host stays pending: restoring it would mean rewriting that role", async () => {
    const s = spec({
      appeals: [appealRow()],
      trip_members: [{ trip_id: TRIP, user_id: APPELLANT, role: "co_host", status: "accepted" }],
    });
    const r = await listPendingRestorations(makeClient(s));

    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.pending.length, 1);
    assert.match(r.pending[0].reason, /role 'co_host'/);
    assert.equal(r.pending[0].blockedOn, "APPEAL_RESTORE_SEMANTICS");
  });

  it("a CROSS-PAIR membership row clears neither appeal — pairs are matched exactly", async () => {
    // The membership lookup is `.in("trip_id", [A,B]).in("user_id", [X,Y])`,
    // which is a CROSS PRODUCT: it returns rows for (A,Y) and (B,X) as well as
    // the two pairs actually asked about. This page asks about (A,X) and (B,Y);
    // the only membership row in the database is (A,Y) — Y is legitimately on
    // trip A, and that has nothing to do with either appeal.
    //
    // Matching on "some row came back for trip A" clears appeal 1. Matching on
    // "some row came back for user Y" clears appeal 2. Both are somebody else's
    // membership erasing a restoration this system still owes, and both are the
    // kind of near-miss that reads as correct in review.
    const s = spec({
      appeals: [
        appealRow({ id: APPEAL,   target_id: TRIP,   appellant_id: APPELLANT }),
        appealRow({ id: APPEAL_2, target_id: TRIP_2, appellant_id: OTHER }),
      ],
      trip_members: [{ trip_id: TRIP, user_id: OTHER, role: "member", status: "accepted" }],
    });
    const r = await listPendingRestorations(makeClient(s));

    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.scanned, 2);
    assert.equal(r.pending.length, 2, "neither appeal is discharged by an unrelated membership row");
    assert.deepEqual(
      r.pending.map((p) => p.appealId).sort(),
      [APPEAL, APPEAL_2].sort(),
    );
  });

  it("lists an event_membership appeal with no RSVP row, and names no command for it", async () => {
    const s = spec({
      appeals: [appealRow({ id: APPEAL_2, target_type: "event_membership", target_id: EVENT })],
      event_rsvps: [],
    });
    const r = await listPendingRestorations(makeClient(s));

    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.pending.length, 1);
    assert.equal(r.pending[0].targetType, "event_membership");
    assert.equal(
      r.pending[0].requiredCommand,
      null,
      "no command has been named for the event half — inventing one here would be a lie",
    );
    assert.match(r.pending[0].reason, /event_rsvps row absent/);
  });

  it("an existing RSVP row clears the event entry", async () => {
    const s = spec({
      appeals: [appealRow({ id: APPEAL_2, target_type: "event_membership", target_id: EVENT })],
      event_rsvps: [{ event_id: EVENT, user_id: APPELLANT, status: "attending" }],
    });
    const r = await listPendingRestorations(makeClient(s));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.pending, []);
  });

  it("does not list appeals that are not approved — nothing was promised yet", async () => {
    const s = spec({
      appeals: [
        appealRow({ state: "under_review" }),
        appealRow({ id: APPEAL_2, state: "denied" }),
      ],
      trip_members: [],
    });
    const r = await listPendingRestorations(makeClient(s));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.scanned, 0);
    assert.deepEqual(r.pending, []);
  });

  it("a failed trip_members read is ok:false — NOT an empty queue", async () => {
    // The failure mode that matters: "nothing pending" is the answer that lets
    // everyone go home, so it must never be produced by a broken read.
    const s = spec(
      { appeals: [appealRow()], trip_members: [] },
      { trip_members: { message: "connection terminated unexpectedly", code: "57P01" } },
    );
    const r = await listPendingRestorations(makeClient(s));

    assert.equal(r.ok, false, "an unreadable membership table must not read as 'nothing owed'");
    if (r.ok) return;
    assert.match(r.reason, /trip_members read failed/);
  });

  it("a failed appeals read is ok:false too", async () => {
    const s = spec({ appeals: [appealRow()] }, { appeals: { message: "permission denied", code: "42501" } });
    const r = await listPendingRestorations(makeClient(s));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /approved appeal read failed/);
  });
});

// ── The route ────────────────────────────────────────────────────────────────

function startServer(client: any): Promise<{ url: string; close: () => Promise<void> }> {
  _setTestClient(client, true);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => {
          srv.closeAllConnections?.();
          srv.close((e) => (e ? rej(e) : res()));
        }),
      });
    });
    srv.on("error", reject);
  });
}

/**
 * The shapes the two endpoints actually emit. `Response.json()` is `unknown`
 * under tsconfig.test.json, and the honest way through that is to NAME the
 * shape production returns rather than to widen it to `any` — a fixture whose
 * body type is `any` is exactly the fixture the test-typecheck ratchet exists
 * to stop. Every field an assertion reads is optional, because the refusal
 * responses (401/403/500) carry `error`/`message` and none of the rest.
 */
interface PendingEntryBody {
  appealId: string;
  appellantId: string;
  targetType: string;
  targetId: string;
  moderatorId: string | null;
  resolutionNote: string | null;
  approvedAt: string | null;
  reason: string;
  requiredCommand: string | null;
  blockedOn: string | null;
}

interface QueueBody {
  pending?: PendingEntryBody[];
  page?: number;
  limit?: number;
  scanned?: number;
  error?: string;
  message?: string;
}

interface PatchAppealBody {
  id?: string;
  state?: string;
  resolutionNote?: string | null;
  updatedAt?: string;
  reversalAction?: string;
  restored?: boolean;
  restorationRequired?: string;
  restorationQueue?: string;
  error?: string;
  message?: string;
}

async function getQueue(url: string, token?: string): Promise<{ status: number; body: QueueBody }> {
  const res = await fetch(`${url}/api/appeals/restorations/pending`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json()) as QueueBody };
}

describe("GET /api/appeals/restorations/pending", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it("an admin sees the owed restoration", async () => {
    const s = spec({ appeals: [appealRow()], trip_members: [] });
    server = await startServer(makeClient(s));

    const { status, body } = await getQueue(server.url, "admin-token");

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.pending?.length, 1);
    assert.equal(body.pending?.[0].appealId, APPEAL);
    assert.equal(body.pending?.[0].targetId, TRIP);
    assert.equal(body.pending?.[0].requiredCommand, "ADMIN_RESTORE_PARTICIPANT");
    assert.equal(body.pending?.[0].blockedOn, "APPEAL_RESTORE_SEMANTICS");
    assert.equal(body.scanned, 1);
  });

  it("a non-admin is refused 403 forbidden and sees no queue at all", async () => {
    const s = spec({ appeals: [appealRow()], trip_members: [] });
    server = await startServer(makeClient(s));

    const { status, body } = await getQueue(server.url, "user-token");

    assert.equal(status, 403, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.error, "forbidden");
    assert.equal(body.pending, undefined, "a refusal must not leak the queue");
  });

  it("an unauthenticated caller is refused 401", async () => {
    const s = spec({ appeals: [appealRow()], trip_members: [] });
    server = await startServer(makeClient(s));

    const { status, body } = await getQueue(server.url);

    assert.equal(status, 401, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.error, "unauthenticated");
    assert.equal(body.pending, undefined);
  });

  it("a failed read is 500 db_error — the response carries no `pending` key to misread as empty", async () => {
    const s = spec(
      { appeals: [appealRow()], trip_members: [] },
      { trip_members: { message: "connection terminated unexpectedly", code: "57P01" } },
    );
    server = await startServer(makeClient(s));

    const { status, body } = await getQueue(server.url, "admin-token");

    assert.equal(status, 500, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.error, "db_error");
    assert.equal(body.pending, undefined);
  });
});

// ── The two halves, wired ────────────────────────────────────────────────────

describe("approving a trip_membership appeal puts it on the queue an admin can read", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it("PATCH → approved with restored:false, then GET shows it pending", async () => {
    const s = spec({
      appeals: [appealRow({ state: "under_review", moderator_id: null, resolution_note: null })],
      trip_members: [], // the member really was removed
    });
    server = await startServer(makeClient(s));

    const patch = await fetch(`${server.url}/api/appeals/${APPEAL}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
      body: JSON.stringify({ state: "approved" }),
    });
    const patchBody = (await patch.json()) as PatchAppealBody;

    assert.equal(patch.status, 200, `got ${patch.status} ${JSON.stringify(patchBody)}`);
    assert.equal(patchBody.state, "approved", "the appeal is upheld");
    assert.equal(patchBody.restored, false, "and the restoration is owed");
    assert.equal(
      patchBody.restorationQueue,
      "/api/appeals/restorations/pending",
      "the admin is told where to look, not just that something failed",
    );

    const { status, body } = await getQueue(server.url, "admin-token");
    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.pending?.length, 1, "the deferral is visible AFTER the request that caused it");
    assert.equal(body.pending?.[0].appealId, APPEAL);
    assert.equal(body.pending?.[0].moderatorId, ADMIN);

    // And the restoration still has not happened.
    assert.equal(s.tables.trip_members.length, 0, "no membership row may be conjured");
  });
});
