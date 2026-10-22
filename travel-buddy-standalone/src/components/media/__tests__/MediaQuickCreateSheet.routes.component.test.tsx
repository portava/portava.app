/**
 * MediaQuickCreateSheet.routes.component.test.tsx
 *
 * WHAT THE OWNER SAW (iPhone, 2026-10-22). In the Media tab's create sheet,
 * Story, Memory, Event, Trip, Plan and Group activity all opened /create — the
 * camera. The standard rows shared one handler that never looked at which row
 * was tapped, while the app's other create menu (CreateHubSheet) sent the
 * same labels to their own screens.
 *
 * WHAT THIS SUITE PINS:
 *   - every live row closes the sheet and then pushes ITS OWN route (Event →
 *     /events/create, not /create), after the sheet's 80 ms close delay;
 *   - for every label both menus show, this sheet opens exactly what the
 *     Create hub opens (or, like the hub, nothing);
 *   - a row with no live screen (Plan, Group activity) is a disabled "Soon"
 *     row that never navigates — in particular never falls back to /create.
 *
 * Run with: npx jest --forceExit src/components/media/__tests__/MediaQuickCreateSheet.routes.component.test.tsx
 */
import React from 'react';
import { screen, render, fireEvent, act } from '@testing-library/react-native';
import { MediaQuickCreateSheet } from '../MediaQuickCreateSheet.tsx';
import { CreateHubSheet } from '../../create/CreateHubSheet.tsx';

// NOTE: intentional stub — both sheets only call `router.push`; spreading
// requireActual pulls in expo-router's native navigation runtime, which isn't
// available under Jest.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

const { router: mockRouter } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
const pushMock = mockRouter.push;

// NOTE: intentional stub — only the insets hook is used by these sheets; the
// real module needs native safe-area measurement that isn't available under Jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — the sheet reads only `isEnabled`, and the real
// provider fetches flags from Supabase. The Add-a-Gem flag is on so its row shows.
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => k === 'MEDIA_HIDDEN_GEMS_CREATE_ENABLED' }),
}));

/** Press a row, let the deferred navigation fire, and return what was pushed. */
async function pushedBy(label: string): Promise<unknown[]> {
  pushMock.mockClear();
  await fireEvent.press(screen.getByLabelText(label));
  await act(async () => {
    jest.advanceTimersByTime(320); // the slower of the two sheets' close delays
  });
  return pushMock.mock.calls.map((call) => call[0]);
}

describe('MediaQuickCreateSheet — each entry opens its own screen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    pushMock.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('closes the sheet, then pushes the route of the row that was tapped', async () => {
    const liveEntries: Array<[string, string]> = [
      ['Add a Gem', '/media/add-gem'],
      ['Post', '/create'],
      ['Story', '/stories'],
      ['Memory', '/memory/new'],
      ['Event', '/events/create'],
      ['Trip', '/trip/new'],
    ];

    const onClose = jest.fn();
    await render(<MediaQuickCreateSheet visible onClose={onClose} showGemEntry />);

    for (const [label, expectedRoute] of liveEntries) {
      onClose.mockClear();
      pushMock.mockClear();

      await fireEvent.press(screen.getByLabelText(label));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(pushMock).not.toHaveBeenCalled(); // deferred until the sheet has closed

      await act(async () => {
        jest.advanceTimersByTime(80);
      });
      expect({ label, pushed: pushMock.mock.calls }).toEqual({ label, pushed: [[expectedRoute]] });
    }
  });

  it('opens what the Create hub opens for every label both menus show', async () => {
    const shared = ['Post', 'Story', 'Memory', 'Event', 'Trip', 'Plan'];

    await render(<CreateHubSheet visible onClose={jest.fn()} />);
    const hub: Record<string, unknown[]> = {};
    for (const label of shared) hub[label] = await pushedBy(label);
    // The hub's own suite pins its routes; this guards that the reading is real.
    expect(hub.Event).toEqual(['/events/create']);

    await screen.rerender(<MediaQuickCreateSheet visible onClose={jest.fn()} />);
    for (const label of shared) {
      expect({ label, pushed: await pushedBy(label) }).toEqual({ label, pushed: hub[label] });
    }
  });

  it('shows a row with no live screen as a disabled "Soon" row that never navigates', async () => {
    const onClose = jest.fn();
    await render(<MediaQuickCreateSheet visible onClose={onClose} />);

    expect(screen.getAllByText('Soon')).toHaveLength(2);
    for (const label of ['Plan', 'Group activity']) {
      const row = screen.getByLabelText(label);
      expect(row.props.accessibilityState?.disabled).toBe(true);
      expect(await pushedBy(label)).toEqual([]); // not /create
    }
    expect(onClose).not.toHaveBeenCalled();
  });
});
