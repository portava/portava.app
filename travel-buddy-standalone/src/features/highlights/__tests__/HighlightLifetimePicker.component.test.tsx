/**
 * HighlightLifetimePicker — §4's five lifetimes at creation.
 *
 * Highlights/Memories Development Architecture Spec v1 §4 / §12; census
 * H94–H98. The classes have been storable since migration 2723 landed on
 * 2026-09-15 and nothing offered them.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

import { HighlightLifetimePicker } from '../HighlightLifetimePicker.tsx';
import type { LifetimeClassesView } from '../lifetimeApi.ts';

function view(over: Partial<LifetimeClassesView> = {}): LifetimeClassesView {
  return {
    deployed: true,
    classes: [
      { cls: 'LIVE', example: 'Tonight with the crew', defaultBehavior: 'Short-lived; high freshness; no stale location.', mayNotBeStorable: false },
      { cls: 'DAY', example: 'Day 4 in Da Nang', defaultBehavior: 'Expires after recent context unless pinned.', mayNotBeStorable: false },
      { cls: 'TRIP', example: 'Japan 2026', defaultBehavior: 'Lives through Trip and may remain as curated recap.', mayNotBeStorable: false },
      { cls: 'SEASONAL', example: 'Summer in Asia', defaultBehavior: 'Dynamic collection over multiple Trips/Memories.', mayNotBeStorable: false },
      { cls: 'PERMANENT', example: 'First Portava Trip', defaultBehavior: 'Explicit or milestone-driven durable Highlight.', mayNotBeStorable: true },
    ],
    reason: null,
    ...over,
  };
}

const loader = (v: LifetimeClassesView) => jest.fn(async () => ({ ok: true as const, data: v }));

/**
 * ONE loader instance per test, hoisted out of the JSX.
 *
 * The component's effect depends on `load`, so a `loader(view())` written
 * inline creates a new function on every render and the effect re-runs
 * forever — which presents as a findByTestId timeout rather than as a loop,
 * and is exactly the shape of bug a stable-identity prop is for.
 */

describe('HighlightLifetimePicker', () => {

  it('offers §12\'s five in the spec\'s own words, from the SERVER', async () => {
    const load = loader(view());
    const { findByTestId, getByText } = await render(
      <HighlightLifetimePicker value={null} onChange={() => {}} load={load} />,
    );
    await findByTestId('highlight-lifetime-picker');
    expect(getByText('Tonight with the crew')).toBeTruthy();
    expect(getByText('Day 4 in Da Nang')).toBeTruthy();
    expect(getByText('First Portava Trip')).toBeTruthy();
  });

  it('preselects NOTHING — "no class" is a real state', async () => {
    // The server stores no class when none is named, because nothing in §12
    // assigns hour boundaries to the classes. Preselecting one here would put
    // that invention back a layer up.
    const load = loader(view());
    const { findByTestId } = await render(
      <HighlightLifetimePicker value={null} onChange={() => {}} load={load} />,
    );
    for (const cls of ['LIVE', 'DAY', 'TRIP', 'SEASONAL', 'PERMANENT']) {
      expect(await findByTestId(`highlight-lifetime-${cls}-off`)).toBeTruthy();
    }
  });

  it('reports the choice upward when a class is picked', async () => {
    const onChange = jest.fn();
    const load = loader(view());
    const { findByTestId } = await render(
      <HighlightLifetimePicker value={null} onChange={onChange} load={load} />,
    );
    fireEvent.press(await findByTestId('highlight-lifetime-TRIP-off'));
    expect(onChange).toHaveBeenCalledWith('TRIP');
  });

  it('shows §12\'s own sentence for the class that is selected', async () => {
    // Its own test rather than a second render inside the one above: two
    // renders in a single test leave two trees mounted in the same container,
    // and the NEXT test's query then looks at the wrong one — which presents
    // as a timeout on a test that passes in isolation.
    const load = loader(view());
    const { findByTestId, getByText } = await render(
      <HighlightLifetimePicker value="TRIP" onChange={() => {}} load={load} />,
    );
    await findByTestId('highlight-lifetime-note');
    expect(getByText('Lives through Trip and may remain as curated recap.')).toBeTruthy();
  });

  it('pressing the selected class CLEARS it — the first tap is not irreversible', async () => {
    const onChange = jest.fn();
    const load = loader(view());
    const { findByTestId } = await render(
      <HighlightLifetimePicker value="DAY" onChange={onChange} load={load} />,
    );
    fireEvent.press(await findByTestId('highlight-lifetime-DAY-on'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('warns on PERMANENT rather than promising a storage it cannot verify', async () => {
    // PERMANENT needs migration 2975's nullable expires_at and nullability is
    // not probeable. Offering it silently produces a save that fails; hiding it
    // removes a choice that works where the migration HAS run.
    const load = loader(view());
    const { findByTestId } = await render(
      <HighlightLifetimePicker value="PERMANENT" onChange={() => {}} load={load} />,
    );
    expect(await findByTestId('highlight-lifetime-warning')).toBeTruthy();
  });

  it('does not warn on a class that is plainly storable', async () => {
    const load = loader(view());
    const { findByTestId, queryByTestId } = await render(
      <HighlightLifetimePicker value="DAY" onChange={() => {}} load={load} />,
    );
    await findByTestId('highlight-lifetime-note');
    expect(queryByTestId('highlight-lifetime-warning')).toBeNull();
  });

  it('renders NOTHING where no class is storable at all', async () => {
    // Migration 2723 not applied. This is an optional refinement on a create
    // form, not a failure worth interrupting somebody's post for.
    const { queryByTestId } = await render(
      <HighlightLifetimePicker
        value={null}
        onChange={() => {}}
        load={jest.fn(async () => ({ ok: true as const, data: view({ deployed: false, classes: [], reason: 'lifetime_class is absent' }) }))}
      />,
    );
    await waitFor(() => expect(queryByTestId('highlight-lifetime-loading')).toBeNull());
    expect(queryByTestId('highlight-lifetime-picker')).toBeNull();
  });

  it('renders nothing when the capability read fails, rather than guessing a list', async () => {
    const { queryByTestId } = await render(
      <HighlightLifetimePicker
        value={null}
        onChange={() => {}}
        load={jest.fn(async () => ({ ok: false as const, kind: 'unavailable' as const, detail: 'offline' }))}
      />,
    );
    await waitFor(() => expect(queryByTestId('highlight-lifetime-loading')).toBeNull());
    expect(queryByTestId('highlight-lifetime-picker')).toBeNull();
  });
});
