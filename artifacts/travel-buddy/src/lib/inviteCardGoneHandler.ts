/**
 * Pure helper extracted from InviteCard.
 *
 * Returns 'gone' when an error thrown by acceptTripInvite signals that the
 * trip has ended (code === 'gone' or, as a fallback, message === 'gone').
 * Returns 'generic' for any other error so the caller can show an Alert.
 *
 * Exported so unit tests can exercise the exact same logic the component runs,
 * without needing to render React Native.
 */
export function classifyInviteAcceptError(e: unknown): 'gone' | 'generic' {
  const err = e as { code?: string; message?: string } | null | undefined;
  if (err?.code === 'gone' || err?.message === 'gone') return 'gone';
  return 'generic';
}
