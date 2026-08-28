/**
 * messagingThreadIsolation.test.ts — messaging RLS, against the live CI database.
 *
 * RED before migration 2198, GREEN after. It pins the three defects that
 * migration repairs, each of which is invisible to a mocked Supabase client
 * because each lives entirely in a policy expression:
 *
 *   D1  42P17 infinite recursion. mtm_select on message_thread_members
 *       subqueried message_thread_members, so EVERY read of messages,
 *       message_threads and message_thread_members raised
 *         "infinite recursion detected in policy for relation
 *          message_thread_members".
 *       Messaging reads were dead in production.
 *
 *   D2  A tautological correlation. Both mtm_select and msg_select compared a
 *       column to ITSELF — `mtm.thread_id = mtm.thread_id` — because the source
 *       wrote `WHERE mtm.thread_id = thread_id` and the unqualified name bound
 *       to the subquery's own table instead of the outer row. The predicate
 *       therefore asked "is this user in ANY thread", not "in THIS thread".
 *
 *   D3  messages_hide_blocked_sender was PERMISSIVE. Permissive policies OR, so
 *       a policy written to SUBTRACT blocked senders instead GRANTED every
 *       message whose sender had not blocked the caller — i.e. all of them, to
 *       everyone, anon included.
 *
 * THE TEST THAT MATTERS MOST is "a member of a DIFFERENT thread". A suite whose
 * only negative case is a user with no threads at all passes happily under D2:
 * the tautology's failure mode is that thread membership becomes GLOBAL, so
 * only a user who is in some OTHER thread can distinguish "in this thread" from
 * "in any thread". Carol exists for that reason, and reintroducing the
 * tautology fails on her.
 *
 * D3 is the mirror image: it needs a user in NO thread (Dave), because a
 * permissive blocked-sender policy grants regardless of membership. Between
 * them Carol and Dave cover both leak shapes; neither one alone does.
 *
 * Live-DB suite: kept out of the curated npm test list (which pins
 * SUPABASE_URL=http://127.0.0.1:9), run by the live-DB job. Scored on OUTPUT by
 * .github/scripts/run-live-suite.sh — pass > 0 AND skipped == 0 — so a run
 * without credentials fails the job rather than passing vacuously.
 *
 * Run: node --import tsx/esm --env-file-if-exists=.env --test src/test/messagingThreadIsolation.test.ts
 */
