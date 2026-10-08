/**
 * profileAuthorityColumns — 3742, and rule 6 of check:client-privilege-boundary
 * (lib/profileAuthorityColumns.ts), which keeps its defect from coming back.
 *
 * THE DEFECT. profiles_update admits a user's own row and RLS cannot restrict
 * columns, so every profiles column the server trusts needs a column barrier
 * (no client UPDATE grant) and a trigger barrier. verified, verified_at,
 * trust_score, trust_label, verification_method, featured_count and created_at
 * had neither; account_status had neither on main (3600, PR #592, adds its
 * trigger); is_official and 2163's nine verification columns had the trigger
 * but kept the grant. Confirmed in production by the lead's catalog query.
 *
 * WHAT IS PROVEN HERE, OFFLINE (the executed proof against PostgreSQL is
 * src/test/db/profileAuthorityColumns.db.test.ts, run by CI's local-db job):
 *   M-*   3742's lists, its trigger's shape, its INSERT defaults against the
 *         schema's, its blocks as certify:migrations classifies them, its
 *         rollback, and that no earlier re-runnable postcondition pins what it
 *         takes away.
 *   R6-*  rule 6 on the real tree (green), without 3742 (names exactly what
 *         3742 fixes — the mutation proof is a test), and over planted
 *         re-grants and trigger regressions.
 *   P-1   the premise: no client tree writes an authority column of profiles.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clientUpdatableAuthorityColumns,
  predicateRedefinitions,
  PROFILE_AUTHORITY_COLUMNS,
  replayProfilesTriggers,
  replayProfilesUpdateAcl,
  unguardedAuthorityColumns,
  type MigrationText,
} from "../scripts/lib/profileAuthorityColumns.js";
import { isAssertionOnlyDoBlock, isPreconditionDoBlock, topLevelStatements } from "../scripts/lib/migrationSqlBlocks.js";
import { BASELINE_PATH } from "../scripts/parseBaselineSchema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const MIGRATIONS = join(API_ROOT, "src", "migrations");
const THE_FILE = "3742_profiles_authority_columns_server_only.sql";
const ROLLBACK = join(REPO_ROOT, "db", "rollback", "2026-10-07-3742-profiles-authority-columns-server-only-rollback.sql");

const GUARDED = ["created_at", "featured_count", "trust_label", "trust_score", "verification_method", "verified", "verified_at"];
const REVOKED = [
  ...GUARDED,
  "account_status", "buddy_verified_at", "home_country_verified_at", "host_verified_at", "id_verified_at", "is_official",
  "role", "safety_flags_count", "selfie_verified_at", "verification_level", "verification_status", "verified_since",
].sort();

const baselineSql = readFileSync(BASELINE_PATH, "utf8");
const sql = readFileSync(join(MIGRATIONS, THE_FILE), "utf8");
const stmts = topLevelStatements(sql);
const sorted = (xs: Iterable<string>) => [...xs].sort();
const f = (name: string, text: string): MigrationText => ({ name, sql: text });

function chain(skip: readonly string[] = []): MigrationText[] {
  return readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql") && !skip.includes(n))
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") }));
}

/** The literal text[] a block declares under `name`. */
function literal(block: string, name: string): string[] {
  const at = block.indexOf(`${name} constant text[] := ARRAY[`);
  assert.ok(at >= 0, `no ${name} literal`);
  return [...block.slice(at, block.indexOf("];", at)).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
}

describe("3742 — the migration", () => {
  const fnDdl = (() => {
    const at = sql.indexOf("CREATE OR REPLACE FUNCTION public.enforce_profile_authority_privileged()");
    return sql.slice(at, sql.indexOf("$fn$;", at) + 5);
  })();

  it("M-1: one REVOKE takes column UPDATE on exactly the 19 authority columns from PUBLIC, anon and authenticated", () => {
    const m = /REVOKE UPDATE \(([^)]*)\) ON TABLE public\.profiles FROM PUBLIC, anon, authenticated;/.exec(sql);
    assert.ok(m, "no column REVOKE on profiles");
    assert.deepEqual(sorted(m![1]!.split(",").map((c) => c.trim())), REVOKED);
    assert.deepEqual(sorted(PROFILE_AUTHORITY_COLUMNS.map((c) => c.column)), REVOKED, "rule 6's list and 3742's REVOKE disagree");
    // The file grants nothing to anyone.
    assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /\bGRANT\b/);
  });

  it("M-2: the trigger guards each of the seven on INSERT and on UPDATE, asks the predicate only when one moved, and is SECURITY INVOKER", () => {
    for (const c of GUARDED) {
      assert.match(fnDdl, new RegExp(`NEW\\.${c} IS DISTINCT FROM OLD\\.${c} THEN '${c}'`), `${c}: update side`);
      assert.match(fnDdl, new RegExp(`WHEN NEW\\.${c} IS (DISTINCT FROM [^O]|NOT NULL)[^\\n]*THEN '${c}'`), `${c}: insert side`);
    }
    assert.match(fnDdl, /SECURITY INVOKER/);
    assert.doesNotMatch(fnDdl, /SECURITY DEFINER/);
    assert.match(fnDdl, /IF v_changed <> '' THEN\s+IF NOT public\.caller_may_write_profile_role\(\) THEN\s+RAISE EXCEPTION/);
    assert.match(fnDdl, /ERRCODE = '42501'/);
    assert.match(
      sql,
      /CREATE TRIGGER trg_profiles_authority_privileged\s+BEFORE INSERT OR UPDATE ON public\.profiles\s+FOR EACH ROW EXECUTE FUNCTION public\.enforce_profile_authority_privileged\(\);/,
    );
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.enforce_profile_authority_privileged\(\) FROM PUBLIC, anon, authenticated;/);
  });

  it("M-3: the INSERT defaults the trigger admits are the schema's column defaults (else every signup is refused)", () => {
    const table = /CREATE TABLE public\.profiles \(([\s\S]*?)\n\);/.exec(baselineSql)![1]!;
    const def = (c: string) => {
      const line = new RegExp(`^\\s+${c} [^\\n]*$`, "m").exec(table)![0];
      const m = / DEFAULT (.+?)(?: NOT NULL)?,?$/.exec(line);
      return m ? m[1]! : null;
    };
    const expected: Record<string, string | null> = {
      verified: "false", verified_at: null, trust_score: "70", trust_label: "'New Traveler'::text",
      verification_method: null, featured_count: "0", created_at: "now()",
    };
    for (const [c, want] of Object.entries(expected)) assert.equal(def(c), want, `${c}: the baseline default moved`);
    // What the trigger compares on INSERT, column by column.
    assert.match(fnDdl, /NEW\.verified IS DISTINCT FROM false THEN/);
    assert.match(fnDdl, /NEW\.verified_at IS NOT NULL THEN/);
    assert.match(fnDdl, /NEW\.trust_score IS DISTINCT FROM 70 THEN/);
    assert.match(fnDdl, /NEW\.trust_label IS DISTINCT FROM 'New Traveler' THEN/);
    assert.match(fnDdl, /NEW\.verification_method IS NOT NULL THEN/);
    assert.match(fnDdl, /NEW\.featured_count IS DISTINCT FROM 0 THEN/);
    assert.match(fnDdl, /NEW\.created_at IS DISTINCT FROM now\(\) THEN/);
    // The $pre$ block refuses a database whose defaults differ, with the same values.
    for (const v of ["('verified', 'false')", "('verified_at', NULL)", "('trust_score', '70')", "('trust_label', '''New Traveler''::text')", "('verification_method', NULL)", "('featured_count', '0')", "('created_at', 'now()')"]) {
      assert.ok(sql.includes(v), `$pre$ default check lacks ${v}`);
    }
    // No later file moves one of these defaults (it would have to move the trigger with it).
    const movers = chain()
      .filter((m) => m.name !== THE_FILE)
      .filter((m) => new RegExp(String.raw`alter\s+table\s+(?:only\s+)?(?:public\.)?profiles\b[^;]*alter\s+column\s+(?:${GUARDED.join("|")})\s+(?:set|drop)\s+default`, "i").test(m.sql))
      .map((m) => m.name);
    assert.deepEqual(movers, []);
  });

  it("M-4: certify:migrations holds the $pre$ block back and re-runs the $post$ block, which sits after COMMIT", () => {
    const pre = stmts.filter((s) => isAssertionOnlyDoBlock(s) && isPreconditionDoBlock(s));
    const post = stmts.filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
    assert.equal(pre.length, 1, "exactly one $pre$ block");
    assert.equal(post.length, 1, "exactly one re-runnable postcondition");
    assert.match(post[0]!, /3742 POSTCONDITION FAILED/);
    assert.ok(sql.indexOf("DO $post$") > sql.lastIndexOf("\nCOMMIT;"), "the postcondition must run after COMMIT");
    assert.deepEqual(sorted(literal(post[0]!, "v_revoked")), REVOKED);
    assert.deepEqual(sorted(literal(post[0]!, "v_guarded")), GUARDED);
    assert.deepEqual(sorted(literal(pre[0]!, "v_cols")), REVOKED);
  });

  it("M-5: no earlier re-runnable postcondition pins a client UPDATE grant 3742 takes away (certify re-runs them on a full-chain build)", () => {
    // Files whose re-runnable blocks read profiles' column privileges at all.
    const readers: string[] = [];
    for (const m of chain().filter((x) => x.name < THE_FILE)) {
      for (const st of topLevelStatements(m.sql)) {
        if (!isAssertionOnlyDoBlock(st) || isPreconditionDoBlock(st)) continue;
        if (!/\bprofiles\b/.test(st) || !/has_column_privilege|column_privileges|aclexplode\(\s*a\.attacl/.test(st)) continue;
        if (!readers.includes(m.name)) readers.push(m.name);
      }
    }
    // 3740 pins NO MORE than the baseline's UPDATE columns (verifier F5) and a
    // floor only on SELECT; 2982 names profiles in a message about another
    // table; 3600 (PR #592), when it lands, pins the ABSENCE of account_status.
    for (const r of readers) assert.match(r, /^(2982|3600|3740)_/, `${r} reads profiles column privileges in a re-runnable block; check it does not pin an UPDATE 3742 revokes`);
    const post3740 = topLevelStatements(readFileSync(join(MIGRATIONS, "3740_client_grant_excess_boundary.sql"), "utf8")).find(
      (s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s),
    )!;
    assert.doesNotMatch(post3740, /Missing:/);
    assert.doesNotMatch(post3740, /lost column UPDATE/);
    assert.match(post3740, /column UPDATE on public\.profiles exceeds the baseline''s\. Extra:/);
  });

  it("M-6: the rollback re-opens only the seven, keeps account_status with 3600, and clears the ledger row", () => {
    const rb = readFileSync(ROLLBACK, "utf8");
    const g = /GRANT UPDATE \(([^)]*)\) ON TABLE public\.profiles TO anon, authenticated;/.exec(rb);
    assert.ok(g);
    assert.deepEqual(sorted(g![1]!.split(",").map((c) => c.trim())), GUARDED);
    assert.match(rb, /DROP TRIGGER IF EXISTS trg_profiles_authority_privileged ON public\.profiles;/);
    assert.match(rb, /DROP FUNCTION IF EXISTS public\.enforce_profile_authority_privileged\(\);/);
    assert.match(rb, /DELETE FROM public\.schema_migration_ledger WHERE filename = '3742_profiles_authority_columns_server_only\.sql';/);
    assert.doesNotMatch(rb.replace(/--[^\n]*/g, ""), /GRANT[^;]*\baccount_status\b/);
  });

  it("M-7: the files ORDER_OVERRIDES.json moves or skips touch nothing rule 6 reads, so byte order is apply order here", () => {
    const o = JSON.parse(readFileSync(join(MIGRATIONS, "ORDER_OVERRIDES.json"), "utf8")) as { overrides: Array<Record<string, unknown>> };
    const named = o.overrides.map((x) => String(x["move"] ?? x["skip"]));
    assert.ok(named.length >= 1);
    for (const n of named) {
      const one = [f(n, readFileSync(join(MIGRATIONS, n), "utf8"))];
      assert.deepEqual(replayProfilesTriggers(one, ""), [], `${n} creates a profiles trigger`);
      const acl = replayProfilesUpdateAcl(one, "", "production");
      for (const r of ["anon", "authenticated", "public"] as const) {
        assert.deepEqual([acl[r].table, [...acl[r].cols]], [false, []], `${n} grants UPDATE on profiles to ${r}`);
      }
      assert.doesNotMatch(readFileSync(join(MIGRATIONS, n), "utf8"), /\b(?:grant|revoke)\b[^;]*\bon\s+(?:table\s+)?(?:public\.)?profiles\b/i, `${n} grants or revokes on profiles`);
    }
  });
});

