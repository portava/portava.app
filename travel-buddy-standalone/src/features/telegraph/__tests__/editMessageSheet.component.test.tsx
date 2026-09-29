/**
 * WP-08 / TEL-F07 — the edit sheet closes only when the server said yes, and
 * a refusal stays on screen with the text the person typed.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — TESTING.md Rule 6 (Modal replaced by a synchronous View).
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react');
        return ({ children, visible }: any) =>
          visible ? R.createElement(target.View, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

import { EditMessageSheet } from '../messageActions/EditMessageSheet.tsx';

it('Save is not offered for an unchanged or empty body', async () => {
  const onSubmit = jest.fn();
  await render(<EditMessageSheet visible initialBody="meet at 7" onClose={() => {}} onSubmit={onSubmit} />);
  await fireEvent.press(screen.getByTestId('telegraph-edit-save'));
  await fireEvent.changeText(screen.getByTestId('telegraph-edit-input'), '   ');
  await fireEvent.press(screen.getByTestId('telegraph-edit-save'));
  expect(onSubmit).not.toHaveBeenCalled();
});

it('a refused edit stays open with the reason and the typed text', async () => {
  const onClose = jest.fn();
  const onSubmit = jest.fn().mockResolvedValueOnce({ ok: false, message: 'Messages in an end-to-end encrypted conversation cannot be edited.' });
  await render(<EditMessageSheet visible initialBody="meet at 7" onClose={onClose} onSubmit={onSubmit} />);
  await fireEvent.changeText(screen.getByTestId('telegraph-edit-input'), 'meet at 8');
  await fireEvent.press(screen.getByTestId('telegraph-edit-save'));
  await waitFor(() => expect(screen.getByTestId('telegraph-edit-error')).toBeTruthy());
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByTestId('telegraph-edit-input').props.value).toBe('meet at 8');
});

it('an accepted edit sends the trimmed body and closes', async () => {
  const onClose = jest.fn();
  const onSubmit = jest.fn().mockResolvedValueOnce({ ok: true });
  await render(<EditMessageSheet visible initialBody="meet at 7" onClose={onClose} onSubmit={onSubmit} />);
  await fireEvent.changeText(screen.getByTestId('telegraph-edit-input'), '  meet at 8  ');
  await fireEvent.press(screen.getByTestId('telegraph-edit-save'));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onSubmit).toHaveBeenCalledWith('meet at 8');
});
