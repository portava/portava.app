/**
 * census G303 — the confirmed tap of a `share_entity` candidate in the Telegraph
 * composer. The sender confirms first ("Share this event?"); only then is the
 * object sent, through the EXISTING §5 share route (POST /threads/:id/share),
 * which re-checks that the sender can open it and projects it for each
 * recipient at read time (§5.3). A failed send is said, never swallowed.
 */
import { Alert } from 'react-native';
import { shareObjectIntoThread } from '../../../features/telegraph/sharing/shareApi.ts';
import type { MeetAtSharedObject } from './telegraphMeetAt.ts';

export interface ConfirmShareDeps {
  alert: typeof Alert.alert;
  share: typeof shareObjectIntoThread;
}

const DEFAULT_DEPS: ConfirmShareDeps = { alert: (...a) => Alert.alert(...a), share: shareObjectIntoThread };

/** The chip label without its "Share Event: " prefix — what the sender is asked about. */
export function sharedObjectName(label: string): string {
  return label.replace(/^Share Event:\s*/i, '').trim() || 'this event';
}

export function confirmShareObject(threadId: string, object: MeetAtSharedObject, label: string, deps: ConfirmShareDeps = DEFAULT_DEPS): void {
  const name = sharedObjectName(label);
  deps.alert('Share this event?', `${name} will be shared in this chat. Each person sees only what they are allowed to see.`, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Share',
      onPress: () => {
        void deps.share(threadId, object.objectType, object.objectId, null).then((res) => {
          if (!res.ok) deps.alert('Couldn’t share', 'The event was not shared. Please try again.');
        });
      },
    },
  ]);
}
