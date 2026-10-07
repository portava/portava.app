/**
 * clientGrantExcessBoundary — 3740, and the rule that keeps its defect from
 * coming back (checkClientPrivilegeBoundary.ts rule 4,
 * lib/clientTableAclDecisions.ts).
 *
 * THE DEFECT. Supabase's default ACL gives `anon` and `authenticated` SELECT,
 * INSERT, UPDATE and DELETE on every table created in `public`. Nine
 * post-baseline tables were created without a REVOKE and kept them, and on
 * every database built by replaying the baseline over that default ACL
 * (portava-ci, the beta bootstrap, the local harness) `profiles` gained a
 * table-level SELECT and UPDATE that overrides its column grants — so the anon
 * key could read date_of_birth, phone_e164, expo_push_token and full_name.
 * Found by audit:live-unexplained run 37608414616 (548 EXCESS_PRIVILEGE).
 *
 * WHAT IS PROVEN HERE, OFFLINE (the executed proof against PostgreSQL is
 * src/test/db/clientGrantExcessBoundary.db.test.ts, run by CI's local-db job):
 *   R4-*  rule 4 fires on a post-baseline CREATE TABLE with no client REVOKE,
 *         recognises every REVOKE shape the chain uses, and is silent on the
 *         real tree — and names exactly the seven tables 3740 fixes when 3740
 *         is taken away (the mutation proof is a test, not a note).
 *   M-*   3740's lists are the baseline's lists, its blocks are classified the
 *         way certify:migrations needs, and no later migration hands any of
 *         the ten tables' excess back.
 *   P-*   the premise of Part 1: no client tree reaches any of the nine
 *         tables directly. When one does, this fails and asks for a GRANT
 *         migration rather than letting the client hit a 42501 in production.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createdTables,
  findUndecidedTables,
  revokedFromClients,
  type MigrationText,
} from "../scripts/lib/clientTableAclDecisions.js";
import { expandForeachLiteralLoops, extractGrants } from "../scripts/lib/liveVsCanonicalCore.js";
import { findClientDefinerViews, VIEW_INVOKER_EXEMPT } from "../scripts/lib/clientTableAclDecisions.js";
import {
  isAssertionOnlyDoBlock,
  isPreconditionDoBlock,
  topLevelStatements,
} from "../scripts/lib/migrationSqlBlocks.js";
import { BASELINE_PATH, parseBaselineTables } from "../scripts/parseBaselineSchema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const MIGRATIONS = join(API_ROOT, "src", "migrations");
const THE_FILE = "3740_client_grant_excess_boundary.sql";

/** 3740 Part 1's tables. The two media lifecycle tables are deliberately NOT here (verifier F1; G-2 withdrawn). */
const SEVEN = [
  "conversation_action_refs",
  "highlight_projection_policies",
  "highlight_resurfacing_preferences",
  "highlight_sources",
  "message_attachments",
  "message_edits",
  "message_reactions",
];

const baselineSql = readFileSync(BASELINE_PATH, "utf8");
const BASELINE_TABLES = new Set([...parseBaselineTables(baselineSql).keys()].map((t) => t.toLowerCase()));

function chain(skip: readonly string[] = []): MigrationText[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql") && !skip.includes(f))
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") }));
}

