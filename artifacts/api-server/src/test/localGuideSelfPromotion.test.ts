/**
 * localGuideSelfPromotion.test.ts — the guide self-promotion write boundary.
 *
 * RED before migration 2144, GREEN after. Verified in both states against
 * portava-ci: pre-2144 the self-promotion UPDATE affected 1 row and the values
 * landed (guide_level=5, accuracy_score=1, status=active, helpful_votes=9999,
 * verified_at set); post-2144 it fails with 42501.
 *
 * ── WHAT IS BEING GUARDED ───────────────────────────────────────────────────
 * local_guide_profiles.guide_level, accuracy_score, helpful_votes,
 * contribution_count, status and verified_at are DERIVED or ADJUDICATED
 * server-side. recomputeGuideAccuracy computes accuracy from the real fate of a
 * guide's submissions precisely so the number cannot be asserted; setGuideStatus
 * is an admin path. If a client can PATCH those columns, both are decorative.
 *
 * ── WHY THIS IS A LIVE-DB SUITE ─────────────────────────────────────────────
 * The boundary is enforced by Postgres column grants and an RLS WITH CHECK.
 * Neither exists in a mocked client, so a unit test would assert nothing. It is
 * therefore kept OUT of the curated `npm test` list (which pins
 * SUPABASE_URL=http://127.0.0.1:9) and run by the live-DB CI job instead.
 *
 * ── THE TRAP THIS SUITE AVOIDS ──────────────────────────────────────────────
 * PostgREST reports an UPDATE that matches no row as SUCCESS with zero rows. A
 * naive "assert the value did not change" therefore passes for the wrong reason
 * — including when the fixture was never created. So every denial assertion here
 * checks BOTH:
 *   (a) the operation reported a PERMISSION error (42501), not silence, and
 *   (b) the value is unchanged when read back through the service client.
 * And test 1 is a negative control proving the fixture is real and writable at
 * all, so the suite cannot go green by failing to set itself up.
 *
 * Run: node --import tsx/esm --test src/test/localGuideSelfPromotion.test.ts
 */

import "../lib/ciSupabaseGuard.mjs";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { purgeFixtureUsers, fixtureEmail } from "./liveFixtureUsers.js";

// ── Env ───────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  "";

const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

if (!CREDS_AVAILABLE) {
  console.warn(
    "\n[localGuideSelfPromotion] SKIPPING — no live credentials.\n" +
      "  This is a database-boundary suite; without a real database it cannot\n" +
      "  fail and proves nothing. A skip is not a pass.\n",
  );
}

// ── Clients ───────────────────────────────────────────────────────────────────

/** Service-role: bypasses RLS and column grants. Fixtures + authoritative reads. */
function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
}

/** The attacker's position: an ordinary signed-in app user (`authenticated`). */
function userClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PREFIX = "guide_promo_test_";
const PASSWORD = "test-password-123";

/** An approved guide, acting on their own row. */
let guideId = "";
let guideToken = "";
/** A second guide, target of the cross-user attempt. */
let otherId = "";
/** A signed-in user with NO guide profile, attempting to self-create one. */
let outsiderId = "";
let outsiderToken = "";

const TABLE = "local_guide_profiles";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: created, error: cErr } = await sc.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (cErr || !created?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = created.user.id;

  // handle_new_user() may already have made the profile; upsert so either way works.
  const { error: pErr } = await sc.from("profiles").upsert(
    { id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `guide promo ${tag}` },
    { onConflict: "id" },
  );
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);

  const { data: session, error: sErr } = await anonClient().auth.signInWithPassword({
    email, password: PASSWORD,
  });
  if (sErr || !session?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: session.session.access_token };
}

