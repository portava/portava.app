/**
 * The four 0127 layover tables are not client-writable — census-layover L200
 * and L199, owner decision L199-b, migration 3620 (lane R, 2026-10-07).
 *
 * node:test + node:assert. Static: reads the committed migration SQL and the
 * authorization contract, and drives the contract's own evaluator. No database
 * — 3620 is applied to none, and `*.db.test.ts` / certify:migrations cannot run
 * on this machine; CI replays the chain. 3620's postconditions are what assert
 * the live state when it is applied.
 *
 * THE DEFECT. 0127's default-privileges grant left `anon` and `authenticated`
 * holding DELETE, INSERT, SELECT and UPDATE on layover_sessions,
 * layover_plan_stops, layover_events and airport_profiles. layover_sessions'
 * owner policy is FOR ALL with a WITH CHECK on user_id — ownership-correct and
 * column-blind — so a traveller could PATCH their own session's `status`,
 * `return_reminder_at` and `share_city_status` through PostgREST, around every
 * rule the routes apply. No application path writes these tables as a user.
 *
 * What these cases hold:
 *   1. 3620 revokes every write verb from `authenticated`, everything from
 *      `anon`, keeps SELECT for `authenticated`, and asserts each of those in a
 *      postcondition inside its transaction.
 *   2. No later migration re-grants a write on these tables to a client role.
 *   2b. Neither 3620 nor any later migration creates a SECURITY DEFINER writer
 *      of these tables that a client role can call, or a dynamic GRANT that
 *      re-opens one (wave-2 second verification F3, mutants N1 and N3).
 *   3. The authorization contract states exactly that boundary, and its own
 *      evaluator reports the PRE-3620 grants as a broadened boundary — so a
 *      database 3620 has not reached, or one where a write is re-granted, is
 *      red on check:authorization-contract.
 *
 * Run: node --import tsx/esm --test src/test/layoverClientWriteBoundary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateContract,
  loadContract,
  type ColRow,
  type GrantRow,
  type PolicyRow,
} from "../security/authorizationContract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");
const FILE = "3620_layover_client_write_boundary.sql";
const TABLES = ["layover_sessions", "layover_plan_stops", "layover_events", "airport_profiles"] as const;

const sql = readFileSync(join(MIGRATIONS_DIR, FILE), "utf8");
/** The SQL with comment lines removed, so a sentence in the header cannot satisfy an assertion. */
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("3620 — what the migration does", () => {
  it("is one transaction, with its postconditions inside it", () => {
    const begin = code.indexOf("BEGIN;");
    const post = code.indexOf("DO $post$");
    const commit = code.lastIndexOf("COMMIT;");
    assert.ok(begin >= 0 && post > begin && commit > post, "BEGIN; … DO $post$ … COMMIT; in that order");
  });

  for (const t of TABLES) {
    it(`${t}: anon loses everything, authenticated loses every write verb and keeps SELECT`, () => {
      assert.match(code, new RegExp(`REVOKE ALL ON TABLE public\\.${t}\\s+FROM anon;`));
      assert.match(code, new RegExp(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\\.${t}\\s+FROM authenticated;`));
      assert.match(code, new RegExp(`GRANT SELECT ON TABLE public\\.${t}\\s+TO authenticated;`));
    });
  }

  it("revokes column-level grants too, which a table-level REVOKE leaves in place", () => {
    assert.match(code, /a\.attacl IS NOT NULL/);
    assert.match(code, /REVOKE ALL \(%I\) ON TABLE public\.%I FROM anon, authenticated/);
  });

  it("asserts the boundary it creates, verb by verb, for both client roles and the service role", () => {
    const post = code.slice(code.indexOf("DO $post$"));
    assert.match(post, /ARRAY\['layover_sessions', 'layover_plan_stops', 'layover_events', 'airport_profiles'\]/);
    assert.match(post, /has_table_privilege\('authenticated', format\('public\.%I', t\), 'SELECT'\)/);
    assert.match(post, /ARRAY\['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'\]/);
    assert.match(post, /has_any_column_privilege\('authenticated'/);
    assert.match(post, /has_table_privilege\('anon', format\('public\.%I', t\), v\)/);
    assert.match(post, /has_table_privilege\('service_role', format\('public\.%I', t\), v\)/);
    assert.match(post, /relrowsecurity/);
  });

  it("the postconditions are the LAST statement: nothing but COMMIT follows `END $post$;` (wave-2 verification F4)", () => {
    // A GRANT appended after the postconditions would commit with them already
    // green. Comments are stripped above; whitespace is all that may remain.
    const end = code.indexOf("END $post$;");
    const commit = code.lastIndexOf("COMMIT;");
    assert.ok(end > 0 && commit > end, "END $post$; precedes COMMIT;");
    assert.equal(code.slice(end + "END $post$;".length, commit).trim(), "", "a statement sits between the postconditions and COMMIT");
    assert.equal(code.slice(commit + "COMMIT;".length).trim(), "", "a statement follows COMMIT");
  });

  it("grants no write verb ANYWHERE in the file to anon, authenticated or PUBLIC (wave-2 verification F4)", () => {
    const grants: string[] = code.match(/GRANT\s+[^;]*;/gi) ?? [];
    const writes = grants.filter((g) => /\b(ALL|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN)\b/i.test(g.split(/\bON\b/i)[0] ?? "") && /\bTO\s+[^;]*\b(anon|authenticated|PUBLIC)\b/i.test(g));
    assert.deepEqual(writes, []);
  });

  it("changes no policy, row or flag", () => {
    assert.doesNotMatch(code, /\b(CREATE|DROP|ALTER)\s+POLICY\b/i);
    assert.doesNotMatch(code, /\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)\b/i);
    assert.doesNotMatch(code, /feature_flags/);
  });
});

describe("3620 — nothing after it re-opens a client write", () => {
  it("no later migration grants a write verb on these tables to anon, authenticated or PUBLIC", () => {
    const later = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f > FILE).sort();
    const offenders: string[] = [];
    for (const f of later) {
      const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8")
        .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      for (const t of TABLES) {
        const re = new RegExp(`GRANT\\s+[^;]*\\b(ALL|INSERT|UPDATE|DELETE|TRUNCATE)\\b[^;]*\\bON\\s+(TABLE\\s+)?(public\\.)?${t}\\b[^;]*\\bTO\\s+[^;]*\\b(anon|authenticated|PUBLIC)\\b`, "i");
        if (re.test(text)) offenders.push(`${f} → ${t}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

/**
 * Wave-2 second verification F3 (mutant N1): a SECURITY DEFINER function that
 * writes one of the four tables, callable by a client role, re-opens the write
 * 3620 closes — it runs as its owner, so no table grant is needed. Neither the
 * table-grant vocabulary above nor 3620's own postconditions see it, and the
 * repo-wide guards skip function grants by design. These two scans close that
 * door in 3620 and in every later migration.
 *
 * A definer writer is client-callable unless EXECUTE is REVOKEd from PUBLIC,
 * anon AND authenticated and never GRANTed back: PostgreSQL gives PUBLIC
 * EXECUTE on every new function, and this project's default privileges hand
 * functions in `public` to anon and authenticated as well.
 *
 * Dynamic SQL (mutant N3): `EXECUTE format('GRANT … ON TABLE public.layover_sessions TO %I', …)`
 * is invisible to a literal GRANT scan. 3620's `$post$` would RAISE on apply,
 * but a later file has no such postcondition, so a dynamic GRANT that names one
 * of the four tables, or names a client role while the file names one of them,
 * is an offender too.
 */
type SqlFile = { name: string; text: string };
const stripSqlComments = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
const TABLE_ALT = TABLES.join("|");
const WRITE_OF_TABLE = new RegExp(`\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(\\s+TABLE)?|MERGE\\s+INTO)\\s+(ONLY\\s+)?(public\\.)?"?(${TABLE_ALT})"?\\b`, "i");
const NAMES_TABLE = new RegExp(`\\b(${TABLE_ALT})\\b`, "i");
const CLIENT_ROLE = /\b(anon|authenticated|PUBLIC)\b/i;
const normName = (n: string) => n.replace(/"/g, "").replace(/^public\./i, "").toLowerCase();

/** Every SECURITY DEFINER function/procedure whose body writes one of the four tables. */
function definerWriters(files: SqlFile[]): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const f of files) {
    const text = stripSqlComments(f.text);
    const head = /CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+([\w."]+)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = head.exec(text))) {
      const rest = text.slice(m.index);
      const open = /\$(\w*)\$/.exec(rest);
      if (!open) continue;
      const bodyStart = open.index + open[0].length;
      const close = rest.indexOf(open[0], bodyStart);
      if (close < 0) continue;
      const body = rest.slice(bodyStart, close);
      const after = rest.slice(close + open[0].length);
      const semi = after.indexOf(";");
      const trailer = semi >= 0 ? after.slice(0, semi) : after;
      const attrs = `${rest.slice(0, open.index)} ${trailer}`;
      if (!/\bSECURITY\s+DEFINER\b/i.test(attrs)) continue;
      const dynamicWrite = /\bEXECUTE\b/i.test(body) && NAMES_TABLE.test(body) && /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i.test(body);
      if (WRITE_OF_TABLE.test(body) || dynamicWrite) out.push({ file: f.name, name: normName(m[3]!) });
    }
  }
  return out;
}

/** Definer writers a client role can call: granted to one, or not revoked from all three. */
function clientCallableDefinerWriters(files: SqlFile[]): string[] {
  const all = files.map((f) => stripSqlComments(f.text)).join("\n");
  const offenders: string[] = [];
  for (const w of definerWriters(files)) {
    const fn = w.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const onFn = `ON\\s+(FUNCTION|PROCEDURE|ROUTINE)\\s+(public\\.)?"?${fn}"?\\b`;
    const onAll = `ON\\s+ALL\\s+(FUNCTIONS|PROCEDURES|ROUTINES)\\s+IN\\s+SCHEMA\\s+public\\b`;
    const granted = new RegExp(`GRANT\\s+[^;]*\\b(EXECUTE|ALL)\\b[^;]*(${onFn}|${onAll})[^;]*\\bTO\\s+[^;]*\\b(anon|authenticated|PUBLIC)\\b`, "i").test(all);
    const revokedFrom = new Set<string>();
    for (const r of all.matchAll(new RegExp(`REVOKE\\s+[^;]*\\b(EXECUTE|ALL)\\b[^;]*${onFn}[^;]*\\bFROM\\s+([^;]*)`, "gi"))) {
      for (const role of (r[r.length - 1] ?? "").split(/[\s,]+/)) revokedFrom.add(role.toLowerCase());
    }
    const sealed = ["public", "anon", "authenticated"].every((r) => revokedFrom.has(r));
    if (granted || !sealed) {
      offenders.push(`${w.file} → ${w.name}${granted ? " (EXECUTE granted to a client role)" : " (EXECUTE not revoked from PUBLIC, anon and authenticated)"}`);
    }
  }
  return offenders;
}

/** Dynamic GRANTs that can re-open a client write on the four tables. */
function dynamicGrantOffenders(files: SqlFile[]): string[] {
  const offenders: string[] = [];
  for (const f of files) {
    const text = stripSqlComments(f.text);
    const fileNamesTable = NAMES_TABLE.test(text);
    for (const m of text.matchAll(/\bEXECUTE\s+(format\s*\(\s*)?(E)?'\s*GRANT\b[^;]*;/gi)) {
      const stmt = m[0];
      // `public.` is a schema prefix, not the PUBLIC role.
      const namesClientRole = CLIENT_ROLE.test(stmt.replace(/\bpublic\s*\./gi, ""));
      if (NAMES_TABLE.test(stmt) || (fileNamesTable && namesClientRole)) offenders.push(`${f.name} → ${stmt.slice(0, 120)}`);
    }
  }
  return offenders;
}

const FROM_3620: SqlFile[] = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql") && f >= FILE)
  .sort()
  .map((name) => ({ name, text: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));

describe("3620 and every later migration — no client-callable SECURITY DEFINER writer, no dynamic GRANT (wave-2 second verification F3)", () => {
  it("the scan reads 3620 itself and every later file", () => {
    assert.equal(FROM_3620[0]?.name, FILE);
  });

  it("no SECURITY DEFINER function or procedure that writes the four tables is callable by anon, authenticated or PUBLIC", () => {
    assert.deepEqual(clientCallableDefinerWriters(FROM_3620), []);
  });

  it("no dynamic GRANT names the four tables, or a client role in a file that names them", () => {
    assert.deepEqual(dynamicGrantOffenders(FROM_3620), []);
  });

  describe("planted violations — each scan refuses what it exists to refuse", () => {
    const N1 = "CREATE OR REPLACE FUNCTION public.layover_set_status(sid uuid, s text) RETURNS void LANGUAGE sql SECURITY DEFINER AS $fn$ UPDATE layover_sessions SET status = s WHERE id = sid $fn$;";
    const SEAL = "REVOKE ALL ON FUNCTION public.layover_set_status(uuid, text) FROM PUBLIC, anon, authenticated;";

    it("N1 verbatim: a definer UPDATE granted to authenticated", () => {
      const v = clientCallableDefinerWriters([{ name: "3699_x.sql", text: `${N1}\nGRANT EXECUTE ON FUNCTION public.layover_set_status(uuid, text) TO authenticated;` }]);
      assert.equal(v.length, 1);
      assert.match(v[0]!, /granted to a client role/);
    });

    it("a definer writer with NO grant statement is still callable (PUBLIC's default EXECUTE)", () => {
      assert.equal(clientCallableDefinerWriters([{ name: "3699_x.sql", text: N1 }]).length, 1);
    });

    it("revoked from PUBLIC only is still callable by anon/authenticated (this project's default privileges)", () => {
      const text = `${N1}\nREVOKE EXECUTE ON FUNCTION public.layover_set_status(uuid, text) FROM PUBLIC;`;
      assert.equal(clientCallableDefinerWriters([{ name: "3699_x.sql", text }]).length, 1);
    });

    it("sealed, then granted back in a LATER file (or schema-wide), is callable", () => {
      assert.equal(clientCallableDefinerWriters([
        { name: "3698_a.sql", text: `${N1}\n${SEAL}` },
        { name: "3699_b.sql", text: "GRANT EXECUTE ON FUNCTION public.layover_set_status(uuid, text) TO anon;" },
      ]).length, 1);
      assert.equal(clientCallableDefinerWriters([
        { name: "3698_a.sql", text: `${N1}\n${SEAL}` },
        { name: "3699_b.sql", text: "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;" },
      ]).length, 1);
    });

    it("SECURITY DEFINER after the body, INSERT / DELETE / TRUNCATE, quoted names, and dynamic SQL inside the body are all seen", () => {
      const planted = [
        "CREATE FUNCTION public.f1() RETURNS void AS $$ INSERT INTO public.layover_events(user_id) VALUES (auth.uid()) $$ LANGUAGE sql SECURITY DEFINER;",
        "CREATE FUNCTION f2() RETURNS void LANGUAGE sql SECURITY DEFINER AS $b$ DELETE FROM \"layover_plan_stops\" $b$;",
        "CREATE FUNCTION f3() RETURNS void LANGUAGE sql SECURITY DEFINER AS $b$ TRUNCATE TABLE airport_profiles $b$;",
        "CREATE FUNCTION f4(t text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $b$ BEGIN EXECUTE format('UPDATE %I SET status = $1', 'layover_sessions') USING t; END $b$;",
      ];
      for (const text of planted) assert.equal(clientCallableDefinerWriters([{ name: "3699_x.sql", text }]).length, 1, text);
    });

    it("NOT an offender: a definer writer sealed from all three roles; an INVOKER writer; a definer that only reads", () => {
      const sealed = `${N1}\n${SEAL}\nGRANT EXECUTE ON FUNCTION public.layover_set_status(uuid, text) TO service_role;`;
      assert.deepEqual(clientCallableDefinerWriters([{ name: "3699_x.sql", text: sealed }]), []);
      assert.deepEqual(clientCallableDefinerWriters([{ name: "3699_x.sql", text: N1.replace("SECURITY DEFINER", "SECURITY INVOKER") }]), []);
      const reader = "CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $b$ SELECT count(*)::int FROM layover_sessions $b$;";
      assert.deepEqual(clientCallableDefinerWriters([{ name: "3699_x.sql", text: reader }]), []);
    });

    it("N3 verbatim: a dynamic GRANT on layover_sessions; and a table-parameterised dynamic GRANT in a file that names the tables", () => {
      const n3 = "DO $x$ BEGIN EXECUTE format('GRANT %s ON TABLE public.layover_sessions TO %I', 'UPDATE', 'authenticated'); END $x$;";
      assert.equal(dynamicGrantOffenders([{ name: "3699_x.sql", text: n3 }]).length, 1);
      const looped = "DO $x$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['layover_sessions'] LOOP EXECUTE format('GRANT UPDATE ON TABLE public.%I TO authenticated', t); END LOOP; END $x$;";
      assert.equal(dynamicGrantOffenders([{ name: "3699_x.sql", text: looped }]).length, 1);
    });

    it("NOT an offender: 3620's own dynamic REVOKE; a schema-qualified dynamic GRANT to service_role; an unrelated table in a file that does not name the four", () => {
      assert.deepEqual(dynamicGrantOffenders([{ name: FILE, text: sql }]), []);
      const toService = "-- layover_sessions\nSELECT 1 FROM layover_sessions;\nDO $x$ BEGIN EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', 'places'); END $x$;";
      assert.deepEqual(dynamicGrantOffenders([{ name: "3699_x.sql", text: toService }]), []);
      const unrelated = "DO $x$ BEGIN EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', 'places'); END $x$;";
      assert.deepEqual(dynamicGrantOffenders([{ name: "3699_x.sql", text: unrelated }]), []);
    });
  });
});

describe("the authorization contract states 3620's boundary, and catches the old one", () => {
  const contract = loadContract();

  for (const t of TABLES) {
    it(`${t}: authenticated=SELECT, anon=nothing, no client-writable column`, () => {
      const e = contract.tables[t];
      assert.ok(e, `${t} is a contracted table`);
      assert.deepEqual(e.tableGrants, { authenticated: ["SELECT"] });
      assert.deepEqual(e.insertCols, {});
      assert.deepEqual(e.updateCols, {});
    });
  }

  it("the contract's evaluator reports the PRE-3620 grants as a broadened boundary on all four tables", () => {
    // The clean state for every OTHER table, exactly as the contract states it…
    const grants: GrantRow[] = [];
    const cols: ColRow[] = [];
    const pols: PolicyRow[] = [];
    for (const [table, c] of Object.entries(contract.tables)) {
      for (const [role, privs] of Object.entries(c.tableGrants)) for (const p of privs) grants.push({ table_name: table, grantee: role, privilege_type: p });
      for (const [role, list] of Object.entries(c.insertCols)) for (const col of list) cols.push({ table_name: table, grantee: role, privilege_type: "INSERT", column_name: col });
      for (const [role, list] of Object.entries(c.updateCols)) for (const col of list) cols.push({ table_name: table, grantee: role, privilege_type: "UPDATE", column_name: col });
      for (const p of c.policies) pols.push({ table_name: table, name: p.name, cmd: p.cmd, permissive: p.permissive, roles: p.roles });
    }
    assert.deepEqual(evaluateContract(contract, grants, cols, pols), [], "the contract as stated is clean");
    // …plus the grants portava-ci measured before 3620 on these four.
    for (const t of TABLES) {
      for (const role of ["anon", "authenticated"]) {
        for (const p of ["DELETE", "INSERT", "SELECT", "UPDATE"]) {
          if (!grants.some((g) => g.table_name === t && g.grantee === role && g.privilege_type === p)) {
            grants.push({ table_name: t, grantee: role, privilege_type: p });
          }
        }
      }
    }
    const v = evaluateContract(contract, grants, cols, pols);
    for (const t of TABLES) {
      assert.ok(v.some((line) => line.includes(t) && /BROADENED/.test(line)), `${t} is reported broadened: ${v.join("\n")}`);
    }
  });
});
