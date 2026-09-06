/**
 * memoryProjectorCanonicalSaves.test.ts
 *
 * Pins migration 2310, which repoints the memory projector's PLACE lane off the
 * writerless `public.saved_places` and onto the two tables saves actually land
 * in.
 *
 * WHAT THIS TEST CAN AND CANNOT DO — stated plainly, because the gap matters.
 * `project_user_memory` is a SQL function. Executing it needs a database, and
 * this suite has none, so these are CONTRACT assertions over the migration text,
 * not behavioural ones. Two things carry the behavioural weight instead:
 *   1. the migration's own DO-block postconditions, which run at apply time and
 *      refuse the migration if the function still reads saved_places or if the
 *      id-space bridge is incomplete; and
 *   2. the live-DB CI tier, which applies migrations and certifies against the
 *      real schema.
 * A contract test that cannot execute the thing it guards is weaker than a
 * behavioural one, and saying so is part of the guard.
 *
 * THE DEFECT. `public.saved_places` has ZERO writers anywhere — server TS,
 * client TS or SQL. The PLACE lane read it, so it produced nothing, forever,
 * while reporting success with collected: 0. That one table explains two dead
 * surfaces: the Map `saved` layer (fixed in TypeScript by PR #446) and the Map
 * `memory` layer, which filters on subject_type='place' and therefore never had
 * an eligible subject.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../migrations");

/** The function BODY only. The postcondition block and COMMENT after it name the
 *  old table on purpose, to explain the change and to refuse a regression. */
/** Function body with SQL comments stripped. A bridge assertion must match the
 *  JOIN, not the sentence describing it — matching prose is how a removed bridge
 *  can pass a test that "checks" for it. */
function fnCode(sql: string): string {
  return fnBody(sql).replace(/--.*$/gm, "");
}

function fnBody(sql: string): string {
  const start = sql.indexOf("AS $fn$");
  const end = sql.indexOf("$fn$;", start);
  assert.ok(start >= 0 && end > start, "could not isolate the function body");
  return sql.slice(start, end);
}

/** The migration that currently owns the projector — the highest-numbered one. */
function latestProjectorMigration(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => readFileSync(join(MIGRATIONS, f), "utf8")
      .includes("FUNCTION public.project_user_memory"))
    .sort();
  assert.ok(files.length > 0, "no migration defines project_user_memory");
  const file = files[files.length - 1]!;
  return { file, sql: readFileSync(join(MIGRATIONS, file), "utf8") };
}

describe("memory projector — the PLACE lane reads the canonical save tables", () => {
  it("the newest definition does NOT read the writerless saved_places", () => {
    const { file, sql } = latestProjectorMigration();
    // Comments legitimately name the old table when explaining the change.
    const body = fnBody(sql);
    assert.ok(
      !/\bpublic\.saved_places\b/.test(body),
      `${file}'s function body still reads public.saved_places. Nothing writes ` +
      `that table, so the PLACE lane returns zero rows for every user in every ` +
      `environment — and an empty table is indistinguishable from an empty ` +
      `result, so the projector reports success either way.`,
    );
  });

  it("reads BOTH canonical save tables — neither alone is a superset", () => {
    const { sql } = latestProjectorMigration();
    const body = fnBody(sql);
    const code = fnCode(sql);
    assert.match(code, /public\.wishlist_places/,
      "wishlist_places carries every TripWishlistPicker save, including the Map's own long-press save");
    assert.match(code, /public\.discovery_place_saves/,
      "discovery_place_saves carries the DiscoveryWall bookmark, which writes nothing to wishlist_places");
  });

  it("bridges all three resolvable id-spaces, so no save path is silently dropped", () => {
    const { sql } = latestProjectorMigration();
    const body = fnBody(sql);
    // wishlist_places.place_id is TEXT with no FK and spans four spaces. Missing
    // any ONE bridge looks exactly like "that user saved nothing".
    const code = fnCode(latestProjectorMigration().sql);
    assert.match(code, /dp\.id\s*=\s*substring\(\s*wp\.place_id/,
      "db/<discovery_places.id> must resolve by a real JOIN, not a comment");
    assert.match(code, /dp\.canonical_location_id\s*=\s*substring\(\s*wp\.place_id/,
      "db/<places.id> must resolve via the 2053 mirror by a real JOIN");
    assert.match(code, /dp\.osm_id\s*=\s*wp\.place_id/,
      "node|way|relation/<id> must resolve via the 0086 mirror by a real JOIN — " +
      "asserting only that the token 'osm_id' appears somewhere passes even when " +
      "the JOIN is deleted, because the comment above it names the column too");
  });

  it("dedupes per venue and keeps the FIRST save instant", () => {
    const { sql } = latestProjectorMigration();
    const body = fnBody(sql);
    assert.match(body, /MIN\(saved_at\)/i,
      "one OSM save writes BOTH tables, and wishlist_places is UNIQUE(user_id, place_id, list_id) " +
      "so one venue saved to three trips is three rows. Grouping on the resolved id with " +
      "MIN(saved_at) collapses both, and MIN — not MAX — because re-saving to another list " +
      "is the same memory, not a new one, and MAX would let a re-save rewrite history.",
    );
    assert.match(body, /GROUP BY\s+resolved_id/i, "dedupe must key on the resolved venue, not the row");
  });

  it("preserves subject identity — nothing unbridgeable becomes a memory subject", () => {
    const { sql } = latestProjectorMigration();
    const body = fnBody(sql);
    // subject_id has always been a discovery_places.id. A bare uuid in
    // wishlist_places is a hidden gem / event / city in an unnamed space; it has
    // no discovery_places row, and inventing one would fabricate a place.
    assert.match(body, /subject_type,\s*subject_id/,
      "the projection still writes an explicit subject_type/subject_id pair");
    assert.match(body, /cs\.place_id::text/,
      "the subject remains a discovery_places.id cast to text — the same space as before");
  });

  it("scopes every read to the requesting user", () => {
    const { sql } = latestProjectorMigration();
    const body = fnBody(sql);
    const userScoped = (body.match(/user_id\s*=\s*p_user_id/g) ?? []).length;
    assert.ok(
      userScoped >= 4,
      `the function is SECURITY DEFINER, so 'user_id = p_user_id' is the ONLY scoping ` +
      `there is — found ${userScoped} occurrences, expected one per source read`,
    );
  });

  it("carries postconditions that refuse the migration if the repoint regresses", () => {
    const { sql } = latestProjectorMigration();
    assert.match(sql, /POSTCONDITION FAILED[\s\S]*saved_places/,
      "apply-time refusal if the function still reads the writerless table");
    assert.match(sql, /POSTCONDITION FAILED[\s\S]*id-space bridge is incomplete/,
      "apply-time refusal if a bridge is missing — the failure mode that looks like 'no saves'");
  });
});
