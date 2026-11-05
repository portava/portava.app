/**
 * journeyShadowProgrammeRetired4003 — migration 4003 (the dormant journey-shadow programme retired from production on
 * the owner's 2026-11-05 decision), executed against real PostgreSQL (CI's postgis/postgis:16-3.4 service,
 * scripts/local-db/up.sh).
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/journeyShadowProgrammeRetired4003.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every src/test/db suite;
 *      scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE STARTING SHAPES
 *   production                  the programme is installed and dormant (2127 on an unmerged branch, applied out of band):
 *                               nine tables, six columns, 36 functions, their triggers, three disabled flags, one row of
 *                               job-health counters. The file retires all of it, or refuses and changes nothing.
 *   portava-ci / this harness   the 2026-08-19 baseline and the chain from 0001 carry none of it (2976 refuses to create
 *                               its stop from nothing), so the file is a strict no-op. Production's shape is rebuilt here
 *                               inside a rolled-back transaction from the census note's DDL (docs/architecture/census-media.md,
 *                               "Note (2026-10-24, capability refresh, PR #788)") and the capture's column lists.
 *
 * PROPERTIES
 *   J0  on the replayed chain the file's postconditions hold: nothing of the programme exists.
 *   J1  re-running the body there changes nothing: the host tables and the flag table keep every oid and their
 *       definition fingerprint (columns, defaults, constraints, indexes, RLS, client privileges).
 *   J2  on production's shape, rebuilt in a rolled-back transaction, the body removes all of it — the tables, the
 *       columns and their CHECKs, the 36 functions and an overload the tree never recorded, the three triggers (two of
 *       them on host tables), the three flag rows — the host rows and the other flags survive, and the postconditions hold.
 *   J3  each premise refuses, by name, and the file says it changed nothing: a programme row, an open programme session,
 *       a consenting preference row, an enabled or unknown COMPASS_JOURNEY flag, an outside function naming a programme
 *       object, a view on a programme table, a view on a programme column, a foreign key from outside the programme.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(__dir, "../../migrations");
const FILE = "4003_journey_shadow_programme_retired.sql";

function split(filename: string): { body: string; postconditions: string } {
  const file = readFileSync(resolve(MIGRATIONS, filename), "utf8");
  const b = file.indexOf("\nBEGIN;\n");
  const c = file.indexOf("\nCOMMIT;\n");
  assert.ok(b >= 0 && c > b, `${filename} is BEGIN … COMMIT with a postcondition tail`);
  return { body: file.slice(b + "\nBEGIN;\n".length, c), postconditions: file.slice(c + "\nCOMMIT;\n".length) };
}
const M4003 = split(FILE);

/** 2976's canonical text for the stop, verbatim: the body production holds since 2976 was applied there. */
const STOP_DEFINITION = (() => {
  const m2976 = readFileSync(resolve(MIGRATIONS, "2976_journey_shadow_global_stop_delete_scope.sql"), "utf8");
  const start = m2976.indexOf("CREATE OR REPLACE FUNCTION public.global_journey_shadow_stop_v1");
  const end = m2976.indexOf("$function$;", start) + "$function$;".length;
  assert.ok(start > 0 && end > start, "2976 carries the stop's definition inside its $mig$ block");
  return m2976.slice(start, end);
})();

/** The capture's column lists for the nine tables (names only; the file drops by name, so the types here are nominal). */
const CAPTURE = JSON.parse(
  readFileSync(resolve(__dir, "../../lib/capability/snapshots/20261104-production-schema.json"), "utf8"),
) as { tables: Record<string, string[]> };
const PROGRAMME_TABLES = Object.keys(CAPTURE.tables).filter((t) => t.startsWith("journey")).sort();
assert.equal(PROGRAMME_TABLES.length, 9, "the 2026-11-04 capture holds the nine programme tables");

