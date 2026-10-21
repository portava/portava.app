/** Verified request identity for atomic Layover service-write auditing.
 * Incoming HTTP audit headers are never consulted. PostgREST receives only
 * identity set after requireUser, or an explicit internal worker scope. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request,Response,NextFunction } from 'express';
import { logger } from './logger.js';
interface Scope { requestId:string; actor:string|null; system:string|null; route:()=>string }
const scopes=new AsyncLocalStorage<Scope>();
const originalClients=new WeakMap<object,object>();
const proxies=new WeakMap<object,object>();
export function layoverServiceAuditContext(req:Request,_res:Response,next:NextFunction):void {
 scopes.run({requestId:randomUUID(),actor:null,system:null,route:()=>`${req.method} ${req.baseUrl??''}${String(req.route?.path??req.path).split('?')[0]}`.slice(0,240)},next);
}
export function setLayoverAuditActor(userId:string):void {
 const scope=scopes.getStore();if(!scope)return;
 if(scope.actor!==null&&scope.actor!==userId)throw new Error('Layover audit identity changed within a verified request');
 scope.actor=userId;
}
export function withLayoverSystemAudit<T>(name:string,work:()=>T):T {
 if(!/^[a-z][a-z0-9_:-]{2,100}$/.test(name))throw new Error('Invalid internal audit scope');
 return scopes.run({requestId:randomUUID(),actor:null,system:name,route:()=>`SYSTEM ${name}`},work);
}
export function originalLayoverAuditClient<T>(client:T):T {
 return (client&&typeof client==='object'?originalClients.get(client)??client:client) as T;
}
export function auditedLayoverClient<T>(client:T):T {
 if(!client||typeof client!=='object'||!scopes.getStore())return client;
 if(originalClients.has(client))return client;
 const existing=proxies.get(client);if(existing)return existing as T;
 const wrapBuilder=(builder:any,table:string,operation='read'):any=>{
  if(!builder||typeof builder!=='object')return builder;
  return new Proxy(builder,{get(target,key){
   const member=Reflect.get(target,key,target);
   if(typeof member!=='function')return member;
   if(key==='then')return (resolve:any,reject:any)=>{
    const scope=scopes.getStore();
    if(typeof target.setHeader==='function'){
     // PostgREST builders are reusable. Credentials from a previous execution
     // must not outlive the verified request or worker that supplied them.
     target.setHeader('x-portava-layover-actor',scope?.actor??'');
     target.setHeader('x-portava-layover-system',scope?.system??'');
     target.setHeader('x-portava-layover-route',scope?.route()??'');
     target.setHeader('x-portava-layover-request',scope?.requestId??'');
    }
    const noteFailure=(code:string)=>{if(scope&&operation!=='read')logger.error({actorUserId:scope.actor,system:scope.system,route:scope.route(),requestId:scope.requestId,table,operation,outcome:'failed',code},'layover service mutation failed');};
    return member.call(target,(result:any)=>{if(result?.error)noteFailure(String(result.error.code??'database_error'));return resolve?resolve(result):result;},(err:unknown)=>{noteFailure('transport_threw');if(reject)return reject(err);throw err;});
   };
   return (...args:unknown[])=>wrapBuilder(member.apply(target,args),table,['insert','update','upsert','delete'].includes(String(key))?String(key):operation);
  }});
 };
 const proxy=new Proxy(client,{get(target,key){
  const member=Reflect.get(target,key,target);
  if((key==='from'||key==='rpc')&&typeof member==='function')return (...args:unknown[])=>wrapBuilder(member.apply(target,args),String(args[0]),key==='rpc'?'rpc':'read');
  return typeof member==='function'?member.bind(target):member;
 }});
 originalClients.set(proxy,client);proxies.set(client,proxy);return proxy;
}

/** The migration's flag ROW is a schema sentinel. Even a disabled flag must
 * continue expiring records left by an earlier activation. */
export async function expireLayoverServiceAudit(db:any,now=new Date()):Promise<LayoverServiceAuditExpiry> {
 if(!db)return {outcome:'failed',deleted:0,complete:false,batches:0,oldestExpiredAt:null};
 try {
  const sentinel=await db.from('feature_flags').select('flag').eq('flag','layover_service_write_audit_enabled').maybeSingle();
  if(sentinel.error)throw new Error('audit retention schema sentinel unreadable');
  if(sentinel.data===null)return {outcome:'schema_absent',deleted:0,complete:true,batches:0,oldestExpiredAt:null};
  if(sentinel.data?.flag!=='layover_service_write_audit_enabled')throw new Error('audit retention schema sentinel malformed');
  return await catchUpLayoverServiceAudit(db,now);
  // The bounded worker reports remaining due evidence explicitly.
  // A full page or SKIP LOCKED result cannot prove the backlog is empty.
  // Disabled auditing still runs this retention phase after schema installation.
 }catch(err){logger.error({err},'layover service audit retention failed');return {outcome:'failed',deleted:0,complete:false,batches:0,oldestExpiredAt:null};}
}

export interface LayoverServiceAuditExpiry {outcome:'expired'|'schema_absent'|'failed';deleted:number;complete:boolean;batches:number;oldestExpiredAt:string|null}
export const LAYOVER_SERVICE_AUDIT_EXPIRY_BATCHES=10;
/** At most 5,000 expired rows per pass. Backlog/lock contention gets a short
 * scheduler retry; the deadline is a deletion target, not an outage-proof SLA. */
async function catchUpLayoverServiceAudit(db:any,now:Date):Promise<LayoverServiceAuditExpiry> {
 let deleted=0,batches=0;
 try {
  for(;batches<LAYOVER_SERVICE_AUDIT_EXPIRY_BATCHES;){
   const result=await db.rpc('layover_expire_service_write_audit',{p_limit:500});
   if(result.error||!Number.isInteger(result.data)||result.data<0||result.data>500)throw new Error('audit retention RPC failed or returned an invalid count');
   batches+=1;deleted+=result.data;if(result.data<500)break;
  }
  const remaining=await db.from('layover_service_write_audit').select('retain_until').lte('retain_until',now.toISOString()).order('retain_until',{ascending:true}).limit(1);
  if(remaining.error||!Array.isArray(remaining.data)||remaining.data.length>1)throw new Error('audit retention backlog probe failed');
  const oldestExpiredAt=remaining.data.length?remaining.data[0]?.retain_until:null;
  if(oldestExpiredAt!==null&&(typeof oldestExpiredAt!=='string'||!Number.isFinite(Date.parse(oldestExpiredAt))||Date.parse(oldestExpiredAt)>now.getTime()))throw new Error('audit retention backlog probe malformed');
  const report:LayoverServiceAuditExpiry={outcome:'expired',deleted,complete:oldestExpiredAt===null,batches,oldestExpiredAt};
  logger.info(report,'layover service audit retention');return report;
 }catch(err){logger.error({err,deleted,batches},'layover service audit retention failed');return {outcome:'failed',deleted,complete:false,batches,oldestExpiredAt:null};}
}
