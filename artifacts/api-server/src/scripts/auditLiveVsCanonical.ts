/**
 * Live-vs-canonical inverse audit  (`audit:live-unexplained`)
 *
 * The REVERSE of audit:schema. audit:schema asks "does every object the
 * migrations CLAIM exist live?"; this asks the other direction — "does every
 * object that exists LIVE have a canonical explanation?" — and errors on any
 * live object the MODEL (committed baseline + canonical migrations sorting
 * >= "2100" + the EXPLAINED ledger) cannot account for. It is READ-ONLY: every
 * statement it sends is a SELECT.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run audit:live-unexplained
 *
 * Exit code 0 → every live object in all ten inventories is explained, every
 *               live public r/p table carries a complete, consistent disposition,
 *               every ledger entry is reachable, every verifier is wired.
 * Exit code 1 → a finding (UNEXPLAINED_LIVE, EXCESS_PRIVILEGE,
 *               POLICY_PREDICATE_DRIFT, a DISPOSITION_* failure,
 *               STALE_LEDGER_ENTRY, VERIFIER_NOT_WIRED, LEDGER_SHAPE_INVALID).
 * Exit code 2 → CANNOT establish a result, and ONLY this: missing credentials,
 *               the live sweep threw, or the live relation census is empty.
 *               Precedence 2 > 1 > 0 — an unrunnable inverse audit exits 2,
 *               never 0. Consumed identically to audit:schema's 0/1/2, but as a
 *               SEPARATE script so the forward exit contract is untouched.
 *
 * Notes:
 * - The heavy lifting is pure and lives in lib/liveVsCanonicalCore.ts, which the
 *   unit test drives with fixtures and no database. This file is the thin I/O
 *   shell: fetch the extended live snapshot, build the model, run the core.
 * - It REUSES the forward auditor's transport (liveQuery), its live snapshot
 *   (fetchLiveSchema, for the six inventories it already captures correctly), and
 *   its migration parser (parseMigration). It never re-implements them.
 * - It NEVER writes a file, and in particular never writes .sql under
 *   src/migrations (which auditMigrationsVsLive.ts / checkMigrationPrefixes.ts
 *   parse as claims).
 */

// FIRST import, deliberately — the READ-ONLY front door. Everything this file
// sends is a SELECT (pg_class with relkind, information_schema.columns/
// role_table_grants/role_column_grants/role_routine_grants, pg_proc with
// pg_get_function_identity_arguments, pg_indexes, pg_policies including qual/
// with_check/roles, pg_type/pg_enum, pg_trigger, pg_constraint, pg_extension,
// server_version_num). Auditing production is the purpose. If it ever gains a
// write, move this to src/lib/ciSupabaseGuard.mjs and drop it from the read-only
// list in scripts/check-guard-coverage.mjs, in the same change.
import "../lib/ciProdReadOnlyAuditGuard.mjs";

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  parseMigration,
  liveQuery,
  fetchLiveSchema,
} from "./auditMigrationsVsLive.js";
import {
  EXPLAINED_LIVE_OBJECTS,
  validateLedgerShape,
} from "./explainedLiveObjects.js";
import { RLS_DISPOSITIONS } from "./rlsDispositions.js";
import { BASELINE_PATH, parseBaselineTables } from "./parseBaselineSchema.js";
import {
  buildModel,
  computeUnexplained,
  functionIdentityKey,
  normalizePrivilege,
  normalizeRoles,
} from "./lib/liveVsCanonicalCore.js";
import type { LiveInventory } from "./lib/liveVsCanonicalCore.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const lc = (s: string) => s.toLowerCase();

/** pg array literals arrive either as a JS array or a `{a,b}` string; normalize. */
function toRoleArray(roles: unknown): string[] {
  if (Array.isArray(roles)) return roles.map((r) => String(r));
  if (typeof roles === "string") {
    return roles
      .replace(/^\{|\}$/g, "")
      .split(",")
      .map((r) => r.replace(/^"|"$/g, "").trim())
      .filter(Boolean);
  }
  return [];
}

