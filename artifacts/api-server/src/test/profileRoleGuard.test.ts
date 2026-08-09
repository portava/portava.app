/**
 * Finding 17 — `profiles.role` must not be writable by its own subject.
 *
 * WHAT THIS PROVES
 * ----------------
 * These tests run against the REAL Supabase database with REAL user JWTs.
 * Nothing is stubbed. The `role` column is what every admin gate in this
 * codebase reads (40 files do `.from("profiles").select("role")` and compare
 * against 'admin'), so a user who can write it can grant themselves the
 * administrator bit.
 *
 * WHY THE ASSERTIONS READ GROUND TRUTH
 * ------------------------------------
 * Every escalation attempt asserts on the value of `role` READ BACK WITH THE
 * SERVICE ROLE afterwards — not merely on whether the HTTP call returned an
 * error. Those are different claims, and only the second one matters:
 *
 *   - PostgREST can return 200 having matched zero rows (RLS filtered them),
 *     which looks like success and changed nothing.
 *   - A call can return an error from a later stage having already written.
 *
 * Asserting "the request failed" would pass against a database that happily
 * granted the role. Asserting "role is still 'user'" cannot.
 *
 * THESE TESTS WERE RUN AGAINST THE UNPATCHED SCHEMA FIRST
 * -------------------------------------------------------
 * Before migration 2078 was applied, tests 2, 3 and 5 FAILED — the escalation
 * genuinely succeeded and `role` came back 'admin'. That is recorded here
 * because a security test that has never been observed failing is not evidence
 * of anything; see docs/migrations.md.
 *
 * Requirements:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EXPO_PUBLIC_SUPABASE_ANON_KEY
 * Skipped (not silently passed) when credentials are absent.
 *
 * Run: pnpm run test:profile-role-guard
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  "";

const CREDS = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

const PREFIX = "role_guard_test_";
const PASSWORD = "role-guard-test-password-123";

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

interface Actor {
  id: string;
  email: string;
  token: string;
  client: SupabaseClient;
}

/** Create an auth user + profile row, then sign in for a real user JWT. */
async function makeActor(tag: string): Promise<Actor> {
  const sc = admin();
  const email = `${PREFIX}${tag}@example.com`;

  const { data: created, error: cErr } = await sc.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (cErr || !created?.user) throw new Error(`create ${tag}: ${cErr?.message}`);
  const id = created.user.id;

  // No trigger on auth.users in this project (handle_new_user is dormant), so
  // the profile row is created explicitly, exactly as services/auth.ts does.
  const { error: pErr } = await sc.from("profiles").insert({
    id,
    handle: `${PREFIX}${tag}`,
    username: `${PREFIX}${tag}`,
    name: `Role Guard ${tag}`,
  });
  if (pErr) throw new Error(`profile ${tag}: ${pErr.message}`);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data: session, error: sErr } =
    await userClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !session?.session) throw new Error(`signin ${tag}: ${sErr?.message}`);

  return { id, email, token: session.session.access_token, client: userClient };
}

/** Read `role` with the service role — the ground truth, bypassing RLS. */
async function roleOf(id: string): Promise<string | null> {
  const { data, error } = await admin()
    .from("profiles")
    .select("role")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`roleOf: ${error.message}`);
  return (data as { role: string } | null)?.role ?? null;
}

