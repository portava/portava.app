/**
 * meetupRlsLive.test.ts — the meetup access matrix, measured through PostgREST.
 *
 * RED before migrations 2460 + 2461 are applied to the target database, GREEN
 * after. Before them every non-service read and write of meetups,
 * meetup_invites and meetup_time_options raises 42P17 (policy cycle, see
 * 2461); the first case here fails on exactly that, by design.
 *
 * WHAT IT PROVES (per viewer class, against one 'invitees'-visibility meetup)
 *   creator            reads the meetup, every invite row, the time option
 *   invitee (going)    reads the meetup, OWN invite row only, the time option
 *   invitee (pending)  the same — a pending invitee must see the meetup to answer
 *   outsider           reads nothing; cannot INSERT themselves an invite (2460)
 *   anon               reads nothing
 *   no viewer          hits the 42P17 error path
 * and the write half of 2460: an invitee can answer and remove their own row
 * but not re-point it; the creator can still invite.
 *
 * Trip- and circle-visibility branches are not exercised here (they need a
 * trips / circle_memberships fixture); they were rehearsed on portava-ci inside
 * a rolled-back transaction on 2026-09-07 (crew+circle viewer: 2 meetups, 0
 * invites, 0 options — see the migration report).
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB job.
 * Run: node --import tsx/esm --env-file-if-exists=.env --test src/test/meetupRlsLive.test.ts
 */
