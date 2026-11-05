import React, { useEffect, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { currentPlaceClaims, type PlaceLiveInformation as LiveInformation } from './placeLiveInformation.ts';
import { useTelegraphPalette } from '../theme/telegraphTheme.ts';

export function PlaceLiveInformation({ value, textColor }: { value?: LiveInformation; textColor?: string }) {
  const palette = useTelegraphPalette();
  const [now, setNow] = useState(Date.now);
  const expiry = value?.expiresAtMs;
  useEffect(() => {
    const tick = () => setNow(previous => Math.max(Date.now(), previous + 1));
    const remaining = typeof expiry === 'number' ? expiry - Date.now() : 0;
    const timer = remaining > 0 ? setTimeout(tick, Math.min(remaining, 2_147_483_647)) : undefined;
    const listener = AppState.addEventListener('change', state => { if (state === 'active') tick(); });
    return () => { if (timer) clearTimeout(timer); listener.remove(); };
  }, [expiry, now]);
  const claims = currentPlaceClaims(value, Math.max(now, Date.now()));
  if (!claims.length) return null;
  return <View testID="telegraph-place-live-information" style={{ gap: 3, paddingVertical: 6 }}>
    <Text style={{ color: textColor ?? palette.mute, fontSize: 12, fontWeight: '600' }}>Current place information</Text>
    {claims.map((claim, index) => <Text key={`${index}:${claim}`} style={{ color: textColor ?? palette.recvText, fontSize: 13 }}>{claim}</Text>)}
  </View>;
}
