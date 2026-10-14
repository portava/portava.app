/**
 * memoriesClientBoundary — verifier V-716 fix 2 / owner question OQ-716-1 on the
 * DIRECT PostgREST door to canonical Memories (census-highlights-memories §BJ):
 * migration 3813 and check:client-privilege-boundary rule 7.
 *
 * THE DEFECT. The baseline grants ALL on public.memories to anon and
 * authenticated (2490 left SELECT, INSERT, UPDATE, DELETE), and RLS decides rows
 * only: `memories_public_read` let any signed-in user read every column of a
 * stranger's published public Memory (exact coordinates, place references, the
 * owner's audience lists) past every rule the API applies before it serves one,
 * and `memories_owner_all` let an owner write any column of their own rows.
 *
 * WHAT IS PROVEN HERE, OFFLINE (the executed proof against PostgreSQL is
 * src/test/db/memoriesClientBoundary.db.test.ts, run by CI's local-db job):
 *   A-*  the chain's END STATE, replayed in apply order over the baseline and
 *        every migration: no client role holds anything on memories — and
 *        without 3813 both would hold the four DML privileges (anti-vacuity).
 *   B-*  3813 and its rollback are shaped as they claim: one $pre$, one
 *        catalog-only postcondition, one REVOKE and no GRANT; the rollback
 *        restores 2490's four privileges, never ALL.
 *   C-*  rule 7 (lib/serverOnlyTables.ts) fails on every shape that would hand
 *        a client role memories back, and on none that does not; the CLI wires it.
 *   P-*  the premise: no client tree reads memories directly, and every
 *        function that reads it is service-role-only or a trigger.
 *   K-*  the live guard agrees: memories is in the authorization contract with
 *        no client grant, as every SERVER_ONLY_TABLES entry is.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoriesClientBoundary.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { blankSqlComments } from "../scripts/lib/liveVsCanonicalCore.js";
import { isAssertionOnlyDoBlock, isPreconditionDoBlock, topLevelStatements } from "../scripts/lib/migrationSqlBlocks.js";
import { BASELINE_PATH } from "../scripts/parseBaselineSchema.js";
import {
  findServerOnlyTableBreaches,
  heldBy,
  replayClientTableAcl,
  SERVER_ONLY_TABLES,
  type ServerOnlyTable,
} from "../scripts/lib/serverOnlyTables.js";
import { loadContract } from "../security/authorizationContract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const MIGRATIONS = join(API_ROOT, "src", "migrations");
const CHECKER = join(API_ROOT, "src", "scripts", "checkClientPrivilegeBoundary.ts");
const F3813 = "3813_memories_client_privileges_revoked.sql";
const ROLLBACK = join(REPO_ROOT, "db", "rollback", "2026-10-14-3813-memories-client-privileges-revoked-rollback.sql");
const CLIENT_ROLES = ["anon", "authenticated"] as const;

type Mig = { name: string; sql: string };
const chain = (skip: readonly string[] = []): Mig[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql") && !skip.includes(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") }));
const BASELINE = readFileSync(BASELINE_PATH, "utf8");

describe("V-716 fix 2 — the chain's end state: no client role holds anything on public.memories", () => {
  it("A-0: no apply-order override moves 3813 or 2161 (so byte order is the apply order here)", () => {
    const overrides = readFileSync(join(MIGRATIONS, "ORDER_OVERRIDES.json"), "utf8");
    for (const f of [F3813, "2161_compass_memories_client_revoke.sql"]) assert.ok(!overrides.includes(f), `${f} is named in ORDER_OVERRIDES.json`);
  });

  it("A-1 (anti-vacuity, the defect): WITHOUT 3813 both client roles end the chain holding SELECT, INSERT, UPDATE and DELETE", () => {
    const r = replayClientTableAcl(chain([F3813]), BASELINE, "memories");
    for (const role of CLIENT_ROLES) assert.deepEqual(heldBy(r.acl, role), ["DELETE", "INSERT", "SELECT", "UPDATE"], role);
    assert.ok(r.revokedBy.get("2490_destructive_privilege_boundary.sql")?.has("anon"), "the replay sees 2490 take the four unpoliced privileges");
  });

  it("A-2 THE POINT: with 3813, anon, authenticated and PUBLIC hold nothing on memories, at table or column level", () => {
    const r = replayClientTableAcl(chain(), BASELINE, "memories");
    for (const role of ["anon", "authenticated", "public"] as const) assert.deepEqual(heldBy(r.acl, role), [], role);
    assert.deepEqual([...(r.revokedBy.get(F3813) ?? [])].sort(), ["anon", "authenticated", "public"]);
  });

  it("A-3: rule 7 holds on the real tree, and is not blind (it sees the baseline open the table and 3813 close it)", () => {
    const { findings, vacuity } = findServerOnlyTableBreaches(chain(), BASELINE, { realTree: true });
    assert.deepEqual(findings, []);
    assert.deepEqual(vacuity, []);
    const blind = findServerOnlyTableBreaches(chain([F3813]), BASELINE, { realTree: true });
    assert.ok(blind.vacuity.some((v) => v.includes(`${F3813} is not in the chain`)), "a missing closing file is a vacuity failure");
    assert.equal(blind.findings.filter((f) => f.table === "memories").length, 2, "and both client roles are reported");
  });
});

describe("3813 and its rollback — shaped as they claim", () => {
  const sql = readFileSync(join(MIGRATIONS, F3813), "utf8");
  const rb = readFileSync(ROLLBACK, "utf8");
  const aclStatements = (text: string) =>
    topLevelStatements(text)
      .map((s) => s.replace(/^(\s|--[^\n]*\n)*/, "").trim())
      .filter((s) => /^(GRANT|REVOKE)\b/i.test(s));

  it("B-1: exactly one $pre$ and one assertion-only postcondition, which reads only the catalog", () => {
    const stmts = topLevelStatements(sql);
    const pre = stmts.filter((s) => isAssertionOnlyDoBlock(s) && isPreconditionDoBlock(s));
    const post = stmts.filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
    assert.equal(pre.length, 1, "exactly one assertion-only $pre$ block");
    assert.equal(post.length, 1, "exactly one assertion-only postcondition");
    assert.match(post[0]!, /POSTCONDITION FAILED \(3813\)/);
    // The live applier runs the body and $post$ as separate requests (COMMON 2026-10-08 07:55Z).
    assert.doesNotMatch(blankSqlComments(post[0]!), /pg_temp|current_setting\s*\(|set_config\s*\(|\btemp(orary)?\s+table\b/i);
    // The postcondition is after COMMIT: it asserts what persisted.
    assert.ok(sql.indexOf("DO $post$") > sql.lastIndexOf("\nCOMMIT;"));
  });

  it("B-2: the only privilege statement is REVOKE ALL from PUBLIC, anon and authenticated — nothing is granted back", () => {
    assert.deepEqual(aclStatements(sql), ["REVOKE ALL ON TABLE public.memories FROM PUBLIC, anon, authenticated;"]);
    // Privilege-only: no policy, function, trigger or row change.
    assert.doesNotMatch(blankSqlComments(sql), /\b(CREATE|DROP|ALTER)\s+(POLICY|FUNCTION|TRIGGER|TABLE|VIEW)\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b/i);
  });

  it("B-3: the rollback restores 2490's four privileges, never the baseline's ALL, refuses without RLS and both policies, and clears the ledger", () => {
    assert.deepEqual(aclStatements(rb), ["GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memories TO anon, authenticated;"]);
    assert.match(rb, /DELETE FROM public\.schema_migration_ledger WHERE filename = '3813_memories_client_privileges_revoked\.sql';/);
    const pre = topLevelStatements(rb).filter((s) => isPreconditionDoBlock(s));
    assert.equal(pre.length, 1);
    assert.match(pre[0]!, /relrowsecurity/);
    assert.match(pre[0]!, /'memories_owner_all', 'memories_public_read'/);
  });
});

