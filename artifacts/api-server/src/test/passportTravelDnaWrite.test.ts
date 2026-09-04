/**
 * Passport Travel DNA write — §19 Show / Hide / Not-Me (migration 2261).
 *
 * Exercises `writeTravelDnaPref` (the core of PUT /passport/me/travel-dna):
 *   • upsert    — a valid write persists user_id + dimension_key + state with the
 *                 (user_id,dimension_key) conflict target;
 *   • owner-scoping — the row is written for the SUPPLIED user only, never a
 *                 different id, even if a different id appears elsewhere;
 *   • flag-gate — with passport_travel_dna_enabled off the write is refused
 *                 fail-closed and NOTHING is written;
 *   • invalid state — a state outside shown|hidden|not_me is rejected before any
 *                 flag read or write.
 *
 * Run: node --import tsx/esm --test src/test/passportTravelDnaWrite.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeTravelDnaPref } from "../services/passport/PassportTravelIdentityService.js";

const USER_A = "aaaa0000-0000-4000-a000-000000000001";
const USER_B = "bbbb0000-0000-4000-a000-000000000002";

interface UpsertCall { table: string; row: any; onConflict?: string }

/**
 * A capturing fake that records every upsert payload and answers the single flag
 * read `writeTravelDnaPref` performs. `upsertError` forces the DB-error branch.
 */
function makeFake(opts: { flagEnabled: boolean; upsertError?: boolean }) {
  const upserts: UpsertCall[] = [];
  const client: any = {
    from(table: string) {
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        maybeSingle: async () => {
          if (table === "feature_flags") return { data: { enabled: opts.flagEnabled }, error: null };
          return { data: null, error: null };
        },
        upsert(row: any, options?: any) {
          upserts.push({ table, row, onConflict: options?.onConflict });
          return Promise.resolve({ data: null, error: opts.upsertError ? { message: "boom" } : null });
        },
      };
      return builder;
    },
  };
  return { client, upserts };
}

describe("writeTravelDnaPref — §19 Travel DNA Show/Hide/Not-Me", () => {
  it("upserts a valid preference with the (user_id,dimension_key) conflict target", async () => {
    const { client, upserts } = makeFake({ flagEnabled: true });
    const r = await writeTravelDnaPref(client, USER_A, { key: "night_explorer", kind: "trait", state: "hidden" });
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.pref);
    if (r.ok) {
      assert.equal(r.pref.userId, USER_A);
      assert.equal(r.pref.key, "night_explorer");
      assert.equal(r.pref.kind, "trait");
      assert.equal(r.pref.state, "hidden");
    }
    assert.equal(upserts.length, 1, "exactly one upsert");
    assert.equal(upserts[0].table, "passport_travel_dna_prefs");
    assert.equal(upserts[0].row.dimension_key, "night_explorer");
    assert.equal(upserts[0].row.state, "hidden");
    assert.equal(upserts[0].onConflict, "user_id,dimension_key");
  });

  it("is owner-scoped: writes the SUPPLIED user_id only", async () => {
    const { client, upserts } = makeFake({ flagEnabled: true });
    await writeTravelDnaPref(client, USER_A, { key: "travel_pace", kind: "dimension", state: "not_me" });
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].row.user_id, USER_A, "row written for the session user");
    assert.notEqual(upserts[0].row.user_id, USER_B, "never another user's subtree");
  });

  it("is fail-closed when passport_travel_dna_enabled is off (no write)", async () => {
    const { client, upserts } = makeFake({ flagEnabled: false });
    const r = await writeTravelDnaPref(client, USER_A, { key: "food_driven", kind: "trait", state: "shown" });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.reason === "feature_disabled");
    assert.equal(upserts.length, 0, "gated write must persist nothing");
  });

  it("rejects an invalid state before any flag read or write", async () => {
    const { client, upserts } = makeFake({ flagEnabled: true });
    const r = await writeTravelDnaPref(client, USER_A, { key: "rhythm", kind: "dimension", state: "bogus" as any });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.reason === "invalid_state");
    assert.equal(upserts.length, 0);
  });

  it("rejects an empty key and an unknown kind", async () => {
    const { client } = makeFake({ flagEnabled: true });
    const r1 = await writeTravelDnaPref(client, USER_A, { key: "   ", kind: "trait", state: "shown" });
    assert.ok(!r1.ok && r1.reason === "invalid_key");
    const r2 = await writeTravelDnaPref(client, USER_A, { key: "rhythm", kind: "bogus" as any, state: "shown" });
    assert.ok(!r2.ok && r2.reason === "invalid_key");
  });

  it("surfaces a DB error as reason 'db_error'", async () => {
    const { client } = makeFake({ flagEnabled: true, upsertError: true });
    const r = await writeTravelDnaPref(client, USER_A, { key: "discovery", kind: "dimension", state: "hidden" });
    assert.ok(!r.ok && r.reason === "db_error");
  });
});