import "../lib/ciSupabaseGuard.mjs";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { purgeFixtureUsers, purgeFixtureRowsDetailed, fixtureEmail, fixtureLabel } from "./liveFixtureUsers.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
if (!CREDS_AVAILABLE) console.warn("\n[meetupRlsLive] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "meetup_rls_test_";
const PASSWORD = "test-password-123";
const TITLE_BASES = [`${PREFIX}m1`, `${PREFIX}m2`];
const T_M1 = fixtureLabel(`${PREFIX}m1`);
const T_M2 = fixtureLabel(`${PREFIX}m2`);
const USER_TAGS = ["creator", "going", "pending", "outsider"] as const;
type Tag = (typeof USER_TAGS)[number];

const users: Record<Tag, { id: string; token: string }> = {} as any;
let M1 = "", M2 = "", OPT = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: fixtureLabel(`${PREFIX}${tag}`), username: fixtureLabel(`${PREFIX}${tag}`), name: `mrls ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  await purgeFixtureUsers(sc, USER_TAGS.map((t) => fixtureEmail(`${PREFIX}${t}@example.com`)));
  for (const t of USER_TAGS) users[t] = await makeUser(t);
  const { data: m1, error: e1 } = await sc.from("meetups").insert({ creator_id: users.creator.id, title: T_M1, visibility: "invitees", status: "active" }).select("id").single();
  if (e1) throw new Error(`fixture meetup 1: ${e1.message}`);
  M1 = (m1 as any).id;
  const { data: m2, error: e2 } = await sc.from("meetups").insert({ creator_id: users.creator.id, title: T_M2, visibility: "invitees", status: "active" }).select("id").single();
  if (e2) throw new Error(`fixture meetup 2: ${e2.message}`);
  M2 = (m2 as any).id;
  const { error: iErr } = await sc.from("meetup_invites").insert([
    { meetup_id: M1, user_id: users.going.id, status: "going" },
    { meetup_id: M1, user_id: users.pending.id, status: "pending" },
  ]);
  if (iErr) throw new Error(`fixture invites: ${iErr.message}`);
  const { data: opt, error: oErr } = await sc.from("meetup_time_options").insert({ meetup_id: M1, proposed_date: "2026-10-01", time_block: "evening" }).select("id").single();
  if (oErr) throw new Error(`fixture option: ${oErr.message}`);
  OPT = (opt as any).id;
});

after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  for (const id of [M1, M2]) if (id) await sc.from("meetups").delete().eq("id", id); // invites + options cascade
  await purgeFixtureRowsDetailed(sc, "meetups", "title", TITLE_BASES);
  await purgeFixtureUsers(sc, USER_TAGS.map((t) => fixtureEmail(`${PREFIX}${t}@example.com`)));
});

async function read(client: SupabaseClient, table: string, col: string, ids: string[]) {
  const { data, error } = await client.from(table).select("id").in(col, ids);
  return { rows: data ?? [], error };
}

async function matrix(client: SupabaseClient) {
  const m = await read(client, "meetups", "id", [M1, M2]);
  const i = await read(client, "meetup_invites", "meetup_id", [M1, M2]);
  const o = await read(client, "meetup_time_options", "meetup_id", [M1, M2]);
  for (const [what, r] of [["meetups", m], ["meetup_invites", i], ["meetup_time_options", o]] as const) {
    assert.equal(r.error, null, `${what}: read raised ${r.error?.code} ${r.error?.message} — the 42P17 cycle is still in place (apply 2460 then 2461)`);
  }
  return { meetups: m.rows.length, invites: i.rows.length, options: o.rows.length };
}

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected an RLS refusal, got success — the boundary is open`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("row-level security"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("meetup RLS access matrix (2460 + 2461)", { skip: !CREDS_AVAILABLE }, () => {
  it("no viewer hits the 42P17 error path", async () => {
    for (const t of USER_TAGS) await matrix(userClient(users[t].token));
    await matrix(anonClient());
  });

  it("creator: both meetups, every invite row, the time option", async () => {
    assert.deepEqual(await matrix(userClient(users.creator.token)), { meetups: 2, invites: 2, options: 1 });
  });

  it("accepted invitee (going): the meetup, own row only, the time option", async () => {
    assert.deepEqual(await matrix(userClient(users.going.token)), { meetups: 1, invites: 1, options: 1 });
  });

  it("pending invitee: the same — a pending invitee must see the meetup to answer it", async () => {
    assert.deepEqual(await matrix(userClient(users.pending.token)), { meetups: 1, invites: 1, options: 1 });
  });

  it("outsider: nothing", async () => {
    assert.deepEqual(await matrix(userClient(users.outsider.token)), { meetups: 0, invites: 0, options: 0 });
  });

  it("anon: nothing", async () => {
    assert.deepEqual(await matrix(anonClient()), { meetups: 0, invites: 0, options: 0 });
  });

  it("outsider cannot invite themselves (2460), so cannot read their way in", async () => {
    const { error } = await userClient(users.outsider.token).from("meetup_invites").insert({ meetup_id: M1, user_id: users.outsider.id });
    assertDenied(error, "self-invite");
    const { data } = await adminClient().from("meetup_invites").select("id").eq("meetup_id", M1).eq("user_id", users.outsider.id);
    assert.equal((data ?? []).length, 0, "no self-minted row may exist");
    assert.deepEqual(await matrix(userClient(users.outsider.token)), { meetups: 0, invites: 0, options: 0 });
  });

  it("an invitee cannot re-point their invitation at another meetup", async () => {
    const { error } = await userClient(users.going.token).from("meetup_invites").update({ meetup_id: M2 }).eq("meetup_id", M1).eq("user_id", users.going.id);
    assertDenied(error, "re-point");
    const { data } = await adminClient().from("meetup_invites").select("meetup_id").eq("user_id", users.going.id);
    assert.deepEqual((data ?? []).map((r: any) => r.meetup_id), [M1]);
  });

  it("a pending invitee can answer their own invitation", async () => {
    const { data, error } = await userClient(users.pending.token).from("meetup_invites").update({ status: "maybe" }).eq("meetup_id", M1).eq("user_id", users.pending.id).select("status");
    assert.ifError(error);
    assert.deepEqual((data ?? []).map((r: any) => r.status), ["maybe"]);
  });

  it("the creator can still invite, and the new invitee can then read", async () => {
    const { error } = await userClient(users.creator.token).from("meetup_invites").insert({ meetup_id: M2, user_id: users.outsider.id });
    assert.ifError(error);
    const m = await read(userClient(users.outsider.token), "meetups", "id", [M2]);
    assert.equal(m.error, null);
    assert.equal(m.rows.length, 1, "an invited outsider reads the meetup they were invited to");
    const other = await read(userClient(users.outsider.token), "meetups", "id", [M1]);
    assert.equal(other.rows.length, 0, "...and still not the one they were not");
  });

  it("an invitee can remove their own row; nobody can remove another's", async () => {
    const { error: dErr } = await userClient(users.outsider.token).from("meetup_invites").delete().eq("meetup_id", M1).eq("user_id", users.pending.id);
    assert.ifError(dErr); // RLS filters, it does not raise, on DELETE
    const { data: still } = await adminClient().from("meetup_invites").select("id").eq("meetup_id", M1).eq("user_id", users.pending.id);
    assert.equal((still ?? []).length, 1, "another user's row must survive");
    const { error } = await userClient(users.going.token).from("meetup_invites").delete().eq("meetup_id", M1).eq("user_id", users.going.id);
    assert.ifError(error);
    const { data: gone } = await adminClient().from("meetup_invites").select("id").eq("meetup_id", M1).eq("user_id", users.going.id);
    assert.equal((gone ?? []).length, 0);
    assert.deepEqual(await matrix(userClient(users.going.token)), { meetups: 0, invites: 0, options: 0 }, "with the row gone, access is gone");
  });
});
