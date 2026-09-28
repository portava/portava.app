/**
 * §27/§32/§37/§46 — the DEGRADED surface, asserted against the real container
 * (census G13, G350).
 *
 * WHAT WAS WRONG, IN ONE SENTENCE PER SYMPTOM.
 *
 *   1. A field the authority marks `server_required` or `unavailable` drops its
 *      retained rows when the network dies — correctly, and that gate is
 *      untouched here (`useInputAssistance.ts#mayRetain`). The user was then
 *      shown a panel with NOTHING in it and no sentence explaining why.
 *   2. When the screen had supplied an `emptyState` — §37's context-dependent
 *      fallback actions, "Drop a pin" / "Add a new Place" — the degraded case
 *      rendered THAT. A field that was never asked, because the authority could
 *      not be reached, reported that a search had found nothing and offered to
 *      create a record instead.
 *   3. `unavailable` and "no matches" shared one string and one shape, so the
 *      three facts §27 names — loading, empty, error/degraded — were two.
 *
 * WHY THE CONTAINER AND NOT ONLY THE PURE FUNCTION. The branch is what was
 * broken. `degradedNotice.ts` is proven directly in `degradedNotice.test.ts`;
 * what those cases cannot see is that `emptyState` used to win, that the
 * degraded note reaches the a11y live region, and that the `server_required`
 * path draws NO suggestion row. Those are properties of this file's render
 * tree, so they are asserted on it.
 *
 * NOT A ROW IN SIGHT: every assertion about the `unassisted` branch also
 * asserts `queryAllByTestId(/^ia-entity-row-/)` is empty. The point of this
 * surface is that it explains an absence, and a test that only checked for the
 * sentence would stay green if a later pass "helpfully" restored the cache.
 *
 * MUTATION LOG: see the bottom of this file.
 *
 * Run: npx jest --testPathPattern='degradedSurface'
 */
import React from 'react';
import { Text } from 'react-native';
import { cleanup, render } from '@testing-library/react-native';

import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { SuggestionOverlay } from '../SuggestionOverlay.tsx';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

function withInsets(node: React.ReactElement) {
  return (
    <SafeAreaInsetsContext.Provider value={{ top: 0, bottom: 34, left: 0, right: 0 }}>
      {node}
    </SafeAreaInsetsContext.Provider>
  );
}

function sug(i: number, over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: `s${i}`,
    type: 'entity',
    context: 'city_picker',
    label: `Row ${i}`,
    entityType: 'city',
    source: 'local',
    policyVersion: 'input-2026-08',
    ...over,
  };
}

/** §37's fallback actions, as a screen would supply them. */
const FALLBACKS = <Text>Drop a pin</Text>;

afterEach(() => {
  cleanup();
});

test('§32: an OFFLINE field with no offline surface explains itself, and shows no row', async () => {
  const r = await render(
    withInsets(
      <SuggestionOverlay
        visible
        loading={false}
        unavailable
        offlineSurface={false}
        suggestions={[]}
        grouped={false}
        onSelect={() => {}}
      />,
    ),
  );
  expect(r.getByTestId('ia-degraded-unassisted')).toBeTruthy();
  // `getAllBy`, not `getBy`: the sentence is on screen AND in the live region,
  // which is the point — §46 announces the state rather than announcing nothing.
  expect(r.getAllByText(/only assisted online/).length).toBeGreaterThan(0);
  // The absence is explained, not filled.
  expect(r.queryAllByTestId(/^ia-entity-row-/).length).toBe(0);
  // And it is NOT the no-match sentence.
  expect(r.queryByText('No matches yet.')).toBeNull();
});

test("§37: the screen's fallback actions can no longer mask the degraded state", async () => {
  // `offlineSurface` IS DELIBERATELY OMITTED HERE, and that is a second
  // assertion rather than an oversight. The prop is optional on an exported
  // component, so "a caller that declares nothing" is a reachable input, and it
  // must fail CLOSED — the same answer `offlineSurfaceAllowed(null)` gives.
  // Defaulting it open would have this surface claim a device cache it cannot
  // see. Flipping the default to `true` reddens this case and nothing else,
  // which is why the case is written this way instead of passing `false`.
  const r = await render(
    withInsets(
      <SuggestionOverlay
        visible
        loading={false}
        unavailable
        suggestions={[]}
        emptyState={FALLBACKS}
        grouped={false}
        onSelect={() => {}}
      />,
    ),
  );
  // This is the defect, stated as an assertion: "Drop a pin" answers "nothing
  // matched", and nothing was searched.
  expect(r.queryByText('Drop a pin')).toBeNull();
  expect(r.getByTestId('ia-degraded-unassisted')).toBeTruthy();
  expect(r.queryAllByTestId(/^ia-entity-row-/).length).toBe(0);
});

