/**
 * Moderation account state — bans and suspensions, end to end.
 *
 * THE DEFECT
 * ----------
 * Bans and suspensions could not work at all.
 *   - The admin writers (POST /admin/users/:id/ban, /suspend, PATCH
 *     /admin/users/:id/moderation-action) wrote `profiles.account_status =
 *     'banned' | 'suspended'`. profiles_account_status_check admits only active
 *     | deactivated | pending_deletion | deleted (baseline; verified read-only on
 *     the hosted testing database and portava-ci 2026-10-03), so /ban and
 *     /suspend failed 23514 on EVERY call, before their user_account_states
 *     upsert ran; the PATCH path folded the same failure into a 200.
 *   - Every auth gate (requireUser, optionalUser, the hand-rolled sites)
 *     compared `profiles.account_status` to those two values — values no row can
 *     hold. The one place a ban DID land, `user_account_states`, was read by no
 *     gate. A banned user was served everywhere.
 *   - Unban DELETED the rows (history gone) and wrote account_status 'active'
 *     (silently reactivating a deactivated or pending-deletion account).
 *   - PR #580's optional-auth gate mapped banned / suspended to ANONYMOUS; the
 *     owner ruled (2026-10-03) that a restricted caller is REFUSED instead.
 *
 * THE CONTRACT PINNED HERE (owner decision 2026-10-03; lib/accountStateGate.ts)
 * -----------------------------------------------------------------------------
 *   `user_account_states` is the one authoritative moderation state. A banned /
 *   suspended row is IN FORCE while expires_at is NULL or in the future; an
 *   unban REVOKES (expires_at := now, row kept). Required AND optional auth
 *   answer 403 `forbidden` (reason account_banned / account_suspended) for an
 *   in-force restriction, 503 `degraded_unavailable` (retryable) when the state
 *   cannot be read, and keep deleted / pending_deletion / deactivated as before.
 *
 * Synthetic: an in-memory supabase-js shaped fake that RESOLVES `{ data: null,
 * error }` on failure as the real client does, and answers the gate's profiles
 * read with the embedded `user_account_states` rows exactly when the select
 * names that embed — PostgREST's behaviour. The real table contract
 * (constraints, RLS, the revocation statement) is exercised against PostgreSQL
 * in src/test/db/userAccountStatesContract.db.test.ts.
 *
 * Runtime: node:test + node:assert/strict. Registered in package.json `test`.
 */
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient, _setTestServiceClient, requireUser, optionalUser } from "../lib/http.js";
import { _markPostgrestBackedForTest, isPostgrestBackedClient } from "../lib/supabase.js";
import {
  resolveAccountRestriction,
  pickRestriction,
  isRestrictionRowInForce,
  isAuthUserBannedError,
  optionalUserFromToken,
  requireUserFromToken,
  enforceAccountState,
  watchAccountRestriction,
  _setAccountStateRecheckMsForTest,
  ACCOUNT_STATE_GATE_SELECT,
} from "../lib/accountStateGate.js";
import {
  applyAccountRestriction,
  revokeAccountRestrictions,
  sessionLockDuration,
  lockForRowsInForce,
  parseRestrictionEnd,
  recordModerationNotApplied,
  PERMANENT_SESSION_LOCK,
} from "../lib/accountModeration.js";
import { registerTerminator } from "../lib/telegraphEvents.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import { resolveProfileVisibility } from "../lib/profileVisibility.js";
import { runDelayedPostPublisher } from "../lib/delayedPostPublisher.js";
import { resolveInteractionPermissions } from "../services/interactionPermissions.js";
import adminRouter from "../routes/admin.js";
import notificationsRouter from "../routes/notifications.js";
import tripsExpansionRouter from "../routes/trips-expansion.js";

// ─────────────────────────────────────────────────────────────────────────────
// The fake
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, any>;
interface Op { table: string; op: string; payload?: any; filters: string[]; select?: string; opts?: any }

interface World {
  user?: { id: string } | null;
  /** getUser's answer: a GoTrue error (e.g. the banned refusal) instead of a user. */
  authError?: { message: string; code?: string; status?: number } | null;
  tables: Record<string, Row[]>;
  /** `${table}:${op}` → error the statement resolves with. */
  fail?: Record<string, { message: string; code?: string }>;
  /** The gate's embed resolves to this instead of an array (a malformed response). */
  embedOverride?: unknown;
  /** The gate's profiles read answers the status column ALONE — the row carries no embed key at all. */
  omitEmbed?: boolean;
  /** Tables whose reads resolve `{ data: null, error: null }` — no error, and no row list either. */
  nullData?: string[];
  updateUserById?: (id: string, attrs: any) => Promise<{ data?: any; error: any }>;
  ops: Op[];
  authAdminCalls: Array<{ id: string; attrs: any }>;
}

function parseOr(expr: string): (r: Row) => boolean {
  const parts = expr.split(",").map((p) => {
    const [col, op, ...rest] = p.split(".");
    const val = rest.join(".");
    return (r: Row) => {
      if (op === "is" && val === "null") return r[col!] == null;
      if (op === "gt") return r[col!] != null && Date.parse(r[col!]) > Date.parse(val);
      throw new Error(`fake: unsupported or-term ${p}`);
    };
  });
  return (r) => parts.some((f) => f(r));
}

