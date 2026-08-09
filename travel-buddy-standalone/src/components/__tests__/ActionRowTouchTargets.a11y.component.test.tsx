/**
 * Action rows — every tappable action clears the 44pt touch minimum.
 *
 * Three rows build their actions by hand instead of going through
 * PostActionGroup, and each had drifted below the floor:
 *
 *   ActionBar          36pt — hitSlop 8 around a 20pt icon
 *   cards/PostCard     36pt — hitSlop 8 around a 20pt icon
 *   HighlightViewer    20pt — the viewers/Eye button had NO hitSlop at all,
 *                      less than half the minimum, while every sibling in the
 *                      same row already had HIT_SLOP
 *
 * WHAT THESE TESTS PIN, AND WHY IT IS TWO ASSERTIONS AND NOT ONE
 * --------------------------------------------------------------
 * Visible icon size and touch size are independent concerns, and there are two
 * ways to satisfy "icon + 2*slop >= 44". Only one of them is correct.
 *
 *   1. `reaches 44pt` — the target is at least 44pt.
 *   2. `without inflating the icon` — and it got there via hitSlop, with the
 *      icon still at the design token.
 *
 * Assertion 1 alone would pass if someone grew the icons to 44pt, which would
 * undo the normalisation in ui/ActionRowIcon.tsx that exists to hold every
 * action-row icon at ONE visible size. Assertion 2 is what makes that
 * regression fail. Do not collapse them.
 *
 * These read the hitSlop actually handed to each Pressable in the rendered
 * tree, not the constant at its definition site — the same reason
 * ActionRowIcon.component.test.tsx reads rendered geometry.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { ActionBar } from '../ActionBar.tsx';
import { PostCard } from '../cards/PostCard.tsx';
import { HighlightViewer } from '../HighlightViewer.tsx';
import { POST_ACTION_ICON_SIZE, POST_ACTION_MIN_TOUCH, POST_ACTION_TOUCH_PAD } from '../PostActionRow.tsx';
import { icon } from '../../theme/tokens.ts';
import type { Highlight } from '../../services/highlights.ts';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const MIN_TOUCH = 44;

type Node = { type: string; props: Record<string, unknown>; children: Node[] | null };

/**
 * Every Pressable in the rendered tree.
 *
 * Keyed on `onStartShouldSetResponder`, which every Pressable sets and which
 * survives regardless of props. Enumerating by `hitSlop` instead would be
 * worse than useless here: the HighlightViewer bug was a MISSING hitSlop, so a
 * hitSlop-keyed walk skips the very control under test and the suite passes by
 * not looking. Verified by mutation — see the commit message.
 */
function allPressables(tree: Node): Node[] {
  const out: Node[] = [];
  const stack: Node[] = [tree];
  while (stack.length) {
    const n = stack.pop()!;
    if (n && typeof n === 'object') {
      if (n.props?.onStartShouldSetResponder !== undefined) out.push(n);
      if (Array.isArray(n.children)) stack.push(...(n.children.filter(Boolean) as Node[]));
    }
  }
  return out;
}

function descendants(node: Node): Node[] {
  const out: Node[] = [];
  const stack: Node[] = [...((node.children ?? []).filter(Boolean) as Node[])];
  while (stack.length) {
    const n = stack.pop()!;
    if (n && typeof n === 'object') {
      out.push(n);
      if (Array.isArray(n.children)) stack.push(...(n.children.filter(Boolean) as Node[]));
    }
  }
  return out;
}

/** Carries an action-row icon: a lucide glyph at the token, or an ActionRowIcon box. */
function holdsActionIcon(node: Node): boolean {
  return descendants(node).some((d) => {
    if (d.props?.size === POST_ACTION_ICON_SIZE) return true;
    const st = StyleSheet.flatten(d.props?.style as never) as Record<string, number> | undefined;
    return st?.width === POST_ACTION_ICON_SIZE && st?.height === POST_ACTION_ICON_SIZE;
  });
}

/**
 * The action controls of a row: leaf Pressables holding an action-row icon.
 *
 * "Leaf" excludes wrappers that merely contain the row — PostCard's whole card
 * is itself a Pressable. "Holds an icon" excludes controls that are not icon
 * buttons at all, such as HighlightViewer's full-bleed tap zones, which are
 * flex-sized and have no business being measured against a 44pt icon floor.
 */
function actionControls(tree: Node): Node[] {
  const pressables = allPressables(tree);
  return pressables.filter(
    (p) => holdsActionIcon(p) && !descendants(p).some((d) => d.props?.onStartShouldSetResponder !== undefined),
  );
}

/**
 * Smallest edge-to-edge extent of a hitSlop, in pt. A number applies to all
 * four sides; an object may differ per side, and the tightest one governs
 * whether the target clears the floor. Absent hitSlop is 0 — the case that
 * matters most.
 */
function slopMin(hitSlop: unknown): number {
  if (typeof hitSlop === 'number') return hitSlop;
  if (hitSlop && typeof hitSlop === 'object') {
    const h = hitSlop as Record<string, number>;
    return Math.min(h.top ?? 0, h.bottom ?? 0, h.left ?? 0, h.right ?? 0);
  }
  return 0;
}

