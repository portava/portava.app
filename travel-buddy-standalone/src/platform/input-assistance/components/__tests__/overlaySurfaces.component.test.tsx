/**
 * §27 / §33 — the overlay's THREE missing mechanisms, each asserted against the
 * real component (census G172, G173, G211).
 *
 * What the census said, verbatim, and what each test here answers:
 *
 *   G172 "There is no zero-state PANEL: SuggestionOverlay's `emptyState` is a
 *        caller-supplied ReactNode and the zero-character rows the server
 *        returns are rendered through the ordinary list. The platform ships no
 *        component for the surface the spec names."
 *        → `ZeroStatePanel` exists, the overlay mounts it when the field is
 *          empty, and it frames the rows with a header instead of presenting
 *          them as matches.
 *
 *   G173 "There is no safe-area inset and no keyboard-height awareness anywhere
 *        in the layer — no useSafeAreaInsets, no KeyboardAvoidingView, no
 *        Keyboard listener — so the claim is an argument, not a mechanism."
 *        → `overlayHeightBudget` is the mechanism, the overlay subscribes to
 *          `keyboardDidShow`/`keyboardDidHide`, and the rendered cap moves when
 *          the keyboard does.
 *
 *   G211 "Nothing is virtualized: SuggestionOverlay:99 renders a plain
 *        ScrollView, not a FlatList/VirtualizedList, so every row in the group
 *        mounts."
 *        → 40 rows are handed to the overlay and fewer than 40 mount.
 *
 * WHY THE G211 ASSERTION CAN FAIL. Under jest there is no layout pass, so a
 * VirtualizedList renders exactly `initialNumToRender` items and no more. A
 * ScrollView renders all of them. The assertion is therefore a direct
 * discriminator between the two containers, which is the whole content of the
 * requirement. It is written as "fewer than the input" rather than "exactly 8"
 * so it survives a future tuning of the window without going green for the
 * wrong reason — and the companion assertion pins that SOME rows mount, so a
 * container that renders nothing at all cannot pass it either.
 *
 * MUTATION LOG (each applied, watched go red, reverted):
 *   - SuggestionOverlay: FlatList → ScrollView over `rows.map(...)`
 *       → "virtualizes" goes red (40 of 40 mount).
 *   - overlayHeightBudget: drop the `keyboardHeight > 0` branch from `reserved`
 *       → "the cap shrinks when the keyboard comes up" goes red.
 *   - overlayHeightBudget: drop the `Math.max(OVERLAY_MIN_HEIGHT, …)` floor
 *       → "never collapses below the floor" goes red.
 *   - SuggestionOverlay: render `list` instead of `<ZeroStatePanel …>` in the
 *     zeroState branch → both zero-state tests go red.
 *   - ZeroStatePanel: render `body` unconditionally
 *       → "an empty zero-state set says so" goes red.
 *
 * Run: npx jest --testPathPattern='overlaySurfaces'
 */
import React from 'react';
import { Keyboard } from 'react-native';
import { cleanup, render } from '@testing-library/react-native';

import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import {
  SuggestionOverlay,
  overlayHeightBudget,
  OVERLAY_MIN_HEIGHT,
  OVERLAY_GUTTER,
} from '../SuggestionOverlay.tsx';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import { space } from '../../../../theme/tokens.ts';

/**
 * The overlay reads the inset from CONTEXT (it must not throw when no provider
 * is mounted), so the test supplies one rather than mocking the hook.
 */
function withInsets(node: React.ReactElement, bottom = 34) {
  return (
    <SafeAreaInsetsContext.Provider value={{ top: 0, bottom, left: 0, right: 0 }}>
      {node}
    </SafeAreaInsetsContext.Provider>
  );
}

function sug(i: number): InputSuggestion {
  return {
    id: `s${i}`,
    type: 'entity',
    context: 'global_search',
    label: `Row ${i}`,
    entityType: 'city',
    entityId: `c${i}`,
    source: 'canonical',
    confidence: 0.9,
    action: { type: 'open_entity', entityType: 'city', entityId: `c${i}` },
  } as InputSuggestion;
}

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

// ── G211: virtualization ─────────────────────────────────────────────────────

test('§33/G211: a 40-row group does NOT mount 40 rows', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => sug(i));
  const r = await render(
    withInsets(
      <SuggestionOverlay visible loading={false} suggestions={rows} grouped={false} onSelect={() => {}} />,
    ),
  );
  const mounted = r.queryAllByTestId(/^ia-entity-row-/);
  expect(mounted.length).toBeGreaterThan(0); // a container that renders nothing is not a pass
  expect(mounted.length).toBeLessThan(rows.length);
});

test('§33/G211: the container is a VirtualizedList, not a ScrollView', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => sug(i));
  const r = await render(
    withInsets(
      <SuggestionOverlay visible loading={false} suggestions={rows} grouped={false} onSelect={() => {}} />,
    ),
  );
  // FlatList forwards these to VirtualizedList; a ScrollView has neither.
  const list = r.getByTestId('ia-suggestion-scroll');
  expect(list.props.renderItem ?? list.props.getItemCount).toBeDefined();
});

test('§33/G211: a short list still renders every row (the cap, not the window, is what shortens it)', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => sug(i));
  const r = await render(
    withInsets(
      <SuggestionOverlay visible loading={false} suggestions={rows} grouped={false} onSelect={() => {}} />,
    ),
  );
  expect(r.queryAllByTestId(/^ia-entity-row-/).length).toBe(5);
});

// ── G173: safe-area + keyboard height budget ─────────────────────────────────

