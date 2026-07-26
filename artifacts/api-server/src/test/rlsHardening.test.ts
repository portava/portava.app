/**
 * RLS Hardening tests — direct Supabase client reads as unauthorized users.
 *
 * These tests use the real Supabase instance (not a fake client) to verify
 * that Row-Level Security policies block unauthorized access at the database
 * layer, independent of the API server.
 *
 * Requirements:
 *   SUPABASE_URL             — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key (for inserting test fixtures)
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY — anon key (for testing unauthenticated reads)
 *
 * All tests are skipped when credentials are absent so CI still passes without
 * a live Supabase connection.
 *
 * Run: node --import tsx/esm --env-file-if-exists=.env --test src/test/rlsHardening.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ── Env-var checks ────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  "";

const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

// ── Clients ───────────────────────────────────────────────────────────────────

/** Service-role client: bypasses RLS — used for test-fixture setup only. */
function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/** Anon client: no auth — equivalent to an unauthenticated/public request. */
function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  });
}

// ── Test IDs (deterministic so cleanup is reliable) ───────────────────────────

const RLS_TEST_PREFIX = "rls_hardening_test_";

/** IDs that we'll insert and then clean up */
let testProfileIdPrivate: string;
let testProfileIdPublic: string;
let testEventIdPrivate: string;
let testTripIdPrivate: string;

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(async () => {
  if (!CREDS_AVAILABLE) return;

  const admin = adminClient();

  // ── Create two auth users for test profiles ──────────────────────────────
  const { data: userA, error: userAErr } =
    await admin.auth.admin.createUser({
      email: `${RLS_TEST_PREFIX}private@example.com`,
      password: "test-password-123",
      email_confirm: true,
    });
  if (userAErr) throw new Error(`Setup: create userA: ${userAErr.message}`);

  const { data: userB, error: userBErr } =
    await admin.auth.admin.createUser({
      email: `${RLS_TEST_PREFIX}public@example.com`,
      password: "test-password-123",
      email_confirm: true,
    });
  if (userBErr) throw new Error(`Setup: create userB: ${userBErr.message}`);

  testProfileIdPrivate = userA.user.id;
  testProfileIdPublic = userB.user.id;

  // ── Upsert profile rows (auto-created by trigger, but set is_private) ────
  const { error: pErr } = await admin.from("profiles").upsert([
    {
      id: testProfileIdPrivate,
      handle: `${RLS_TEST_PREFIX}private`,
      name: "RLS Test Private",
      is_private: true,
    },
    {
      id: testProfileIdPublic,
      handle: `${RLS_TEST_PREFIX}public`,
      name: "RLS Test Public",
      is_private: false,
    },
  ]);
  if (pErr) throw new Error(`Setup: upsert profiles: ${pErr.message}`);

  // ── Create a private event hosted by the private profile ─────────────────
  const { data: ev, error: evErr } = await admin
    .from("events")
    .insert({
      host_id: testProfileIdPrivate,
      title: `${RLS_TEST_PREFIX}private_event`,
      visibility: "invite_only",
      state: "open",
    })
    .select("id")
    .single();
  if (evErr) throw new Error(`Setup: create event: ${evErr.message}`);
  testEventIdPrivate = ev.id;

  // ── Create a private trip owned by the private profile ───────────────────
  const { data: tr, error: trErr } = await admin
    .from("trips")
    .insert({
      owner_id: testProfileIdPrivate,
      title: `${RLS_TEST_PREFIX}private_trip`,
      destination_city: "Testville",
      visibility: "private",
      status: "planning",
    })
    .select("id")
    .single();
  if (trErr) throw new Error(`Setup: create trip: ${trErr.message}`);
  testTripIdPrivate = tr.id;
});