function columnType(c: string): string {
  if (c === "id") return "uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY";
  if (c.endsWith("_id") || c.endsWith("_by")) return "uuid";
  if (c.endsWith("_at")) return "timestamptz";
  if (c.startsWith("is_") || c.endsWith("_enabled")) return "boolean NOT NULL DEFAULT false";
  if (/count|rows|lag|version|attempts/.test(c)) return "integer";
  return "text";
}

/** [name, identity arguments, return type, SECURITY DEFINER] — the census note's 35 signatures (float8 ×5 expanded). */
const FUNCTIONS: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["_journey_shadow_jsonb_has_forbidden_keys", "jsonb", "boolean", false],
  ["_journey_shadow_jsonb_has_forbidden_keys_deep", "jsonb, integer", "boolean", false],
  ["_journey_shadow_require_admin_actor", "uuid", "void", true],
  ["aggregate_journey_shadow_observations_v1", "uuid, uuid, timestamptz, timestamptz", "jsonb", true],
  ["aggregate_journey_shadow_segment_revisions_v1", "uuid, uuid, timestamptz, timestamptz", "jsonb", true],
  ["append_journey_segment_revisions", "jsonb", "jsonb", true],
  ["append_journey_segment_revisions_v2", "jsonb", "jsonb", true],
  ["assign_journey_shadow_cohort_v1", "uuid, uuid, uuid, timestamptz, timestamptz", "jsonb", true],
  ["begin_journey_retention_cycle_v1", "text, timestamptz, integer", "jsonb", true],
  ["claim_journey_revocation_jobs_v1", "text, integer, timestamptz, integer", "jsonb", true],
  ["complete_journey_revocation_job_v1", "uuid, uuid, timestamptz, integer", "jsonb", true],
  ["configure_journey_shadow_stage_v1", "uuid, text, timestamptz, timestamptz, uuid, timestamptz", "jsonb", true],
  ["delete_journey_observations_for_user_v1", "uuid", "integer", true],
  ["delete_journey_segments_for_user", "uuid", "integer", true],
  ["delete_journey_shadow_rows_v1", "uuid, uuid", "jsonb", true],
  ["fail_journey_revocation_job_v1", "uuid, uuid, timestamptz, timestamptz, integer, text", "jsonb", true],
  ["finish_journey_retention_cycle_v1", "uuid, timestamptz, text, integer, integer, bigint, bigint, integer, text", "jsonb", true],
  ["finish_journey_retention_cycle_v2", "uuid, timestamptz, text, integer, integer, bigint, bigint, integer, text, integer, integer, integer", "jsonb", true],
  ["ingest_journey_observation_v1", "uuid, uuid, smallint, timestamptz, text, float8, float8, float8, float8, float8, jsonb, text, text, text", "jsonb", true],
  ["ingest_journey_observation_v2", "uuid, uuid, smallint, timestamptz, text, float8, float8, float8, float8, float8, jsonb, text, text, text, text, numeric, text, text[]", "jsonb", true],
  ["is_valid_journey_world_ref", "jsonb", "boolean", false],
  ["issue_journey_shadow_session_v1", "uuid, uuid, text, timestamptz", "jsonb", true],
  ["journey_shadow_authorize_v1", "uuid, uuid, text, timestamptz, text", "jsonb", true],
  ["persist_journey_shadow_qa_report_v1", "uuid, uuid, text, timestamptz, timestamptz, jsonb, text", "jsonb", true],
  ["purge_expired_journey_shadow_table_v1", "text, timestamptz", "integer", true],
  ["read_journey_shadow_observations_v1", "uuid, uuid, timestamptz, timestamptz", "jsonb", true],
  ["read_journey_shadow_qa_observations_v1", "uuid, uuid, uuid, timestamptz, timestamptz", "jsonb", true],
  ["read_journey_shadow_qa_segment_revisions_v1", "uuid, uuid, uuid, timestamptz, timestamptz", "jsonb", true],
  ["record_journey_shadow_ground_truth_v1", "uuid, uuid, uuid, timestamptz, jsonb, text", "jsonb", true],
  ["revoke_journey_consent_and_delete_segments", "uuid, jsonb", "jsonb", true],
  ["revoke_journey_shadow_cohort_v1", "uuid, uuid", "jsonb", true],
  ["set_journey_observation_consent_v1", "uuid, boolean", "jsonb", true],
];

