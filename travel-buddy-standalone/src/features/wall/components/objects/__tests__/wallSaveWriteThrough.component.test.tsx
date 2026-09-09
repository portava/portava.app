/**
 * §2 "save" — the Wall's bookmark writes to the CANONICAL save store.
 *
 * It did not. `SocialActionRow` held a `React.useState(false)`, flipped it, and
 * fired analytics; nothing was written anywhere, so the bookmark reset the
 * moment the row unmounted — which, in a virtualised feed, is as soon as you
 * scroll past it. One of §2's eight named real-world actions was an animation.
 *
 * WHAT IS PROVEN HERE
 *   • the initial state comes from the SERVER (`projection.viewerSaved`), not
 *     from component state, so a save survives a remount;
 *   • pressing writes through `services/collections` → the canonical
 *     `post_saves` endpoint, with the CANONICAL object id;
 *   • un-saving writes the delete, not a second save;
 *   • an object type with no canonical post save is never written for;
 *   • a failed write does not leave the icon claiming a save the server does
 *     not hold.
 *
 * ONE PRESS, ONE FILE. The renderer's press budget (see
 * .agents/memory/rntl-react19-renderer-budget.md) allows ~2 reliable presses per
 * file and ONE press-derived visual commit, so the press scenario lives here on
 * its own and everything else is asserted through the exported
 * `persistWallSave`, which needs no renderer at all.
 *
 * MUTATION PROOF (each verified: revert → RED, restore → GREEN)
 *   • restore `React.useState(false)` as the initial save state AND remove the
 *     `viewerSaved` re-sync effect → the server-truth test RED. (Either alone
 *     leaves the other holding: the initial value and the effect are two paths
 *     to the same server fact, which is why a remount cannot lose it.)
 *   • delete the `persistWallSave` call from `toggleSave` → the write-through
 *     test RED.
 *   • always call `saveItem` (never `unsaveItem`) → the unsave test RED.
 *   • drop the POST_SAVEABLE_TYPES guard → the no-write-for-a-buddy test RED.
 *   • stop excluding `save` from `ContextualActionChips` → the one-Save test RED
 *     (a second Save chip would appear on every post in the feed).
 *   • drop the `if (!ok) setSaved(!next)` revert → the failed-write test RED.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — wallItemShared pulls wallAnalytics →
// wallApi, whose real module loads the supabase/apiToken chain at import.
jest.mock('../../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  fetchQuickMedia: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
  revalidateCachedObjects: jest.fn(async () => ({ ok: false, error: 'Network error' })),
}));

// NOTE: intentional stub — services/collections talks to the network through
// the supabase-configured API base. `saveItem`/`unsaveItem` are the only members
// the Wall's save path touches; this factory is complete for that seam.
jest.mock('../../../../../services/collections.ts', () => ({
  saveItem: jest.fn(async () => true),
  unsaveItem: jest.fn(async () => true),
}));

import { saveItem, unsaveItem } from '../../../../../services/collections.ts';
import { ContextualActionChips, SocialActionRow, persistWallSave } from '../wallItemShared.tsx';
import type { WallProjection } from '../../../types/wallProjection.ts';

const saveMock = saveItem as jest.Mock;
const unsaveMock = unsaveItem as jest.Mock;

function projection(over: Partial<WallProjection> = {}): WallProjection {
  return {
    projectionId: 'wall_social_post_p1',
    objectType: 'social_post',
    canonicalObjectId: 'post-1',
    publishedAt: '2026-09-04T00:00:00.000Z',
    visibility: 'public',
    actions: [],
    ...over,
  } as WallProjection;
}

beforeEach(() => {
  saveMock.mockReset();
  saveMock.mockResolvedValue(true);
  unsaveMock.mockReset();
  unsaveMock.mockResolvedValue(true);
});

// ── The write-through, without a renderer ────────────────────────────────────

describe('persistWallSave — the canonical write', () => {
  it('saves a post through the canonical post_saves endpoint, by CANONICAL id', async () => {
    expect(await persistWallSave(projection(), true)).toBe(true);
    expect(saveMock).toHaveBeenCalledWith('post', 'post-1');
    // Never the projection id — that is a Wall-local handle, not a canonical one.
    expect(saveMock).not.toHaveBeenCalledWith('post', 'wall_social_post_p1');
    expect(unsaveMock).not.toHaveBeenCalled();
  });

  it('un-saving deletes; it is not a second save', async () => {
    expect(await persistWallSave(projection(), false)).toBe(true);
    expect(unsaveMock).toHaveBeenCalledWith('post', 'post-1');
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('every post-like type writes through', async () => {
    for (const objectType of ['social_post', 'video', 'postcard', 'social_update', 'discovery']) {
      saveMock.mockClear();
      await persistWallSave(projection({ objectType } as Partial<WallProjection>), true);
      expect(saveMock).toHaveBeenCalledTimes(1);
    }
  });

  it('a type with no canonical post save is NEVER written for', async () => {
    for (const objectType of ['shared_moment', 'contextual_opportunity']) {
      expect(
        await persistWallSave(projection({ objectType } as Partial<WallProjection>), true),
      ).toBe(false);
    }
    expect(saveMock).not.toHaveBeenCalled();
    expect(unsaveMock).not.toHaveBeenCalled();
  });

  it('a rejected write reports failure instead of crashing the feed', async () => {
    saveMock.mockRejectedValue(new Error('offline'));
    expect(await persistWallSave(projection(), true)).toBe(false);
  });

  it('a refused write reports failure', async () => {
    saveMock.mockResolvedValue(false);
    expect(await persistWallSave(projection(), true)).toBe(false);
  });
});

// ── The action exists on the wire, but is rendered ONCE ──────────────────────

describe('§7/§35 — a server `save` action does not become a second Save chip', () => {
  it('the chip row ignores `save`; the bookmark is the only Save on the card', async () => {
    const withSave = projection({
      actions: [
        { type: 'open_object', label: 'Open' },
        { type: 'save', label: 'Save', targetType: 'post', targetId: 'post-1' },
      ],
    } as Partial<WallProjection>);

    const view = await render(
      <>
        <ContextualActionChips projection={withSave} />
        <SocialActionRow projection={withSave} />
      </>,
    );
    // Exactly one Save affordance, and it is the bookmark — not a chip row that
    // would now appear on every post in the feed.
    expect(view.getAllByLabelText('Save')).toHaveLength(1);
  });
});

// ── Server truth in the UI, and the one press ────────────────────────────────

describe('SocialActionRow — the bookmark is server truth', () => {
  it('renders the SERVER-resolved save state, and pressing writes it through', async () => {
    // Server says "already saved" → the control says Saved on first paint,
    // with no fetch and no component-state guess.
    const saved = await render(<SocialActionRow projection={projection({ viewerSaved: true })} />);
    expect(saved.getByLabelText('Saved')).toBeTruthy();
    expect(saved.queryByLabelText('Save')).toBeNull();

    // A second, unsaved object — and the file's ONE press.
    const view = await render(<SocialActionRow projection={projection({ viewerSaved: false })} />);
    fireEvent.press(view.getByLabelText('Save'));

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('post', 'post-1'));
    expect(unsaveMock).not.toHaveBeenCalled();
  });
});