/** Authoritative read — service client, so RLS cannot hide a successful write. */
async function readGuide(userId: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("user_id", userId).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;

  await purgeFixtureUsers(adminClient(), [
    fixtureEmail(`${PREFIX}guide@example.com`),
    fixtureEmail(`${PREFIX}other@example.com`),
    fixtureEmail(`${PREFIX}outsider@example.com`),
  ]);

  ({ id: guideId, token: guideToken } = await makeUser("guide"));
  ({ id: otherId } = await makeUser("other"));
  ({ id: outsiderId, token: outsiderToken } = await makeUser("outsider"));

  const sc = adminClient();
  // Two guide rows, created through the service role exactly as applyForGuide does.
  const { error } = await sc.from(TABLE).upsert(
    [
      // Identical key sets on both rows. In a batch upsert PostgREST builds one
      // column list from the union of keys and sends explicit NULL for any key a
      // row omits — so a column with a default (helpful_votes) still receives
      // NULL and trips its NOT NULL constraint. Every row lists every column.
      { user_id: guideId, guide_level: 0, accuracy_score: 0, helpful_votes: 0, contribution_count: 0, status: "applicant", bio: "before" },
      { user_id: otherId, guide_level: 3, accuracy_score: 0.5, helpful_votes: 0, contribution_count: 0, status: "active", bio: "theirs" },
    ],
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`fixture: could not seed guide rows: ${error.message}`);

  const seeded = await readGuide(guideId);
  assert.ok(seeded, "fixture: the guide row must exist or every assertion below is vacuous");
  assert.equal(Number(seeded.guide_level), 0, "fixture: guide must start at level 0");
});

after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  for (const id of [guideId, otherId, outsiderId]) {
    if (!id) continue;
    await sc.from(TABLE).delete().eq("user_id", id);
    await sc.from("profiles").delete().eq("id", id);
    await sc.auth.admin.deleteUser(id);
  }
});

/** A denial must be a PERMISSION error, not PostgREST's silent zero-rows. */
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

describe("0. control: the fixture is real and the owner CAN write their own row", { skip: !CREDS_AVAILABLE }, () => {
  it("the owner updates bio — proves the suite is not passing vacuously", async () => {
    const { error } = await userClient(guideToken).from(TABLE).update({ bio: "control write" }).eq("user_id", guideId);
    assert.ifError(error);
    assert.equal((await readGuide(guideId))?.bio, "control write");
  });
});

// ── 1. Self-promotion is closed ───────────────────────────────────────────────

describe("1. a guide cannot promote themselves", { skip: !CREDS_AVAILABLE }, () => {
  for (const [column, value] of [
    ["guide_level", 5],
    ["accuracy_score", 1],
    ["helpful_votes", 9999],
    ["contribution_count", 9999],
    ["verified_at", new Date().toISOString()],
  ] as const) {
    it(`refuses to write ${column}`, async () => {
      const before = await readGuide(guideId);
      const { error } = await userClient(guideToken)
        .from(TABLE).update({ [column]: value }).eq("user_id", guideId);

      assertPermissionDenied(error, `self-write of ${column}`);
      const after = await readGuide(guideId);
      assert.deepEqual(after?.[column], before?.[column], `${column} must be unchanged`);
    });
  }

  it("refuses self-ACTIVATION via status — which is also self-publication", async () => {
    // lgp_public_read exposes every row with status='active', so writing status
    // is both a privilege escalation and a publication decision.
    const { error } = await userClient(guideToken)
      .from(TABLE).update({ status: "active" }).eq("user_id", guideId);

    assertPermissionDenied(error, "self-activation");
    assert.equal((await readGuide(guideId))?.status, "applicant");
  });

  it("refuses to re-point the row at another user", async () => {
    // user_id was in the writable column set, and lgp_own_update had no
    // WITH CHECK — so the row could be handed to somebody else mid-update.
    const { error } = await userClient(guideToken)
      .from(TABLE).update({ user_id: otherId }).eq("user_id", guideId);

    assertPermissionDenied(error, "re-pointing user_id");
    assert.ok(await readGuide(guideId), "the guide's own row must still be theirs");
  });

  it("refuses the whole promotion in one statement", async () => {
    const { error } = await userClient(guideToken).from(TABLE).update({
      guide_level: 5, accuracy_score: 1, helpful_votes: 9999,
      status: "active", verified_at: new Date().toISOString(),
    }).eq("user_id", guideId);

    assertPermissionDenied(error, "combined self-promotion");
    const after = await readGuide(guideId);
    assert.equal(Number(after?.guide_level), 0);
    assert.equal(after?.status, "applicant");
  });
});