after(async () => {
  if (!CREDS_AVAILABLE) return;

  const admin = adminClient();

  // Delete trips first (FK dependency)
  if (testTripIdPrivate) {
    await admin.from("trips").delete().eq("id", testTripIdPrivate);
  }
  if (testEventIdPrivate) {
    await admin.from("events").delete().eq("id", testEventIdPrivate);
  }
  // Delete auth users (cascades to profiles)
  if (testProfileIdPrivate) {
    await admin.auth.admin.deleteUser(testProfileIdPrivate);
  }
  if (testProfileIdPublic) {
    await admin.auth.admin.deleteUser(testProfileIdPublic);
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RLS hardening — unauthenticated (anon) reads", { skip: !CREDS_AVAILABLE }, () => {
  it("anon read of a private profile row returns empty", async () => {
    const { data, error } = await anonClient()
      .from("profiles")
      .select("id")
      .eq("id", testProfileIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "RLS should block anon access to private profile"
    );
  });

  it("anon read of a public profile row is allowed", async () => {
    const { data, error } = await anonClient()
      .from("profiles")
      .select("id")
      .eq("id", testProfileIdPublic);

    assert.ifError(error);
    assert.ok(
      data && data.length === 1,
      "Anon should see public profiles"
    );
  });

  it("anon read of a private (invite_only) event returns empty", async () => {
    const { data, error } = await anonClient()
      .from("events")
      .select("id")
      .eq("id", testEventIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "RLS should block anon access to private event"
    );
  });

  it("anon read of a private trip returns empty", async () => {
    const { data, error } = await anonClient()
      .from("trips")
      .select("id")
      .eq("id", testTripIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "RLS should block anon access to private trip"
    );
  });

  it("anon read of notifications table returns empty", async () => {
    const { data, error } = await anonClient()
      .from("notifications")
      .select("id")
      .limit(5);

    assert.ifError(error);
    assert.deepEqual(data, [], "Anon must not read any notifications rows");
  });

  it("anon read of trip_members returns empty", async () => {
    const { data, error } = await anonClient()
      .from("trip_members")
      .select("trip_id")
      .eq("trip_id", testTripIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "RLS should block anon access to trip_members of a private trip"
    );
  });

  it("anon read of event_attendees returns empty", async () => {
    const { data, error } = await anonClient()
      .from("event_attendees")
      .select("event_id")
      .eq("event_id", testEventIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "RLS should block anon access to event_attendees"
    );
  });

  it("anon read of user_follows returns empty", async () => {
    const { data, error } = await anonClient()
      .from("user_follows")
      .select("follower_id")
      .limit(5);

    assert.ifError(error);
    assert.deepEqual(data, [], "Anon must not read user_follows rows");
  });

  it("anon read of user_friendships returns empty", async () => {
    const { data, error } = await anonClient()
      .from("user_friendships")
      .select("user_a")
      .limit(5);

    assert.ifError(error);
    assert.deepEqual(data, [], "Anon must not read user_friendships rows");
  });
});

describe("RLS hardening — wrong-user (signed-in non-member) reads", { skip: !CREDS_AVAILABLE }, () => {
  /**
   * Sign in as the *public* test user (who has no relationship with the
   * private event / trip) and verify they cannot read those rows.
   */
  async function publicUserClient(): Promise<SupabaseClient> {
    const client = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false },
    });
    const { error } = await client.auth.signInWithPassword({
      email: `${RLS_TEST_PREFIX}public@example.com`,
      password: "test-password-123",
    });
    if (error) throw new Error(`Test sign-in failed: ${error.message}`);
    return client;
  }

  it("non-member authenticated user cannot read private event row", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("events")
      .select("id")
      .eq("id", testEventIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Non-member signed-in user should not see private event"
    );
  });

  it("non-member authenticated user cannot read private trip row", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("trips")
      .select("id")
      .eq("id", testTripIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Non-member signed-in user should not see private trip"
    );
  });

  it("non-member cannot read trip_members of a private trip", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("trip_members")
      .select("trip_id")
      .eq("trip_id", testTripIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Non-member should not read trip_members of a private trip"
    );
  });

  it("non-member cannot read event_attendees of a private event", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("event_attendees")
      .select("event_id")
      .eq("event_id", testEventIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Non-member should not read event_attendees of a private event"
    );
  });

  it("authenticated user cannot read another user's notifications", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("notifications")
      .select("id")
      .eq("user_id", testProfileIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Authenticated user must not read another user's notifications"
    );
  });

  it("private profile is hidden from non-friend signed-in user", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("profiles")
      .select("id")
      .eq("id", testProfileIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Private profile must be hidden from non-friend authenticated user"
    );
  });
});