// FIRST import, deliberately: refuses to let this process reach an unsanctioned
// database before the Supabase client library is even loaded.
import "../lib/ciSupabaseGuard.mjs";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { purgeFixtureUsers } from "./liveFixtureUsers.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
if (!CREDS_AVAILABLE) console.warn("\n[messagingThreadIsolation] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
}
function userClient(token: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

const PREFIX = "msg_isolation_test_";
const PASSWORD = "test-password-123";
const TAGS = ["alice", "bob", "carol", "dave"] as const;
const EMAILS = TAGS.map((t) => `${PREFIX}${t}@example.com`);

type Fixture = { id: string; token: string };
const users: Record<string, Fixture> = {};

/** T1 = {alice, bob}. T2 = {carol}. Dave belongs to nothing. */
let threadOne = "";
let threadTwo = "";
let msgAliceInT1 = "";
let msgBobInT1 = "";
let msgCarolInT2 = "";

async function makeUser(tag: string): Promise<Fixture> {
  const sc = adminClient();
  const email = `${PREFIX}${tag}@example.com`;
  const { data: c, error: cErr } = await sc.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert(
    { id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `mi ${tag}` },
    { onConflict: "id" },
  );
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}

/** Remove any fixture rows a previous run left behind (self-healing setup). */
async function purgeRows(sc: SupabaseClient, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await sc.from("blocks").delete().in("blocker_id", userIds);
  await sc.from("blocks").delete().in("blocked_id", userIds);
  await sc.from("messages").delete().in("sender_id", userIds);
  await sc.from("message_thread_members").delete().in("user_id", userIds);
}

/**
 * Threads carry the fixture prefix as their title so a run that dies before its
 * teardown can be cleaned up by the NEXT run. Deleting a thread cascades to its
 * members and messages (both thread_id FKs are ON DELETE CASCADE), so this one
 * delete is the whole cleanup — and without it, orphaned threads would pile up
 * in the shared CI project with no handle to find them by.
 */
async function purgeFixtureThreads(sc: SupabaseClient): Promise<void> {
  await sc.from("message_threads").delete().eq("title", PREFIX);
}

async function newThread(sc: SupabaseClient): Promise<string> {
  const { data, error } = await sc
    .from("message_threads")
    .insert({ thread_type: "direct", status: "active", title: PREFIX })
    .select("id")
    .single();
  if (error) throw new Error(`thread: ${error.message}`);
  return (data as any).id as string;
}

async function addMember(sc: SupabaseClient, threadId: string, userId: string): Promise<void> {
  const { error } = await sc.from("message_thread_members").insert({ thread_id: threadId, user_id: userId });
  if (error) throw new Error(`member: ${error.message}`);
}

async function postMessage(sc: SupabaseClient, threadId: string, senderId: string, body: string): Promise<string> {
  const { data, error } = await sc
    .from("messages")
    .insert({ thread_id: threadId, sender_id: senderId, body })
    .select("id")
    .single();
  if (error) throw new Error(`message: ${error.message}`);
  return (data as any).id as string;
}

/** Message ids visible to a client, restricted to this suite's own fixtures. */
async function visibleMessageIds(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client
    .from("messages")
    .select("id")
    .in("id", [msgAliceInT1, msgBobInT1, msgCarolInT2].filter(Boolean));
  // A read that ERRORS is never a pass here: 42P17 (D1) is exactly an error, and
  // silently treating it as "saw nothing" is how this suite would go green on a
  // completely broken read path.
  if (error) throw new Error(`read messages: ${error.code ?? "?"} ${error.message}`);
  return (data ?? []).map((r: any) => r.id).sort();
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  await purgeFixtureThreads(sc);
  await purgeFixtureUsers(sc, EMAILS);
  for (const tag of TAGS) users[tag] = await makeUser(tag);
  await purgeRows(sc, TAGS.map((t) => users[t].id));

  threadOne = await newThread(sc);
  threadTwo = await newThread(sc);
  await addMember(sc, threadOne, users.alice.id);
  await addMember(sc, threadOne, users.bob.id);
  await addMember(sc, threadTwo, users.carol.id);
  // Dave is deliberately a member of nothing.

  msgAliceInT1 = await postMessage(sc, threadOne, users.alice.id, "alice in thread one");
  msgBobInT1 = await postMessage(sc, threadOne, users.bob.id, "bob in thread one");
  msgCarolInT2 = await postMessage(sc, threadTwo, users.carol.id, "carol in thread two");
});

after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  await purgeRows(sc, TAGS.map((t) => users[t]?.id).filter(Boolean) as string[]);
  await purgeFixtureThreads(sc);
  await purgeFixtureUsers(sc, EMAILS);
});

