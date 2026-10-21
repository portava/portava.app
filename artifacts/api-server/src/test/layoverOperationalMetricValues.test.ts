import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeLayoverMetrics, type LayoverMetricInput } from '../services/airport/layoverObservability.js';
const event = (sessionId: string, replanned: number) => ({ sessionId, eventType: 'session_updated', at: '2026-10-19T10:00:00Z', metadata: { replan: { counts: { replanned } } } });
const metric = (name: string, more: Record<string, unknown> = {}) => computeLayoverMetrics({ events: [], decisions: [], replay: null, ...more } as LayoverMetricInput).find(m => m.name === name)!;
describe('measured operational metrics', () => {
 it('deduplicates replanned sessions instead of summing repeated fanout counts or counting user edits', () => {
  const m = metric('replan_rate', { replans: { rows: [event('a', 8),event('a', 8),event('b', 0),{...event('c',0),metadata:{}}], truncated: false } });
  assert.equal(m.status, 'OK'); assert.equal(m.value, 1/3); assert.equal(m.sampleSize,3);
 });
 it('withholds malformed or truncated replan windows rather than undercounting', () => {
  for (const replans of [{rows:[event('a',1)],truncated:true},{rows:[{...event('a',1),metadata:{replan:{counts:{replanned:'1'}}}}],truncated:false}]) assert.equal(metric('replan_rate',{replans}).status,'UNPRODUCIBLE');
 });
 it('counts only observed reentry after start; BOARDED and generic safe are not airport-return proof', () => {
  const safeReturns = { available:true, started: [{sessionId:'a',at:'2026-10-19T10:00:00Z'},{sessionId:'a',at:'2026-10-19T10:01:00Z'},{sessionId:'b',at:'2026-10-19T10:00:00Z'},{sessionId:'c',at:'2026-10-19T10:00:00Z'}], outcomes: [ {sessionId:'a',leftAirport:true,returnedAt:'2026-10-19T10:30:00Z'}, {sessionId:'b',leftAirport:true,returnedAt:null,boardingOutcome:'BOARDED'}, {sessionId:'c',leftAirport:true,returnedAt:'2026-10-19T09:30:00Z'} ], truncated:false };
  const m=metric('safe_return_completion_rate',{safeReturns}); assert.equal(m.value,1/3); assert.equal(m.sampleSize,3);
 });
 it('does not turn unavailable outcomes, a partial cohort or zero starts into a healthy zero', () => {
  for (const safeReturns of [null,{available:false,reason:'layover_outcomes unavailable'},{available:true,started:[],outcomes:[],truncated:false},{available:true,started:[{sessionId:'a',at:'2026-10-19T10:00:00Z'}],outcomes:[],truncated:true}]) assert.equal(metric('safe_return_completion_rate',{safeReturns}).value,null);
 });
});
