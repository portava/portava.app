/**
 * Telegraph §6.4 — the content drawer and object-aware search, rendered.
 *
 *   "MEDIA | PLACES | PORTAVA | VOICE | GIFS | LINKS | FILES … The content
 *    drawer is a structured index over exchanged content, not a second storage
 *    copy. Object-aware search must respect current authorization and
 *    unsent/deleted state."
 *
 * The authorization and tombstone halves are the SERVER's to enforce and are
 * asserted in `artifacts/api-server/src/test/telegraphKinds.test.ts`. What this
 * file settles is the surface: that the seven tabs exist with their counts,
 * that the list is the index the server returned (never a second copy the
 * client keeps), that search runs against the server, and that a failed read
 * SAYS SO instead of showing an empty drawer.
 *
 * MODAL RULE 6 (src/components/__tests__/TESTING.md): the sheet is Modal-rooted
 * and does async work, so it lives in its own file with the Proxy Modal mock.
 *
 * SHOWN RED before commit, each reverted:
 *   • the failure branch replaced with an empty list → "a failed drawer read
 *     SAYS SO" RED.
 *   • `DRAWER_TABS` trimmed to four → the seven-tab test RED.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — TESTING.md Rule 6.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react');
        return ({ children, visible }: any) =>
          visible ? R.createElement(target.View, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

// NOTE: intentional stub — kindsApi reaches lib/supabase, which builds a client
// at import time and fails outside an Expo runtime. The sheet's own logic is
// the real one.
jest.mock('../kinds/kindsApi.ts', () => {
  const actual = jest.requireActual('../kinds/kindsApi.ts');
  return {
    ...actual,
    sendTypedMessage: jest.fn(),
    fetchDrawer: jest.fn(),
    searchThread: jest.fn(),
  };
});

import { ContentDrawerSheet } from '../drawer/ContentDrawerSheet.tsx';
import { fetchDrawer, searchThread, DRAWER_TABS } from '../kinds/kindsApi.ts';

const mockedFetchDrawer = fetchDrawer as jest.MockedFunction<typeof fetchDrawer>;
const mockedSearch = searchThread as jest.MockedFunction<typeof searchThread>;

const drawerData = {
  ok: true as const,
  data: {
    threadId: 't1',
    tab: null,
    tabs: DRAWER_TABS,
    counts: { MEDIA: 3, PLACES: 2, PORTAVA: 1, VOICE: 0, GIFS: 1, LINKS: 1, FILES: 0 },
    items: [
      { id: 'm1', senderId: 'u1', createdAt: 'x', tab: 'MEDIA' as const, msgType: 'text', subtype: null, previewUrl: null, title: 'the rooftop', links: [] },
      { id: 'm2', senderId: 'u1', createdAt: 'x', tab: 'LINKS' as const, msgType: 'text', subtype: null, previewUrl: null, title: null, links: ['https://example.com/bar'] },
    ],
    indexOnly: true,
    scanned: 12,
    truncated: false,
  },
};

beforeEach(() => {
  mockedFetchDrawer.mockReset();
  mockedSearch.mockReset();
});

describe('§6.4 — the content drawer', () => {
  it('renders the seven tabs with the counts the server computed', async () => {
    mockedFetchDrawer.mockResolvedValue(drawerData as any);
    await render(<ContentDrawerSheet visible threadId="t1" onClose={() => {}} />);
    expect(screen.getByTestId('telegraph-content-drawer')).toBeTruthy();
    expect(DRAWER_TABS).toHaveLength(7);
    for (const tab of DRAWER_TABS) {
      expect(screen.getByTestId(`telegraph-drawer-tab-${tab}`)).toBeTruthy();
    }
    await waitFor(() => expect(screen.getByText('MEDIA 3')).toBeTruthy());
    expect(screen.getByText('VOICE 0')).toBeTruthy();
  });

  it('lists the index it was GIVEN — including a link row', async () => {
    mockedFetchDrawer.mockResolvedValue(drawerData as any);
    await render(<ContentDrawerSheet visible threadId="t1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('the rooftop')).toBeTruthy());
    expect(screen.getByText('https://example.com/bar')).toBeTruthy();
  });

  it('a failed drawer read SAYS SO rather than showing an empty drawer', async () => {
    mockedFetchDrawer.mockResolvedValue({ ok: false, error: 'db_error' } as any);
    await render(<ContentDrawerSheet visible threadId="t1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('telegraph-drawer-failed')).toBeTruthy());
    expect(screen.queryByTestId('telegraph-drawer-items')).toBeNull();
  });

  it('runs object-aware search against the server and renders the matches', async () => {
    mockedFetchDrawer.mockResolvedValue(drawerData as any);
    mockedSearch.mockResolvedValue({
      ok: true,
      data: {
        threadId: 't1', query: 'rooftop', tab: null, scanned: 12,
        results: [{ id: 'm1', senderId: 'u1', createdAt: 'x', msgType: 'text', subtype: null, tab: 'MEDIA', snippet: 'the rooftop' }],
      },
    } as any);
    await render(<ContentDrawerSheet visible threadId="t1" onClose={() => {}} />);
    const input = screen.getByTestId('telegraph-drawer-search-input');
    fireEvent.changeText(input, 'rooftop');
    await waitFor(() => expect(screen.getByTestId('telegraph-drawer-search-input').props.value).toBe('rooftop'));
    fireEvent(screen.getByTestId('telegraph-drawer-search-input'), 'submitEditing');
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledWith('t1', 'rooftop', null));
    await waitFor(() => expect(screen.getByTestId('telegraph-drawer-results')).toBeTruthy());
  });

  it('renders nothing when closed', async () => {
    await render(<ContentDrawerSheet visible={false} threadId="t1" onClose={() => {}} />);
    expect(screen.queryByTestId('telegraph-content-drawer')).toBeNull();
    expect(mockedFetchDrawer).not.toHaveBeenCalled();
  });
});
