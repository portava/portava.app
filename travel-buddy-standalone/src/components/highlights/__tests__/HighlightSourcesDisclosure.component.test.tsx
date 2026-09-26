/**
 * §12 provenance renders FOUR states, not two.
 *
 * Highlights/Memories Development Architecture Spec v1 §12 and §28.11 ("never
 * swallow projection/schema failures into plausible-looking empty history
 * without structured error state"). Census H93.
 *
 * THE FAILURE THIS SUITE EXISTS TO PREVENT is the one-line version of this
 * component: `sources.length === 0 ? 'built from nothing' : <list/>`. Written
 * that way it prints "this highlight isn't built from a memory" for a request
 * that has not been sent, for one still in flight, and for one the server
 * refused — three claims about somebody's record that the client has no
 * grounds for. Only a 200 that came back empty may say it.
 *
 * It also pins the retry rule: `feature_disabled` means migration 2722 is
 * absent on that deployment and no number of taps will change it, so no retry
 * is offered; `degraded_unavailable` gets one.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { HighlightSourcesDisclosure } from '../HighlightSourcesDisclosure.tsx';
import type { HighlightSourcesState } from '../../../hooks/useHighlightSources.ts';
import type { HighlightSource } from '../../../services/highlights.ts';

const HID = '66666666-6666-4666-8666-666666666666';

function state(over: Partial<HighlightSourcesState>): HighlightSourcesState {
  return {
    status: 'idle',
    sources: [],
    errorKind: null,
    message: null,
    load: jest.fn(),
    ...over,
  };
}

const SRC: HighlightSource = {
  sourceType: 'MEMORY',
  sourceId: '77777777-7777-4777-8777-777777777777',
  provenance: 'USER_ASSERTED',
  createdAt: '2026-09-01T00:00:00.000Z',
};

describe('HighlightSourcesDisclosure', () => {
  it('renders nothing but the toggle while collapsed', async () => {
    await render(
      <HighlightSourcesDisclosure
        highlightId={HID}
        expanded={false}
        onToggle={jest.fn()}
        stateOverride={state({ status: 'ready', sources: [] })}
      />,
    );
    expect(screen.getByTestId(`highlight-sources-toggle-${HID}`)).toBeTruthy();
    expect(screen.queryByTestId(`highlight-sources-none-${HID}`)).toBeNull();
  });

  it('does NOT say "built from nothing" while the read is in flight', async () => {
    await render(
      <HighlightSourcesDisclosure
        highlightId={HID}
        expanded
        onToggle={jest.fn()}
        stateOverride={state({ status: 'loading' })}
      />,
    );
    expect(screen.getByTestId(`highlight-sources-loading-${HID}`)).toBeTruthy();
    expect(screen.queryByTestId(`highlight-sources-none-${HID}`)).toBeNull();
  });

  it('does NOT say "built from nothing" when the server refused', async () => {
    await render(
      <HighlightSourcesDisclosure
        highlightId={HID}
        expanded
        onToggle={jest.fn()}
        stateOverride={state({ status: 'refused', errorKind: 'degraded_unavailable' })}
      />,
    );
    expect(screen.getByTestId(`highlight-sources-refused-${HID}`)).toBeTruthy();
    expect(screen.queryByTestId(`highlight-sources-none-${HID}`)).toBeNull();
  });

  it('says sourceless ONLY for a 200 that came back empty', async () => {
    await render(
      <HighlightSourcesDisclosure
        highlightId={HID}
        expanded
        onToggle={jest.fn()}
        stateOverride={state({ status: 'ready', sources: [] })}
      />,
    );
    expect(screen.getByTestId(`highlight-sources-none-${HID}`)).toBeTruthy();
  });

  it('offers a retry for a refusal that might succeed next time', async () => {
    await render(
      <HighlightSourcesDisclosure
        highlightId={HID}
        expanded
        onToggle={jest.fn()}
        stateOverride={state({ status: 'refused', errorKind: 'degraded_unavailable' })}
      />,
    );
    expect(screen.getByTestId(`highlight-sources-retry-${HID}`)).toBeTruthy();
  });

  it('offers NO retry for `feature_disabled` — that build cannot answer, ever', async () => {
    await render(
      <HighlightSourcesDisclosure
        highlightId={HID}
        expanded
        onToggle={jest.fn()}
        stateOverride={state({ status: 'refused', errorKind: 'feature_disabled' })}
      />,
    );
    expect(screen.getByTestId(`highlight-sources-refused-${HID}`)).toBeTruthy();
    expect(screen.queryByTestId(`highlight-sources-retry-${HID}`)).toBeNull();
  });

  it('names §4’s truth level per source rather than rendering the five as one', async () => {
    await render(
      <HighlightSourcesDisclosure
        highlightId={HID}
        expanded
        onToggle={jest.fn()}
        stateOverride={state({
          status: 'ready',
          sources: [SRC, { ...SRC, sourceId: 'other', provenance: 'INFERRED' }],
        })}
      />,
    );
    expect(screen.getByTestId(`highlight-sources-list-${HID}`)).toBeTruthy();
    expect(screen.getByText('You said so')).toBeTruthy();
    expect(screen.getByText('Inferred')).toBeTruthy();
  });
});
