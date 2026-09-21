/**
 * Telegraph §10.1 / §6.2 — the Memory Note half of the typed-compose sheet.
 *
 * A MEMORY_NOTE message carries §10.1's `MemoryNoteShare` fields — the note's
 * own id, its author, its text and its asset ids — and NOT the sender's
 * canonical Memory graph. What the sheet produces is asserted field by field
 * here, because "shareable without exposing the private graph" is a claim
 * about what is IN the payload.
 *
 * MODAL RULE 6 + the two-file rule (src/components/__tests__/TESTING.md): this
 * is a Modal-rooted component driven through waitFor, and a third such mount in
 * one file does not render. Measured: with these two tests appended to
 * `typedCompose.component.test.tsx`, both failed with "Unable to find an
 * element with testID: telegraph-typed-compose-input" while the two tests
 * above them passed.
 *
 * SHOWN RED before commit: `TypedComposePrompt` submitting on an empty string
 * → "an empty prompt sends nothing" RED.
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

describe('§10.1 — the Memory Note sheet', () => {
  it('a MEMORY_NOTE carries the author and the text, and nothing else', async () => {
    const onSubmit = jest.fn();
    await render(<TypedComposePrompt kind="MEMORY_NOTE" authorId="u1" onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.changeText(screen.getByTestId('telegraph-typed-compose-input'), 'the night we walked to the bridge');
    await waitFor(() =>
      expect(screen.getByTestId('telegraph-typed-compose-input').props.value).toBe('the night we walked to the bridge'),
    );
    fireEvent.press(screen.getByTestId('telegraph-typed-compose-send'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const [kind, payload] = onSubmit.mock.calls[0];
    expect(kind).toBe('MEMORY_NOTE');
    expect(payload).toEqual(
      expect.objectContaining({ authorId: 'u1', text: 'the night we walked to the bridge', mediaAssetIds: [] }),
    );
  });

  it('an empty prompt sends nothing', async () => {
    const onSubmit = jest.fn();
    await render(<TypedComposePrompt kind="MEMORY_NOTE" authorId="u1" onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.press(screen.getByTestId('telegraph-typed-compose-send'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

});
