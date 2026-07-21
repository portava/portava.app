/**
 * ConfidencePill on an EVENT card — pill press must open the sheet WITHOUT
 * triggering the parent card's tap navigation (router.push to /event/[id]).
 *
 * Run with: pnpm test:component
 *
 * Sibling to ConfidencePillSheet.component.test.tsx per the renderer press
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

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));

afterEach(cleanup);

const blocks: CompassUiBlock[] = [{
  type: 'event_cards',
  events: [{
    id: 'e1', title: 'Night Market Crawl', city: 'Cebu',
    startsAt: '2026-07-25T10:00:00.000Z', description: null,
    confidence: {
      sourceClass: 'community_reported',
      label: 'Reported by the community',
      checkedAt: null,
      dataNote: null,
    },
  }],
}] as any;

test('tapping the event confidence pill opens the sheet and does NOT navigate to the event', async () => {
  const view = await render(<CompassChatBlocks blocks={blocks} />);

  expect(view.queryByTestId('compass-confidence-e1-sheet')).toBeNull();

  await act(async () => { fireEvent.press(view.getByTestId('compass-confidence-e1')); });

  // Sheet opened…
  expect(view.getByTestId('compass-confidence-e1-sheet')).toBeTruthy();
  expect(view.getByText('Reported by the community')).toBeTruthy();
  // …and the card's own navigation did not fire.
  expect(mockPush).not.toHaveBeenCalled();
});
