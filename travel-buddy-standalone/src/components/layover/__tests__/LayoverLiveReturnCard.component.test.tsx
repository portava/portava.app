/**
 * census-layover L157 — live return assistance: adaptive, press-gated, foreground-only location sensing
 * (LAYOVER 165, lane B2-CREW). L164's boundary: location is requested when the traveller enables live return
 * assistance, not because Layover exists.
 *
 * The location door and the one-shot sampler are replaced so the test can count exactly what the card asks the OS
 * for and when: nothing before the press; ONE door request on the press; then one-shot samples at the cadence the
 * certified rung picks (10 min well before the deadline, 30 s while heading back); nothing after "Turn off".
 * NATIVE / DEVICE BEHAVIOUR IS NOT VERIFIED HERE: a real OS prompt, real fixes and real battery behaviour need a device.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverLiveReturnCard } from '../LayoverLiveReturnCard.tsx';
import { requestLocationForUserAction } from '../../../lib/location/locationRequestDoor.ts';
import { sampleLiveReturnFix } from '../../../lib/location/layoverLiveReturnSampler.ts';
import * as Battery from 'expo-battery';

// NOTE: intentionally exhaustive — the real door imports services/location.ts, which loads expo-location's native
// module; this test counts the door's calls, so the door itself is the stand-in.
jest.mock('../../../lib/location/locationRequestDoor.ts', () => ({
  USER_PRESS_LIVE_RETURN: { trigger: 'user_press', purpose: 'live_return_assistance' },
  requestLocationForUserAction: jest.fn(),
}));

// NOTE: intentionally exhaustive — the real sampler loads expo-location's native module; this test counts its calls.
jest.mock('../../../lib/location/layoverLiveReturnSampler.ts', () => ({
  sampleLiveReturnFix: jest.fn(),
}));

const door = requestLocationForUserAction as jest.Mock;
const sample = sampleLiveReturnFix as jest.Mock;
const AIRPORT = { name: 'Changi', lat: 1.3644, lng: 103.9915 };
const CITY = { lat: 1.2834, lng: 103.8607 };

beforeEach(() => {
  jest.useFakeTimers();
  door.mockReset(); sample.mockReset(); jest.mocked(Battery.isAvailableAsync).mockReset().mockResolvedValue(true); jest.mocked(Battery.getPowerStateAsync).mockReset().mockResolvedValue({ batteryLevel: 0.8, lowPowerMode: false, batteryState: 1 }); jest.mocked(Battery.addBatteryLevelListener).mockClear(); jest.mocked(Battery.addLowPowerModeListener).mockClear();
  door.mockResolvedValue({ granted: true, lat: CITY.lat, lng: CITY.lng, accuracyMeters: 20 });
  sample.mockResolvedValue({ ok: true, lat: CITY.lat + 0.01, lng: CITY.lng, accuracyMeters: 20, atMs: Date.now() });
});

it('11. turning assistance off discards a permission revocation returned by an already-running fix', async () => {
  let finish: (value: { ok: false; reason: 'permission_not_granted' }) => void = () => { throw new Error('no pending sample'); };
  sample.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render(<LayoverLiveReturnCard sessionStatus="active" returnState="RETURN_NOW" airport={AIRPORT} />);
  await fireEvent.press(screen.getByLabelText('Turn on live return assistance'));
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(sample).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByLabelText('Turn off live return assistance'));
  await act(async () => { finish({ ok: false, reason: 'permission_not_granted' }); });
  expect(screen.queryByTestId('layover-live-return-note')).toBeNull();
});
afterEach(() => { jest.useRealTimers(); });

describe('LayoverLiveReturnCard — L157 adaptive sensing inside the L164 boundary', () => {
  it('1. NOTHING is asked of the OS until the traveller presses the control — not on mount, not over time', async () => {
    await render(<LayoverLiveReturnCard sessionStatus="active" returnState="NORMAL" airport={AIRPORT} />);
    await act(async () => { jest.advanceTimersByTime(60 * 60_000); });
    expect(door).not.toHaveBeenCalled(); expect(Battery.getPowerStateAsync).not.toHaveBeenCalled();
    expect(sample).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Turn on live return assistance')).toBeTruthy();
  });

  it('2. the press is the ONE request, with the live-return purpose; the distance to the airport is shown from that fix', async () => {
    await render(<LayoverLiveReturnCard sessionStatus="active" returnState="NORMAL" airport={AIRPORT} />);
    await fireEvent.press(screen.getByLabelText('Turn on live return assistance'));
    expect(door).toHaveBeenCalledTimes(1);
    expect(door).toHaveBeenCalledWith({ trigger: 'user_press', purpose: 'live_return_assistance' });
    expect(screen.getByTestId('layover-live-return-distance')).toBeTruthy();
    expect(screen.getByText(/not a route or a travel time/)).toBeTruthy();
  });

  it('3. a refused permission senses nothing, ever', async () => {
    door.mockResolvedValue({ granted: false, lat: null, lng: null, accuracyMeters: null, error: 'permission_denied' });
    await render(<LayoverLiveReturnCard sessionStatus="active" returnState="NORMAL" airport={AIRPORT} />);
    await fireEvent.press(screen.getByLabelText('Turn on live return assistance'));
    await act(async () => { jest.advanceTimersByTime(60 * 60_000); });
    expect(sample).not.toHaveBeenCalled();
    expect(screen.getByTestId('layover-live-return-note')).toBeTruthy();
  });

  it('4. well before the deadline: ONE low-accuracy fix per 10 minutes — not before', async () => {
    await render(<LayoverLiveReturnCard sessionStatus="active" returnState="NORMAL" airport={AIRPORT} />);
    await fireEvent.press(screen.getByLabelText('Turn on live return assistance'));
    await act(async () => { jest.advanceTimersByTime(9 * 60_000); });
    expect(sample).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(sample).toHaveBeenCalledTimes(1);
    expect(sample).toHaveBeenLastCalledWith('low');
  });

  it('5. heading back (RETURN_NOW): navigation-appropriate — a high-accuracy fix every 30 s', async () => {
    await render(<LayoverLiveReturnCard sessionStatus="active" returnState="RETURN_NOW" airport={AIRPORT} />);
    await fireEvent.press(screen.getByLabelText('Turn on live return assistance'));
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(sample).toHaveBeenCalledTimes(1);
    expect(sample).toHaveBeenLastCalledWith('high');
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(sample).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('layover-live-return-cadence')).toBeTruthy();
  });

  it('6. "Turn off" stops sensing at once', async () => {
    await render(<LayoverLiveReturnCard sessionStatus="active" returnState="RETURN_NOW" airport={AIRPORT} />);
    await fireEvent.press(screen.getByLabelText('Turn on live return assistance'));
    await fireEvent.press(screen.getByLabelText('Turn off live return assistance'));
    await act(async () => { jest.advanceTimersByTime(10 * 60_000); });
    expect(sample).not.toHaveBeenCalled();
  });

  it('7. low power mode samples less often than the same rung at full power', async () => {
    await render(<LayoverLiveReturnCard sessionStatus="active" returnState="RETURN_NOW" airport={AIRPORT} power={{ lowPowerMode: true, batteryLevel: null }} />);
    await fireEvent.press(screen.getByLabelText('Turn on live return assistance'));
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(sample).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(sample).toHaveBeenCalledTimes(1);
    expect(sample).toHaveBeenLastCalledWith('balanced');
  });

  it('8. an ended layover draws nothing and asks nothing', async () => {
    await render(<LayoverLiveReturnCard sessionStatus="completed" returnState="NORMAL" airport={AIRPORT} />);
    expect(screen.queryByTestId('layover-live-return')).toBeNull();
    expect(door).not.toHaveBeenCalled();
  });

  it('9. at the airport the card says so', async () => {
    door.mockResolvedValue({ granted: true, lat: AIRPORT.lat + 0.001, lng: AIRPORT.lng, accuracyMeters: 10 });
    await render(<LayoverLiveReturnCard sessionStatus="returning" returnState="RETURN_NOW" airport={AIRPORT} />);
    await fireEvent.press(screen.getByLabelText('Turn on live return assistance'));
    expect(screen.getByTestId('layover-live-return-at-airport')).toBeTruthy();
  });
  it('10. a failed fix does not stop the schedule: the next one-shot is still taken at the band\'s interval', async () => {
    sample.mockResolvedValue({ ok: false, reason: 'fix_failed' });
    await render(<LayoverLiveReturnCard sessionStatus="active" returnState="RETURN_NOW" airport={AIRPORT} />);
    await fireEvent.press(screen.getByLabelText('Turn on live return assistance'));
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(sample).toHaveBeenCalledTimes(2);
  });
});

// NOTE: intentionally exhaustive — the device battery bridge must not load native code in this component test.
jest.mock('expo-battery', () => ({
  isAvailableAsync: jest.fn(), getPowerStateAsync: jest.fn(),
  addBatteryLevelListener: jest.fn(() => ({ remove: jest.fn() })),
  addLowPowerModeListener: jest.fn(() => ({ remove: jest.fn() })),
}));

it('12. a real power-state read slows live sensing when battery is low, without a test-only prop', async () => {
  jest.mocked(Battery.getPowerStateAsync).mockResolvedValue({ batteryLevel: 0.1, lowPowerMode: false, batteryState: 1 });
  await render(<LayoverLiveReturnCard sessionStatus="returning" returnState="RETURN_NOW" airport={AIRPORT} />);
  await fireEvent.press(screen.getByLabelText('Turn on live return assistance'));
  await waitFor(() => expect(Battery.getPowerStateAsync).toHaveBeenCalled());
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(sample).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(sample).toHaveBeenLastCalledWith('balanced');
});

it('13. low-power events change cadence immediately and all battery listeners are removed when disabled', async () => {
  await render(<LayoverLiveReturnCard sessionStatus="returning" returnState="RETURN_NOW" airport={AIRPORT} />);
  await fireEvent.press(screen.getByLabelText('Turn on live return assistance'));
  await waitFor(() => expect(Battery.addLowPowerModeListener).toHaveBeenCalled());
  const onPower = jest.mocked(Battery.addLowPowerModeListener).mock.calls[0]![0];
  await act(async () => { onPower({ lowPowerMode: true }); });
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(sample).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(sample).toHaveBeenLastCalledWith('balanced');
  await fireEvent.press(screen.getByLabelText('Turn off live return assistance'));
  expect(jest.mocked(Battery.addLowPowerModeListener).mock.results[0]!.value.remove).toHaveBeenCalledTimes(1);
  expect(jest.mocked(Battery.addBatteryLevelListener).mock.results[0]!.value.remove).toHaveBeenCalledTimes(1);
});
