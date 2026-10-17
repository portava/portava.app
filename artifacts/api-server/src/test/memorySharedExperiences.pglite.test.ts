/**
 * §5 "Remember this together" — the shared-experience anchor and participant
 * consent (migration 3997, census H53), and §3.6 memory_visibility_policies'
 * storage (3997, census H33), executed against REAL SQL.
 *
 * Migration 3997 is applied to an isolated PGlite database, and the HTTP routes
 * (routes/memorySharedExperiences.ts) run over it through a small PostgREST-
 * shaped adapter that executes every read, write and RPC as `service_role` — so
 * the grants are exercised too, not assumed.
 *
 * The spec sentence under test: "Prefer a shared-experience anchor plus
 * separate personal Memories. Mutual 'Remember this together' creates an
 * explicitly shared object only after participant consent."
 *
 * Run: node --import tsx/esm --test src/test/memorySharedExperiences.pglite.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import sharedRouter from "../routes/memorySharedExperiences.js";

const modulePath = process.env.MEMORY_SHARED_EXPERIENCES_PGLITE_MODULE ?? process.env.DISCOVERY_PGLITE_MODULE
  ?? import.meta.resolve("@electric-sql/pglite");
const migration = readFileSync(new URL("../migrations/3997_memory_visibility_policies_and_shared_experiences.sql", import.meta.url), "utf8");

const HOST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BAO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STRANGER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PENDING_TAG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const M_HOST = "10000000-0000-4000-8000-000000000001";
const M_ANA = "10000000-0000-4000-8000-000000000002";
const M_BAO = "10000000-0000-4000-8000-000000000003";
const M_STRANGER = "10000000-0000-4000-8000-000000000004";
const M_HOST_PRIVATE = "10000000-0000-4000-8000-000000000005";

interface Database {
  exec(sql: string): Promise<unknown>;
  query<Row = Record<string, any>>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[] }>;
  close(): Promise<void>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(s: string): string { assert.match(s, IDENT); return s; }
/** A select list; an embedded resource (`rel!fk(cols)`) is dropped — this adapter has no joins. */
function columns(s: string | undefined): string {
  if (!s || s.trim() === "*") return "*";
  const plain = s.replace(/[a-z_]+(![a-z_]+)?\([^)]*\)/g, "").split(",").map((c) => c.trim()).filter(Boolean);
  return plain.map(ident).join(", ");
}

/** A PostgREST-shaped client over PGlite. Every statement runs as service_role. `failSelect` makes chosen reads resolve with an error, as supabase-js does. */
function pgClient(db: Database, opts: { failSelect?: (table: string, columns: string) => boolean } = {}) {
  async function asService<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec("SET ROLE service_role");
    try { return await fn(); } finally { await db.exec("RESET ROLE"); }
  }
  return {
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
    from(table: string) {
      ident(table);
      const where: string[] = [];
      const values: unknown[] = [];
      let op: "select" | "delete" | "upsert" = "select";
      let cols = "*";
      let returning = "";
      let payload: Record<string, unknown> | null = null;
      let conflict = "";
      let single = false;
      const q: any = {
        select(c?: string) { if (op === "select") cols = columns(c); else returning = columns(c); return q; },
        eq(c: string, v: unknown) { values.push(v); where.push(`${ident(c)}::text = $${values.length}::text`); return q; },
        neq(c: string, v: unknown) { values.push(v); where.push(`${ident(c)}::text <> $${values.length}::text`); return q; },
        in(c: string, vs: unknown[]) { values.push(vs.map(String)); where.push(`${ident(c)}::text = ANY($${values.length}::text[])`); return q; },
        is(c: string, v: unknown) { assert.equal(v, null); where.push(`${ident(c)} IS NULL`); return q; },
        order() { return q; }, limit() { return q; },
        delete() { op = "delete"; return q; },
        upsert(p: Record<string, unknown>, o?: { onConflict?: string }) { op = "upsert"; payload = p; conflict = o?.onConflict ?? "id"; return q; },
        maybeSingle() { single = true; return run(); },
        then(f: any, r: any) { return run().then(f, r); },
      };
      async function run(): Promise<{ data: any; error: any }> {
        try {
          return await asService(async () => {
            const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
            if (op === "select") {
              if (opts.failSelect?.(table, cols)) return { data: null, error: { message: `${table} unavailable` } };
              const r = await db.query(`SELECT ${cols} FROM public.${table}${w}`, values);
              return { data: single ? (r.rows[0] ?? null) : r.rows, error: null };
            }
            if (op === "delete") {
              const r = await db.query(`DELETE FROM public.${table}${w} RETURNING ${returning || "*"}`, values);
              return { data: r.rows, error: null };
            }
            const keys = Object.keys(payload!).map(ident);
            const conflictCols = conflict.split(",").map((c) => ident(c.trim()));
            const updates = keys.filter((k) => !conflictCols.includes(k)).map((k) => `${k} = EXCLUDED.${k}`).join(", ");
            const r = await db.query(
              `INSERT INTO public.${table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})
               ON CONFLICT (${conflictCols.join(", ")}) DO UPDATE SET ${updates} RETURNING ${returning || "*"}`,
              keys.map((k) => (payload as any)[k]),
            );
            return { data: r.rows, error: null };
          });
        } catch (e: any) {
          return { data: null, error: { message: e?.message ?? String(e), code: e?.code } };
        }
      }
      return q;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      ident(name);
      const keys = Object.keys(args).map(ident);
      try {
        return await asService(async () => {
          const r = await db.query(`SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) AS result`, keys.map((k) => args[k]));
          return { data: r.rows[0]?.result ?? null, error: null };
        });
      } catch (e: any) {
        return { data: null, error: { message: e?.message ?? String(e), code: e?.code } };
      }
    },
  };
}

