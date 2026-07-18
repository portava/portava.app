/**
 * About Me edit screen — clearing the legacy singular travel style.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. A profile with a legacy `travelStyle` shows it as a deselectable chip.
 * 2. Deselecting the chip and saving sends `travelStyle: null` (explicit
 *    null — not an empty string, and not omitted) to updateMyProfile.
 * 3. A profile without a legacy style renders no legacy section, and saving
 *    other changes never includes a `travelStyle` key.
 *
 * ## Why these tests exist
 *
 * The API clears the stuck legacy travel_style column only on an explicit
 * `travelStyle: null` PATCH. If the screen omitted the key (or sent ''),
 * the style would silently survive and keep showing on the public profile.
 */

import React from 'react';
import { render, act, waitFor, fireEvent, cleanup, screen } from '@testing-library/react-native';
import AboutScreen from '../about.tsx';
import { getMyProfile, updateMyProfile } from '../../../../src/services/profile.ts';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../../src/services/profile', () => ({
  ...jest.requireActual('../../../../src/services/profile'),
  getMyProfile: jest.fn(),
  updateMyProfile: jest.fn(),
}));

const mockGetMyProfile = getMyProfile as jest.Mock;
const mockUpdateMyProfile = updateMyProfile as jest.Mock;

function profileWith(overrides: Record<string, unknown> = {}) {
  return {
    interests: ['Food'],
    travelStyles: ['Adventure'],
    travelStyle: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('AboutScreen — legacy travel style clearing', () => {
  it('shows the legacy style chip and sends travelStyle: null after deselect + save', async () => {
    mockGetMyProfile.mockResolvedValue({
      ok: true,
      data: profileWith({ travelStyle: 'Vintage rail touring' }),
    });
    mockUpdateMyProfile.mockResolvedValue({
      ok: true,
      data: profileWith({ travelStyle: null }),
    });

    render(<AboutScreen />);
    await waitFor(() => expect(screen.getByText('Legacy travel style')).toBeTruthy());

    // Deselect the legacy chip.
    await act(async () => {
      fireEvent.press(screen.getByText('Vintage rail touring'));
    });

    // Save.
    await act(async () => {
      fireEvent.press(screen.getByText('Save changes'));
    });

    await waitFor(() => expect(mockUpdateMyProfile).toHaveBeenCalledTimes(1));
    const patch = mockUpdateMyProfile.mock.calls[0][0];
    expect(patch).toHaveProperty('travelStyle');
    expect(patch.travelStyle).toBeNull();
    expect(patch.travelStyle).not.toBe('');
  });

  it('re-selecting the chip before saving keeps the legacy style untouched', async () => {
    mockGetMyProfile.mockResolvedValue({
      ok: true,
      data: profileWith({ travelStyle: 'Vintage rail touring', travelStyles: [] }),
    });
    mockUpdateMyProfile.mockResolvedValue({ ok: true, data: profileWith() });

    render(<AboutScreen />);
    await waitFor(() => expect(screen.getByText('Legacy travel style')).toBeTruthy());

    // Deselect then re-select — form is back to original, save stays disabled.
    await act(async () => {
      fireEvent.press(screen.getByText('Vintage rail touring'));
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Vintage rail touring'));
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Save changes'));
    });

    expect(mockUpdateMyProfile).not.toHaveBeenCalled();
  });

  it('renders no legacy section without a legacy style, and other saves omit travelStyle', async () => {
    mockGetMyProfile.mockResolvedValue({ ok: true, data: profileWith() });
    mockUpdateMyProfile.mockResolvedValue({ ok: true, data: profileWith() });

    render(<AboutScreen />);
    await waitFor(() => expect(screen.getByText('Travel Style')).toBeTruthy());
    expect(screen.queryByText('Legacy travel style')).toBeNull();

    // Toggle an interest and save — patch must not contain travelStyle.
    await act(async () => {
      fireEvent.press(screen.getByText('Music'));
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Save changes'));
    });

    await waitFor(() => expect(mockUpdateMyProfile).toHaveBeenCalledTimes(1));
    expect(mockUpdateMyProfile.mock.calls[0][0]).not.toHaveProperty('travelStyle');
  });
});