/** Production's shape, from the census note: columns with their CHECKs, the nine tables, the functions, the triggers, the flags, the health row. */
function programmeShape(userId: string): string {
  let s = `
  ALTER TABLE public.location_sessions ADD COLUMN journey_purpose text NOT NULL DEFAULT 'legacy_location_share'::text,
    ADD CONSTRAINT location_sessions_journey_purpose_check CHECK (((journey_purpose = ANY (ARRAY['legacy_location_share'::text, 'journey_observation_v1'::text])) AND ((journey_purpose <> 'journey_observation_v1'::text) OR (expires_at IS NOT NULL))));
  CREATE INDEX location_sessions_journey_purpose_idx ON public.location_sessions (journey_purpose) WHERE journey_purpose = 'journey_observation_v1';
  ALTER TABLE public.user_location_preferences ADD COLUMN journey_observation_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN journey_consent_scope text, ADD COLUMN journey_consent_version smallint,
    ADD COLUMN journey_consent_granted_at timestamptz, ADD COLUMN journey_consent_revoked_at timestamptz,
    ADD CONSTRAINT user_location_preferences_journey_con CHECK ((((journey_observation_enabled = false) OR ((journey_consent_scope = 'journey_observation_v1'::text) AND (journey_consent_version = 1) AND (journey_consent_granted_at IS NOT NULL) AND (journey_consent_revoked_at IS NULL))) AND ((journey_consent_revoked_at IS NULL) OR ((journey_consent_granted_at IS NOT NULL) AND (journey_consent_revoked_at >= journey_consent_granted_at)))));
`;
  const parentsFirst = [
    "journey_shadow_stages",
    "journey_shadow_cohort_assignments",
    ...PROGRAMME_TABLES.filter((t) => t !== "journey_shadow_stages" && t !== "journey_shadow_cohort_assignments"),
  ];
  for (const t of parentsFirst) {
    const cols = CAPTURE.tables[t]!;
    const defs = cols.map((c) => `${c} ${columnType(c)}`);
    if (cols.includes("location_session_id")) defs.push(`CONSTRAINT ${t}_ls_fk FOREIGN KEY (location_session_id) REFERENCES public.location_sessions(id) ON DELETE CASCADE`);
    if (cols.includes("user_id")) defs.push(`CONSTRAINT ${t}_user_fk FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE`);
    if (t === "journey_shadow_ground_truth" && cols.includes("assignment_id")) defs.push("CONSTRAINT journey_shadow_ground_truth_assignment_fk FOREIGN KEY (assignment_id) REFERENCES public.journey_shadow_cohort_assignments(id) ON DELETE CASCADE");
    if (t === "journey_shadow_cohort_assignments" && cols.includes("stage_id")) defs.push("CONSTRAINT journey_shadow_cohort_assignments_stage_fk FOREIGN KEY (stage_id) REFERENCES public.journey_shadow_stages(id)");
    s += `  CREATE TABLE public.${t} (${defs.join(", ")});
  ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated;
  GRANT ALL ON TABLE public.${t} TO service_role;
`;
  }
  for (const [name, args, ret, definer] of FUNCTIONS) {
    const body =
      ret === "void" ? "BEGIN RETURN; END"
      : ret === "boolean" ? "BEGIN RETURN false; END"
      : ret === "integer" ? "BEGIN DELETE FROM public.journey_observations WHERE false; RETURN 0; END"
      : "BEGIN RETURN '{}'::jsonb; END";
    s += `  CREATE FUNCTION public.${name}(${args}) RETURNS ${ret} LANGUAGE plpgsql ${definer ? "SECURITY DEFINER" : ""} SET search_path = '' AS $f$ ${body} $f$;
  REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO service_role;
`;
  }
  s += `
  CREATE FUNCTION public.delete_journey_segments_for_user(uuid, boolean) RETURNS integer LANGUAGE sql SECURITY DEFINER AS $f$ SELECT 0 $f$;
  CREATE FUNCTION public.prevent_journey_observation_update() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'journey_observations are append-only'; END $f$;
  CREATE TRIGGER journey_observations_no_update BEFORE UPDATE ON public.journey_observations FOR EACH ROW EXECUTE FUNCTION public.prevent_journey_observation_update();
  CREATE FUNCTION public.purge_journey_observations_on_session_revocation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$ BEGIN DELETE FROM public.journey_observations WHERE location_session_id = NEW.id; RETURN NEW; END $f$;
  CREATE TRIGGER location_sessions_journey_purge AFTER UPDATE OF ended_at ON public.location_sessions FOR EACH ROW EXECUTE FUNCTION public.purge_journey_observations_on_session_revocation();
  CREATE FUNCTION public.purge_journey_observations_on_consent_revocation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$ BEGIN DELETE FROM public.journey_segment_revisions WHERE user_id = NEW.user_id; RETURN NEW; END $f$;
  CREATE TRIGGER user_location_preferences_journey_purge AFTER UPDATE OF journey_observation_enabled ON public.user_location_preferences FOR EACH ROW EXECUTE FUNCTION public.purge_journey_observations_on_consent_revocation();
  ${STOP_DEFINITION}
  REVOKE ALL ON FUNCTION public.global_journey_shadow_stop_v1(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.global_journey_shadow_stop_v1(uuid) TO service_role;
  INSERT INTO public.feature_flags (flag, enabled) VALUES
    ('COMPASS_JOURNEY_ENGINE_ENABLED', false), ('COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED', false), ('COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED', false);
  INSERT INTO public.location_sessions (user_id, session_type, expires_at) VALUES ('${userId}', 'live_share', now() + interval '1 hour');
  INSERT INTO public.user_location_preferences (user_id) VALUES ('${userId}') ON CONFLICT (user_id) DO NOTHING;
`;
  const health = CAPTURE.tables["journey_retention_health"]!;
  const values = health.map((c) =>
    c === "id" ? "gen_random_uuid()"
    : c.endsWith("_at") ? "now()"
    : c.endsWith("_id") || c.endsWith("_by") ? "NULL"
    : /count|rows|lag|version|attempts/.test(c) ? "0"
    : c.startsWith("is_") || c.endsWith("_enabled") ? "false"
    : "'retention'",
  );
  s += `  INSERT INTO public.journey_retention_health (${health.join(", ")}) VALUES (${values.join(", ")});\n`;
  return s;
}

