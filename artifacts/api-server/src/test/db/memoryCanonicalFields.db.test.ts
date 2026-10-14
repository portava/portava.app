/**
 * memoryCanonicalFields.db.test.ts — the EXECUTING witness for 3803
 * (memories.memory_type) and 3804 (memories.place_display_name_at_occurrence and
 * its trigger), on the full chain scripts/local-db/up.sh replays (production's
 * 2026-08-19 baseline structure plus every migration). Census-highlights-
 * memories H40 and H71; B58 cluster MEM-CANON.
 *
 * The route suite (src/test/memoryCanonicalFields.test.ts) ports the trigger to
 * TypeScript to drive the API; this file is what proves the SQL itself does what
 * the port assumes, as the API's service role writes it, with every other
 * memories trigger the chain installs (3674's graph mirror among them) in place.
 *
 *   D1  a new Memory nobody typed is a MOMENT (Q-H40); an off-vocabulary type is refused
 *   D2  a catalog place records the catalog's name at the moment of the write; a
 *       later rename and merge of the catalog row leave the Memory's text alone
 *   D3  the same place never rewrites its text, whatever a writer sends
 *   D4  a NEW place gets its own text, never the old place's; no place, no name
 *   D5  a provider pick keeps the writer's (trimmed) text; a first capture on a
 *       NULL text is accepted once (the route's follow-up after a kernel write)
 *   D6  no client role may execute the trigger function, and both flags are seeded FALSE
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, scalar, seedUser, deleteUser } from "./localDb.js";

let owner = "";
const placeA = randomUUID();
const placeB = randomUUID();
const placeR = randomUUID();
const TAG = `mcf${randomUUID().slice(0, 8)}`;

/** One write as the API's service client makes it. */
const asService = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });
const nameOf = (id: string) => scalar(`SELECT coalesce(place_display_name_at_occurrence, '<null>') FROM public.memories WHERE id = '${id}'`);
const typeOf = (id: string) => scalar(`SELECT coalesce(memory_type, '<null>') FROM public.memories WHERE id = '${id}'`);
function newMemory(cols: Record<string, string | null>): string {
  const id = randomUUID();
  const keys = ["id", "owner_id", "title", ...Object.keys(cols)];
  const vals = [`'${id}'`, `'${owner}'`, `'${TAG}'`, ...Object.values(cols).map((v) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`))];
  asService(`INSERT INTO public.memories (${keys.join(", ")}) VALUES (${vals.join(", ")});`);
  return id;
}

describe("3803/3804 on the full chain: the type and the occurrence-time place text", { skip: !HAVE_DB }, () => {
  before(() => {
    owner = seedUser(TAG);
    exec(`INSERT INTO public.places (id, name, normalized_name) VALUES
      ('${placeA}', 'Cafe A ${TAG}', 'cafe a ${TAG}'), ('${placeB}', 'Cafe B ${TAG}', 'cafe b ${TAG}'), ('${placeR}', 'Ramen R ${TAG}', 'ramen r ${TAG}');`);
  });
  after(() => {
    if (owner) deleteUser(owner); // cascades the Memories
    exec(`UPDATE public.places SET merged_into_place_id = NULL WHERE id IN ('${placeA}', '${placeB}', '${placeR}');
          DELETE FROM public.places WHERE id IN ('${placeA}', '${placeB}', '${placeR}');`);
  });

  test("D1 untyped is MOMENT; a chosen type holds; a type off §4's list is refused", () => {
    assert.equal(typeOf(newMemory({})), "MOMENT");
    assert.equal(typeOf(newMemory({ memory_type: "REUNION" })), "REUNION");
    assert.throws(() => newMemory({ memory_type: "VACATION" }), /memories_memory_type_check/);
  });

  test("D2 a catalog place records its name at the write; a rename and a merge later leave it alone", () => {
    const m = newMemory({ place_id: placeA });
    assert.equal(nameOf(m), `Cafe A ${TAG}`);
    exec(`UPDATE public.places SET name = 'Renamed ${TAG}', merged_into_place_id = '${placeB}' WHERE id = '${placeA}';`);
    assert.equal(nameOf(m), `Cafe A ${TAG}`);
    exec(`UPDATE public.places SET name = 'Cafe A ${TAG}', merged_into_place_id = NULL WHERE id = '${placeA}';`);
  });

  test("D3 the same place never rewrites its text", () => {
    const m = newMemory({ place_id: "fsq:" + TAG, place_display_name_at_occurrence: "Pho 10" });
    asService(`UPDATE public.memories SET place_display_name_at_occurrence = 'Rewritten' WHERE id = '${m}';`);
    asService(`UPDATE public.memories SET place_id = place_id, place_display_name_at_occurrence = 'Rewritten', title = 'x' WHERE id = '${m}';`);
    assert.equal(nameOf(m), "Pho 10");
  });

  test("D4 a new place gets its own text, never the old one's; no place, no name", () => {
    const m = newMemory({ place_id: "fsq:" + TAG, place_display_name_at_occurrence: "Pho 10" });
    asService(`UPDATE public.memories SET place_id = '${placeR}' WHERE id = '${m}';`);
    assert.equal(nameOf(m), `Ramen R ${TAG}`);
    asService(`UPDATE public.memories SET place_id = 'fsq:new-${TAG}' WHERE id = '${m}';`);
    assert.equal(nameOf(m), "<null>");
    asService(`UPDATE public.memories SET place_id = NULL, place_display_name_at_occurrence = 'Orphan' WHERE id = '${m}';`);
    assert.equal(nameOf(m), "<null>");
  });

  test("D5 a pick keeps the writer's trimmed text; a NULL text takes ONE first capture", () => {
    assert.equal(nameOf(newMemory({ place_id: "fsq:a-" + TAG, place_display_name_at_occurrence: "  Bun Cha 34  " })), "Bun Cha 34");
    const bare = newMemory({ place_id: "fsq:b-" + TAG });
    assert.equal(nameOf(bare), "<null>");
    asService(`UPDATE public.memories SET place_display_name_at_occurrence = 'First' WHERE id = '${bare}';`);
    asService(`UPDATE public.memories SET place_display_name_at_occurrence = 'Second' WHERE id = '${bare}';`);
    assert.equal(nameOf(bare), "First");
  });

  test("D6 the function is not executable by a client role; both flags exist and are FALSE", () => {
    assert.equal(scalar("SELECT has_function_privilege('anon', 'public.memory_place_occurrence_name_fill()', 'EXECUTE')"), "f");
    assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public.memory_place_occurrence_name_fill()', 'EXECUTE')"), "f");
    assert.equal(scalar("SELECT string_agg(flag || '=' || enabled::text, ',' ORDER BY flag) FROM public.feature_flags WHERE flag IN ('memory_type_enabled', 'memory_place_occurrence_name_enabled')"),
      "memory_place_occurrence_name_enabled=false,memory_type_enabled=false");
  });
});