/** The baseline's column grants on profiles to one role, by privilege. */
function baselineProfileColumns(role: "anon" | "authenticated", priv: "SELECT" | "UPDATE"): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`^GRANT (.+?) ON TABLE public\.profiles TO ${role};$`, "gm");
  for (const m of baselineSql.matchAll(re)) {
    for (const pm of m[1]!.matchAll(/\b(SELECT|UPDATE|INSERT|REFERENCES)\((\w+)\)/g)) {
      if (pm[1] === priv) out.push(pm[2]!);
    }
  }
  return out;
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("rule 4 — a post-baseline table must carry a client-privilege decision", () => {
  const f = (name: string, sql: string): MigrationText => ({ name, sql });

  it("R4-1: CREATE TABLE and nothing else is flagged for both client roles", () => {
    const r = findUndecidedTables([f("9001_x.sql", "CREATE TABLE public.zz_t (id int);")], BASELINE_TABLES);
    assert.deepEqual(r, [{ table: "zz_t", file: "9001_x.sql", missing: ["anon", "authenticated"] }]);
  });

  it("R4-2: a REVOKE ALL from both client roles is a decision, in the same file or a later one", () => {
    const same = findUndecidedTables(
      [f("9001_x.sql", "CREATE TABLE zz_t (id int);\nREVOKE ALL ON public.zz_t FROM PUBLIC, anon, authenticated;")],
      BASELINE_TABLES,
    );
    assert.deepEqual(same, []);
    const later = findUndecidedTables(
      [f("9001_x.sql", "CREATE TABLE zz_t (id int);"), f("9002_y.sql", "REVOKE SELECT, INSERT ON TABLE zz_t FROM anon, authenticated;")],
      BASELINE_TABLES,
    );
    assert.deepEqual(later, []);
  });

  it("R4-3: a REVOKE that reaches only one client role leaves the other flagged", () => {
    const r = findUndecidedTables(
      [f("9001_x.sql", "CREATE TABLE zz_t (id int);\nREVOKE ALL ON zz_t FROM PUBLIC, anon;")],
      BASELINE_TABLES,
    );
    assert.deepEqual(r.map((u) => u.missing), [["authenticated"]]);
    // PUBLIC alone reaches neither: Supabase grants the two roles by name.
    const pub = findUndecidedTables([f("9001_x.sql", "CREATE TABLE zz_t (id int);\nREVOKE ALL ON zz_t FROM PUBLIC;")], BASELINE_TABLES);
    assert.deepEqual(pub.map((u) => u.missing), [["anon", "authenticated"]]);
  });

  it("R4-4: a REVOKE in an EARLIER file is not a decision about a table created later", () => {
    const r = findUndecidedTables(
      [f("9001_x.sql", "REVOKE ALL ON zz_t FROM anon, authenticated;"), f("9002_y.sql", "CREATE TABLE zz_t (id int);")],
      BASELINE_TABLES,
    );
    assert.equal(r.length, 1);
  });

  it("R4-5: column-level and destructive-only REVOKEs are not decisions about the default DML", () => {
    for (const rev of [
      "REVOKE UPDATE (a) ON zz_t FROM anon, authenticated;",
      "REVOKE TRUNCATE, REFERENCES, TRIGGER ON zz_t FROM anon, authenticated;",
    ]) {
      const r = findUndecidedTables([f("9001_x.sql", `CREATE TABLE zz_t (a int);\n${rev}`)], BASELINE_TABLES);
      assert.equal(r.length, 1, `"${rev}" was taken as a decision`);
    }
  });

  it("R4-6: several targets in one REVOKE, and an EXECUTE literal in a DO block, both count", () => {
    const multi = findUndecidedTables(
      [f("9001_x.sql", "CREATE TABLE zz_a (id int);\nCREATE TABLE zz_b (id int);\nREVOKE ALL ON public.zz_a, public.zz_b FROM anon, authenticated;")],
      BASELINE_TABLES,
    );
    assert.deepEqual(multi, []);
    const exec = findUndecidedTables(
      [f("9001_x.sql", "CREATE TABLE zz_a (id int);\nDO $$ BEGIN EXECUTE 'REVOKE ALL ON public.zz_a FROM anon, authenticated'; END $$;")],
      BASELINE_TABLES,
    );
    assert.deepEqual(exec, []);
  });

  it("R4-7: a FOREACH-literal loop REVOKE counts (2762/2763's shape)", () => {
    const sql = `CREATE TABLE zz_a (id int);\nCREATE TABLE zz_b (id int);
DO $g$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['zz_a','zz_b'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
END $g$;`;
    assert.deepEqual(findUndecidedTables([f("9001_x.sql", sql)], BASELINE_TABLES), []);
  });

  it("R4-8: a temp-table driven loop REVOKE counts for exactly the listed tables (3504's shape)", () => {
    const sql = `CREATE TABLE zz_a (id int);\nCREATE TABLE zz_b (id int);
CREATE TEMP TABLE _p_targets (rel text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _p_targets (rel) VALUES ('zz_a');
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT t.rel FROM _p_targets t ORDER BY t.rel LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, PUBLIC', r.rel);
  END LOOP;
END $$;`;
    const r = findUndecidedTables([f("9001_x.sql", sql)], BASELINE_TABLES);
    assert.deepEqual(r.map((u) => u.table), ["zz_b"], "only the table the temp list names is decided");
    assert.ok(!createdTables(sql).includes("_p_targets"), "a TEMP table is not a table the chain creates");
  });

  it("R4-9: a dropped table, a baseline table and a pre-chain-start file are exempt", () => {
    const dropped = findUndecidedTables(
      [f("9001_x.sql", "CREATE TABLE zz_t (id int);"), f("9002_y.sql", "DROP TABLE IF EXISTS public.zz_t CASCADE;")],
      BASELINE_TABLES,
    );
    assert.deepEqual(dropped, []);
    const baseline = findUndecidedTables([f("9001_x.sql", "CREATE TABLE IF NOT EXISTS public.profiles (id uuid);")], BASELINE_TABLES);
    assert.deepEqual(baseline, []);
    const history = findUndecidedTables([f("0050_x.sql", "CREATE TABLE zz_t (id int);")], BASELINE_TABLES);
    assert.deepEqual(history, []);
  });

  it("R4-10: the word 'revoke' in COMMENT prose is not a REVOKE", () => {
    const sql = "CREATE TABLE zz_t (id int);\nCOMMENT ON TABLE zz_t IS 'we revoke all on zz_t from anon, authenticated later';";
    assert.equal(findUndecidedTables([f("9001_x.sql", sql)], BASELINE_TABLES).length, 1);
    assert.equal(revokedFromClients(sql).size, 0);
  });

  it("R4-11: the real chain passes, and WITHOUT 3740 it names exactly the seven tables 3740 fixes", () => {
    assert.deepEqual(findUndecidedTables(chain(), BASELINE_TABLES), []);
    const without = findUndecidedTables(chain([THE_FILE]), BASELINE_TABLES);
    assert.deepEqual(sorted(without.map((u) => u.table)), SEVEN);
    for (const u of without) assert.deepEqual(u.missing, ["anon", "authenticated"], u.table);
  });

  it("R4-12: the rule is not vacuous on the real chain (it examined 100+ post-baseline tables)", () => {
    const seen = new Set<string>();
    for (const m of chain()) {
      if (m.name < "2093_") continue;
      for (const t of createdTables(m.sql)) if (!BASELINE_TABLES.has(t)) seen.add(t);
    }
    assert.ok(seen.size >= 100, `only ${seen.size} post-baseline tables found`);
  });
});

