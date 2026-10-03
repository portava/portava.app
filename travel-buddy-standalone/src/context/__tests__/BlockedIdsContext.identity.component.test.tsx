/**
 * BlockedIdsContext — a block list belongs to ONE account (census-trust §31,
 * the client half of the block sweep).
 *
 * The provider loaded the list once per app session, behind a `loaded` ref
 * that nothing ever reset. Measured before this change:
 *   1. SIGN-OUT left the previous account's block list in memory, and the
 *      next account to sign in on the device NEVER loaded its own — every
 *      surface that filters people client-side (crew map, circle members,
 *      saved people, trips, reviews…) filtered against someone else's blocks,
 *      and showed the people the new account had blocked.
 *   2. A slow response for the previous account landed after the switch and
 *      overwrote the new one (no request sequencing).
 *   3. A failed load was presented exactly like "you have blocked nobody".
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Text } from 'react-native';
import { render, waitFor, screen, cleanup, act } from '@testing-library/react-native';
import { BlockedIdsProvider, useBlockedIds } from '../BlockedIdsContext.tsx';
import { getBlockList, getBlockerIds } from '../../services/blocks.ts';

let mockSession: { isAuthed: boolean; configured: boolean; userId: string | null } = {
  isAuthed: true, configured: true, userId: 'user-a',
};

// NOTE: a bare factory on purpose — the provider reads only these three
// fields, and the real SessionContext pulls in Supabase and native storage.
jest.mock('../SessionContext.tsx', () => ({
  useSession: () => mockSession,
}));

// NOTE: requireActual keeps the module's other exports; only the two reads the
// provider makes are replaced.
jest.mock('../../services/blocks.ts', () => ({
  ...jest.requireActual('../../services/blocks.ts'),
  getBlockList: jest.fn(),
  getBlockerIds: jest.fn(),
}));

const mockGetBlockList = getBlockList as jest.Mock;
const mockGetBlockerIds = getBlockerIds as jest.Mock;

function Probe() {
  // `loadFailed === true`, not `String(loadFailed)`: the identity cases must go
  // red for the identity defect alone, not because the field is new.
  const ctx = useBlockedIds() as ReturnType<typeof useBlockedIds> & { loadFailed?: boolean };
  return (
    <Text testID="probe">
      {[...ctx.blockedIds].sort().join(',')}|{[...ctx.blockerIds].sort().join(',')}|{String(ctx.loadFailed === true)}
    </Text>
  );
}

const probe = () => screen.getByTestId('probe').props.children.join('');

function listFor(user: string, blocked: string[], blockers: string[]) {
  mockGetBlockList.mockImplementation(async () => ({ ok: true, data: blocked.map((id) => ({ id })) }));
  mockGetBlockerIds.mockImplementation(async () => ({ ok: true, data: blockers }));
  void user;
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  mockSession = { isAuthed: true, configured: true, userId: 'user-a' };
});

describe('BlockedIdsProvider — the list follows the signed-in account', () => {
  it("signing in as another account replaces the list with THAT account's", async () => {
    listFor('user-a', ['x-blocked-by-a'], ['y-blocks-a']);
    const ui = <BlockedIdsProvider><Probe /></BlockedIdsProvider>;
    const { rerender } = await render(ui);
    await waitFor(() => expect(probe()).toBe('x-blocked-by-a|y-blocks-a|false'));

    listFor('user-b', ['z-blocked-by-b'], []);
    mockSession = { isAuthed: true, configured: true, userId: 'user-b' };
    await act(async () => { rerender(<BlockedIdsProvider><Probe /></BlockedIdsProvider>); });
    await waitFor(() => expect(probe()).toBe('z-blocked-by-b||false'));
    expect(mockGetBlockList).toHaveBeenCalledTimes(2);
  });

  it('signing out clears the list — the next account never sees the last one\'s blocks', async () => {
    listFor('user-a', ['x-blocked-by-a'], []);
    const { rerender } = await render(<BlockedIdsProvider><Probe /></BlockedIdsProvider>);
    await waitFor(() => expect(probe()).toBe('x-blocked-by-a||false'));

    mockSession = { isAuthed: false, configured: true, userId: null };
    await act(async () => { rerender(<BlockedIdsProvider><Probe /></BlockedIdsProvider>); });
    await waitFor(() => expect(probe()).toBe('||false'));
  });

  it("a SLOW response for the previous account cannot overwrite the new account's list", async () => {
    let resolveA: (v: unknown) => void = () => {};
    mockGetBlockList.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    mockGetBlockerIds.mockImplementationOnce(async () => ({ ok: true, data: [] }));
    const { rerender } = await render(<BlockedIdsProvider><Probe /></BlockedIdsProvider>);

    listFor('user-b', ['z-blocked-by-b'], []);
    mockSession = { isAuthed: true, configured: true, userId: 'user-b' };
    await act(async () => { rerender(<BlockedIdsProvider><Probe /></BlockedIdsProvider>); });
    await waitFor(() => expect(probe()).toBe('z-blocked-by-b||false'));

    await act(async () => { resolveA({ ok: true, data: [{ id: 'x-blocked-by-a' }] }); });
    expect(probe()).toBe('z-blocked-by-b||false');
  });

  it('a FAILED load is reported as such, not as "you have blocked nobody"', async () => {
    mockGetBlockList.mockImplementation(async () => ({ ok: false, error: 'Failed to load block list' }));
    mockGetBlockerIds.mockImplementation(async () => ({ ok: true, data: [] }));
    await render(<BlockedIdsProvider><Probe /></BlockedIdsProvider>);
    await waitFor(() => expect(probe()).toBe('||true'));
  });
});
