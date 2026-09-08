/**
 * Appeal-approved trip MEMBERSHIP restore — the false success
 * (services/appeals/resolveAppeal.ts case "trip_membership";
 *  routes/appeals.ts PATCH /api/appeals/:id;
 *  migrations 2450/2500/2590 REMOVE_PARTICIPANT; owner decision
 *  APPEAL_RESTORE_SEMANTICS recorded in scripts/tripKernelWriterBaseline.ts.)
 *
 * THE DEFECT
 * ==========
 * `trip_membership` appeals contest a REMOVAL, and removal DELETES the
 * trip_members row — the kernel's REMOVE_PARTICIPANT runs
 * `DELETE FROM public.trip_members` and so does its flag-off twin in
 * routes/trips.ts and routes/requests.ts. The case answered that appeal with
 *
 *     UPDATE trip_members SET role = 'member' WHERE trip_id = ? AND user_id = ?
 *
 * which matches ZERO rows against a deleted member. supabase-js reports zero
 * matched rows as `{ error: null }` — byte-identical to a successful update —
 * so the old code, which read only `error`, returned
 * `{ ok: true, action: "trip_membership_restored" }`. The appeal reached the
 * terminal 'approved' state and the appellant was told "the action has been
 * reversed" while they were still off the trip.
 *
 * WHAT THE FAKE MODELS — AND WHY THAT MATTERS
 * ===========================================
 * The trap this class of bug hides behind is a fake that returns the UPDATE
 * PAYLOAD as `data` (so `data` is never empty) or that only ever produces
 * `error: null` with no notion of which rows matched. Such a fake cannot
 * express "zero rows matched, no error", which IS the bug. The client below
 * therefore keeps real rows and resolves an UPDATE to the rows it ACTUALLY
 * matched — empty array when nothing matched — and records every write so a
 * test can assert that no write was attempted at all.
 *
 * WHAT IS PROVEN
 * ==============
 *   row deleted   -> action "restore_requires_policy", restored === false,
 *                    NEVER "trip_membership_restored"; no INSERT and no UPDATE
 *                    is issued (restoring means choosing a role, and the role a
 *                    removed member returns to is the OPEN owner decision
 *                    APPEAL_RESTORE_SEMANTICS — this code must not pick one).
 *   row present,
 *   role co_host  -> "restore_requires_policy" as well, and the co_host is NOT
 *                    demoted: the legacy `SET role='member'` never runs.
 *   row present,
 *   role member   -> "trip_membership_already_present". Not a restore claim:
 *                    nothing had been removed.
 *   read fails    -> ok:false noop, surfaced as reversal_failed by the route.
 *   route         -> the appeal STILL RESOLVES to 'approved' (the appeal is
 *                    upheld; what failed is the restoration), the response says
 *                    restored:false with the reason, and the appellant's
 *                    notification does NOT claim the action was reversed and
 *                    carries metadata.restored === false.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/appealTripMembershipRestore.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { resolveAppeal, isDeferred } from "../services/appeals/resolveAppeal.js";

const APPELLANT = "aaaaaaaa-0000-0000-0000-000000000001";
const ADMIN     = "cccccccc-0000-0000-0000-000000000003";
const TRIP      = "33333333-0000-0000-0000-000000000001";
const APPEAL    = "99999999-0000-0000-0000-000000000001";

type Row = Record<string, any>;
interface Write { table: string; verb: string; payload: any; matched: number }

interface Spec {
  tables: Record<string, Row[]>;
  writes: Write[];
  /** table -> resolved error for READS on that table. Never a throw. */
  failReadsOn?: Record<string, { message: string; code?: string }>;
}

/**
 * A PostgREST fake with REAL row matching.
 *   - `.update(p)` mutates the rows the filters matched and, when `.select()`
 *     was called, resolves to exactly those rows (RETURNING). Zero matches
 *     resolve to `{ data: [], error: null }` — the shape the defect hid in.
 *   - reads can be made to resolve (never throw) an error, per table.
 */
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
        const e = spec.failReadsOn?.[table];
        if (e) return { data: null, error: e };
        const m = match();
        return { data: single ? (m[0] ?? null) : m, error: null };
      }
      if (verb === "insert" || verb === "upsert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        const made = rows.map((r) => ({ id: `gen-${src(table).length + 1}`, ...r }));
        src(table).push(...made);
        spec.writes.push({ table, verb, payload, matched: made.length });
        return { data: single ? (made[0] ?? null) : made, error: null };
      }
      if (verb === "update") {
        const m = match();
        for (const r of m) Object.assign(r, payload);
        spec.writes.push({ table, verb, payload, matched: m.length });
        // RETURNING only when .select() was chained — otherwise data is null,
        // which is exactly why the old code could not tell zero from one.
        if (!returning) return { data: null, error: null };
        return { data: single ? (m[0] ?? null) : m, error: null };
      }
      const m = match();
      T[table] = src(table).filter((r) => !m.includes(r));
      spec.writes.push({ table, verb, payload: null, matched: m.length });
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
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
}

const APPEAL_ROW = {
  id: APPEAL,
  appellant_id: APPELLANT,
  target_type: "trip_membership",
  target_id: TRIP,
  resolution_note: null,
};

function spec(members: Row[], failReadsOn?: Spec["failReadsOn"]): Spec {
  return { tables: { trip_members: members }, writes: [], failReadsOn };
}

// ── The unit: resolveAppeal's trip_membership case ───────────────────────────

