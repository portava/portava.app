/**
 * OD-INPUT-1's opt-in, driven as a person would: the REAL component, with the
 * server's answers injected through its `read` / `write` props.
 *
 * Asserted: an outage is never shown as "off"; turning the switch on grants
 * NOTHING until the disclosure is read and "Allow" is pressed; "Not now" sends
 * nothing; a grant opens the device gate for the current account; withdrawal is
 * one tap and says whether what was kept is gone now or will expire.
 *
 * Harness fact (inputTelemetryFunnel.component.test.tsx): at most four mounts
 * per file under React 19 + RNTL 14, so each test mounts once.
 *
 * MUTATION LOG (each applied, watched go red, reverted):
 *   - OutcomeLearningSetting.tsx: call `commit(true)` straight from the switch
 *     (skip the disclosure) → test 2 goes red.
 *   - OutcomeLearningSetting.tsx: render an unreadable read as the ready state
 *     with enabled:false → test 1 goes red.
 *   - OutcomeLearningSetting.tsx: drop the countersErased === false branch →
 *     test 3 goes red.
 */
import React from 'react';
import { cleanup, fireEvent, render, waitFor, act } from '@testing-library/react-native';

// The component's own `read`/`write` props carry every answer in these tests.
// NOTE: exhaustive-by-design stub — the transport imports the Supabase-backed
// token + auth helpers at load (no native module under jest), so requireActual
// cannot be spread; these four are its complete export surface.
jest.mock('../../services/outcomeLearningTransport.ts', () => ({
  readOutcomeConsent: jest.fn(),
  writeOutcomeConsent: jest.fn(),
  postTaskOutcome: jest.fn(),
  installOutcomeConsentSync: jest.fn(),
}));

import { OutcomeLearningSetting } from '../OutcomeLearningSetting.tsx';
import {
  OUTCOME_DISCLOSURE_BODY,
  OUTCOME_DISCLOSURE_VERSION,
  beginOutcomeAccount,
  outcomeLearningConsented,
  type OutcomeConsentState,
} from '../../services/outcomeLearning.ts';

const OFF: OutcomeConsentState = {
  available: true, enabled: false, consentVersion: null, consentedAt: null, withdrawnAt: null,
  currentDisclosureVersion: OUTCOME_DISCLOSURE_VERSION, retentionDays: 30,
};
const ON: OutcomeConsentState = { ...OFF, enabled: true, consentVersion: OUTCOME_DISCLOSURE_VERSION, consentedAt: '2026-10-05T00:00:00.000Z' };

afterEach(async () => {
  await cleanup();
  beginOutcomeAccount(null);
});

test('an UNREADABLE setting is shown as unreadable with a retry — never as a switch that is off', async () => {
  const read = jest.fn().mockResolvedValueOnce({ status: 'unreadable' }).mockResolvedValueOnce({ status: 'ok', state: OFF });
  const write = jest.fn();
  const r = await render(<OutcomeLearningSetting read={read} write={write} />);
  await waitFor(() => expect(r.getByTestId('outcome-learning-unreadable')).toBeTruthy(), { timeout: 8000 });
  expect(r.queryByTestId('outcome-learning-switch')).toBeNull();
  await act(async () => { fireEvent.press(r.getByTestId('outcome-learning-retry')); });
  await waitFor(() => expect(r.getByTestId('outcome-learning-switch')).toBeTruthy());
  expect(r.getByTestId('outcome-learning-switch').props.value).toBe(false);
  expect(write).not.toHaveBeenCalled();
});

test('switching ON grants nothing until the disclosure is read and Allow is pressed; Not now sends nothing', async () => {
  beginOutcomeAccount('u1');
  const read = jest.fn().mockResolvedValue({ status: 'ok', state: OFF });
  const write = jest.fn().mockResolvedValue({ status: 'ok', state: ON, countersErased: null });
  const r = await render(<OutcomeLearningSetting read={read} write={write} />);
  await waitFor(() => expect(r.getByTestId('outcome-learning-switch')).toBeTruthy());

  await act(async () => { fireEvent(r.getByTestId('outcome-learning-switch'), 'valueChange', true); });
  expect(r.getByTestId('outcome-learning-disclosure')).toBeTruthy();
  expect(r.getByText(OUTCOME_DISCLOSURE_BODY)).toBeTruthy();
  expect(write).not.toHaveBeenCalled();

  await act(async () => { fireEvent.press(r.getByTestId('outcome-learning-decline')); });
  expect(r.queryByTestId('outcome-learning-disclosure')).toBeNull();
  expect(write).not.toHaveBeenCalled();
  expect(outcomeLearningConsented()).toBe(false);

  await act(async () => { fireEvent(r.getByTestId('outcome-learning-switch'), 'valueChange', true); });
  await act(async () => { fireEvent.press(r.getByTestId('outcome-learning-allow')); });
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(true);
  await waitFor(() => expect(r.getByTestId('outcome-learning-switch').props.value).toBe(true));
  expect(outcomeLearningConsented()).toBe(true);
});

test('withdrawal is one tap, closes the gate, and says when what was kept goes', async () => {
  beginOutcomeAccount('u1');
  const read = jest.fn().mockResolvedValue({ status: 'ok', state: ON });
  const write = jest.fn().mockResolvedValue({ status: 'ok', state: { ...ON, enabled: false, withdrawnAt: '2026-10-05T01:00:00.000Z' }, countersErased: false });
  const r = await render(<OutcomeLearningSetting read={read} write={write} />);
  await waitFor(() => expect(r.getByTestId('outcome-learning-switch').props.value).toBe(true), { timeout: 8000 });
  expect(outcomeLearningConsented()).toBe(true);

  await act(async () => { fireEvent(r.getByTestId('outcome-learning-switch'), 'valueChange', false); });
  expect(write).toHaveBeenCalledWith(false);
  await waitFor(() => expect(r.getByTestId('outcome-learning-note')).toBeTruthy());
  expect(r.getByTestId('outcome-learning-note').props.children).toMatch(/within 30 days/);
  expect(outcomeLearningConsented()).toBe(false);
  expect(r.queryByTestId('outcome-learning-disclosure')).toBeNull();
});
