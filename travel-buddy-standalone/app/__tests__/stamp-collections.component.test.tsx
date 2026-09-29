/**
 * Stamp collections & catalog — TM-social, PASS-F09.
 *
 * GET /stamps/me/collections and GET /stamps/definitions had no caller. The
 * screen's states must each be true: "not switched on" for the v2 flag's 503
 * (not an outage, not an empty catalog), "couldn't load" with a retry for an
 * outage, the empty state for a real empty answer, and progress read from the
 * server (never assumed "0 of N").
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import StampCollectionsScreen from '../stamp-collections.tsx';

jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), router: { push: jest.fn(), back: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  ...jest.requireActual('../../src/hooks/useNavBarCollapse'),
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));
jest.mock('../../src/services/stamps', () => ({
  ...jest.requireActual('../../src/services/stamps'),
  getMyStampCollections: jest.fn(),
  getStampCatalog: jest.fn(),
}));
const stamps = require('../../src/services/stamps');

const C = (id: string, name: string, earned: number, total: number) => ({ id, slug: id, name, description: null, iconUrl: null, total, earned, complete: total > 0 && earned === total });

jest.setTimeout(20000);

describe('Stamp collections screen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('collections show earned of total, and Complete when done', async () => {
    stamps.getMyStampCollections.mockResolvedValue({ ok: true, data: [C('c1', 'Balkans', 1, 2), C('c2', 'Islands', 3, 3)] });
    const { findByText, getByText } = await render(<StampCollectionsScreen />);
    await findByText('1 of 2');
    expect(getByText('Complete')).toBeTruthy();
  });

  it('the v2 flag being off is "not switched on", not an error and not empty', async () => {
    stamps.getMyStampCollections.mockResolvedValue({ ok: false, disabled: true, message: 'Stamp System v2 is not yet enabled.' });
    const { findByText, queryByText } = await render(<StampCollectionsScreen />);
    await findByText("Stamp collections aren't switched on yet");
    expect(queryByText('No collections yet')).toBeNull();
    expect(queryByText('Something went wrong')).toBeNull();
  });

  it('an outage is an error with a retry, never "No collections yet"', async () => {
    stamps.getMyStampCollections
      .mockResolvedValueOnce({ ok: false, disabled: false, message: 'db_error' })
      .mockResolvedValueOnce({ ok: true, data: [C('c1', 'Balkans', 0, 2)] });
    const { findByText, queryByText, getByLabelText } = await render(<StampCollectionsScreen />);
    await findByText("We couldn't load your collections.");
    expect(queryByText('No collections yet')).toBeNull();
    await fireEvent.press(getByLabelText('Retry'));
    await findByText('0 of 2');
  });

  it('a real empty answer is the empty state', async () => {
    stamps.getMyStampCollections.mockResolvedValue({ ok: true, data: [] });
    const { findByText } = await render(<StampCollectionsScreen />);
    await findByText('No collections yet');
  });

  it('the catalog loads on first show of its tab, grouped by category', async () => {
    stamps.getMyStampCollections.mockResolvedValue({ ok: true, data: [] });
    stamps.getStampCatalog.mockResolvedValue({ ok: true, data: [
      { id: 'd1', slug: 'a', name: 'Zagreb', description: null, stampType: 'city', category: 'places', rarity: 'common', iconUrl: null, artworkUrl: null, city: 'Zagreb', country: 'Croatia' },
      { id: 'd2', slug: 'b', name: 'Night owl', description: null, stampType: 'milestone', category: 'milestones', rarity: 'rare', iconUrl: null, artworkUrl: null, city: null, country: null },
    ] });
    const { findByText, getByTestId, getByText } = await render(<StampCollectionsScreen />);
    await findByText('No collections yet');
    expect(stamps.getStampCatalog).not.toHaveBeenCalled();
    await fireEvent.press(getByTestId('stamp-collections-seg-catalog'));
    await findByText('Zagreb');
    expect(getByText('Night owl')).toBeTruthy();
    expect(getByText('places')).toBeTruthy();
    expect(getByText('milestones')).toBeTruthy();
  });
});
