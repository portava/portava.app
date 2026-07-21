/**
 * ConfidencePill tap-to-explain sheet — component tests (full-data case).
 *
 * Run with: pnpm test:component
 *
 * Verifies (task: explain the confidence pill):
 *  - Tapping the pill opens a sheet with the human label, plain-language copy,
 *    dataNote, and checkedAt time when present.
 *  - Sheet is closable via the "Got it" button.
 *
 * The sparse-confidence case (no dataNote/checkedAt) lives in a sibling file
 * (ConfidencePillSheetSparse) per the renderer press budget — this file's two
 * act-wrapped presses exhaust it (TESTING.md).
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
    confidence: {
      sourceClass: 'historical',
      label: 'Based on historical data',
      checkedAt: '2026-07-20T02:00:00.000Z',
      dataNote: 'Live status can\u2019t be verified right now',
    },
  }],
}] as any;

test('tapping the pill opens the explainer with label, note and checked time; Got it closes it', async () => {
  const view = await render(<CompassChatBlocks blocks={blocks} />);

  // Sheet closed initially
  expect(view.queryByTestId('compass-confidence-p1-sheet')).toBeNull();

  await act(async () => { fireEvent.press(view.getByTestId('compass-confidence-p1')); });

  expect(view.getByTestId('compass-confidence-p1-sheet')).toBeTruthy();
  expect(view.getByText('Based on historical data')).toBeTruthy();
  // Plain-language copy for the historical class
  expect(view.getByText(/based on past records/i)).toBeTruthy();
  expect(view.getByTestId('compass-confidence-p1-sheet-note')).toHaveTextContent(
    'Live status can\u2019t be verified right now',
  );
  expect(view.getByTestId('compass-confidence-p1-sheet-checked')).toHaveTextContent(/^Checked /);

  await act(async () => { fireEvent.press(view.getByTestId('compass-confidence-p1-sheet-close')); });
  expect(view.queryByTestId('compass-confidence-p1-sheet')).toBeNull();
});
