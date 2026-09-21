/**
 * G226 / G100 — §35 selection memory against a REAL Postgres.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * Every other test of selection memory runs against an in-memory fake. A fake
 * proves that `recordSelection` and `fetchSelectionMemory` CALL the right
 * things; it cannot prove that Postgres accepts them, and the properties §35
 * actually rests on live in the database and in nothing else:
 *
 *   • upsert-with-increment — `input_selection_history_unique_idx` over
 *     (user_id, context, entity_type, entity_id, query_key) is what makes a
 *     repeated selection an INCREMENT rather than a second row. A fake that
 *     keys a Map by the same tuple agrees with any schema, including one with
 *     no such index. "Frequently selected" is a COUNT, so a schema that
 *     accumulated duplicate rows would report frequency 1 forever.
 *   • the label-preservation rule — `COALESCE(EXCLUDED.label, …)` inside the
 *     RPC, which a fake reimplements rather than exercises.
 *   • the erasure cascade — `user_id` REFERENCES `auth.users(id)` ON DELETE
 *     CASCADE. This is the whole of the §35 erasure guarantee: there is no
 *     sweep, no tombstone and no separate forget path. A fake has no cascade.
 *   • deny-default grants — `anon` and `authenticated` hold no privilege on the
 *     table and no EXECUTE on the function (2258 REVOKEs both and grants only
 *     `service_role`). A fake has no concept of a role, and this is the exact
 *     class that shipped as a defect twice before (the 2190/2214 lesson 2258's
 *     own postcondition cites).
 *   • the `selection_count >= 1` CHECK.
 *
 * WHY IT IS WORTH HAVING NOW, SPECIFICALLY
 * ========================================
 * `input_selection_history` reached PRODUCTION on 2026-09-21. Before that date
 * every §35 verdict in census-input-intelligence.md was flagged `☠prod` —
 * correct code over storage that did not exist. The flag is gone; what replaces
 * it must not be a fake agreeing with itself. This suite is the artifact that
 * makes "the memory round-trips" a measured claim rather than an inference from
 * a migration file.
 *
 * WHAT THIS SUITE DOES AND DOES NOT TOUCH
 * =======================================
 * It targets the SANCTIONED CI PROJECT and never production.
 * `../lib/ciSupabaseGuard.mjs` is the FIRST import, above
 * `@supabase/supabase-js`, so the allowlist is enforced before any client can
 * be constructed — see docs/ci/README.md § "The allowlist is enforced in the
 * execution path". It creates its own fixture auth user, writes only that
 * user's rows, and deletes the user in `after` (which also proves the cascade).
 *
 * THE SKIP IS LOUD ON PURPOSE
 * ===========================
 * This file CANNOT be registered in the curated `test` script: the guard exits
 * 2 when CI_SUPABASE_PROJECT_REF and KNOWN_PROD_PROJECT_REF are unset, which is
 * every ordinary run, and that refusal is the repository's production-safety
 * spine and must stay unconditional. It is allowlisted in
 * scripts/UNREGISTERED_TESTS_ALLOWLIST.json and run by its own script.
 * `describe({ skip })` carries the reason into the TAP output so
 * .github/scripts/run-live-suite.sh (which scores `pass > 0 && skipped == 0`)
 * turns a skip into a RED in the credentialed job rather than a silent green —
 * the failure mode .github/workflows/live-db.yml documents.
 *
 * NOT RUN WHEN WRITTEN, stated rather than implied: the session that added this
 * file had no CI credentials, so it has been executed against no database. It
 * is an artifact for the credentialed job, and no census verdict rests on a
 * result it has not produced.
 *
 * RUN IT:
 *   pnpm --filter @workspace/api-server run test:input-selection-memory-live-db
 * with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and CI_SUPABASE_PROJECT_REF set
 * to the sanctioned CI project.
 */
import "../lib/ciSupabaseGuard.mjs";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { recordSelection, fetchSelectionMemory } from "../lib/inputAssistance/personalization.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
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

let admin: SupabaseClient;
let userId = "";
const createdUserIds: string[] = [];
const FIXTURE_EMAIL = fixtureEmail("input_selection_memory_live_test@example.com");

/** A canonical city id. It need not exist: the table stores entity_id as text. */
const CITY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CITY_ID = "22222222-2222-4222-8222-222222222222";

