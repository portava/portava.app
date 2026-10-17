import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migrationRoot = new URL("../migrations/", import.meta.url);
const now = "2031-07-15T00:00:00.000Z";
const safePlace = "10000000-0000-4000-a000-000000000001";
const protectedPlace = "10000000-0000-4000-a000-000000000002";
const unknownPlace = "10000000-0000-4000-a000-000000000003";

async function migration(name: string): Promise<string> {
  return readFile(new URL(name, migrationRoot), "utf8");
}

async function installFunctions(database: any, name: string): Promise<void> {
  const definitions = [...(await migration(name)).matchAll(/^CREATE OR REPLACE FUNCTION[\s\S]*?^\$fn\$;/gm)];
  assert.ok(definitions.length > 0, `actual function definitions found in ${name}`);
  for (const definition of definitions) await database.exec(definition[0]);
}

async function fixture(database: any): Promise<void> {
  await database.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.protected_zones (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), active boolean DEFAULT true,
      shape text, center_lat double precision, center_lng double precision, radius_meters double precision, ring jsonb);
    ALTER TABLE public.protected_zones ENABLE ROW LEVEL SECURITY;
    CREATE TABLE public.discovery_places (id uuid PRIMARY KEY, submitted_by uuid, city text, neighborhood text,
      lat double precision, lng double precision, created_at timestamptz, category text, place_type text);
    CREATE TABLE public.rank_events (item_id text, user_id uuid, outcome text, served_at timestamptz, outcome_at timestamptz, surface text);
    CREATE TABLE public.feature_flags (flag text PRIMARY KEY, enabled boolean);
    CREATE TABLE public.memories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid, place_id text,
      canonical_location_id uuid, state text, visibility text, created_at timestamptz);
    CREATE TABLE public.memory_resurfacing_preferences (memory_id uuid, owner_id uuid, control text);
    CREATE TABLE public.memory_corrections (id uuid DEFAULT gen_random_uuid(), memory_id uuid, owner_id uuid,
      field text, kind text, place_id text, canonical_location_id uuid, created_at timestamptz);
  `);
  const initial = await migration("2892_place_momentum.sql");
  const table = initial.match(/^CREATE TABLE IF NOT EXISTS public\.place_momentum \([\s\S]*?^\);/m);
  assert.ok(table);
  await database.exec(table[0]);
  await database.exec(`ALTER TABLE public.place_momentum ADD COLUMN feature_version text,
    ADD COLUMN recent_unique_travelers integer, ADD COLUMN window_unique_travelers integer, ADD COLUMN source_surface text;`);
  await installFunctions(database, "2892_place_momentum.sql");
  await installFunctions(database, "3435_place_momentum_feature_version.sql");
  await database.exec(await migration("3476_discovery_trend_v2_store.sql"));
  await installFunctions(database, "3477_discovery_trend_v2_rebuild.sql");
  await installFunctions(database, "3497_discovery_trend_post_convergence_stored.sql");
  await installFunctions(database, "3726_discovery_trend_post_latest_correction.sql");
  await database.exec(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
    INSERT INTO public.feature_flags VALUES ('discovery_trend_normalised_enabled',false), ('discovery_trend_post_convergence_enabled',false);
    INSERT INTO public.discovery_places (id,lat,lng,city,neighborhood,created_at,category) VALUES
      ('${safePlace}',0,0.01,'test-city','same-cell','2030-01-01','park'),
      ('${protectedPlace}',0,0,'test-city','same-cell','2030-01-01','park'),
      ('${unknownPlace}',NULL,NULL,'test-city','same-cell','2030-01-01','park');
    INSERT INTO public.protected_zones (shape,center_lat,center_lng,radius_meters) VALUES ('circle',0,0,100);
    INSERT INTO public.rank_events
      SELECT place, ('20000000-0000-4000-a000-' || lpad(sequence::text,12,'0'))::uuid, 'save',
        '${now}'::timestamptz - sequence * interval '1 hour', '${now}'::timestamptz - sequence * interval '1 hour', 'discovery'
      FROM unnest(ARRAY['db/${safePlace}','db/${protectedPlace}','db/${unknownPlace}','osm:missing']) place
      CROSS JOIN generate_series(1,35) sequence;
    SET ROLE service_role;
  `);
}

