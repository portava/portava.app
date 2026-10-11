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
import { migrationFkBacksEmbed, parseForeignKeyEdges, parseSelectEmbeds, assertSelectEmbedsBacked } from "./helpers/migrationForeignKeys.js";

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