/** What is installed, one line. */
const STATE = `
  SELECT 'state=' || json_build_object(
    'tables', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname LIKE 'journey%'),
    'columns', (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('location_sessions', 'user_location_preferences') AND column_name LIKE 'journey%'),
    'checks', (SELECT count(*) FROM pg_constraint WHERE conname IN ('location_sessions_journey_purpose_check', 'user_location_preferences_journey_con')),
    'functions', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE '%journey%'),
    'triggers', (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE NOT t.tgisinternal AND p.proname LIKE '%journey%'),
    'programme_flags', (SELECT count(*) FROM public.feature_flags WHERE flag LIKE 'COMPASS\\_JOURNEY\\_%'),
    'host_columns', (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('location_sessions', 'user_location_preferences', 'feature_flags'))
  )::text;`;

const HOST_TABLES = ["location_sessions", "user_location_preferences", "feature_flags"];
/** Object identity (oids) and a definition fingerprint for the host tables, one row each. */
const CATALOG = `
  SELECT 'class:' || c.relname || '@' || c.oid FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${HOST_TABLES.map((t) => `'${t}'`).join(", ")})
  UNION ALL SELECT 'constraint:' || k.conname || '@' || k.oid FROM pg_constraint k
   WHERE k.conrelid IN (${HOST_TABLES.map((t) => `'public.${t}'::regclass`).join(", ")})
  UNION ALL SELECT 'fingerprint:' || md5(
    (SELECT string_agg(c.relname || ':' || c.relrowsecurity::text || ':' ||
            coalesce((SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
                                        || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attnum)
                        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                       WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '') || ':' ||
            coalesce((SELECT string_agg(k.conname || '=' || pg_get_constraintdef(k.oid), ',' ORDER BY k.conname)
                        FROM pg_constraint k WHERE k.conrelid = c.oid), '') || ':' ||
            coalesce((SELECT string_agg(pg_get_indexdef(i.indexrelid), ',' ORDER BY pg_get_indexdef(i.indexrelid))
                        FROM pg_index i WHERE i.indrelid = c.oid), '') || ':' ||
            has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')::text || ':' ||
            has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')::text || ':' ||
            has_table_privilege('service_role', c.oid, 'SELECT, INSERT, UPDATE, DELETE')::text,
            ';' ORDER BY c.relname)
       FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${HOST_TABLES.map((t) => `'${t}'`).join(", ")})))
  ORDER BY 1`;