describe("resolveAppeal trip_membership — zero matched rows is not a restoration", () => {
  it("member row DELETED: restore_requires_policy, never *_restored, and no write is attempted", async () => {
    const s = spec([]); // REMOVE_PARTICIPANT deleted the row
    const client = makeClient(s);

    const r = await resolveAppeal(client, { ...APPEAL_ROW });

    assert.equal(r.ok, true, "the appeal itself still resolves — what failed is the restoration");
    assert.equal(r.action, "restore_requires_policy");
    assert.ok(isDeferred(r), "isDeferred() must recognise it so callers cannot read ok alone");
    assert.equal((r as any).restored, false);
    assert.notEqual(r.action, "trip_membership_restored");
    assert.ok(!String(r.action).endsWith("_restored"), "no *_restored action may be reported");

    // The operator evidence requirement: appeal id, trip id, user id.
    const ev = (r as any).evidence;
    assert.equal(ev.appealId, APPEAL);
    assert.equal(ev.targetId, TRIP);
    assert.equal(ev.userId, APPELLANT);
    assert.match(String((r as any).reason), /APPEAL_RESTORE_SEMANTICS/);

    // No role was invented: nothing was inserted and nothing was updated.
    assert.deepEqual(s.writes, [], `expected zero writes, saw ${JSON.stringify(s.writes)}`);
    assert.equal(s.tables.trip_members.length, 0, "no row may be conjured for the removed member");
  });

  it("row present as co_host: refuses, and does NOT demote them to member", async () => {
    const s = spec([{ trip_id: TRIP, user_id: APPELLANT, role: "co_host", status: "accepted" }]);
    const client = makeClient(s);

    const r = await resolveAppeal(client, { ...APPEAL_ROW });

    assert.equal(r.action, "restore_requires_policy");
    assert.equal((r as any).restored, false);
    assert.equal(s.tables.trip_members[0].role, "co_host", "the legacy SET role='member' must not run");
    assert.deepEqual(s.writes, [], "a refusal writes nothing");
  });

  it("row present as member: reports already_present, not a restore", async () => {
    const s = spec([{ trip_id: TRIP, user_id: APPELLANT, role: "member", status: "accepted" }]);
    const client = makeClient(s);

    const r = await resolveAppeal(client, { ...APPEAL_ROW });

    assert.equal(r.ok, true);
    assert.equal(r.action, "trip_membership_already_present");
    assert.equal(isDeferred(r), false);
    assert.ok(!String(r.action).endsWith("_restored"));
    // The write it does run is RETURNING-checked, so its affected count is read.
    const upd = s.writes.filter((w) => w.verb === "update");
    assert.equal(upd.length, 1);
    assert.equal(upd[0].matched, 1);
  });

  it("read failure resolves (not throws) as a noop — the appeal must not approve", async () => {
    const s = spec([], { trip_members: { message: "connection terminated unexpectedly", code: "57P01" } });
    const client = makeClient(s);

    const r = await resolveAppeal(client, { ...APPEAL_ROW });

    assert.equal(r.ok, false);
    assert.equal(r.action, "noop");
    assert.match(String((r as any).reason), /trip member read failed/);
  });
});

// ── The route: what an admin and the appellant are told ──────────────────────

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

function routeSpec(members: Row[]): Spec {
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

async function approve(url: string) {
  const res = await fetch(`${url}/api/appeals/${APPEAL}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
    body: JSON.stringify({ state: "approved", resolutionNote: undefined }),
  });
  return { status: res.status, body: await res.json() };
}

describe("PATCH /api/appeals/:id — approving a trip_membership appeal whose member row is gone", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it("resolves the appeal but reports restored:false and never notifies a reversal", async () => {
    const s = routeSpec([]); // the member really was removed
    server = await startServer(makeClient(s));

    const { status, body } = await approve(server.url);

    // Not a validation rejection — the request reached the handler and the
    // appeal was genuinely resolved.
    assert.equal(status, 200, `expected the appeal to resolve; got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.state, "approved", "the appeal is upheld; what failed is the restoration");
    assert.equal(body.restored, false, "the admin must be told the restoration did not happen");
    assert.equal(body.reversalAction, "restore_requires_policy");
    assert.match(String(body.restorationRequired), /APPEAL_RESTORE_SEMANTICS/);

    const notif = s.tables.notifications[0];
    assert.ok(notif, "the appellant is still notified their appeal was approved");
    assert.doesNotMatch(
      String(notif.body),
      /has been reversed/,
      "the appellant must NOT be told the removal was reversed",
    );
    assert.match(String(notif.body), /by hand/);
    assert.equal(notif.metadata.restored, false);
    assert.equal(notif.metadata.reversalAction, "restore_requires_policy");

    // And still: no membership row was conjured.
    assert.equal(s.tables.trip_members.length, 0);
  });

  it("an intact member row approves with restored:true and the ordinary reversal wording", async () => {
    const s = routeSpec([{ trip_id: TRIP, user_id: APPELLANT, role: "member", status: "accepted" }]);
    server = await startServer(makeClient(s));

    const { status, body } = await approve(server.url);

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.state, "approved");
    assert.equal(body.restored, true);
    assert.equal(body.reversalAction, "trip_membership_already_present");
    assert.equal(s.tables.notifications[0].metadata.restored, true);
  });

  it("a resolved read error holds the appeal under_review (422 reversal_failed), not approved", async () => {
    const s = routeSpec([]);
    s.failReadsOn = { trip_members: { message: "connection terminated unexpectedly", code: "57P01" } };
    server = await startServer(makeClient(s));

    const { status, body } = await approve(server.url);

    assert.equal(status, 422, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.error, "reversal_failed");
    assert.equal(s.tables.appeals[0].state, "under_review", "a DB failure must not close the appeal");
  });
});
