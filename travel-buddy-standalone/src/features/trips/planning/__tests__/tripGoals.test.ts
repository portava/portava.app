/**
 * tripGoals — the three states of a trip's goals on TripDecisionsCard
 * (census-trips wave-5 follow-up). Pure logic, node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { goalsOf, goalLine, type BoardGoal } from '../tripGoals.ts';

const goal = (over: Partial<BoardGoal> = {}): BoardGoal => ({
  id: 'g1', type: 'rest', priority: 'normal', status: 'open', evidence: {}, scope: 'shared', ...over,
});

test('a list the board did not carry is UNREADABLE, never "no goals"', () => {
  assert.deepEqual(goalsOf({ goals: undefined as never }), { state: 'unreadable' });
  assert.deepEqual(goalsOf({ goals: null as never }), { state: 'unreadable' });
  assert.deepEqual(goalsOf({ goals: {} as never }), { state: 'unreadable' });
  assert.deepEqual(goalsOf(null), { state: 'unreadable' });
});

test('an empty list the board carried is NONE', () => {
  assert.deepEqual(goalsOf({ goals: [] }), { state: 'none' });
});

test('open goals first, then by priority, keeping the server order within a band', () => {
  const r = goalsOf({ goals: [
    goal({ id: 'met-high', priority: 'high', status: 'met' }),
    goal({ id: 'low', priority: 'low' }),
    goal({ id: 'normal-a' }),
    goal({ id: 'high', priority: 'high' }),
    goal({ id: 'normal-b' }),
    goal({ id: 'odd', priority: 'urgent' }),
  ] });
  assert.equal(r.state, 'listed');
  if (r.state !== 'listed') return;
  assert.deepEqual(r.goals.map((g) => g.id), ['high', 'normal-a', 'normal-b', 'low', 'odd', 'met-high']);
  assert.equal(r.unreadable, 0);
});

test('a row that cannot be read is COUNTED, not dropped silently', () => {
  const r = goalsOf({ goals: [goal(), { id: '', type: 'rest' } as never, 7 as never, { id: 'g2', type: 'budget', priority: 'low' } as never] });
  assert.equal(r.state, 'listed');
  if (r.state !== 'listed') return;
  assert.deepEqual(r.goals.map((g) => g.id), ['g1']);
  assert.equal(r.unreadable, 3);
});

test('a goal in words: type, priority, whose, and a status other than open', () => {
  assert.equal(goalLine(goal()), 'Rest · normal priority');
  assert.equal(goalLine(goal({ type: 'safety', priority: 'high', scope: 'personal' })), 'Safety · high priority · just you');
  assert.equal(goalLine(goal({ status: 'met' })), 'Rest · normal priority · met');
  assert.equal(goalLine(goal({ status: 'abandoned', scope: undefined })), 'Rest · normal priority · abandoned');
});

test('an unknown value passes through rather than being dropped or mapped to a neighbour', () => {
  assert.equal(goalLine(goal({ type: 'wellbeing', priority: 'urgent', status: 'paused' })), 'wellbeing · urgent · paused');
});
