/**
 * AppHeader's optional `overlayTint` (census-media §31.13).
 *
 * The overlay variant draws a white title on a 0.28 black tint. Without the
 * prop that must not change. The Media tab passes an ink tint at 0.58, the
 * least alpha at which the white title clears 4.5:1 over any frame.
 * `transparent` still wins over a tint.
 *
 * Run with:  pnpm test:component
 */
import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { render } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — react-native-reanimated initialises native
// worklets on import which crash under jest-expo without special Babel config.
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return { __esModule: true, default: { View: RN.View } };
});
// NOTE: intentionally exhaustive — useSafeAreaInsets requires a native provider.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

import { AppHeader } from '../AppHeader.tsx';

type Node = { type?: string; props?: Record<string, unknown>; children?: Array<Node | string> | null };

/** The overlay's outer View: the first rendered node. */
async function overlayBackground(props: Partial<React.ComponentProps<typeof AppHeader>>): Promise<unknown> {
  const r = await render(<AppHeader variant="overlay" title="Watch" {...props} />);
  const json = r.toJSON() as unknown as Node | Node[];
  const outer = Array.isArray(json) ? json[0] : json;
  return StyleSheet.flatten(outer.props?.style as StyleProp<ViewStyle>)?.backgroundColor;
}

describe('AppHeader overlayTint', () => {
  it('without a tint, the overlay keeps its 0.28 black', async () => {
    expect(await overlayBackground({})).toBe('rgba(0,0,0,0.28)');
  });
  it('a tint replaces it', async () => {
    expect(await overlayBackground({ overlayTint: 'rgba(17,17,15,0.58)' })).toBe('rgba(17,17,15,0.58)');
  });
  it('`transparent` wins over a tint, as before', async () => {
    expect(await overlayBackground({ transparent: true })).toBe('transparent');
    expect(await overlayBackground({ transparent: true, overlayTint: 'rgba(17,17,15,0.58)' })).toBe('transparent');
  });
  it('a tint does not touch the other variants', async () => {
    const plain = await render(<AppHeader variant="detail" title="Post" onBack={() => {}} />);
    const a = JSON.stringify(plain.toJSON());
    const tinted = await render(<AppHeader variant="detail" title="Post" onBack={() => {}} overlayTint="rgba(17,17,15,0.58)" />);
    expect(JSON.stringify(tinted.toJSON())).toBe(a);
  });
});