test('§37: a genuine NO-MATCH still gets the fallback actions — the slot is not broken', async () => {
  const r = await render(
    withInsets(
      <SuggestionOverlay
        visible
        loading={false}
        suggestions={[]}
        emptyState={FALLBACKS}
        grouped={false}
        onSelect={() => {}}
      />,
    ),
  );
  expect(r.getByText('Drop a pin')).toBeTruthy();
  expect(r.queryByTestId('ia-degraded-unassisted')).toBeNull();
  expect(r.queryByTestId('ia-degraded-empty')).toBeNull();
});

test('§32: a LICENSED field with an empty device gets a DIFFERENT note from an online-only field', async () => {
  const r = await render(
    withInsets(
      <SuggestionOverlay
        visible
        loading={false}
        unavailable
        offlineSurface
        suggestions={[]}
        grouped={false}
        onSelect={() => {}}
      />,
    ),
  );
  expect(r.getByTestId('ia-degraded-empty')).toBeTruthy();
  expect(r.queryByTestId('ia-degraded-unassisted')).toBeNull();
});

test('G13: offline rows render UNDER a note saying they are device-local and unchecked', async () => {
  const r = await render(
    withInsets(
      <SuggestionOverlay
        visible
        loading={false}
        unavailable
        offlineSurface
        suggestions={[sug(0), sug(1)]}
        grouped={false}
        onSelect={() => {}}
      />,
    ),
  );
  expect(r.getByTestId('ia-degraded-rows')).toBeTruthy();
  expect(r.getAllByText(/Nothing here has been checked just now/).length).toBeGreaterThan(0);
  // The rows are still there — this arm RETAINS, it is the licensed surface.
  expect(r.queryAllByTestId(/^ia-entity-row-/).length).toBe(2);
  // §46 — and the live region leads with the offline fact rather than with the
  // count. The old status for this state was "2 suggestions" alone, so a
  // screen-reader user heard a number and never learned the list was
  // device-local (G13).
  const live = r.getAllByText(/^Offline\./)[0];
  expect(String(live.props.children)).toContain('2 suggestions');
});

test('§27: LOADING wins over the degraded note — "we are asking" is about to change', async () => {
  // The third of §27's three states, and the only one that is transient. A
  // degraded note over a live spinner would tell the user the request failed
  // while it is still in flight.
  const r = await render(
    withInsets(
      <SuggestionOverlay
        visible
        loading
        unavailable
        offlineSurface={false}
        suggestions={[]}
        grouped={false}
        onSelect={() => {}}
      />,
    ),
  );
  expect(r.getByText('Finding suggestions…')).toBeTruthy();
  expect(r.queryByTestId('ia-degraded-unassisted')).toBeNull();
  expect(r.queryByText('No matches yet.')).toBeNull();
});

/*
 * MUTATION LOG — applied to the shipped modules, run, watched, reverted,
 * `cmp`-verified. Baseline: 6/6 here, 8/8 across the two degraded jest files.
 *
 *   - SuggestionOverlay: delete the degraded block AND restore
 *     `{emptyState ?? (unavailable ? 'Suggestions are unavailable right now.'
 *     : 'No matches yet.')}` — i.e. EXACTLY the pre-build surface → 3/8.
 *     Four cases here go RED, including "the screen's fallback actions can no
 *     longer mask the degraded state", plus the SERVER_REQUIRED case in
 *     `degradedField.component.test.tsx`. This is the one that matters: it is
 *     the shipped behaviour this work replaces.
 *   - SuggestionOverlay: keep the degraded block but drop `&& !degraded` from
 *     the empty branch → 5/8. Three cases red — both sentences render at once,
 *     so "no matches" is printed under "we could not ask".
 *   - SuggestionOverlay: the `offlineSurface = false` default flipped to `true`
 *     → 7/8. "The screen's fallback actions can no longer mask the degraded
 *     state" goes RED, because that case is the one that OMITS the prop. It was
 *     written that way for this mutation: on the first run the default was
 *     unreachable from any test and the mutation survived — every case passed
 *     the prop explicitly. The gap was in the inputs, not in the code.
 *   - SuggestionOverlay: `status` puts the count BEFORE `degraded.a11y`
 *     → 7/8. The §46 assertion in "offline rows render UNDER a note" goes RED.
 *
 * PURE-SUITE MUTATIONS (degradedNotice.ts) and what they did to THIS file:
 *   - `rowCount > 0` moved below the licence check → pure 5/7, jest 7/8.
 *   - `UNASSISTED.detail` → 'No matches yet.' → pure 6/7, jest 6/8.
 *   - `ROWS.detail` loses 'Nothing here has been checked just now.'
 *       → pure 6/7, jest 7/8.
 *   - `EMPTY` collapsed into `UNASSISTED` → pure 5/7, jest 8/8 GREEN. Recorded
 *     rather than hidden: this file checks the `kind` on that branch and the
 *     kind does not change, so the SENTENCE is pinned only by the pure suite.
 *     That is the right division — the copy is a pure fact and the branch is a
 *     render fact — but it means a reader must not take this file's green as
 *     covering the copy.
 */
