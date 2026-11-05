/**
 * FeedAutoplayVideo — the muted, looping video a Pulse feed card plays while it
 * is the card the feed picked (lib/media/feedAutoplay.ts).
 *
 *   - MUTED, always. A feed scrolls past many videos, browsers refuse to start
 *     one with sound, and tapping the card opens the post, which plays it with
 *     sound. A small speaker-off badge says so.
 *   - SIGNED like every player (services/playbackUri.ts): a private-bucket ref
 *     mounts no <Video> until its signed URL is back. Until then, and if the
 *     video fails, the card keeps the poster it already draws underneath.
 *   - INVISIBLE until the first frame is ready, so the poster never flashes to
 *     black while the video loads.
 *   - TOUCH-THROUGH: the card's tap (open the post) and double-tap (stamp) are
 *     handled by the card, so nothing here takes a touch.
 *
 * The caller mounts it only for the one card that should play and unmounts it
 * when that changes, which also stops the video and frees the decoder.
 */
import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { VolumeX } from 'lucide-react-native';
import { useHydratedMedia } from '../../services/mediaUrl.ts';
import { playbackUriState } from '../../services/playbackUri.ts';
import { avatar } from '../../theme/tokens.ts';

export function FeedAutoplayVideo({ uri }: { uri: string }) {
  const { resolved } = useHydratedMedia([uri]);
  const source = playbackUriState(uri, resolved);
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);

  // The player gets the READY state's uri and nothing else (playbackUri.relay.test.ts P6).
  const playbackUri = source.state === 'ready' ? source.uri : null;
  if (playbackUri === null || failedFor === playbackUri) return null;
  const shown = shownFor === playbackUri;

  return (
    <View
      testID="feed-autoplay-video"
      style={[StyleSheet.absoluteFill, shown ? null : s.hidden]}
      pointerEvents="none"
    >
      <Video
        key={playbackUri}
        source={{ uri: playbackUri }}
        style={StyleSheet.absoluteFill}
        resizeMode={ResizeMode.COVER}
        shouldPlay
        isLooping
        isMuted
        useNativeControls={false}
        onReadyForDisplay={() => setShownFor(playbackUri)}
        onError={() => setFailedFor(playbackUri)}
      />
      {shown ? (
        <View style={s.mutedBadge} accessibilityLabel="Playing without sound. Open the post to hear it.">
          <VolumeX size={14} color="#fff" />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  hidden: { opacity: 0 },
  mutedBadge: {
    position: 'absolute',
    top: 36, // under the card's date mark (top 16, right 14)
    right: 12,
    width: avatar.s28,
    height: avatar.s28,
    borderRadius: avatar.s28 / 2,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
