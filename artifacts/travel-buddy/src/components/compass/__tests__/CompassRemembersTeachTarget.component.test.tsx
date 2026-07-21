/**
 * CompassRemembers circle-targeted teach — single press scenario, isolated
 * in its own file per the RNTL React-19 renderer budget.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { CompassRemembers } from '../CompassRemembers.tsx';

const CIRCLES = [{ ownerId: 'owner-1', name: 'Lisbon Crew' }];
const noop = () => {};

describe('CompassRemembers — teach circle target', () => {
  it('teaching after selecting a circle passes its owner id to onTeach', async () => {
    const onTeach = jest.fn();
    await render(
      <CompassRemembers
        memories={[]}
        circles={CIRCLES}
        onTeach={onTeach} onEdit={noop} onForget={noop}
      />,
    );
    fireEvent.press(screen.getByTestId('teach-target-owner-1'));
    fireEvent.changeText(screen.getByTestId('teach-input'), 'We love markets');
    fireEvent(screen.getByTestId('teach-input'), 'submitEditing');
    expect(onTeach).toHaveBeenCalledWith('We love markets', 'owner-1');
  });
});
