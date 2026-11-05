/**
 * Avatar URLs for the members a receipt says have read a message — the reader
 * chips under one of the caller's own messages.
 *
 * SERVER-BUILT (census-telegraph T295). This used to read `profiles.avatar_url`
 * itself, the last raw read on the conversation surface. The faces now come
 * WITH the receipt (`GET /api/threads/:id/receipts` → `readerFaces`, published
 * by `useThreadReadState`), under the server's rule: none across a block, a
 * private profile's only to a friend. `readerIds` is kept so the call sites read
 * as they did; a face the server has not answered is simply not drawn.
 *
 * DECORATIVE BY DESIGN: a missing face never changes what the receipt claims —
 * "Seen by N" is the server's count and is rendered whether or not a face exists.
 */
import { useCallback, useSyncExternalStore } from 'react';

import { readerFace, readerFacesVersion, subscribeReaderFaces } from './readerFaces.ts'; import { avatarImageUri } from '../../../lib/avatarImageUri.ts'; // PRIV-FIX-3 (census-telegraph §97)

export function useReaderAvatars(_readerIds: readonly string[]): (userId: string) => string | null {
  const version = useSyncExternalStore(subscribeReaderFaces, readerFacesVersion, readerFacesVersion);
  // `version` is the dependency that makes a new answer re-render the chips.
  return useCallback((userId: string) => avatarImageUri(readerFace(userId)), [version]); // eslint-disable-line react-hooks/exhaustive-deps -- PRIV-FIX-3 (census-telegraph §97): a reader's face is Portava storage or not drawn (the chips include GroupChatScreen's raw <Image>)
}
