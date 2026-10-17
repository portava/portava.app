/**
 * census-layover L132 / L158 / L166 / L203 — migration 3996, the crew location
 * grant store, statically and executed.
 *
 * The static half always runs. The executed half runs on PGlite (the repo's
 * `DISCOVERY_PGLITE_MODULE` convention) over 2984's REAL file on a minimal
 * 0127/2985 stand-in, so the FK to the membership, the guard trigger and the
 * three ending triggers are exercised against PostgreSQL rather than read.
 *
 * Run: DISCOVERY_PGLITE_MODULE=<abs path to @electric-sql/pglite/dist/index.js> \
 *      node --import tsx/esm --test src/test/layoverCrewLocationMigration.test.ts
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { postconditionBlocks } from "../scripts/lib/migrationSqlBlocks.js";

const FILE = "../migrations/3996_layover_crew_location_grants.sql";
const sql = readFileSync(new URL(FILE, import.meta.url), "utf8");
const crews2984 = readFileSync(new URL("../migrations/2984_layover_crews.sql", import.meta.url), "utf8");

describe("3996 — static shape", () => {
  it("is one transaction with its preconditions first and its postconditions before COMMIT", () => {
    assert.match(sql, /^BEGIN;$/m);
    assert.match(sql, /^COMMIT;\s*$/m);
    assert.ok(sql.indexOf("PRECONDITION FAILED (3996)") < sql.indexOf("CREATE TABLE"));
    const post = postconditionBlocks(sql);
    assert.equal(post.length, 1, "exactly one re-runnable postcondition block");
    assert.ok(sql.indexOf(post[0]!.text) < sql.lastIndexOf("COMMIT;"));
  });

  it("seeds its flag FALSE and asserts it ships OFF", () => {
    assert.match(sql, /'layover_crew_location_enabled',\s*false,/);
    assert.match(sql, /layover_crew_location_enabled is ON — activation is an owner decision/);
  });

  it("the expiry has no default and the window is the Telegraph ceiling", () => {
    assert.match(sql, /expires_at\s+TIMESTAMPTZ\s+NOT NULL,\n/);
    assert.match(sql, /expires_at <= granted_at \+ interval '4 hours'/);
  });

  it("every function is SECURITY INVOKER with a pinned search_path and no client EXECUTE", () => {
    const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(\)/g)].map((m) => m[1]);
    assert.equal(fns.length, 4);
    assert.doesNotMatch(sql, /SECURITY DEFINER/);
    for (const fn of fns) assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(\\) FROM PUBLIC, anon, authenticated;`));
    assert.equal((sql.match(/SET search_path = pg_catalog, public/g) ?? []).length, 4);
  });

  it("no client role is granted anything", () => {
    assert.doesNotMatch(sql, /GRANT [A-Z, ]+ ON public\.layover_crew_location_[a-z_]+ TO (anon|authenticated|PUBLIC)/);
    assert.match(sql, /REVOKE ALL ON public\.layover_crew_location_grants FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /REVOKE ALL ON public\.layover_crew_location_controls FROM PUBLIC, anon, authenticated;/);
  });
});

const PREREQS = `
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role BYPASSRLS;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  CREATE TABLE public.profiles (id uuid PRIMARY KEY);
  CREATE TABLE public.feature_flags (flag text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text);
  CREATE TABLE public.layover_sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE);
  CREATE TABLE public.layover_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid, user_id uuid,
    event_type text NOT NULL CHECK (event_type IN ('session_created', 'crew_created', 'crew_joined', 'crew_left')),
    metadata jsonb, created_at timestamptz NOT NULL DEFAULT now()
  );
`;

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const S1 = "00000000-0000-4000-8000-000000000011";
const S2 = "00000000-0000-4000-8000-000000000012";
const C1 = "00000000-0000-4000-8000-000000000021";

test("3996 executes: membership, explicit permission, bounded window, and every end", { skip: !process.env.DISCOVERY_PGLITE_MODULE }, async (t) => {
  const { PGlite } = await import(process.env.DISCOVERY_PGLITE_MODULE!);
  const db = new PGlite();
  const q = (text: string, params: unknown[] = []) => db.query(text, params);
  const grant = (over: Record<string, string> = {}) => {
    const g = {
      crew_id: C1, user_id: U1, session_id: S1, purpose: "'presence_in_context'", precision: "'area'", label: "'Night market'",
      lat: "NULL", lng: "NULL", granted_at: "now()", expires_at: "now() + interval '1 hour'", ...over,
    };
    return q(`INSERT INTO public.layover_crew_location_grants (crew_id, user_id, session_id, purpose, precision, label, lat, lng, granted_at, expires_at)
              VALUES ('${g.crew_id}', '${g.user_id}', '${g.session_id}', ${g.purpose}, ${g.precision}, ${g.label}, ${g.lat}, ${g.lng}, ${g.granted_at}, ${g.expires_at})`);
  };
  const count = async (table: string, where = "TRUE") => Number((await q(`SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`)).rows[0].n);
  const reset = async () => {
    await db.exec(`
      DELETE FROM public.layover_crew_location_grants; DELETE FROM public.layover_crew_location_controls;
      DELETE FROM public.layover_crew_members; DELETE FROM public.layover_crews;
      INSERT INTO public.layover_crews (id, city, created_by, created_session_id, title, status, expires_at)
        VALUES ('${C1}', 'taoyuan', '${U1}', '${S1}', 'Ramen', 'open', now() + interval '6 hours');
      INSERT INTO public.layover_crew_members (crew_id, user_id, session_id, role) VALUES
        ('${C1}', '${U1}', '${S1}', 'owner'), ('${C1}', '${U2}', '${S2}', 'member');
    `);
  };

  await db.exec(PREREQS);
  await db.exec(`INSERT INTO public.profiles VALUES ('${U1}'), ('${U2}');
                 INSERT INTO public.layover_sessions VALUES ('${S1}', '${U1}'), ('${S2}', '${U2}');`);
  await db.exec(crews2984);
  await db.exec(sql);

  await t.test("applies twice without error (idempotent)", async () => {
    await db.exec(sql);
  });

  await t.test("the flag is seeded FALSE; the audit vocabulary is the union", async () => {
    assert.equal((await q("SELECT enabled FROM public.feature_flags WHERE flag = 'layover_crew_location_enabled'")).rows[0].enabled, false);
    await q(`INSERT INTO public.layover_events (event_type) VALUES ('crew_location_shared'), ('crew_location_stopped'), ('crew_left'), ('session_created')`);
    await assert.rejects(q(`INSERT INTO public.layover_events (event_type) VALUES ('crew_location_everything')`), { code: "23514" });
    await q("DELETE FROM public.layover_events");
  });

  await t.test("no client role can read or write either table, even with permissive defaults", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await assert.rejects(q("SELECT * FROM public.layover_crew_location_grants"), { code: "42501" });
        await assert.rejects(q("SELECT * FROM public.layover_crew_location_controls"), { code: "42501" });
      } finally {
        await db.exec("RESET ROLE");
      }
    }
  });

  await t.test("L203: a share needs a LIVE membership on the same session", async () => {
    await reset();
    await grant();
    assert.equal(await count("layover_crew_location_grants"), 1);
    await assert.rejects(grant({ user_id: U2, session_id: S1 }), /made from the session the member joined with/);
    await q(`UPDATE public.layover_crew_members SET left_at = now() WHERE user_id = '${U2}'`);
    await assert.rejects(grant({ user_id: U2, session_id: S2 }), /LIVE crew membership/);
    await assert.rejects(grant({ user_id: "00000000-0000-4000-8000-000000000099" }), /LIVE crew membership|violates foreign key/);
  });

  await t.test("L132: explicit, scoped, auto-expiring — the window and the rung are CHECKed", async () => {
    await reset();
    await assert.rejects(grant({ expires_at: "NULL" }), { code: "23502" });
    await assert.rejects(grant({ expires_at: "now() + interval '4 hours 1 minute'" }), { code: "23514" });
    await assert.rejects(grant({ expires_at: "now() - interval '1 minute'" }), { code: "23514" });
    await assert.rejects(grant({ lat: "25.03", lng: "121.56" }), { code: "23514" }, "a coordinate at area");
    await assert.rejects(grant({ precision: "'venue'", lat: "25.03", lng: "NULL" }), { code: "23514" }, "half a coordinate");
    await assert.rejects(grant({ precision: "'exact'" }), { code: "23514" }, "exact under the coarse purpose");
    await assert.rejects(grant({ precision: "'everywhere'" }), { code: "23514" });
    await grant({ precision: "'venue'", lat: "25.033", lng: "121.565" });
  });

  await t.test("a share may not outlive its crew, and a dead crew takes none", async () => {
    await reset();
    await q(`UPDATE public.layover_crews SET expires_at = now() + interval '30 minutes' WHERE id = '${C1}'`);
    await assert.rejects(grant({ expires_at: "now() + interval '1 hour'" }), /may not outlive its crew/);
    await q(`UPDATE public.layover_crews SET status = 'disbanded' WHERE id = '${C1}'`);
    await assert.rejects(grant({ expires_at: "now() + interval '10 minutes'" }), /crew is not live/);
  });

  await t.test("L166: exact needs the separate control ON, and turning it off deletes the exact share", async () => {
    await reset();
    const exact = { precision: "'exact'", purpose: "'live_session_sharing'", lat: "25.033", lng: "121.565" };
    await assert.rejects(grant(exact), /separate precise-sharing control ON/);
    await q(`INSERT INTO public.layover_crew_location_controls (crew_id, user_id) VALUES ('${C1}', '${U1}')`);
    assert.equal((await q(`SELECT precise_sharing_enabled FROM public.layover_crew_location_controls WHERE user_id = '${U1}'`)).rows[0].precise_sharing_enabled, false, "off by default");
    await assert.rejects(grant(exact), /separate precise-sharing control ON/);
    await q(`UPDATE public.layover_crew_location_controls SET precise_sharing_enabled = true WHERE user_id = '${U1}'`);
    await grant(exact);
    await q(`INSERT INTO public.layover_crew_location_controls (crew_id, user_id, precise_sharing_enabled) VALUES ('${C1}', '${U2}', true)`);
    await grant({ user_id: U2, session_id: S2, precision: "'venue'", lat: "25.03", lng: "121.56" });
    await q(`UPDATE public.layover_crew_location_controls SET precise_sharing_enabled = false WHERE user_id = '${U1}'`);
    assert.equal(await count("layover_crew_location_grants", `user_id = '${U1}'`), 0, "the exact share went with the control");
    assert.equal(await count("layover_crew_location_grants", `user_id = '${U2}'`), 1, "a venue share is not touched");
  });

  await t.test("L158: leaving the crew deletes the share and forgets the control", async () => {
    await reset();
    await q(`INSERT INTO public.layover_crew_location_controls (crew_id, user_id, precise_sharing_enabled) VALUES ('${C1}', '${U1}', true)`);
    await grant();
    await q(`UPDATE public.layover_crew_members SET left_at = now() WHERE user_id = '${U1}'`);
    assert.equal(await count("layover_crew_location_grants"), 0);
    assert.equal(await count("layover_crew_location_controls"), 0);
  });

  await t.test("L158: a disbanded crew's shares are deleted, not hidden", async () => {
    await reset();
    await grant();
    await grant({ user_id: U2, session_id: S2 });
    await q(`UPDATE public.layover_crews SET status = 'disbanded' WHERE id = '${C1}'`);
    assert.equal(await count("layover_crew_location_grants"), 0);
  });

  await t.test("L158: the crew sweep's DELETE and a session delete cascade through", async () => {
    await reset();
    await grant();
    await q(`DELETE FROM public.layover_crews WHERE id = '${C1}'`);
    assert.equal(await count("layover_crew_location_grants"), 0);
    await reset();
    await grant({ user_id: U2, session_id: S2 });
    await q(`DELETE FROM public.layover_sessions WHERE id = '${S2}'`);
    assert.equal(await count("layover_crew_location_grants"), 0);
    await q(`INSERT INTO public.layover_sessions VALUES ('${S2}', '${U2}')`);
  });

  await t.test("the postcondition block rejects drift", async () => {
    const post = postconditionBlocks(sql)[0]!.text;
    const drifts = [
      "ALTER TABLE public.layover_crew_location_grants DISABLE ROW LEVEL SECURITY",
      "GRANT SELECT ON public.layover_crew_location_grants TO anon",
      "GRANT SELECT ON public.layover_crew_location_controls TO authenticated",
      "ALTER TABLE public.layover_crew_location_controls ADD COLUMN lat double precision",
      "ALTER TABLE public.layover_crew_location_grants DROP CONSTRAINT layover_crew_location_grants_no_coordinate_at_area",
      "ALTER TABLE public.layover_crew_location_grants DROP CONSTRAINT layover_crew_location_grants_bounded_window",
      "ALTER TABLE public.layover_crew_location_grants ALTER COLUMN expires_at SET DEFAULT now() + interval '1 hour'",
      "UPDATE public.feature_flags SET enabled = true WHERE flag = 'layover_crew_location_enabled'",
      "DROP TRIGGER layover_crew_location_member_left ON public.layover_crew_members",
      "GRANT EXECUTE ON FUNCTION public.layover_crew_location_grant_guard() TO authenticated",
      "CREATE POLICY anyone_reads ON public.layover_crew_location_grants FOR SELECT TO authenticated USING (true)",
    ];
    for (const change of drifts) {
      await db.exec("BEGIN");
      try {
        await db.exec(change);
        await assert.rejects(db.exec(post), /POSTCONDITION FAILED \(3996\)/, change);
      } finally {
        await db.exec("ROLLBACK");
      }
    }
    await db.exec(post);
  });

  await db.close();
});
