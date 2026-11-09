import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { tripExpiryTime, type TripWindow } from '../lib/tripCalendar.ts';

/** Refresh at an actual expiry and on return from the background. */
export function useTripWindowClock(trips: readonly TripWindow[]): number {
  const [tick, setTick] = useState(Date.now);
  useEffect(() => {
    const now = Date.now();
    const next = trips.reduce((earliest, trip) => {
      const expiry = tripExpiryTime(trip);
      return expiry !== null && expiry > now ? Math.min(earliest, expiry) : earliest;
    }, Infinity);
    const timer = Number.isFinite(next) ? setTimeout(() => setTick(Date.now()), Math.min(next - now, 2_000_000_000)) : null;
    const listener = AppState.addEventListener('change', state => { if (state === 'active') setTick(Date.now()); });
    return () => { if (timer !== null) clearTimeout(timer); listener.remove(); };
  }, [trips, tick]);
  return Date.now();
}