/** `public.foo` / `"Foo"` regclass rendering -> bare lower-cased table name. */
function bareRelname(regclass: string): string {
  let s = regclass.trim();
  const dot = s.lastIndexOf(".");
  if (dot !== -1) s = s.slice(dot + 1);
  s = s.replace(/^"|"$/g, "");
  return s.toLowerCase();
}

/**
 * Build the extended live inventory. REUSES fetchLiveSchema() for the five
 * public-scoped inventories it already captures correctly (columns, indexes,
 * enums, enumValues, rlsEnabled) and issues fresh SELECT-only queries for
 * everything it lacks, shapes differently, or must re-scope to public
 * (triggers -- fetchLiveSchema's trigger query spans all schemas).
 */
async function fetchLiveInventory(): Promise<LiveInventory> {
  const base = await fetchLiveSchema();

  const [
    rels,
    fns,
    pols,
    tgrants,
    cgrants,
    rgrants,
    cons,
    exts,
    ver,
    trgs,
    extRels,
    extIdx,
  ] = await Promise.all([
    // relations WITH relkind (fetchLiveSchema collapses these into one set)
    liveQuery<{ name: string; kind: string }>(
      `select c.relname as name, c.relkind as kind from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p','v','m')`,
    ),
    // functions keyed by identity args, extension-owned excluded (packet Q4)
    liveQuery<{ name: string; args: string }>(
      `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and not exists (
           select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
         )`,
    ),
    // policy predicates: qual / with_check / roles / cmd, public + storage
    liveQuery<{
      schemaname: string;
      tablename: string;
      policyname: string;
      cmd: string;
      roles: unknown;
      qual: string | null;
      with_check: string | null;
    }>(
      `select schemaname, tablename, policyname, cmd, roles, qual, with_check
       from pg_policies where schemaname in ('public','storage')`,
    ),
    // table grants
    liveQuery<{ table_name: string; grantee: string; privilege_type: string }>(
      `select table_name, grantee, privilege_type
       from information_schema.role_table_grants where table_schema = 'public'`,
    ),
    // column grants (the inventory absent on both sides before this auditor)
    liveQuery<{
      table_name: string;
      column_name: string;
      grantee: string;
      privilege_type: string;
    }>(
      `select table_name, column_name, grantee, privilege_type
       from information_schema.role_column_grants where table_schema = 'public'`,
    ),
    // routine EXECUTE grants keyed by identity args
    liveQuery<{ proname: string; args: string; grantee: string }>(
      `select p.proname as proname, pg_get_function_identity_arguments(p.oid) as args, r.grantee as grantee
       from information_schema.role_routine_grants r
       join pg_proc p on p.proname = r.routine_name
       join pg_namespace n on n.oid = p.pronamespace
       where r.routine_schema = 'public' and n.nspname = 'public'
         and r.privilege_type = 'EXECUTE'`,
    ),
    // constraints
    liveQuery<{ t: string; conname: string }>(
      `select conrelid::regclass::text as t, conname from pg_constraint c
       join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'`,
    ),
    // extensions
    liveQuery<{ extname: string }>(`select extname from pg_extension`),
    // server version
    liveQuery<{ v: number }>(
      `select current_setting('server_version_num')::int as v`,
    ),
    // triggers -- PUBLIC-SCOPED. fetchLiveSchema's trigger query is unscoped
    // (all schemas); in the inverse direction that would flag auth/storage/
    // realtime system triggers as UNEXPLAINED_LIVE. The model is public-only,
    // so the live side must be too. Keyed table.trigger to match the model.
    liveQuery<{ t: string; g: string }>(
      `select c.relname as t, tr.tgname as g
       from pg_trigger tr
       join pg_class c on c.oid = tr.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not tr.tgisinternal`,
    ),
    // extension-owned relations (postgis's spatial_ref_sys, geometry_columns,
    // geography_columns, …): pg_dump excludes extension members from the
    // baseline, so the model has none; exclude them from the live census too.
    liveQuery<{ name: string }>(
      `select c.relname as name from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_depend d on d.objid = c.oid and d.deptype = 'e'
       where n.nspname = 'public'`,
    ),
    // extension-owned index names (the index, or its table, is an extension member)
    liveQuery<{ name: string }>(
      `select ci.relname as name from pg_index x
       join pg_class ci on ci.oid = x.indexrelid
       join pg_class ct on ct.oid = x.indrelid
       join pg_namespace n on n.oid = ci.relnamespace
       where n.nspname = 'public'
         and exists (select 1 from pg_depend d
                     where d.deptype = 'e' and (d.objid = ci.oid or d.objid = ct.oid))`,
    ),
  ]);

  // Extension-owned objects are excluded from the live census: pg_dump omits
  // them from the baseline (so the model can't carry them) and they are
  // Postgres/extension infrastructure, not app schema — same rationale as the
  // function query's pg_depend exclusion above.
  const E_RELS = new Set(extRels.map((r) => lc(r.name)));
  const E_IDX = new Set(extIdx.map((r) => lc(r.name)));

  const relations = new Map<string, "r" | "p" | "v" | "m">();
  for (const r of rels) {
    if (E_RELS.has(lc(r.name))) continue;
    relations.set(lc(r.name), r.kind as "r" | "p" | "v" | "m");
  }

  const functions = new Set<string>();
  for (const f of fns) functions.add(functionIdentityKey(f.name, f.args ?? ""));

  const policies = new Map<
    string,
    { using: string | null; withCheck: string | null; roles: string[]; cmd: string }
  >();
  const policyCountByTable = new Map<string, number>();
  for (const p of pols) {
    const key = lc(`${p.schemaname}.${p.tablename}.${p.policyname}`);
    policies.set(key, {
      using: p.qual,
      withCheck: p.with_check,
      roles: normalizeRoles(toRoleArray(p.roles)),
      cmd: lc(p.cmd ?? ""),
    });
    if (lc(p.schemaname) === "public") {
      const t = lc(p.tablename);
      policyCountByTable.set(t, (policyCountByTable.get(t) ?? 0) + 1);
    }
  }

  const tableGrants = new Map<string, Set<string>>();
  for (const g of tgrants) {
    if (E_RELS.has(lc(g.table_name))) continue;
    const key = lc(`${g.table_name}.${g.grantee}`);
    if (!tableGrants.has(key)) tableGrants.set(key, new Set());
    tableGrants.get(key)!.add(normalizePrivilege(g.privilege_type));
  }

  const columnGrants = new Map<string, Set<string>>();
  for (const g of cgrants) {
    if (E_RELS.has(lc(g.table_name))) continue;
    const key = lc(`${g.table_name}.${g.column_name}.${g.grantee}`);
    if (!columnGrants.has(key)) columnGrants.set(key, new Set());
    columnGrants.get(key)!.add(normalizePrivilege(g.privilege_type));
  }

  const routineGrants = new Map<string, Set<string>>();
  for (const g of rgrants) {
    const key = `${functionIdentityKey(g.proname, g.args ?? "")}.${lc(g.grantee)}`;
    if (!routineGrants.has(key)) routineGrants.set(key, new Set());
    routineGrants.get(key)!.add("execute");
  }

  const constraints = new Set<string>();
  for (const c of cons) {
    if (E_RELS.has(bareRelname(c.t))) continue;
    constraints.add(`${bareRelname(c.t)}.${lc(c.conname)}`);
  }

  const extensions = new Set<string>();
  for (const e of exts) extensions.add(lc(e.extname));

  const triggers = new Set<string>();
  for (const t of trgs) {
    if (E_RELS.has(lc(t.t))) continue;
    triggers.add(lc(`${t.t}.${t.g}`));
  }

  return {
    pgVersionNum: Number(ver[0]?.v ?? 0),
    relations,
    columns: new Set(
      [...base.columns].filter(
        (col) => !E_RELS.has(col.slice(0, col.lastIndexOf("."))),
      ),
    ),
    functions,
    indexes: new Set([...base.indexes].filter((ix) => !E_IDX.has(ix))),
    policies,
    enums: base.enums,
    enumValues: base.enumValues,
    triggers,
    rlsEnabled: base.rlsEnabled,
    policyCountByTable,
    tableGrants,
    columnGrants,
    routineGrants,
    constraints,
    extensions,
  };
}

