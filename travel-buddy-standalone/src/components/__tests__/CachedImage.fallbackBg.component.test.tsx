/**
 * CachedImage's optional `fallbackBg` (census-media §31.13).
 *
 * When an image cannot load, CachedImage draws MediaFallback: a `haze` box
 * with the caption "Image unavailable" in `paper` (1.19:1). Without the prop
 * that must not change. Media's image sites pass `mute`, on which the caption
 * reads 5.27:1. DisplayMediaImage already took the same prop.
 *
 * Run with:  pnpm test:component
 */
import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { render } from '@testing-library/react-native';
import { CachedImage } from '../CachedImage.tsx';
import { color } from '../../theme/tokens.ts';

type Node = { props?: Record<string, unknown>; children?: Array<Node | string> | null };

/** The fallback box: the rendered node one of whose children is the caption. */
function boxOf(node: Node | null): Node | null {
  if (!node || typeof node !== 'object') return null;
  const kids = (node.children ?? []).filter((c): c is Node => typeof c !== 'string');
  if (kids.some((k) => (k.children ?? []).includes('Image unavailable'))) return node;
  for (const k of kids) { const hit = boxOf(k); if (hit) return hit; }
  return null;
}

async function fallbackBox(props: { fallbackBg?: string }) {
  const r = await render(<CachedImage source={{ uri: '' }} style={{ width: 120, height: 90 }} {...props} />);
  const caption = r.getByText('Image unavailable');
  const box = boxOf(r.toJSON() as unknown as Node);
  return {
    background: StyleSheet.flatten(box?.props?.style as StyleProp<ViewStyle>)?.backgroundColor,
    captionColor: StyleSheet.flatten(caption.props.style).color,
  };
}

describe('CachedImage fallbackBg', () => {
  it('without it, the fallback box stays `haze` with a `paper` caption', async () => {
    expect(await fallbackBox({})).toEqual({ background: color.haze, captionColor: color.paper });
  });
  it('with it, the box takes the given ground and the caption is unchanged', async () => {
    expect(await fallbackBox({ fallbackBg: color.mute })).toEqual({ background: color.mute, captionColor: color.paper });
  });
});
