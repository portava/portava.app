/**
 * census-trust (wave 5, 2026-10-17) — the admin appeals queue reads its
 * appellants in two steps, because `appeals` has no key to `profiles`.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/appealsAppellantTwoStepRead.test.ts
 *
 * THE DEFECT. GET /api/appeals (admin) selected
 * `profiles!appellant_id(handle, display_name, avatar_url)` from `appeals`. The
 * only foreign key on public.appeals is `appeals_appellant_id_fkey`, which runs
 * to auth.users (production catalog, read by the lead 2026-10-17; migration 0070
 * and the 2026-08-19 baseline agree). PostgREST refused the embed (PGRST200) and
 * the admin queue answered `db_error` on every call.
 *
 * THE FIX. Read the page of appeals, then the appellants' profiles in ONE batched
 * `.in("id", ids)` read, joined in code. Proven here, against the doubles that
 * refuse the old embed:
 *   1. the queue answers 200 on schemaStrictSupabase with the shape it was
 *      written to return, naming only live columns;
 *   2. the appellant object is exactly {handle, displayName, avatarUrl};
 *   3. an ADMIN surface lists every appellant whatever their account state (a
 *      deactivated or deleted account's appeal is still owed a decision), and an
 *      appellant with no profile row is listed with null fields, never dropped;
 *   4. an unreadable profile batch is `db_error`, never a queue of nameless
 *      appellants;
 *   5. the profile read is one batch per page.
 *
 * Mutation proofs: see the wave-5 embeds handback (scratchpad).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { makeSchemaStrictClient, type Seed } from "./helpers/schemaStrictSupabase.js";
import { makeFailClosedClient, noopLog, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import appealsRouter from "../routes/appeals.js";

const ADMIN = "a0a0a0a0-0000-4000-a000-0000000000a0";
const ALICE = "a1a1a1a1-0000-4000-a000-0000000000a1";
const BOB   = "b2b2b2b2-0000-4000-a000-0000000000b2";
const GONE  = "c3c3c3c3-0000-4000-a000-0000000000c3"; // account state varied per case
const NOROW = "d4d4d4d4-0000-4000-a000-0000000000d4"; // no profile row at all
const TOKEN = "tok-admin";

const APPEAL_KEYS = ["appellant", "appellantId", "createdAt", "evidenceUrl", "id", "moderatorId", "reason", "resolutionNote", "state", "targetId", "targetType", "updatedAt"];

function profile(id: string, handle: string, extra: Record<string, unknown> = {}) {
  return {
    id, handle, username: handle, name: `${handle} legal name`, display_name: `${handle} display`,
    avatar_url: `https://cdn.invalid/${handle}.png`, account_status: "active", role: "user",
    bio: `${handle} private bio`, home_city: "Secret City",
    ...extra,
  };
}

function appeal(id: string, appellant: string, day: number, state = "submitted") {
  return {
    id, appellant_id: appellant, target_type: "post", target_id: `t-${id}`, reason: `reason ${id}`,
    evidence_url: null, state, moderator_id: null, resolution_note: null,
    created_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`, updated_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  };
}

function world(overrides: Partial<Seed> = {}): Seed {
  return {
    profiles: [profile(ADMIN, "admin", { role: "admin" }), profile(ALICE, "alice"), profile(BOB, "bob"), profile(GONE, "gone")],
    user_account_states: [],
    appeals: [appeal("ap-1", ALICE, 1), appeal("ap-2", BOB, 2, "under_review"), appeal("ap-3", ALICE, 3)],
    ...overrides,
  };
}

let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", appealsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); _setTestClient(null, false); });

const auth = { getUser: async (token: string) => (token === TOKEN ? { data: { user: { id: ADMIN } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) };

/** schemaStrictSupabase, mounted, with `.range()` (which it does not model) added by narrowing what it returns. */
function installStrict(seed: Seed) {
  const strict = makeSchemaStrictClient(seed);
  const profileReads: Array<{ cols: string; ids: unknown[] }> = [];
  const appealSelects: string[] = [];
  const from = (table: string) => {
    const b = strict.from(table);
    let cols = "";
    let window: [number, number] | null = null;
    const select = b.select;
    b.select = (c?: string, o?: any) => { cols = c ?? ""; if (table === "appeals") appealSelects.push(cols); return select(c, o); };
    const inFilter = b.in;
    b.in = (col: string, vals: unknown[]) => { if (table === "profiles" && col === "id") profileReads.push({ cols, ids: vals }); return inFilter(col, vals); };
    b.range = (lo: number, hi: number) => { window = [lo, hi]; return b; };
    const then = b.then;
    b.then = (onF: any, onR: any) => then((r: any) => onF(Array.isArray(r?.data) && window ? { ...r, data: r.data.slice(window[0], window[1] + 1) } : r), onR);
    return b;
  };
  _setTestClient({ from, auth }, true);
  return { strict, profileReads, appealSelects };
}

