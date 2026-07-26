/**
 * PostcardsTab — sentinel shapes
 *
 * Confirms that PostcardsTab renders a graceful state (not a crash or blank
 * screen) for every sentinel the API can now return:
 *
 *   { private: true, postcards: [] }      → private passport message
 *   { blocked: true, postcards: [] }      → content unavailable message
 *   { unavailable: true, postcards: [] }  → account unavailable message
 *
 * Also confirms the normal (non-sentinel) empty path still renders the
 * empty-state component for owners.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { PostcardsTab } from '../PostcardsTab.tsx';

// ── Mocks ──────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-router is a native Expo package; pulling
// requireActual drags in native modules that crash the jest-expo runner. All
// router surfaces used by PostcardsTab and its children are stubbed below.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useSegments: () => [],
  useFocusEffect: jest.fn(),
  useNavigation: () => ({
    navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link: ({ children }: { children: React.ReactNode }) => children as any,
  Redirect: (_props: { href: unknown }) => null,
  Stack: { Screen: (_props: unknown) => null },
  Tabs: { Screen: (_props: unknown) => null },
}));

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: ({ testID, ...rest }: { testID?: string; [k: string]: unknown }) =>
      React.createElement(View, { testID: testID ?? 'expo-image', ...rest }),
  };
});

// NOTE: intentionally exhaustive — sentinel views never invoke media hydration,
// and letting requireActual run would pull in live fetch/Supabase machinery.
// The stub surface (useHydratedMedia) is the only export PostcardsTab uses.
jest.mock('../../services/mediaUrl', () => ({
  useHydratedMedia: () => ({ resolved: {} }),
}));

// Mock PostcardEmptyState to avoid its animation/Animated.Value complexity.
jest.mock('../PostcardEmptyState', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    PostcardEmptyState: ({ isOwner }: { isOwner: boolean }) =>
      React.createElement(Text, { testID: 'postcard-empty-state' },
        isOwner ? 'Your adventure starts here' : 'No postcards yet',
      ),
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────

const NO_ACTIONS = undefined;

// ── Sentinel: private ──────────────────────────────────────────────────────

describe('PostcardsTab — sentinel: private', () => {
  it('renders the private passport heading without crashing', async () => {
    await render(
      <PostcardsTab
        postcards={[]}
        isOwner={false}
        actions={NO_ACTIONS}
        sentinel="private"
      />,
    );
    expect(screen.getByText('Private passport')).toBeTruthy();
  });

  it('renders the explanatory body text for the private sentinel', async () => {
    await render(
      <PostcardsTab
        postcards={[]}
        isOwner={false}
        actions={NO_ACTIONS}
        sentinel="private"
      />,
    );
    expect(
      screen.getByText(/This passport is private/i),
    ).toBeTruthy();
  });

  it('does NOT render the empty-state component for the private sentinel', async () => {
    await render(
      <PostcardsTab
        postcards={[]}
        isOwner={false}
        actions={NO_ACTIONS}
        sentinel="private"
      />,
    );
    expect(screen.queryByTestId('postcard-empty-state')).toBeNull();
  });
});

// ── Sentinel: blocked ──────────────────────────────────────────────────────

describe('PostcardsTab — sentinel: blocked', () => {
  it('renders the content-unavailable heading without crashing', async () => {
    await render(
      <PostcardsTab
        postcards={[]}
        isOwner={false}
        actions={NO_ACTIONS}
        sentinel="blocked"
      />,
    );
    expect(screen.getByText('Content unavailable')).toBeTruthy();
  });

  it('renders the explanatory body text for the blocked sentinel', async () => {
    await render(
      <PostcardsTab
        postcards={[]}
        isOwner={false}
        actions={NO_ACTIONS}
        sentinel="blocked"
      />,
    );
    expect(
      screen.getByText(/Postcard content is not available/i),
    ).toBeTruthy();
  });

  it('does NOT render the empty-state component for the blocked sentinel', async () => {
    await render(
      <PostcardsTab
        postcards={[]}
        isOwner={false}
        actions={NO_ACTIONS}
        sentinel="blocked"
      />,
    );
    expect(screen.queryByTestId('postcard-empty-state')).toBeNull();
  });
});

// ── Sentinel: unavailable ──────────────────────────────────────────────────

describe('PostcardsTab — sentinel: unavailable', () => {
  it('renders the account-unavailable heading without crashing', async () => {
    await render(
      <PostcardsTab
        postcards={[]}
        isOwner={false}
        actions={NO_ACTIONS}
        sentinel="unavailable"
      />,
    );
    expect(screen.getByText('Account unavailable')).toBeTruthy();
  });

  it('renders the explanatory body text for the unavailable sentinel', async () => {
    await render(
      <PostcardsTab
        postcards={[]}
        isOwner={false}
        actions={NO_ACTIONS}
        sentinel="unavailable"
      />,
    );
    expect(
      screen.getByText(/This account is no longer available/i),
    ).toBeTruthy();
  });

  it('does NOT render the empty-state component for the unavailable sentinel', async () => {
    await render(
      <PostcardsTab
        postcards={[]}
        isOwner={false}
        actions={NO_ACTIONS}
        sentinel="unavailable"
      />,
    );
    expect(screen.queryByTestId('postcard-empty-state')).toBeNull();
  });
});

// ── Normal empty path — no sentinel ───────────────────────────────────────

describe('PostcardsTab — no sentinel, empty list', () => {
  it('renders the empty-state component for an owner with no postcards', async () => {
    await render(
      <PostcardsTab
        postcards={[]}
        isOwner
        actions={NO_ACTIONS}
      />,
    );
    expect(screen.getByTestId('postcard-empty-state')).toBeTruthy();
  });

  it('renders the viewer empty-state (no CTA) when not the owner', async () => {
    await render(
      <PostcardsTab
        postcards={[]}
        isOwner={false}
        actions={NO_ACTIONS}
      />,
    );
    expect(screen.getByText('No postcards yet')).toBeTruthy();
  });
});