/** Largest explicit height declared on a node or anywhere beneath it. */
function declaredHeight(node: Node): number {
  let max = 0;
  for (const n of [node, ...descendants(node)]) {
    const st = StyleSheet.flatten(n.props?.style as never) as Record<string, number> | undefined;
    for (const v of [st?.minHeight, st?.height]) {
      if (typeof v === 'number' && v > max) max = v;
    }
  }
  return max;
}

/**
 * The guaranteed touch extent of an action control.
 *
 * A control that sizes itself explicitly is taken at its word, and that sizing
 * is not always on the node holding the hitSlop: StampButton puts
 * `minHeight: 44` on the Animated.View *inside* its Pressable, and the viewer's
 * close button is a fixed 32pt circle. So the whole subtree is measured, since
 * a parent is at least as tall as its tallest child.
 *
 * Only when nothing declares a height does the icon govern: these rows size to
 * their tallest child, and the counter text beside the icon is smaller than it.
 * Either way this is a LOWER bound on the real target, which is the safe
 * direction for a floor assertion.
 */
function touchExtent(node: Node): number {
  return Math.max(declaredHeight(node), POST_ACTION_ICON_SIZE) + slopMin(node.props.hitSlop) * 2;
}

const HIGHLIGHT: Highlight = {
  id: 'h1',
  ownerId: 'u1',
  mediaUrl: 'post-media/u1/h1.jpg',
  mediaType: 'image',
  videoDurationSeconds: null,
  caption: null,
  locationName: null,
  locationCity: null,
  locationCountry: null,
  visibility: 'public' as Highlight['visibility'],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  createdAt: new Date().toISOString(),
  deletedAt: null,
  author: { id: 'u1', handle: 'maya', name: 'Maya Chen', avatarUrl: null },
  viewCount: 12,
  likeCount: 3,
  viewedByMe: false,
  likedByMe: false,
  filterId: 'original',
  filterIntensity: 100,
};

describe('the shared pad is derived from the floor, not guessed', () => {
  it('POST_ACTION_TOUCH_PAD closes exactly the gap to 44pt', () => {
    expect(POST_ACTION_MIN_TOUCH).toBe(MIN_TOUCH);
    expect(POST_ACTION_ICON_SIZE + POST_ACTION_TOUCH_PAD * 2).toBeGreaterThanOrEqual(MIN_TOUCH);
  });

  it('the icon size is still the design token — the pad is what moved', () => {
    // If a future "fix" reaches 44 by growing the icon instead, this fails and
    // ui/ActionRowIcon.tsx's one-visible-size guarantee is preserved.
    expect(POST_ACTION_ICON_SIZE).toBe(icon.s20);
    expect(POST_ACTION_ICON_SIZE).toBeLessThan(MIN_TOUCH);
  });
});

describe('ActionBar — every action clears 44pt', () => {
  it('every action control reaches 44pt', async () => {
    const r = await render(
      <ActionBar entityType="post" entityId="p1" commentCount={3} saveCount={1} />,
    );
    const controls = actionControls(r.toJSON() as unknown as Node);
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(touchExtent(c)).toBeGreaterThanOrEqual(MIN_TOUCH);
    }
  });

  it('the share button specifically — it was 36pt', async () => {
    const r = await render(
      <ActionBar entityType="post" entityId="p1" commentCount={3} saveCount={1} onShare={() => {}} />,
    );
    const share = r.getByLabelText('Share');
    expect(slopMin(share.props.hitSlop) * 2 + POST_ACTION_ICON_SIZE).toBeGreaterThanOrEqual(MIN_TOUCH);
  });
});

describe('cards/PostCard — every engagement action clears 44pt', () => {
  it('stamp, comment and save all reach 44pt', async () => {
    const r = await render(
      <PostCard
        id="p1"
        type="post"
        title="A title"
        onPress={() => {}}
        onLike={() => {}}
        onComment={() => {}}
        onSave={() => {}}
        likeCount={2}
        commentCount={5}
      />,
    );
    const controls = actionControls(r.toJSON() as unknown as Node);
    // stamp + comment + save
    expect(controls.length).toBeGreaterThanOrEqual(3);
    for (const c of controls) {
      expect(touchExtent(c)).toBeGreaterThanOrEqual(MIN_TOUCH);
    }
  });
});

describe('HighlightViewer — the viewers button, which had no hitSlop at all', () => {
  it('the owner viewers/count button reaches 44pt', async () => {
    const r = await render(
      <HighlightViewer
        visible
        highlights={[HIGHLIGHT]}
        currentUserId="u1"
        onClose={() => {}}
      />,
    );
    // currentUserId === ownerId, so the owner-only viewers button is rendered.
    const controls = actionControls(r.toJSON() as unknown as Node);
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(touchExtent(c)).toBeGreaterThanOrEqual(MIN_TOUCH);
    }
  });

  it('no action in the row is left without a hitSlop', async () => {
    // The original bug was absence, not a small value: one Pressable in a row
    // where every sibling already had HIT_SLOP. A count, not a minimum.
    const r = await render(
      <HighlightViewer
        visible
        highlights={[HIGHLIGHT]}
        currentUserId="u1"
        onClose={() => {}}
      />,
    );
    const controls = actionControls(r.toJSON() as unknown as Node);
    for (const c of controls) {
      expect(slopMin(c.props.hitSlop)).toBeGreaterThan(0);
    }
  });
});
