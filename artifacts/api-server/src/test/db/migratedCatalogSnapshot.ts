/** Whole local catalog and every public/auth non-ledger table. Used only by isolated
 * migration roundtrip tests; snapshots never leave the local test process. */
import assert from "node:assert/strict";
import type { PressedDb } from "./pressedLayoverDb.js";
const DUMP_SQL = `
WITH ext AS (SELECT classid, objid FROM pg_depend WHERE deptype = 'e'),
nsps AS (SELECT oid, nspname FROM pg_namespace
          WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND nspname NOT LIKE 'pg\\_temp%' AND nspname NOT LIKE 'pg\\_toast\\_temp%'),
rels AS (SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl, n.nspname
           FROM pg_class c JOIN nsps n ON n.oid = c.relnamespace
          WHERE c.oid NOT IN (SELECT objid FROM ext WHERE classid = 'pg_class'::regclass))
SELECT k, v FROM (
  SELECT 'rel:' || nspname || '.' || relname AS k,
         relkind::text || '|' || relrowsecurity || '|' || relforcerowsecurity || '|' || coalesce(relacl::text, '') || '|' || coalesce(obj_description(oid, 'pg_class'), '') AS v
    FROM rels WHERE relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'i')
  UNION ALL
  SELECT 'view:' || nspname || '.' || relname, md5(pg_get_viewdef(oid)) FROM rels WHERE relkind IN ('v', 'm')
  UNION ALL
  SELECT 'col:' || r.nspname || '.' || r.relname || '.' || a.attname,
         format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|' || coalesce(a.attacl::text, '')
         || '|' || coalesce(col_description(r.oid, a.attnum), '') || '|' || a.attidentity::text || a.attgenerated::text
    FROM rels r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
   WHERE r.relkind IN ('r', 'p', 'v', 'm', 'f')
  UNION ALL
  SELECT 'con:' || r.nspname || '.' || r.relname || '.' || k.conname, k.contype::text || '|' || pg_get_constraintdef(k.oid) || '|' || k.convalidated || '|' || k.condeferrable
    FROM pg_constraint k JOIN rels r ON r.oid = k.conrelid
  UNION ALL
  SELECT 'idx:' || r.nspname || '.' || r.relname, pg_get_indexdef(r.oid) || '|' || i.indisvalid || '|' || i.indisready
    FROM rels r JOIN pg_index i ON i.indexrelid = r.oid
  UNION ALL
  SELECT 'trg:' || r.nspname || '.' || r.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text
    FROM pg_trigger t JOIN rels r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal
  UNION ALL
  SELECT 'itrg:' || r.nspname || '.' || r.relname || '.' || coalesce(k.conname, '?') || '.' || t.tgfoid::regproc::text || '.' || t.tgtype, count(*)::text
    FROM pg_trigger t JOIN rels r ON r.oid = t.tgrelid LEFT JOIN pg_constraint k ON k.oid = t.tgconstraint
   WHERE t.tgisinternal GROUP BY 1
  UNION ALL
  SELECT 'pol:' || r.nspname || '.' || r.relname || '.' || p.polname,
         p.polcmd::text || '|' || p.polpermissive || '|' || p.polroles::regrole[]::text || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    FROM pg_policy p JOIN rels r ON r.oid = p.polrelid
  UNION ALL
  SELECT 'fn:' || n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')',
         md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, '') || '|' || coalesce(obj_description(p.oid, 'pg_proc'), '')
    FROM pg_proc p JOIN nsps n ON n.oid = p.pronamespace
   WHERE p.prokind IN ('f', 'p') AND p.oid NOT IN (SELECT objid FROM ext WHERE classid = 'pg_proc'::regclass)
  UNION ALL
  SELECT 'nsp:' || nspname, coalesce(n.nspacl::text, '') FROM pg_namespace n WHERE n.oid IN (SELECT oid FROM nsps)
  UNION ALL
  SELECT 'defacl:' || defaclrole::regrole::text || '.' || defaclnamespace::text || '.' || defaclobjtype::text, coalesce(defaclacl::text, '') FROM pg_default_acl
  UNION ALL
  SELECT 'type:' || n.nspname || '.' || t.typname, t.typtype::text || '|' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '')
    FROM pg_type t JOIN nsps n ON n.oid = t.typnamespace
   WHERE t.typtype IN ('e', 'd') AND t.oid NOT IN (SELECT objid FROM ext WHERE classid = 'pg_type'::regclass)
  UNION ALL
  SELECT 'pub:' || p.pubname || '.' || pr.prrelid::regclass::text, 'present' FROM pg_publication_rel pr JOIN pg_publication p ON p.oid = pr.prpubid

  UNION ALL
  SELECT 'flag:' || flag, enabled || '|' || coalesce(description, '') || '|' || coalesce(metadata::text, '') FROM public.feature_flags
) x ORDER BY k`;
export async function migratedCatalogAndRows(db: PressedDb): Promise<Record<string,string>> {
  await db.exec("RESET ROLE; SET search_path TO public");
  const out: Record<string,string> = {};
  for (const row of await db.query<{k:string;v:string}>(DUMP_SQL)) {
    assert.ok(!(row.k in out), `duplicate catalog key ${row.k}`);
    out[row.k] = row.v;
  }
  const tables=await db.query<{nspname:string;relname:string}>(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','auth') AND c.relkind IN ('r','p') AND c.relname<>'schema_migration_ledger'
      AND c.oid NOT IN (SELECT objid FROM pg_depend WHERE deptype='e' AND classid='pg_class'::regclass) ORDER BY 1,2`);
  const identifier=(value:string)=>'"'+value.replaceAll('"','""')+'"';
  for (const table of tables) {
    const [row] = await db.query<{hash:string}>(`SELECT count(*)::text || ':' || md5(coalesce(string_agg(x::text,'|' ORDER BY x::text),'')) AS hash FROM ${identifier(table.nspname)}.${identifier(table.relname)} x`);
    assert.ok(row); out[`rows:${table.nspname}.${table.relname}`]=row.hash;
  }
  return out;
}