function installFailClosed(seed: Seed, failOn?: (ctx: FakeReadContext) => boolean) {
  const profileBatches: unknown[][] = [];
  _setTestClient(makeFailClosedClient({
    rows: seed as Record<string, Record<string, any>[]>,
    users: { [TOKEN]: ADMIN },
    failOn: (ctx) => {
      const batch = ctx.filters.find((f) => f.op === "in" && f.col === "id");
      if (ctx.table === "profiles" && batch) profileBatches.push(batch.val as unknown[]);
      return failOn?.(ctx) ? { message: "server closed the connection unexpectedly", code: "08006" } : null;
    },
  }), true);
  return { profileBatches };
}

async function get(path: string, token = TOKEN): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${base}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body, raw };
}

const isProfileBatch = (ctx: FakeReadContext) => ctx.table === "profiles" && ctx.filters.some((f) => f.op === "in" && f.col === "id");

describe("schema-strict: GET /api/appeals reads appeals, then one batch of appellant profiles", () => {
  it("answers 200 with the shape it was written to return, naming only live columns", async () => {
    const { strict, profileReads, appealSelects } = installStrict(world());
    const r = await get("/appeals");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(Object.keys(r.body).sort(), ["appeals", "limit", "page"]);
    assert.deepEqual(r.body.appeals.map((a: any) => a.id), ["ap-1", "ap-2", "ap-3"]);
    for (const a of r.body.appeals) assert.deepEqual(Object.keys(a).sort(), APPEAL_KEYS);
    assert.deepEqual(r.body.appeals[0], {
      id: "ap-1", appellantId: ALICE,
      appellant: { handle: "alice", displayName: "alice display", avatarUrl: "https://cdn.invalid/alice.png" },
      targetType: "post", targetId: "t-ap-1", reason: "reason ap-1", evidenceUrl: null, state: "submitted",
      moderatorId: null, resolutionNote: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(r.body.appeals[1].appellant.handle, "bob");
    assert.ok(appealSelects.length === 1 && !appealSelects[0].includes("("), `no embed on the appeals read: ${JSON.stringify(appealSelects)}`);
    assert.equal(profileReads.length, 1, "one batched profiles read per page");
    assert.deepEqual([...profileReads[0].ids].sort(), [ALICE, BOB].sort(), "each appellant once");
    assert.deepEqual(profileReads[0].cols.split(",").map((c) => c.trim()).sort(), ["avatar_url", "display_name", "handle", "id"]);
    for (const leaked of ["private bio", "Secret City", "legal name", "account_status"]) assert.ok(!r.raw.includes(leaked), `${leaked} reached the response`);
  });

  it("the state filter and the page window still apply; the batch holds only the page's appellants", async () => {
    const { profileReads } = installStrict(world());
    const r = await get("/appeals?state=under_review");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.appeals.map((a: any) => a.id), ["ap-2"]);
    assert.deepEqual(profileReads[0].ids, [BOB]);
    const paged = await get("/appeals?limit=1&page=2");
    assert.deepEqual(paged.body.appeals.map((a: any) => a.id), ["ap-2"]);
    assert.equal(paged.body.page, 2);
    assert.equal(paged.body.limit, 1);
  });

  it("an empty queue answers 200 with no profile read at all", async () => {
    const { profileReads } = installStrict(world({ appeals: [] }));
    const r = await get("/appeals");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.appeals, []);
    assert.equal(profileReads.length, 0);
  });

  it("a non-admin is still refused before anything is read", async () => {
    const seed = world();
    seed.profiles = seed.profiles.map((p) => (p.id === ADMIN ? { ...p, role: "user" } : p));
    const { profileReads } = installStrict(seed);
    const r = await get("/appeals");
    assert.equal(r.status, 403, r.raw);
    assert.equal(profileReads.length, 0);
  });
});

