import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition } from '../services/airport/LayoverLifecycle.js';

test('an airside executable contract can be selected without asserting entry permission', () => {
  const chosen = transition('AIRPORT_ONLY', 'PLAN_CHOSEN', { executablePlanReady: true, planInsideAirport: true });
  assert.ok(chosen.ok); assert.equal(chosen.to, 'PLAN_SELECTED');
  assert.equal(transition('AIRPORT_ONLY', 'PLAN_CHOSEN', { executablePlanReady: true }).ok, false);
  assert.equal(transition('AIRPORT_ONLY', 'PLAN_CHOSEN', { planInsideAirport: true }).ok, false);
});
test('starting a selected plan requires a fresh executable contract and keeps landside guards', () => {
  assert.equal(transition('PLAN_SELECTED', 'EXPERIENCE_STARTED', {}).ok, false);
  assert.equal(transition('PLAN_SELECTED', 'EXPERIENCE_STARTED', { executablePlanReady: true }).ok, false);
  const airside = transition('PLAN_SELECTED', 'EXPERIENCE_STARTED', { executablePlanReady: true, planInsideAirport: true });
  assert.ok(airside.ok); assert.equal(airside.to, 'EXECUTING');
  const landside = { executablePlanReady: true, planInsideAirport: false, entryPermissionState: 'CONFIRMED_ALLOWED' as const, criticalUnknowns: [], usableMinutes: 180, returnContractSatisfiable: true };
  assert.equal(transition('PLAN_SELECTED', 'EXPERIENCE_STARTED', landside).ok, true);
  assert.equal(transition('PLAN_SELECTED', 'EXPERIENCE_STARTED', { ...landside, entryPermissionState: 'UNKNOWN' }).ok, false);
  assert.equal(transition('AIRPORT_ONLY', 'EXPERIENCE_STARTED', landside).ok, false);
});
