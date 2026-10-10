/**
 * census G176 — the row RENDERS the coarse band the server projected, and reads
 * it to a screen reader; an unknown band renders nothing. Real
 * `EntitySuggestionRow`.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - EntitySuggestionRow.tsx: the subtitle line back to `suggestion.subtitle` →
 *     test 1 red (no band on screen).
 *   - EntitySuggestionRow.tsx: the a11y label back to `suggestion.subtitle` →
 *     test 1 red (the band is not announced).
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react-native';
import { EntitySuggestionRow } from '../EntitySuggestionRow.tsx';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const base: InputSuggestion = {
  id: 'p1', type: 'entity', context: 'place_picker', label: 'Lantern Cafe', subtitle: 'Hoi An',
  entityType: 'place', entityId: 'p1', source: 'canonical', policyVersion: 'v',
};

afterEach(async () => { await cleanup(); });

test('G176: a permitted band is shown on the location line and announced', async () => {
  const r = await render(<EntitySuggestionRow suggestion={{ ...base, distanceBand: '<0.5km' }} onPress={() => {}} />);
  expect(r.getByTestId('ia-row-subtitle').props.children).toBe('Hoi An · Under 500 m');
  expect(r.getByTestId('ia-entity-row-p1').props.accessibilityLabel).toContain('Under 500 m');
});

test('G176: an unknown band renders nothing extra', async () => {
  const r = await render(<EntitySuggestionRow suggestion={{ ...base, distanceBand: '0.42 km' }} onPress={() => {}} />);
  expect(r.getByTestId('ia-row-subtitle').props.children).toBe('Hoi An');
  expect(r.getByTestId('ia-entity-row-p1').props.accessibilityLabel).not.toContain('0.42');
});
