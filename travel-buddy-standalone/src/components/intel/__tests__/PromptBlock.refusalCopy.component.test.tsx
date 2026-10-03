/**
 * PromptBlock — a refused Quick Signal says what will fix it.
 *
 * A capture without Intelligence Contributions consent is refused 403
 * `forbidden` / `consent_required` (routes/intel.ts REASON_CODE). The block
 * answered it "Could not send — tap to retry", and every retry was refused the
 * same way. CONTROLLED: the capture service is a double.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — the native haptics module is absent under jest.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Error: 'error', Warning: 'warning' },
}));
const mockSubmit = jest.fn();
// NOTE: intentionally exhaustive — the real service does an authed fetch with a native token store.
jest.mock('../../../services/intelCapture.ts', () => ({
  submitQuickSignal: (...a: unknown[]) => mockSubmit(...a),
  submitWalkIn: jest.fn(),
  submitMusic: jest.fn(),
  makeIdempotencyKey: () => 'k',
}));

import { PromptBlock } from '../PromptBlock.tsx';
import type { PromptQuestion } from '../../../lib/intel/contracts.ts';

const Q: PromptQuestion = { id: 'arrival', topic: 'energy', prompt: 'How is it?', kind: 'context', context: 'arrival', options: ['dead', 'busy'], phase1: true };

beforeEach(() => mockSubmit.mockReset());

it('a consent refusal points to Settings and does not ask for a retry', async () => {
  mockSubmit.mockResolvedValue({ ok: false, code: 'forbidden', error: 'consent_required' });
  const r = await render(<PromptBlock subjectId="p" question={Q} visibility="private" />);
  fireEvent.press(r.getByTestId('intel-q-arrival-busy'));
  await r.findByText(/Turn on Intelligence Contributions/);
  expect(r.queryByText(/retry|try again/i)).toBeNull();
});

it('a transient failure still asks for a retry', async () => {
  mockSubmit.mockResolvedValue({ ok: false, error: 'network_error' });
  const r = await render(<PromptBlock subjectId="p" question={Q} visibility="private" />);
  fireEvent.press(r.getByTestId('intel-q-arrival-busy'));
  await r.findByText(/tap to try again/);
});
