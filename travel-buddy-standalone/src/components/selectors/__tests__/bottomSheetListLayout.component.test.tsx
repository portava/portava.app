/**
 * GlobalTimePicker / DurationPicker — the option list must have a height of its own.
 *
 * Both sheets are content-sized bottom sheets (only a `maxHeight`), and both styled their option ScrollView
 * `flex: 1`. In React Native `flex: 1` means flexBasis 0: inside a parent with no definite height Yoga lays such a
 * child out to 0pt. On the owner's iPhone (2026-10-22, release 9d3dc5d0) the layover "Arrival time" sheet opened as a
 * bare title — no "Now", no presets, no "Custom…" — so no layover could be started. Reproduced with yoga-layout 3.2.1
 * at 390×844: sheet 102pt / list 0pt with `flex: 1`; sheet 518pt / list 416pt content-sized; with 20 rows the
 * content-sized list stops at the 75% cap (633pt) and scrolls.
 *
 * Jest computes no layout, so this pins the style that decides it (content-sized, shrinking past the cap) together
 * with the behaviour the list exists for: every option is there and picking one reports it.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { GlobalTimePicker } from '../GlobalTimePicker.tsx';
import { DurationPicker } from '../DurationPicker.tsx';

// NOTE: intentional stub — requireActual pulls native-module internals.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

/** The one host scroll view in the sheet (`screen.root` is the host tree). */
function hostScrollView(): any {
  const found: any[] = [];
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'RCTScrollView') found.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  visit((screen as any).root);
  expect(found).toHaveLength(1);
  return found[0];
}

function expectContentSizedList() {
  const style = StyleSheet.flatten(hostScrollView().props.style) ?? {};
  // `flex: 1` (or any positive flex / flexBasis 0) collapses the list to 0pt inside the content-sized sheet.
  expect(style.flex).toBeUndefined();
  expect(style.flexBasis).toBeUndefined();
  expect(style.flexGrow ?? 0).toBe(0);
  // ...and it must still shrink, so a long list scrolls inside the sheet's maxHeight instead of overflowing it.
  expect(style.flexShrink).toBe(1);
}

describe('GlobalTimePicker sheet', () => {
  it('lays its options out at their own height and every option is reachable', async () => {
    const onChange = jest.fn();
    const onClose = jest.fn();
    await render(<GlobalTimePicker visible title="Arrival time" value={null} onChange={onChange} onClose={onClose} />);

    expectContentSizedList();
    for (const label of ['Now', 'Morning', 'Noon', 'Afternoon', 'Evening', 'Tonight', 'Late Night', 'Custom…']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    await fireEvent.press(screen.getByText('Evening'));
    expect(onChange).toHaveBeenCalledWith('18:00');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('DurationPicker sheet', () => {
  it('lays its options out at their own height and every option is reachable', async () => {
    const onChange = jest.fn();
    const onClose = jest.fn();
    await render(<DurationPicker visible title="Duration" value={null} onChange={onChange} onClose={onClose} />);

    expectContentSizedList();
    await fireEvent.press(screen.getByText('6 h'));
    expect(onChange).toHaveBeenCalledWith(6 * 60 * 60);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
