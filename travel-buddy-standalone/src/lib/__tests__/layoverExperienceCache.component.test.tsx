import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen } from '@testing-library/react-native';
import { experienceCacheKey, parseOfflineExperience, prepareExperienceOffline, readCachedExperience } from '../layoverExperienceCache.ts';
import { LayoverCachedExperience } from '../../components/layover/LayoverCachedExperience.tsx';
const at = (h: number) => `2030-06-14T${String(h).padStart(2, '0')}:00:00.000Z`;
const plan = () => ({ id: 'plan1', version: 1, phase: 'selected', stopIds: ['one', 'two'], createdAt: at(8),
  privatePassport: 'must not store', contract: { state: 'READY', snapshotId: 'snap1', candidateIds: ['c1', 'c2'], insideAirport: false,
    departBy: at(10), leaveActivityBy: at(14), expectedAirportReturn: at(13), hardReturnBy: at(15), expiresAt: at(10),
    fallbackPlan: { duringExperience: 'return_to_airport', returnBy: at(15), returnRoute: { mode: 'TRANSIT', departAt: at(12), minutes: 45, conservativeMinutes: 60, forecast: true, transferCount: 1 } },
    abortThreshold: { leaveBy: at(14), returnDeadline: at(15), conditions: ['route_expired'] },
    itinerary: [ { kind: 'outbound', startsAt: at(9), endsAt: at(10), mode: 'TRANSIT', origin: [1, 2] },
      { kind: 'experience', startsAt: at(10), endsAt: '2030-06-14T10:30:00.000Z', mode: null, candidateId: 'c1' },
      { kind: 'outbound', startsAt: '2030-06-14T10:30:00.000Z', endsAt: at(11), mode: 'WALK' },
      { kind: 'experience', startsAt: at(11), endsAt: at(12), mode: null, candidateId: 'c2' },
      { kind: 'return', startsAt: at(12), endsAt: at(13), mode: 'TRANSIT' } ] } });
beforeEach(async () => { jest.restoreAllMocks(); await AsyncStorage.clear(); });
it('survives an offline read with every ordered hop and original expiry, while dropping private extensions', async () => {
  const result = await prepareExperienceOffline('s', plan(), Date.parse(at(8)));
  expect(result.ok).toBe(true); expect(result.reason).toContain('Street navigation is not saved');
  const saved = await readCachedExperience('s'); expect(saved?.contract.itinerary).toHaveLength(5);
  expect(saved?.contract.expiresAt).toBe(at(10)); expect(saved?.contract.fallbackPlan.returnRoute?.conservativeMinutes).toBe(60);
  const raw = await AsyncStorage.getItem(experienceCacheKey('s')); expect(raw).not.toContain('privatePassport'); expect(raw).not.toContain('origin');
  expect(await readCachedExperience('other')).toBeNull();
});
it('refuses stale, incomplete and contradictory return plans before starting', async () => {
  expect((await prepareExperienceOffline('s', plan(), Date.parse(at(10)))).ok).toBe(false);
  const missing = plan(); missing.contract.itinerary.pop(); expect(parseOfflineExperience(missing)).toBeNull();
  const late = plan(); late.contract.expectedAirportReturn = at(16); expect(parseOfflineExperience(late)).toBeNull();
  const skipped = plan(); skipped.contract.itinerary.splice(1, 1); expect(parseOfflineExperience(skipped)).toBeNull();
});
it('does not allow starting after a failed write or a changed readback', async () => {
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('full'));
  expect((await prepareExperienceOffline('s', plan(), Date.parse(at(8)))).ok).toBe(false);
  jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('{}');
  expect((await prepareExperienceOffline('s', plan(), Date.parse(at(8)))).ok).toBe(false);
});
it('renders stale saved timetable and deadline without authorizing departure or implying cached navigation', async () => {
  await prepareExperienceOffline('s', plan(), Date.parse(at(8)));
  await render(<LayoverCachedExperience sessionId="s" nowMs={Date.parse(at(12))} />);
  expect(await screen.findByText('Timing is stale. Do not start from this saved plan.')).toBeTruthy();
  expect(screen.getByText(`Return deadline: ${at(15)} (UTC)`)).toBeTruthy();
  expect(screen.getByText(/Street navigation is not saved/)).toBeTruthy();
});