describe("rule 7 (lib/serverOnlyTables.ts) — fires on every shape that hands memories back, and on none that does not", () => {
  // A miniature of the real thing: the baseline's CREATE + GRANT ALL, 2490, 3813 as written.
  const MINI_BASELINE =
    "CREATE TABLE public.memories (id uuid PRIMARY KEY, location_lat numeric);\n" +
    "GRANT ALL ON TABLE public.memories TO anon;\nGRANT ALL ON TABLE public.memories TO authenticated;\nGRANT ALL ON TABLE public.memories TO service_role;\n";
  const M2490 = { name: "2490_destructive_privilege_boundary.sql", sql: "REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN\n  ON ALL TABLES IN SCHEMA public\n  FROM anon, authenticated;\n" };
  const M3813 = { name: F3813, sql: readFileSync(join(MIGRATIONS, F3813), "utf8") };
  const ONLY_MEMORIES: readonly ServerOnlyTable[] = SERVER_ONLY_TABLES.filter((t) => t.table === "memories");
  const judge = (later: string, name = "3900_later.sql") =>
    findServerOnlyTableBreaches([M2490, M3813, { name, sql: later }], MINI_BASELINE, { realTree: true, tables: ONLY_MEMORIES });

  it("C-0 (control): the miniature passes as written", () => {
    assert.deepEqual(judge("SELECT 1;"), { findings: [], vacuity: [] });
  });

  const OPENERS: Array<[string, string]> = [
    ["a table-level SELECT to authenticated", "GRANT SELECT ON public.memories TO authenticated;"],
    ["TABLE keyword, several targets, anon", "GRANT SELECT, INSERT ON TABLE public.trips, public.memories TO anon;"],
    ["a bare (search_path) name", "GRANT UPDATE ON memories TO authenticated;"],
    ["a column-level SELECT of the coordinates", "GRANT SELECT (location_lat, location_lng) ON TABLE public.memories TO anon;"],
    ["PUBLIC", "GRANT SELECT ON TABLE public.memories TO PUBLIC;"],
    ["ALL TABLES IN SCHEMA public", "GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;"],
    ["a FOREACH over a literal array", "DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['trips', 'memories'] LOOP EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t); END LOOP; END $$;"],
    ["an EXECUTE literal", "DO $$ BEGIN EXECUTE 'GRANT DELETE ON public.memories TO authenticated'; END $$;"],
    ["a run-time name from a catalog loop", "DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP EXECUTE format('GRANT SELECT ON public.%I TO authenticated', r.tablename); END LOOP; END $$;"],
    ["a run-time grantee", "DO $$ DECLARE g text := 'anon'; BEGIN EXECUTE format('GRANT SELECT ON public.%I TO %I', 'memories', g); END $$;"],
    ["the table named through format()", "DO $$ BEGIN EXECUTE format('GRANT SELECT ON public.memories TO %s', 'anon'); END $$;"],
    ["a re-CREATE (Supabase's default ACL)", "DROP TABLE public.memories;\nCREATE TABLE public.memories (id uuid);"],
    ["a GRANT whose grant option alone is revoked later", "GRANT SELECT ON public.memories TO authenticated WITH GRANT OPTION;\nREVOKE GRANT OPTION FOR SELECT ON public.memories FROM authenticated;"],
  ];
  for (const [what, sql] of OPENERS) {
    it(`C-1 FAILS: ${what}`, () => {
      const { findings, vacuity } = judge(sql);
      assert.deepEqual(vacuity, []);
      assert.ok(findings.length > 0, `rule 7 missed: ${sql}`);
      assert.ok(findings.every((f) => f.table === "memories"));
    });
  }

  const HARMLESS: Array<[string, string]> = [
    ["a GRANT later revoked whole", "GRANT SELECT ON public.memories TO authenticated;\nREVOKE ALL ON public.memories FROM authenticated;"],
    ["a column grant later revoked at table level (PostgreSQL takes the column privilege with it)", "GRANT SELECT (location_lat) ON public.memories TO anon;\nREVOKE SELECT ON TABLE public.memories FROM anon;"],
    ["a grant to service_role", "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memories TO service_role;"],
    ["another table that merely ends in memories", "GRANT SELECT ON TABLE public.passport_memories TO anon, authenticated;"],
    ["a FOREACH over other tables", "DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['trips', 'passport_memories'] LOOP EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t); END LOOP; END $$;"],
    ["a run-time GRANT to service_role", "DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables LOOP EXECUTE format('GRANT SELECT ON public.%I TO service_role', r.tablename); END LOOP; END $$;"],
    ["a RAISE message that reads like a GRANT", "DO $$ BEGIN RAISE NOTICE 'never: GRANT SELECT ON public.memories TO authenticated'; END $$;"],
    ["a comment", "-- GRANT SELECT ON public.memories TO authenticated;\nSELECT 1;"],
    ["a function EXECUTE grant", "GRANT EXECUTE ON FUNCTION public.memory_public_feed(uuid, integer, timestamptz) TO authenticated;"],
  ];
  for (const [what, sql] of HARMLESS) {
    it(`C-2 passes: ${what}`, () => {
      assert.deepEqual(judge(sql), { findings: [], vacuity: [] });
    });
  }

  it("C-3: a run-time GRANT BEFORE the closing migration is the replay's business, not an unresolved report", () => {
    const early = { name: "3000_early.sql", sql: "DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables LOOP EXECUTE format('GRANT SELECT ON public.%I TO authenticated', r.tablename); END LOOP; END $$;" };
    const { findings } = findServerOnlyTableBreaches([M2490, early, M3813], MINI_BASELINE, { realTree: true, tables: ONLY_MEMORIES });
    assert.deepEqual(findings, []);
  });

  it("C-4: vacuity — a blind replay (no baseline) and a closing file that misses a role are refused, not passed", () => {
    const blind = findServerOnlyTableBreaches([M2490, M3813], "", { realTree: true, tables: ONLY_MEMORIES });
    assert.ok(blind.vacuity.some((v) => /never saw the table created or granted/.test(v)), JSON.stringify(blind.vacuity));
    const half = { name: F3813, sql: "REVOKE ALL ON TABLE public.memories FROM PUBLIC, anon;" };
    const r = findServerOnlyTableBreaches([M2490, half], MINI_BASELINE, { realTree: true, tables: ONLY_MEMORIES });
    assert.ok(r.vacuity.some((v) => /revoke the table from both anon and authenticated/.test(v)), JSON.stringify(r.vacuity));
    assert.ok(r.findings.some((f) => /authenticated holding DELETE, INSERT, SELECT, UPDATE/.test(f.message)));
  });

  it("C-5: every SERVER_ONLY_TABLES entry names a closing migration that exists", () => {
    const names = new Set(readdirSync(MIGRATIONS));
    for (const t of SERVER_ONLY_TABLES) assert.ok(names.has(t.closedBy), `${t.table}: ${t.closedBy} missing`);
  });

  describe("C-6: the CLI wires rule 7 (CLIENT_PRIVILEGE_DIRS fixture mode)", () => {
    let tmp = "";
    before(() => {
      tmp = mkdtempSync(join(tmpdir(), "memacl-"));
    });
    after(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });
    const run = (name: string, sql: string) => {
      const dir = join(tmp, name);
      mkdirSync(dir, { recursive: true });
      // The checker's own vacuity floor wants >= 50 GRANT statements.
      writeFileSync(join(dir, "0001_padding.sql"), Array.from({ length: 60 }, (_, i) => `GRANT SELECT ON TABLE public.pad_${i} TO authenticated;`).join("\n"));
      writeFileSync(join(dir, "9999_case.sql"), sql);
      const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
        cwd: API_ROOT,
        encoding: "utf8",
        env: { ...process.env, CLIENT_PRIVILEGE_DIRS: dir },
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    };
    it("FAILS on GRANT SELECT ON public.memories TO authenticated, naming rule 7", () => {
      const { code, out } = run("memgrant", "GRANT SELECT ON TABLE public.memories TO authenticated;");
      assert.notEqual(code, 0, out);
      assert.match(out, /server-only table public\.memories is client-reachable/);
      assert.match(out, /authenticated holding SELECT/);
    });
    it("FAILS on a client grant of compass_memories (2161's table)", () => {
      const { code, out } = run("cmgrant", "GRANT SELECT ON TABLE public.compass_memories TO anon;");
      assert.notEqual(code, 0, out);
      assert.match(out, /server-only table public\.compass_memories is client-reachable/);
    });
    it("passes the same grant on another table", () => {
      const { code, out } = run("other", "GRANT SELECT ON TABLE public.trips TO authenticated;");
      assert.equal(code, 0, out);
      assert.match(out, /rule 7: memories, compass_memories/);
    });
  });
});