function makeClient(w: World): any {
  let idSeq = 0;
  return {
    auth: {
      async getUser(_token: string) {
        if (w.authError) return { data: { user: null }, error: w.authError };
        return { data: { user: w.user ?? null }, error: w.user ? null : { message: "invalid JWT" } };
      },
      admin: {
        async updateUserById(id: string, attrs: any) {
          w.authAdminCalls.push({ id, attrs });
          if (w.updateUserById) return w.updateUserById(id, attrs);
          return { data: { user: { id } }, error: null };
        },
        async listUsers() { return { data: { users: [] }, error: null }; },
      },
    },
    from(table: string) {
      const op: Op = { table, op: "select", filters: [] };
      const preds: Array<(r: Row) => boolean> = [];
      let limitN: number | null = null;
      const rowsOf = () => (w.tables[table] ??= []);
      const failure = () => w.fail?.[`${table}:${op.op}`] ?? null;
      const matched = () => rowsOf().filter((r) => preds.every((p) => p(r)));
      const project = (r: Row) => {
        if (table === "profiles" && op.select === ACCOUNT_STATE_GATE_SELECT) {
          if (w.omitEmbed) return { account_status: r.account_status };
          const embed = w.embedOverride !== undefined
            ? w.embedOverride
            : (w.tables.user_account_states ?? []).filter((s) => s.user_id === r.id).map((s) => ({ state: s.state, expires_at: s.expires_at ?? null }));
          return { account_status: r.account_status, user_account_states: embed };
        }
        return { ...r };
      };
      const run = (): { data: any; error: any } => {
        w.ops.push(op);
        const f = failure();
        if (f) return { data: null, error: f };
        if (op.op === "select" && w.nullData?.includes(table)) return { data: null, error: null };
        if (op.op === "insert" || op.op === "upsert") {
          const items = (Array.isArray(op.payload) ? op.payload : [op.payload]).map((p: Row) => ({ ...p }));
          for (const item of items) {
            if (op.op === "upsert" && op.opts?.onConflict) {
              const keys = String(op.opts.onConflict).split(",");
              const existing = rowsOf().find((r) => keys.every((k) => r[k] === item[k]));
              if (existing) { Object.assign(existing, item); continue; }
            }
            item.id ??= `row-${++idSeq}`;
            rowsOf().push(item);
          }
          return { data: items, error: null };
        }
        if (op.op === "update") {
          const hit = matched();
          for (const r of hit) Object.assign(r, op.payload);
          return { data: hit.map((r) => ({ id: r.id })), error: null };
        }
        if (op.op === "delete") {
          const hit = matched();
          w.tables[table] = rowsOf().filter((r) => !hit.includes(r));
          return { data: hit, error: null };
        }
        let out = matched().map(project);
        if (limitN !== null) out = out.slice(0, limitN);
        return { data: out, error: null };
      };
      const b: any = {
        select(cols?: string) { if (op.op === "select") op.select = cols; return b; },
        insert(p: any) { op.op = "insert"; op.payload = p; return b; },
        upsert(p: any, o?: any) { op.op = "upsert"; op.payload = p; op.opts = o; return b; },
        update(p: any) { op.op = "update"; op.payload = p; return b; },
        delete() { op.op = "delete"; return b; },
        eq(c: string, v: any) { op.filters.push(`eq.${c}`); preds.push((r) => r[c] === v); return b; },
        neq(c: string, v: any) { preds.push((r) => r[c] !== v); return b; },
        in(c: string, vs: any[]) { op.filters.push(`in.${c}`); preds.push((r) => vs.includes(r[c])); return b; },
        or(expr: string) { op.filters.push(`or.${expr}`); preds.push(parseOr(expr)); return b; },
        is(c: string, v: any) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
        lte(c: string, v: any) { preds.push((r) => r[c] != null && r[c] <= v); return b; },
        gt() { return b; }, gte() { return b; }, lt() { return b; }, not() { return b; },
        order() { return b; }, range() { return b; },
        limit(n: number) { limitN = n; return b; },
        async maybeSingle() {
          const r = run();
          if (r.error) return r;
          // PostgREST: more than one row for a single-object request is an ERROR (PGRST116), not "the first".
          if ((r.data as any[]).length > 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
          return { data: (r.data as any[])[0] ?? null, error: null };
        },
        async single() { const r = run(); return r.error ? r : { data: (r.data as any[])[0] ?? null, error: (r.data as any[])[0] ? null : { message: "no rows" } }; },
        then(onF: any, onR: any) { return Promise.resolve().then(run).then(onF, onR); },
      };
      return b;
    },
  };
}

const USER = { id: "11111111-1111-4111-8111-111111111111" };
const ADMIN = { id: "99999999-9999-4999-8999-999999999999" };
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function world(over: Partial<World> = {}): World {
  return {
    user: USER,
    tables: { profiles: [{ id: USER.id, account_status: "active", role: "member" }], user_account_states: [] },
    ops: [],
    authAdminCalls: [],
    ...over,
  };
}
const banRow = (expires_at: string | null = null, user_id = USER.id) => ({ id: `uas-ban-${user_id}`, user_id, state: "banned", expires_at, reason: "spam", set_by: ADMIN.id });
const suspRow = (expires_at: string | null, user_id = USER.id) => ({ id: `uas-susp-${user_id}`, user_id, state: "suspended", expires_at, reason: "cool off", set_by: ADMIN.id });

function reqWith(token: string | null = "tok"): any {
  return { headers: token === null ? {} : { authorization: `Bearer ${token}` }, log: { error() {}, warn() {}, info() {} } };
}
function sink() {
  const out: { status: number | null; body: any } = { status: null, body: null };
  const res: any = { status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
  return { res, out };
}

async function call(router: any, method: string, path: string, opts: { token?: string | null; body?: any } = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use(globalErrorHandler);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as any).port;
    const token = opts.token === undefined ? "tok" : opts.token;
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await r.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body };
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The read path
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveAccountRestriction — the one read path", () => {
  const NOW = Date.parse("2026-10-03T12:00:00.000Z");

  it("reads profiles ONCE, with user_account_states embedded through the user_id FK", async () => {
    const w = world({ tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [banRow()] } });
    const read = await resolveAccountRestriction(makeClient(w), USER.id, new Date(NOW));
    assert.deepEqual(read, { state: "ok", accountStatus: "active", restriction: { kind: "banned", until: null } });
    assert.equal(w.ops.length, 1, "one round trip");
    assert.equal(w.ops[0]!.table, "profiles");
    assert.match(String(w.ops[0]!.select), /user_account_states!user_account_states_user_id_fkey\(state, expires_at\)/);
  });

  it("a suspension is in force until expires_at, and reported with its end", async () => {
    const until = iso(NOW + HOUR);
    const w = world({ tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [suspRow(until)] } });
    const read = await resolveAccountRestriction(makeClient(w), USER.id, new Date(NOW));
    assert.deepEqual(read.state === "ok" && read.restriction, { kind: "suspended", until });
    const after = await resolveAccountRestriction(makeClient(w), USER.id, new Date(NOW + 2 * HOUR));
    assert.deepEqual(after.state === "ok" && after.restriction, { kind: "none" }, "after expires_at the suspension is over");
  });

  it("a REVOKED ban (expires_at set to the revocation instant) is not in force", async () => {
    const w = world({ tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [banRow(iso(NOW - 1000))] } });
    const read = await resolveAccountRestriction(makeClient(w), USER.id, new Date(NOW));
    assert.deepEqual(read.state === "ok" && read.restriction, { kind: "none" });
  });

  it("a profiles read error is UNAVAILABLE, never 'no restriction'", async () => {
    const w = world({ fail: { "profiles:select": { message: "permission denied for table profiles", code: "42501" } } });
    const read = await resolveAccountRestriction(makeClient(w), USER.id);
    assert.equal(read.state, "unavailable");
  });

  it("an embed that is present but not a row list is UNAVAILABLE", async () => {
    for (const bad of [null, { state: "banned" }, "banned"]) {
      const w = world({ embedOverride: bad });
      const read = await resolveAccountRestriction(makeClient(w), USER.id);
      assert.equal(read.state, "unavailable", `embed ${JSON.stringify(bad)}`);
    }
  });

  // ── independent verification of 9dd3aafc2: "a profile row missing the restriction embed reads as 'no ban'" ──
  it("a PostgREST-backed client's row with NO embed key is UNAVAILABLE — the moderation rows were not read", async () => {
    const w = world({ omitEmbed: true, tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [banRow()] } });
    const client = makeClient(w);
    _markPostgrestBackedForTest(client);
    assert.equal(isPostgrestBackedClient(client), true);
    const read = await resolveAccountRestriction(client, USER.id);
    assert.equal(read.state, "unavailable", "a banned user's row that lost its embed must not read as 'no restriction'");
    assert.match((read as any).reason, /embed missing/);
  });

  it("a PostgREST-backed client's answer that is not a row object carries no embed either, and is UNAVAILABLE", async () => {
    for (const data of [[{ account_status: "active", user_account_states: [] }], "active", 7]) {
      const client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) }) };
      _markPostgrestBackedForTest(client);
      assert.equal((await resolveAccountRestriction(client as any, USER.id)).state, "unavailable", JSON.stringify(data));
    }
  });

  it("requireUser and optionalUser REFUSE (503) on a PostgREST-backed client whose row lacks the embed", async () => {
    const w = world({ omitEmbed: true, tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [banRow()] } });
    const client = makeClient(w);
    _markPostgrestBackedForTest(client);
    _setTestClient(client, true);
    try {
      const { res, out } = sink();
      assert.equal(await requireUser(reqWith(), res), null);
      assert.equal(out.status, 503);
      assert.equal(out.body.error, "degraded_unavailable");
      await assert.rejects(() => optionalUser(reqWith()), (e: any) => e.status === 503 && e.code === "degraded_unavailable");
    } finally { _clearTestClient(); }
  });

  it("CONTROL — only an injected double that models the status column alone still reads as no rows; it is never PostgREST-backed", async () => {
    const w = world({ omitEmbed: true });
    const client = makeClient(w);
    assert.equal(isPostgrestBackedClient(client), false, "getServiceClient records the clients it builds; a double is not one");
    assert.deepEqual(await resolveAccountRestriction(client, USER.id), { state: "ok", accountStatus: "active", restriction: { kind: "none" } });
  });

  it("no table-absence exemption: a missing user_account_states or a missing relationship is UNAVAILABLE, never 'not banned'", async () => {
    for (const error of [
      { code: "42P01", message: 'relation "public.user_account_states" does not exist' },
      { code: "PGRST205", message: "Could not find the table 'public.user_account_states' in the schema cache" },
      { code: "PGRST200", message: "Could not find a relationship between 'profiles' and 'user_account_states' in the schema cache" },
    ]) {
      const read = await resolveAccountRestriction(makeClient(world({ fail: { "profiles:select": error } })), USER.id);
      assert.equal(read.state, "unavailable", error.code);
    }
  });

  it("a transport-level rejection is UNAVAILABLE", async () => {
    const c = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { throw new Error("ECONNRESET"); } }) }) }) };
    assert.equal((await resolveAccountRestriction(c as any, USER.id)).state, "unavailable");
  });

  it("no profile row yet is a positive 'active, no restriction' (user_id is an FK to profiles)", async () => {
    const w = world({ tables: { profiles: [], user_account_states: [] } });
    assert.deepEqual(await resolveAccountRestriction(makeClient(w), USER.id), { state: "ok", accountStatus: "active", restriction: { kind: "none" } });
  });

  it("deleted / pending_deletion / deactivated pass through as the account status, not as restrictions", async () => {
    for (const s of ["deleted", "pending_deletion", "deactivated"]) {
      const w = world({ tables: { profiles: [{ id: USER.id, account_status: s }], user_account_states: [{ user_id: USER.id, state: s, expires_at: null }] } });
      assert.deepEqual(await resolveAccountRestriction(makeClient(w), USER.id), { state: "ok", accountStatus: s, restriction: { kind: "none" } });
    }
  });
});

