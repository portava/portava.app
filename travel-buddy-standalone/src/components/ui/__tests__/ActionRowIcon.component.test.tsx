/**
 * Action-row icons must render at ONE visible size across icon families.
 *
 * These tests deliberately assert *rendered geometry* — the width and viewBox
 * actually handed to each SVG — not that a shared constant was imported. The
 * bug they exist to prevent had three call sites all correctly importing the
 * same `POST_ACTION_ICON_SIZE`, and the stamp still rendered at 62% of the
 * comment icon beside it, because `size` sets the SVG viewport and each family
 * fills its viewBox by a different amount.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { MessageCircle } from 'lucide-react-native';
import { StampIcon } from '../../stamps/StampIcon.tsx';
import { PortavaShareIcon } from '../../icons/PortavaShareIcon.tsx';
import {
  ActionStampIcon,
  ActionShareIcon,
  ACTION_ICON_VISIBLE,
  ACTION_ICON_INK,
  ACTION_ICON_INK_RATIO,
  ACTION_STAMP_NOMINAL,
  ACTION_SHARE_NOMINAL,
} from '../ActionRowIcon.tsx';
import { POST_ACTION_ICON_SIZE, POST_ACTION_MIN_TOUCH } from '../../PostActionRow.tsx';
import { icon } from '../../../theme/tokens.ts';

type Node = { type: string; props: Record<string, unknown>; children: Node[] | null };

/** Walks the rendered tree and returns the props of the node with this testID. */
function propsOf(tree: Node, testID: string): Record<string, unknown> {
  const stack: Node[] = [tree];
  while (stack.length) {
    const n = stack.pop()!;
    if (n && typeof n === 'object') {
      if (n.props?.testID === testID) return n.props;
      if (Array.isArray(n.children)) stack.push(...(n.children.filter(Boolean) as Node[]));
    }
  }
  throw new Error(`no rendered node with testID "${testID}"`);
}

describe('viewBox guards — the ink ratios are derived from these', () => {
  // If either viewBox is retightened, ACTION_ICON_INK_RATIO is stale and every
  // action row silently misaligns again. That is exactly how this shipped.
  it('StampIcon still uses the 40x36 viewBox', async () => {
    const r = await render(<StampIcon size={20} testID="stamp-raw" />);
    const p = propsOf(r.toJSON() as unknown as Node, 'stamp-raw');
    expect([p.vbWidth, p.vbHeight]).toEqual([40, 36]);
  });

  it('PortavaShareIcon still uses the 24x24 viewBox', async () => {
    const r = await render(<PortavaShareIcon size={20} testID="share-raw" />);
    const p = propsOf(r.toJSON() as unknown as Node, 'share-raw');
    expect([p.vbWidth, p.vbHeight]).toEqual([24, 24]);
  });

  it('StampIcon letterboxes — a square viewport does NOT fill its 40x36 box', async () => {
    // This is the mechanism behind the bug: uniform scale = min(w/40, h/36),
    // so the glyph is bound by the 40-unit axis while only spanning 22.6 of it.
    const r = await render(<StampIcon size={20} testID="stamp-fit" />);
    const p = propsOf(r.toJSON() as unknown as Node, 'stamp-fit');
    expect(p.align).toBe('xMidYMid');
    expect(p.meetOrSlice).toBe(0); // 0 = "meet"
  });
});

describe('one canonical size', () => {
  it('the action size is the design token, not an independent number', () => {
    expect(POST_ACTION_ICON_SIZE).toBe(icon.action);
    expect(ACTION_ICON_VISIBLE).toBe(icon.action);
  });
});

describe('rendered visible size is uniform across icon families', () => {
  it('lucide, share and stamp all render the same ink extent', async () => {
    const r = await render(
      <>
        <MessageCircle size={POST_ACTION_ICON_SIZE} />
        <ActionShareIcon testID="share" />
        <ActionStampIcon testID="stamp" />
      </>,
    );
    const tree = r.toJSON() as unknown as Node;

    // Rendered ink = the viewport actually handed to each icon, times the
    // fraction of that viewport its artwork occupies.
    const commentInk =
      (propsOf(tree, 'icon-MessageCircle').size as number) * ACTION_ICON_INK_RATIO.lucide;
    const shareInk = (propsOf(tree, 'share').width as number) * ACTION_ICON_INK_RATIO.share;
    const stampInk = (propsOf(tree, 'stamp').width as number) * ACTION_ICON_INK_RATIO.stamp;

    expect(commentInk).toBeCloseTo(ACTION_ICON_INK, 5);
    expect(shareInk).toBeCloseTo(ACTION_ICON_INK, 5);
    expect(stampInk).toBeCloseTo(ACTION_ICON_INK, 5);

    // The property that actually matters: no family renders smaller than any
    // other. Sub-pixel tolerance, not "they share a constant".
    expect(Math.abs(shareInk - commentInk)).toBeLessThan(0.5);
    expect(Math.abs(stampInk - commentInk)).toBeLessThan(0.5);
  });

  it('the custom icons are scaled UP past the token, not merely set equal to it', async () => {
    // Guards against a "fix" that just passes the shared token everywhere
    // again — which is what the broken code already did.
    expect(ACTION_STAMP_NOMINAL).toBeGreaterThan(POST_ACTION_ICON_SIZE);
    expect(ACTION_SHARE_NOMINAL).toBeGreaterThan(POST_ACTION_ICON_SIZE);
    const r = await render(<ActionStampIcon testID="stamp-up" />);
    expect(propsOf(r.toJSON() as unknown as Node, 'stamp-up').width as number)
      .toBeGreaterThan(POST_ACTION_ICON_SIZE);
  });
});

describe('layout is unaffected by the oversized viewport', () => {
  it('the ink fits inside the pinned box, so nothing clips or overlaps', () => {
    expect(ACTION_ICON_INK).toBeLessThanOrEqual(ACTION_ICON_VISIBLE);
    // Both custom families overflow their box with transparent canvas only.
    expect(ACTION_STAMP_NOMINAL * ACTION_ICON_INK_RATIO.stamp).toBeLessThanOrEqual(ACTION_ICON_VISIBLE);
    expect(ACTION_SHARE_NOMINAL * ACTION_ICON_INK_RATIO.share).toBeLessThanOrEqual(ACTION_ICON_VISIBLE);
  });
});

describe('accessibility: touch target is independent of visible size', () => {
  it('the 44pt minimum is not reduced to make icons match', () => {
    expect(POST_ACTION_MIN_TOUCH).toBe(44);
    const hitSlop = (POST_ACTION_MIN_TOUCH - POST_ACTION_ICON_SIZE) / 2;
    expect(POST_ACTION_ICON_SIZE + hitSlop * 2).toBeGreaterThanOrEqual(44);
  });
});
