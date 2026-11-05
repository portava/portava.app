import React, { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useSession } from '../../../context/SessionContext.tsx';
import { capturePostDestinationOwner, listPostDestinationMemories } from '../../../services/postDestinations.ts';
import type { MessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import { ProfileMemoryAlbums, type MemoryAlbumReader } from './ProfileMemoryAlbums.tsx';

/** Reads canonical albums directly whenever the Passport tab becomes visible. */
export function OwnMemoryAlbums() {
  const { userId } = useSession();
  return userId ? <OwnerAlbums key={userId} ownerId={userId} /> : null;
}
function OwnerAlbums({ ownerId }: { ownerId: string }) {
  const request = useRef<MessagingOwnerRequest | null>(null);
  const [generation, setGeneration] = useState(0);
  useFocusEffect(useCallback(() => {
    const owner = capturePostDestinationOwner(); request.current = owner;
    setGeneration(n => n + 1);
    return () => { owner?.invalidate(); if (request.current === owner) request.current = null; };
  }, [ownerId]));
  const readPage = useCallback<MemoryAlbumReader>(async cursor => {
    const owner = request.current;
    if (!owner?.isCurrent() || owner.ownerId !== ownerId) return { ok: false, message: 'Sign in again to view your Memories.' };
    const result = await listPostDestinationMemories(owner, cursor);
    if (!owner.isCurrent() || request.current !== owner) return { ok: false, message: 'Your signed-in session changed.' };
    return result.ok ? { ok: true, memories: result.data.memories, nextCursor: result.data.nextCursor } : result;
  }, [ownerId]);
  return generation > 0 ? <ProfileMemoryAlbums key={generation} userId={ownerId} readPage={readPage} /> : null;
}
