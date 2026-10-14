/**
 * memoryMediaSegments.db.test.ts — the EXECUTING witness for 3809
 * (`memory_media_segments`, logical segments of a Memory's video item without
 * duplicating the original), on the full chain scripts/local-db/up.sh replays
 * (production's 2026-08-19 baseline structure plus every migration).
 * Census-highlights-memories H184 (§BP); B58 cluster MEM-SEGMENTS.
 *
 * The route suite (src/test/memorySegments.test.ts) drives the API over a fake;
 * this file proves the SQL the fake stands in for, as the API's service role
 * writes it and as a client key would reach it, with every other trigger and
 * grant the chain installs on memories and memory_items in place.
 *
 *   S1  a segment is a window and a label — no column can hold a path; the window
 *       CHECK, the label CHECK and the one-row-per-window UNIQUE hold
 *   S2  the integrity trigger: the item must be on the Memory, owner_id must be
 *       the Memory's owner, on INSERT and on UPDATE
 *   S3  erasure: a segment goes with its item, its Memory and its owner's account
 *   S4  no client role reaches the table — not even the owner's own JWT
 *   S5  RLS on with no policy; the API's role reads, marks and removes, and can
 *       neither rewrite nor truncate
 *   S6  the trigger function is SECURITY INVOKER and no client role may call it
 *   S7  the rollback refuses while a segment exists and drops everything when
 *       none does (inside a transaction that is rolled back: the shared database
 *       keeps 3809 for every suite after this one)
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { HAVE_DB, exec, psql, scalar, seedUser, deleteUser, asUser } from "./localDb.js";

const ROLLBACK = new URL("../../../../../db/rollback/2026-10-14-3809-memory-media-segments-rollback.sql", import.meta.url);

let owner = "";
let other = "";
const TAG = `mms${randomUUID().slice(0, 8)}`;

const asService = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });
function newMemory(ownerId: string): string {
  const id = randomUUID();
  asService(`INSERT INTO public.memories (id, owner_id, title, visibility) VALUES ('${id}', '${ownerId}', '${TAG}', 'public');`);
  return id;
}
function newVideo(memoryId: string, position = 0): string {
  const id = randomUUID();
  asService(`INSERT INTO public.memory_items (id, memory_id, media_url, media_type, position) VALUES ('${id}', '${memoryId}', 'post-media/${TAG}/${id}.mp4', 'video/mp4', ${position});`);
  return id;
}
function mark(memoryId: string, itemId: string, ownerId: string, startMs: number, endMs: number, label: string | null = null): string {
  const id = randomUUID();
  asService(`INSERT INTO public.memory_media_segments (id, memory_id, item_id, owner_id, start_ms, end_ms, label)
             VALUES ('${id}', '${memoryId}', '${itemId}', '${ownerId}', ${startMs}, ${endMs}, ${label === null ? "NULL" : `'${label}'`});`);
  return id;
}
const segmentsOf = (itemId: string) => scalar(`SELECT count(*) FROM public.memory_media_segments WHERE item_id = '${itemId}'`);
/** The psql stderr of a script that must fail. */
function refusal(script: string): string {
  const r = psql(script, { single: true });
  assert.notEqual(r.status, 0, `expected a refusal from:\n${script}`);
  return r.stderr;
}

