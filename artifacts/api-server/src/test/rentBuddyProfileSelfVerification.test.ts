/**
 * rentBuddyProfileSelfVerification.test.ts — the buddy self-verification boundary.
 *
 * RED before migration 2145, GREEN after. Verified in both states against
 * portava-ci: pre-2145 a buddy self-set verified/id_verified/status/admin_status/
 * verification_status (1 row, all landed); post-2145 each fails with 42501.
 *
 * ── WHAT IS BEING GUARDED, AND WHY IT MATTERS MORE THAN THE GUIDE TABLE ──────
 * Rent-a-Buddy is an ENABLED production feature. verification_status and
 * id_verified are exactly what the high-risk (arrival/nightlife) booking gate
 * reads, and status='active' + admin_status='active' is self-approval as a
 * bookable buddy — bypassing the admin + 10-item safety-training approval. A
 * direct PostgREST write with the public anon key never touches the route
 * handlers where those gates live.
 *
 * All legitimate server writes to this table use the service-role client, so
 * 2145 grants authenticated column-UPDATE only on profile-content / pricing /
 * scheduling fields and revokes everything else. This suite proves the boundary.
 *
 * ── THE TRAP AVOIDED ────────────────────────────────────────────────────────
 * PostgREST reports an UPDATE that matches no row as success-with-zero-rows, so
 * every denial here asserts BOTH a 42501 permission error AND the unchanged
 * value read back through the service client. Test 0 is a negative control.
 *
 * Live-DB suite: kept out of the curated `npm test` list (which pins a dead
 * SUPABASE_URL) and run by the live-DB CI job.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyProfileSelfVerification.test.ts
 */

import "../lib/ciSupabaseGuard.mjs";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { purgeFixtureUsers, fixtureEmail, fixtureLabel } from "./liveFixtureUsers.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

if (!CREDS_AVAILABLE) {
  console.warn(
    "\n[rentBuddyProfileSelfVerification] SKIPPING — no live credentials.\n" +
      "  Database-boundary suite; without a real database it proves nothing.\n",
  );
}

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
}
function userClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const PREFIX = "rbp_verify_test_";
const PASSWORD = "test-password-123";
const TABLE = "rent_buddy_profiles";

let buddyId = "";
let buddyToken = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: created, error: cErr } = await sc.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (cErr || !created?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = created.user.id;
  const { error: pErr } = await sc.from("profiles").upsert(
    { id, handle: fixtureLabel(`${PREFIX}${tag}`), username: fixtureLabel(`${PREFIX}${tag}`), name: `rbp ${tag}` },
    { onConflict: "id" },
  );
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: session, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !session?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: session.session.access_token };
}

async function readBuddy(userId: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("user_id", userId).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}buddy@example.com`)]);
  ({ id: buddyId, token: buddyToken } = await makeUser("buddy"));

  const sc = adminClient();
  // A pending, unverified applicant buddy — created via service role as the app does.
  // city is NOT NULL. Every derived column left at its default.
  const { error } = await sc.from(TABLE).upsert(
    {
      user_id: buddyId, city: "Cebu", bio: "before", hourly_rate_usd: 10,
      verified: false, id_verified: false, phone_verified: false, age_verified: false,
      status: "pending", admin_status: "pending", verification_status: "unverified",
      nightlife_admin_approved: false, arrival_approved: false, training_completed: false,
      buddy_level: "new", featured: false,
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`fixture: could not seed buddy row: ${error.message}`);

  const seeded = await readBuddy(buddyId);
  assert.ok(seeded, "fixture: the buddy row must exist or every assertion below is vacuous");
  assert.equal(seeded.verified, false, "fixture: buddy must start unverified");
  assert.equal(seeded.status, "pending", "fixture: buddy must start pending");
});

after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  if (buddyId) {
    await sc.from(TABLE).delete().eq("user_id", buddyId);
    await sc.from("profiles").delete().eq("id", buddyId);
    await sc.auth.admin.deleteUser(buddyId);
  }
});

function assertPermissionDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success — the boundary is open`);
  const code = String(error.code ?? "");
  const msg = String(error.message ?? "").toLowerCase();
  assert.ok(
    code === "42501" || msg.includes("permission denied"),
    `${what}: expected 42501 / permission denied, got code=${code} message=${error.message}`,
  );
}

// ── 0. Negative control ───────────────────────────────────────────────────────

describe("0. control: the fixture is real and the owner CAN edit content", { skip: !CREDS_AVAILABLE }, () => {
  it("owner edits bio — proves the suite is not passing vacuously", async () => {
    const { error } = await userClient(buddyToken).from(TABLE).update({ bio: "control write" }).eq("user_id", buddyId);
    assert.ifError(error);
    assert.equal((await readBuddy(buddyId))?.bio, "control write");
  });
});

// ── 1. Self-verification / self-approval is closed ────────────────────────────

