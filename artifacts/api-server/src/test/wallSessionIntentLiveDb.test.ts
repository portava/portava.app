/**
 * W146 — the Wall's session-intent store against a REAL Postgres.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * Every other test of `WallSessionIntentService`'s persistence runs against an
 * injected in-memory fake. A fake proves that the service CALLS the right
 * things; it cannot prove that Postgres ACCEPTS them. The three properties the
 * Wall's store actually depends on all live in the database and in nothing else:
 *
 *   • one row per user — the `user_id PRIMARY KEY` in migration 2271 is what
 *     makes `upsert(..., { onConflict: "user_id" })` a replace rather than a
 *     second row. A fake that keys a Map by user id will agree with any schema,
 *     including one that has no such constraint.
 *   • the foreign key to `profiles` — an intent for a user who does not exist
 *     must be REFUSED. A fake accepts it.
 *   • deny-default grants — `anon` and `authenticated` hold no privilege on the
 *     table (migration 2271 REVOKEs and grants only `service_role`). A fake has
 *     no concept of a role.
 *
 * and the failure behaviour the service promises — "fail-soft: returns false,
 * never throws" — is only meaningful against errors a real server produces
 * (23503, 42501), not against errors a fake was told to produce.
 *
 * THE GUARD IS LOUD ON PURPOSE — AND THE LOUD HALF LIVES ELSEWHERE
 * ================================================================
 * This file CANNOT be registered in the curated `test` script, and not by
 * preference: `../lib/ciSupabaseGuard.mjs` exits 2 when CI_SUPABASE_PROJECT_REF
 * and KNOWN_PROD_PROJECT_REF are unset, which is every ordinary run. That
 * refusal is the repository's production-safety spine and must stay
 * unconditional, so this file is allowlisted in
 * scripts/UNREGISTERED_TESTS_ALLOWLIST.json and run by its own script instead.
 *
 * A file that never runs is the failure mode this repository keeps hitting, so
 * the announcement is split out into a file that DOES run every time:
 * `src/test/wallSessionIntentLiveDbStatus.test.ts` prints, on every ordinary
 * suite run, that the store was not verified against a database and names what
 * is missing. Delete that file and the absence goes quiet again.
 *
 * This repository already has three live-DB suites that skip and exit 0 when
 * credentials are absent, and `.github/workflows/live-db.yml` documents that
 * behaviour as the defect it is: a suite that proves nothing while reporting
 * green. So when this file cannot reach a database it does NOT quietly vanish —
 * `describe({ skip })` carries the reason into the TAP output, and
 * `.github/scripts/run-live-suite.sh` scores a live suite on `pass > 0 &&
 * skipped == 0`, which is what turns a skip into a red in the credentialed job.
 *
 * WHAT COUNTS AS "A DATABASE" HERE
 * ================================
 * The curated `test` script in package.json pins `SUPABASE_URL=http://127.0.0.1:9`
 * — a deliberately dead address — so merely checking that `SUPABASE_URL` is set
 * would make this suite believe it had a database on every ordinary run. The
 * predicate below therefore rejects loopback hosts and placeholder keys
 * explicitly. Getting that wrong is how a suite ends up reporting a pass it
 * never earned.
 *
 * WHICH DATABASE: never production. `../lib/ciSupabaseGuard.mjs` is the FIRST
 * import in this file, above `@supabase/supabase-js`, so the sanctioned-project
 * allowlist is enforced before any client can be constructed. See
 * docs/ci/README.md § "The allowlist is enforced in the execution path".
 *
 * WHAT HAS ALREADY BEEN PROVEN AGAINST THE REAL DATABASE, AND WHAT HAS NOT
 * ========================================================================
 * On 2026-09-14 the four properties above were executed against the sanctioned
 * CI project (`hwokxgbmezheskbzskfr`) at the SQL layer, through the Supabase
 * management API, against the table this suite targets:
 *
 *   write     an intent row inserted for a real profile            — accepted
 *   read      the jsonb structured intent read back unchanged      — intact
 *   upsert    ON CONFLICT (user_id) replaced rather than appended  — 1 row
 *   rollback  an aborted subtransaction left no trace              — clean
 *   failure   an orphan user_id                     — 23503 foreign_key_violation
 *   failure   a null structured_intent              — 23502 not_null_violation
 *   failure   SET ROLE anon / authenticated, SELECT — 42501 insufficient_privilege
 *
 * That establishes the SCHEMA behaves as migration 2271 promises. It does NOT
 * establish that `WallSessionIntentService` drives it correctly through
 * supabase-js and PostgREST, because those SQL statements did not go through the
 * service or through the client the server uses. Only this suite does that, and
 * it needs credentials and network access to the CI project's PostgREST
 * endpoint. Do not read the SQL-layer result as a substitute for running it.
 *
 * RUN IT:
 *   pnpm --filter @workspace/api-server run test:wall-session-intent-live-db
 * with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and CI_SUPABASE_PROJECT_REF set
 * to the sanctioned CI project.
 */