describe("an admin queue lists every appellant, whatever their account state", () => {
  for (const status of ["deactivated", "pending_deletion", "deleted"]) {
    it(`${status}: the appeal is listed WITH the appellant's handle (the decision is still owed)`, async () => {
      const seed = world({ appeals: [appeal("ap-gone", GONE, 1), appeal("ap-1", ALICE, 2)] });
      seed.profiles = seed.profiles.map((p) => (p.id === GONE ? { ...p, account_status: status } : p));
      installStrict(seed);
      const r = await get("/appeals");
      assert.equal(r.status, 200, r.raw);
      assert.deepEqual(r.body.appeals.map((a: any) => a.id), ["ap-gone", "ap-1"]);
      assert.deepEqual(r.body.appeals[0].appellant, { handle: "gone", displayName: "gone display", avatarUrl: "https://cdn.invalid/gone.png" });
    });
  }

  it("an appellant with NO profile row is listed with null appellant fields, never dropped from the queue", async () => {
    installStrict(world({ appeals: [appeal("ap-norow", NOROW, 1), appeal("ap-1", ALICE, 2)] }));
    const r = await get("/appeals");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.appeals.map((a: any) => a.id), ["ap-norow", "ap-1"]);
    assert.deepEqual(r.body.appeals[0].appellant, { handle: null, displayName: null, avatarUrl: null });
    assert.equal(r.body.appeals[0].appellantId, NOROW);
  });
});

describe("an unreadable appellant batch is db_error, never a queue of nameless appellants", () => {
  it("HEALTHY TWIN 200, then FAILURE db_error with no `appeals` key", async () => {
    installFailClosed(world());
    const ok = await get("/appeals");
    assert.equal(ok.status, 200, ok.raw);
    assert.ok(ok.body.appeals.every((a: any) => a.appellant.handle), "the twin renders handles");

    const { profileBatches } = installFailClosed(world(), isProfileBatch);
    const r = await get("/appeals");
    assert.equal(profileBatches.length, 1, "the batch was attempted once");
    assert.equal(r.status, 500, r.raw);
    assert.equal(r.body.error, "db_error");
    assert.equal(r.body.appeals, undefined, "no queue is served beside the failure");
  });
});

describe("both doubles refuse `profiles!appellant_id(...)` from `appeals`", () => {
  it("failClosedSupabase and schemaStrictSupabase throw PGRST200 on the old select", () => {
    const old = "id, appellant_id, target_type, target_id, reason, evidence_url, state, moderator_id, resolution_note, created_at, updated_at, profiles!appellant_id(handle, display_name, avatar_url)";
    assert.throws(() => makeFailClosedClient({}).from("appeals").select(old), /failClosedSupabase: `profiles\(\.\.\.\)` is embedded from `appeals`.*PGRST200/);
    assert.throws(() => makeSchemaStrictClient({}).from("appeals").select(old), /schemaStrictSupabase: `profiles\(\.\.\.\)` is embedded from `appeals`.*PGRST200/);
  });
});