// ── 2. The INSERT vector is closed ────────────────────────────────────────────

describe("2. a user cannot self-create an already-promoted guide profile", { skip: !CREDS_AVAILABLE }, () => {
  it("refuses INSERT of an active level-5 profile", async () => {
    // lgp_insert verifies OWNERSHIP and says nothing about the values, so before
    // 2144 this was a second, independent self-promotion path that needed no
    // existing row at all.
    const { error } = await userClient(outsiderToken).from(TABLE).insert({
      user_id: outsiderId, guide_level: 5, accuracy_score: 1, status: "active", bio: "self-made",
    });

    assertPermissionDenied(error, "self-INSERT of a promoted profile");
    assert.equal(await readGuide(outsiderId), null, "no guide row may have been created");
  });

  it("refuses DELETE of their own guide row", async () => {
    const { error } = await userClient(guideToken).from(TABLE).delete().eq("user_id", guideId);
    assertPermissionDenied(error, "self-delete");
    assert.ok(await readGuide(guideId), "the row must survive");
  });
});

// ── 3. Cross-user is closed ───────────────────────────────────────────────────

describe("3. a guide cannot touch another guide's row", { skip: !CREDS_AVAILABLE }, () => {
  it("cannot edit another guide's bio", async () => {
    // Row scope is RLS's job, so this one legitimately surfaces as zero rows
    // rather than 42501 — bio IS a granted column. The proof is the value.
    await userClient(guideToken).from(TABLE).update({ bio: "hijacked" }).eq("user_id", otherId);
    assert.equal((await readGuide(otherId))?.bio, "theirs", "another guide's bio must be untouched");
  });

  it("cannot promote another guide", async () => {
    await userClient(guideToken).from(TABLE).update({ guide_level: 5 }).eq("user_id", otherId);
    assert.equal(Number((await readGuide(otherId))?.guide_level), 3);
  });
});

// ── 4. Legitimate operations are preserved ────────────────────────────────────

describe("4. legitimate guide operations still work", { skip: !CREDS_AVAILABLE }, () => {
  it("the owner can still edit bio and city_expertise", async () => {
    const { error } = await userClient(guideToken)
      .from(TABLE)
      .update({ bio: "I run food walks in Cebu", city_expertise: ["Cebu", "Manila"] })
      .eq("user_id", guideId);

    assert.ifError(error);
    const after = await readGuide(guideId);
    assert.equal(after?.bio, "I run food walks in Cebu");
    assert.deepEqual(after?.city_expertise, ["Cebu", "Manila"]);
  });

  it("the public guide directory is still readable by a signed-in non-owner", async () => {
    const { data, error } = await userClient(outsiderToken)
      .from(TABLE).select("user_id, guide_level, bio").eq("user_id", otherId);
    assert.ifError(error);
    assert.equal((data ?? []).length, 1, "an active guide must remain publicly visible");
  });

  it("the public guide directory is still readable ANONYMOUSLY", async () => {
    const { data, error } = await anonClient()
      .from(TABLE).select("user_id, guide_level").eq("user_id", otherId);
    assert.ifError(error);
    assert.equal((data ?? []).length, 1, "revoking anon writes must not revoke anon reads");
  });

  it("the service role can still write every derived column", async () => {
    // This is how every server path writes: recomputeGuideAccuracy,
    // recordContribution, setGuideStatus. If this breaks, the app breaks.
    const { error } = await adminClient().from(TABLE)
      .update({ guide_level: 2, accuracy_score: 0.75, helpful_votes: 4, status: "active" })
      .eq("user_id", guideId);
    assert.ifError(error);
    const after = await readGuide(guideId);
    assert.equal(Number(after?.guide_level), 2);
    assert.equal(Number(after?.accuracy_score), 0.75);
    assert.equal(after?.status, "active");
  });
});