describe("H53 / H33 — migration 3997 executed in PGlite, and the shared-experience routes over it", { concurrency: 1 }, () => {
  let db: Database;
  let base: string;
  let server: http.Server;

  async function sql<Row = Record<string, any>>(text: string, params: unknown[] = []) {
    return (await db.query<Row>(text, params)).rows;
  }
  async function asService<Row = Record<string, any>>(text: string, params: unknown[] = []) {
    await db.exec("SET ROLE service_role");
    try { return (await db.query<Row>(text, params)).rows; } finally { await db.exec("RESET ROLE"); }
  }
  const invite = (host: string, memory: string, invitee: string) =>
    asService<{ r: any }>("SELECT public.memory_shared_experience_invite($1, $2, $3) AS r", [host, memory, invitee]).then((x) => x[0].r);
  const respond = (inv: string, who: string, accept: boolean, mem: string | null = null) =>
    asService<{ r: any }>("SELECT public.memory_shared_experience_respond($1, $2, $3, $4) AS r", [inv, who, accept, mem]).then((x) => x[0].r);
  const leave = (exp: string, who: string) =>
    asService<{ r: any }>("SELECT public.memory_shared_experience_leave($1, $2) AS r", [exp, who]).then((x) => x[0].r);
  const end = (host: string, memory: string) =>
    asService<{ r: any }>("SELECT public.memory_shared_experience_end($1, $2) AS r", [host, memory]).then((x) => x[0].r);
  const count = async (table: string) => Number((await sql(`SELECT count(*)::int AS n FROM public.${ident(table)}`))[0].n);

  async function call(method: string, path: string, actor: string | null, body?: unknown) {
    const res = await fetch(base + "/api" + path, {
      method,
      headers: { ...(actor ? { Authorization: `Bearer ${actor}` } : {}), "Content-Type": "application/json", connection: "close" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, cache: res.headers.get("cache-control") };
  }

  before(async () => {
    const runtime = await import(modulePath.startsWith("file:") ? modulePath : pathToFileURL(modulePath).href);
    db = new runtime.PGlite() as Database;
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; -- as on Supabase
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE TABLE public.feature_flags (flag text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text);
      CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, name text, handle text, avatar_url text, account_status text DEFAULT 'active');
      CREATE TABLE public.memories (
        id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        title text, state text NOT NULL DEFAULT 'published', visibility text NOT NULL DEFAULT 'public',
        allowed_user_ids uuid[] NOT NULL DEFAULT '{}', hidden_user_ids uuid[] NOT NULL DEFAULT '{}', trip_id uuid);
      CREATE TABLE public.memory_tags (memory_id uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
        tagged_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, status text NOT NULL DEFAULT 'pending',
        PRIMARY KEY (memory_id, tagged_user_id));
      CREATE TABLE public.blocks (blocker_id uuid NOT NULL, blocked_id uuid NOT NULL, PRIMARY KEY (blocker_id, blocked_id));
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT ALL ON public.feature_flags, public.profiles, public.memories, public.memory_tags, public.blocks TO service_role;
      GRANT SELECT ON public.memories TO authenticated;
    `);
    await db.exec(migration);
    _setTestClient(pgClient(db) as any, true);
    const app = express();
    app.use(express.json());
    app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
    app.use("/api", sharedRouter);
    await new Promise<void>((resolve, reject) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; server.unref(); resolve(); });
      server.on("error", reject);
    });
  });

  beforeEach(async () => {
    _setTestClient(pgClient(db) as any, true);
    await db.exec(`
      TRUNCATE auth.users CASCADE; TRUNCATE public.blocks;
      UPDATE public.feature_flags SET enabled = true WHERE flag IN ('memory_shared_experiences_enabled', 'memory_visibility_policies_enabled');
    `);
    await db.query(`INSERT INTO auth.users VALUES ($1), ($2), ($3), ($4), ($5)`, [HOST, ANA, BAO, STRANGER, PENDING_TAG]);
    await db.query(`INSERT INTO public.profiles (id, name, handle) VALUES ($1,'Host','host'), ($2,'Ana','ana'), ($3,'Bao','bao'), ($4,'Stranger','s'), ($5,'Pending','p')`,
      [HOST, ANA, BAO, STRANGER, PENDING_TAG]);
    await db.query(`INSERT INTO public.memories (id, owner_id, title, visibility) VALUES
      ($1, $2, 'Night market in Hoi An', 'public'), ($3, $4, 'My night market', 'only_me'),
      ($5, $6, 'Bao''s lanterns', 'public'), ($7, $8, 'Elsewhere', 'public'), ($9, $2, 'Private dinner', 'only_me')`,
      [M_HOST, HOST, M_ANA, ANA, M_BAO, BAO, M_STRANGER, STRANGER, M_HOST_PRIVATE]);
    await db.query(`INSERT INTO public.memory_tags (memory_id, tagged_user_id, status) VALUES
      ($1, $2, 'approved'), ($1, $3, 'approved'), ($1, $4, 'pending'), ($5, $2, 'approved')`,
      [M_HOST, ANA, BAO, PENDING_TAG, M_HOST_PRIVATE]);
  });

  after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await db?.close();
  });

  // ── The SQL contract ───────────────────────────────────────────────────────

  it("seeds both flags FALSE, is re-runnable, and leaves every client role without access", async () => {
    const fresh = await import(modulePath.startsWith("file:") ? modulePath : pathToFileURL(modulePath).href);
    const other = new fresh.PGlite() as Database;
    try {
      await other.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
        CREATE TABLE auth.users (id uuid PRIMARY KEY);
        CREATE TABLE public.feature_flags (flag text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text);
        CREATE TABLE public.memories (id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth.users(id), state text NOT NULL DEFAULT 'published');
        CREATE TABLE public.memory_tags (memory_id uuid, tagged_user_id uuid, status text);`);
      await other.exec(migration);
      await other.exec(migration);
      const flags = (await other.query<{ flag: string; enabled: boolean }>("SELECT flag, enabled FROM public.feature_flags ORDER BY flag")).rows;
      assert.deepEqual(flags.map((f) => [f.flag, f.enabled]), [["memory_shared_experiences_enabled", false], ["memory_visibility_policies_enabled", false]]);
    } finally { await other.close(); }
    const privileges = (await sql<any>(`SELECT
      has_table_privilege('authenticated', 'public.memory_shared_experiences', 'SELECT') AS a1,
      has_table_privilege('anon', 'public.memory_shared_experience_invitations', 'SELECT') AS a2,
      has_table_privilege('authenticated', 'public.memory_visibility_policies', 'INSERT') AS a3,
      has_function_privilege('authenticated', 'public.memory_shared_experience_invite(uuid,uuid,uuid)', 'EXECUTE') AS a4,
      has_function_privilege('anon', 'public.memory_shared_experience_respond(uuid,uuid,boolean,uuid)', 'EXECUTE') AS a5,
      has_function_privilege('service_role', 'public.memory_shared_experience_respond(uuid,uuid,boolean,uuid)', 'EXECUTE') AS s1`))[0];
    assert.deepEqual(privileges, { a1: false, a2: false, a3: false, a4: false, a5: false, s1: true });
  });

  it("with the flag off, nobody can be invited (the ways out are proved ungated at the end of this file)", async () => {
    await db.exec("UPDATE public.feature_flags SET enabled = false WHERE flag = 'memory_shared_experiences_enabled'");
    assert.equal((await invite(HOST, M_HOST, ANA)).outcome, "disabled");
    assert.equal(await count("memory_shared_experience_invitations"), 0);
  });

  it("only the owner of a live Memory may invite, and only a person with an APPROVED tag on it", async () => {
    assert.equal((await invite(ANA, M_HOST, BAO)).outcome, "not_found", "not your Memory");
    assert.equal((await invite(HOST, M_HOST, PENDING_TAG)).outcome, "not_invitable", "a pending tag is not consent to being there");
    assert.equal((await invite(HOST, M_HOST, STRANGER)).outcome, "not_invitable", "no tag at all");
    assert.equal((await invite(HOST, M_HOST, HOST)).outcome, "not_invitable", "not yourself");
    assert.equal((await invite(HOST, M_HOST, ANA)).outcome, "invited");
    assert.equal((await invite(HOST, M_HOST, ANA)).outcome, "already_invited");
    await db.exec(`UPDATE public.memories SET state = 'deleted' WHERE id = '${M_HOST_PRIVATE}'`);
    assert.equal((await invite(HOST, M_HOST_PRIVATE, ANA)).outcome, "not_found", "a deleted Memory invites nobody");
  });

  it("creates NO shared object until somebody consents — and then exactly one, shared by everyone who does", async () => {
    const a = await invite(HOST, M_HOST, ANA);
    const b = await invite(HOST, M_HOST, BAO);
    assert.equal(await count("memory_shared_experiences"), 0, "an invitation is a question, not a shared object");
    const accepted = await respond(a.invitation_id, ANA, true, M_ANA);
    assert.equal(accepted.outcome, "accepted");
    assert.equal(await count("memory_shared_experiences"), 1);
    const second = await respond(b.invitation_id, BAO, true, null);
    assert.equal(second.experience_id, accepted.experience_id, "one anchor per host Memory");
    const rows = await sql<any>("SELECT invitee_id, status, participant_memory_id FROM public.memory_shared_experience_invitations ORDER BY invitee_id");
    assert.deepEqual(rows.map((r) => [r.invitee_id, r.status, r.participant_memory_id]), [[ANA, "accepted", M_ANA], [BAO, "accepted", null]]);
    const owners = await sql<any>("SELECT id, owner_id FROM public.memories WHERE id IN ($1, $2) ORDER BY id", [M_HOST, M_ANA]);
    assert.deepEqual(owners.map((o) => o.owner_id), [HOST, ANA], "each Memory stays its owner's: nothing is co-owned");
  });

  it("only the invitee answers, once; a decline is final for that Memory", async () => {
    const a = await invite(HOST, M_HOST, ANA);
    assert.equal((await respond(a.invitation_id, BAO, true)).outcome, "not_found", "someone else's invitation");
    assert.equal((await respond(a.invitation_id, ANA, false)).outcome, "declined");
    assert.equal((await respond(a.invitation_id, ANA, true)).outcome, "not_found", "already answered");
    assert.equal((await invite(HOST, M_HOST, ANA)).outcome, "answered", "a no is not re-asked");
    assert.equal(await count("memory_shared_experiences"), 0);
    await assert.rejects(asService(`UPDATE public.memory_shared_experience_invitations SET status = 'pending', responded_at = NULL WHERE id = $1`, [a.invitation_id]),
      /not a consent transition/);
    await assert.rejects(asService(`INSERT INTO public.memory_shared_experience_invitations (host_memory_id, host_id, invitee_id, status, responded_at) VALUES ($1, $2, $3, 'declined', now())`, [M_HOST, HOST, BAO]),
      /created pending/);
    await assert.rejects(asService(`UPDATE public.memory_shared_experience_invitations SET invitee_id = $2 WHERE id = $1`, [a.invitation_id, BAO]),
      /cannot change/);
  });

  it("a participant may link only their OWN live Memory, and only once", async () => {
    const a = await invite(HOST, M_HOST, ANA);
    const b = await invite(HOST, M_HOST, BAO);
    assert.equal((await respond(a.invitation_id, ANA, true, M_BAO)).outcome, "memory_not_linkable", "not Ana's Memory");
    assert.equal((await respond(a.invitation_id, ANA, true, M_HOST)).outcome, "memory_not_linkable", "the host's Memory is not Ana's");
    assert.equal((await respond(a.invitation_id, ANA, true, M_ANA)).outcome, "accepted");
    assert.equal((await respond(b.invitation_id, BAO, true, M_ANA)).outcome, "memory_not_linkable");
  });

  it("a tag withdrawn after the invitation means the invitation no longer stands", async () => {
    const a = await invite(HOST, M_HOST, ANA);
    await db.query("UPDATE public.memory_tags SET status = 'removed' WHERE memory_id = $1 AND tagged_user_id = $2", [M_HOST, ANA]);
    assert.equal((await respond(a.invitation_id, ANA, true)).outcome, "not_invitable");
    assert.equal(await count("memory_shared_experiences"), 0);
  });

  it("leaving withdraws consent; the experience is erased when nobody is left", async () => {
    const a = await invite(HOST, M_HOST, ANA);
    const b = await invite(HOST, M_HOST, BAO);
    const exp = (await respond(a.invitation_id, ANA, true, M_ANA)).experience_id;
    await respond(b.invitation_id, BAO, true);
    assert.equal((await leave(exp, ANA)).outcome, "left");
    assert.equal(await count("memory_shared_experiences"), 1, "Bao is still in it");
    const ana = (await sql<any>("SELECT status, experience_id, participant_memory_id, left_at FROM public.memory_shared_experience_invitations WHERE invitee_id = $1", [ANA]))[0];
    assert.equal(ana.status, "left");
    assert.equal(ana.experience_id, null);
    assert.equal(ana.participant_memory_id, null, "her Memory is unlinked");
    assert.ok(ana.left_at);
    assert.equal((await leave(exp, ANA)).outcome, "not_member");
    assert.equal((await leave(exp, BAO)).outcome, "left");
    assert.equal(await count("memory_shared_experiences"), 0, "dissolved");
    assert.equal(Number((await sql<any>("SELECT count(*)::int AS n FROM public.memories WHERE id IN ($1, $2)", [M_HOST, M_ANA]))[0].n), 2, "no personal Memory was touched");
  });

  it("the host ends it for everyone, and nothing about who was asked survives", async () => {
    const a = await invite(HOST, M_HOST, ANA);
    const b = await invite(HOST, M_HOST, BAO);
    await respond(a.invitation_id, ANA, true, M_ANA);
    await respond(b.invitation_id, BAO, false);
    assert.equal((await end(ANA, M_HOST)).outcome, "not_found", "a participant cannot end it");
    assert.equal((await end(HOST, M_HOST)).outcome, "ended");
    assert.equal(await count("memory_shared_experiences"), 0);
    assert.equal(await count("memory_shared_experience_invitations"), 0);
  });

  it("a deleted host Memory takes the experience with it; a deleted participant Memory is only unlinked", async () => {
    const a = await invite(HOST, M_HOST, ANA);
    const b = await invite(HOST, M_HOST, BAO);
    await respond(a.invitation_id, ANA, true, M_ANA);
    await respond(b.invitation_id, BAO, true, M_BAO);
    await db.exec(`UPDATE public.memories SET state = 'deleted' WHERE id = '${M_BAO}'`);
    const bao = (await sql<any>("SELECT status, participant_memory_id FROM public.memory_shared_experience_invitations WHERE invitee_id = $1", [BAO]))[0];
    assert.deepEqual([bao.status, bao.participant_memory_id], ["accepted", null]);
    await db.exec(`UPDATE public.memories SET state = 'deleted' WHERE id = '${M_HOST}'`);
    assert.equal(await count("memory_shared_experiences"), 0);
    assert.equal(await count("memory_shared_experience_invitations"), 0);
  });

  it("account erasure cascades: an erased participant leaves; an erased host erases it all", async () => {
    const a = await invite(HOST, M_HOST, ANA);
    await respond(a.invitation_id, ANA, true, M_ANA);
    await db.query("DELETE FROM auth.users WHERE id = $1", [ANA]);
    assert.equal(await count("memory_shared_experiences"), 0, "the last participant's erasure dissolves it");
    const b = await invite(HOST, M_HOST, BAO);
    await respond(b.invitation_id, BAO, true);
    await db.query("DELETE FROM auth.users WHERE id = $1", [HOST]);
    assert.equal(await count("memory_shared_experiences"), 0);
    assert.equal(await count("memory_shared_experience_invitations"), 0);
  });

  it("H33's table holds one ceiling per owner and audience, on the ladder only, erased with the account", async () => {
    await asService("INSERT INTO public.memory_visibility_policies (owner_id, audience, location_precision) VALUES ($1, 'public', 'city')", [HOST]);
    await assert.rejects(asService("INSERT INTO public.memory_visibility_policies (owner_id, audience, location_precision) VALUES ($1, 'public', 'country')", [HOST]), /duplicate key/);
    await assert.rejects(asService("INSERT INTO public.memory_visibility_policies (owner_id, audience, location_precision) VALUES ($1, 'private', 'city')", [ANA]), /audience_check/);
    await assert.rejects(asService("INSERT INTO public.memory_visibility_policies (owner_id, audience, location_precision) VALUES ($1, 'public', 'EXACT')", [ANA]), /precision_check/);
    await db.query("DELETE FROM auth.users WHERE id = $1", [HOST]);
    assert.equal(await count("memory_visibility_policies"), 0);
  });

  // ── The routes, over the same SQL ──────────────────────────────────────────

  it("HTTP: the host sees only themself plus who could be asked; nothing is shared yet", async () => {
    const r = await call("GET", `/memories/${M_HOST}/shared-experience`, HOST);
    assert.equal(r.status, 200);
    assert.equal(r.cache, "private, no-store");
    const v = r.body.sharedExperience;
    assert.equal(v.experienceId, null);
    assert.equal(v.viewerRole, "host");
    assert.deepEqual(v.members.map((m: any) => [m.userId, m.role]), [[HOST, "host"]]);
    assert.deepEqual(v.invitable.map((p: any) => p.userId).sort(), [ANA, BAO].sort(), "approved tags only: the pending tag is not offered");
    assert.deepEqual(v.pending, []);
  });

  it("HTTP: invite → the invitee sees it → accepts with their own Memory → both see the shared experience", async () => {
    const inv = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: ANA });
    assert.equal(inv.status, 201);
    assert.equal(inv.body.outcome, "invited");
    assert.equal((await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: BAO })).status, 201, "Bao is asked too, and has not answered");
    const mine = await call("GET", "/me/shared-experience-invitations", ANA);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.invitations.length, 1);
    const [i] = mine.body.invitations;
    assert.equal(i.host.userId, HOST);
    assert.equal(i.memoryTitle, "Night market in Hoi An", "a public Memory's title is something Ana may already read");
    const acc = await call("POST", `/shared-experience-invitations/${i.invitationId}/accept`, ANA, { memoryId: M_ANA });
    assert.equal(acc.status, 200);
    assert.ok(acc.body.experienceId);
    const hostView = (await call("GET", `/memories/${M_HOST}/shared-experience`, HOST)).body.sharedExperience;
    assert.equal(hostView.experienceId, acc.body.experienceId);
    const ana = hostView.members.find((m: any) => m.userId === ANA);
    assert.equal(ana.role, "participant");
    assert.equal(ana.memoryId, null, "Ana's Memory is only_me: the anchor grants the host no read of it");
    const anaView = (await call("GET", `/memories/${M_ANA}/shared-experience`, ANA)).body.sharedExperience;
    assert.equal(anaView.viewerRole, "participant");
    assert.equal(anaView.hostMemoryId, M_HOST);
    assert.equal(anaView.members.find((m: any) => m.role === "host").memoryId, M_HOST, "the host's public Memory is readable to her anyway");
    assert.equal(anaView.members.find((m: any) => m.userId === ANA).memoryId, M_ANA, "her own");
    assert.deepEqual(anaView.pending, [], "a participant does not see who else was asked (Bao is pending)");
    assert.deepEqual(hostView.pending.map((p: any) => p.userId), [BAO], "the host does");
    assert.deepEqual(anaView.invitable, []);
  });

  it("HTTP: an invitation to an only_me Memory names the host but not the Memory", async () => {
    assert.equal((await call("POST", `/memories/${M_HOST_PRIVATE}/shared-experience/invitations`, HOST, { userId: ANA })).status, 201);
    const [i] = (await call("GET", "/me/shared-experience-invitations", ANA)).body.invitations;
    assert.equal(i.host.userId, HOST);
    assert.equal(i.memoryTitle, null);
    assert.equal(i.memoryId, null);
  });

  it("HTTP: a stranger learns nothing and cannot answer someone else's invitation", async () => {
    const inv = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: ANA });
    await call("POST", `/shared-experience-invitations/${inv.body.invitationId}/accept`, ANA, {});
    assert.equal((await call("GET", `/memories/${M_HOST}/shared-experience`, STRANGER)).body.sharedExperience, null);
    assert.equal((await call("GET", `/memories/${M_STRANGER}/shared-experience`, HOST)).body.sharedExperience, null);
    const other = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: BAO });
    assert.equal((await call("POST", `/shared-experience-invitations/${other.body.invitationId}/accept`, STRANGER, {})).status, 404);
    assert.equal((await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, STRANGER, { userId: BAO })).status, 404, "not the stranger's Memory");
    assert.equal((await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: BAO, hostId: STRANGER })).status, 400, "no actor id is taken from the body");
  });

  it("HTTP: a block in either direction stops an invitation, hides the invitation, and hides the member", async () => {
    await db.query("INSERT INTO public.blocks VALUES ($1, $2)", [BAO, HOST]);
    assert.equal((await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: BAO })).status, 403);
    const hostView = (await call("GET", `/memories/${M_HOST}/shared-experience`, HOST)).body.sharedExperience;
    assert.deepEqual(hostView.invitable.map((p: any) => p.userId), [ANA], "Bao, blocked, is not offered");
    await db.exec("TRUNCATE public.blocks");
    const inv = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: ANA });
    await call("POST", `/shared-experience-invitations/${inv.body.invitationId}/accept`, ANA, { memoryId: M_ANA });
    // §25: "Blocked participant after shared experience."
    await db.query("INSERT INTO public.blocks VALUES ($1, $2)", [HOST, ANA]);
    const after = (await call("GET", `/memories/${M_HOST}/shared-experience`, HOST)).body.sharedExperience;
    assert.deepEqual(after.members.map((m: any) => m.userId), [HOST], "the blocked participant is not shown to the host");
    const hers = (await call("GET", `/memories/${M_ANA}/shared-experience`, ANA)).body.sharedExperience;
    assert.deepEqual(hers.members.map((m: any) => m.userId), [ANA], "nor the host to her");
    const inv2 = await call("POST", `/memories/${M_HOST_PRIVATE}/shared-experience/invitations`, HOST, { userId: ANA });
    assert.equal(inv2.status, 403, "and no new invitation crosses the block");
  });

  it("HTTP: a block that arrives after the invitation stops its acceptance and hides it", async () => {
    const inv = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: ANA });
    await db.query("INSERT INTO public.blocks VALUES ($1, $2)", [ANA, HOST]);
    assert.deepEqual((await call("GET", "/me/shared-experience-invitations", ANA)).body.invitations, []);
    assert.equal((await call("POST", `/shared-experience-invitations/${inv.body.invitationId}/accept`, ANA, {})).status, 404);
    assert.equal(await count("memory_shared_experiences"), 0);
  });

  it("HTTP: decline, withdraw, leave and end each do one thing", async () => {
    const a = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: ANA });
    const b = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: BAO });
    assert.equal((await call("DELETE", `/memories/${M_HOST}/shared-experience/invitations/${BAO}`, HOST)).body.withdrawn, true);
    assert.equal((await call("POST", `/shared-experience-invitations/${b.body.invitationId}/decline`, BAO)).status, 404, "withdrawn means gone");
    const acc = await call("POST", `/shared-experience-invitations/${a.body.invitationId}/accept`, ANA, {});
    assert.equal((await call("POST", `/shared-experiences/${acc.body.experienceId}/leave`, HOST)).status, 404, "the host ends, a participant leaves");
    assert.equal((await call("POST", `/shared-experiences/${acc.body.experienceId}/leave`, ANA)).status, 200);
    assert.equal((await call("GET", `/memories/${M_HOST}/shared-experience`, ANA)).body.sharedExperience, null);
    assert.equal(await count("memory_shared_experiences"), 0);
    await call("POST", `/memories/${M_HOST_PRIVATE}/shared-experience/invitations`, HOST, { userId: ANA });
    assert.equal((await call("DELETE", `/memories/${M_HOST_PRIVATE}/shared-experience`, HOST)).body.ended, true);
    assert.equal((await call("DELETE", `/memories/${M_HOST_PRIVATE}/shared-experience`, ANA)).status, 404);
  });

  it("HTTP: an invitation list that cannot be read is a refusal, never 'not part of anything'", async () => {
    const inv = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: ANA });
    await call("POST", `/shared-experience-invitations/${inv.body.invitationId}/accept`, ANA, {});
    _setTestClient(pgClient(db, { failSelect: (t, c) => t === "memory_shared_experience_invitations" && c.includes("experience_id") }) as any, true);
    const r = await call("GET", `/memories/${M_HOST}/shared-experience`, ANA);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("HTTP: off is absent, and an unreadable store is a refusal, never 'no shared experience'", async () => {
    await db.exec("UPDATE public.feature_flags SET enabled = false WHERE flag = 'memory_shared_experiences_enabled'");
    for (const [method, path, body] of [
      ["GET", `/memories/${M_HOST}/shared-experience`, undefined],
      ["POST", `/memories/${M_HOST}/shared-experience/invitations`, { userId: ANA }],
      ["GET", "/me/shared-experience-invitations", undefined],
    ] as const) {
      const r = await call(method, path, HOST, body);
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.equal(r.body.error, "feature_disabled");
    }
    await db.exec("UPDATE public.feature_flags SET enabled = true WHERE flag = 'memory_shared_experiences_enabled'");
    await db.exec("REVOKE SELECT ON public.memory_shared_experience_invitations FROM service_role");
    try {
      const r = await call("GET", `/memories/${M_HOST}/shared-experience`, HOST);
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "degraded_unavailable");
    } finally {
      await db.exec("GRANT SELECT ON public.memory_shared_experience_invitations TO service_role");
    }
  });

  // ── H53 correction (2026-10-17, wave-4 verification): the ways OUT are never gated ──
  // 3997 says leaving is deliberately not flag-gated ("never trap a person"); the
  // service used to gate it anyway. Anything that removes a person or their consent
  // (leave, decline, withdraw, end) runs with the flag OFF; anything that creates or
  // extends sharing (invite, accept) and the reads stay gated.

  const flagOff = () => db.exec("UPDATE public.feature_flags SET enabled = false WHERE flag = 'memory_shared_experiences_enabled'");
  const statusOf = async (invitee: string, memory = M_HOST) =>
    (await sql<any>("SELECT status FROM public.memory_shared_experience_invitations WHERE invitee_id = $1 AND host_memory_id = $2", [invitee, memory]))[0]?.status ?? null;

  it("H53 flag OFF: a member LEAVES; a non-member, the host and an anonymous caller are refused", async () => {
    const a = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: ANA });
    const b = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: BAO });
    const exp = (await call("POST", `/shared-experience-invitations/${a.body.invitationId}/accept`, ANA, { memoryId: M_ANA })).body.experienceId;
    await call("POST", `/shared-experience-invitations/${b.body.invitationId}/accept`, BAO, {});
    await flagOff();
    const stranger = await call("POST", `/shared-experiences/${exp}/leave`, STRANGER);
    assert.deepEqual([stranger.status, stranger.body.error], [404, "not_found"], "a non-member is refused as a non-member, not as 'disabled'");
    const host = await call("POST", `/shared-experiences/${exp}/leave`, HOST);
    assert.deepEqual([host.status, host.body.error], [404, "not_found"], "the host ends; only a participant leaves");
    assert.equal((await call("POST", `/shared-experiences/${exp}/leave`, null)).status, 401, "auth is still required");
    const left = await call("POST", `/shared-experiences/${exp}/leave`, ANA);
    assert.equal(left.status, 200, "the switch must not trap her");
    assert.deepEqual(left.body, { left: true });
    assert.equal(await statusOf(ANA), "left");
    assert.equal(await statusOf(BAO), "accepted", "only the member themself left");
    assert.equal(await count("memory_shared_experiences"), 1);
    const again = await call("POST", `/shared-experiences/${exp}/leave`, ANA);
    assert.deepEqual([again.status, again.body.error], [404, "not_found"], "once");
    assert.equal((await call("POST", `/shared-experiences/${exp}/leave`, BAO)).status, 200);
    assert.equal(await count("memory_shared_experiences"), 0, "and it still dissolves when nobody is left");
  });

  it("H53 flag OFF: decline, withdraw and end still work, each only for the person it belongs to", async () => {
    const a = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: ANA });
    await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: BAO });
    const p = await call("POST", `/memories/${M_HOST_PRIVATE}/shared-experience/invitations`, HOST, { userId: ANA });
    await call("POST", `/shared-experience-invitations/${a.body.invitationId}/accept`, ANA, {});
    await flagOff();
    // decline
    const notHers = await call("POST", `/shared-experience-invitations/${p.body.invitationId}/decline`, STRANGER);
    assert.deepEqual([notHers.status, notHers.body.error], [404, "not_found"]);
    assert.equal(await statusOf(ANA, M_HOST_PRIVATE), "pending");
    const declined = await call("POST", `/shared-experience-invitations/${p.body.invitationId}/decline`, ANA);
    assert.equal(declined.status, 200, "a no to a question already asked is never gated");
    assert.equal(declined.body.outcome, "declined");
    assert.equal(await statusOf(ANA, M_HOST_PRIVATE), "declined");
    // withdraw
    assert.equal((await call("DELETE", `/memories/${M_HOST}/shared-experience/invitations/${BAO}`, ANA)).body.withdrawn, false, "not Ana's invitation to take back");
    assert.equal(await statusOf(BAO), "pending");
    const withdrawn = await call("DELETE", `/memories/${M_HOST}/shared-experience/invitations/${BAO}`, HOST);
    assert.deepEqual([withdrawn.status, withdrawn.body.withdrawn], [200, true]);
    assert.equal(await statusOf(BAO), null);
    // end
    const notHost = await call("DELETE", `/memories/${M_HOST}/shared-experience`, ANA);
    assert.deepEqual([notHost.status, notHost.body.error], [404, "not_found"], "a participant cannot end it");
    assert.equal(await count("memory_shared_experiences"), 1);
    const ended = await call("DELETE", `/memories/${M_HOST}/shared-experience`, HOST);
    assert.deepEqual([ended.status, ended.body.ended], [200, true]);
    assert.equal(await count("memory_shared_experiences"), 0);
  });

  it("H53 flag OFF: every way IN is still refused — invite, accept (which would create or join), and the reads", async () => {
    const a = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: ANA });
    const b = await call("POST", `/memories/${M_HOST}/shared-experience/invitations`, HOST, { userId: BAO });
    await flagOff();
    const create = await call("POST", `/shared-experience-invitations/${a.body.invitationId}/accept`, ANA, { memoryId: M_ANA });
    assert.deepEqual([create.status, create.body.error], [404, "feature_disabled"], "the first acceptance would CREATE the experience");
    assert.equal(await count("memory_shared_experiences"), 0);
    assert.equal(await statusOf(ANA), "pending");
    const invited = await call("POST", `/memories/${M_HOST_PRIVATE}/shared-experience/invitations`, HOST, { userId: ANA });
    assert.deepEqual([invited.status, invited.body.error], [404, "feature_disabled"]);
    assert.equal(await statusOf(ANA, M_HOST_PRIVATE), null);
    // join an EXISTING experience: accepted while on, then the switch goes off.
    await db.exec("UPDATE public.feature_flags SET enabled = true WHERE flag = 'memory_shared_experiences_enabled'");
    await call("POST", `/shared-experience-invitations/${a.body.invitationId}/accept`, ANA, {});
    await flagOff();
    const join = await call("POST", `/shared-experience-invitations/${b.body.invitationId}/accept`, BAO, {});
    assert.deepEqual([join.status, join.body.error], [404, "feature_disabled"]);
    assert.equal(await statusOf(BAO), "pending");
    for (const path of [`/memories/${M_HOST}/shared-experience`, "/me/shared-experience-invitations"]) {
      const r = await call("GET", path, ANA);
      assert.deepEqual([r.status, r.body.error], [404, "feature_disabled"], path);
    }
  });

  it("H53 flag OFF, in the SQL itself: respond declines but never accepts; leave and end run; invite refuses", async () => {
    const a = await invite(HOST, M_HOST, ANA);
    const b = await invite(HOST, M_HOST, BAO);
    const exp = (await respond(a.invitation_id, ANA, true, M_ANA)).experience_id;
    const p = await invite(HOST, M_HOST_PRIVATE, ANA);
    await flagOff();
    assert.equal((await respond(b.invitation_id, BAO, true)).outcome, "disabled", "joining is a way in");
    assert.equal((await respond(b.invitation_id, ANA, false)).outcome, "not_found", "only the invitee answers");
    assert.equal((await respond(b.invitation_id, BAO, false)).outcome, "declined");
    assert.equal((await invite(HOST, M_HOST, STRANGER)).outcome, "disabled");
    assert.equal((await leave(exp, STRANGER)).outcome, "not_member");
    assert.equal((await leave(exp, ANA)).outcome, "left");
    assert.equal((await end(ANA, M_HOST_PRIVATE)).outcome, "not_found");
    assert.equal((await end(HOST, M_HOST_PRIVATE)).outcome, "ended");
    assert.equal(await statusOf(ANA, M_HOST_PRIVATE), null, "the pending question is erased with it");
    assert.ok(p.invitation_id);
  });
});
