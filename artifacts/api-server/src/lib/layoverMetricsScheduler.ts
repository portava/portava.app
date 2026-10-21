/** House monitoring for Layover: bounded DB windows, aggregate Pino values,
 * authenticated Prometheus scrape, optional Pushgateway, Sentry target alerts.
 * No identity, coordinate, itinerary or raw decision is exported. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';
import { Sentry } from './sentry.js';
import { getServiceClient } from './supabase.js';
import { readLayoverMetricsReport } from '../services/airport/LayoverMetricsReport.js';
import { createPushgatewaySink, renderPrometheusText, type MetricsSink } from './providers/metricsExporter.js';
import type { LayoverMetricValue } from '../services/airport/layoverObservability.js';

const ALERT_COOLDOWN_MS = 15*60_000;
const lastAlert = new Map<string,number>();
let timer: ReturnType<typeof setTimeout>|null=null;
let generation=0;
let running=false;
const interval = ():number => {
 const v=Number(process.env.LAYOVER_METRICS_INTERVAL_SECONDS);
 return (Number.isFinite(v)&&v>=60&&v<=86400?v:300)*1000;
};
export function layoverMetricAlerts(metrics: readonly LayoverMetricValue[]) {
 return metrics.filter(m=>m.status==='OK' && m.value!==null && Number.isFinite(m.value) && m.target!==null && m.value>m.target);
}

async function runLayoverMetricsTickImpl(options: {
 client?: SupabaseClient|null; nowMs?:number;
 read?: typeof readLayoverMetricsReport;
 sink?: MetricsSink|null;
 capture?: (name:string,detail:Record<string,unknown>)=>void;
}={}) {
 const nowMs=options.nowMs??Date.now();
 const client=options.client===undefined?getServiceClient():options.client;
 const capture=options.capture??((name,detail)=>{Sentry.captureMessage(name,{level:'error',fingerprint:['layover-metrics',String(detail.metric??'collection')],tags:{domain:'layover'},extra:detail});});
 const alert=(metric:string,detail:Record<string,unknown>)=>{
  const previous=lastAlert.get(metric);
  if(previous!==undefined && nowMs-previous<ALERT_COOLDOWN_MS && nowMs>=previous)return;
  lastAlert.set(metric,nowMs);
  logger.error({metric,...detail},'layover operational metric alert');
  capture('Layover operational metric alert',{metric,...detail});
 };
 if(!client){logger.warn({reason:'no_service_client'},'layover metrics collection unavailable');return {ok:false as const,reason:'no_service_client'};}
 try {
  const report=await (options.read??readLayoverMetricsReport)(client,{nowMs,days:7});
  if(!report.ok){alert('collection_failed',{reason:report.message});return {ok:false as const,reason:'collection_failed'};}
  // Values are emitted, not just a count of how many series were rendered.
  logger.info({window:report.window,metrics:report.metrics.map(m=>({name:m.name,value:m.value,status:m.status,sampleSize:m.sampleSize,blockedBy:m.blockedBy}))},'layover operational metrics');
  const alerts=layoverMetricAlerts(report.metrics);
  for(const m of alerts) alert(m.name,{value:m.value,target:m.target,sampleSize:m.sampleSize,windowDays:report.window.days});
  const sink=options.sink===undefined?(process.env.METRICS_PUSHGATEWAY_URL?createPushgatewaySink({job:'portava_layover',replace:true}):null):options.sink;
  let delivery:'not_configured'|'delivered'|'failed'='not_configured';
  if(sink){
   const delivered=await sink.publish(renderPrometheusText(report.metrics,{prefix:'portava_layover_',windowed:true,labels:{window_days:String(report.window.days)}}));
   delivery=delivered.ok?'delivered':'failed';
   if(!delivered.ok)alert('export_failed',{reason:'configured_metrics_sink_refused'});
  }
  return {ok:true as const,alerts:alerts.map(m=>m.name),delivery,alertSink:Sentry.getClient()?'sentry':'log_only',metrics:report.metrics};
 }catch(err){logger.error({err,operation:'runLayoverMetricsTick'},'layover metrics tick failed');alert('collection_threw',{reason:'metrics_read_or_delivery_threw'});return {ok:false as const,reason:'collection_threw'};}
}

export function startLayoverMetricsScheduler():void {
 if(running)return;
 running=true;const current=++generation;
 const tick=async()=>{
  timer=null;
  await runLayoverMetricsTick();
  if(running&&generation===current){timer=setTimeout(()=>{void tick();},interval());timer.unref();}
 };
 timer=setTimeout(()=>{void tick();},120_000);timer.unref();
}
export function stopLayoverMetricsScheduler():void {
 running=false;generation++;if(timer)clearTimeout(timer);timer=null;
}
export function resetLayoverMetricAlertsForTests():void {lastAlert.clear();}

const health={lastAttemptAt:null as string|null,lastSuccessAt:null as string|null,consecutiveFailures:0,detail:'Not yet collected'};
export function getLayoverMetricsStatus(){return {...health,staleAfterMs:Math.max(interval()*3,180_000)};}
export async function runLayoverMetricsTick(options:Parameters<typeof runLayoverMetricsTickImpl>[0]={}) {
 const at=new Date(options.nowMs??Date.now()).toISOString();health.lastAttemptAt=at;
 const result=await runLayoverMetricsTickImpl(options);
 if(result.ok&&result.delivery!=='failed'){health.lastSuccessAt=at;health.consecutiveFailures=0;health.detail=`collection succeeded; metrics delivery ${result.delivery}; alert sink ${result.alertSink}`;}
 else{health.consecutiveFailures++;health.detail=result.ok?'configured metrics delivery failed':result.reason;}
 return result;
}
