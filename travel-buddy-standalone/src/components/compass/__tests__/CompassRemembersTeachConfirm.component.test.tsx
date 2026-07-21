/**
 * CompassRemembers teach confirmation — prop-driven rendering, isolated in
 * its own file per the RNTL React-19 renderer budget.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { CompassRemembers } from '../CompassRemembers.tsx';

const noop = () => {};

describe('CompassRemembers — teach confirmation', () => {
  it('shows the confirmation message when provided', async () => {
    await render(
      <CompassRemembers
        memories={[]}
        teachConfirmation="Remembered for Lisbon Crew"
        onTeach={noop} onEdit={noop} onForget={noop}
      />,
    );
    expect(screen.getByTestId('teach-confirmation')).toBeTruthy();
    expect(screen.getByText('Remembered for Lisbon Crew')).toBeTruthy();
  });

  it('renders no confirmation row when the prop is null', async () => {
    await render(
      <CompassRemembers
        memories={[]}
        teachConfirmation={null}
        onTeach={noop} onEdit={noop} onForget={noop}
      />,
    );
    expect(screen.queryByTestId('teach-confirmation')).toBeNull();
  });
});
