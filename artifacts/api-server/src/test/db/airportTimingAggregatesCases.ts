/**
 * The SQL cases of airportTimingAggregates.db.test.ts — census-layover L159 /
 * L161, migrations 3789 and 3790 — kept in their own module so the same text
 * the CI local-db job runs on the replayed chain can be rehearsed elsewhere
 * (the authoring lane ran it on PGlite over a fixture of the touched objects).
 *
 * Every case is SELF-ASSERTING SQL: it raises if what it checks is false. The
 * runner wraps each in BEGIN … ROLLBACK, so nothing a case plants, flips,
 * folds, deletes or drops survives it. A case with `error` must FAIL, with a
 * message matching it (ON_ERROR_STOP aborts the script; the transaction dies
 * with the connection).
 *
 * The rollback files carry their own BEGIN/COMMIT; `withoutTxControl` strips
 * them before a case embeds one, or the file's COMMIT would commit the case's
 * transaction and really drop the table under every later suite.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations");
const ROLLBACKS = join(HERE, "..", "..", "..", "..", "..", "db", "rollback");

export const M3789 = readFileSync(join(MIGRATIONS, "3789_layover_operational_expiry_sweep_flag.sql"), "utf8");
export const M3790 = readFileSync(join(MIGRATIONS, "3790_airport_timing_aggregates.sql"), "utf8");
export const R3789 = readFileSync(join(ROLLBACKS, "2026-10-14-3789-layover-operational-expiry-sweep-flag-rollback.sql"), "utf8");
export const R3790 = readFileSync(join(ROLLBACKS, "2026-10-14-3790-airport-timing-aggregates-rollback.sql"), "utf8");

/** A migration's `DO $post$ … $post$;` block, run alone as the live applier runs it. */
export function postconditionOf(sql: string): string {
  const m = sql.match(/DO \$post\$[\s\S]*?\$post\$;/);
  if (!m) throw new Error("no $post$ block");
  return m[0];
}

/** The file without its own transaction control, so it can run inside a rolled-back case. */
export function withoutTxControl(sql: string): string {
  return sql.replace(/^\s*(BEGIN|COMMIT);\s*$/gm, "");
}

/** An hour-aligned instant two hours back, computed without the session TimeZone. */
const WS = `(to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600) - interval '2 hours')`;

/**
 * Plant `n` expired community readings at airport `ref` inside one UTC hour two
 * hours back, from `observers` distinct handles (the rest repeat the first).
 * Ids carry a fixed prefix no producer mints.
 */
export function plant(ref: string, n: number, observers: number, opts: { kind?: string; expiresInMin?: number; idPrefix?: string } = {}): string {
  const prefix = opts.idPrefix ?? "a1e2b3c4-0000-4000-8000";
  const expires = opts.expiresInMin === undefined
    ? `${WS} + make_interval(mins => g + 45)`
    : `now() + make_interval(mins => ${opts.expiresInMin})`;
  return `INSERT INTO public.airport_fact_observations
    (id, airport_ref, fact_type, fact_class, value, observer_kind, observer_id, source_ref, observed_at, expires_at)
  SELECT ('${prefix}-' || lpad(to_hex(g), 12, '0'))::uuid, '${ref}', 'queue_report_minutes', 'TRAVELER_OBSERVATION', 4 + g,
         '${opts.kind ?? "community"}', 'tv1-' || lpad(to_hex(CASE WHEN g <= ${observers} THEN g ELSE 1 END), 40, '0'),
         'portava:layover/traveller-report', ${WS} + make_interval(mins => g), ${expires}
    FROM generate_series(1, ${n}) AS g;`;
}

/** The one-band commit for the readings `plant(ref, …)` made, claiming `samples` / `observers`. */
export function commitSql(ref: string, samples: number, observers: number, opts: { extraIds?: string; role?: string; cutoff?: string } = {}): string {
  return `${opts.role ? `SET LOCAL ROLE ${opts.role};` : ""}
  SELECT public.airport_timing_fold_commit(
    jsonb_build_array(jsonb_build_object(
      'airport_ref', '${ref}', 'fact_type', 'queue_report_minutes', 'local_hour', 7,
      'window_start', ${WS}, 'window_end', ${WS} + interval '1 hour',
      'sample_count', ${samples}, 'distinct_observers', ${observers},
      'p50_minutes', 10, 'p75_minutes', 12, 'p90_minutes', 15, 'truth_version', 'db-test')),
    jsonb_build_array((SELECT to_jsonb(array_agg(o.id ORDER BY o.id)) FROM public.airport_fact_observations o WHERE o.airport_ref = '${ref}' AND o.observer_kind = 'community' AND o.expires_at <= now())),
    (SELECT array_agg(o.id ORDER BY o.id) FROM public.airport_fact_observations o WHERE o.airport_ref = '${ref}')${opts.extraIds ? ` || ${opts.extraIds}` : ""},
    ${opts.cutoff ?? "now()"}
  );
  `;
}

