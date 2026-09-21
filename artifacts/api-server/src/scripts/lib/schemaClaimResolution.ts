/**
 * audit:schema — the pure half: what a migration CLAIMS, what the database HAS,
 * and whether the claim is unmet.
 *
 * EXTRACTED 2026-09-09, and the reason is a guard doing its job. The mutation
 * test for the authz widening below lived next to the auditor and therefore
 * named Supabase credential env vars (the auditor asserts its target at import,
 * so the test had to set them first). check:guard-coverage flagged it: a file
 * that can reach Supabase must import a guard front door. It could not — the
 * front door asserts on import, i.e. BEFORE the test could set anything.
 *
 * The answer is not to exempt the test. It is that `isMissing` never needed a
 * database in the first place: it compares two in-memory structures. Moving it
 * here makes that true in the type system as well as in fact, and the test can
 * import a module with no side effects, no credentials and no guard.
 *
 * This mirrors src/scripts/lib/transformedFunction.ts, censusHeadCommit.ts and
 * policyCitations.ts: the guard predicate is extracted so it can be tested
 * without booting the thing that uses it.
 */

export interface LiveSchema {
  relations: Set<string>; // tables + views + matviews
  columns: Set<string>; // "table.column"
  functions: Set<string>; // public only
  /**
   * `authz` functions, kept SEPARATE from `functions` on purpose.
   *
   * Migrations create membership predicates in `authz` because that schema is
   * not in PostgREST's db-schemas, so a predicate there is reachable by RLS but
   * not exposed as an RPC endpoint. The claim extractor is name-keyed and does
   * not record the schema, so a claim cannot say which one it meant. Resolving
   * both into one set would let a function that BELONGS in public pass while
   * living only in authz; keeping them apart lets the audit resolve the claim
   * and still SAY that it resolved somewhere other than public.
   */
  authzFunctions: Set<string>;
  indexes: Set<string>;
  policies: Set<string>; // "table.policy"
  enums: Set<string>;
  enumValues: Set<string>; // "enum.value"
  triggers: Set<string>; // "table.trigger"
  rlsEnabled: Set<string>; // tables with pg_class.relrowsecurity = true
  tableGrants: Set<string>; // "table.grantee.privilege"
  routineGrants: Set<string>; // "function.grantee" (EXECUTE only), routine_schema = public
  /**
   * The same, for `authz`. Kept APART from `routineGrants` for the reason
   * `authzFunctions` is kept apart from `functions`, and then some.
   *
   * MEASURED 2026-09-09, and this is why the split matters. Widening the
   * EXISTENCE check to public-OR-authz without widening this one made eight
   * present grants read as MISSING: `!live.functions.has(fn)` used to be true
   * for an authz function and short-circuited the whole grantfn claim, so the
   * grant was never checked. Once the function resolved, the claim WAS checked
   * — against a grant catalogue that still only knew `public`. Every one of
   * `viewer_in_call`, `is_trip_crew`, `accepted_trip_ids`, `shares_accepted_trip`,
   * `accepted_trip_role`, `geofence_trip_id`, `is_active_thread_member` and
   * `is_meetup_invitee` holds EXECUTE for anon on the live database.
   *
   * THE NAME-KEY LIMITATION, STATED. Claims are name-keyed — a migration's
   * `GRANT EXECUTE ON FUNCTION authz.f(...)` and one on `public.f(...)` produce
   * the same claim key — so a satisfied grant on EITHER schema satisfies the
   * claim. Exactly one name is currently in both schemas on portava-ci:
   * `is_accepted_trip_member`. That is not hypothetical comfort — it is the one
   * of 2337's five grants that did NOT report missing in the run that found this
   * defect, because `public.is_accepted_trip_member` carries the anon grant and
   * the name-keyed lookup found it there. `collidingFunctionNames` below exists
   * so that case is REPORTED rather than silently trusted.
   */
  authzRoutineGrants: Set<string>;
  /** Function names present in BOTH schemas, where a name-keyed answer cannot
   *  say which one satisfied a claim. Reported, not assumed away. */
  collidingFunctionNames: Set<string>;
}

export interface Claim {
  kind:
    | "table"
    | "column"
    | "function"
    | "index"
    | "policy"
    | "enum"
    | "enumvalue"
    | "trigger"
    | "view"
    | "rls"
    | "grant"
    | "grantfn";
  /** allowlist / report key, e.g. "column:feature_flags.key" */
  key: string;
  label: string;
}

export function isMissing(claim: Claim, live: LiveSchema): boolean {
  const key = claim.key.slice(claim.kind.length + 1);
  switch (claim.kind) {
    case "table":
    case "view":
      // legacy buddy_* relations live as views; any relation kind counts
      return !live.relations.has(key);
    case "column": {
      const [table] = key.split(".");
      // If the table itself is missing it's already reported; a column claim
      // on a view (compat layer) is checked against columns of that view too
      // (information_schema.columns includes view columns).
      if (!live.relations.has(table)) return false;
      return !live.columns.has(key);
    }
    case "function":
      // Resolved in EITHER schema. See LiveSchema.authzFunctions for why the
      // two sets are kept apart, and `authzOnly` in main() for how an
      // authz-only resolution is reported rather than passed in silence.
      return !live.functions.has(key) && !live.authzFunctions.has(key);
    case "index":
      return !live.indexes.has(key);
    case "policy":
      return !live.policies.has(key);
    case "enum":
      return !live.enums.has(key);
    case "enumvalue":
      return !live.enumValues.has(key);
    case "trigger":
      return !live.triggers.has(key);
    case "rls": {
      // THE DISCRIMINATION THAT MAKES THIS CLAIM TYPE USABLE. A great many RLS
      // claims come from conditional blocks (`IF to_regclass(...) IS NOT NULL`,
      // `EXCEPTION WHEN undefined_table`) written to be safe on environments
      // where the table does not exist. Reporting those as drift would flood
      // the output with statements that were correctly skipped and drown the
      // one case that matters. Absent table → not drift; the missing TABLE is
      // reported separately by its own claim if a migration declares it.
      if (!live.relations.has(key)) return false;
      return !live.rlsEnabled.has(key);
    }
    case "grant": {
      const [table] = key.split(".");
      if (!live.relations.has(table)) return false;
      return !live.tableGrants.has(key);
    }
    case "grantfn": {
      const [fn] = key.split(".");
      // A grant on a function that does not exist is not a MISSING GRANT; the
      // missing FUNCTION is the finding, and it is reported by its own claim.
      if (!live.functions.has(fn) && !live.authzFunctions.has(fn)) return false;
      // Both catalogues, for the same reason the line above reads both schemas.
      // See LiveSchema.authzRoutineGrants for what checking only `public` here
      // cost, measured.
      return !live.routineGrants.has(key) && !live.authzRoutineGrants.has(key);
    }
  }
}
