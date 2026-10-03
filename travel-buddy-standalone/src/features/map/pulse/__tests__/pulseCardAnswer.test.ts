/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's B31): what the NOW map's Live Pulse card
 * keeps from a GET /pulse/live answer (pulseCardAnswer).
 *
 *   PA0 CONTROL: a whole answer → its items, nothing unread
 *   PA1 an answer naming `safe_return_sessions` → its items, and the name kept for the card to say
 *   PA2 a failed read → NO items (never the previous camera's), and `live_pulse` unread
 *   PA3 no answer at all (the call threw) → the same as PA2
 *   PA4 an answer whose failedSources is not a list → nothing unread (the service already normalises it)
 *   PU0–PU2 pulseUnreadText: what the card says for each
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pulseCardAnswer, pulseUnreadText } from '../pulseCardAnswer.ts';

const ITEM = { id: 'event:e1' } as any;
describe('census-discovery §119 (B31): pulseCardAnswer', () => {
  it('PA0 CONTROL: a whole answer → its items, nothing unread', () => {
    assert.deepEqual(pulseCardAnswer({ ok: true, items: [ITEM], sessionId: 's', failedSources: [] }), { items: [ITEM], unread: [] });
  });
  it('PA1 safe_return_sessions named → the items, and the name kept', () => {
    assert.deepEqual(pulseCardAnswer({ ok: true, items: [ITEM], sessionId: 's', failedSources: ['safe_return_sessions'] }), { items: [ITEM], unread: ['safe_return_sessions'] });
  });
  it('PA2 a failed read → no items, live_pulse unread', () => {
    assert.deepEqual(pulseCardAnswer({ ok: false, error: 'HTTP 503' }), { items: [], unread: ['live_pulse'] });
  });
  it('PA3 no answer (the call threw) → no items, live_pulse unread', () => {
    assert.deepEqual(pulseCardAnswer(null), { items: [], unread: ['live_pulse'] });
  });
  it('PA4 failedSources not a list → nothing unread', () => {
    assert.deepEqual(pulseCardAnswer({ ok: true, items: [ITEM], sessionId: null, failedSources: undefined as any }), { items: [ITEM], unread: [] });
  });
  it('PU0–PU2 pulseUnreadText', () => {
    assert.equal(pulseUnreadText([]), null);
    assert.equal(pulseUnreadText(['live_pulse']), "Couldn't load live updates here");
    assert.equal(pulseUnreadText(['circle_presence', 'safe_return_sessions']), "Couldn't check your Safe Return sessions");
    assert.equal(pulseUnreadText(['circle_presence']), "Some live updates couldn't be loaded");
  });
});
