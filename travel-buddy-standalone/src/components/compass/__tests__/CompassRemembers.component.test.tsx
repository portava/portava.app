/**
 * CompassRemembers component test — Phase 6.
 *
 * Keeps presses minimal per the RNTL React-19 renderer budget: one press
 * commit per test, prop-capture via callbacks.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { CompassRemembers } from '../CompassRemembers.tsx';
import type { CompassMemory } from '../../../services/compass.ts';

const MEM: CompassMemory = {
  id: 'mem-1',
  userId: 'u1',
  scope: 'long_term',
  circleOwnerId: null,
  tripId: null,
  conversationId: null,
  category: 'food',
  content: 'Prefers vegetarian food',
  source: 'taught',
  confidence: 1,
  createdAt: '2026-07-20T00:00:00Z',
  updatedAt: '2026-07-20T00:00:00Z',
};

const noop = () => {};

describe('CompassRemembers', () => {
  it('renders memories with scope, category, and source labels', async () => {
    await render(
      <CompassRemembers memories={[MEM]} onTeach={noop} onEdit={noop} onForget={noop} />,
    );
    expect(screen.getByText('Prefers vegetarian food')).toBeTruthy();
    expect(screen.getByText('LONG-TERM PREFERENCE · FOOD')).toBeTruthy();
    expect(screen.getByText('You taught this')).toBeTruthy();
    expect(screen.getByText('Compass Remembers')).toBeTruthy();
    expect(screen.getByText('Teach My Compass')).toBeTruthy();
  });

  it('shows the empty state when nothing is remembered', async () => {
    await render(
      <CompassRemembers memories={[]} onTeach={noop} onEdit={noop} onForget={noop} />,
    );
    expect(screen.getByTestId('memories-empty')).toBeTruthy();
  });

  it('forget button reports the memory id', async () => {
    const onForget = jest.fn();
    await render(
      <CompassRemembers memories={[MEM]} onTeach={noop} onEdit={noop} onForget={onForget} />,
    );
    fireEvent.press(screen.getByTestId('memory-forget-mem-1'));
    expect(onForget).toHaveBeenCalledWith('mem-1');
  });
});