describe(
  "§35 selection memory against real Postgres (migration 2258)",
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
        .upsert([{ id: userId, username: fixtureLabel(`ism_live_${userId.slice(0, 8)}`) }], {
          onConflict: "id",
        });
      if (pErr) throw new Error(`Setup: profile for ${userId}: ${pErr.message}`);
    });

    after(async () => {
      if (!admin) return;
      await admin.from("input_selection_history").delete().eq("user_id", userId);
      for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
    });

    it("WRITE — an explicit selection reaches Postgres through the real service", async () => {
      const policy = resolvePolicy("city_picker")!;
      const res = await recordSelection(admin, policy, {
        userId,
        context: "city_picker",
        entityType: "city",
        entityId: CITY_ID,
        query: "bkk",
        label: "Bangkok",
      });
      assert.equal(res.recorded, true, `recordSelection refused: ${res.reason ?? ""}`);

      // Read the row back with a SEPARATE query, not through the service, so the
      // service cannot be the thing that agrees with itself.
      const { data, error } = await admin
        .from("input_selection_history")
        .select("user_id, context, entity_type, entity_id, query_key, label, selection_count")
        .eq("user_id", userId)
        .eq("entity_id", CITY_ID)
        .maybeSingle();
      assert.equal(error, null);
      assert.ok(data, "no row was written");
      assert.equal((data as any).context, "city_picker");
      assert.equal((data as any).entity_type, "city");
      assert.equal((data as any).query_key, "bkk");
      assert.equal((data as any).label, "Bangkok");
      assert.equal((data as any).selection_count, 1);
    });

    it("UPSERT — a repeated selection INCREMENTS rather than appending a second row", async () => {
      // This is the property "frequently selected" (§35) is made of. A schema
      // without input_selection_history_unique_idx accumulates rows and every
      // entity reports a frequency of 1 forever.
      const policy = resolvePolicy("city_picker")!;
      const again = await recordSelection(admin, policy, {
        userId,
        context: "city_picker",
        entityType: "city",
        entityId: CITY_ID,
        query: "bkk",
        label: null,
      });
      assert.equal(again.recorded, true);

      const { data, error } = await admin
        .from("input_selection_history")
        .select("id, selection_count, label")
        .eq("user_id", userId)
        .eq("entity_id", CITY_ID);
      assert.equal(error, null);
      assert.equal((data ?? []).length, 1, "a repeat must not create a second row");
      assert.equal((data as any[])[0].selection_count, 2, "the count must increment");
      // COALESCE(EXCLUDED.label, …): a NULL label must not erase a known one.
      assert.equal((data as any[])[0].label, "Bangkok", "a null label must not overwrite a known one");
    });

    it("READ — the real read path aggregates what the real write path stored", async () => {
      const policy = resolvePolicy("city_picker")!;
      await recordSelection(admin, policy, {
        userId,
        context: "city_picker",
        entityType: "city",
        entityId: OTHER_CITY_ID,
        query: "sgn",
        label: "Ho Chi Minh City",
      });

      const memory = await fetchSelectionMemory(admin, { userId, context: "city_picker", max: 200 });
      assert.equal(memory.isEmpty, false, "the memory must not be empty after two writes");
      const ids = memory.recentEntities.map((a) => a.entityId);
      assert.ok(ids.includes(CITY_ID) && ids.includes(OTHER_CITY_ID), `got ${ids.join(",")}`);
      const bkk = memory.byEntity.get(`city:${CITY_ID}`);
      assert.ok(bkk, "the twice-selected entity must be aggregated");
      assert.equal(bkk!.total, 2, "the aggregate must carry the real stored count");
      assert.equal(bkk!.byQuery.get("bkk"), 2, "the per-query mapping is the §35 abbreviation signal");
    });

    it("CONTEXT-SCOPED — a read of another context sees none of it", async () => {
      const memory = await fetchSelectionMemory(admin, {
        userId,
        context: "trip_destination",
        max: 200,
      });
      assert.equal(memory.isEmpty, true, "memory learned on city_picker must not reach trip_destination");
    });

    it("REFUSAL — selection_count may not drop below 1 (the CHECK constraint)", async () => {
      const { error } = await admin
        .from("input_selection_history")
        .update({ selection_count: 0 })
        .eq("user_id", userId)
        .eq("entity_id", CITY_ID);
      assert.ok(error, "the database must refuse a non-positive selection count");
      assert.equal((error as any).code, "23514", `expected check_violation, got ${(error as any).code}`);
    });

    it("ERASURE — deleting the auth user erases the memory by cascade, with no sweep", async () => {
      // This is the WHOLE of §35's erasure guarantee: the FK is to auth.users,
      // not profiles, precisely because profiles is kept as an anonymised
      // tombstone and would never fire a cascade. Nothing else forgets.
      const { data: before } = await admin
        .from("input_selection_history")
        .select("id")
        .eq("user_id", userId);
      assert.ok((before ?? []).length > 0, "the premise: rows exist before the delete");

      await admin.auth.admin.deleteUser(userId);
      createdUserIds.length = 0; // already deleted; do not double-delete in after()

      const { data: afterRows, error } = await admin
        .from("input_selection_history")
        .select("id")
        .eq("user_id", userId);
      assert.equal(error, null);
      assert.deepEqual(afterRows, [], "the cascade must have erased every row for the departed user");
    });
  },
);
