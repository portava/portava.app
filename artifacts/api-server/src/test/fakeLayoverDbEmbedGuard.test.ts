/**
 * census-layover L295 (wave W, A6) — "Never let a test fixture assert impossible
 * production joins".
 *
 * `fakeLayoverDb` used to resolve `airport_profiles(...)` off ANY table's
 * `airport_id`, and accepted every other `x(...)` embed silently. PostgREST
 * resolves an embed only along a foreign key between the two tables and
 * refuses the rest (PGRST200), so a route that embedded across tables with no
 * FK was green under the double and dead in production. The double now checks
 * every embed (nested ones too) against the FKs the migration chain declares
 * (`helpers/migrationForeignKeys.ts`) and throws on the rest.
 *
 * Run: node --import tsx/esm --test src/test/fakeLayoverDbEmbedGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { migrationFkBacksEmbed, parseForeignKeyEdges, parseSelectEmbeds, assertSelectEmbedsBacked, parseForeignKeys, selectEmbedRefusals, KNOWN_UNBACKED_EMBEDS } from "./helpers/migrationForeignKeys.js"; import { makeFailClosedClient } from "./helpers/failClosedSupabase.js"; import { makeSchemaStrictClient } from "./helpers/schemaStrictSupabase.js"; import { makeFakeMapDb } from "./helpers/fakeMapDb.js"; import { readdirSync, readFileSync } from "node:fs";

function db() {
  return makeLayoverDb({
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({}, { nowMs: Date.parse("2026-09-13T02:00:00.000Z") })],
    rent_buddy_profiles: [{ id: "b1", user_id: "u1", city: "Taoyuan", airport_id: "airport-tpe" }],
  });
}

describe("L295 — the layover double refuses an embed no migration-declared FK backs", () => {
  it("PLANTED: rent_buddy_profiles → airport_profiles has no FK, so the double refuses it", () => {
    // The row even carries an `airport_id`: the old double would have joined it.
    assert.throws(
      () => db().from("rent_buddy_profiles").select("id, airport_profiles(city)"),
      /no migration declares a foreign key/,
    );
  });

  it("PLANTED, nested: a bad embed inside a good one is refused too", () => {
    assert.throws(
      () => db().from("layover_sessions").select("id, airport_profiles(city, rent_buddy_profiles(id))"),
      /`rent_buddy_profiles\(\.\.\.\)` is embedded from `airport_profiles`/,
    );
  });

  it("PLANTED, aliased and hinted forms are parsed, not skipped", () => {
    assert.throws(() => db().from("rent_buddy_profiles").select("id, ap:airport_profiles!inner(city)"));
  });

  it("CONTROL: layover_sessions → airport_profiles (0127's FK) is modelled and resolves", async () => {
    const { data, error } = await db().from("layover_sessions").select("id, airport_profiles(city)").maybeSingle();
    assert.equal(error, null);
    assert.equal(data.airport_profiles?.city, "Taoyuan");
  });

  it("CONTROL: an FK-backed embed the double does not model is accepted with the key absent (unchanged)", async () => {
    // layover_sessions.user_id REFERENCES profiles(id) — 0127.
    const { data, error } = await db().from("layover_sessions").select("id, profiles(display_name)");
    assert.equal(error, null);
    assert.equal(data.length, 1);
    assert.equal("profiles" in data[0], false);
  });

  it("CONTROL: an aliased, hinted embed along a real FK is accepted (the alias is not the relation)", () => {
    assert.doesNotThrow(() => db().from("layover_sessions").select("id, airport:airport_profiles!inner(city)"));
  });

  it("CONTROL: a plain column list and an aggregate are not embeds", () => {
    assert.deepEqual(parseSelectEmbeds("layover_sessions", "id, user_id, count()"), []);
    assert.deepEqual(parseSelectEmbeds("layover_sessions", "*"), []);
  });
});

describe("L295 — airport.test.ts's hand-rolled double (named by the census row) uses the same guard", () => {
  it("the guard it calls refuses the planted embed and accepts 0127's", () => {
    assert.throws(() => assertSelectEmbedsBacked("airport.test makeClient", "rent_buddy_profiles", "id, airport_profiles(city)"), /PGRST200/);
    assert.doesNotThrow(() => assertSelectEmbedsBacked("airport.test makeClient", "layover_sessions", "user_id, airport_profiles(city)"));
  });
  it("and airport.test.ts actually calls it from select()", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./airport.test.ts", import.meta.url), "utf8");
    assert.match(src, /select\(cols\?: string\) \{ assertSelectEmbedsBacked\("airport\.test makeClient", _table, cols\);/);
  });
});

describe("L295 — the FK reader reads what the migrations declare", () => {
  it("column REFERENCES inside CREATE TABLE, and ALTER TABLE … REFERENCES, both count", () => {
    const e = parseForeignKeyEdges(`
      CREATE TABLE IF NOT EXISTS public.a (id uuid PRIMARY KEY, b_id uuid REFERENCES public.b(id) ON DELETE CASCADE);
      -- CREATE TABLE fake (x uuid REFERENCES commented_out(id));
      ALTER TABLE ONLY c ADD CONSTRAINT c_d_fk FOREIGN KEY (d_id) REFERENCES d(id);
    `);
    assert.ok(e.has("a→b"));
    assert.ok(e.has("c→d"));
    assert.ok(![...e].some((x) => x.includes("commented_out")), "a commented-out FK is not an FK");
  });

  it("the real chain: 0127's layover_sessions → airport_profiles is found, in both directions", () => {
    assert.equal(migrationFkBacksEmbed("layover_sessions", "airport_profiles"), true);
    assert.equal(migrationFkBacksEmbed("airport_profiles", "layover_sessions"), true);
  });

  it("the real chain: no FK joins rent_buddy_profiles and airport_profiles", () => {
    assert.equal(migrationFkBacksEmbed("rent_buddy_profiles", "airport_profiles"), false);
  });
});

// ── census-layover L295, wave 5 (2026-10-17): the three doubles §65.4 named are behind the guard ──
//
// §65.4: "failClosedSupabase, schemaStrictSupabase and fakeMapDb are not yet
// behind the embed guard." Each now calls `assertSelectEmbedsBacked` from its
// own `select()`. The guard also reads the 2026-08-19 production baseline, so
// keys that predate the migration chain count, and it reads which COLUMN a key
// runs along, so a column embed resolves and a hint naming no key is refused.

describe("L295 wave 5 — every double refuses an embed no declared key backs", () => {
  const PLANT = "id, airport_profiles(city)";

  it("PLANTED: failClosedSupabase refuses rent_buddy_profiles → airport_profiles", () => {
    const client = makeFailClosedClient({ rows: { rent_buddy_profiles: [{ id: "b1", airport_id: "airport-tpe" }] } });
    assert.throws(() => client.from("rent_buddy_profiles").select(PLANT), /^Error: failClosedSupabase: `airport_profiles\(\.\.\.\)` is embedded from `rent_buddy_profiles`.*PGRST200/);
  });

  it("PLANTED: schemaStrictSupabase refuses it (its column check drops embeds, so nothing else would)", () => {
    const client = makeSchemaStrictClient({ rent_buddy_profiles: [] });
    assert.throws(() => client.from("rent_buddy_profiles").select(PLANT), /^Error: schemaStrictSupabase: .*PGRST200/);
  });

  it("PLANTED: fakeMapDb refuses it", () => {
    const client = makeFakeMapDb({ rent_buddy_profiles: [] }, { token: "t", userId: "u" });
    assert.throws(() => client.from("rent_buddy_profiles").select(PLANT), /^Error: fakeMapDb: .*PGRST200/);
  });

  it("PLANTED, nested, on every double: a bad embed inside a good one", () => {
    const cols = "id, airport_profiles(city, rent_buddy_profiles(id))";
    for (const from of [
      makeFailClosedClient({}).from,
      makeSchemaStrictClient({}).from,
      makeFakeMapDb({}, { token: "t", userId: "u" }).from,
    ]) {
      assert.throws(() => from("layover_sessions").select(cols), /`rent_buddy_profiles\(\.\.\.\)` is embedded from `airport_profiles`/);
    }
  });

  it("CONTROL, on every double: a key-backed embed is accepted and the read resolves", async () => {
    const fc = await makeFailClosedClient({ rows: { layover_sessions: [{ id: "s1" }] } }).from("layover_sessions").select("id, airport_profiles(city)");
    assert.equal(fc.error, null);
    const ss = await makeSchemaStrictClient({ trip_members: [{ trip_id: "t1" }] }).from("trip_members").select("trip_id, trips!inner(destination_city)");
    assert.equal(ss.error, null);
    const fm = await makeFakeMapDb({ profiles: [{ id: "u" }] }, { token: "t", userId: "u" }).from("profiles").select("id, user_account_states!user_account_states_user_id_fkey(state)"); // wave 5: hinted as lib/accountStateGate.ts hints it; unhinted is PGRST201 (user_id AND set_by key profiles)
    assert.equal(fm.error, null);
  });
});

describe("L295 wave 5 — the reader knows production's keys, and the column each runs along", () => {
  const migrationsOnly = () => {
    const dir = new URL("../migrations/", import.meta.url);
    const out = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
      for (const e of parseForeignKeyEdges(readFileSync(new URL(f, dir), "utf8"))) out.add(e);
    }
    return out;
  };

  it("keys that predate the migration chain count: trip_members → trips is in the baseline only", () => {
    assert.equal(migrationsOnly().has("trip_members→trips"), false, "if a migration now declares it, pick another baseline-only key");
    assert.equal(migrationFkBacksEmbed("trip_members", "trips"), true);
    assert.deepEqual(selectEmbedRefusals("trip_members", "trip_id, trips!inner(destination_city)"), []);
  });

  it("a column embed lands on the table its key references, and nests from there", () => {
    // discovery_places.submitted_by → profiles (baseline `discovery_places_submitted_by_fkey`).
    // airport_profiles is keyed to profiles (created_by) but NOT to discovery_places,
    // so it resolves only if the nested parent is the column's TARGET.
    assert.equal(migrationFkBacksEmbed("discovery_places", "airport_profiles"), false);
    assert.deepEqual(selectEmbedRefusals("discovery_places", "id, profiles:submitted_by!left(id, airport_profiles(city))"), []);
    assert.match(
      selectEmbedRefusals("discovery_places", "id, profiles:submitted_by!left(id, feature_flags(key))").join(" "),
      /`feature_flags\(\.\.\.\)` is embedded from `profiles`/,
    );
  });

  it("PLANTED: a hint naming no key between the tables is refused; a constraint or column hint that does is accepted", () => {
    assert.match(selectEmbedRefusals("event_reviews", "id, profiles!bogus_col(handle)")[0] ?? "", /`bogus_col` names no foreign-key column or constraint/);
    assert.deepEqual(selectEmbedRefusals("event_reviews", "id, profiles!reviewer_id(handle)"), []);
    assert.deepEqual(selectEmbedRefusals("user_follows", "following_id, profiles!user_follows_following_id_fkey(id)"), []);
    assert.deepEqual(selectEmbedRefusals("circle_memberships", "user_id, owner:profiles!circle_memberships_user_id_fkey(id)"), []);
  });

  it("the column-aware parser reads both CREATE TABLE and ALTER TABLE forms, with default and declared names", () => {
    const fks = parseForeignKeys(`
      CREATE TABLE a (id uuid, b_id uuid REFERENCES b(id), CONSTRAINT a_c_fk FOREIGN KEY (x, y) REFERENCES c(x, y));
      ALTER TABLE ONLY public.d
          ADD CONSTRAINT d_e_custom FOREIGN KEY (e_id) REFERENCES public.e(id);
      ALTER TABLE f ADD COLUMN IF NOT EXISTS g_id uuid REFERENCES g(id);
      -- ALTER TABLE h ADD CONSTRAINT h_fk FOREIGN KEY (i) REFERENCES commented_out(id);
    `);
    assert.deepEqual(fks, [
      { from: "a", to: "b", columns: ["b_id"], name: "a_b_id_fkey" },
      { from: "a", to: "c", columns: ["x", "y"], name: "a_c_fk" },
      { from: "d", to: "e", columns: ["e_id"], name: "d_e_custom" },
      { from: "f", to: "g", columns: ["g_id"], name: "f_g_id_fkey" },
    ]);
  });
});

describe("L295 wave 5 — KNOWN_UNBACKED_EMBEDS cannot outlive its defect", () => {
  it("every entry is still unbacked by any declared key, and still issued by production code", () => {
    assert.deepEqual(KNOWN_UNBACKED_EMBEDS.map((k) => `${k.parent}→${k.relation}`), [], "census-trust wave 5 emptied the ledger; a new entry needs its own still-issued case here");
    for (const k of KNOWN_UNBACKED_EMBEDS) {
      assert.equal(migrationFkBacksEmbed(k.parent, k.relation), false, `${k.parent}→${k.relation} is backed now: delete its entry`);
    }
    const reviews = readFileSync(new URL("../routes/reviews.ts", import.meta.url), "utf8"); // census-trust wave 5: the reviews→profiles entry is gone because the embed is no longer issued
    assert.doesNotMatch(reviews, /\.select\(\s*["'`][^"'`]*profiles!reviewer_id\(/, "routes/reviews.ts issues `profiles!reviewer_id(...)` again; reviews.reviewer_id keys auth.users, so production answers PGRST200");
  });

  it("with the ledger empty, reviews → profiles is REFUSED again, as from any table with no key to profiles", () => {
    assert.match(selectEmbedRefusals("reviews", "id, profiles!reviewer_id(handle)")[0] ?? "", /no migration declares a foreign key between those tables.*PGRST200/);
    assert.match(selectEmbedRefusals("rent_buddy_profiles", "id, profiles!reviewer_id(handle)")[0] ?? "", /PGRST200/);
  });
});
