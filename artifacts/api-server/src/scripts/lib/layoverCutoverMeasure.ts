/**
 * The 2411 cutover MEASUREMENT: how the query is built, and what its counts mean.
 *
 * ── WHY THE MEASUREMENT IS AN ARTIFACT ───────────────────────────────────────
 * `check:layover-cutover` blocks 2411 on NON_VACUITY, and that is not a code
 * problem: 2411 declares no schema object, so its whole effect is a row count,
 * and a row count is OPERATIONAL DATA. The migration's header carries a hand
 * measurement; the checker refuses it, because a comment is not a measurement and
 * prose cannot go stale in any way a machine can detect.
 *
 * So the measurement is a committed, reviewable JSON artifact. This module is how
 * the query is CONSTRUCTED and how the counts are READ — deliberately pure, with
 * no database client and no credential handling, so both halves can be unit
 * tested and so the SQL can be reviewed by anyone without a project to point it
 * at. `emitLayoverCutoverSql.ts` prints it; nothing here talks to a database.
 *
 * ── THE DERIVATION IS LIFTED, NOT RETYPED ────────────────────────────────────
 * `extractDerivation` takes the CASE expression out of 2411 itself. Retyping it
 * would let the artifact and the migration drift apart silently — the same defect
 * as 2411's SQL drifting from the service's `recommendationKey`, where every
 * backfilled key would be one the writer never generates and the cutover sweep
 * would delete exactly the rows 2411 exists to protect. The checksum is what
 * makes such a drift visible: counts taken under one algorithm are not evidence
 * about another.
 */
import { createHash } from "node:crypto";

export const CUTOVER_FLAG = "layover_stable_recommendation_ids_enabled";

/** The rec_key CASE expression, taken out of the migration rather than restated. */
export function extractDerivation(migrationSql: string): string | null {
  const start = migrationSql.indexOf("CASE\n");
  if (start === -1) return null;
  const marker = "END AS rec_key";
  const end = migrationSql.indexOf(marker, start);
  if (end === -1) return null;
  return migrationSql.slice(start, end + marker.length).replace(/\s+/g, " ").trim();
}

export function derivationChecksum(derivation: string): string {
  return createHash("sha256").update(derivation).digest("hex").slice(0, 16);
}

/** The read-only measurement query, built from the migration's own derivation. */
export function buildSql(derivation: string): string {
  const caseExpr = derivation.replace(/\s*END AS rec_key$/, " END");
  return `-- 2411 cutover measurement. READ-ONLY: SELECTs only, counts and shapes only.
-- Nothing identifying may leave this query — no titles, no cities, no ids — because
-- its result is committed to the repository and read in a diff.
WITH derived AS (
  SELECT r.id, r.session_id, r.status,
         ${caseExpr} AS derived_key
    FROM public.layover_recommendations r
   WHERE r.rec_key IS NULL
),
ambiguous AS (
  SELECT d.* FROM derived d
   WHERE d.derived_key IS NULL
      OR 1 <> (SELECT count(*) FROM derived d2
                WHERE d2.session_id = d.session_id AND d2.derived_key = d.derived_key)
      OR EXISTS (SELECT 1 FROM public.layover_recommendations x
                  WHERE x.session_id = d.session_id AND x.rec_key = d.derived_key
                    AND x.rec_key IS NOT NULL)
)
SELECT
  (SELECT count(*) FROM public.layover_recommendations)                            AS total_rows,
  (SELECT count(*) FROM public.layover_recommendations WHERE rec_key IS NULL)      AS legacy_rows,
  (SELECT count(*) FROM public.layover_recommendations
     WHERE rec_key IS NULL AND status IS DISTINCT FROM 'active')                   AS legacy_moderated,
  (SELECT count(*) FROM ambiguous)                                                  AS ambiguous_derivations,
  (SELECT count(*) FROM ambiguous WHERE status IS DISTINCT FROM 'active')           AS ambiguous_moderated,
  (SELECT count(*) FROM (SELECT session_id, derived_key FROM derived
                          WHERE derived_key IS NOT NULL
                          GROUP BY session_id, derived_key HAVING count(*) > 1) c)  AS colliding_derived_keys,
  (SELECT count(*) FROM public.layover_plan_stops s
     JOIN public.layover_recommendations r ON r.id = s.recommendation_id
    WHERE r.rec_key IS NULL)                                                        AS plan_stops_on_legacy_rows,
  (SELECT count(DISTINCT session_id) FROM public.layover_recommendations)           AS distinct_sessions,
  (SELECT enabled FROM public.feature_flags WHERE flag = '${CUTOVER_FLAG}')         AS cutover_flag,
  (SELECT to_regclass('public.layover_recs_session_key_uidx') IS NOT NULL)          AS unique_index_present,
  (SELECT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='layover_recommendations'
                     AND column_name='rec_key'))                                    AS rec_key_column_present;`;
}

export interface CutoverCounts {
  legacyRows: number;
  legacyModerated: number;
  ambiguousModerated: number;
  collidingDerivedKeys: number;
  planStopsOnLegacyRows: number;
}

export type CutoverVerdict = "REQUIRED" | "OPTIONAL" | "UNSAFE" | "NO_OP";

/**
 * The verdict, DERIVED from the counts rather than asserted next to them.
 *
 *   UNSAFE    2411's own postcondition would abort, or it cannot key rows whose
 *             moderation state it exists to preserve.
 *   NO_OP     there is nothing left to key.
 *   REQUIRED  something measured would be lost to the cutover sweep without it.
 *   OPTIONAL  it would write keys, and nothing measured depends on them.
 *
 * OPTIONAL is the answer nobody wants and the one that has to be sayable. A
 * migration that writes rows while protecting nothing is not "safe because it is
 * harmless" — it is a change with no reason, and rounding that up to REQUIRED
 * because it is easier to justify applying is exactly the kind of metric-shaped
 * dishonesty this gate exists to prevent.
 */
export function verdictOf(m: CutoverCounts): { verdict: CutoverVerdict; why: string } {
  if (m.collidingDerivedKeys > 0) {
    return {
      verdict: "UNSAFE",
      why: `${m.collidingDerivedKeys} derived key(s) collide on (session_id, rec_key); 2411's own postcondition would abort.`,
    };
  }
  if (m.ambiguousModerated > 0) {
    return {
      verdict: "UNSAFE",
      why: `${m.ambiguousModerated} moderated row(s) cannot be keyed unambiguously, so the cutover would discard exactly the state 2411 exists to preserve.`,
    };
  }
  if (m.legacyRows === 0) {
    return { verdict: "NO_OP", why: "every row already carries a rec_key; the backfill would update nothing." };
  }
  if (m.legacyModerated > 0 || m.planStopsOnLegacyRows > 0) {
    return {
      verdict: "REQUIRED",
      why: `${m.legacyModerated} moderated row(s) and ${m.planStopsOnLegacyRows} plan-stop reference(s) would be lost to the cutover sweep without it.`,
    };
  }
  return {
    verdict: "OPTIONAL",
    why: `${m.legacyRows} row(s) would receive a key, but 0 are moderated and 0 are referenced by a plan stop — nothing measured depends on their ids surviving the cutover sweep.`,
  };
}
