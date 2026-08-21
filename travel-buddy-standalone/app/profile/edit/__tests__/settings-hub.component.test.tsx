/**
 * Consolidated settings hub — privacy and location routes stay reachable.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import EditSettingsHub from '../index.tsx';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

jest.mock('../../../../src/components/settings/SettingsUI', () => {
  const R = require('react');
  const { View, Text, Pressable } = require('react-native');
  return {
    SettingsScreen: ({ children }: { children: React.ReactNode }) =>
      R.createElement(View, null, children),
    SettingsSection: ({ children }: { children: React.ReactNode }) =>
      R.createElement(View, null, children),
    SettingsDivider: () => null,
    SettingsRow: ({ title, onPress }: { title: string; onPress?: () => void }) =>
      R.createElement(
        Pressable,
        { accessibilityRole: 'button', accessibilityLabel: title, onPress },
        R.createElement(Text, null, title),
      ),
  };
});

describe('Edit & Settings hub routes', () => {
  it('opens the existing privacy and location destinations', async () => {
    const mockPush = router.push as jest.Mock;
    await render(<EditSettingsHub />);

    fireEvent.press(screen.getByRole('button', { name: 'Privacy & Visibility' }));
    fireEvent.press(screen.getByRole('button', { name: 'Location & Availability' }));

    expect(mockPush.mock.calls.map((call) => call[0])).toEqual([
      '/profile/edit/privacy',
      '/profile/edit/location',
    ]);
  });
});