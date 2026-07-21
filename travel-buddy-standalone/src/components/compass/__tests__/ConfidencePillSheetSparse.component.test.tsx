/**
 * ConfidencePill tap-to-explain sheet — sparse-confidence case.
 *
 * Run with: pnpm test:component
 *
 * Verifies the sheet omits the dataNote and checkedAt rows when the server
 * payload doesn't include them, and shows the verified_live copy. Sibling of
 * ConfidencePillSheet.component.test.tsx — split per the renderer press
 * budget (TESTING.md).
 */
import React from 'react';
import { render, fireEvent, act, cleanup } from '@testing-library/react-native';
import { CompassChatBlocks } from '../CompassChatBlocks.tsx';
import type { CompassUiBlock } from '../../../services/compass.ts';

// NOTE: Proxy over requireActual — Modal's animation lifecycle corrupts act()
// scopes in RNTL, so it is replaced with a synchronous View (see TESTING.md).
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: any) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

afterEach(cleanup);

const blocks: CompassUiBlock[] = [{
  type: 'place_cards',
  places: [{
    id: 'p1', name: 'Cafe Uno', category: 'food', city: 'Cebu',
    neighborhood: null, rating: null, blurb: null, verified: true,
    lat: 10.3, lng: 123.9,
    confidence: { sourceClass: 'verified_live', label: 'Verified live' },
  }],
}] as any;

test('sparse confidence opens the sheet with live copy and no note/checked rows', async () => {
  const view = await render(<CompassChatBlocks blocks={blocks} />);

  await act(async () => { fireEvent.press(view.getByTestId('compass-confidence-p1')); });

  expect(view.getByTestId('compass-confidence-p1-sheet')).toBeTruthy();
  expect(view.getByText('Verified live')).toBeTruthy();
  expect(view.getByText(/checked against a live source/i)).toBeTruthy();
  expect(view.queryByTestId('compass-confidence-p1-sheet-note')).toBeNull();
  expect(view.queryByTestId('compass-confidence-p1-sheet-checked')).toBeNull();
});