describe("messaging RLS — thread isolation", { skip: !CREDS_AVAILABLE }, () => {
  // ── D1: the read path works at all ────────────────────────────────────────
  it("a member can read messages without 42P17 (the recursion is gone)", async () => {
    const { error } = await userClient(users.alice.token).from("messages").select("id").limit(1);
    if (error) {
      assert.notEqual(
        error.code, "42P17",
        "infinite recursion in the message_thread_members policy — a policy on that table is querying that table",
      );
      assert.fail(`reading messages failed: ${error.code ?? "?"} ${error.message}`);
    }
  });

  it("reading message_thread_members and message_threads also succeeds", async () => {
    const c = userClient(users.alice.token);
    for (const table of ["message_thread_members", "message_threads"]) {
      const { error } = await c.from(table).select("*").limit(1);
      if (error) assert.fail(`reading ${table} failed: ${error.code ?? "?"} ${error.message}`);
    }
  });

  // ── (a) a member reads only their own threads' messages ───────────────────
  it("a member sees their own thread's messages and no others", async () => {
    const seen = await visibleMessageIds(userClient(users.alice.token));
    assert.deepEqual(seen, [msgAliceInT1, msgBobInT1].sort(), "alice must see exactly thread one");
    assert.ok(!seen.includes(msgCarolInT2), "alice must NOT see thread two");
  });

  it("a member of a DIFFERENT thread sees only that thread — the tautology guard", async () => {
    // THE load-bearing case. `mtm.thread_id = mtm.thread_id` is always true, so
    // membership of ANY thread satisfied it. Carol is in thread two; under the
    // tautology she reads thread one as well.
    const seen = await visibleMessageIds(userClient(users.carol.token));
    assert.deepEqual(
      seen, [msgCarolInT2],
      "carol is a member of thread TWO only; seeing thread one means the correlation compares a column to itself again",
    );
  });

  // ── (b) a non-member reads none ───────────────────────────────────────────
  it("a user who belongs to no thread reads no messages", async () => {
    // Also the D3 guard: a PERMISSIVE messages_hide_blocked_sender grants every
    // message whose sender has not blocked the caller, regardless of membership,
    // so dave would see all three.
    assert.deepEqual(
      await visibleMessageIds(userClient(users.dave.token)), [],
      "a user in no thread must read nothing; if they read everything, messages_hide_blocked_sender is permissive again",
    );
  });

  it("anon reads no messages", async () => {
    const { data, error } = await anonClient()
      .from("messages").select("id").in("id", [msgAliceInT1, msgBobInT1, msgCarolInT2]);
    if (error) {
      assert.notEqual(error.code, "42P17", "anon read raised infinite recursion");
      return; // a permission error is an acceptable denial
    }
    assert.deepEqual(data ?? [], [], "anon must not read any message");
  });

  // ── membership rows ───────────────────────────────────────────────────────
  it("a member still sees co-members of their own thread (the roster read the app needs)", async () => {
    const { data, error } = await userClient(users.alice.token)
      .from("message_thread_members").select("user_id").eq("thread_id", threadOne);
    assert.ifError(error);
    const ids = (data ?? []).map((r: any) => r.user_id).sort();
    assert.deepEqual(
      ids, [users.alice.id, users.bob.id].sort(),
      "alice must see both members of thread one — travel-buddy-standalone reads the roster and the other party's last_read_at directly over PostgREST",
    );
  });

  it("a member of a different thread sees no membership rows of a thread they are not in", async () => {
    const { data, error } = await userClient(users.carol.token)
      .from("message_thread_members").select("user_id").eq("thread_id", threadOne);
    assert.ifError(error);
    assert.deepEqual((data ?? []), [], "carol must not see thread one's roster");
  });

  it("a user who belongs to no thread sees no membership rows", async () => {
    const { data, error } = await userClient(users.dave.token)
      .from("message_thread_members").select("user_id").in("thread_id", [threadOne, threadTwo]);
    assert.ifError(error);
    assert.deepEqual((data ?? []), [], "dave must see no membership rows at all");
  });

  // ── threads ───────────────────────────────────────────────────────────────
  it("a member sees only the threads they belong to", async () => {
    const { data, error } = await userClient(users.alice.token)
      .from("message_threads").select("id").in("id", [threadOne, threadTwo]);
    assert.ifError(error);
    assert.deepEqual((data ?? []).map((r: any) => r.id), [threadOne], "alice must see thread one only");
  });

  // ── D3, from the other side: the block must still SUBTRACT ────────────────
  it("a blocked sender's messages stay hidden inside a shared thread", async () => {
    // Converting messages_hide_blocked_sender to RESTRICTIVE must preserve what
    // 0015_blocks.sql was trying to do, not just stop it granting. Alice and bob
    // share thread one; once bob blocks alice, alice keeps her own message and
    // loses his.
    const sc = adminClient();
    const { error: bErr } = await sc.from("blocks").insert({ blocker_id: users.bob.id, blocked_id: users.alice.id });
    assert.ifError(bErr);
    try {
      assert.deepEqual(
        await visibleMessageIds(userClient(users.alice.token)), [msgAliceInT1],
        "alice must still see her own message but not the blocked sender's",
      );
    } finally {
      await sc.from("blocks").delete().eq("blocker_id", users.bob.id).eq("blocked_id", users.alice.id);
    }
  });

  // ── the legitimate mechanism ──────────────────────────────────────────────
  it("the service role still reads every thread (the API's own path)", async () => {
    const seen = await visibleMessageIds(adminClient());
    assert.deepEqual(
      seen, [msgAliceInT1, msgBobInT1, msgCarolInT2].sort(),
      "service_role bypasses RLS; the API server depends on it",
    );
  });
});