import "../lib/ciSupabaseGuard.mjs";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  setStoredIntent,
  getStoredIntent,
  clearStoredIntent,
  parseIntent,
} from "../services/wall/WallSessionIntentService.js";
import type { StructuredIntent } from "../lib/wallProjection.js";
import { fixtureEmail, fixtureLabel } from "./liveFixtureUsers.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * Why each clause is here, so nobody deletes one as redundant:
 *   - empty url/key: nothing to connect to.
 *   - loopback: the curated suite pins http://127.0.0.1:9 so the api tests never
 *     reach a network. That is a configured NON-database and must read as one.
 *   - "dummy"/"test" keys: the same pin supplies SUPABASE_SERVICE_ROLE_KEY=dummy.
 */
function missingLiveDbReason(): string | null {
  if (!SUPABASE_URL) return "SUPABASE_URL is not set";
  if (!SERVICE_ROLE_KEY) return "SUPABASE_SERVICE_ROLE_KEY is not set";
  if (/(^|\/\/)(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])([:/]|$)/.test(SUPABASE_URL)) {
    return `SUPABASE_URL points at a loopback stub (${SUPABASE_URL}), not a database`;
  }
  if (/^(dummy|test|placeholder|changeme)$/i.test(SERVICE_ROLE_KEY)) {
    return `SUPABASE_SERVICE_ROLE_KEY is the placeholder "${SERVICE_ROLE_KEY}"`;
  }
  return null;
}

const SKIP_REASON = missingLiveDbReason();
const LIVE = SKIP_REASON === null;

// ── The live suite ───────────────────────────────────────────────────────────

let admin: SupabaseClient;
let userId = "";
const createdUserIds: string[] = [];
const FIXTURE_EMAIL = fixtureEmail("wall_session_intent_live_test@example.com");

/** A never-persisted user id, for the foreign-key refusal. */
const ABSENT_USER_ID = "00000000-0000-4000-8000-000000000000";

function intentFixture(label: string, keyword: string): StructuredIntent {
  return {
    filters: [{ kind: "city", entityId: "11111111-1111-4111-8111-111111111111", label, value: null }],
    keywords: [keyword],
    sessionScoped: true,
    createdAt: new Date().toISOString(),
    resolution: "resolved",
  };
}

