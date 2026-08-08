/**
 * E-2: Safety Number route (Expo Router).
 *
 * Pushed as a modal from the thread header lock badge.
 *
 * Params (via useLocalSearchParams):
 *   peerName — display name of the peer
 *   threadId — the thread whose live MLS group the number is derived from
 *
 * This route previously fetched the peer's identity public key from
 * GET /api/users/:id/devices and derived the number from it. That key was never
 * used by the MLS session, so the number verified nothing. The derivation now
 * reads the signature keys actually present in the group's ratchet tree, which
 * means the fetch is gone: the number comes from local group state, not from
 * anything the server tells us. That is the point — a server that could choose
 * the inputs could choose the output.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { SafetyNumberScreen } from '../src/screens/SafetyNumberScreen';

export default function SafetyNumberRoute() {
  const { peerName, threadId } = useLocalSearchParams<{
    peerName: string;
    threadId: string;
  }>();

  return (
    <SafetyNumberScreen
      peerName={peerName ?? 'Unknown'}
      threadId={threadId ?? ''}
      onDismiss={() => router.back()}
    />
  );
}