const FLAG_ON = `UPDATE public.feature_flags SET enabled = true WHERE flag = 'airport_timing_aggregate_enabled';`;
const assertSql = (cond: string, msg: string) => `DO $a$ BEGIN IF NOT (${cond}) THEN RAISE EXCEPTION 'ASSERTION FAILED: %', ${`'${msg.replace(/'/g, "''")}'`}; END IF; END $a$;`;
const count = (where: string) => `(SELECT count(*) FROM public.airport_fact_observations WHERE ${where})`;
const aggCount = (ref: string) => `(SELECT count(*) FROM public.airport_timing_aggregates WHERE airport_ref = '${ref}')`;

export interface DbCase { id: string; name: string; sql: string; error?: RegExp }

/** What a commit DID, re-derived from the tables rather than taken from its own answer. */
function committedAs(ref: string, inserted: number, deleted: number): string {
  return [
    assertSql(`${aggCount(ref)} = ${inserted}`, `${inserted} aggregate(s) stored for ${ref}`),
    assertSql(`${count(`airport_ref = '${ref}' AND observer_kind = 'community'`)} = ${12 - deleted}`, `${deleted} reading(s) deleted for ${ref}`),
  ].join("\n");
}

export function airportTimingDbCases(): DbCase[] {
  return [
    {
      id: "D1",
      name: "3789 and 3790 are applied: both flags seeded FALSE, and each $post$ passes run alone",
      sql: [
        assertSql(`(SELECT enabled FROM public.feature_flags WHERE flag = 'layover_operational_expiry_sweep_enabled') = false`, "3789 flag FALSE"),
        assertSql(`(SELECT enabled FROM public.feature_flags WHERE flag = 'airport_timing_aggregate_enabled') = false`, "3790 flag FALSE"),
        postconditionOf(M3789),
        postconditionOf(M3790),
      ].join("\n"),
    },
    {
      id: "D2",
      name: "flag OFF: the commit answers disabled and writes and deletes NOTHING",
      sql: [plant("QZA", 12, 10), commitSql("QZA", 12, 10, { role: "service_role" }), `RESET ROLE;`, committedAs("QZA", 0, 0)].join("\n"),
    },
    {
      id: "D3",
      name: "flag ON, as service_role: one verified band is stored and exactly its twelve raw readings are deleted, in one statement",
      sql: [
        FLAG_ON, plant("QZB", 12, 10), commitSql("QZB", 12, 10, { role: "service_role" }), `RESET ROLE;`, committedAs("QZB", 1, 12),
        assertSql(`(SELECT distinct_observers FROM public.airport_timing_aggregates WHERE airport_ref = 'QZB') = 10`, "the stored band is the claimed one"),
      ].join("\n"),
    },
    { id: "D4", name: "nine distinct observers are refused by the function (k = 10)", sql: [FLAG_ON, plant("QZC", 12, 9), commitSql("QZC", 12, 9, { role: "service_role" })].join("\n"), error: /floor is 10/ },
    { id: "D5", name: "a forged distinct-observer count is refused (recounted from the raw rows)", sql: [FLAG_ON, plant("QZD", 12, 9), commitSql("QZD", 12, 10, { role: "service_role" })].join("\n"), error: /does not match/ },
    { id: "D6", name: "a forged sample count is refused", sql: [FLAG_ON, plant("QZE", 12, 10), commitSql("QZE", 11, 10, { role: "service_role" })].join("\n"), error: /does not match/ },
    {
      id: "D7",
      name: "an UNEXPIRED reading in the delete set fails the WHOLE commit (the band inserted first rolls back with it)",
      sql: [FLAG_ON, plant("QZF", 12, 10), plant("QZF", 1, 1, { expiresInMin: 30, idPrefix: "a1e2b3c4-0000-4000-8001" }), commitSql("QZF", 12, 10, { role: "service_role" })].join("\n"),
      error: /still due/,
    },
    {
      id: "D8",
      name: "a future cutoff deletes nothing that has not expired (LEAST(cutoff, now()))",
      sql: [FLAG_ON, plant("QZG", 1, 1, { expiresInMin: 30 }), `SET LOCAL ROLE service_role; SELECT public.airport_timing_fold_commit('[]'::jsonb, '[]'::jsonb, (SELECT array_agg(id) FROM public.airport_fact_observations WHERE airport_ref = 'QZG'), now() + interval '1 day');`].join("\n"),
      error: /still due/,
    },
    {
      id: "D9",
      name: "a non-community reading is never deleted by the fold",
      sql: [FLAG_ON, plant("QZH", 1, 1, { kind: "operator_feed" }), `SET LOCAL ROLE service_role; SELECT public.airport_timing_fold_commit('[]'::jsonb, '[]'::jsonb, (SELECT array_agg(id) FROM public.airport_fact_observations WHERE airport_ref = 'QZH'), now());`].join("\n"),
      error: /still due/,
    },
    { id: "D10", name: "anon cannot read the aggregates", sql: `SET LOCAL ROLE anon; SELECT count(*) FROM public.airport_timing_aggregates;`, error: /permission denied/ },
    { id: "D11", name: "authenticated cannot read the aggregates", sql: `SET LOCAL ROLE authenticated; SELECT count(*) FROM public.airport_timing_aggregates;`, error: /permission denied/ },
    { id: "D12", name: "authenticated cannot execute the fold", sql: `SET LOCAL ROLE authenticated; SELECT public.airport_timing_fold_commit('[]'::jsonb, '[]'::jsonb, ARRAY[]::uuid[], now());`, error: /permission denied/ },
    { id: "D13", name: "anon cannot execute the fold", sql: `SET LOCAL ROLE anon; SELECT public.airport_timing_fold_commit('[]'::jsonb, '[]'::jsonb, ARRAY[]::uuid[], now());`, error: /permission denied/ },
    {
      id: "D14",
      name: "the CHECK refuses nine distinct observers even on a direct insert",
      sql: `INSERT INTO public.airport_timing_aggregates (airport_ref, fact_type, local_hour, window_start, window_end, sample_count, distinct_observers, p50_minutes, p75_minutes, p90_minutes, truth_version)
            VALUES ('QZI', 'queue_report_minutes', 7, ${WS}, ${WS} + interval '1 hour', 9, 9, 1, 2, 3, 'db-test');`,
      error: /airport_timing_aggregates_k_floor/,
    },
    {
      id: "D15",
      name: "service_role cannot rewrite a stored band (no UPDATE)",
      sql: `SET LOCAL ROLE service_role; UPDATE public.airport_timing_aggregates SET p90_minutes = p90_minutes;`,
      error: /permission denied/,
    },
    {
      id: "D16",
      name: "the L159 sweep's tables: service_role may delete from both, and no client role may",
      sql: [
        assertSql(`has_table_privilege('service_role', 'public.layover_checkpoints', 'DELETE') AND has_table_privilege('service_role', 'public.layover_presence', 'DELETE')`, "service_role DELETE"),
        assertSql(`NOT has_table_privilege('authenticated', 'public.layover_checkpoints', 'DELETE') AND NOT has_table_privilege('anon', 'public.layover_presence', 'DELETE')`, "no client DELETE"),
      ].join("\n"),
    },
    { id: "D17", name: "3790's rollback refuses while the flag is ON", sql: [FLAG_ON, withoutTxControl(R3790)].join("\n"), error: /ROLLBACK REFUSED \(3790\): airport_timing_aggregate_enabled is TRUE/ },
    {
      id: "D18",
      name: "3790's rollback refuses while an aggregate exists (its raw readings are gone)",
      sql: [FLAG_ON, plant("QZJ", 12, 10), commitSql("QZJ", 12, 10, { role: "service_role" }), `RESET ROLE;`,
        `UPDATE public.feature_flags SET enabled = false WHERE flag = 'airport_timing_aggregate_enabled';`, withoutTxControl(R3790)].join("\n"),
      error: /cannot be re-derived/,
    },
    {
      id: "D19",
      name: "3790's rollback, when empty and OFF, drops exactly its objects (rolled back with the case)",
      sql: [`DELETE FROM public.airport_timing_aggregates;`, withoutTxControl(R3790),
        assertSql(`to_regclass('public.airport_timing_aggregates') IS NULL AND to_regclass('public.airport_fact_observations') IS NOT NULL`, "3790's objects gone, 2860's kept")].join("\n"),
    },
    { id: "D20", name: "3789's rollback refuses while the flag is ON", sql: [`UPDATE public.feature_flags SET enabled = true WHERE flag = 'layover_operational_expiry_sweep_enabled';`, withoutTxControl(R3789)].join("\n"), error: /ROLLBACK REFUSED \(3789\)/ },
  ];
}
