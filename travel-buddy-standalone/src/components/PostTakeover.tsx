import React, { useLayoutEffect, useState } from 'react';
import { enterPostPlaybackLayer, PostPlaybackLayer } from '../hooks/usePostPlaybackLayer.ts';
import { Modal, View } from 'react-native';
import type { ReferenceMedia } from '../services/postDestinations.ts';
import { useMediaSurfaceActivity } from '../hooks/useMediaSurfaceActivity.ts';
import { useSession } from '../context/SessionContext.tsx';
import { usePrivateSurfaceKey } from '../hooks/usePrivateSurfaceKey.ts';

export interface PostTakeoverProps {
  postId: string;
  onClose: () => void;
  initialPositionMillis?: number;
  onPositionChange?: (position: number) => void;
  initialMediaUri?: string;
  /** Present only after a live destination and source authorization check. */
  authorizedMedia?: ReferenceMedia[];
}

/** Mount on the presenting surface, including when that surface is itself a modal. */
export function PostTakeover({ postId, onClose, ...playback }: PostTakeoverProps) {
  const activity = useMediaSurfaceActivity(onClose);
  const scope = usePrivateSurfaceKey();
  const { userId } = useSession();
  const [layer] = useState(() => Symbol('post-modal'));
  useLayoutEffect(() => activity.active ? enterPostPlaybackLayer(layer) : undefined, [activity.active, layer]);
  if (!activity.active) return null;
  // Only load the full detail screen when a reader actually opens a post.
  const { PostDetailContent } = require('../../app/post/[id].tsx') as typeof import('../../app/post/[id].tsx');
  return <Modal visible presentationStyle="fullScreen" animationType="fade" onRequestClose={onClose}
    supportedOrientations={['portrait', 'landscape']}>
    <View style={{ flex: 1 }} accessibilityViewIsModal testID="post-takeover">
      <PostPlaybackLayer.Provider value={layer}><PostDetailContent key={JSON.stringify([scope, userId, postId])} id={postId} onClose={onClose} {...playback} /></PostPlaybackLayer.Provider>
    </View>
  </Modal>;
}
