/**
 * memoryProjectorPlaceLane — census-map M42 (and M123 downstream of it),
 * asserted BEHAVIOURALLY against real PostgreSQL.
 *
 * Run: pnpm run test:db-local   (or with LOCAL_DB_URL set)
 *
 * WHY THIS FILE EXISTS RATHER THAN A CONTRACT TEST
 * ================================================
 * `project_user_memory` is SQL, so the ordinary suite — which has no database —
 * can only assert over migration TEXT. That is what
 * `mapMemoryProducer.test.ts` does, and it is worth having: it is the guard
 * that would have rejected PR #451's one-argument redefinition. But a text
 * guard cannot answer the question M42 actually asks, which is whether the
 * PLACE lane PRODUCES ANYTHING.
 *
 * The defect it is aimed at is specifically invisible to counting: the lane
 * read a table with no writers, so it returned zero rows and reported success.
 * An empty table and an empty result are the same observation. The only way to
 * tell them apart is to seed a user who HAS saves — in the tables saves
 * actually land in — and then look at what comes out.
 *
 * THE ANTI-VACUITY ARM IS THE POINT. Every case below seeds a user with ZERO
 * rows in the legacy table and several saves reachable only through the union.
 * If the PLACE lane were still reading the legacy table, `place` would be
 * absent while the other three lanes were populated — which is exactly the
 * shape the pre-fix function produces, and is asserted here as the thing that
 * must NOT happen. A run where nothing at all is projected cannot pass: the
 * other three lanes are asserted non-empty in the same breath, so an empty
 * database fails rather than passing quietly.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { HAVE_DB, exec, rows, seedUser, deleteUser } from "./localDb.js";

// The viewer and the followee come from the harness's own seedUser, which knows
// the shape of this database's auth.users shim — it has no instance_id, and
// hand-writing the insert is how the first draft of this file failed.
let U = "";
let F = "";
const P_DIRECT = "0dd0dd00-0000-4000-8000-0000000a42a1";
const P_CANON = "0dd0dd00-0000-4000-8000-0000000a42b1";
const P_OSM = "0dd0dd00-0000-4000-8000-0000000a42d1";
const CANON_LOC = "0dd0dd00-0000-4000-8000-0000000a42bc";
const UNBRIDGEABLE = "0dd0dd00-0000-4000-8000-0000000a42ff";
const LIST_1 = "0dd0dd00-0000-4000-8000-0000000a42e1";
const LIST_2 = "0dd0dd00-0000-4000-8000-0000000a42e2";

function cleanup(): void {
  exec(`
    DELETE FROM public.memory_projections WHERE user_id = '${U}';
    DELETE FROM public.memory_events      WHERE user_id = '${U}';
    DELETE FROM public.wishlist_places    WHERE user_id = '${U}';
    DELETE FROM public.discovery_place_saves WHERE user_id = '${U}';
    DELETE FROM public.user_follows       WHERE follower_id = '${U}';
    DELETE FROM public.compass_user_preferences WHERE user_id = '${U}';
    DELETE FROM public.compass_graph_edges WHERE src_key = '${U}';
    DELETE FROM public.discovery_places   WHERE id IN ('${P_DIRECT}','${P_CANON}','${P_OSM}');
    DELETE FROM public.places             WHERE id = '${CANON_LOC}';
  `);
}

describe("M42 — the memory projector's PLACE lane, against a real database", { skip: !HAVE_DB }, () => {
  before(() => {
    U = seedUser("m42_viewer");
    F = seedUser("m42_followee");
    cleanup();
    exec(`
      -- EPISODIC: two cities.
      INSERT INTO public.compass_graph_edges
        (src_type, src_key, dst_type, dst_key, edge_type, observed_count, first_seen, last_seen)
      VALUES ('person','${U}','city','lisbon','visited',3,'2026-01-01','2026-02-01'),
             ('person','${U}','city','porto','returned_to',2,'2026-03-01','2026-04-01');

      -- SEMANTIC: two interests and one travel style.
      INSERT INTO public.compass_user_preferences (user_id, interests, travel_styles)
      VALUES ('${U}', ARRAY['surfing','pastry'], ARRAY['slow'])
      ON CONFLICT (user_id) DO UPDATE
        SET interests = EXCLUDED.interests, travel_styles = EXCLUDED.travel_styles;

      -- SOCIAL: one follow.
      INSERT INTO public.user_follows (follower_id, following_id, created_at)
      VALUES ('${U}','${F}','2026-05-01') ON CONFLICT DO NOTHING;

      -- PLACE: three venues, reachable ONLY through the union.
      -- The canonical branch needs a real places row: discovery_places
      -- .canonical_location_id carries an FK to it, and migration 2053 is the
      -- reason that bridge exists at all.
      INSERT INTO public.places (id, name, normalized_name)
      VALUES ('${CANON_LOC}', 'Cafe', 'cafe')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.discovery_places (id, canonical_location_id, osm_id, name, city, place_type)
      VALUES ('${P_DIRECT}', NULL, NULL, 'Miradouro', 'Lisbon', 'viewpoint'),
             ('${P_CANON}', '${CANON_LOC}', NULL, 'Cafe', 'Porto', 'cafe'),
             ('${P_OSM}', NULL, 'node/999000111', 'Ponte', 'Porto', 'attraction')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.discovery_place_saves (user_id, place_id, saved_at)
      VALUES ('${U}','${P_DIRECT}','2026-03-01');

      -- Saved to TWO lists: one venue, two rows — dedupe must take MIN(saved_at).
      INSERT INTO public.wishlist_places (user_id, place_id, list_id, saved_at, place_data)
      VALUES ('${U}','db/${CANON_LOC}','${LIST_1}','2026-04-01','{}'::jsonb),
             ('${U}','db/${CANON_LOC}','${LIST_2}','2026-05-01','{}'::jsonb),
             ('${U}','node/999000111','${LIST_1}','2026-06-01','{}'::jsonb),
             -- A bare uuid bridges to no discovery_places row and must be excluded.
             ('${U}','${UNBRIDGEABLE}','${LIST_1}','2026-07-01','{}'::jsonb);
    `);
  });

  after(() => {
    if (!HAVE_DB) return;
    cleanup();
    if (U) deleteUser(U);
    if (F) deleteUser(F);
  });

  it("the fixture has NO rows in the legacy table — otherwise the PLACE arm proves nothing", () => {
    const [r] = rows<{ n: string }>(`SELECT count(*)::text AS n FROM public.saved_places WHERE user_id = '${U}'`);
    assert.equal(r.n, "0");
  });

  it("projects all four lanes, and PLACE is not the empty one", () => {
    // p_enforce_flag = false: the flag gate is the caller's contract and is
    // exercised by its own case below, not smuggled into this one.
    exec(`SELECT public.project_user_memory('${U}'::uuid, false);`);
    const got = rows<{ memory_type: string; n: string }>(
      `SELECT memory_type, count(*)::text AS n FROM public.memory_projections
       WHERE user_id = '${U}' GROUP BY memory_type`,
    );
    const by = Object.fromEntries(got.map((g) => [g.memory_type, Number(g.n)]));

    // All four, asserted together. Three non-zero lanes are what make the
    // fourth's count meaningful — on an empty database this case fails.
    assert.ok((by["episodic"] ?? 0) > 0, `episodic lane produced nothing: ${JSON.stringify(by)}`);
    assert.ok((by["semantic"] ?? 0) > 0, `semantic lane produced nothing: ${JSON.stringify(by)}`);
    assert.ok((by["social"] ?? 0) > 0, `social lane produced nothing: ${JSON.stringify(by)}`);
    assert.ok((by["place"] ?? 0) > 0, `PLACE lane produced nothing — the M42 defect: ${JSON.stringify(by)}`);
  });

  it("resolves the union to one row per venue: three venues, not four and not five", () => {
    // Five source rows (1 bookmark + 3 wishlist bridgeable + 1 unbridgeable)
    // across three resolvable venues.
    const [r] = rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.memory_projections
       WHERE user_id = '${U}' AND memory_type = 'place'`,
    );
    assert.equal(r.n, "3", "expected exactly the three bridgeable venues");
  });

  it("dedupes a two-list save to the FIRST save, not the re-save", () => {
    const [r] = rows<{ at: string }>(
      `SELECT to_char(last_supported_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS at
       FROM public.memory_projections
       WHERE user_id = '${U}' AND memory_type = 'place' AND subject_id = '${P_CANON}'`,
    );
    // MIN(saved_at) is 2026-04-01; MAX would be 2026-05-01 and would let a
    // re-save to another list rewrite history.
    assert.equal(r.at, "2026-04-01");
  });

  it("excludes the bare uuid rather than inventing a place for it", () => {
    const [r] = rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.memory_projections
       WHERE user_id = '${U}' AND subject_id = '${UNBRIDGEABLE}'`,
    );
    assert.equal(r.n, "0");
  });

  it("bridges all three id-spaces — direct, canonical and OSM", () => {
    const got = rows<{ subject_id: string }>(
      `SELECT subject_id FROM public.memory_projections
       WHERE user_id = '${U}' AND memory_type = 'place' ORDER BY subject_id`,
    ).map((g) => g.subject_id);
    assert.deepEqual([...got].sort(), [P_DIRECT, P_CANON, P_OSM].sort());
  });

  it("keeps the two-argument signature, and exactly one overload exists", () => {
    // The defect PR #451 would have shipped: a one-argument CREATE OR REPLACE
    // adds a function instead of replacing one, and the real caller — which
    // passes two arguments — keeps reaching the old body.
    const got = rows<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'project_user_memory'`,
    );
    assert.equal(got.length, 1, `expected exactly one overload, found ${got.length}: ${JSON.stringify(got)}`);
    assert.equal(got[0].sig, "project_user_memory(uuid,boolean)");
  });

  it("honours the flag gate its caller relies on", () => {
    // project_user_memory_with_retraction passes false deliberately. With the
    // flag off and enforcement ON, the function must project nothing.
    const before = rows<{ enabled: boolean | null }>(
      `SELECT enabled FROM public.feature_flags WHERE flag = 'memory_projection'`,
    );
    const wasEnabled = before.length > 0 ? before[0].enabled : null;
    try {
      exec(`
        INSERT INTO public.feature_flags (flag, enabled) VALUES ('memory_projection', false)
        ON CONFLICT (flag) DO UPDATE SET enabled = false;
      `);
      const [r] = rows<{ n: string }>(`SELECT public.project_user_memory('${U}'::uuid, true)::text AS n`);
      assert.equal(r.n, "0", "with the flag off and enforcement on, nothing may be projected");
    } finally {
      if (wasEnabled === null) {
        exec(`DELETE FROM public.feature_flags WHERE flag = 'memory_projection';`);
      } else {
        exec(`
          INSERT INTO public.feature_flags (flag, enabled) VALUES ('memory_projection', ${wasEnabled})
          ON CONFLICT (flag) DO UPDATE SET enabled = ${wasEnabled};
        `);
      }
    }
  });
});