/** The CI surface: package.json scripts (hard gate) + soft-signal texts. */
function readCiSurface() {
  const pkg = JSON.parse(
    readFileSync(resolve(__dir, "../../package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  const packageScripts = new Set(Object.keys(pkg.scripts ?? {}));

  let runAllChecksText = "";
  try {
    runAllChecksText = readFileSync(
      resolve(__dir, "../../scripts/run-all-checks.sh"),
      "utf8",
    );
  } catch {
    /* soft signal only */
  }

  let workflowText = "";
  try {
    const wfDir = resolve(__dir, "../../../../.github/workflows");
    for (const f of readdirSync(wfDir)) {
      if (f.endsWith(".yml") || f.endsWith(".yaml")) {
        workflowText += readFileSync(join(wfDir, f), "utf8") + "\n";
      }
    }
  } catch {
    /* soft signal only */
  }

  return { packageScripts, runAllChecksText, workflowText };
}

async function main(): Promise<void> {
  // Env presence is a cannot-establish (exit 2). projectRef/token are resolved
  // lazily inside liveQuery, so this check is the only place we read them here.
  const url = process.env.SUPABASE_URL;
  const token =
    process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
  if (!url || !token) {
    console.error(
      "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
        "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
        "       or SUPABASE_ACCESS_TOKEN (personal access token).",
    );
    process.exit(2);
  }

  const projectRef = new URL(url).hostname.split(".")[0];
  console.log(
    `Auditing live schema against the canonical model (project ${projectRef}) …`,
  );

  let live: LiveInventory;
  try {
    live = await fetchLiveInventory();
  } catch (err) {
    console.error(
      `ERROR: failed to fetch the live inventory: ${(err as Error).message}`,
    );
    process.exit(2);
  }

  // Vacuity of the LIVE side is a cannot-establish, never a clean pass.
  if (live.relations.size === 0) {
    console.error(
      "ERROR: the live relation census is empty. Cannot establish a result " +
        "(this project holds no public relations). Exiting 2, not 0.",
    );
    process.exit(2);
  }

  const baselineSql = readFileSync(BASELINE_PATH, "utf8");
  const baselineTables = parseBaselineTables(baselineSql);

  // Canonical band: only migrations authored after the baseline (4-digit prefix
  // sorting >= "2100"). Empty today (highest is 2095); the model rests on the
  // baseline + ledger, which is correct and intended.
  const canonicalDir = resolve(__dir, "../migrations");
  const canonicalSqls = readdirSync(canonicalDir)
    .filter((f) => f.endsWith(".sql") && f.slice(0, 4) >= "2100")
    .sort()
    .map((f) => readFileSync(join(canonicalDir, f), "utf8"));

  const model = buildModel({
    baselineSql,
    baselineTables,
    canonicalSqls,
    ledger: EXPLAINED_LIVE_OBJECTS,
    parseMig: parseMigration,
  });
  const ledgerShapeProblems = validateLedgerShape(EXPLAINED_LIVE_OBJECTS);
  const ci = readCiSurface();

  const result = computeUnexplained({
    model,
    live,
    ledger: EXPLAINED_LIVE_OBJECTS,
    ledgerShapeProblems,
    dispositions: RLS_DISPOSITIONS,
    ci,
  });

  // Print findings grouped by code.
  if (result.findings.length > 0) {
    const byCode = new Map<string, typeof result.findings>();
    for (const f of result.findings) {
      if (!byCode.has(f.code)) byCode.set(f.code, []);
      byCode.get(f.code)!.push(f);
    }
    for (const [code, list] of [...byCode].sort()) {
      console.log(`\n── ${code} (${list.length})`);
      for (const f of list) console.log(`   • ${f.key}: ${f.detail}`);
    }
    console.error(
      `\n✖ ${result.findings.length} finding(s). The live schema carries objects the ` +
        "canonical model does not explain (or the ledger/dispositions are incomplete).",
    );
  } else {
    console.log(
      "\n✔ Every live object is explained by the canonical model or the ledger.",
    );
  }

  process.exit(result.exitCode);
}

// Entrypoint gate: run only when invoked directly, so importing this file (it is
// not imported anywhere, but the pattern matches the forward script) runs nothing.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
