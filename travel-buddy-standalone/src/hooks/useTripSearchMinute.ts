import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/** Search suggestions can hide a trip's dates. Recheck date-sensitive rows at a
 * clock-minute boundary without exposing a private trip's timezone or end date. */
export function useTripSearchMinute(watching: boolean): number {
  const [,wake] = useState(0);
  const minute = Math.floor(Date.now() / 60_000);
  useEffect(() => {
    if (!watching) return;
    const refresh = () => wake(value => value + 1);
    const timer = setTimeout(refresh,(minute + 1) * 60_000 - Date.now());
    const listener = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => { clearTimeout(timer); listener.remove(); };
  },[watching,minute]);
  return minute;
}
export function tripSearchType(type: string | undefined): boolean {
  return type === 'trips' || type === 'trip' || type === 'plans' || type === 'plan';
}
