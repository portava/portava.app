/**
 * §15 Memory search is REACHABLE — a screen nothing mounts is not built.
 *
 * Highlights/Memories Development Architecture Spec v1 §15 ("Memory Retrieval
 * and Search"). Census H110–H114.
 *
 * WHAT WAS WRONG. The server has `POST /api/memories/search`, and this client
 * has a complete, tested screen for it — `src/features/memories/
 * MemorySearchScreen.tsx`, with the three non-empty answers (`revoked`,
 * `refused`, `unavailable`) rendered as themselves per §28.11. It was
 * imported by nothing outside its own test: no file under `app/` referenced
 * it and no entry existed in `PORTAVA_ROUTES`, so there was no path by which
 * any person could open it. A retrieval requirement whose only surface cannot
 * be navigated to is not satisfied on the client, however correct the screen.
 *
 * This file asserts the mount, not the screen's behaviour — that is
 * `src/features/memories/__tests__/MemorySearchScreen.component.test.tsx`.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator
// context this unit does not mount; the route only calls back() and push().
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({}),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { PORTAVA_ROUTES } from '../../../src/navigation/portavaRoutes.ts';
import MemorySearchRoute from '../search.tsx';

describe('§15 memory search has a route', () => {
  it('is registered in PORTAVA_ROUTES', () => {
    const entry = PORTAVA_ROUTES.find((r) => r.path === 'memory/search');
    expect(entry).toBeDefined();
    // Somebody else's memories are never searchable from here; the server
    // derives the namespace from the authenticated viewer, and the route is
    // the owner's own.
    expect(entry?.requiresAuth).toBe(true);
  });

  it('the route renders the §15 search screen', async () => {
    await render(<MemorySearchRoute />);
    expect(screen.getByTestId('memory-search-screen')).toBeTruthy();
    expect(screen.getByTestId('memory-search-input')).toBeTruthy();
  });
});
