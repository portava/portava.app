/**
 * What the appellant is told when the appeal is upheld and the restoration is NOT
 * (routes/appeals.ts PATCH /api/appeals/:id, the approval notification)
 *
 * THE DEFECT
 * ==========
 * A deferred restoration produced this notification body:
 *
 *   resolutionNote  ? `Your appeal was approved. ${resolutionNote}`
 *                   : "Your appeal was approved. A moderator still needs to restore this by hand."
 *
 * The sentence that says the removal has NOT been undone was in the `else`
 * branch. Supply a resolution note — which is what a moderator does on the
 * appeals they care most about — and the appellant is told, in full:
 *
 *   "Your appeal was approved. Sorry about this, you were removed in error."
 *
 * That reads as "you are back on the trip". They are not. The `metadata` did
 * carry `restored: false`, but metadata is not what a human reads, and a
 * machine-readable disclaimer under a human-readable claim of success is how
 * this class of defect survives review. The wording is now unconditional: the
 * note is added TO the pending sentence, never instead of it.
 *
 * WHAT IS PROVEN
 * ==============
 *   deferred + note      body carries the moderator's note AND the pending
 *                        sentence, and never claims a reversal;
 *                        metadata.restored === false and the action is
 *                        `restore_requires_policy`.
 *   deferred, no note    unchanged: pending sentence, no reversal claim.
 *   restored + note      unchanged: the note, and metadata.restored === true —
 *                        so this is not a fix that shouts "pending" at
 *                        everybody.
 *   restored, no note    still says the action has been reversed.
 *   the admin's own response carries restored:false and the queue path, so the
 *   fact that the appeal SUCCEEDED and the fact that the restoration did NOT
 *   are reported as two different facts in the same body.
 *
 * THE FAKE
 * ========
 * Real rows, real filters, and an UPDATE that resolves to the rows it actually
 * matched — a fake that echoed the payload back could not tell the deferred
 * path from the restored one, and every assertion here would pass either way.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/appealRestoreDeferredNotice.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

const APPELLANT = "aaaaaaaa-0000-0000-0000-000000000001";
const ADMIN     = "cccccccc-0000-0000-0000-000000000003";
const TRIP      = "33333333-0000-0000-0000-000000000001";
const APPEAL    = "99999999-0000-0000-0000-000000000001";

const NOTE = "Sorry about this — you were removed in error and we have logged it.";

type Row = Record<string, any>;
interface Spec { tables: Record<string, Row[]>; writes: Array<{ table: string; verb: string; matched: number }> }

function makeClient(spec: Spec): any {
  const T = spec.tables;
  const src = (t: string) => (T[t] ??= []);

  function from(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let verb: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: any = null;
    let returning = false;
    let single = false;

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
      range() { return b; },
      limit() { return b; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };

    const match = () => src(table).filter((r) => preds.every((p) => p(r)));

    async function run(): Promise<{ data: any; error: any }> {
      if (verb === "select") {
        const m = match();
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
        if (token === "admin-token") return { data: { user: { id: ADMIN } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
}

function spec(members: Row[]): Spec {
  return {
    tables: {
      trip_members: members,
      profiles: [{ id: ADMIN, role: "admin" }, { id: APPELLANT, role: "user" }],
      appeals: [{
        id: APPEAL,
        appellant_id: APPELLANT,
        target_type: "trip_membership",
        target_id: TRIP,
        reason: "I was removed from this trip without cause and would like it reviewed.",
        state: "under_review",
        evidence_url: null,
        resolution_note: null,
        moderator_id: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }],
      notifications: [],
    },
    writes: [],
  };
}

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
 * What PATCH /api/appeals/:id actually returns. `Response.json()` is `unknown`
 * under tsconfig.test.json; naming the shape is the honest way through it, and
 * a fixture typed `any` is precisely what that ratchet exists to stop.
 */
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

async function approve(
  url: string,
  resolutionNote?: string,
): Promise<{ status: number; body: PatchAppealBody }> {
  const res = await fetch(`${url}/api/appeals/${APPEAL}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
    body: JSON.stringify(resolutionNote === undefined ? { state: "approved" } : { state: "approved", resolutionNote }),
  });
  return { status: res.status, body: (await res.json()) as PatchAppealBody };
}

const PENDING = /still needs to restore this by hand/;
const REVERSED = /has been reversed/;

describe("a deferred restoration always says so — a resolution note must not swallow it", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it("deferred WITH a moderator note: the note AND the pending sentence, and no reversal claim", async () => {
    const s = spec([]); // REMOVE_PARTICIPANT deleted the row
    server = await startServer(makeClient(s));

    const { status, body } = await approve(server.url, NOTE);

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.state, "approved", "the appeal is upheld — that fact is unchanged");
    assert.equal(body.restored, false, "and the restoration is a separate, failed fact");
    assert.equal(body.reversalAction, "restore_requires_policy");
    assert.equal(body.restorationQueue, "/api/appeals/restorations/pending");

    const notif = s.tables.notifications[0];
    assert.ok(notif, "the appellant is notified");
    assert.equal(notif.event_type, "appeal.approved");
    assert.ok(String(notif.body).includes(NOTE), "the moderator's note is still delivered");
    assert.match(String(notif.body), PENDING, "and it must NOT replace the pending sentence");
    assert.doesNotMatch(String(notif.body), REVERSED, "never tell them the removal was undone");

    assert.equal(notif.metadata.restored, false);
    assert.equal(notif.metadata.reversalAction, "restore_requires_policy");
    assert.ok(notif.metadata.restorationPending, "the reason travels with the notification");

    assert.equal(s.tables.trip_members.length, 0, "and nothing was restored");
  });

  it("deferred with NO note: unchanged — pending sentence, no reversal claim", async () => {
    const s = spec([]);
    server = await startServer(makeClient(s));

    const { status, body } = await approve(server.url);

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.restored, false);
    const notif = s.tables.notifications[0];
    assert.match(String(notif.body), PENDING);
    assert.doesNotMatch(String(notif.body), REVERSED);
  });

  it("NOT deferred, WITH a note: the note is delivered and nothing is marked pending", async () => {
    const s = spec([{ trip_id: TRIP, user_id: APPELLANT, role: "member", status: "accepted" }]);
    server = await startServer(makeClient(s));

    const { status, body } = await approve(server.url, NOTE);

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.restored, true);
    assert.equal(body.restorationQueue, undefined, "nothing is owed, so no queue pointer");

    const notif = s.tables.notifications[0];
    assert.ok(String(notif.body).includes(NOTE));
    assert.doesNotMatch(
      String(notif.body),
      PENDING,
      "this fix must not tell every appellant a restoration is pending",
    );
    assert.equal(notif.metadata.restored, true);
    assert.equal(notif.metadata.restorationPending, undefined);
  });

  it("NOT deferred, no note: still states the action has been reversed", async () => {
    const s = spec([{ trip_id: TRIP, user_id: APPELLANT, role: "member", status: "accepted" }]);
    server = await startServer(makeClient(s));

    const { status } = await approve(server.url);
    assert.equal(status, 200);
    assert.match(String(s.tables.notifications[0].body), REVERSED);
  });
});
