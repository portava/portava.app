/**
 * MediaFilterEditor — accessibility contract.
 *
 * Gates the four things audited against the Step 16 standard. Three of them
 * were failing before this file existed:
 *
 *   1. Every control has an accessible name. The close button was icon-only
 *      with no label, and the intensity slider announced a bare number because
 *      its "Intensity" caption is a visual sibling, not a linked label.
 *   2. Selection state is available non-visually. Visually it always passed —
 *      the selected thumbnail carries a Check glyph and a bolder name, so it
 *      was never colour-alone — but nothing exposed `selected` to a screen
 *      reader, so twelve filters announced with no indication of the current
 *      choice.
 *   3. Touch targets meet the 44pt floor. Apply was 34pt, Reset 38pt, and
 *      "Post as Original" was a bare Text at 18pt.
 *
 * Dynamic-text-scaling behaviour (fixed-width captions, and the fixed column
 * that pushed Reset off-screen) is structural and covered by the styles rather
 * than asserted here; see the audit note in the commit message.
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { MediaFilterEditor } from '../MediaFilterEditor.tsx';
import { mediaFilters } from '../../lib/media/filters.ts';

// No react-native Modal proxy here on purpose: this editor renders its Modal
// with `visible` fixed true and no animation callbacks to settle, so RNTL
// walks into the children unaided. Adding the usual proxy actually broke
// render() outright.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const MIN_TOUCH = 44;

// RNTL v14's render is async (it awaits act internally) — it returns a Promise,
// so the queries only exist after awaiting. Calling it synchronously yields a
// Promise with no query methods and leaves `screen` unbound.
async function renderEditor(overrides: Partial<React.ComponentProps<typeof MediaFilterEditor>> = {}) {
  const onApply = jest.fn();
  const onCancel = jest.fn();
  const utils = await render(
    <MediaFilterEditor
      file={{ uri: 'file:///tmp/pick.jpg', mimeType: 'image/jpeg' }}
      mediaType="image"
      onApply={onApply}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onApply, onCancel, ...utils };
}

/**
 * Press and flush. Under this RNTL the render/act cycle is async, so a bare
 * fireEvent.press leaves the resulting state update uncommitted and the tree
 * still shows the previous selection.
 */
async function press(node: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => {
    fireEvent.press(node);
  });
}

/** Flatten a possibly-nested RN style prop into one object. */
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return (style ?? {}) as Record<string, unknown>;
}

describe('MediaFilterEditor — accessible names', () => {
  it('the icon-only close button has a label', async () => {
    const { getByLabelText } = await renderEditor();
    expect(getByLabelText('Close filter editor')).toBeTruthy();
  });

  it('the close button actually cancels', async () => {
    const { onCancel, getByLabelText } = await renderEditor();
    await press(getByLabelText('Close filter editor'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('the intensity slider has a label, not just a visual caption', async () => {
    const { getByLabelText } = await renderEditor();
    expect(getByLabelText('Filter intensity')).toBeTruthy();
  });

  it('every filter in the carousel is reachable by its name', async () => {
    const { getByLabelText } = await renderEditor();
    for (const f of mediaFilters) {
      expect(getByLabelText(f.name)).toBeTruthy();
    }
  });
});

describe('MediaFilterEditor — selection state is exposed non-visually', () => {
  it('exactly one filter reports selected, and it is Original by default', async () => {
    const { getByLabelText } = await renderEditor();
    const selected = mediaFilters.filter(
      (f) => getByLabelText(f.name).props.accessibilityState?.selected,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe('original');
  });

  it('selecting a filter moves the announced selection', async () => {
    const { getByLabelText } = await renderEditor();
    await press(getByLabelText('Noir'));

    expect(getByLabelText('Noir').props.accessibilityState?.selected).toBe(true);
    expect(getByLabelText('Original').props.accessibilityState?.selected).toBe(false);

    // Still exactly one — selection must move, not accumulate.
    const selected = mediaFilters.filter(
      (f) => getByLabelText(f.name).props.accessibilityState?.selected,
    );
    expect(selected).toHaveLength(1);
  });

  it('filters are announced as radios so the single-choice semantic is clear', async () => {
    const { getByLabelText } = await renderEditor();
    expect(getByLabelText('Noir').props.accessibilityRole).toBe('radio');
  });
});

describe('MediaFilterEditor — touch targets meet the 44pt floor', () => {
  it('Apply is at least 44pt tall', async () => {
    const { getByLabelText } = await renderEditor();
    const apply = getByLabelText('Apply Original filter');
    expect(flatten(apply.props.style).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH);
  });

  it('Reset is at least 44pt tall', async () => {
    const { getByLabelText } = await renderEditor();
    const reset = getByLabelText('Reset to Original');
    expect(flatten(reset.props.style).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH);
  });

  it('the close button clears 44pt via hitSlop on a 36pt control', async () => {
    const { getByLabelText } = await renderEditor();
    const close = getByLabelText('Close filter editor');
    const size = flatten(close.props.style).height as number;
    const slop = close.props.hitSlop as number;
    expect(size + slop * 2).toBeGreaterThanOrEqual(MIN_TOUCH);
  });
});

describe('MediaFilterEditor — disabled state is announced, not just dimmed', () => {
  it('the slider reports disabled while Original is selected', async () => {
    const { getByLabelText } = await renderEditor();
    // Original is the default selection and has nothing to modulate.
    expect(getByLabelText('Filter intensity').props.accessibilityState?.disabled).toBe(true);
  });

  it('the slider becomes enabled once a real filter is chosen', async () => {
    const { getByLabelText } = await renderEditor();
    await press(getByLabelText('Vivid'));
    expect(getByLabelText('Filter intensity').props.accessibilityState?.disabled).toBe(false);
  });

  it('Reset reports disabled while already on Original', async () => {
    const { getByLabelText } = await renderEditor();
    expect(getByLabelText('Reset to Original').props.accessibilityState?.disabled).toBe(true);
  });
});