test("executed SQL excludes protected and unlocatable contributions before all trend aggregates", { skip: !process.env.DISCOVERY_PGLITE_MODULE }, async (context) => {
  const { PGlite } = await import(process.env.DISCOVERY_PGLITE_MODULE!);
  const database = new PGlite();
  try {
    await fixture(database);
    const original = await database.query("SELECT o_key FROM public.discovery_trend_windows_v2($1,'place') ORDER BY o_key", [now]);
    assert.equal(original.rows.length, 4, "unpatched functions include protected, unknown and noncanonical places");
    const originalArea = await database.query("SELECT o_recent_exposures FROM public.discovery_trend_windows_v2($1,'area')", [now]);
    assert.equal(originalArea.rows[0].o_recent_exposures, 105, "unpatched area combines all three canonical places");
    await database.exec("BEGIN");
    await database.query("DELETE FROM public.rank_events WHERE item_id <> $1", [`db/${safePlace}`]);
    await database.query("SELECT public.rebuild_place_momentum_v2($1)", [now]);
    const placeReadingSql = "SELECT to_jsonb(snapshot)-'id'-'created_at'-'feature_version' AS reading FROM public.place_momentum snapshot ORDER BY place_id";
    const areaReadingSql = "SELECT to_jsonb(snapshot)-'id'-'created_at'-'feature_version' AS reading FROM public.area_momentum snapshot ORDER BY cell_key";
    const safePlaceBaseline = (await database.query(placeReadingSql)).rows;
    const safeAreaBaseline = (await database.query(areaReadingSql)).rows;
    await database.exec("ROLLBACK");
    await database.exec("RESET ROLE");
    const patch = await migration("3988_discovery_trend_protected_contributions.sql");
    await database.exec(patch);
    await database.exec(patch);
    await database.exec("SET ROLE service_role");

    await context.test("place, area and context filter before aggregation", async () => {
      const places = await database.query("SELECT o_key,o_recent_exposures FROM public.discovery_trend_windows_v2($1,'place')", [now]);
      assert.deepEqual(places.rows, [{ o_key: `db/${safePlace}`, o_recent_exposures: 35 }]);
      const areas = await database.query("SELECT o_recent_exposures,o_recent_groups FROM public.discovery_trend_windows_v2($1,'area')", [now]);
      assert.deepEqual(areas.rows, [{ o_recent_exposures: 35, o_recent_groups: 35 }]);
      const canonical = await database.query("SELECT place_key FROM public.discovery_trend_place_context()");
      assert.deepEqual(canonical.rows, [{ place_key: safePlace }]);
    });

    await context.test("both persisted producers carry privacy provenance and exclude unsafe rows", async () => {
      await database.query("SELECT public.rebuild_place_momentum($1)", [now]);
      const first = await database.query("SELECT place_id,total_weight,feature_version FROM public.place_momentum");
      assert.deepEqual(first.rows, [{ place_id: `db/${safePlace}`, total_weight: 140, feature_version: "discovery-row-activity-v2+protected-contributions-v1" }]);
      await database.exec("UPDATE public.feature_flags SET enabled=true WHERE flag='discovery_trend_normalised_enabled'");
      await database.query("SELECT public.rebuild_place_momentum($1)", [now]);
      await database.query("SELECT public.rebuild_place_momentum_v2($1)", [now]);
      const places = await database.query("SELECT place_id,recent_exposures,feature_version FROM public.place_momentum");
      assert.deepEqual(places.rows, [{ place_id: `db/${safePlace}`, recent_exposures: 35, feature_version: "discovery-exposure-activity-v3+protected-contributions-v1" }]);
      const areas = await database.query("SELECT recent_exposures,feature_version FROM public.area_momentum");
      assert.deepEqual(areas.rows, [{ recent_exposures: 35, feature_version: "discovery-exposure-activity-v3+protected-contributions-v1" }]);
      assert.deepEqual((await database.query(placeReadingSql)).rows, safePlaceBaseline, "all arithmetic matches the previous producer over only eligible inputs");
      assert.deepEqual((await database.query(areaReadingSql)).rows, safeAreaBaseline);
      await database.exec("UPDATE public.feature_flags SET enabled=true WHERE flag='discovery_trend_post_convergence_enabled'");
      await database.query("SELECT public.rebuild_place_momentum($1)", [now]);
      assert.equal((await database.query("SELECT feature_version FROM public.place_momentum")).rows[0].feature_version,
        "discovery-exposure-activity-v3+post-after-visit-v1+protected-contributions-v1");
    });

    await context.test("post convergence preserves owner controls and rejects protected authors' place contributions", async () => {
      await database.exec(`
        INSERT INTO public.rank_events SELECT place, actor, 'save', '2031-07-10', '2031-07-10', 'discovery'
          FROM unnest(ARRAY['db/${safePlace}','db/${protectedPlace}']) place
          CROSS JOIN unnest(ARRAY['30000000-0000-4000-a000-000000000001'::uuid,'30000000-0000-4000-a000-000000000002'::uuid]) actor;
        INSERT INTO public.memories (owner_id,place_id,state,visibility,created_at)
          SELECT actor, place,'published','public', CASE WHEN actor::text LIKE '%001' THEN '2031-07-14 01:00'::timestamptz ELSE '2031-07-14 02:00'::timestamptz END
          FROM unnest(ARRAY['${safePlace}','${protectedPlace}']) place
          CROSS JOIN unnest(ARRAY['30000000-0000-4000-a000-000000000001'::uuid,'30000000-0000-4000-a000-000000000002'::uuid]) actor;
      `);
      assert.deepEqual((await database.query("SELECT * FROM public.discovery_trend_post_groups_v2($1)", [now])).rows,
        [{ o_key: `db/${safePlace}`, o_win: "recent", o_added: 2 }]);
      await database.exec("INSERT INTO public.memory_resurfacing_preferences SELECT id,owner_id,'KEEP_PRIVATE_FOREVER' FROM public.memories");
      assert.deepEqual((await database.query("SELECT * FROM public.discovery_trend_post_groups_v2($1)", [now])).rows, []);
      await database.exec(`DELETE FROM public.memory_resurfacing_preferences;
        INSERT INTO public.memory_corrections (memory_id,owner_id,field,kind,place_id,created_at)
          SELECT id,owner_id,'place','assert','${unknownPlace}','2031-07-14 03:00' FROM public.memories;`);
      assert.deepEqual((await database.query("SELECT * FROM public.discovery_trend_post_groups_v2($1)", [now])).rows, []);
      await database.exec(`INSERT INTO public.memory_corrections (memory_id,owner_id,field,kind,place_id,created_at)
          SELECT id,owner_id,'place','assert',place_id,'2031-07-14 04:00' FROM public.memories;`);
      assert.deepEqual((await database.query("SELECT * FROM public.discovery_trend_post_groups_v2($1)", [now])).rows,
        [{ o_key: `db/${safePlace}`, o_win: "recent", o_added: 2 }]);
      await database.exec(`INSERT INTO public.memory_corrections (memory_id,owner_id,field,kind,place_id,created_at)
          SELECT id,owner_id,'place','reject',place_id,'2031-07-14 05:00' FROM public.memories;`);
      assert.deepEqual((await database.query("SELECT * FROM public.discovery_trend_post_groups_v2($1)", [now])).rows, []);
    });

    await context.test("invalid positions, malformed policy, circle boundaries and polygon edges fail closed", async () => {
      const clear = async (latitude: number | null, longitude: number | null) =>
        (await database.query("SELECT public.discovery_trend_position_is_clear($1,$2) AS clear", [latitude, longitude])).rows[0].clear;
      assert.equal(await clear(0, 0), false);
      assert.equal(await clear(0, 0.01), true);
      assert.equal(await clear(null, 1), false);
      assert.equal(await clear(91, 0), false);
      assert.equal(await clear(0, 181), false);
      await database.exec("UPDATE public.protected_zones SET center_lng=179.999,radius_meters=300");
      assert.equal(await clear(0, -179.999), false);
      await database.exec("UPDATE public.protected_zones SET shape='polygon',center_lat=NULL,center_lng=NULL,radius_meters=NULL,ring='[[0,0],[1,0],[1,1],[0,1]]'");
      for (const [latitude, longitude] of [[0,0],[0,0.5],[0.5,0.5],[1,0.5]]) assert.equal(await clear(latitude!, longitude!), false);
      assert.equal(await clear(2, 2), true);
      for (const ring of ['[[0,0],[1,0],[1,1],[0,1],[0,0]]', '[[0,1],[1,1],[1,0],[0,0]]',
        '[[0,0],[1,0],[1,1],[0.5,0.5],[0,1]]', '[[0,0],[0.5,0],[1,0],[1,1],[0,1]]']) {
        await database.query("UPDATE public.protected_zones SET ring=$1::jsonb", [ring]);
        assert.equal(await clear(2, 2), true);
        assert.equal(await clear(0.2, 0.5), false);
      }
      for (const ring of ['[[0,0],["bad",1],[1,0]]','[[179,0],[-179,0],[-179,1]]','[[0,0],[1,1],[2,2]]',
        '[[0,0],[4,4],[0,4],[4,0],[6,1]]', '[[0,0],[4,0],[2,0],[2,4],[0,4]]',
        '[[0,0],[4,0],[4,4],[0,4],[4,0]]']) {
        await database.query("UPDATE public.protected_zones SET ring=$1::jsonb", [ring]);
        assert.equal(await clear(40, 40), false);
      }
      const largeRing = JSON.stringify(Array.from({ length: 258 }, (_, index) => [Math.cos(index * Math.PI / 129), Math.sin(index * Math.PI / 129)]));
      await database.query("UPDATE public.protected_zones SET ring=$1::jsonb", [largeRing]);
      assert.equal(await clear(40, 40), false);
      for (const pole of [-90, 90]) {
        await database.query("UPDATE public.protected_zones SET ring=$1::jsonb", [JSON.stringify([[10, pole * 88 / 90], [20, pole * 88 / 90], [15, pole]])]);
        for (const longitude of [-180, 0, 15, 180]) assert.equal(await clear(pole, longitude), false);
      }
      await database.exec("UPDATE public.protected_zones SET active=false");
      assert.equal(await clear(40, 40), true);
      assert.equal(await clear(null, null), false);
    });

    await context.test("anonymous and signed-in clients cannot execute any producer or privacy oracle", async () => {
      for (const role of ["anon", "authenticated"]) {
        await database.exec(`RESET ROLE; SET ROLE ${role}`);
        for (const query of ["SELECT public.discovery_trend_position_is_clear(0,0)",
          "SELECT * FROM public.discovery_trend_place_context()",
          "SELECT * FROM public.discovery_trend_windows_v2(now(),'place')",
          "SELECT * FROM public.discovery_trend_post_groups_v2(now())",
          "SELECT public.rebuild_place_momentum(now())", "SELECT public.rebuild_place_momentum_v2(now())"]) {
          await assert.rejects(database.query(query), /permission denied/);
        }
      }
      await database.exec("RESET ROLE; REVOKE SELECT ON public.protected_zones FROM service_role; SET ROLE service_role");
      await assert.rejects(database.query("SELECT public.rebuild_place_momentum_v2($1)", [now]), /permission denied/); await assert.rejects(database.query("SELECT public.rebuild_place_momentum($1)", [now]), /permission denied/); await assert.rejects(database.query("SELECT * FROM public.discovery_trend_place_context()"), /permission denied/); // Fable gate C3 (2026-10-17): an unreadable zone policy is an error for v1 and the context too, never an empty policy
    });

    await context.test("with no active zone every producer writes its predecessor's rows and feature version; a zone switched on filters and stamps", async () => {
      const inactive = new PGlite();
      try {
        await fixture(inactive);
        await inactive.exec(`RESET ROLE; UPDATE public.protected_zones SET active = false;
          INSERT INTO public.rank_events SELECT place, actor, 'save', '2031-07-10', '2031-07-10', 'discovery'
            FROM unnest(ARRAY['db/${safePlace}','db/${protectedPlace}','db/${unknownPlace}','osm:missing']) place
            CROSS JOIN unnest(ARRAY['30000000-0000-4000-a000-000000000001'::uuid,'30000000-0000-4000-a000-000000000002'::uuid]) actor;
          INSERT INTO public.memories (owner_id,place_id,state,visibility,created_at)
            SELECT actor, place,'published','public', CASE WHEN actor::text LIKE '%001' THEN '2031-07-14 01:00'::timestamptz ELSE '2031-07-14 02:00'::timestamptz END
            FROM unnest(ARRAY['${safePlace}','${protectedPlace}','${unknownPlace}','osm:missing']) place
            CROSS JOIN unnest(ARRAY['30000000-0000-4000-a000-000000000001'::uuid,'30000000-0000-4000-a000-000000000002'::uuid]) actor;
          SET ROLE service_role`);
        const readings = async () => {
          const out: Record<string, unknown> = {};
          for (const [label, normalised, post] of [["v1", false, false], ["v2", true, false], ["v2+post", true, true]] as const) {
            await inactive.exec(`DELETE FROM public.place_momentum; DELETE FROM public.area_momentum;
              UPDATE public.feature_flags SET enabled = ${normalised} WHERE flag = 'discovery_trend_normalised_enabled';
              UPDATE public.feature_flags SET enabled = ${post} WHERE flag = 'discovery_trend_post_convergence_enabled';`);
            await inactive.query("SELECT public.rebuild_place_momentum($1)", [now]);
            out[label] = {
              places: (await inactive.query("SELECT to_jsonb(s)-'id'-'created_at' AS r FROM public.place_momentum s ORDER BY place_id")).rows,
              areas: (await inactive.query("SELECT to_jsonb(s)-'id'-'created_at' AS r FROM public.area_momentum s ORDER BY cell_key")).rows,
            };
          }
          out.context = (await inactive.query("SELECT * FROM public.discovery_trend_place_context() ORDER BY place_key")).rows;
          out.windows = (await inactive.query("SELECT * FROM public.discovery_trend_windows_v2($1,'place') ORDER BY o_key", [now])).rows;
          out.areaWindows = (await inactive.query("SELECT * FROM public.discovery_trend_windows_v2($1,'area') ORDER BY o_key", [now])).rows;
          out.posts = (await inactive.query("SELECT * FROM public.discovery_trend_post_groups_v2($1) ORDER BY o_key, o_win", [now])).rows;
          return out;
        };
        const predecessor = await readings();
        const everyItem = [`db/${safePlace}`, `db/${protectedPlace}`, `db/${unknownPlace}`, "osm:missing"].sort();
        assert.deepEqual((predecessor.windows as Array<{ o_key: string }>).map((r) => r.o_key), everyItem, "not vacuous: unlocatable and non-canonical items are read");
        assert.deepEqual((predecessor.posts as Array<{ o_key: string }>).map((r) => r.o_key), everyItem, "not vacuous: every place has a post leg");
        assert.deepEqual((predecessor.v1 as { places: Array<{ r: Record<string, unknown> }> }).places.map((p) => p.r.feature_version),
          everyItem.map(() => "discovery-row-activity-v2"));
        await inactive.exec("RESET ROLE");
        await inactive.exec(patch);
        await inactive.exec("SET ROLE service_role");
        assert.deepEqual(await readings(), predecessor, "no active zone: 3988 moves no value, feature_version included");

        await inactive.exec("RESET ROLE; UPDATE public.protected_zones SET active = true; SET ROLE service_role");
        const policed = await readings();
        assert.deepEqual((policed.windows as Array<{ o_key: string }>).map((r) => r.o_key), [`db/${safePlace}`]);
        assert.deepEqual((policed.posts as Array<{ o_key: string }>).map((r) => r.o_key), [`db/${safePlace}`]);
        assert.deepEqual((policed.context as Array<{ place_key: string }>).map((r) => r.place_key), [safePlace]);
        // A Local Pulse cell has no post leg (3497 stamps it with the plain v2 feature in either mode).
        for (const [label, stamp, areaStamp] of [["v1", "discovery-row-activity-v2+protected-contributions-v1", null],
          ["v2", "discovery-exposure-activity-v3+protected-contributions-v1", "discovery-exposure-activity-v3+protected-contributions-v1"],
          ["v2+post", "discovery-exposure-activity-v3+post-after-visit-v1+protected-contributions-v1", "discovery-exposure-activity-v3+protected-contributions-v1"]] as const) {
          const reading = policed[label] as { places: Array<{ r: Record<string, unknown> }>; areas: Array<{ r: Record<string, unknown> }> };
          assert.deepEqual(reading.places.map((p) => [p.r.place_id, p.r.feature_version]), [[`db/${safePlace}`, stamp]], label);
          assert.deepEqual(reading.areas.map((a) => a.r.feature_version), areaStamp === null ? [] : [areaStamp], label);
        }
      } finally {
        await inactive.close();
      }
    });

    await context.test("an incompatible deployed definition rolls back the whole migration", async () => {
      const incompatible = new PGlite();
      try {
        await fixture(incompatible);
        await incompatible.exec("RESET ROLE; ALTER FUNCTION public.discovery_trend_post_groups_v2(timestamptz) RENAME TO fixture_old_post_groups");
        const prior = await incompatible.query("SELECT pg_get_functiondef('public.discovery_trend_windows_v2(timestamptz,text)'::regprocedure) AS definition");
        await assert.rejects(incompatible.exec(patch), /3988 requires/);
        await incompatible.exec("ROLLBACK");
        const after = await incompatible.query("SELECT pg_get_functiondef('public.discovery_trend_windows_v2(timestamptz,text)'::regprocedure) AS definition");
        assert.deepEqual(after.rows, prior.rows);
        assert.equal((await incompatible.query("SELECT to_regprocedure('public.discovery_trend_position_is_clear(double precision,double precision)') AS helper")).rows[0].helper, null);
      } finally {
        await incompatible.close();
      }
    });

    for (const drift of ["older owner controls", "filter text only in a comment", "security definer"] as const) {
      await context.test(`refuses ${drift} without overwriting unrelated definitions`, async () => {
        const incompatible = new PGlite();
        try {
          await fixture(incompatible);
          await incompatible.exec("RESET ROLE");
          if (drift === "older owner controls") {
            await installFunctions(incompatible, "3725_discovery_trend_post_owner_controls.sql");
          } else if (drift === "filter text only in a comment") {
            const prior = (await incompatible.query("SELECT pg_get_functiondef('public.discovery_trend_place_context()'::regprocedure) AS definition")).rows[0].definition;
            await incompatible.exec(prior.replace("FROM public.discovery_places dp\n", "FROM public.discovery_places dp\n/* FROM public.discovery_places dp\n     WHERE public.discovery_trend_position_is_clear(dp.lat, dp.lng)\n */\n"));
          } else {
            await incompatible.exec("ALTER FUNCTION public.discovery_trend_windows_v2(timestamptz,text) SECURITY DEFINER");
          }
          const prior = await incompatible.query("SELECT pg_get_functiondef('public.discovery_trend_windows_v2(timestamptz,text)'::regprocedure) AS definition");
          await assert.rejects(incompatible.exec(patch), /3988 refuses unreviewed definition/);
          await incompatible.exec("ROLLBACK");
          assert.deepEqual((await incompatible.query("SELECT pg_get_functiondef('public.discovery_trend_windows_v2(timestamptz,text)'::regprocedure) AS definition")).rows, prior.rows);
          assert.equal((await incompatible.query("SELECT to_regprocedure('public.discovery_trend_position_is_clear(double precision,double precision)') AS helper")).rows[0].helper, null);
        } finally {
          await incompatible.close();
        }
      });
    }
  } finally {
    await database.close();
  }
});
