/**
 * (rent-a-buddy)/active.tsx — the Safe Return switch's check-in.
 *
 * THE DEFECT (found by another lane, fixed in lane tm-followups). The switch
 * sent `checkinType: 'safe_return_enabled'`, which is not a label of the
 * `rent_buddy_checkin_type` enum (0047 + 0113 — read from the migrations
 * below, not re-typed), so the insert was refused; and the call ended in
 * `.catch(() => {})`, so the traveller saw the switch ON over a check-in that
 * never landed.
 *
 * THE FIX. It sends `check_ok` with `response: 'ok'` — the enum's "I am OK"
 * value, which is what the switch's own comment says it records. It does NOT
 * send `start_safe_return`: the check-in route counts that as a DISTRESS
 * signal and opens a safety event against the other party, which a routine
 * opt-in must never do. A refused check-in turns the switch back OFF and says
 * so.
 *
 * Run: npx jest "app/\(rent-a-buddy\)/__tests__/activeSafeReturnCheckin"
 */
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// NOTE: intentional stub — expo-router is mocked so the screen can mount with a bookingId.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ bookingId: 'booking-1' }),
  useFocusEffect: (cb: () => unknown) => { require('react').useEffect(cb, []); },
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — layout insets are not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useStickyBarInset:     () => ({ inset: 100, onBarLayout: () => {} }),
  usePlainBottomInset:   () => 100,
  PlainBottomFiller:     () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useKeyboardVisible:    () => false,
  useBottomInset:        () => 100,
  useLayoverAwareBottomInset: () => 100,
}));

const mockSafetyCheckin = jest.fn();
jest.mock('../../../src/services/rentABuddy', () => ({
  ...jest.requireActual('../../../src/services/rentABuddy'),
  getBooking: jest.fn(async () => ({
    ok: true,
    data: { booking: { id: 'booking-1', city: 'Lisbon', status: 'in_progress', buddyDisplayName: 'Ana', hours: 2 } },
  })),
  safetyCheckin: (...args: unknown[]) => mockSafetyCheckin(...args),
}));

jest.mock('../../../src/services/safeReturn', () => ({
  ...jest.requireActual('../../../src/services/safeReturn'),
  getActiveSession: jest.fn(async () => ({ session: null })),
}));

import ActiveSessionScreen from '../active';

/** The enum's labels, read from the migrations that define and extend it. */
function checkinTypeLabels(): string[] {
  const dir = join(__dirname, '../../../../artifacts/api-server/migrations');
  const base = readFileSync(join(dir, '0047_rent_buddy.sql'), 'utf8');
  const create = /CREATE TYPE rent_buddy_checkin_type AS ENUM \(([^)]*)\)/.exec(base);
  const labels = [...(create?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  const added = readFileSync(join(dir, '0113_rent_buddy_lifecycle_fixes.sql'), 'utf8');
  for (const m of added.matchAll(/ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS '([^']+)'/g)) labels.push(m[1]!);
  return labels;
}

/** The host switch's current value (RN renders `value` on the host element). */
function screenSwitchValue(el: { props: Record<string, unknown> }): unknown {
  return el.props.value;
}

async function mountAndFindSafeReturnSwitch() {
  const screen = await render(<ActiveSessionScreen />);
  await waitFor(() => expect(screen.getByText('Safe Return check-in')).toBeTruthy());
  // The Safe Return switch is the first Switch in the safety panel.
  const sw = screen.getAllByRole('switch')[0]!;
  return { screen, sw };
}

describe('active.tsx — Safe Return check-in', () => {
  beforeEach(() => {
    mockSafetyCheckin.mockReset();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('the enum reader sees the fourteen labels (control)', () => {
    const labels = checkinTypeLabels();
    expect(labels).toContain('check_ok');
    expect(labels).toContain('start_safe_return');
    expect(labels).toHaveLength(14);
  });

  it('sends a check-in type the database accepts — the "I am OK" value, not a distress one', async () => {
    mockSafetyCheckin.mockResolvedValue({ ok: true, data: { ok: true } });
    const { sw } = await mountAndFindSafeReturnSwitch();
    await act(async () => { await fireEvent(sw, 'valueChange', true); });
    expect(mockSafetyCheckin).toHaveBeenCalledTimes(1);
    const [bookingId, payload] = mockSafetyCheckin.mock.calls[0]!;
    expect(bookingId).toBe('booking-1');
    expect(checkinTypeLabels()).toContain(payload.checkinType);
    expect(payload).toEqual({ checkinType: 'check_ok', response: 'ok' });
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(screenSwitchValue(sw)).toBe(true);
  });

  it('a refused check-in turns the switch back off and says so', async () => {
    mockSafetyCheckin.mockResolvedValue({ ok: false, error: 'db_error' });
    const { screen } = await mountAndFindSafeReturnSwitch();
    await act(async () => { await fireEvent(screen.getAllByRole('switch')[0]!, 'valueChange', true); });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    expect(screenSwitchValue(screen.getAllByRole('switch')[0]!)).toBe(false);
  });

  it('a thrown request (network) is a failure too, not silence', async () => {
    mockSafetyCheckin.mockRejectedValue(new Error('Network request failed'));
    const { screen } = await mountAndFindSafeReturnSwitch();
    await act(async () => { await fireEvent(screen.getAllByRole('switch')[0]!, 'valueChange', true); });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    expect(screenSwitchValue(screen.getAllByRole('switch')[0]!)).toBe(false);
  });
});