describe("the premise: no client path reads public.memories as a client role", () => {
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
  const clientFiles = () => CLIENT_ROOTS.flatMap((r) => [...walk(join(REPO_ROOT, r))]);
  const rel = (p: string) => p.slice(REPO_ROOT.length + 1);

  it("P-1: no client source names memories as a table — .from(), a realtime filter, a REST path, an embed in a select list — and the walk read real files", () => {
    const files = clientFiles();
    assert.ok(files.length > 200, `only ${files.length} client files scanned: the roots moved`);
    let fromCalls = 0;
    const hits: string[] = [];
    for (const p of files) {
      const src = readFileSync(p, "utf8");
      fromCalls += (src.match(/\.from\(\s*['"`][a-z_]+['"`]\s*\)/g) ?? []).length;
      if (/\.from\(\s*['"`]memories['"`]\s*\)/.test(src)) hits.push(`${rel(p)}: .from('memories')`);
      if (/\btable\s*:\s*['"`]memories['"`]/.test(src)) hits.push(`${rel(p)}: a realtime filter on memories`);
      if (/rest\/v1\/memories\b/.test(src)) hits.push(`${rel(p)}: /rest/v1/memories`);
      for (const m of src.matchAll(/\.select\(\s*(['"`])([^'"`]*)\1/g)) {
        if (/(^|[^\w])memories\s*[(!:]/.test(m[2]!)) hits.push(`${rel(p)}: select('${m[2]}') embeds memories`);
      }
    }
    assert.ok(fromCalls >= 10, `only ${fromCalls} client .from('<table>') calls found: the scan went blind`);
    assert.deepEqual(hits, [], "a client reads memories directly; after 3813 it is refused with 42501 — it needs the API");
  });

  // A function body that reads public.memories, by the statement shapes 3813's precondition uses.
  const READS_MEMORIES = /\b(from|join|into|update|table)\s+(only\s+)?(public\.)?"?memories"?(?![\w])/i;
  /** Every CREATE [OR REPLACE] FUNCTION public.<name> in the chain whose body reads memories, with its return type. */
  function readersOfMemories(): Array<{ name: string; file: string; trigger: boolean }> {
    const out: Array<{ name: string; file: string; trigger: boolean }> = [];
    for (const f of chain()) {
      const text = blankSqlComments(f.sql);
      for (const m of text.matchAll(/\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\.)?("?[A-Za-z_]\w*"?)\s*\(([\s\S]*?)\)\s*returns\s+([\s\S]*?)\bas\s+(\$[A-Za-z_]*\$)([\s\S]*?)\4/gi)) {
        if (!READS_MEMORIES.test(m[5]!)) continue;
        out.push({ name: m[1]!.replace(/"/g, "").toLowerCase(), file: f.name, trigger: /^\s*(setof\s+)?trigger\b/i.test(m[3]!) });
      }
    }
    return out;
  }

  it("P-2: every chain function whose body reads memories is a trigger function or is revoked from anon and authenticated — the static twin of 3813's precondition", () => {
    const readers = readersOfMemories();
    assert.ok(readers.length >= 8, `only ${readers.length} memories-reading functions found: the scan went blind`);
    const allText = chain().map((f) => blankSqlComments(f.sql)).join("\n");
    const callable: string[] = [];
    for (const r of readers) {
      if (r.trigger) continue;
      const revoked = (role: string) =>
        new RegExp(String.raw`\brevoke\s+(all|execute)\s+on\s+function\s+(public\.)?${r.name}\s*\([^)]*\)\s+from\s+[^;]*\b${role}\b`, "i").test(allText);
      if (!revoked("anon") || !revoked("authenticated")) callable.push(`${r.name} (${r.file})`);
    }
    assert.deepEqual(callable, [], "a client role may call a function that reads memories; after 3813 an invoker one fails, a definer one stays a door");
  });

  it("P-3: no client source calls an RPC that reads memories (today the client trees call no RPC at all)", () => {
    const readers = new Set(readersOfMemories().map((r) => r.name));
    const called: string[] = [];
    for (const p of clientFiles()) {
      for (const m of readFileSync(p, "utf8").matchAll(/\.rpc\(\s*['"`]([A-Za-z_]\w*)['"`]/g)) if (readers.has(m[1]!.toLowerCase())) called.push(`${rel(p)}: ${m[1]}`);
    }
    assert.deepEqual(called, []);
  });
});

describe("the live guard agrees: authorization-contract.json", () => {
  const contract = loadContract();

  it("K-1: memories is contracted with no client table grant, no client-writable column, and exactly the baseline's two policies", () => {
    const c = contract.tables["memories"];
    assert.ok(c, "memories is not in the authorization contract");
    assert.deepEqual(c.tableGrants, {});
    assert.deepEqual(c.insertCols, {});
    assert.deepEqual(c.updateCols, {});
    const pols = c.policies.map((p) => `${p.name}|${p.cmd}|${p.permissive}|${p.roles.join("+")}`).sort();
    assert.deepEqual(pols, ["memories_owner_all|ALL|true|public", "memories_public_read|SELECT|true|public"]);
    // The policies are the baseline's, unchanged by the chain.
    assert.match(BASELINE, /CREATE POLICY memories_owner_all ON public\.memories USING \(\(owner_id = auth\.uid\(\)\)\);/);
    assert.match(BASELINE, /CREATE POLICY memories_public_read ON public\.memories FOR SELECT USING/);
    assert.equal(chain().filter((f) => /\b(create|drop|alter)\s+policy\b[^;]*\bon\s+(public\.)?memories\b/i.test(blankSqlComments(f.sql))).length, 0);
  });

  it("K-2: every server-only table is contracted with no client grant of any kind (the offline rule and the live check say the same thing)", () => {
    for (const t of SERVER_ONLY_TABLES) {
      const c = contract.tables[t.table];
      assert.ok(c, `${t.table} is server-only (rule 7) but not in the authorization contract`);
      assert.deepEqual([c.tableGrants, c.insertCols, c.updateCols], [{}, {}, {}], t.table);
    }
  });
});