/** Raw PostgREST call, bypassing supabase-js entirely. */
async function rest(
  path: string,
  init: { method: string; token: string; body?: unknown; prefer?: string },
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: init.method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${init.token}`,
      "Content-Type": "application/json",
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: await res.text() };
}

let alice: Actor;
let bob: Actor;

before(async () => {
  if (!CREDS) return;
  alice = await makeActor("alice");
  bob = await makeActor("bob");
});

after(async () => {
  if (!CREDS) return;
  const sc = admin();
  for (const a of [alice, bob]) {
    if (!a) continue;
    await sc.from("profiles").delete().eq("id", a.id);
    await sc.auth.admin.deleteUser(a.id);
  }
});

describe("Finding 17 — profiles.role is not self-writable", { skip: !CREDS }, () => {
  // ── 1. Table stakes: the table is not simply locked ───────────────────────
  it("1. a user CAN update their own permitted profile fields", async () => {
    const bio = `guard test ${Date.now()}`;
    const { error } = await alice.client
      .from("profiles")
      .update({ bio, current_city: "Lisbon" })
      .eq("id", alice.id);
    assert.equal(error, null, `permitted update was rejected: ${error?.message}`);

    const { data } = await admin()
      .from("profiles")
      .select("bio, current_city")
      .eq("id", alice.id)
      .single();
    assert.equal((data as { bio: string }).bio, bio, "bio did not persist");
    assert.equal(
      (data as { current_city: string }).current_city,
      "Lisbon",
      "current_city did not persist",
    );
  });

  // ── 2. The finding itself ─────────────────────────────────────────────────
  it("2. a user CANNOT change their own role", async () => {
    await alice.client.from("profiles").update({ role: "admin" }).eq("id", alice.id);
    assert.equal(
      await roleOf(alice.id),
      "user",
      "SELF-ESCALATION: alice granted herself admin",
    );
  });

  // ── 3. Lateral movement ───────────────────────────────────────────────────
  it("3. a user CANNOT change another user's role", async () => {
    await alice.client.from("profiles").update({ role: "admin" }).eq("id", bob.id);
    assert.equal(
      await roleOf(bob.id),
      "user",
      "LATERAL ESCALATION: alice changed bob's role",
    );
  });

  // ── 4. The legitimate path still works, and is explicit ───────────────────
  it("4. the authorised privileged path CAN change role", async () => {
    const { error } = await admin().rpc("admin_set_profile_role", {
      target_user_id: bob.id,
      new_role: "admin",
    });
    assert.equal(error, null, `privileged path failed: ${error?.message}`);
    assert.equal(await roleOf(bob.id), "admin", "privileged promotion did not apply");

    // …and can demote again, so the mechanism is not one-way.
    await admin().rpc("admin_set_profile_role", {
      target_user_id: bob.id,
      new_role: "user",
    });
    assert.equal(await roleOf(bob.id), "user", "privileged demotion did not apply");
  });

  // ── 5. The one that matters: every alternate write path ───────────────────
  describe("5. alternate write paths cannot bypass the guard", () => {
    it("5a. raw PostgREST PATCH (no supabase-js)", async () => {
      await rest(`profiles?id=eq.${alice.id}`, {
        method: "PATCH",
        token: alice.token,
        body: { role: "admin" },
        prefer: "return=representation",
      });
      assert.equal(await roleOf(alice.id), "user", "BYPASS via raw PostgREST PATCH");
    });

    it("5b. upsert (INSERT .. ON CONFLICT DO UPDATE) over an existing row", async () => {
      // The UPDATE branch of an upsert is a different code path from .update().
      await alice.client
        .from("profiles")
        .upsert(
          { id: alice.id, handle: `${PREFIX}alice`, name: "Role Guard alice", role: "admin" },
          { onConflict: "id" },
        );
      assert.equal(await roleOf(alice.id), "user", "BYPASS via upsert");
    });

    it("5c. raw PostgREST upsert with resolution=merge-duplicates", async () => {
      await rest("profiles", {
        method: "POST",
        token: alice.token,
        body: {
          id: alice.id,
          handle: `${PREFIX}alice`,
          name: "Role Guard alice",
          role: "admin",
        },
        prefer: "resolution=merge-duplicates,return=representation",
      });
      assert.equal(await roleOf(alice.id), "user", "BYPASS via PostgREST upsert");
    });

    it("5d. self-INSERT of a fresh profile row carrying role=admin", async () => {
      // profiles_insert permits WITH CHECK (id = auth.uid()), so a user whose
      // profile does not yet exist gets one free INSERT. If role were writable
      // there, the very first write would be a free promotion.
      const sc = admin();
      const { data: created } = await sc.auth.admin.createUser({
        email: `${PREFIX}fresh@example.com`,
        password: PASSWORD,
        email_confirm: true,
      });
      const freshId = created!.user!.id;
      try {
        const fresh = createClient(SUPABASE_URL, ANON_KEY, {
          auth: { persistSession: false },
        });
        await fresh.auth.signInWithPassword({
          email: `${PREFIX}fresh@example.com`,
          password: PASSWORD,
        });
        await fresh.from("profiles").insert({
          id: freshId,
          handle: `${PREFIX}fresh`,
          username: `${PREFIX}fresh`,
          name: "Role Guard fresh",
          role: "admin",
        });
        const got = await roleOf(freshId);
        assert.ok(
          got === null || got === "user",
          `BYPASS via self-INSERT: role came back ${got}`,
        );
      } finally {
        await sc.from("profiles").delete().eq("id", freshId);
        await sc.auth.admin.deleteUser(freshId);
      }
    });

    it("5e. the privileged RPC is not callable by an ordinary user", async () => {
      const { error } = await alice.client.rpc("admin_set_profile_role", {
        target_user_id: alice.id,
        new_role: "admin",
      });
      assert.notEqual(error, null, "admin_set_profile_role was callable by a user");
      assert.equal(await roleOf(alice.id), "user", "BYPASS via privileged RPC");
    });

    it("5f. no server request path writes profiles.role (mass-assignment guard)", () => {
      // The DB is the barrier, but a route that forwards a client-supplied
      // `role` would still be a bug worth catching at source. Every profile
      // write on a request path allowlists its fields explicitly; assert that.
      //
      // SCOPE, stated rather than implied: only directories reachable from an
      // HTTP request are scanned. `src/scripts/` is excluded — those are
      // one-off operator tools run by hand with the service-role key, never
      // by a client. seed-demo-buddies.ts legitimately writes role:"user"
      // (the column default) while seeding fixtures, and flagging it would
      // train the next person to ignore this test. A scripts/ file writing a
      // PRIVILEGED role is still caught by the database trigger, which does
      // not care where the write came from.
      const here = dirname(fileURLToPath(import.meta.url));
      const srcRoot = resolve(here, "..");
      const REQUEST_PATH_DIRS = ["routes", "services", "lib", "compass", "middleware"];
      const offenders: string[] = [];
      let filesScanned = 0;

      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === "__tests__") continue;
            walk(p);
            continue;
          }
          if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
          filesScanned++;
          const src = readFileSync(p, "utf8");
          // A write to profiles whose payload mentions `role:` as a key.
          const re =
            /\.from\(\s*["'`]profiles["'`]\s*\)[\s\S]{0,200}?\.(?:update|upsert|insert)\(\s*\{[^}]*\brole\s*:/;
          if (re.test(src)) offenders.push(p.slice(srcRoot.length + 1));
        }
      };
      for (const d of REQUEST_PATH_DIRS) {
        try {
          walk(join(srcRoot, d));
        } catch {
          // Directory absent in this checkout — skip.
        }
      }

      // Guard the guard: if the walk silently scanned nothing, the assertion
      // below would pass vacuously. This repo has been bitten by exactly that.
      assert.ok(
        filesScanned > 50,
        `scan covered only ${filesScanned} files — the walk is broken, not the code clean`,
      );
      assert.deepEqual(
        offenders,
        [],
        `request path(s) write profiles.role directly: ${offenders.join(", ")}`,
      );
    });
  });
});
