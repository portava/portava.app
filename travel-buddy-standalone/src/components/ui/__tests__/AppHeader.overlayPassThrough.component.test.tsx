/**
 * AppHeader overlay variant — the bar floats over content, so it must not swallow touches meant for that content.
 *
 * The overlay's outer View was already `pointerEvents="box-none"`, but its 44pt bar was a plain View: on iOS a plain
 * View is the hit-test target for every touch inside it, so the whole band (62–106pt on the owner's iPhone 17 Pro Max,
 * zIndex 20) took every tap. The Watch feed's per-video Create button (then at insets.top + 12 = 74pt) and the Media
 * tab's World pill (insets.top + 8) sat in that band: visible, never pressable.
 *
 * Every AppHeader usage was checked: `overlay` is used once (app/(tabs)/media.tsx, no back button, no actions); the
 * bar's other children are the centred title (already pointerEvents none) and the left/right slots, which hold the
 * only things meant to take touches. The in-flow variants (detail / modal) overlay nothing and are unchanged.
 *
 * Run with:  pnpm test:component
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, fireEvent, screen } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — react-native-reanimated initialises native
// worklets on import which crash under jest-expo without special Babel config.
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return { __esModule: true, default: { View: RN.View } };
});
// NOTE: intentionally exhaustive — useSafeAreaInsets requires a native provider; 62 is the owner's iPhone.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));

import { AppHeader, OVERLAY_HEADER_HEIGHT } from '../AppHeader.tsx';

type Node = { type?: string; props?: Record<string, any>; children?: Array<Node | string> | null };

/** The header's bar: the host View styled at the bar's height in a row. */
function bar(): Node {
  const found: Node[] = [];
  const visit = (n: Node | string | null | undefined) => {
    if (!n || typeof n !== 'object') return;
    const st = StyleSheet.flatten(n.props?.style) ?? {};
    if (st.height === OVERLAY_HEADER_HEIGHT && st.flexDirection === 'row') found.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  visit((screen as any).root);
  expect(found).toHaveLength(1);
  return found[0];
}

describe('AppHeader overlay bar', () => {
  it('lets touches through to the content under it (box-none), as its outer View already did', async () => {
    await render(<AppHeader variant="overlay" title="Watch" overlayTint="rgba(17,17,15,0.58)" />);
    expect(bar().props?.pointerEvents).toBe('box-none');
  });

  it('its own back button and actions still take touches', async () => {
    const onBack = jest.fn();
    const onShare = jest.fn();
    await render(
      <AppHeader variant="overlay" title="Watch" onBack={onBack} rightActions={[{ icon: null, onPress: onShare, accessibilityLabel: 'Share' }]} />,
    );
    expect(bar().props?.pointerEvents).toBe('box-none');
    await fireEvent.press(screen.getByLabelText('Back'));
    await fireEvent.press(screen.getByLabelText('Share'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('the in-flow variants overlay nothing and keep a plain bar', async () => {
    await render(<AppHeader variant="detail" title="Post" onBack={() => {}} />);
    expect(bar().props?.pointerEvents).toBeUndefined();
    await render(<AppHeader variant="modal" title="Edit" onBack={() => {}} />);
    expect(bar().props?.pointerEvents).toBeUndefined();
  });
});
