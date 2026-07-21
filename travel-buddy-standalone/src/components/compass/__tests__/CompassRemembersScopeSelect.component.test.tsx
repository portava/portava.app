/**
 * CompassRemembers scope-filter selection — single press scenario, isolated
 * in its own file per the RNTL React-19 renderer budget.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { CompassRemembers } from '../CompassRemembers.tsx';

const noop = () => {};

describe('CompassRemembers — scope select', () => {
  it('tapping a scope tab reports the scope to onScopeChange', async () => {
    const onScopeChange = jest.fn();
    await render(
      <CompassRemembers
        memories={[]}
        scope={null}
        onScopeChange={onScopeChange}
        onTeach={noop} onEdit={noop} onForget={noop}
      />,
    );
    fireEvent.press(screen.getByTestId('scope-filter-circle'));
    expect(onScopeChange).toHaveBeenCalledWith('circle');
  });
});
