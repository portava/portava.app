/** L236/L295 source-enumerated checks on the actual migrated database. These
 * are schema and parse proofs, alongside (not substitutes for) pressed routes. */
import assert from 'node:assert/strict';
import { before,after,describe,it } from 'node:test';
import { generateLayoverQueryInventory } from '../helpers/layoverQueryInventory.js';
import { vocabularyFromCheck } from '../../scripts/lib/canonicalVocabulary.js';
import { openPressedLayoverDb,PRESSED_SKIP_REASON,type PressedDb } from './pressedLayoverDb.js';
const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const lit=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const inventory=generateLayoverQueryInventory();
let db:PressedDb;
describe('source-enumerated Layover queries against actual migrated schema',{skip:PRESSED_SKIP_REASON},()=>{
 before(async()=>{db=await openPressedLayoverDb();});after(async()=>{await db?.close();});
 it('Q1 has no unresolved safety query body and checks every named table, column and function',async()=>{
  assert.ok(inventory.refs.length>1500,'source scan unexpectedly collapsed');assert.deepEqual(inventory.unresolved,[]);
  const columns=await db.query<any>(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'`);
  const tables=new Set(columns.map(c=>c.table_name)),keys=new Set(columns.map(c=>`${c.table_name}.${c.column_name}`));
  const functions=new Set((await db.query<any>(`SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace`)).map(x=>x.proname));
  const misses=inventory.refs.filter(r=>r.kind==='rpc'?!functions.has(r.name):r.kind==='table'?!tables.has(r.name):!keys.has(`${r.table}.${r.name}`));
  assert.deepEqual(misses,[]);
 });
 it('Q2 runs every generated select spelling and join through the service client against that database',async()=>{
  const errors:string[]=[];
  for(const site of inventory.selects)for(const select of site.variants){
   const result=await db.client.from(site.table).select(select).limit(0);
   if(result.error)errors.push(`${site.file}:${site.line} ${site.table} ${select}: ${JSON.stringify(result.error)}`);
  }
  assert.deepEqual(errors,[]);
 });
 it('Q3 parses every resolved write shape on the actual table without inserting synthetic safety data',async()=>{
  const groups=new Map<string,{table:string;method:string;columns:Set<string>}>();
  for(const r of inventory.refs.filter(r=>r.kind==='write'&&r.table)){
   const key=`${r.file}:${r.line}:${r.method}:${r.table}`;const g=groups.get(key)??{table:r.table!,method:r.method,columns:new Set<string>()};g.columns.add(r.name);groups.set(key,g);
  }
  assert.ok(groups.size>50);
  for(const [site,g] of groups){
   const cols=[...g.columns].sort();
   const sql=g.method==='update'?`EXPLAIN UPDATE public.${q(g.table)} SET ${cols.map(c=>`${q(c)}=${q(c)}`).join(',')} WHERE false`:`EXPLAIN INSERT INTO public.${q(g.table)}(${cols.map(q).join(',')}) SELECT ${cols.map(()=> 'NULL').join(',')} WHERE false`;
   try{await db.query(sql);}catch(e){assert.fail(`${site}: ${String(e)}`);}
  }
 });
 it('Q4 compares extracted enum and TEXT+CHECK literals with the database catalogs, not hand-made fixture vocabularies',async()=>{
  const vocabulary=new Map<string,Set<string>>();
  for(const row of await db.query<any>(`SELECT c.relname,a.attname,e.enumlabel FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid JOIN pg_type t ON t.oid=a.atttypid JOIN pg_enum e ON e.enumtypid=t.oid WHERE c.relnamespace='public'::regnamespace`)){
   const key=`${row.relname}.${row.attname}`;const values=vocabulary.get(key)??new Set<string>();values.add(row.enumlabel);vocabulary.set(key,values);
  }
  // A coupled state/result CHECK does not define a column vocabulary on its
  // own. Judge only single-column constraints here; lifecycle tests exercise
  // the coupled conditions with actual rows.
  for(const row of await db.query<any>(`SELECT c.relname,pg_get_expr(k.conbin,k.conrelid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND k.contype='c' AND cardinality(k.conkey)=1`)){
   for(const [column,values] of vocabularyFromCheck(row.definition)){const key=`${row.relname}.${column}`;const old=vocabulary.get(key);vocabulary.set(key,old?new Set([...old].filter(x=>values.has(x))):values);}
  }
  const judged=inventory.literals.filter(s=>vocabulary.has(`${s.table}.${s.column}`));assert.ok(judged.length>40);
  assert.deepEqual(judged.filter(s=>!vocabulary.get(`${s.table}.${s.column}`)!.has(s.literal)),[]);
 });
 it('Q5 every Layover base table is RLS-enabled and authenticated callers cannot invoke internal audit administration',async()=>{
  assert.deepEqual(await db.query(`SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND left(relname,8)='layover_' AND NOT relrowsecurity`),[]);
  for(const fn of ['layover_install_service_write_audit()','layover_expire_service_write_audit(integer)']){
   const permission=await db.query<any>(`SELECT has_function_privilege('authenticated',${lit('public.'+fn)},'EXECUTE') AS allowed`);assert.equal(permission[0].allowed,false,fn);
  }
 });
});
