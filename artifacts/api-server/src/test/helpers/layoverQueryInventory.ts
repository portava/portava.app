/** Generated source coverage. Unresolved sites stay visible and fail the guard;
 * catalog/EXPLAIN coverage is explicitly distinct from an executed route proof. */
import { join } from 'node:path';
import { scanSchemaReferences } from './schemaColumnScan.js';
import { API_ROOT,SRC,scanSelectEmbeds } from './selectEmbedScan.js';
import { extractFilterLiterals } from '../../scripts/lib/filterLiteralExtract.js';
import { extractWriteLiterals } from '../../scripts/lib/writeLiteralExtract.js';
export const isLayoverQueryFile=(file:string)=>/^src\/(?:services\/(?:airport|layover)\/|lib\/layover|routes\/(?:airport|layover|adminLayover))/.test(file);
export function generateLayoverQueryInventory(){
 const scan=scanSchemaReferences(),embeds=scanSelectEmbeds();
 const dirs=['routes','services','lib'].map(d=>join(API_ROOT,'src',d));
 return {
  version:1,
  scope:'All resolved production PostgREST sites in services/airport, services/layover, lib/layover*, and routes/airport*, layover*, adminLayover*. Scanner limitations remain explicit; generated catalog/EXPLAIN checks do not claim arbitrary payload or route execution.',
  refs:scan.refs.filter(r=>isLayoverQueryFile(r.file)),
  selects:embeds.selectSites.filter(r=>isLayoverQueryFile(r.file)),
  unresolved:scan.unresolved.filter(r=>isLayoverQueryFile(r.file)),
  literals:[...extractFilterLiterals(dirs,API_ROOT).sites,...extractWriteLiterals(dirs,API_ROOT).sites].filter(r=>isLayoverQueryFile(r.file)),
  routes:generateLayoverRouteInventory(),
 };
}

import ts from 'typescript';
import { productionSources,unwrap } from './selectEmbedScan.js';
import { relative } from 'node:path';
export function generateLayoverRouteInventory(root=SRC){
 const routes:Array<{file:string;line:number;method:string;path:string;authorization:string[];audit:string}>=[];
 for(const sf of productionSources(root)){
  const file='src/'+relative(root,sf.fileName).split('\\').join('/');
  if(!/^src\/routes\/(?:airport|layover|adminLayover)/.test(file))continue;
  const functions=new Map<string,ts.FunctionDeclaration>();
  const collect=(n:ts.Node)=>{if(ts.isFunctionDeclaration(n)&&n.name)functions.set(n.name.text,n);ts.forEachChild(n,collect);};collect(sf);
  const firstGuard=(body:ts.ConciseBody|undefined,seen=new Set<string>()):string[]=>{
   if(!body||!ts.isBlock(body))return [];
   const statement=body.statements[0];if(!statement)return [];
   let initializer:ts.Expression|undefined;
   if(ts.isVariableStatement(statement))initializer=statement.declarationList.declarations[0]?.initializer;
   if(ts.isExpressionStatement(statement))initializer=statement.expression;
   if(!initializer)return [];let call=unwrap(initializer);while(ts.isAwaitExpression(call))call=unwrap(call.expression);if(!ts.isCallExpression(call)||!ts.isIdentifier(call.expression))return [];
   const name=call.expression.text;
   if(ts.isVariableStatement(statement)){
    const binding=statement.declarationList.declarations[0]?.name;const refusal=body.statements[1];
    if(!binding||!ts.isIdentifier(binding)||!refusal||!ts.isIfStatement(refusal)||refusal.expression.getText(sf).replace(/\s/g,'')!==`!${binding.text}`)return [];
    const branch=refusal.thenStatement;if(!(ts.isReturnStatement(branch)||(ts.isBlock(branch)&&branch.statements.some(s=>ts.isReturnStatement(s)))))return [];
   }
   if(['requireUser','requireAdmin'].includes(name))return [name];if(seen.has(name))return [];seen.add(name);
   const nested=firstGuard(functions.get(name)?.body,seen);return nested.length?[name,...nested]:[];
  };
  const visit=(n:ts.Node)=>{
   if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.getText(sf)==='router'&&['get','post','put','patch','delete'].includes(n.expression.name.text)&&n.arguments[0]&&ts.isStringLiteralLike(n.arguments[0])){
    let body:ts.ConciseBody|undefined;
    const find=(x:ts.Node)=>{if(ts.isArrowFunction(x)||ts.isFunctionExpression(x)){body=x.body;return;}ts.forEachChild(x,find);};
    const factory=(expression:ts.Expression,seen=new Set<string>())=>{
     const call=unwrap(expression);if(!ts.isCallExpression(call)||!ts.isIdentifier(call.expression))return;
     const name=call.expression.text;if(seen.has(name))return;seen.add(name);
     const declared=functions.get(name),statements=declared?.body?.statements,statement=statements?.[0];
     // Resolve only a pure factory consisting of one returned handler. Any
     // preceding write/effect remains unclassified and fails the guard.
     if(statements?.length!==1||!statement||!ts.isReturnStatement(statement)||!statement.expression)return;
     const returned=statement.expression;find(returned);if(!body)factory(returned,seen);
    };
    for(const arg of n.arguments.slice(1)){find(arg);if(!body)factory(arg);}
    const authorization=firstGuard(body);
    if(file==='src/routes/layoverEvents.ts'&&body&&/if\s*\(!safeSecretEquals\(req\.get\(PRODUCER_SECRET_HEADER\), expected\)\)\s*\{[\s\S]*?return;\s*\}/.test(body.getText(sf)))authorization.push('safeSecretEquals(PRODUCER_SECRET_HEADER) with refusal return');
    routes.push({file,line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,method:n.expression.name.text.toUpperCase(),path:n.arguments[0].text,authorization,audit:'3890 atomic protected-table trigger; verified request actor from global HTTP middleware, explicit system identity for the credentialed event producer'});
   }
   ts.forEachChild(n,visit);
  };visit(sf);
 }
 return routes;
}