describe("pickRestriction / isRestrictionRowInForce", () => {
  const NOW = Date.parse("2026-10-03T12:00:00.000Z");
  it("NULL end is in force; a past end is not; an unparseable end IS (a garbage date never lifts a ban)", () => {
    assert.equal(isRestrictionRowInForce(null, NOW), true);
    assert.equal(isRestrictionRowInForce(undefined, NOW), true);
    assert.equal(isRestrictionRowInForce(iso(NOW + 1), NOW), true);
    assert.equal(isRestrictionRowInForce(iso(NOW), NOW), false, "revoked AT now is lifted");
    assert.equal(isRestrictionRowInForce(iso(NOW - 1), NOW), false);
    assert.equal(isRestrictionRowInForce("not a date", NOW), true);
  });
  it("banned outranks suspended, whatever the row order; other states are ignored", () => {
    assert.deepEqual(pickRestriction([{ state: "suspended", expires_at: iso(NOW + HOUR) }, { state: "banned", expires_at: null }], NOW), { kind: "banned", until: null });
    assert.deepEqual(pickRestriction([{ state: "banned", expires_at: null }, { state: "suspended", expires_at: iso(NOW + HOUR) }], NOW), { kind: "banned", until: null });
    assert.deepEqual(pickRestriction([{ state: "deactivated", expires_at: null }, { state: "restricted", expires_at: null }, { state: "active" }], NOW), { kind: "none" });
  });
  it("a timed ban reports its end; an expired ban beside an in-force suspension yields the suspension", () => {
    assert.deepEqual(pickRestriction([{ state: "banned", expires_at: iso(NOW + HOUR) }], NOW), { kind: "banned", until: iso(NOW + HOUR) });
    assert.deepEqual(pickRestriction([{ state: "banned", expires_at: iso(NOW - HOUR) }, { state: "suspended", expires_at: null }], NOW), { kind: "suspended", until: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Required auth
// ─────────────────────────────────────────────────────────────────────────────

describe("requireUser — required routes", () => {
  afterEach(() => _clearTestClient());

  it("a permanent ban → 403 forbidden, reason account_banned, nothing served", async () => {
    _setTestClient(makeClient(world({ tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [banRow()] } })), true);
    const { res, out } = sink();
    assert.equal(await requireUser(reqWith(), res), null);
    assert.equal(out.status, 403);
    assert.equal(out.body.error, "forbidden");
    assert.equal(out.body.reason, "account_banned");
    assert.deepEqual(out.body.restriction, { kind: "banned", until: null }, "the refusal says which restriction and that it has no end");
  });

  it("an in-force suspension → 403 account_suspended, naming its end", async () => {
    const until = iso(Date.now() + HOUR);
    _setTestClient(makeClient(world({ tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [suspRow(until)] } })), true);
    const { res, out } = sink();
    assert.equal(await requireUser(reqWith(), res), null);
    assert.equal(out.status, 403);
    assert.equal(out.body.reason, "account_suspended");
    assert.ok(String(out.body.message).includes(until), out.body.message);
    assert.deepEqual(out.body.restriction, { kind: "suspended", until }, "the end is machine-readable, not only prose");
  });

  it("enforceAccountState and the thrown optional refusal carry the same restriction detail", async () => {
    const until = iso(Date.now() + HOUR);
    const c = makeClient(world({ tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [suspRow(until)] } }));
    const { res, out } = sink();
    assert.equal(await enforceAccountState(reqWith(), res, c, USER.id), false);
    assert.deepEqual(out.body.restriction, { kind: "suspended", until });
    assert.equal(out.body.reason, "account_suspended");
    await assert.rejects(() => optionalUserFromToken(c, "tok"), (e: any) => e.status === 403 && e.restriction?.kind === "suspended" && e.restriction?.until === until);
  });

  it("a suspension whose expires_at has passed → served", async () => {
    _setTestClient(makeClient(world({ tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [suspRow(iso(Date.now() - 1000))] } })), true);
    const { res, out } = sink();
    assert.ok(await requireUser(reqWith(), res));
    assert.equal(out.status, null);
  });

  it("an unbanned (revoked) account → served, the row still present as history", async () => {
    const w = world({ tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [banRow(iso(Date.now() - 1000))] } });
    _setTestClient(makeClient(w), true);
    const { res } = sink();
    assert.ok(await requireUser(reqWith(), res));
    assert.equal(w.tables.user_account_states!.length, 1);
  });

  it("a token issued BEFORE the ban is refused: the state is read per request, not trusted from the session", async () => {
    // Auth still accepts the token (minted before the ban, not yet expired); the row landed after.
    const w = world();
    _setTestClient(makeClient(w), true);
    const before = sink();
    assert.ok(await requireUser(reqWith("old-token"), before.res), "served while not banned");
    w.tables.user_account_states!.push(banRow());
    const after = sink();
    assert.equal(await requireUser(reqWith("old-token"), after.res), null);
    assert.equal(after.out.status, 403);
  });

  it("the auth service refusing the token AS BANNED (GoTrue user_banned) → 403 account_restricted, not 401", async () => {
    _setTestClient(makeClient(world({ user: null, authError: { message: "User is banned", code: "user_banned", status: 403 } })), true);
    const { res, out } = sink();
    assert.equal(await requireUser(reqWith(), res), null);
    assert.equal(out.status, 403, "a 401 tells the client it is signed out");
    assert.equal(out.body.reason, "account_restricted");
  });

  // ── independent verification of 9dd3aafc2: the GoTrue `user_banned` CODE check had no test of its own ──
  it("isAuthUserBannedError: the code decides; the wording is a fallback; anything else is not a ban", () => {
    assert.equal(isAuthUserBannedError({ code: "user_banned", message: "Forbidden" }), true, "the code alone, whatever the wording");
    assert.equal(isAuthUserBannedError({ code: "user_banned" }), true);
    assert.equal(isAuthUserBannedError({ message: "User is banned" }), true, "an older auth service sends the wording with no code");
    assert.equal(isAuthUserBannedError({ message: "user is BANNED until 2099" }), true);
    assert.equal(isAuthUserBannedError({ code: "bad_jwt", message: "invalid JWT" }), false);
    assert.equal(isAuthUserBannedError({ code: "session_not_found", message: "Session from session_id claim in JWT does not exist" }), false);
    assert.equal(isAuthUserBannedError({ code: "user_not_found", message: "User from sub claim in JWT does not exist" }), false);
    assert.equal(isAuthUserBannedError(null), false);
    assert.equal(isAuthUserBannedError(undefined), false);
  });

  it("the banned refusal is recognised by its CODE alone (a 403 with unrelated wording is still not a 401)", async () => {
    _setTestClient(makeClient(world({ user: null, authError: { message: "Forbidden", code: "user_banned", status: 403 } })), true);
    const { res, out } = sink();
    assert.equal(await requireUser(reqWith(), res), null);
    assert.equal(out.status, 403);
    assert.equal(out.body.reason, "account_restricted");
    assert.equal(out.body.restriction, undefined, "the auth service names neither the kind nor the end, so the API does not invent them");
  });

  it("CONTROL — a different auth error code is 401 even at HTTP 403", async () => {
    _setTestClient(makeClient(world({ user: null, authError: { message: "Session from session_id claim in JWT does not exist", code: "session_not_found", status: 403 } })), true);
    const { res, out } = sink();
    assert.equal(await requireUser(reqWith(), res), null);
    assert.equal(out.status, 401);
  });

  it("CONTROL — an ordinary invalid token is still 401", async () => {
    _setTestClient(makeClient(world({ user: null, authError: { message: "invalid JWT" } })), true);
    const { res, out } = sink();
    assert.equal(await requireUser(reqWith(), res), null);
    assert.equal(out.status, 401);
  });

  it("an unreadable state → 503 degraded_unavailable, retryable (a DB failure is not a restriction)", async () => {
    _setTestClient(makeClient(world({ fail: { "profiles:select": { message: "connection refused" } } })), true);
    const { res, out } = sink();
    assert.equal(await requireUser(reqWith(), res), null);
    assert.equal(out.status, 503);
    assert.equal(out.body.error, "degraded_unavailable");
    assert.equal(out.body.retryable, true);
  });

  for (const s of ["deleted", "pending_deletion", "deactivated"]) {
    it(`CONTROL — ${s} keeps its existing behaviour on required auth: served`, async () => {
      _setTestClient(makeClient(world({ tables: { profiles: [{ id: USER.id, account_status: s }], user_account_states: [] } })), true);
      const { res } = sink();
      assert.ok(await requireUser(reqWith(), res));
    });
  }

  it("profiles.account_status is not a moderation source: an impossible 'banned' there is not consulted", async () => {
    // Its CHECK cannot hold the value; the only authority is user_account_states.
    _setTestClient(makeClient(world({ tables: { profiles: [{ id: USER.id, account_status: "banned" }], user_account_states: [] } })), true);
    const { res } = sink();
    assert.ok(await requireUser(reqWith(), res));
  });

  it("requireUserFromToken (the Telegraph SSE path) gives the same 403 for the auth-service banned refusal", async () => {
    const c = makeClient(world({ user: null, authError: { message: "User is banned", code: "user_banned" } }));
    const { res, out } = sink();
    assert.equal(await requireUserFromToken(reqWith(), res, c, "tok"), null);
    assert.equal(out.status, 403);
    assert.equal(out.body.reason, "account_restricted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Optional auth — refused, never anonymous
// ─────────────────────────────────────────────────────────────────────────────

describe("optional auth — a restricted caller is refused, never treated as anonymous", () => {
  afterEach(() => _clearTestClient());

  it("optionalUser: a permanent ban throws 403 account_banned", async () => {
    _setTestClient(makeClient(world({ tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [banRow()] } })), true);
    await assert.rejects(() => optionalUser(reqWith()), (e: any) => e.status === 403 && e.reason === "account_banned");
  });

  it("optionalUser: the auth-service banned refusal throws 403 account_restricted — not null", async () => {
    _setTestClient(makeClient(world({ user: null, authError: { message: "User is banned", code: "user_banned" } })), true);
    await assert.rejects(() => optionalUser(reqWith()), (e: any) => e.status === 403 && e.reason === "account_restricted");
  });

  it("optionalUserFromToken: the banned refusal is not swallowed by authThrowIsAnonymous", async () => {
    const c = makeClient(world({ user: null, authError: { message: "User is banned" } }));
    await assert.rejects(() => optionalUserFromToken(c, "tok", { authThrowIsAnonymous: true }), (e: any) => e.status === 403);
  });

  it("optionalUser: an expired suspension and a revoked ban are signed in", async () => {
    const past = iso(Date.now() - 1000);
    _setTestClient(makeClient(world({ tables: { profiles: [{ id: USER.id, account_status: "active" }], user_account_states: [suspRow(past), banRow(past)] } })), true);
    assert.equal((await optionalUser(reqWith()))?.user.id, USER.id);
  });

  it("CONTROL — optionalUser with no token never reads account state, even while the state is unreadable", async () => {
    const w = world({ fail: { "profiles:select": { message: "down" } } });
    _setTestClient(makeClient(w), true);
    assert.equal(await optionalUser(reqWith(null)), null);
    assert.equal(w.ops.length, 0);
  });

  it("route level: GET /api/trips/:id with a suspended token → 403 JSON with reason, no trip content", async () => {
    const TRIP = "22222222-2222-4222-8222-222222222222";
    const until = iso(Date.now() + HOUR);
    const w = world({
      tables: {
        profiles: [{ id: USER.id, account_status: "active" }],
        user_account_states: [suspRow(until)],
        trips: [{ id: TRIP, owner_id: USER.id, title: "Secret", visibility: "private", status: "planning" }],
        blocks: [], trip_members: [],
      },
    });
    _setTestClient(makeClient(w), true);
    const r = await call(tripsExpansionRouter, "GET", `/api/trips/${TRIP}`);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "forbidden");
    assert.equal(r.body.reason, "account_suspended");
    assert.equal(r.body.title, undefined);
    assert.equal(r.body.locked, undefined, "not the anonymous preview either");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The writers
// ─────────────────────────────────────────────────────────────────────────────

function adminWorld(over: Partial<World> = {}): World {
  return world({
    user: ADMIN,
    tables: {
      profiles: [
        { id: ADMIN.id, account_status: "active", role: "admin", display_name: "Ad", username: "ad", handle: "ad" },
        { id: USER.id, account_status: "active", role: "member" },
      ],
      user_account_states: [],
      moderation_actions: [],
    },
    ...over,
  });
}
const useAdmin = (w: World) => { const c = makeClient(w); _setTestClient(c, true); _setTestServiceClient(c); return c; };
const opsOn = (w: World, table: string, op?: string) => w.ops.filter((o) => o.table === table && (!op || o.op === op));
const profileStatusWrites = (w: World) => opsOn(w, "profiles").filter((o) => (o.op === "update" || o.op === "upsert") && o.payload && "account_status" in o.payload);
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("admin writers — ban / suspend / unban write user_account_states, never profiles.account_status", () => {
  afterEach(() => { _clearTestClient(); _setTestServiceClient(null as any); });

  it("POST /ban → a banned row (no end, set_by the admin), an audit row, a permanent session lock; no profiles write", async () => {
    const w = adminWorld();
    useAdmin(w);
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/ban`, { body: { reason: "spam ring" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.banned, true);
    assert.equal(r.body.sessionLock, "locked");
    const row = w.tables.user_account_states!.find((s) => s.user_id === USER.id && s.state === "banned");
    assert.ok(row, "the ban row exists");
    assert.equal(row!.expires_at, null);
    assert.equal(row!.set_by, ADMIN.id);
    assert.equal(row!.reason, "spam ring");
    assert.equal(opsOn(w, "user_account_states", "upsert")[0]!.opts.onConflict, "user_id,state");
    assert.ok(w.tables.moderation_actions!.some((a) => a.action_type === "permanent_ban" && a.target_user_id === USER.id && a.performed_by === ADMIN.id));
    assert.deepEqual(profileStatusWrites(w), [], "profiles.account_status must not be written (its CHECK cannot hold 'banned')");
    assert.deepEqual(w.authAdminCalls, [{ id: USER.id, attrs: { ban_duration: PERMANENT_SESSION_LOCK } }]);
  });

  it("after POST /ban, the banned user's own request is refused 403", async () => {
    const w = adminWorld();
    useAdmin(w);
    await call(adminRouter, "POST", `/api/admin/users/${USER.id}/ban`, { body: { reason: "x" } });
    w.user = USER;
    const { res, out } = sink();
    assert.equal(await requireUser(reqWith(), res), null);
    assert.equal(out.status, 403);
  });

  it("POST /ban refuses cleanly when the row cannot be written: 500, no trust charge, no session lock", async () => {
    const w = adminWorld({ fail: { "user_account_states:upsert": { message: "insert denied" } } });
    useAdmin(w);
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/ban`, { body: { reason: "x" } });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
    assert.match(r.body.message, /Nothing is in force/);
    await tick();
    assert.deepEqual(opsOn(w, "trust_events"), [], "no trust charge for a ban that did not land");
    assert.deepEqual(w.authAdminCalls, []);
  });

  it("POST /ban with a failed audit write → 500 and NO restriction written (audit first)", async () => {
    const w = adminWorld({ fail: { "moderation_actions:insert": { message: "audit down" } } });
    useAdmin(w);
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/ban`, { body: {} });
    assert.equal(r.status, 500);
    assert.deepEqual(opsOn(w, "user_account_states", "upsert"), []);
  });

  it("POST /ban whose session lock fails still bans (the API refusal holds) and SAYS the lock failed", async () => {
    const w = adminWorld({ updateUserById: async () => ({ error: { message: "auth admin down" } }) });
    useAdmin(w);
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/ban`, { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.sessionLock, "failed");
    assert.ok(w.tables.user_account_states!.some((s) => s.state === "banned"));
  });

  it("POST /suspend with a future expires_at → a suspended row with that end and a session lock that ends with it", async () => {
    const w = adminWorld();
    useAdmin(w);
    const until = iso(Date.now() + 2 * HOUR);
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/suspend`, { body: { reason: "cool off", expires_at: until } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = w.tables.user_account_states!.find((s) => s.state === "suspended");
    assert.equal(row?.expires_at, until);
    assert.ok(w.tables.moderation_actions!.some((a) => a.action_type === "temporary_suspension"));
    assert.deepEqual(profileStatusWrites(w), []);
    const dur = w.authAdminCalls[0]?.attrs.ban_duration as string;
    assert.match(dur, /^\d+s$/);
    const secs = Number(dur.slice(0, -1));
    assert.ok(secs > 7000 && secs <= 7200, `lock ends with the suspension: ${dur}`);
  });

  it("POST /suspend with a past or unparseable expires_at → 400, nothing audited or written", async () => {
    // "2099" and the other date-shaped values are what `Date.parse` alone accepted: the audit row was
    // written and THEN the timestamptz write failed (independent verification of 9dd3aafc2).
    for (const bad of [iso(Date.now() - HOUR), "tomorrow-ish", 12345, "2099", "2099-06-01", "2099-06-01T00:00:00", "2099-06-01 00:00:00+00", "June 1, 2099", "", true, {}]) {
      const w = adminWorld();
      useAdmin(w);
      const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/suspend`, { body: { expires_at: bad } });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${JSON.stringify(r.body)}`);
      assert.deepEqual(opsOn(w, "moderation_actions"), []);
      assert.deepEqual(opsOn(w, "user_account_states", "upsert"), []);
    }
  });

  it("POST /suspend refuses cleanly on a write error: 500 db_error", async () => {
    const w = adminWorld({ fail: { "user_account_states:upsert": { message: "nope" } } });
    useAdmin(w);
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/suspend`, { body: { expires_at: iso(Date.now() + HOUR) } });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
  });

  it("POST /suspend stores an offset timestamp as the same INSTANT, normalised", async () => {
    const w = adminWorld();
    useAdmin(w);
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/suspend`, { body: { expires_at: "2099-06-01T02:00:00+02:00" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.expiresAt, "2099-06-01T00:00:00.000Z");
    assert.equal(w.tables.user_account_states!.find((s) => s.state === "suspended")?.expires_at, "2099-06-01T00:00:00.000Z");
  });

  // ── independent verification of 9dd3aafc2: "a failed restriction write leaves an audit row that looks landed" ──
  for (const [route, actionType, body] of [
    ["ban", "permanent_ban", { reason: "r" }],
    ["suspend", "temporary_suspension", { reason: "r", expires_at: iso(Date.now() + HOUR) }],
  ] as const) {
    it(`POST /${route} whose restriction write fails appends a ${actionType}_not_applied row naming the audit row it voids`, async () => {
      const w = adminWorld({ fail: { "user_account_states:upsert": { message: "insert denied" } } });
      useAdmin(w);
      const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/${route}`, { body });
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.match(r.body.message, /Nothing is in force/);
      assert.match(r.body.message, /audit trail records that this attempt did not take effect/);
      const actions = w.tables.moderation_actions!;
      const first = actions.find((a) => a.action_type === actionType);
      const voided = actions.find((a) => a.action_type === `${actionType}_not_applied`);
      assert.ok(first, "the audit-first row is still there (the trail is append-only)");
      assert.ok(voided, `a correcting row exists: ${JSON.stringify(actions.map((a) => a.action_type))}`);
      assert.equal(voided!.target_user_id, USER.id);
      assert.equal(voided!.performed_by, ADMIN.id);
      assert.equal(voided!.metadata.voids_action_id, first!.id, "it names the row it corrects");
      assert.equal(voided!.metadata.voided_action_type, actionType);
      assert.match(voided!.reason, /did NOT take effect: insert denied/);
      assert.deepEqual(w.tables.user_account_states, [], "and nothing is in force");
    });
  }

  it("POST /restore whose revocation fails appends account_restored_not_applied — the trail must not say a standing ban was lifted", async () => {
    const w = adminWorld({ fail: { "user_account_states:update": { message: "nope" } } });
    w.tables.user_account_states = [banRow(null)];
    useAdmin(w);
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/restore`, { body: { reason: "appeal" } });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    const types = w.tables.moderation_actions!.map((a) => a.action_type);
    assert.deepEqual(types, ["account_restored", "account_restored_not_applied"]);
    assert.equal(w.tables.user_account_states![0]!.expires_at, null, "the ban still stands");
  });

  it("PATCH moderation-action whose restriction write fails appends <action>_not_applied", async () => {
    const w = adminWorld({ fail: { "user_account_states:upsert": { message: "nope" } } });
    useAdmin(w);
    const r = await call(adminRouter, "PATCH", `/api/admin/users/${USER.id}/moderation-action`, { body: { action_type: "permanent_ban", reason: "r" } });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.deepEqual(w.tables.moderation_actions!.map((a) => a.action_type), ["permanent_ban", "permanent_ban_not_applied"]);
  });

  it("when even the correcting row cannot be written, the refusal SAYS the trail holds a row that looks landed", async () => {
    const w = adminWorld({ fail: { "user_account_states:upsert": { message: "insert denied" } } });
    const client = useAdmin(w);
    // The audit-first insert succeeds; the correcting insert (the second one) fails.
    const from = client.from.bind(client);
    let auditInserts = 0;
    client.from = (table: string) => {
      const b = from(table);
      if (table !== "moderation_actions") return b;
      const insert = b.insert.bind(b);
      b.insert = (p: any) => {
        auditInserts++;
        if (auditInserts === 2) return { then: (onF: any) => Promise.resolve({ data: null, error: { message: "audit down" } }).then(onF) };
        return insert(p);
      };
      return b;
    };
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/ban`, { body: { reason: "r" } });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.match(r.body.message, /could NOT be marked as not applied \(audit down\)/);
    assert.match(r.body.message, /reads as if it landed/);
  });

  // ── independent verification of 9dd3aafc2: "suspending an already-banned user shortens the GoTrue lock" ──
  it("POST /suspend on an ALREADY-BANNED user keeps the session lock PERMANENT", async () => {
    const w = adminWorld();
    w.tables.user_account_states = [banRow(null)];
    useAdmin(w);
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/suspend`, { body: { reason: "also", expires_at: iso(Date.now() + HOUR) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sessionLock, "locked");
    assert.deepEqual(w.authAdminCalls, [{ id: USER.id, attrs: { ban_duration: PERMANENT_SESSION_LOCK } }],
      "the lock must outlast the suspension: the ban row is still in force when the suspension ends");
    assert.equal(w.tables.user_account_states!.length, 2, "both rows stand");
  });

  it("POST /suspend beside a REVOKED ban locks only for the suspension (a lifted ban does not extend it)", async () => {
    const w = adminWorld();
    w.tables.user_account_states = [banRow(iso(Date.now() - 1000))];
    useAdmin(w);
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/suspend`, { body: { expires_at: iso(Date.now() + HOUR) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const dur = w.authAdminCalls[0]?.attrs.ban_duration as string;
    assert.match(dur, /^\d+s$/);
    assert.ok(Number(dur.slice(0, -1)) <= 3600, dur);
  });

  it("when the restrictions in force cannot be read back, the lock is LEFT ALONE and reported failed — never set from this row alone", async () => {
    const w = adminWorld({ fail: { "user_account_states:select": { message: "read down" } } });
    w.tables.user_account_states = [banRow(null)];
    useAdmin(w);
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/suspend`, { body: { expires_at: iso(Date.now() + HOUR) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sessionLock, "failed");
    assert.deepEqual(w.authAdminCalls, [], "a one-hour lock here would have replaced the ban's permanent one");
    assert.ok(w.tables.user_account_states!.some((s) => s.state === "suspended"), "the suspension row itself landed; the API refusal holds");
  });

  it("a read-back that answers no row list (and no error) is not 'nothing else in force': the lock is left alone and reported failed", async () => {
    const w = world({ tables: { profiles: [], user_account_states: [banRow(null)] }, nullData: ["user_account_states"] });
    const out = await applyAccountRestriction(makeClient(w), { userId: USER.id, kind: "suspended", reason: null, expiresAt: iso(Date.now() + HOUR), actorId: ADMIN.id });
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.sessionLock, "failed");
    assert.match(String(out.ok && out.sessionLockError), /no row list/);
    assert.deepEqual(w.authAdminCalls, []);
  });

  it("POST /restore REVOKES (expires_at := now), keeps the rows, clears the lock, audits — and does not touch profiles", async () => {
    const until = iso(Date.now() + 5 * HOUR);
    const w = adminWorld();
    w.tables.user_account_states = [banRow(null), suspRow(until), { id: "old", user_id: USER.id, state: "restricted", expires_at: null }];
    w.tables.profiles!.find((p) => p.id === USER.id)!.account_status = "deactivated";
    useAdmin(w);
    const before = Date.now();
    const r = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/restore`, { body: { reason: "appeal upheld" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.revoked, 2);
    assert.equal(r.body.sessionLock, "unlocked");
    assert.equal(w.tables.user_account_states!.length, 3, "no row deleted — history is kept");
    assert.deepEqual(opsOn(w, "user_account_states", "delete"), []);
    for (const s of w.tables.user_account_states!.filter((x) => x.state === "banned" || x.state === "suspended")) {
      const end = Date.parse(s.expires_at);
      assert.ok(end >= before - 5 && end <= Date.now() + 5, `${s.state} revoked at now: ${s.expires_at}`);
      assert.ok(s.reason, "the sanction's reason survives the unban");
    }
    assert.equal(w.tables.user_account_states!.find((x) => x.state === "restricted")!.expires_at, null, "non-moderation rows untouched");
    const upd = opsOn(w, "user_account_states", "update")[0]!;
    assert.ok(upd.filters.includes("eq.user_id") && upd.filters.includes("in.state"), upd.filters.join(" "));
    assert.ok(upd.filters.some((f) => f.startsWith("or.expires_at.is.null,expires_at.gt.")), "only IN-FORCE rows are revoked");
    assert.deepEqual(profileStatusWrites(w), [], "restore must not write account_status (it would reactivate a deactivated account)");
    assert.equal(w.tables.profiles!.find((p) => p.id === USER.id)!.account_status, "deactivated");
    assert.deepEqual(w.authAdminCalls, [{ id: USER.id, attrs: { ban_duration: "none" } }]);
    assert.ok(w.tables.moderation_actions!.some((a) => a.action_type === "account_restored" && a.reason === "appeal upheld"));
  });

  it("after POST /restore the user is served again", async () => {
    const w = adminWorld();
    w.tables.user_account_states = [banRow(null)];
    useAdmin(w);
    await call(adminRouter, "POST", `/api/admin/users/${USER.id}/restore`, { body: {} });
    w.user = USER;
    const { res } = sink();
    assert.ok(await requireUser(reqWith(), res));
  });

  it("POST /restore refuses cleanly: 500 when the revocation cannot be written, 502 when the session unlock fails", async () => {
    const w1 = adminWorld({ fail: { "user_account_states:update": { message: "nope" } } });
    w1.tables.user_account_states = [banRow(null)];
    useAdmin(w1);
    const r1 = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/restore`, { body: {} });
    assert.equal(r1.status, 500);
    assert.match(r1.body.message, /still stands/);
    assert.deepEqual(w1.authAdminCalls, [], "the lock is not cleared while the row still stands");

    const w2 = adminWorld({ updateUserById: async () => ({ error: { message: "auth down" } }) });
    w2.tables.user_account_states = [banRow(null)];
    useAdmin(w2);
    const r2 = await call(adminRouter, "POST", `/api/admin/users/${USER.id}/restore`, { body: {} });
    assert.equal(r2.status, 502, JSON.stringify(r2.body));
    assert.equal(r2.body.error, "upstream_error");
  });

  it("PATCH moderation-action permanent_ban → the row and audit, no profiles write; a write error is a 500, not a 200", async () => {
    const w = adminWorld();
    useAdmin(w);
    const r = await call(adminRouter, "PATCH", `/api/admin/users/${USER.id}/moderation-action`, { body: { action_type: "permanent_ban", reason: "r" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sideEffects.accountState, "banned");
    assert.ok(w.tables.user_account_states!.some((s) => s.state === "banned" && s.expires_at === null));
    assert.deepEqual(profileStatusWrites(w), []);

    const wf = adminWorld({ fail: { "user_account_states:upsert": { message: "nope" } } });
    useAdmin(wf);
    const rf = await call(adminRouter, "PATCH", `/api/admin/users/${USER.id}/moderation-action`, { body: { action_type: "temporary_suspension", expires_at: iso(Date.now() + HOUR) } });
    assert.equal(rf.status, 500, JSON.stringify(rf.body));
  });

  it("PATCH moderation-action temporary_suspension keeps the end it was given", async () => {
    const w = adminWorld();
    useAdmin(w);
    const until = iso(Date.now() + 3 * HOUR);
    const r = await call(adminRouter, "PATCH", `/api/admin/users/${USER.id}/moderation-action`, { body: { action_type: "temporary_suspension", expires_at: until } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sideEffects.accountState, "suspended");
    assert.equal(w.tables.user_account_states!.find((s) => s.state === "suspended")?.expires_at, until);
  });

  it("PATCH moderation-action temporary_suspension with a PAST expires_at → 400 before any audit row", async () => {
    const w = adminWorld();
    useAdmin(w);
    const r = await call(adminRouter, "PATCH", `/api/admin/users/${USER.id}/moderation-action`, { body: { action_type: "temporary_suspension", expires_at: iso(Date.now() - HOUR) } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.deepEqual(opsOn(w, "moderation_actions"), []);
  });
});

describe("accountModeration — the writer itself", () => {
  it("sessionLockDuration: permanent for open-ended, whole seconds rounded UP for timed, none once past", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    assert.equal(sessionLockDuration(null, now), PERMANENT_SESSION_LOCK);
    assert.equal(sessionLockDuration("2026-10-03T12:00:01.200Z", now), "2s");
    assert.equal(sessionLockDuration("2026-10-03T13:00:00.000Z", now), "3600s");
    assert.equal(sessionLockDuration("2026-10-03T11:00:00.000Z", now), null);
    assert.equal(sessionLockDuration("2026-10-03T12:00:00.000Z", now), null);
    assert.equal(sessionLockDuration("garbage", now), PERMANENT_SESSION_LOCK);
  });

  it("a ban never carries an end, even if one is passed", async () => {
    const w = world();
    await applyAccountRestriction(makeClient(w), { userId: USER.id, kind: "banned", reason: null, expiresAt: iso(Date.now() + HOUR), actorId: ADMIN.id });
    assert.equal(w.tables.user_account_states![0]!.expires_at, null);
  });

  it("a ban closes the user's open Telegraph streams", async () => {
    let closed = 0;
    const unregister = registerTerminator(USER.id, () => { closed++; });
    try {
      await applyAccountRestriction(makeClient(world()), { userId: USER.id, kind: "banned", reason: null, expiresAt: null, actorId: ADMIN.id });
      assert.equal(closed, 1);
    } finally { unregister(); }
  });

  it("a suspension whose end is already past, or is not a timestamp, is REFUSED by the writer itself: no row, no lock", async () => {
    // This used to WRITE the row (a suspension never in force) and report `not_needed`; the routes refuse
    // such an end with 400 before auditing, and the one writer now holds the same line for every caller.
    for (const bad of [iso(Date.now() - 1000), "2099", "2099-06-01", "soon"]) {
      const w = world();
      const out = await applyAccountRestriction(makeClient(w), { userId: USER.id, kind: "suspended", reason: null, expiresAt: bad, actorId: ADMIN.id });
      assert.equal(out.ok, false, bad);
      assert.deepEqual(w.ops, [], `nothing may be attempted for ${bad}`);
      assert.deepEqual(w.authAdminCalls, []);
    }
  });

  it("parseRestrictionEnd: null is 'until lifted'; a full ISO instant with an offset in the future is normalised; everything else is refused", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    assert.deepEqual(parseRestrictionEnd(null, now), { ok: true, expiresAt: null });
    assert.deepEqual(parseRestrictionEnd(undefined, now), { ok: true, expiresAt: null });
    assert.deepEqual(parseRestrictionEnd("2026-10-03T12:00:01Z", now), { ok: true, expiresAt: "2026-10-03T12:00:01.000Z" });
    assert.deepEqual(parseRestrictionEnd("2026-10-04T00:00+02:00", now), { ok: true, expiresAt: "2026-10-03T22:00:00.000Z" });
    assert.deepEqual(parseRestrictionEnd("2026-10-03T12:00:00.123456Z", new Date("2026-10-03T11:00:00Z")), { ok: true, expiresAt: "2026-10-03T12:00:00.123Z" });
    for (const bad of ["2099", "2099-01-01", "2099-01-01T00:00:00", "2099-01-01 00:00:00Z", "2099-13-45T00:00:00Z", "2026-10-03T12:00:00Z", "2026-10-03T11:59:59Z", 4102444800000, "", " ", {}, []]) {
      assert.equal(parseRestrictionEnd(bad, now).ok, false, JSON.stringify(bad));
    }
    // Dates that do not exist: JavaScript rolls them forward into a DIFFERENT instant (Feb 30 → Mar 2);
    // PostgreSQL refuses them. Neither is what the admin typed, so they are refused here.
    for (const bad of ["2027-02-30T00:00:00Z", "2027-02-29T00:00:00Z", "2027-04-31T00:00:00Z", "2027-01-01T24:00:00Z", "2027-00-10T00:00:00Z", "2027-01-00T00:00:00Z"]) {
      assert.equal(parseRestrictionEnd(bad, now).ok, false, bad);
    }
    assert.deepEqual(parseRestrictionEnd("2028-02-29T23:59:59Z", now), { ok: true, expiresAt: "2028-02-29T23:59:59.000Z" }, "a real leap day is accepted");
  });

  it("lockForRowsInForce: permanent if ANY in-force row has no end; otherwise the LATEST end; null when nothing is in force", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const at = (s: number) => new Date(now.getTime() + s * 1000).toISOString();
    assert.equal(lockForRowsInForce([], now), null);
    assert.equal(lockForRowsInForce([{ state: "suspended", expires_at: at(-1) }, { state: "banned", expires_at: at(-60) }], now), null, "ended and revoked rows lock nothing");
    assert.equal(lockForRowsInForce([{ state: "suspended", expires_at: at(3600) }], now), "3600s");
    assert.equal(lockForRowsInForce([{ state: "suspended", expires_at: at(3600) }, { state: "banned", expires_at: null }], now), PERMANENT_SESSION_LOCK, "a suspension never shortens a ban's lock");
    assert.equal(lockForRowsInForce([{ state: "banned", expires_at: null }, { state: "suspended", expires_at: at(3600) }], now), PERMANENT_SESSION_LOCK, "whatever the row order");
    assert.equal(lockForRowsInForce([{ state: "suspended", expires_at: at(60) }, { state: "banned", expires_at: at(7200) }], now), "7200s", "the latest end…");
    assert.equal(lockForRowsInForce([{ state: "banned", expires_at: at(7200) }, { state: "suspended", expires_at: at(60) }], now), "7200s", "…not the last row's");
    assert.equal(lockForRowsInForce([{ state: "suspended", expires_at: "garbage" }], now), PERMANENT_SESSION_LOCK, "a malformed end never shortens a lock");
    assert.equal(lockForRowsInForce([{ state: "restricted", expires_at: null }, { state: "deactivated", expires_at: null }], now), null, "only banned and suspended rows lock a session");
    assert.equal(lockForRowsInForce([{ state: "suspended", expires_at: at(0.2) }], now), "1s", "rounded UP: the lock never lifts before the row does");
  });

  it("applyAccountRestriction: a ban after a suspension, and a suspension after a ban, both end PERMANENT", async () => {
    const w1 = world({ tables: { profiles: [], user_account_states: [suspRow(iso(Date.now() + HOUR))] } });
    await applyAccountRestriction(makeClient(w1), { userId: USER.id, kind: "banned", reason: null, expiresAt: null, actorId: ADMIN.id });
    assert.equal(w1.authAdminCalls.at(-1)!.attrs.ban_duration, PERMANENT_SESSION_LOCK);
    const w2 = world({ tables: { profiles: [], user_account_states: [banRow(null)] } });
    const out = await applyAccountRestriction(makeClient(w2), { userId: USER.id, kind: "suspended", reason: null, expiresAt: iso(Date.now() + HOUR), actorId: ADMIN.id });
    assert.deepEqual(out, { ok: true, sessionLock: "locked" });
    assert.equal(w2.authAdminCalls.at(-1)!.attrs.ban_duration, PERMANENT_SESSION_LOCK);
  });

  it("applyAccountRestriction: another user's ban does not lengthen this user's suspension lock", async () => {
    const OTHER = "66666666-6666-4666-8666-666666666666";
    const w = world({ tables: { profiles: [], user_account_states: [banRow(null, OTHER)] } });
    await applyAccountRestriction(makeClient(w), { userId: USER.id, kind: "suspended", reason: null, expiresAt: iso(Date.now() + HOUR), actorId: ADMIN.id });
    assert.match(w.authAdminCalls.at(-1)!.attrs.ban_duration, /^\d+s$/);
  });

  it("recordModerationNotApplied: reports a write it could not make, and never throws", async () => {
    const ok = world({ tables: { profiles: [], user_account_states: [], moderation_actions: [] } });
    assert.deepEqual(await recordModerationNotApplied(makeClient(ok), { userId: USER.id, actorId: ADMIN.id, actionType: "permanent_ban", auditId: "a1", error: "boom" }), { ok: true });
    assert.equal(ok.tables.moderation_actions![0]!.action_type, "permanent_ban_not_applied");
    const bad = world({ fail: { "moderation_actions:insert": { message: "audit down" } } });
    assert.deepEqual(await recordModerationNotApplied(makeClient(bad), { userId: USER.id, actorId: ADMIN.id, actionType: "permanent_ban", error: "boom" }), { ok: false, error: "audit down" });
    const thrower = { from: () => { throw new Error("socket"); } };
    assert.deepEqual(await recordModerationNotApplied(thrower, { userId: USER.id, actorId: ADMIN.id, actionType: "permanent_ban", error: "boom" }), { ok: false, error: "socket" });
  });

  it("a write error is ok:false and nothing else happens", async () => {
    const w = world({ fail: { "user_account_states:upsert": { message: "x" } } });
    let closed = 0;
    const unregister = registerTerminator(USER.id, () => { closed++; });
    try {
      const out = await applyAccountRestriction(makeClient(w), { userId: USER.id, kind: "suspended", reason: null, expiresAt: null, actorId: ADMIN.id });
      assert.equal(out.ok, false);
      assert.equal(closed, 0);
      assert.deepEqual(w.authAdminCalls, []);
    } finally { unregister(); }
  });

  it("revocation leaves an already-ended row's own end alone (history is not rewritten)", async () => {
    const oldEnd = iso(Date.now() - 10 * HOUR);
    const w = world({ tables: { profiles: [], user_account_states: [suspRow(oldEnd)] } });
    const out = await revokeAccountRestrictions(makeClient(w), { userId: USER.id });
    assert.deepEqual(out.ok && out.revoked, 0);
    assert.equal(w.tables.user_account_states![0]!.expires_at, oldEnd);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Surfaces beyond the HTTP gates
// ─────────────────────────────────────────────────────────────────────────────

describe("long-lived streams re-check the account", () => {
  afterEach(() => { _clearTestClient(); _setAccountStateRecheckMsForTest(null); });

  it("watchAccountRestriction ends with 403 when a ban lands, 503 when unreadable, and never while clear", async () => {
    const w = world();
    const ends: any[] = [];
    const stop = watchAccountRestriction(makeClient(w), USER.id, (e) => ends.push(e), { intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ends.length, 0, "an unrestricted account's stream stays open");
    w.tables.user_account_states!.push(banRow());
    await new Promise((r) => setTimeout(r, 40));
    stop();
    assert.equal(ends.length, 1, "ends exactly once");
    assert.equal(ends[0].status, 403);
    assert.equal(ends[0].reason, "account_banned");

    const w2 = world({ fail: { "profiles:select": { message: "down" } } });
    const ends2: any[] = [];
    const stop2 = watchAccountRestriction(makeClient(w2), USER.id, (e) => ends2.push(e), { intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 40));
    stop2();
    assert.equal(ends2.length, 1);
    assert.equal(ends2[0].status, 503);
    assert.equal(ends2[0].code, "degraded_unavailable");
  });

  it("a slow state read is never overlapped by the next tick (one read in flight per stream)", async () => {
    let reads = 0;
    const slow = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => { reads++; return new Promise((r) => setTimeout(() => r({ data: { account_status: "active", user_account_states: [] }, error: null }), 80)); } }) }) }) };
    const stop = watchAccountRestriction(slow as any, USER.id, () => {}, { intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 120));
    stop();
    assert.ok(reads >= 1 && reads <= 2, `ticks every 10ms over an 80ms read must not stack reads: ${reads}`);
  });

  it("GET /api/me/notifications/stream: a ban landing mid-stream sends access.revoked and closes it", async () => {
    _setAccountStateRecheckMsForTest(15);
    const w = world();
    _setTestClient(makeClient(w), true);
    const app = express();
    app.use("/api", notificationsRouter);
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as any).port;
      const text = await new Promise<string>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/api/me/notifications/stream", headers: { authorization: "Bearer tok" } }, (res) => {
          assert.equal(res.statusCode, 200);
          let buf = "";
          res.on("data", (c) => { buf += c; });
          res.on("end", () => resolve(buf));
          setTimeout(() => w.tables.user_account_states!.push(banRow()), 30);
        });
        req.on("error", reject);
        req.end();
        setTimeout(() => reject(new Error("stream was not closed after the ban")), 3000).unref();
      });
      assert.match(text, /event: access\.revoked/);
      assert.match(text, /"reason":"account_banned"/);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});

describe("delayed post publisher holds a restricted author's post", () => {
  const POST = (author: string) => ({ id: `post-${author}`, author_id: author, post_status: "pending_delay", publish_eligible_at: iso(Date.now() - 1000), location_privacy_mode: "none" });

  it("banned author → held (stays pending); revoked ban → published; unreadable → held", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const w = world({
      tables: {
        profiles: [{ id: USER.id, account_status: "active" }, { id: OTHER, account_status: "active" }],
        user_account_states: [banRow(), banRow(iso(Date.now() - 1000), OTHER)],
        posts: [POST(USER.id), POST(OTHER)],
        safe_return_sessions: [], delayed_post_location_events: [], job_health: [],
      },
    });
    const out = await runDelayedPostPublisher({ client: makeClient(w) });
    assert.equal(out.published, 1);
    assert.equal(out.skipped, 1);
    assert.equal(w.tables.posts!.find((p) => p.author_id === USER.id)!.post_status, "pending_delay", "the banned author's post is held");
    assert.equal(w.tables.posts!.find((p) => p.author_id === OTHER)!.post_status, "published", "an unbanned author's post publishes");

    const wf = world({
      tables: { profiles: [{ id: USER.id, account_status: "active" }], posts: [POST(USER.id)], safe_return_sessions: [], delayed_post_location_events: [], job_health: [] },
      fail: { "profiles:select": { message: "down" } },
    });
    const outF = await runDelayedPostPublisher({ client: makeClient(wf) });
    assert.equal(outF.published, 0);
    assert.equal(wf.tables.posts![0]!.post_status, "pending_delay", "never published on an unread ban");
  });
});

describe("delayed post publisher — a SUSPENDED author (the gap the independent verification named)", () => {
  const POST = (author: string) => ({ id: `post-${author}`, author_id: author, post_status: "pending_delay", publish_eligible_at: iso(Date.now() - 1000), location_privacy_mode: "none" });
  const ENDED = "77777777-7777-4777-8777-777777777777";
  const CLEAR = "88888888-8888-4888-8888-888888888888";

  it("an in-force suspension holds the post; an ended one, and an unrestricted author, publish", async () => {
    const w = world({
      tables: {
        profiles: [{ id: USER.id, account_status: "active" }, { id: ENDED, account_status: "active" }, { id: CLEAR, account_status: "active" }],
        user_account_states: [suspRow(iso(Date.now() + HOUR)), suspRow(iso(Date.now() - 1000), ENDED)],
        posts: [POST(USER.id), POST(ENDED), POST(CLEAR)],
        safe_return_sessions: [], delayed_post_location_events: [], job_health: [],
      },
    });
    const out = await runDelayedPostPublisher({ client: makeClient(w) });
    const status = (author: string) => w.tables.posts!.find((p) => p.author_id === author)!.post_status;
    assert.equal(status(USER.id), "pending_delay", "a suspended author's post is HELD, not published and not dropped");
    assert.equal(status(ENDED), "published", "a suspension that has ended no longer holds the post");
    assert.equal(status(CLEAR), "published");
    assert.equal(out.published, 2);
    assert.equal(out.skipped, 1);
  });

  it("the held post publishes on a later tick, once the suspension has been lifted", async () => {
    const w = world({
      tables: {
        profiles: [{ id: USER.id, account_status: "active" }],
        user_account_states: [suspRow(iso(Date.now() + HOUR))],
        posts: [POST(USER.id)],
        safe_return_sessions: [], delayed_post_location_events: [], job_health: [],
      },
    });
    const client = makeClient(w);
    assert.equal((await runDelayedPostPublisher({ client })).published, 0);
    assert.equal(w.tables.posts![0]!.post_status, "pending_delay");
    await revokeAccountRestrictions(client, { userId: USER.id });
    assert.equal((await runDelayedPostPublisher({ client })).published, 1);
    assert.equal(w.tables.posts![0]!.post_status, "published");
  });
});

describe("profile visibility honours expiry and revocation", () => {
  const TARGET = "44444444-4444-4444-8444-444444444444";
  const vis = async (rows: Row[]) => {
    const w = world({ tables: { profiles: [], user_account_states: rows, blocks: [], profile_privacy_settings: [] } });
    return (await resolveProfileVisibility(makeClient(w), USER.id, TARGET, { is_private: false, account_status: "active" })).visibility;
  };
  beforeEach(() => _clearTestClient());

  it("an in-force ban or suspension hides the profile", async () => {
    assert.equal(await vis([banRow(null, TARGET)]), "unavailable");
    assert.equal(await vis([suspRow(iso(Date.now() + HOUR), TARGET)]), "unavailable");
  });
  it("a revoked ban or an ended suspension does not — even beside other history rows", async () => {
    assert.notEqual(await vis([banRow(iso(Date.now() - 1000), TARGET)]), "unavailable");
    assert.notEqual(await vis([suspRow(iso(Date.now() - 1000), TARGET), banRow(iso(Date.now() - 5000), TARGET)]), "unavailable");
  });
  it("a state read that returns no row list is not 'no restriction': the profile is withheld", async () => {
    const w = world({ tables: { profiles: [], user_account_states: [], blocks: [], profile_privacy_settings: [] }, nullData: ["user_account_states"] });
    assert.equal((await resolveProfileVisibility(makeClient(w), USER.id, TARGET, { is_private: false, account_status: "active" })).visibility, "unavailable");
  });

  it("CONTROL — deactivated / deleted rows still hide it", async () => {
    assert.equal(await vis([{ user_id: TARGET, state: "deactivated", expires_at: null }, banRow(iso(Date.now() - 1000), TARGET)]), "unavailable");
    assert.equal(await vis([{ user_id: TARGET, state: "deleted", expires_at: null }]), "unavailable");
  });
});

describe("interaction permissions honour expiry and revocation", () => {
  const TARGET = "55555555-5555-4555-8555-555555555555";
  const perms = async (rows: Row[]) => {
    const w = world({ tables: { profiles: [{ id: USER.id, account_status: "active" }, { id: TARGET, account_status: "active" }], user_account_states: rows } });
    return resolveInteractionPermissions(makeClient(w) as any, USER.id, TARGET);
  };

  it("an in-force ban on the target makes it unavailable; a revoked one does not", async () => {
    assert.ok((await perms([banRow(null, TARGET)])).reasonCodes.includes("target_banned"));
    const lifted = await perms([banRow(iso(Date.now() - 1000), TARGET), { user_id: USER.id, state: "limited", expires_at: null }]);
    assert.ok(!lifted.reasonCodes.includes("target_banned"), lifted.reasonCodes.join(","));
    assert.notEqual(lifted.profileVisibility, "unavailable");
  });

  it("a revoked ban beside a deactivated row is ONE answer (deactivated), not a 'more than one row' failure", async () => {
    const p = await perms([banRow(iso(Date.now() - 1000), TARGET), { user_id: TARGET, state: "deactivated", expires_at: null }]);
    assert.ok(p.reasonCodes.includes("target_deactivated"), p.reasonCodes.join(","));
  });

  it("only an IN-FORCE suspension of the viewer blocks interaction, and it wins over `limited`", async () => {
    const active = await perms([{ user_id: USER.id, state: "limited", expires_at: null }, suspRow(iso(Date.now() + HOUR))]);
    assert.equal(active.canFollow, false);
    assert.equal(active.canInviteToEvent, false);
    const ended = await perms([suspRow(iso(Date.now() - 1000))]);
    assert.equal(ended.canInviteToEvent, true, "an ended suspension no longer restricts");
  });
});
