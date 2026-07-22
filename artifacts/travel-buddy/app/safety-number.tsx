/**
 * E-2: Safety Number route (Expo Router).
 *
 * Pushed as a modal from the thread header lock badge.
 *
 * Params (via useLocalSearchParams):
 *   peerName     — display name of the peer
 *   peerUserId   — peer's user id; this route fetches their identity pub key
 *                  from GET /api/users/:id/devices
 */
import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { SafetyNumberScreen } from '../src/screens/SafetyNumberScreen';
import { supabase } from '../src/lib/supabase';

const API_BASE = (process.env['EXPO_PUBLIC_API_URL'] ?? '').replace(/\/$/, '');

export default function SafetyNumberRoute() {
  const { peerName, peerUserId } = useLocalSearchParams<{
    peerName: string;
    peerUserId: string;
  }>();

  const [peerIdentityPub, setPeerIdentityPub] = useState<string | null>(null);

  useEffect(() => {
    if (!peerUserId) return;
    // Fetch the peer's registered device identity public key.
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;
        const resp = await fetch(`${API_BASE}/api/users/${peerUserId}/devices`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!resp.ok) return;
        const json = await resp.json();
        // Take the first device's public key (primary device).
        const devices: { public_key?: string }[] = Array.isArray(json?.devices) ? json.devices : [];
        const pub = devices.find(d => d.public_key)?.public_key ?? null;
        if (pub) setPeerIdentityPub(pub);
      } catch (_) {}
    })();
  }, [peerUserId]);

  return (
    <SafetyNumberScreen
      peerName={peerName ?? 'Unknown'}
      peerIdentityPubB64={peerIdentityPub ?? ''}
      onDismiss={() => router.back()}
    />
  );
}
