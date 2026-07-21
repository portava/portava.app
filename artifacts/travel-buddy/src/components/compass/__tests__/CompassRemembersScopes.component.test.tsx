/**
 * CompassRemembers scope labels & circle names — query-only scenarios.
 * (Press scenarios live in sibling files per the RNTL React-19 renderer budget.)
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { CompassRemembers } from '../CompassRemembers.tsx';
import type { CompassMemory } from '../../../services/compass.ts';

const CIRCLE_MEM: CompassMemory = {
  id: 'mem-c1',
  userId: 'u1',
  scope: 'circle',
  circleOwnerId: 'owner-1',
  tripId: null,
  conversationId: null,
  category: 'general',
  content: 'The group prefers street food',
  source: 'taught',
  confidence: 1,
  createdAt: '2026-07-20T00:00:00Z',
  updatedAt: '2026-07-20T00:00:00Z',
};

const CIRCLES = [{ ownerId: 'owner-1', name: 'Lisbon Crew' }];
const noop = () => {};

describe('CompassRemembers — scopes & circle names', () => {
  it('renders scope filter tabs when onScopeChange is provided', async () => {
    const view = await render(
      <CompassRemembers
        memories={[CIRCLE_MEM]}
        scope={null}
        onScopeChange={noop}
        onTeach={noop} onEdit={noop} onForget={noop}
      />,
    );
    expect(view.getByTestId('scope-filter-all')).toBeTruthy();
    expect(view.getByTestId('scope-filter-long_term')).toBeTruthy();
    expect(view.getByTestId('scope-filter-trip')).toBeTruthy();
    expect(view.getByTestId('scope-filter-circle')).toBeTruthy();
  });

  it('shows the circle display name on circle memories, not the raw owner id', async () => {
    const view = await render(
      <CompassRemembers
        memories={[CIRCLE_MEM]}
        circles={CIRCLES}
        onTeach={noop} onEdit={noop} onForget={noop}
      />,
    );
    expect(view.getByText('CIRCLE · LISBON CREW')).toBeTruthy();
    expect(view.queryByText(/OWNER-1/)).toBeNull();
  });

  it('falls back to the generic circle label when the circle is unknown', async () => {
    const view = await render(
      <CompassRemembers
        memories={[CIRCLE_MEM]}
        circles={[]}
        onTeach={noop} onEdit={noop} onForget={noop}
      />,
    );
    expect(view.getByText('CIRCLE MEMORY')).toBeTruthy();
  });

  it('shows teach target chips when circles are provided', async () => {
    const view = await render(
      <CompassRemembers
        memories={[]}
        circles={CIRCLES}
        onTeach={noop} onEdit={noop} onForget={noop}
      />,
    );
    expect(view.getByTestId('teach-target-me')).toBeTruthy();
    expect(view.getByTestId('teach-target-owner-1')).toBeTruthy();
  });
});