test('§27/G173: the budget reserves the keyboard when it is up', () => {
  const up = overlayHeightBudget({
    requestedMaxHeight: 320,
    windowHeight: 800,
    keyboardHeight: 600,
    bottomInset: 34,
  });
  const down = overlayHeightBudget({
    requestedMaxHeight: 320,
    windowHeight: 800,
    keyboardHeight: 0,
    bottomInset: 34,
  });
  expect(up).toBeLessThan(down);
  expect(up).toBe(800 - 600 - OVERLAY_GUTTER);
  expect(down).toBe(320); // plenty of room ⇒ the caller's cap is the cap
});

test('§27/G173: the inset is reserved only when the keyboard is NOT covering it', () => {
  const withInset = overlayHeightBudget({
    requestedMaxHeight: 9999,
    windowHeight: 400,
    keyboardHeight: 0,
    bottomInset: 34,
  });
  const withoutInset = overlayHeightBudget({
    requestedMaxHeight: 9999,
    windowHeight: 400,
    keyboardHeight: 0,
    bottomInset: 0,
  });
  expect(withoutInset - withInset).toBe(34);
});

test('§27/G173: the budget never collapses the card below the floor', () => {
  expect(
    overlayHeightBudget({
      requestedMaxHeight: 320,
      windowHeight: 400,
      keyboardHeight: 390,
      bottomInset: 34,
    }),
  ).toBe(OVERLAY_MIN_HEIGHT);
});

test('§27/G173: the overlay SUBSCRIBES to the keyboard and re-caps when it appears', async () => {
  const listeners: Record<string, (e: any) => void> = {};
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, cb: (e: any) => void) => {
    listeners[name] = cb;
    return { remove: () => {} };
  }) as any);

  const rows = [sug(0), sug(1)];
  const r = await render(
    withInsets(
      <SuggestionOverlay visible loading={false} suggestions={rows} grouped={false} onSelect={() => {}} />,
    ),
  );

  // The subscription itself is half the requirement — the census's complaint was
  // that no Keyboard listener existed anywhere in the layer.
  expect(typeof listeners.keyboardDidShow).toBe('function');
  expect(typeof listeners.keyboardDidHide).toBe('function');

  const capOf = () => {
    const flat = r.getByTestId('ia-suggestion-overlay').props.style;
    const arr = Array.isArray(flat) ? flat : [flat];
    for (let i = arr.length - 1; i >= 0; i--) {
      const v = arr[i] && (arr[i] as any).maxHeight;
      if (typeof v === 'number') return v;
    }
    return undefined;
  };
  const before = capOf();
  expect(typeof before).toBe('number');

  const { act } = require('@testing-library/react-native');
  await act(async () => {
    listeners.keyboardDidShow({ endCoordinates: { height: 10_000 } });
  });
  expect(capOf()).toBe(OVERLAY_MIN_HEIGHT);
  expect(capOf()).toBeLessThan(before as number);

  await act(async () => {
    listeners.keyboardDidHide({});
  });
  expect(capOf()).toBe(before);
});

test('§27/G173: the bottom SAFE-AREA inset reaches the rendered list padding', async () => {
  const r = await render(
    withInsets(
      <SuggestionOverlay visible loading={false} suggestions={[sug(0)]} grouped={false} onSelect={() => {}} />,
      34,
    ),
  );
  const style = r.getByTestId('ia-suggestion-scroll').props.contentContainerStyle;
  const arr = (Array.isArray(style) ? style.flat(Infinity) : [style]) as any[];
  let pad: number | undefined;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && typeof arr[i].paddingBottom === 'number') { pad = arr[i].paddingBottom; break; }
  }
  // space.xs of chrome plus the whole inset — the card can sit over the home
  // indicator when the keyboard is down, so the last row keeps its tap target.
  expect(pad).toBe(space.xs + 34);
});

// ── G172: the zero-state panel ───────────────────────────────────────────────

test('§27/G172: an empty field renders the zero-state PANEL, framed as pre-typing', async () => {
  const rows = [sug(0), sug(1)];
  const r = await render(
    withInsets(
      <SuggestionOverlay
        visible
        loading={false}
        zeroState
        zeroStateTitle="Recent"
        suggestions={rows}
        grouped={false}
        onSelect={() => {}}
      />,
    ),
  );
  expect(r.getByTestId('ia-zero-state-panel')).toBeTruthy();
  expect(r.getByText('RECENT')).toBeTruthy();
  // the rows still render, and still through the virtualized container
  expect(r.queryAllByTestId(/^ia-entity-row-/).length).toBe(2);
});

test('§27/G172: a TYPED field gets no panel — the surface is what separates the two', async () => {
  const rows = [sug(0)];
  const r = await render(
    withInsets(
      <SuggestionOverlay visible loading={false} suggestions={rows} grouped={false} onSelect={() => {}} />,
    ),
  );
  expect(r.queryByTestId('ia-zero-state-panel')).toBeNull();
});

test('§27/G172: an EMPTY zero-state set says "start typing", not "no matches"', async () => {
  const r = await render(
    withInsets(
      <SuggestionOverlay visible loading={false} zeroState suggestions={[]} grouped={false} onSelect={() => {}} />,
    ),
  );
  expect(r.getByTestId('ia-zero-state-hint')).toBeTruthy();
  expect(r.queryByText('No matches yet.')).toBeNull();
});

test('§37: a typed field with no results still says "no matches yet"', async () => {
  const r = await render(
    withInsets(
      <SuggestionOverlay visible loading={false} suggestions={[]} grouped={false} onSelect={() => {}} />,
    ),
  );
  expect(r.getByText('No matches yet.')).toBeTruthy();
  expect(r.queryByTestId('ia-zero-state-panel')).toBeNull();
});