describe("3740 — its lists are the baseline's, and it is shaped for certify:migrations", () => {
  const sql = readFileSync(join(MIGRATIONS, THE_FILE), "utf8");
  const stmts = topLevelStatements(sql);

  it("M-1: Part 1 revokes ALL from PUBLIC, anon and authenticated on exactly the seven tables, one present table at a time", () => {
    const part1 = stmts.find((x) => /^\s*DO \$part1\$/.test(x.replace(/^(\s|--[^\n]*\n)*/, "")));
    assert.ok(part1, "no DO $part1$ block");
    const expanded = expandForeachLiteralLoops(part1!);
    const r = revokedFromClients(expanded);
    assert.deepEqual(sorted(r.keys()), SEVEN);
    for (const t of SEVEN) assert.deepEqual(sorted(r.get(t)!), ["anon", "authenticated"], t);
    assert.equal((expanded.match(/FROM PUBLIC, anon, authenticated;/g) ?? []).length, 7);
    // An absent table is skipped by name, never refused (verifier F7): the
    // loop guards each EXECUTE on to_regclass, and the $pre$ block only NOTICEs.
    assert.match(part1!, /IF to_regclass\('public\.' \|\| t\) IS NULL THEN\s+RAISE NOTICE/);
    const pre = stmts.find((x) => isPreconditionDoBlock(x))!;
    assert.match(pre, /RAISE NOTICE '3740: % absent from schema public; skipped/);
    assert.doesNotMatch(pre, /RAISE EXCEPTION '3740 PRECONDITION FAILED: % absent/);
  });

  it("M-1b: no EARLIER migration's re-runnable postcondition pins a client grant on a table 3740 revokes (verifier F1)", () => {
    // certify:migrations stage 4 re-runs every assertion-only, non-$pre$ DO
    // block of every file one run applied — on a full-chain build, 2955 and
    // 3740 together. A block that counts client grants on a table 3740 empties
    // would go red there; 2955's did on the two media tables.
    const offenders: string[] = [];
    for (const m of chain().filter((x) => x.name < THE_FILE)) {
      for (const st of topLevelStatements(m.sql)) {
        if (!isAssertionOnlyDoBlock(st) || isPreconditionDoBlock(st)) continue;
        if (!/\b(anon|authenticated)\b/.test(st) || !/role_table_grants|has_table_privilege|aclexplode|has_column_privilege/.test(st)) continue;
        for (const t of SEVEN) if (new RegExp(`\\b${t}\\b`).test(st)) offenders.push(`${m.name}: ${t}`);
      }
    }
    assert.deepEqual(offenders, []);
    // And the case that motivated it would be caught: 2955 pins the media tables.
    const m2955 = chain().find((x) => x.name.startsWith("2955_"))!;
    const pins = topLevelStatements(m2955.sql).some(
      (st) => isAssertionOnlyDoBlock(st) && !isPreconditionDoBlock(st) && /media_processing_attempts/.test(st) && /role_table_grants/.test(st),
    );
    assert.ok(pins, "2955 no longer pins the media SELECT grants; re-check G-2 before adding them back");
  });

  it("M-2: Part 2 re-grants the baseline's profiles column lists, to both roles, exactly", () => {
    const g = extractGrants(sql).columnGrants;
    for (const role of ["anon", "authenticated"] as const) {
      for (const priv of ["SELECT", "UPDATE"] as const) {
        const want = baselineProfileColumns(role, priv);
        assert.ok(want.length > 50, `baseline parse found only ${want.length} ${priv} columns for ${role}`);
        const got = [...g]
          .filter(([k, ps]) => k.startsWith("profiles.") && k.endsWith(`.${role}`) && ps.has(priv.toLowerCase()))
          .map(([k]) => k.split(".")[1]!);
        assert.deepEqual(sorted(got), sorted(want), `${role} ${priv}`);
      }
    }
    // The personal and authority columns stay unreadable, and role unwritable.
    const sel = new Set(baselineProfileColumns("anon", "SELECT"));
    for (const c of ["date_of_birth", "full_name", "expo_push_token", "phone_e164", "trust_score", "safety_flags_count"]) {
      assert.ok(!sel.has(c), `${c} would be client-readable`);
    }
    assert.ok(!baselineProfileColumns("authenticated", "UPDATE").includes("role"));
    // And no TABLE-level SELECT/UPDATE grant on profiles anywhere in the file.
    const tg = extractGrants(sql).tableGrants;
    for (const role of ["anon", "authenticated"]) {
      const p = tg.get(`profiles.${role}`) ?? new Set();
      assert.ok(!p.has("select") && !p.has("update") && !p.has("all"), `table-level grant to ${role}`);
    }
  });

  it("M-3b: the postcondition pins NO MORE than the baseline's columns, and no fewer than the app reads (verifier F5)", () => {
    const post = stmts.find((x) => isAssertionOnlyDoBlock(x) && !isPreconditionDoBlock(x))!;
    const at = post.indexOf("v_app_reads constant text[] := ARRAY[");
    const appReads = [...post.slice(at, post.indexOf("];", at)).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
    assert.deepEqual(sorted(appReads), ["account_status", "avatar_url", "current_city", "display_name", "handle", "id", "is_private", "name", "role", "verified"]);
    for (const c of appReads) assert.ok(baselineProfileColumns("anon", "SELECT").includes(c), `${c} is not baseline-readable`);
    assert.doesNotMatch(post, /Missing:/, "the 'no fewer' direction over the whole baseline list is gone");
    assert.match(post, /exceeds the baseline''s\. Extra:/);
  });

  it("M-3: the $pre$ and $post$ literals carry the same lists as the GRANTs", () => {
    const literal = (block: string, name: string): string[] => {
      const at = block.indexOf(`${name} constant text[] := ARRAY[`);
      assert.ok(at >= 0, `no ${name} literal`);
      const end = block.indexOf("];", at);
      return [...block.slice(at, end).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
    };
    const pre = stmts.find((s) => isPreconditionDoBlock(s))!;
    const post = stmts.find((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s))!;
    assert.ok(pre && post);
    const sel = baselineProfileColumns("anon", "SELECT");
    const upd = baselineProfileColumns("anon", "UPDATE");
    assert.deepEqual(sorted(literal(pre, "v_cols")), sorted(new Set([...sel, ...upd])));
    assert.deepEqual(sorted(literal(post, "v_select")), sorted(sel));
    assert.deepEqual(sorted(literal(post, "v_update")), sorted(upd));
    assert.deepEqual(sorted(literal(pre, "v_targets")), sorted(SEVEN));
    assert.deepEqual(sorted(literal(post, "v_targets")), sorted(SEVEN));
  });

  it("M-4: certify:migrations holds the $pre$ block back and re-runs the $post$ block", () => {
    const pre = stmts.filter((s) => isAssertionOnlyDoBlock(s) && isPreconditionDoBlock(s));
    const post = stmts.filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
    assert.equal(pre.length, 1, "exactly one $pre$ block");
    assert.equal(post.length, 1, "exactly one assertion-only postcondition");
    assert.match(post[0]!, /3740 POSTCONDITION/);
  });

  it("M-5: no migration after 3740 grants a client role anything on the nine, or table-level SELECT/UPDATE on profiles", () => {
    const later = chain().filter((m) => m.name > THE_FILE);
    const bad: string[] = [];
    for (const m of later) {
      for (const text of [m.sql, expandForeachLiteralLoops(m.sql)]) {
        const { tableGrants, columnGrants } = extractGrants(text);
        for (const [k] of [...tableGrants, ...columnGrants]) {
          const parts = k.split(".");
          const role = parts[parts.length - 1]!;
          if (role !== "anon" && role !== "authenticated" && role !== "public") continue;
          if (SEVEN.includes(parts[0]!)) bad.push(`${m.name}: ${k}`);
        }
        for (const role of ["anon", "authenticated", "public"]) {
          const p = tableGrants.get(`profiles.${role}`);
          if (p && (p.has("select") || p.has("update") || p.has("all"))) bad.push(`${m.name}: profiles.${role}`);
        }
      }
    }
    assert.deepEqual(bad, [], "a later migration hands back what 3740 took; record the client path and its reason, or drop the grant");
  });
});

describe("3740 — the premise of Part 1: no client tree reaches the nine tables", () => {
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

  it("P-1: no client source calls .from() on any of the nine tables (and the walk read real files)", () => {
    let scanned = 0;
    const hits: string[] = [];
    const re = new RegExp(String.raw`\.from\(\s*['"\`](${SEVEN.join("|")})['"\`]`);
    for (const root of CLIENT_ROOTS) {
      for (const p of walk(join(REPO_ROOT, root))) {
        scanned++;
        const m = re.exec(readFileSync(p, "utf8"));
        if (m) hits.push(`${p.slice(REPO_ROOT.length + 1)}: ${m[1]}`);
      }
    }
    assert.ok(scanned > 200, `only ${scanned} client files scanned: the roots moved`);
    assert.deepEqual(
      hits,
      [],
      "a client reads one of 3740's tables directly; it now needs a migration that GRANTs exactly that verb beside its policy",
    );
  });
});

describe("rule 4 — the bypasses the verifier planted (F3 a–d) now fail", () => {
  const f = (name: string, sql: string): MigrationText => ({ name, sql });

  it("F3a: DROP + CREATE in one file, or create / drop / re-create across files, is a NEW table and must be decided", () => {
    const one = findUndecidedTables([f("9001_x.sql", "DROP TABLE IF EXISTS public.zz_t;\nCREATE TABLE public.zz_t (id int);")], BASELINE_TABLES);
    assert.deepEqual(one.map((u) => u.table), ["zz_t"]);
    const across = findUndecidedTables(
      [
        f("9001_x.sql", "CREATE TABLE zz_t (id int);\nREVOKE ALL ON zz_t FROM anon, authenticated;"),
        f("9002_y.sql", "DROP TABLE zz_t;"),
        f("9003_z.sql", "CREATE TABLE zz_t (id int);"),
      ],
      BASELINE_TABLES,
    );
    assert.deepEqual(across.map((u) => [u.table, u.file]), [["zz_t", "9003_z.sql"]], "the first table's REVOKE does not decide the second");
    // A baseline table the chain drops and re-creates is a new table too.
    const base = findUndecidedTables([f("9001_x.sql", "DROP TABLE public.profiles;\nCREATE TABLE public.profiles (id uuid);")], BASELINE_TABLES);
    assert.deepEqual(base.map((u) => u.table), ["profiles"]);
    // Still exempt: dropped AFTER its last create (it no longer exists).
    assert.deepEqual(findUndecidedTables([f("9001_x.sql", "CREATE TABLE zz_t (id int);"), f("9002_y.sql", "DROP TABLE zz_t;")], BASELINE_TABLES), []);
  });

  it("F3b: a string literal that starts with REVOKE is not a REVOKE unless it is EXECUTE's operand", () => {
    for (const lit of [
      "DO $$ BEGIN RAISE NOTICE 'REVOKE ALL ON public.zz_t FROM anon, authenticated'; END $$;",
      "COMMENT ON TABLE zz_t IS 'REVOKE ALL ON public.zz_t FROM anon, authenticated';",
    ]) {
      const r = findUndecidedTables([f("9001_x.sql", `CREATE TABLE zz_t (id int);\n${lit}`)], BASELINE_TABLES);
      assert.equal(r.length, 1, lit);
    }
    const exec = findUndecidedTables(
      [f("9001_x.sql", "CREATE TABLE zz_t (id int);\nDO $$ BEGIN EXECUTE 'REVOKE ALL ON public.zz_t FROM anon, authenticated'; END $$;")],
      BASELINE_TABLES,
    );
    assert.deepEqual(exec, []);
  });

  it("F3c: a loop-created table is examined under its real name, and no phantom 'public' appears", () => {
    const sql = `DO $$ DECLARE t text; BEGIN
      FOREACH t IN ARRAY ARRAY['zz_a','zz_b'] LOOP
        EXECUTE format('CREATE TABLE public.%I (id int)', t);
      END LOOP; END $$;`;
    assert.deepEqual(createdTables(sql).sort(), ["zz_a", "zz_b"]);
    assert.deepEqual(findUndecidedTables([f("9001_x.sql", sql)], BASELINE_TABLES).map((u) => u.table), ["zz_a", "zz_b"]);
  });

  it("F3d: a quoted mixed-case table is not decided by a REVOKE on the lower-case name", () => {
    const r = findUndecidedTables([f("9001_x.sql", 'CREATE TABLE "Zz_T" (id int);\nREVOKE ALL ON zz_t FROM anon, authenticated;')], BASELINE_TABLES);
    assert.deepEqual(r.map((u) => u.table), ["Zz_T"]);
    assert.deepEqual(findUndecidedTables([f("9001_x.sql", 'CREATE TABLE "Zz_T" (id int);\nREVOKE ALL ON "Zz_T" FROM anon, authenticated;')], BASELINE_TABLES), []);
  });

  it("F3e (KNOWN LIMIT, pinned so it is not mistaken for coverage): a REVOKE followed by a re-GRANT passes", () => {
    const r = findUndecidedTables(
      [f("9001_x.sql", "CREATE TABLE zz_t (id int);\nREVOKE ALL ON zz_t FROM anon, authenticated;\nGRANT SELECT, INSERT, UPDATE, DELETE ON zz_t TO anon, authenticated;")],
      BASELINE_TABLES,
    );
    assert.deepEqual(r, [], "rule 4 proves a decision exists, not that it is right; the live ACL is audit:live-unexplained's question");
  });
});

describe("rule 5 — no client-readable view without security_invoker (verifier F2)", () => {
  const f = (name: string, sql: string): MigrationText => ({ name, sql });
  const baseline = readFileSync(BASELINE_PATH, "utf8");

  it("the real chain passes, and WITHOUT 3741 it names exactly trip_presence_current", () => {
    assert.deepEqual(findClientDefinerViews(chain(), baseline), []);
    const without = findClientDefinerViews(chain(["3741_trip_presence_current_security_invoker.sql"]), baseline);
    assert.deepEqual(without.map((v) => [v.view, v.definedIn, v.roles.join(",")]), [
      ["trip_presence_current", "2776_trip_presence_freshness_and_ordering.sql", "authenticated"],
    ]);
  });

  it("3820's catalog loop over its literal list of nine compatibility views is what makes them invoker on a chain-built database", () => {
    const without = findClientDefinerViews(chain(["3820_rent_buddy_bookings_write_boundary.sql"]), baseline).map((v) => v.view);
    for (const v of ["buddy_bookings", "buddy_profiles", "buddy_reviews"]) assert.ok(without.includes(v), v);
  });

  it("planted: a new definer view takes the default ACL; a REVOKE or security_invoker clears it; OR REPLACE drops the option", () => {
    const run = (...sqls: string[]) => findClientDefinerViews(sqls.map((s, i) => f(`900${i}_x.sql`, s)), "").map((v) => `${v.view}:${v.roles.join(",")}`);
    assert.deepEqual(run("CREATE VIEW public.zz_v AS SELECT 1;"), ["zz_v:anon,authenticated"]);
    assert.deepEqual(run("CREATE VIEW public.zz_v AS SELECT 1;\nREVOKE ALL ON public.zz_v FROM PUBLIC, anon, authenticated;"), []);
    assert.deepEqual(run("CREATE VIEW public.zz_v WITH (security_invoker = true) AS SELECT 1;"), []);
    assert.deepEqual(run("CREATE VIEW public.zz_v AS SELECT 1;", "ALTER VIEW public.zz_v SET (security_invoker = true);"), []);
    assert.deepEqual(run("CREATE VIEW public.zz_v WITH (security_invoker = true) AS SELECT 1;", "CREATE OR REPLACE VIEW public.zz_v AS SELECT 2;"), ["zz_v:anon,authenticated"]);
    assert.deepEqual(
      run("CREATE VIEW public.zz_v AS SELECT 1;\nREVOKE ALL ON public.zz_v FROM anon, authenticated;", "GRANT SELECT ON public.zz_v TO authenticated;"),
      ["zz_v:authenticated"],
    );
    assert.deepEqual(run("CREATE VIEW public.zz_v WITH (security_invoker = true) AS SELECT 1;", "ALTER VIEW public.zz_v RESET (security_invoker);"), ["zz_v:anon,authenticated"]);
  });

  it("the exemption list is exactly PostGIS's two metadata views", () => {
    assert.deepEqual([...VIEW_INVOKER_EXEMPT.keys()].sort(), ["geography_columns", "geometry_columns"]);
    assert.deepEqual(findClientDefinerViews([f("9001_x.sql", "CREATE VIEW public.geometry_columns AS SELECT 1;")], ""), []);
  });
});
