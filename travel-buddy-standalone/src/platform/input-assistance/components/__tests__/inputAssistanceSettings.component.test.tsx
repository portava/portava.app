/**
 * Verifier finding 4: a person who opted in must ALWAYS be able to see that and
 * withdraw. The Settings block is rendered for every signed-in person and each
 * row asks the server — never the client's flag map, which can be empty (the
 * fail-soft fetch) or say "off" after the owner turns a flag off while the
 * person's consent is still on record.
 *
 * MUTATION LOG (applied, watched go red, reverted):
 *   - app/settings/index.tsx: gate the block on isEnabled('input_outcome_learning_enabled')
 *     again → test 2 goes red.
 *   - OutcomeLearningSetting.tsx: hide when `!state.available` alone → test 1 goes red.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stubs — both transports import the Supabase-backed
// token/auth helpers at load; these are their complete export surfaces.
jest.mock('../../services/outcomeLearningTransport.ts', () => ({
  readOutcomeConsent: jest.fn(), writeOutcomeConsent: jest.fn(), postTaskOutcome: jest.fn(), installOutcomeConsentSync: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — see above.
jest.mock('../../services/memoryContextTransport.ts', () => ({
  readMemoryContext: jest.fn(), writeMemoryContextConsent: jest.fn(),
}));

import { InputAssistanceSettings } from '../InputAssistanceSettings.tsx';
import { OUTCOME_DISCLOSURE_VERSION } from '../../services/outcomeLearning.ts';
import { MEMORY_CONTEXT_DISCLOSURE_VERSION } from '../../services/memoryContext.ts';

afterEach(async () => { await cleanup(); });

test('flag turned OFF by the owner, client flag map EMPTY, consent still on record → the switch is shown, ON, and can be withdrawn', async () => {
  // No FeatureFlags provider at all: the client's isEnabled() would answer false
  // for everything. The rows never ask it.
  const outcomeRead = jest.fn().mockResolvedValue({
    status: 'ok',
    state: { available: false, enabled: true, consentVersion: OUTCOME_DISCLOSURE_VERSION, consentedAt: '2026-10-01T00:00:00.000Z', withdrawnAt: null, currentDisclosureVersion: OUTCOME_DISCLOSURE_VERSION, retentionDays: 30 },
  });
  const memoryRead = jest.fn().mockResolvedValue({
    status: 'ok',
    view: { available: false, enabled: false, currentDisclosureVersion: MEMORY_CONTEXT_DISCLOSURE_VERSION, facts: null, factsUnavailable: false },
  });
  const r = await render(
    <InputAssistanceSettings outcome={{ read: outcomeRead, write: jest.fn() }} memory={{ read: memoryRead, write: jest.fn() }} />,
  );
  await waitFor(() => expect(r.getByTestId('outcome-learning-switch').props.value).toBe(true), { timeout: 8000 });
  expect(r.getByTestId('outcome-learning-switch').props.disabled).toBe(false);
  // The memory row is neither offered nor on for this person, so it hides itself.
  expect(r.queryByTestId('memory-context-setting')).toBeNull();
});

test('the Settings screen mounts the block for every signed-in person — not behind the client flag map', () => {
  const src = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'app', 'settings', 'index.tsx'), 'utf8');
  expect(src).toMatch(/\{\(configured && isAuthed\) && <InputAssistanceSettings \/>\}/);
  expect(src).not.toMatch(/isEnabled\('input_outcome_learning_enabled'\)/);
  expect(src).not.toMatch(/isEnabled\('input_memory_context_enabled'\)/);
});
