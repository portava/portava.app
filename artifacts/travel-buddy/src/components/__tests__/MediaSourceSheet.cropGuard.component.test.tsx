/**
 * MediaSourceSheet — crop-editor guard tests
 *
 * Verifies that effectiveAllowsEditing is correctly suppressed when
 * allowsVideo=true, and preserved when allowsVideo=false.
 *
 * Spec (task 2410):
 *   • launchImageLibraryAsync is called with allowsEditing=false when allowsVideo=true
 *   • launchImageLibraryAsync is called with allowsEditing=true  when allowsVideo=false
 *     and the allowsEditing prop is true
 *
 * Run with: pnpm test:component
 *
 * Modal proxy pattern: replaces <Modal> with a synchronous View so that
 * Modal's animation lifecycle doesn't leave a floating act() scope that
 * corrupts state updates in later assertions.  All other react-native exports
 * fall through untouched.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { MediaSourceSheet } from '../ui/MediaSourceSheet.tsx';

// ── Modal proxy ────────────────────────────────────────────────────────────────
// Replaces only Modal with a synchronous View wrapper; everything else is real.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const R = require('react') as typeof import('react');
        return ({ children, visible }: { children: R.ReactNode; visible?: boolean }) =>
          visible ? R.createElement(target.View as React.ComponentType, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

// ── expo-image-picker mock ─────────────────────────────────────────────────────
// Permissions always granted; launchImageLibraryAsync is a spy so we can
// assert on the exact options it receives.
const mockLaunchImageLibraryAsync = jest.fn().mockResolvedValue({
  canceled: true,
  assets: [],
});

// NOTE: intentionally exhaustive — expo-image-picker requires native camera
// and media-library modules unavailable in the jest-expo runner.  We need to
// intercept launchImageLibraryAsync to assert on the exact options it receives,
// so requireActual would pull in the real (crashing) native module.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  launchImageLibraryAsync: (...args: unknown[]) =>
    mockLaunchImageLibraryAsync(...args),
  MediaTypeOptions: { Images: 'Images', Videos: 'Videos', All: 'All' },
}));

// ── helpers ────────────────────────────────────────────────────────────────────

async function renderSheet(props: {
  allowsVideo: boolean;
  allowsEditing?: boolean;
  aspect?: [number, number];
}) {
  return render(
    <MediaSourceSheet
      visible
      onClose={jest.fn()}
      onResult={jest.fn()}
      {...props}
    />,
  );
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('MediaSourceSheet — crop-editor guard (effectiveAllowsEditing)', () => {
  beforeEach(() => {
    mockLaunchImageLibraryAsync.mockClear();
  });

  it('passes allowsEditing=false to the library picker when allowsVideo=true', async () => {
    // allowsEditing=true is requested by the caller, but the guard must override
    // it to false because video picks are enabled — the crop UI would be a no-op
    // for video assets on iOS and confuse users.
    const { getByLabelText } = await renderSheet({
      allowsVideo: true,
      allowsEditing: true,
    });

    await fireEvent.press(getByLabelText('Choose photo or video from library'));

    await waitFor(() => {
      expect(mockLaunchImageLibraryAsync).toHaveBeenCalledTimes(1);
    });

    const opts = mockLaunchImageLibraryAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.allowsEditing).toBe(false);
  });

  it('passes allowsEditing=true to the library picker when allowsVideo=false and allowsEditing=true', async () => {
    // Pure-photo picker — crop editor must be active.
    const { getByLabelText } = await renderSheet({
      allowsVideo: false,
      allowsEditing: true,
      aspect: [1, 1],
    });

    await fireEvent.press(getByLabelText('Choose photo from library'));

    await waitFor(() => {
      expect(mockLaunchImageLibraryAsync).toHaveBeenCalledTimes(1);
    });

    const opts = mockLaunchImageLibraryAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.allowsEditing).toBe(true);
  });

  it('passes allowsEditing=false when allowsVideo=false but allowsEditing prop is false', async () => {
    // Caller explicitly disables the crop editor — guard must not turn it on.
    const { getByLabelText } = await renderSheet({
      allowsVideo: false,
      allowsEditing: false,
    });

    await fireEvent.press(getByLabelText('Choose photo from library'));

    await waitFor(() => {
      expect(mockLaunchImageLibraryAsync).toHaveBeenCalledTimes(1);
    });

    const opts = mockLaunchImageLibraryAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.allowsEditing).toBe(false);
  });

  it('does not pass aspect to the picker when effectiveAllowsEditing is false', async () => {
    // When the crop editor is suppressed, aspect must not be forwarded either.
    const { getByLabelText } = await renderSheet({
      allowsVideo: true,
      allowsEditing: true,
      aspect: [4, 3],
    });

    await fireEvent.press(getByLabelText('Choose photo or video from library'));

    await waitFor(() => {
      expect(mockLaunchImageLibraryAsync).toHaveBeenCalledTimes(1);
    });

    const opts = mockLaunchImageLibraryAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.aspect).toBeUndefined();
  });

  it('forwards aspect to the picker when effectiveAllowsEditing is true', async () => {
    const { getByLabelText } = await renderSheet({
      allowsVideo: false,
      allowsEditing: true,
      aspect: [4, 3],
    });

    await fireEvent.press(getByLabelText('Choose photo from library'));

    await waitFor(() => {
      expect(mockLaunchImageLibraryAsync).toHaveBeenCalledTimes(1);
    });

    const opts = mockLaunchImageLibraryAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.aspect).toEqual([4, 3]);
  });
});