describe("3809 on the full chain: logical segments of a Memory's video, no copy of anything", { skip: !HAVE_DB }, () => {
  before(() => {
    owner = seedUser(TAG);
    other = seedUser(`${TAG}o`);
  });
  after(() => {
    if (owner) deleteUser(owner); // cascades the Memories, their items, and with them the segments
    if (other) deleteUser(other);
  });

  test("S1 a segment is a window and a label: no path column, the CHECKs and the UNIQUE hold", () => {
    assert.equal(
      scalar(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memory_media_segments'`),
      "id,memory_id,item_id,owner_id,start_ms,end_ms,label,created_at",
      "no column can hold a storage path, URL or bucket: a segment never duplicates the original",
    );
    const m = newMemory(owner);
    const v = newVideo(m);
    mark(m, v, owner, 0, 1_000, "Opening");
    mark(m, v, owner, 1_000, 2_500);
    assert.equal(segmentsOf(v), "2");
    assert.match(refusal(`SET LOCAL ROLE service_role; INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('${m}', '${v}', '${owner}', 0, 1000);`), /memory_media_segments_window_unique|duplicate key/);
    for (const [s, e] of [[-1, 10], [10, 10], [11, 10]] as const) {
      assert.match(refusal(`SET LOCAL ROLE service_role; INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('${m}', '${v}', '${owner}', ${s}, ${e});`), /memory_media_segments_bounds_check/, `[${s}, ${e})`);
    }
    assert.match(refusal(`SET LOCAL ROLE service_role; INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms, label) VALUES ('${m}', '${v}', '${owner}', 5000, 6000, '');`), /memory_media_segments_label_check/);
    assert.match(refusal(`SET LOCAL ROLE service_role; INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms, label) VALUES ('${m}', '${v}', '${owner}', 5000, 6000, repeat('x', 121));`), /memory_media_segments_label_check/);
    mark(m, v, owner, 5_000, 6_000, "x".repeat(120));
    assert.equal(segmentsOf(v), "3");
  });

  test("S2 the integrity trigger: the item must be on the Memory, and owner_id must be its owner", () => {
    const m = newMemory(owner);
    const elsewhere = newMemory(owner);
    const v = newVideo(m);
    const foreign = newVideo(elsewhere);
    assert.match(refusal(`SET LOCAL ROLE service_role; INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('${m}', '${foreign}', '${owner}', 0, 10);`), /is not on Memory/);
    assert.match(refusal(`SET LOCAL ROLE service_role; INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('${m}', '${v}', '${other}', 0, 10);`), /owner_id must be the owner/);
    const s = mark(m, v, owner, 0, 10);
    // The table owner (not the API) moving a segment onto another Memory's item is refused too.
    assert.match(refusal(`UPDATE public.memory_media_segments SET item_id = '${foreign}' WHERE id = '${s}';`), /is not on Memory/);
    assert.match(refusal(`UPDATE public.memory_media_segments SET owner_id = '${other}' WHERE id = '${s}';`), /owner_id must be the owner/);
    assert.equal(segmentsOf(foreign), "0");
  });

  test("S3 a segment goes with its item, its Memory, and its owner's account", () => {
    const m = newMemory(owner);
    const v = newVideo(m);
    const w = newVideo(m, 1);
    mark(m, v, owner, 0, 10);
    mark(m, w, owner, 0, 10);
    asService(`DELETE FROM public.memory_items WHERE id = '${v}';`);
    assert.equal(segmentsOf(v), "0", "removing the video removes its segments");
    assert.equal(segmentsOf(w), "1", "and only its own");
    asService(`DELETE FROM public.memories WHERE id = '${m}';`);
    assert.equal(segmentsOf(w), "0", "the Memory's hard delete takes the rest");
    const gone = seedUser(`${TAG}g`);
    const g = newMemory(gone);
    mark(g, newVideo(g), gone, 0, 10);
    deleteUser(gone);
    assert.equal(scalar(`SELECT count(*) FROM public.memory_media_segments WHERE owner_id = '${gone}'`), "0");
  });

  test("S4 no client role reaches the table, not even through the owner's own JWT", () => {
    const m = newMemory(owner);
    const v = newVideo(m);
    mark(m, v, owner, 0, 10, "mine");
    for (const role of ["anon", "authenticated"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.memory_media_segments', '${p}')`), "f", `${role} ${p}`);
      }
      assert.equal(scalar(`SELECT has_any_column_privilege('${role}', 'public.memory_media_segments', 'SELECT')`), "f", `${role} column SELECT`);
    }
    assert.throws(() => asUser(owner, `SELECT count(*) FROM public.memory_media_segments;`), /permission denied/);
    assert.throws(() => asUser(owner, `INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('${m}', '${v}', '${owner}', 20, 30);`), /permission denied/);
    assert.throws(() => asUser(owner, `DELETE FROM public.memory_media_segments WHERE item_id = '${v}';`), /permission denied/);
    assert.equal(segmentsOf(v), "1", "the owner's JWT changed nothing past the API");
  });

  test("S5 RLS on with no policy; service_role reads, marks and removes, and can neither rewrite nor truncate", () => {
    assert.equal(scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memory_media_segments'::regclass`), "t");
    assert.equal(scalar(`SELECT count(*) FROM pg_policy WHERE polrelid = 'public.memory_media_segments'::regclass`), "0");
    for (const p of ["SELECT", "INSERT", "DELETE"]) {
      assert.equal(scalar(`SELECT has_table_privilege('service_role', 'public.memory_media_segments', '${p}')`), "t", p);
    }
    const m = newMemory(owner);
    const v = newVideo(m);
    const s = mark(m, v, owner, 0, 10);
    assert.match(refusal(`SET LOCAL ROLE service_role; UPDATE public.memory_media_segments SET end_ms = 20 WHERE id = '${s}';`), /permission denied/);
    assert.match(refusal(`SET LOCAL ROLE service_role; TRUNCATE public.memory_media_segments;`), /permission denied/);
    asService(`DELETE FROM public.memory_media_segments WHERE id = '${s}';`);
    assert.equal(segmentsOf(v), "0");
  });

  test("S6 the integrity trigger runs as its caller, is enabled, and no client role may call its function", () => {
    assert.equal(scalar(`SELECT prosecdef FROM pg_proc WHERE oid = 'public.memory_media_segments_integrity()'::regprocedure`), "f");
    assert.equal(scalar(`SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.memory_media_segments'::regclass AND tgname = 'memory_media_segments_integrity'`), "O");
    for (const role of ["anon", "authenticated"]) {
      assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.memory_media_segments_integrity()', 'EXECUTE')`), "f", role);
    }
  });

  test("S7 the rollback refuses while a segment exists, and drops all three objects when none does", () => {
    const body = readFileSync(ROLLBACK, "utf8").replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
    const m = newMemory(owner);
    const v = newVideo(m);
    const s = mark(m, v, owner, 0, 10);
    // Refused: this suite's own row is enough.
    assert.match(refusal(`BEGIN;\n${body}\nROLLBACK;`), /ROLLBACK REFUSED \(3809\)/);
    // Remove every segment THIS suite marked (its own two users own them all), roll back inside a transaction,
    // observe, and undo — the shared database keeps 3809 for every suite after this one.
    asService(`DELETE FROM public.memory_media_segments WHERE owner_id IN ('${owner}', '${other}');`);
    assert.equal(scalar(`SELECT count(*) FROM public.memory_media_segments WHERE id = '${s}'`), "0");
    const others = scalar(`SELECT count(*) FROM public.memory_media_segments`);
    if (others !== "0") {
      // Another suite left a segment behind: the refusal is the rollback's correct answer, and the drop path is
      // proved by the PGlite rehearsal (sql/rehearsals/3809_01). Never delete another suite's rows here.
      assert.match(refusal(`BEGIN;\n${body}\nROLLBACK;`), /ROLLBACK REFUSED \(3809\)/);
      return;
    }
    const out = exec(`BEGIN;\n${body}\nSELECT to_regclass('public.memory_media_segments') IS NULL, (SELECT count(*) FROM pg_proc WHERE proname = 'memory_media_segments_integrity');\nROLLBACK;`);
    assert.ok(out.includes("t|0"), `inside the rolled-back transaction the table and the function are gone: ${out.join(" / ")}`);
    assert.equal(scalar(`SELECT to_regclass('public.memory_media_segments') IS NOT NULL`), "t", "and after it 3809 is back as it was");
  });
});
