/**
 * StampButton's optional `tone` (census-media §31.13).
 *
 * Without the prop, StampButton must render exactly as it always has: the idle
 * icon and count in `mute`, the stamped icon and count in `signal`. Seven
 * non-Media screens rely on that. With `tone="onDark"` (the four Media
 * surfaces, each on a dark backing) the idle icon and the count draw in onInk,
 * because `mute` text cannot reach 4.5:1 on any dark ground; the stamped icon
 * stays `signal`.
 *
 * Run with:  pnpm test:component
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { color } from '../../../theme/tokens.ts';

// NOTE: intentionally exhaustive — react-native-reanimated initialises native
// worklets on import which crash under jest-expo without special Babel config.
// StampButton only needs Animated.View.
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return { __esModule: true, default: { View: RN.View } };
});
// NOTE: intentionally exhaustive — the local press/count animation is reanimated-only.
jest.mock('../../../hooks/useStampAnimation', () => ({
  useStampAnimation: () => ({ buttonStyle: {}, countStyle: {}, playStamp: () => {}, playUnstamp: () => {} }),
}));
// NOTE: intentionally exhaustive — the provider module pulls in reanimated and haptics.
jest.mock('../../../context/StampAnimationContext', () => ({
  useStampAnimationContext: () => ({ triggerStamp: () => {}, isAnimating: false }),
}));

import { StampButton } from '../StampButton.tsx';

type Node = { props?: Record<string, unknown>; children?: Array<Node | string> | null };

/** Every `stroke` the rendered SVG carries. */
function strokes(node: Node | Node[] | null, out: unknown[] = []): unknown[] {
  if (!node) return out;
  if (Array.isArray(node)) { for (const n of node) strokes(n, out); return out; }
  if (node.props && node.props.stroke !== undefined) out.push(node.props.stroke);
  for (const child of node.children ?? []) if (typeof child !== 'string') strokes(child, out);
  return out;
}

async function renderStamp(props: { initialCount: number; initialIsStamped: boolean; tone?: 'default' | 'onDark' }) {
  const r = await render(<StampButton entityType="post" entityId="p1" iconSize={22} {...props} />);
  const countColor = StyleSheet.flatten(r.getByText(String(props.initialCount)).props.style).color;
  return { countColor, iconStroke: strokes(r.toJSON() as unknown as Node)[0], tree: JSON.stringify(r.toJSON()) };
}

describe('StampButton tone', () => {
  it('without a tone, the idle count is `mute` and the stamped count `signal` (unchanged)', async () => {
    expect((await renderStamp({ initialCount: 3, initialIsStamped: false })).countColor).toBe(color.mute);
    expect((await renderStamp({ initialCount: 4, initialIsStamped: true })).countColor).toBe(color.signal);
  });

  it('tone="default" renders exactly as no tone', async () => {
    for (const s of [{ initialCount: 3, initialIsStamped: false }, { initialCount: 4, initialIsStamped: true }]) {
      expect((await renderStamp({ ...s, tone: 'default' })).tree).toBe((await renderStamp(s)).tree);
    }
  });

  it('tone="onDark" draws the count in onInk, idle or stamped', async () => {
    expect((await renderStamp({ initialCount: 3, initialIsStamped: false, tone: 'onDark' })).countColor).toBe(color.onInk);
    expect((await renderStamp({ initialCount: 4, initialIsStamped: true, tone: 'onDark' })).countColor).toBe(color.onInk);
  });

  it('tone="onDark" changes the idle icon only; the stamped icon keeps its default colour', async () => {
    const idle = await renderStamp({ initialCount: 3, initialIsStamped: false });
    const idleDark = await renderStamp({ initialCount: 3, initialIsStamped: false, tone: 'onDark' });
    const stamped = await renderStamp({ initialCount: 4, initialIsStamped: true });
    const stampedDark = await renderStamp({ initialCount: 4, initialIsStamped: true, tone: 'onDark' });
    expect(idle.iconStroke).toBeDefined();
    expect(idleDark.iconStroke).not.toEqual(idle.iconStroke);
    expect(stampedDark.iconStroke).toEqual(stamped.iconStroke);
  });
});
