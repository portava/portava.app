/**
 * sign-in.component.test.tsx
 *
 * Render test for the redesigned login / welcome screen.
 * Confirms that the new brand components, social buttons, form fields,
 * and primary CTA are all present in the tree.
 *
 * Deliberately keeps mocks minimal — we mock only things that would crash
 * the test environment (network, native modules, router).
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

// ── Router ────────────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn() },
}));

// ── Safe area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── Session context ───────────────────────────────────────────────────────────
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ isAuthed: false, loading: false, configured: true }),
}));

// ── Supabase guard ────────────────────────────────────────────────────────────
jest.mock('../../../src/lib/supabase', () => ({
  isSupabaseConfigured: true,
}));

// ── Auth services (stub — no network calls) ───────────────────────────────────
jest.mock('../../../src/services/auth', () => ({
  signIn:                jest.fn().mockResolvedValue({ error: null }),
  signUp:                jest.fn().mockResolvedValue({ error: null, userId: 'u1' }),
  requestPasswordReset:  jest.fn().mockResolvedValue({ error: null }),
  lookupUsernameByEmail: jest.fn().mockResolvedValue({ handle: 'traveler', error: null }),
}));

jest.mock('../../../src/services/profile', () => ({
  getMyProfile: jest.fn().mockResolvedValue({ ok: true, data: { displayName: 'Test', username: 'test' } }),
}));

// ── react-native-svg (simplified stub for test renderer) ─────────────────────
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  const stub = (name: string) =>
    ({ children, ...props }: any) =>
      React.createElement(View, { testID: `svg-${name}`, ...props }, children);

  return {
    __esModule: true,
    default: stub('Svg'),
    Svg:            stub('Svg'),
    Path:           stub('Path'),
    Rect:           stub('Rect'),
    G:              stub('G'),
    Defs:           stub('Defs'),
    LinearGradient: stub('LinearGradient'),
    Stop:           stub('Stop'),
    Text:           ({ children, ...p }: any) => React.createElement(Text, p, children),
    TextPath:       ({ children, ...p }: any) => React.createElement(Text, p, children),
    Line:           stub('Line'),
  };
});

// ── expo-linear-gradient ──────────────────────────────────────────────────────
jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...p }: any) => React.createElement(View, p, children),
  };
});

// ── @expo/vector-icons ────────────────────────────────────────────────────────
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    Ionicons: ({ name, ...p }: any) =>
      React.createElement(Text, { testID: `icon-${name}`, ...p }, name),
  };
});

// ── Background images (no network) ───────────────────────────────────────────
jest.mock('../../../constants/loginBackgrounds', () => ({
  LOGIN_BACKGROUNDS: [
    { uri: 'https://example.com/img1.jpg' },
    { uri: 'https://example.com/img2.jpg' },
  ],
  BG_DISPLAY_DURATION_MS: 99999,
  BG_FADE_DURATION_MS:    1,
}));

// ─────────────────────────────────────────────────────────────────────────────

import SignIn from '../sign-in';

describe('SignIn screen — redesign smoke test', () => {
  it('renders PortavaLogoMark', async () => {
    await render(<SignIn />);
    // PortavaLogoMark renders an Svg element with the accessibility label
    expect(screen.getByLabelText('Portava logo mark')).toBeTruthy();
  });

  it('renders PortavaWordmark ("PORTAV" and "A" in teal)', async () => {
    await render(<SignIn />);
    expect(screen.getByText('PORTAV')).toBeTruthy();
    // The teal "A" segment
    expect(screen.getByText('A')).toBeTruthy();
  });

  it('renders "Continue with Apple" social button', async () => {
    await render(<SignIn />);
    expect(screen.getByLabelText('Continue with Apple')).toBeTruthy();
  });

  it('renders "Continue with Google" social button', async () => {
    await render(<SignIn />);
    expect(screen.getByLabelText('Continue with Google')).toBeTruthy();
  });

  it('renders Email input', async () => {
    await render(<SignIn />);
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });

  it('renders Password input', async () => {
    await render(<SignIn />);
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('renders the Sign In gradient button', async () => {
    await render(<SignIn />);
    expect(screen.getByLabelText('Sign In')).toBeTruthy();
  });

  it('renders the New to Portava passport card', async () => {
    await render(<SignIn />);
    expect(screen.getByLabelText('Portava passport')).toBeTruthy();
  });

  it('renders "Create your Passport" CTA', async () => {
    await render(<SignIn />);
    expect(screen.getByLabelText('Create your Passport')).toBeTruthy();
  });

  it('renders all five feature icons', async () => {
    await render(<SignIn />);
    expect(screen.getByLabelText(/MEET/)).toBeTruthy();
    expect(screen.getByLabelText(/DISCOVER/)).toBeTruthy();
    expect(screen.getByLabelText(/JOIN/)).toBeTruthy();
    expect(screen.getByLabelText(/EXPLORE/)).toBeTruthy();
    expect(screen.getByLabelText(/SHARE/)).toBeTruthy();
  });
});
