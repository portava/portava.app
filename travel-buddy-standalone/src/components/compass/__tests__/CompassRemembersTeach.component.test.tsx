/**
 * CompassRemembers "Teach My Compass" interaction — isolated in its own file
 * so the changeText+press state commit lands on the file's first mounted
 * instance (RNTL React-19 renderer budget).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { CompassRemembers } from '../CompassRemembers.tsx';

const noop = () => {};

describe('CompassRemembers — teach', () => {
  it('submits a trimmed teach statement', async () => {
    const onTeach = jest.fn();
    await render(
      <CompassRemembers memories={[]} onTeach={onTeach} onEdit={noop} onForget={noop} />,
    );
    fireEvent.changeText(screen.getByTestId('teach-input'), '  I love street food  ');
    fireEvent.press(screen.getByTestId('teach-submit'));
    expect(onTeach).toHaveBeenCalledWith('I love street food');
  });
});