describe("1. a buddy cannot self-verify or self-approve", { skip: !CREDS_AVAILABLE }, () => {
  // The five the security requirement names explicitly, plus approval/rank fields.
  for (const [col, val] of [
    ["verified", true],
    ["id_verified", true],
    ["phone_verified", true],
    ["age_verified", true],
    ["status", "active"],
    ["admin_status", "active"],
    ["verification_status", "verified"],
    ["nightlife_admin_approved", true],
    ["arrival_approved", true],
    ["training_completed", true],
    ["buddy_level", "city_trusted"],
    ["featured", true],
  ] as const) {
    it(`refuses to write ${col}`, async () => {
      const before = await readBuddy(buddyId);
      const { error } = await userClient(buddyToken).from(TABLE).update({ [col]: val }).eq("user_id", buddyId);
      assertPermissionDenied(error, `self-write of ${col}`);
      assert.deepEqual((await readBuddy(buddyId))?.[col], before?.[col], `${col} must be unchanged`);
    });
  }

  it("refuses the whole self-verification in one statement", async () => {
    const { error } = await userClient(buddyToken).from(TABLE).update({
      verified: true, id_verified: true, status: "active",
      admin_status: "active", verification_status: "verified",
    }).eq("user_id", buddyId);
    assertPermissionDenied(error, "combined self-verification");
    const after = await readBuddy(buddyId);
    assert.equal(after?.verified, false);
    assert.equal(after?.status, "pending");
    assert.equal(after?.verification_status, "unverified");
  });
});

// ── 2. The booking-eligibility path cannot be reached by client self-verification ──

describe("2. the high-risk booking gate's inputs cannot be forged", { skip: !CREDS_AVAILABLE }, () => {
  it("verification_status stays 'unverified' after a client attempt", async () => {
    // The arrival/nightlife gate accepts verification_status === 'verified'.
    // If a buddy could set it, they would clear the gate with no real check.
    await userClient(buddyToken).from(TABLE).update({ verification_status: "verified" }).eq("user_id", buddyId);
    assert.equal((await readBuddy(buddyId))?.verification_status, "unverified",
      "a buddy must not be able to make themselves gate-eligible");
  });

  it("id_verified stays false after a client attempt", async () => {
    await userClient(buddyToken).from(TABLE).update({ id_verified: true }).eq("user_id", buddyId);
    assert.equal((await readBuddy(buddyId))?.id_verified, false);
  });

  it("status stays 'pending' — the buddy is not self-bookable", async () => {
    await userClient(buddyToken).from(TABLE).update({ status: "active" }).eq("user_id", buddyId);
    assert.equal((await readBuddy(buddyId))?.status, "pending");
  });
});

// ── 3. Legitimate profile editing still works ─────────────────────────────────

describe("3. legitimate buddy profile edits still work", { skip: !CREDS_AVAILABLE }, () => {
  it("owner can edit content / pricing / scheduling fields", async () => {
    const { error } = await userClient(buddyToken).from(TABLE).update({
      bio: "I run food walks in Cebu",
      hourly_rate_usd: 45,
      vibe_tags: ["chill", "foodie"],
      available_now: true,
      max_group_size: 6,
      languages: ["en", "ceb"],
    }).eq("user_id", buddyId);
    assert.ifError(error);
    const after = await readBuddy(buddyId);
    assert.equal(after?.bio, "I run food walks in Cebu");
    assert.equal(Number(after?.hourly_rate_usd), 45);
    assert.deepEqual(after?.vibe_tags, ["chill", "foodie"]);
    assert.equal(after?.available_now, true);
  });

  it("a mixed update (content + authority) is refused ATOMICALLY", async () => {
    // PostgREST/Postgres reject the whole statement if it touches a
    // non-granted column, so a buddy cannot smuggle status='active' alongside
    // a legitimate bio change.
    const before = await readBuddy(buddyId);
    const { error } = await userClient(buddyToken).from(TABLE)
      .update({ bio: "smuggle", status: "active" }).eq("user_id", buddyId);
    assertPermissionDenied(error, "content+authority smuggle");
    const after = await readBuddy(buddyId);
    assert.equal(after?.status, "pending");
    assert.equal(after?.bio, before?.bio, "the content change must not have applied either");
  });
});

// ── 4. Read paths + service-role preserved ────────────────────────────────────

describe("4. reads and backend writes still work", { skip: !CREDS_AVAILABLE }, () => {
  it("anon can read the public buddy directory", async () => {
    const { error } = await anonClient().from(TABLE).select("id, city, display_name").limit(1);
    assert.ifError(error);
  });

  it("the service role can still verify + approve a buddy (the admin path)", async () => {
    const { error } = await adminClient().from(TABLE).update({
      verified: true, id_verified: true, status: "active",
      admin_status: "active", verification_status: "verified", training_completed: true,
    }).eq("user_id", buddyId);
    assert.ifError(error);
    const after = await readBuddy(buddyId);
    assert.equal(after?.verified, true);
    assert.equal(after?.status, "active");
    assert.equal(after?.verification_status, "verified");
  });
});
