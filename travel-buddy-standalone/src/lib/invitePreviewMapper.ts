/**
 * Pure mapping function shared by the invite-preview screen and its tests.
 *
 * Converts an InvitePreviewResult from the service layer into the appropriate
 * ScreenState variant, with no React or React Native dependencies.
 */
import type { InvitePreview, InvitePreviewResult } from '../services/trips';

export type ScreenState =
  | { kind: 'loading' }
  | { kind: 'not_authed' }
  | { kind: 'gone'; message: string }
  | { kind: 'error' }
  | { kind: 'already_member'; tripId: string }
  | { kind: 'terminal'; preview: InvitePreview; message: string }
  | { kind: 'full'; preview: InvitePreview }
  | { kind: 'ready'; preview: InvitePreview };

/**
 * Maps an InvitePreviewResult returned by previewInviteLink() to a ScreenState.
 * The caller is responsible for the pre-conditions (configured, isAuthed, token)
 * that are checked before calling previewInviteLink().
 */
export function mapInvitePreviewToScreenState(result: InvitePreviewResult): ScreenState {
  if (result.error === 'not_authenticated') {
    return { kind: 'not_authed' };
  }
  if (result.gone) {
    const message = result.goneReason === 'trip_inactive'
      ? 'This trip is no longer active.'
      : 'This invite link has expired or been revoked.';
    return { kind: 'gone', message };
  }
  if (!result.data) {
    return { kind: 'error' };
  }
  if (result.data.alreadyMember) {
    return { kind: 'already_member', tripId: result.data.tripId };
  }
  if (result.data.isTerminal) {
    return {
      kind: 'terminal',
      preview: result.data,
      message: result.data.terminalReason ?? 'This trip is no longer active.',
    };
  }
  if (result.data.isFull) {
    return { kind: 'full', preview: result.data };
  }
  return { kind: 'ready', preview: result.data };
}
