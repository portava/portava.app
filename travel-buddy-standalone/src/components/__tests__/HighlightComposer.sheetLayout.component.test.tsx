/**
 * HighlightComposer — the form must have a height of its own.
 *
 * The sheet is content-sized (only `maxHeight: '90%'`) under a `flex: 1, justifyContent: 'flex-end'` keyboard wrapper,
 * and its form ScrollView was `flex: 1`. In React Native `flex: 1` means flexBasis 0: inside a parent with no definite
 * height Yoga lays such a child out to 0pt. On the owner's iPhone 17 Pro Max (440×956) "New Highlight" opened as a
 * title and a disabled Share button — no media picker, caption, place or audience — so no highlight could be created.
 * Reproduced with yoga-layout 3.2.1, errata ALL (RN 0.81 Fabric): sheet 166pt / form 0pt with `flex: 1`; sheet 698pt /
 * form 532pt with `{ flexGrow: 0, flexShrink: 1 }` (the form shrinks at the 90% cap and scrolls).
 *
 * Jest computes no layout, so this pins the style that decides it (content-sized, shrinking past the cap) together
 * with what the form exists for: its fields are there.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

// NOTE: intentional stub — requireActual pulls native-module internals.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// NOTE: intentionally exhaustive — the composer reads only signOut (on a 401), never pressed here.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ signOut: jest.fn() }),
}));

// NOTE: intentionally exhaustive — nothing is submitted; the sheet is only laid out.
jest.mock('../../services/highlights.ts', () => ({
  createHighlight: jest.fn(),
}));

// NOTE: intentionally exhaustive — the server-driven lifetime list is not under test.
jest.mock('../../features/highlights/HighlightLifetimePicker.tsx', () => ({
  HighlightLifetimePicker: () => null,
}));

import { HighlightComposer } from '../HighlightComposer.tsx';

/** Every host scroll view in the sheet (`screen.root` is the host tree). */
function hostScrollViews(): any[] {
  const found: any[] = [];
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'RCTScrollView') found.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  visit((screen as any).root);
  return found;
}

describe('HighlightComposer sheet', () => {
  it('lays the form out at its own height (not flex: 1) and its fields render', async () => {
    await render(<HighlightComposer visible onClose={() => {}} />);

    // The form is the scroll view that holds the Caption field.
    const holds = (n: any, text: string): boolean =>
      !!n && typeof n === 'object' && (n.props?.children === text || (n.children ?? []).some((c: any) => holds(c, text)));
    const form = hostScrollViews().filter((sv) => holds(sv, 'Caption'));
    expect(form).toHaveLength(1);

    const style = StyleSheet.flatten(form[0].props.style) ?? {};
    // `flex: 1` (or any positive flex / flexBasis 0) collapses the form to 0pt inside the content-sized sheet.
    expect(style.flex).toBeUndefined();
    expect(style.flexBasis).toBeUndefined();
    expect(style.flexGrow ?? 0).toBe(0);
    // ...and it must still shrink, so a tall form scrolls inside the sheet's 90% cap instead of overflowing it.
    expect(style.flexShrink).toBe(1);

    for (const label of ['New Highlight', 'Caption', 'Location', 'Who can see this?', 'Share Highlight']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByPlaceholderText('Add a caption…')).toBeTruthy();
  });
});