let USER = "";

describe("4003 — the dormant journey-shadow programme, retired", { skip: !HAVE_DB }, () => {
  before(() => {
    USER = seedUser("u4003");
  });

  after(() => {
    if (USER) deleteUser(USER);
  });

  it("J0 — on the replayed chain the postconditions hold: nothing of the programme exists", () => {
    exec(M4003.postconditions);
    const [state] = exec(STATE);
    assert.ok(state!.startsWith("state="), state);
    const s = JSON.parse(state!.slice("state=".length));
    assert.deepEqual([s.tables, s.columns, s.checks, s.functions, s.triggers, s.programme_flags], [0, 0, 0, 0, 0, 0]);
  });

  it("J1 — re-running the body on that shape keeps every host oid and the definition fingerprint (a no-op, as on portava-ci)", () => {
    const out = exec(`BEGIN;\n${CATALOG};\nSELECT '---';\n${M4003.body}\n${CATALOG};\nROLLBACK;`);
    const sep = out.indexOf("---");
    assert.ok(sep > 0, out.join("\n"));
    assert.ok(sep >= 4, `anti-vacuity: the snapshot read the host tables (${sep} rows)`);
    assert.ok(out.slice(0, sep).some((l) => l.startsWith("fingerprint:")), "the fingerprint was in the snapshot");
    assert.deepEqual(out.slice(sep + 1), out.slice(0, sep), "no oid changed and the fingerprint is identical");
  });

  it("J2 — on production's shape the body retires everything, the host rows survive, and the postconditions hold", () => {
    const out = exec(`BEGIN;
      ${programmeShape(USER)}
      ${STATE}
      SELECT 'sessions_before=' || count(*) FROM public.location_sessions WHERE user_id = '${USER}';
      SELECT 'flags_before=' || count(*) FROM public.feature_flags;
      ${M4003.body}
      ${M4003.postconditions}
      ${STATE}
      SELECT 'sessions_after=' || count(*) FROM public.location_sessions WHERE user_id = '${USER}';
      SELECT 'flags_after=' || count(*) FROM public.feature_flags;
      ROLLBACK;`);
    const states = out.filter((l) => l.startsWith("state=")).map((l) => JSON.parse(l.slice("state=".length)));
    assert.equal(states.length, 2, out.join("\n"));
    const [before, after] = states;
    assert.deepEqual(
      [before.tables, before.columns, before.checks, before.functions, before.triggers, before.programme_flags],
      [9, 6, 2, 37, 3, 3],
      "the rebuilt shape is production's: 9 tables, 6 columns, 2 checks, 36 functions + 1 unrecorded overload, 3 triggers, 3 flags",
    );
    assert.deepEqual([after.tables, after.columns, after.checks, after.functions, after.triggers, after.programme_flags], [0, 0, 0, 0, 0, 0]);
    assert.equal(after.host_columns, before.host_columns - 6, "the host tables lost exactly the six programme columns");
    const n = Object.fromEntries(out.filter((l) => /^(sessions|flags)_(before|after)=/.test(l)).map((l) => l.split("=")));
    assert.equal(n["sessions_after"], n["sessions_before"], "the host session rows survive");
    assert.equal(Number(n["flags_after"]), Number(n["flags_before"]) - 3, "exactly the three programme flag rows went");
  });

  it("J3 — each premise refuses by name and the file says it changed nothing", () => {
    const refusals: ReadonlyArray<readonly [string, string, RegExp]> = [
      ["a programme row", `INSERT INTO public.journey_observations (id, location_session_id, user_id) VALUES (gen_random_uuid(), (SELECT id FROM public.location_sessions WHERE user_id = '${USER}' LIMIT 1), '${USER}');`, /journey_observations holds 1 row/],
      ["an open programme session", `INSERT INTO public.location_sessions (user_id, session_type, expires_at, journey_purpose) VALUES ('${USER}', 'auto', now() + interval '1 hour', 'journey_observation_v1');`, /1 location session\(s\) carry journey_purpose = journey_observation_v1/],
      ["a consenting preference row", `UPDATE public.user_location_preferences SET journey_observation_enabled = true, journey_consent_scope = 'journey_observation_v1', journey_consent_version = 1, journey_consent_granted_at = now() WHERE user_id = '${USER}';`, /1 preference row\(s\) have journey_observation_enabled on/],
      ["an enabled programme flag", `UPDATE public.feature_flags SET enabled = true WHERE flag = 'COMPASS_JOURNEY_ENGINE_ENABLED';`, /enabled or unknown to this file: COMPASS_JOURNEY_ENGINE_ENABLED/],
      ["a programme flag the file does not know", `INSERT INTO public.feature_flags (flag, enabled) VALUES ('COMPASS_JOURNEY_SOMETHING_NEW', false);`, /unknown to this file: COMPASS_JOURNEY_SOMETHING_NEW/],
      ["an outside function naming a programme object", `CREATE FUNCTION public.location_session_tidy_4003() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN DELETE FROM public.journey_observations WHERE false; END $f$;`, /outside the programme name a programme object: location_session_tidy_4003/],
      ["a view on a programme table", `CREATE VIEW public.stage_overview_4003 AS SELECT * FROM public.journey_shadow_stages;`, /view\(s\) depend on the programme: stage_overview_4003/],
      ["a view on a programme column", `CREATE VIEW public.session_purposes_4003 AS SELECT id, journey_purpose FROM public.location_sessions;`, /view\(s\) depend on the programme: session_purposes_4003/],
      ["a foreign key from outside the programme", `CREATE TABLE public.stage_notes_4003 (id serial PRIMARY KEY, stage_id uuid REFERENCES public.journey_shadow_stages(id));`, /foreign key\(s\) from outside the programme into it: stage_notes_4003_stage_id_fkey/],
    ];
    for (const [label, violation, expected] of refusals) {
      const r = psql(`BEGIN;\n${programmeShape(USER)}\n${violation}\n${M4003.body}\nROLLBACK;`);
      assert.notEqual(r.status, 0, `${label}: the body must refuse`);
      assert.match(r.stderr, expected, `${label}: the refusal names what it found\n${r.stderr}`);
      assert.match(r.stderr, /refuses to retire it and changes nothing/, `${label}: and says it changed nothing`);
    }
    // Anti-vacuity: the same shape without a violation retires cleanly.
    const clean = psql(`BEGIN;\n${programmeShape(USER)}\n${M4003.body}\nROLLBACK;`);
    assert.equal(clean.status, 0, `the premises hold on the plain shape\n${clean.stderr}`);
  });
});