describe("rule 6 — every profiles authority column is server-only", () => {
  it("R6-1: the real tree passes; the only pending trigger is account_status's (3600, PR #592)", () => {
    assert.deepEqual(clientUpdatableAuthorityColumns(chain(), baselineSql), []);
    const gaps = unguardedAuthorityColumns(chain(), baselineSql);
    assert.deepEqual(gaps.filter((g) => !g.pending), []);
    for (const g of gaps.filter((x) => x.pending)) assert.equal(g.column, "account_status");
    // The four guarding triggers the rule credits, read from the baseline and the chain.
    const names = replayProfilesTriggers(chain(), baselineSql).map((t) => t.name);
    for (const t of ["enforce_is_official_trigger", "trg_profiles_role_privileged", "trg_profiles_verification_privileged", "trg_profiles_authority_privileged"]) {
      assert.ok(names.includes(t), `${t} not seen`);
    }
  });

  it("R6-2: WITHOUT 3742 it names exactly the 18 granted authority columns, both roles, both models, and the seven unguarded ones", () => {
    const open = clientUpdatableAuthorityColumns(chain([THE_FILE]), baselineSql);
    assert.deepEqual(open.map((c) => c.column), REVOKED.filter((c) => c !== "role"));
    for (const c of open) {
      assert.deepEqual(c.roles, ["anon", "authenticated"], c.column);
      assert.deepEqual(c.models, ["default-acl", "production"], c.column);
    }
    const gaps = unguardedAuthorityColumns(chain([THE_FILE]), baselineSql).filter((g) => !g.pending);
    assert.deepEqual(sorted(gaps.map((g) => g.column)), GUARDED);
  });

  it("R6-3: without 3740 AND 3742 the default-ACL build exposes role too (table-level UPDATE); production does not", () => {
    const open = clientUpdatableAuthorityColumns(chain([THE_FILE, "3740_client_grant_excess_boundary.sql"]), baselineSql);
    const role = open.find((c) => c.column === "role");
    assert.deepEqual(role?.models, ["default-acl"]);
  });

  it("R6-4: a planted re-grant after 3742 is caught in every shape; text that only looks like one is not", () => {
    const after = (text: string) => clientUpdatableAuthorityColumns([...chain(), f("9999_x.sql", text)], baselineSql).map((c) => `${c.column}:${c.roles.join(",")}`);
    assert.deepEqual(after("GRANT UPDATE (verified_at) ON public.profiles TO anon;"), ["verified_at:anon"]);
    assert.equal(after("GRANT UPDATE ON TABLE public.profiles TO authenticated;").length, REVOKED.length);
    assert.equal(after("GRANT ALL ON profiles TO authenticated;").length, REVOKED.length);
    assert.equal(after("GRANT UPDATE ON ALL TABLES IN SCHEMA public TO anon;").length, REVOKED.length);
    assert.deepEqual(after("GRANT UPDATE (trust_score) ON public.profiles TO PUBLIC;"), ["trust_score:anon,authenticated"]);
    assert.deepEqual(after("DO $$ BEGIN EXECUTE 'GRANT UPDATE (verified) ON public.profiles TO authenticated'; END $$;"), ["verified:authenticated"]);
    assert.deepEqual(
      after("DO $$ DECLARE c text; BEGIN FOREACH c IN ARRAY ARRAY['featured_count'] LOOP EXECUTE format('GRANT UPDATE (%I) ON public.profiles TO anon', c); END LOOP; END $$;"),
      ["featured_count:anon"],
    );
    for (const quiet of [
      "GRANT UPDATE (bio, name) ON public.profiles TO authenticated;",
      "DO $$ BEGIN RAISE NOTICE $m$GRANT UPDATE ON public.profiles TO anon$m$; END $$;",
      "COMMENT ON TABLE public.profiles IS 'GRANT UPDATE ON public.profiles TO anon was never issued';",
      "-- GRANT UPDATE ON public.profiles TO anon;",
      "GRANT UPDATE (verified) ON public.rent_buddy_profiles TO authenticated;",
      "GRANT UPDATE (verified) ON public.profiles TO service_role;",
    ]) {
      assert.deepEqual(after(quiet), [], quiet);
    }
    // A later REVOKE takes it back again.
    assert.deepEqual(clientUpdatableAuthorityColumns([...chain(), f("9998_a.sql", "GRANT UPDATE (verified) ON public.profiles TO anon;"), f("9999_b.sql", "REVOKE UPDATE (verified) ON public.profiles FROM anon;")], baselineSql), []);
  });

  it("R6-5: a planted trigger regression after 3742 is caught", () => {
    const gaps = (text: string) => unguardedAuthorityColumns([...chain(), f("9999_x.sql", text)], baselineSql).filter((g) => !g.pending).map((g) => g.column);
    assert.deepEqual(sorted(gaps("DROP TRIGGER IF EXISTS trg_profiles_authority_privileged ON public.profiles;")), GUARDED);
    assert.deepEqual(sorted(gaps("ALTER TABLE public.profiles DISABLE TRIGGER trg_profiles_authority_privileged;")), GUARDED);
    assert.ok(gaps("ALTER TABLE ONLY public.profiles DISABLE TRIGGER ALL;").includes("role"));
    assert.deepEqual(sorted(gaps("DROP FUNCTION IF EXISTS public.enforce_profile_authority_privileged() CASCADE;")), GUARDED);
    const fnDdl = (() => {
      const at = sql.indexOf("CREATE OR REPLACE FUNCTION public.enforce_profile_authority_privileged()");
      return sql.slice(at, sql.indexOf("$fn$;", at) + 5);
    })();
    const weakened = fnDdl.replace(/^\s*CASE WHEN NEW\.trust_label IS DISTINCT FROM OLD\.trust_label THEN 'trust_label' END,\n/m, "");
    assert.notEqual(weakened, fnDdl);
    assert.deepEqual(gaps(weakened), ["trust_label"]);
    // Re-enabling restores it.
    assert.deepEqual(
      unguardedAuthorityColumns([...chain(), f("9998_a.sql", "ALTER TABLE public.profiles DISABLE TRIGGER trg_profiles_authority_privileged;"), f("9999_b.sql", "ALTER TABLE public.profiles ENABLE TRIGGER trg_profiles_authority_privileged;")], baselineSql).filter((g) => !g.pending),
      [],
    );
  });

  it("R6-5b: an INERT trigger is caught: WHEN (…), ENABLE REPLICA, rename-then-drop, UPDATE only, an early RETURN, a body only in comments or single-quoted (verifier G3 F2-F5)", () => {
    const gaps = (...texts: string[]) =>
      unguardedAuthorityColumns([...chain(), ...texts.map((t, i) => f(`999${i}_x.sql`, t))], baselineSql).filter((g) => !g.pending).map((g) => g.column);
    const fnDdl = (() => {
      const at = sql.indexOf("CREATE OR REPLACE FUNCTION public.enforce_profile_authority_privileged()");
      return sql.slice(at, sql.indexOf("$fn$;", at) + 5);
    })();
    const recreate = (shape: string) =>
      `DROP TRIGGER IF EXISTS trg_profiles_authority_privileged ON public.profiles;\nCREATE TRIGGER trg_profiles_authority_privileged ${shape} EXECUTE FUNCTION public.enforce_profile_authority_privileged();`;
    // F2: WHEN (false) never fires.
    assert.deepEqual(sorted(gaps(recreate("BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW WHEN (false)"))), GUARDED);
    // F5: UPDATE only leaves the INSERT door (an upsert, /profile/ensure) open.
    assert.deepEqual(sorted(gaps(recreate("BEFORE UPDATE ON public.profiles FOR EACH ROW"))), GUARDED);
    // The unconditional re-creation is still a guard (the two above are not vacuous).
    assert.deepEqual(gaps(recreate("BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW")), []);
    // F4: REPLICA fires only under session_replication_role = replica; ALWAYS fires always.
    assert.deepEqual(sorted(gaps("ALTER TABLE public.profiles ENABLE REPLICA TRIGGER trg_profiles_authority_privileged;")), GUARDED);
    assert.deepEqual(gaps("ALTER TABLE public.profiles ENABLE ALWAYS TRIGGER trg_profiles_authority_privileged;"), []);
    // F4: rename, then drop under the new name.
    assert.deepEqual(
      sorted(gaps("ALTER TRIGGER trg_profiles_authority_privileged ON public.profiles RENAME TO t2;", "DROP TRIGGER t2 ON public.profiles;")),
      GUARDED,
    );
    assert.deepEqual(gaps("ALTER TRIGGER trg_profiles_authority_privileged ON public.profiles RENAME TO t2;"), [], "a renamed trigger still guards");
    // A trigger holds its function by OID: renaming the function keeps the guard; dropping it under the new name does not.
    const inert = "CREATE OR REPLACE FUNCTION public.enforce_profile_authority_privileged() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW; END $x$;";
    assert.deepEqual(gaps("ALTER FUNCTION public.enforce_profile_authority_privileged() RENAME TO old_guard;", inert), []);
    assert.deepEqual(sorted(gaps("ALTER FUNCTION public.enforce_profile_authority_privileged() RENAME TO old_guard;", "DROP FUNCTION old_guard() CASCADE;")), GUARDED);
    // F4: a single-quoted body replaces the function (it used to be skipped, keeping the old body).
    assert.deepEqual(
      sorted(gaps("CREATE OR REPLACE FUNCTION public.enforce_profile_authority_privileged() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS 'BEGIN RETURN NEW; END';")),
      GUARDED,
    );
    // ...and a single-quoted body that does guard is read, not refused wholesale.
    const quoted = fnDdl.replace("AS $fn$", "AS '").replace(/\$fn\$;$/, "';").replace(/'(?!;$)/g, (q, at: number, all: string) => (at <= all.indexOf("AS '") + 3 ? q : "''"));
    assert.deepEqual(gaps(quoted), [], "the shipped body, single-quoted, still guards");
    // F3: every comparison kept behind an early RETURN NEW is dead code.
    const returnFirst = fnDdl.replace(/\$fn\$\nDECLARE\n  v_changed text;\nBEGIN\n/, "$&  RETURN NEW;\n");
    assert.notEqual(returnFirst, fnDdl);
    assert.deepEqual(sorted(gaps(returnFirst)), GUARDED);
    // A comparison that survives only in a comment guards nothing.
    const commented = fnDdl.replace(/^(\s*)(CASE WHEN NEW\.trust_label IS DISTINCT FROM OLD\.trust_label THEN 'trust_label' END,)$/m, "$1-- $2");
    assert.notEqual(commented, fnDdl);
    assert.deepEqual(gaps(commented), ["trust_label"]);
  });

  it("R6-8: any change to caller_may_write_profile_role() unguards every authority column; a re-statement equal modulo comments and whitespace does not (verifier G3 F1)", () => {
    assert.deepEqual(predicateRedefinitions(chain(), baselineSql), [], "the real chain changes the predicate");
    const all = (text: string) => {
      const gaps = unguardedAuthorityColumns([...chain(), f("9999_x.sql", text)], baselineSql);
      return { cols: sorted(gaps.map((g) => g.column)), redefined: predicateRedefinitions([...chain(), f("9999_x.sql", text)], baselineSql) };
    };
    const everyColumn = sorted(PROFILE_AUTHORITY_COLUMNS.map((c) => c.column));
    for (const change of [
      "CREATE OR REPLACE FUNCTION public.caller_may_write_profile_role() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;",
      "CREATE OR REPLACE FUNCTION public.caller_may_write_profile_role() RETURNS boolean LANGUAGE sql STABLE AS $p$ SELECT true OR (current_setting('role', true) = 'x' AND session_user = 'y') $p$;",
      "CREATE OR REPLACE FUNCTION caller_may_write_profile_role() RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true';",
      "CREATE OR REPLACE FUNCTION public.caller_may_write_profile_role() RETURNS boolean LANGUAGE sql STABLE RETURN true;",
      "DO $$ BEGIN EXECUTE $e$CREATE OR REPLACE FUNCTION public.caller_may_write_profile_role() RETURNS boolean LANGUAGE sql AS $b$ SELECT true $b$$e$; END $$;",
      "DROP FUNCTION IF EXISTS public.caller_may_write_profile_role() CASCADE;",
      "ALTER FUNCTION public.caller_may_write_profile_role() SECURITY DEFINER;",
      "ALTER FUNCTION public.caller_may_write_profile_role() RENAME TO caller_may_write_profile_role_old;",
    ]) {
      const r = all(change);
      assert.equal(r.redefined.length, 1, change);
      assert.deepEqual(r.cols, everyColumn, change);
    }
    // 2078's own text, re-stated (comments and whitespace differ): not a change.
    const m2078 = readFileSync(join(MIGRATIONS, "2078_profiles_role_not_self_writable.sql"), "utf8");
    const at = m2078.indexOf("CREATE OR REPLACE FUNCTION public.caller_may_write_profile_role()");
    const restated = m2078.slice(at, m2078.indexOf("$function$;", at) + "$function$;".length).replace(/\n\s+/g, "\n    ").replace(/-- \(a\)[^\n]*/, "-- reworded comment");
    assert.ok(restated.includes("session_user"), "could not lift 2078's definition");
    assert.deepEqual(all(restated).redefined, []);
    assert.deepEqual(all(restated).cols.filter((c) => c !== "account_status"), []);
  });

  it("R6-6: account_status is pending only until 3600 lands; then its trigger is required", () => {
    const pendingNow = unguardedAuthorityColumns(chain(), baselineSql).find((g) => g.column === "account_status");
    if (chain().some((m) => m.name.startsWith("3600_"))) {
      assert.equal(pendingNow, undefined, "3600 is on the tree: account_status must be guarded, not pending");
      return;
    }
    assert.equal(pendingNow?.pending, true);
    // A 3600_ file without the trigger: no longer pending — a failure.
    const landedBare = unguardedAuthorityColumns([...chain(), f("3600_x.sql", "SELECT 1;")], baselineSql).find((g) => g.column === "account_status");
    assert.equal(landedBare?.pending, false);
    // 3600's (4b) shape: guarded.
    const fourB = `CREATE OR REPLACE FUNCTION public.enforce_profile_account_status_privileged()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.account_status, 'active') IS DISTINCT FROM 'active' AND NOT public.caller_may_write_profile_role() THEN
      RAISE EXCEPTION 'x' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.account_status IS DISTINCT FROM OLD.account_status AND NOT public.caller_may_write_profile_role() THEN
    RAISE EXCEPTION 'y' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER trg_profiles_account_status_privileged
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_account_status_privileged();`;
    assert.equal(unguardedAuthorityColumns([...chain(), f("3600_x.sql", fourB)], baselineSql).find((g) => g.column === "account_status"), undefined);
  });

  it("R6-7: the CLI prints rule 6's verdict on the real tree", () => {
    const env = { ...process.env };
    delete env["CLIENT_PRIVILEGE_DIRS"];
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", join(API_ROOT, "src", "scripts", "checkClientPrivilegeBoundary.ts")], {
      cwd: API_ROOT,
      encoding: "utf8",
      env,
      timeout: 120_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^✅ every one of the 19 profiles authority column\(s\) is server-only: no client UPDATE grant, a guarding trigger \(rule 6/m);
  });
});

describe("3742 — the premise: no client tree writes an authority column of profiles", () => {
  const CLIENT_ROOTS = ["travel-buddy-standalone/src", "travel-buddy-standalone/app", "src", "app", "packages", "posts-ui", "lib"];
  const SKIP_DIR = /(^|\/)(node_modules|__tests__|\.expo|dist|build)(\/|$)/;
  function* walk(dir: string): Generator<string> {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      if (SKIP_DIR.test(p)) continue;
      const st = statSync(p);
      if (st.isDirectory()) yield* walk(p);
      else if (/\.(tsx?|jsx?|mjs)$/.test(e) && !/\.test\.|\.spec\./.test(e)) yield p;
    }
  }
  /** The argument text of a call that starts at `open` (the `(`), to its matching `)`. */
  const callArgs = (text: string, open: number) => {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
  };

  it("P-1: every client write to profiles names only ordinary columns (and the walk read real files)", () => {
    let scanned = 0;
    let writes = 0;
    const hits: string[] = [];
    const cols = new RegExp(`\\b(${REVOKED.join("|")})\\b`);
    for (const root of CLIENT_ROOTS) {
      for (const p of walk(join(REPO_ROOT, root))) {
        scanned++;
        const text = readFileSync(p, "utf8");
        for (const m of text.matchAll(/\.from\(\s*['"`]profiles['"`]\s*\)\s*\.(update|upsert|insert)\s*\(/g)) {
          writes++;
          const args = callArgs(text, m.index! + m[0].length - 1).replace(/\/\/[^\n]*/g, "");
          // A variable payload (`.update(row)`) is resolved from what the code
          // before it assigns: `row.col = …`, `row['col'] = …`, `const row = { col: … }`.
          const v = /^\s*([A-Za-z_]\w*)\s*(?:,|$)/.exec(args);
          let scope = args;
          if (v) {
            const before = text.slice(Math.max(0, m.index! - 3000), m.index!);
            const keys = [
              ...[...before.matchAll(new RegExp(String.raw`\b${v[1]}\.(\w+)\s*=(?!=)`, "g"))].map((k) => k[1]!),
              ...[...before.matchAll(new RegExp(String.raw`\b${v[1]}\[\s*['"\`](\w+)['"\`]\s*\]\s*=(?!=)`, "g"))].map((k) => k[1]!),
              ...[...before.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+${v[1]}\b[^=]*=\s*\{([^}]*)\}`, "g"))].flatMap((k) => [...k[1]!.matchAll(/(\w+)\s*[:,}]/g)].map((x) => x[1]!)),
            ];
            scope = keys.join(" ");
          }
          const hit = cols.exec(scope);
          if (hit) hits.push(`${p.slice(REPO_ROOT.length + 1)}: ${m[1]} names ${hit[1]}`);
        }
        if (/rest\/v1\/profiles/.test(text) && /method:\s*['"`](PATCH|POST)['"`]/.test(text)) hits.push(`${p.slice(REPO_ROOT.length + 1)}: raw PostgREST write to profiles`);
      }
    }
    assert.ok(scanned > 200, `only ${scanned} client files scanned: the roots moved`);
    assert.ok(writes >= 2, `only ${writes} client profiles writes found: the pattern stopped matching`);
    assert.deepEqual(hits, [], "a client writes an authority column of profiles; 3742 refuses it — route it through the server");
  });
});
