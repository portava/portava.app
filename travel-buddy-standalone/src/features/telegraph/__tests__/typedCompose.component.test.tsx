/**
 * Telegraph §4.3 at the point of authorship — the location and Memory Note
 * compose sheets.
 *
 *   §4.3  "Use approximate proximity or controlled distance buckets by
 *          default."
 *   §6.1  Location and Memory Note are two of the + menu's eight entries.
 *   §6.2  they produce LOCATION and MEMORY_NOTE messages.
 *
 * The sheet opens on "Approximate area". Choosing "Exact" is a deliberate
 * second tap, and nothing in this sheet reads the device GPS — the label is
 * what the sender types, so an exact coordinate cannot enter a thread through
 * this surface at all.
 *
 * MODAL RULE 6 (src/components/__tests__/TESTING.md): Modal-rooted components
 * get the Proxy Modal mock AND their own file — a second Modal-rooted
 * component in the same file does not mount. Measured here: with these tests
 * in `composerMenu.component.test.tsx`, every one failed with "Unable to find
 * an element with testID: telegraph-typed-compose-input" while the
 * ComposerPlusMenu tests above them passed.
 *
 * SHOWN RED before commit: `TypedComposePrompt`'s precision default changed
 * from 'area' to 'exact' → the §4.3 default test RED.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — TESTING.md Rule 6.
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

import { TypedComposePrompt } from '../composer/TypedComposePrompt.tsx';

describe('§4.3 — the location sheet is coarse by default', () => {
  it('sends the APPROXIMATE precision without the sender choosing anything', async () => {
    const onSubmit = jest.fn();
    await render(<TypedComposePrompt kind="LOCATION" authorId="u1" onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.changeText(screen.getByTestId('telegraph-typed-compose-input'), 'An Thuong');
    await waitFor(() =>
      expect(screen.getByTestId('telegraph-typed-compose-input').props.value).toBe('An Thuong'),
    );
    fireEvent.press(screen.getByTestId('telegraph-typed-compose-send'));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('LOCATION', { label: 'An Thuong', precision: 'area' }),
    );
  });

  it('EXACT takes a deliberate second tap', async () => {
    const onSubmit = jest.fn();
    await render(<TypedComposePrompt kind="LOCATION" authorId="u1" onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.changeText(screen.getByTestId('telegraph-typed-compose-input'), 'The bridge');
    fireEvent.press(screen.getByTestId('telegraph-precision-exact'));
    await waitFor(() =>
      expect(screen.getByTestId('telegraph-typed-compose-input').props.value).toBe('The bridge'),
    );
    fireEvent.press(screen.getByTestId('telegraph-typed-compose-send'));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('LOCATION', { label: 'The bridge', precision: 'exact' }),
    );
  });

  it('renders nothing with no kind', async () => {
    await render(<TypedComposePrompt kind={null} authorId="u1" onCancel={() => {}} onSubmit={() => {}} />);
    expect(screen.queryByTestId('telegraph-typed-compose')).toBeNull();
  });
});
