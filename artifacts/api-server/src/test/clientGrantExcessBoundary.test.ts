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

const NINE = [
  "highlight_resurfacing_preferences",
  "highlight_projection_policies",
  "highlight_sources",
  "message_edits",
  "message_reactions",
  "message_attachments",
  "conversation_action_refs",
  "media_processing_attempts",
  "media_asset_lifecycle_events",
];
/** The seven of the nine no migration had revoked anything on (2955 had revoked writes on the other two). */
const SEVEN = NINE.filter((t) => !t.startsWith("media_")).sort();

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

  it("M-1: Part 1 revokes ALL from PUBLIC, anon and authenticated on exactly the nine tables", () => {
    const rev = stmts.find((s) => /^\s*REVOKE ALL ON TABLE/m.test(s.replace(/^(\s|--[^\n]*\n)*/, "")));
    assert.ok(rev, "no REVOKE ALL statement");
    const r = revokedFromClients(`${rev};`);
    assert.deepEqual(sorted(r.keys()), sorted(NINE));
    for (const t of NINE) assert.deepEqual(sorted(r.get(t)!), ["anon", "authenticated"], t);
    assert.match(rev!, /FROM PUBLIC, anon, authenticated;?\s*$/);
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
    assert.deepEqual(sorted(literal(pre, "v_targets")), sorted(NINE));
    assert.deepEqual(sorted(literal(post, "v_targets")), sorted(NINE));
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
          if (NINE.includes(parts[0]!)) bad.push(`${m.name}: ${k}`);
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
    const re = new RegExp(String.raw`\.from\(\s*['"\`](${NINE.join("|")})['"\`]`);
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