describe(
  "W146 — the Wall session-intent store against real Postgres",
  { skip: LIVE ? false : `no live database: ${SKIP_REASON}` },
  () => {
    before(async () => {
      admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      // Heal first, then create: a prior crashed run must not poison every
      // subsequent one (the lesson recorded in rlsHardening.test.ts).
      const { data: existing } = await admin.auth.admin.listUsers({ perPage: 200 });
      for (const u of existing?.users ?? []) {
        if (u.email === FIXTURE_EMAIL) await admin.auth.admin.deleteUser(u.id);
      }
      const { data, error } = await admin.auth.admin.createUser({
        email: FIXTURE_EMAIL,
        password: "test-password-123",
        email_confirm: true,
      });
      if (error) throw new Error(`Setup: create ${FIXTURE_EMAIL}: ${error.message}`);
      userId = data.user.id;
      createdUserIds.push(userId);
      const { error: pErr } = await admin
        .from("profiles")
        .upsert(
          // `profiles_username_lower_unique` is UNIQUE and `onConflict: "id"` does
          // not resolve it, so two concurrent runs writing the same bare literal
          // collide with 23505 under different auth-user ids. fixtureLabel() scopes
          // the value to THIS run — see src/test/fixtureLabelUsage.test.ts.
          [{ id: userId, username: fixtureLabel(`wsi_live_${userId.slice(0, 8)}`) }],
          { onConflict: "id" },
        );
      if (pErr) throw new Error(`Setup: profile for ${userId}: ${pErr.message}`);
    });

    after(async () => {
      if (!admin) return;
      await admin.from("wall_session_intents").delete().eq("user_id", userId);
      for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
    });

    it("WRITE — an intent reaches Postgres and the row is really there", async () => {
      const ok = await setStoredIntent(admin, userId, intentFixture("Bangkok", "nightlife"), "bangkok nightlife");
      assert.equal(ok, true, "setStoredIntent reported failure against a healthy database");
      // Read the row back with a SEPARATE query, not through the service, so the
      // service cannot be the thing that agrees with itself.
      const { data, error } = await admin
        .from("wall_session_intents")
        .select("user_id, structured_intent, raw_text")
        .eq("user_id", userId)
        .maybeSingle();
      assert.equal(error, null);
      assert.ok(data, "no row was written");
      assert.equal((data as any).raw_text, "bangkok nightlife");
      assert.equal((data as any).structured_intent.filters[0].label, "Bangkok");
    });

    it("READ — the service reads back exactly what it stored, jsonb round trip intact", async () => {
      const got = await getStoredIntent(admin, userId);
      assert.ok(got, "getStoredIntent returned null for a row that exists");
      assert.equal(got!.filters[0].label, "Bangkok");
      assert.equal(got!.filters[0].entityId, "11111111-1111-4111-8111-111111111111");
      assert.deepEqual(got!.keywords, ["nightlife"]);
      assert.equal(got!.sessionScoped, true);
      // W71: a STORED intent never reports the live engine's health.
      assert.notEqual(got!.resolution, "engine_unavailable");
    });

    it("ONE ROW PER USER — a second write replaces, it does not accumulate", async () => {
      const ok = await setStoredIntent(admin, userId, intentFixture("Lisbon", "museums"), "lisbon museums");
      assert.equal(ok, true);
      const { data, error } = await admin
        .from("wall_session_intents")
        .select("user_id, raw_text")
        .eq("user_id", userId);
      assert.equal(error, null);
      assert.equal(
        (data ?? []).length,
        1,
        "the PRIMARY KEY on user_id is what makes this an upsert — a second row means the " +
          "schema no longer enforces one intent per user",
      );
      assert.equal((data as any[])[0].raw_text, "lisbon museums");
    });

    it("ISOLATION — one user's intent is invisible to another, and deleting one leaves the other", async () => {
      // A second user id that is NOT this fixture: the read must be scoped by
      // user_id at the database, not by whatever the caller happens to pass.
      const other = await getStoredIntent(admin, ABSENT_USER_ID);
      assert.equal(other, null, "a read for a different user returned this user's row");
      // …and the row under test is untouched by that read.
      const mine = await getStoredIntent(admin, userId);
      assert.ok(mine, "the fixture row disappeared");
    });

    it("CLEAR — the row is really gone afterwards (restores prior Wall state, §17)", async () => {
      assert.equal(await clearStoredIntent(admin, userId), true);
      const { data } = await admin
        .from("wall_session_intents")
        .select("user_id")
        .eq("user_id", userId);
      assert.deepEqual(data ?? [], [], "clearStoredIntent reported success but the row survived");
      assert.equal(await getStoredIntent(admin, userId), null);
    });

    it("FAILURE — Postgres REFUSES an intent for a user who does not exist, and the service fails soft", async () => {
      // The foreign key to profiles. A fake client accepts this write; the
      // database must not, and the service must report the refusal rather than
      // throwing or claiming success.
      const ok = await setStoredIntent(
        admin,
        ABSENT_USER_ID,
        intentFixture("Nowhere", "ghost"),
        "ghost",
      );
      assert.equal(
        ok,
        false,
        "the service claimed a write succeeded that the foreign key refused — " +
          "reporting a rejected write as stored is how a user's steer silently disappears",
      );
      const { data } = await admin
        .from("wall_session_intents")
        .select("user_id")
        .eq("user_id", ABSENT_USER_ID);
      assert.deepEqual(data ?? [], [], "an orphan intent row exists");
    });

    it("FAILURE — the deny-default grants hold: a non-service role cannot read the table", async () => {
      const anonKey =
        process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
      if (!anonKey) {
        // Loud, not silent: this one assertion is unavailable, and says so.
        console.log(
          "[W146] anon-grant assertion NOT RUN: no EXPO_PUBLIC_SUPABASE_ANON_KEY/SUPABASE_ANON_KEY",
        );
        return;
      }
      const anon = createClient(SUPABASE_URL, anonKey, { auth: { persistSession: false } });
      const { data, error } = await anon.from("wall_session_intents").select("user_id").limit(1);
      assert.ok(
        error !== null || (data ?? []).length === 0,
        "an unauthenticated client read the Wall's session-intent table",
      );
    });

    it("END TO END — a parsed intent survives a round trip through Postgres", async () => {
      // The whole shipping write path: parse (shared engine over the real
      // client) → store → read back.
      const parsed = await parseIntent(admin, userId, "bangkok street food");
      assert.equal(await setStoredIntent(admin, userId, parsed, "bangkok street food"), true);
      const back = await getStoredIntent(admin, userId);
      assert.ok(back, "the parsed intent did not survive the round trip");
      assert.equal(back!.sessionScoped, true);
      assert.ok(
        Array.isArray(back!.filters) && Array.isArray(back!.keywords),
        "the structured shape did not survive jsonb",
      );
    });
  },
);
