/**
 * CompactPlaybackHost — the one presenter of a thread video (Telegraph §6.3,
 * census-telegraph T62). Mounted ONCE by the root layout, after the Stack and
 * outside every list, the same way the call UI is (`calls/CallSurface`).
 *
 * It renders the session `compactPlaybackStore` holds in one of two
 * presentations — full screen, or docked in the corner while the viewer keeps
 * scrolling the thread — and the player element is the FIRST child of the same
 * frame in both. Minimize and expand restyle that frame; React keeps the
 * player, so the native player keeps its buffer, its position and its play
 * state. Nothing is reloaded and nothing seeks: it is one playback.
 *
 * The player is the shared `SharedVideoPlayer`, unchanged — the same component
 * the thread's full-screen modal used — so private-bucket references are signed
 * before they reach the video, and the shared transport controls are the ones
 * the message tree always had.
 *
 * It also watches what only a root-level component can see, and stops the
 * session (see the store's header for the full list):
 *   - the route (path + params) leaving the conversation that opened it;
 *   - the signed-in account changing or signing out;
 *   - a block with a bound sender, either direction, as the block lists know it;
 *   - realtime `message.unsent` / `message.deleted` naming a bound message,
 *     `user.blocked`, `access.revoked`, and this viewer's own `member.left`;
 *   - the media reference no longer signing for this viewer.
 *
 * Motion: there is no transition to reduce. Both presentations appear and
 * change in place, unanimated, so §11.3's reduced-motion setting has nothing
 * here to gate; the player never starts on its own (the viewer's tap is the
 * only entry).
 */
import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { BackHandler, Pressable, StyleSheet, View } from 'react-native';
import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Maximize2, Minimize2, X } from 'lucide-react-native';
import { SharedVideoPlayer } from '../../../components/ui/SharedVideoPlayer.tsx';
import { useSession } from '../../../context/SessionContext.tsx';
import { useBlockedIds } from '../../../context/BlockedIdsContext.tsx';
import { useHydratedMedia } from '../../../services/mediaUrl.ts';
import { telegraphRealtime } from '../../../services/telegraphRealtimeService.ts';
import {
  expandPlayback,
  getCompactPlayback,
  minimizePlayback,
  reconcilePlaybackContext,
  routeKeyOf,
  stopPlayback,
  stopReasonForBlocks,
  stopReasonForEvent,
  subscribeCompactPlayback,
} from './compactPlaybackStore.ts';

/** Docked size: 16:9, small enough to leave the thread readable. */
export const COMPACT_WIDTH = 176;
export const COMPACT_HEIGHT = 99;
/** Below the conversation header, above the composer and the keyboard. */
const COMPACT_TOP_OFFSET = 64;

export function CompactPlaybackHost() {
  const session = useSyncExternalStore(subscribeCompactPlayback, getCompactPlayback, getCompactPlayback);
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const routeKey = routeKeyOf(pathname, params as Record<string, string | string[] | undefined>);
  const { userId } = useSession();
  const { blockedIds, blockerIds } = useBlockedIds();
  const insets = useSafeAreaInsets();

  const key = session?.key ?? null;
  const mediaRef = session?.mediaRef ?? null;
  const presentation = session?.presentation ?? null;
  const viewerRef = useRef<string | null>(userId ?? null);
  viewerRef.current = userId ?? null;

  // Where and for whom: stamped on first sight of a session, any change stops it.
  useEffect(() => {
    reconcilePlaybackContext(routeKey, userId ?? null);
  }, [key, routeKey, userId]);

  // A block the block lists know about, either direction, with a bound sender.
  useEffect(() => {
    const s = getCompactPlayback();
    if (!s) return;
    const reason = stopReasonForBlocks(s, blockedIds, blockerIds);
    if (reason) stopPlayback(reason, s.key);
  }, [key, blockedIds, blockerIds]);

  // Realtime: unsend / delete of a bound message, blocks, revocation, leaving.
  useEffect(() => {
    if (key === null) return undefined;
    return telegraphRealtime.subscribe((evt) => {
      const s = getCompactPlayback();
      if (!s || s.key !== key) return;
      const reason = stopReasonForEvent(s, evt, viewerRef.current);
      if (reason) stopPlayback(reason, s.key);
    });
  }, [key]);

  // The reference must still sign for this viewer. A refusal is the server
  // saying they may no longer read it; nothing is left playing on a refusal.
  const { resolved } = useHydratedMedia([mediaRef]);
  const signed = mediaRef ? resolved[mediaRef] : undefined;
  useEffect(() => {
    if (key !== null && signed === null) stopPlayback('media_error', key);
  }, [key, signed]);

  // Android back while full screen stops playback, as the old modal's did.
  useEffect(() => {
    if (key === null || presentation !== 'expanded') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      stopPlayback('user', key);
      return true;
    });
    return () => sub.remove();
  }, [key, presentation]);

  if (!session) return null;
  const expanded = session.presentation === 'expanded';
  const sessionKey = session.key;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" testID="compact-playback-host">
      <View
        testID={expanded ? 'compact-playback-expanded' : 'compact-playback-docked'}
        style={expanded ? s.expandedFrame : [s.dockedFrame, { top: insets.top + COMPACT_TOP_OFFSET }]}
        accessibilityViewIsModal={expanded}
      >
        {/* FIRST child in both presentations: React keeps this instance. */}
        <SharedVideoPlayer
          key={sessionKey}
          uri={session.mediaRef}
          poster={session.posterRef ?? undefined}
          autoplay
          muted={false}
          style={expanded ? s.expandedVideo : s.dockedVideo}
          onEnd={() => stopPlayback('ended', sessionKey)}
        />
        {expanded ? (
          <View key="expanded-controls" style={[s.expandedControls, { top: insets.top + 12 }]}>
            <Pressable
              style={s.roundButton}
              onPress={() => minimizePlayback(sessionKey)}
              accessibilityRole="button"
              accessibilityLabel="Minimize video"
              hitSlop={12}
            >
              <Minimize2 size={20} color="#fff" />
            </Pressable>
            <Pressable
              style={s.roundButton}
              onPress={() => stopPlayback('user', sessionKey)}
              accessibilityRole="button"
              accessibilityLabel="Stop video"
              hitSlop={12}
            >
              <X size={22} color="#fff" />
            </Pressable>
          </View>
        ) : (
          <View key="docked-controls" style={StyleSheet.absoluteFill} pointerEvents="box-none">
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => expandPlayback(sessionKey)}
              accessibilityRole="button"
              accessibilityLabel="Expand video"
            >
              <View style={s.expandBadge} pointerEvents="none">
                <Maximize2 size={14} color="#fff" />
              </View>
            </Pressable>
            <Pressable
              style={s.dockedStop}
              onPress={() => stopPlayback('user', sessionKey)}
              accessibilityRole="button"
              accessibilityLabel="Stop video"
              hitSlop={10}
            >
              <X size={14} color="#fff" />
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  expandedFrame: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    elevation: 20,
  },
  expandedVideo: { width: '100%', height: 340 },
  expandedControls: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    gap: 12,
    zIndex: 10,
  },
  roundButton: {
    padding: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
  },
  dockedFrame: {
    position: 'absolute',
    right: 12,
    width: COMPACT_WIDTH,
    height: COMPACT_HEIGHT,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
    zIndex: 1000,
    elevation: 20,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  dockedVideo: { width: '100%', height: '100%', borderRadius: 0 },
  expandBadge: {
    position: 'absolute',
    left: 6,
    top: 6,
    padding: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  dockedStop: {
    position: 'absolute',
    right: 6,
    top: 6,
    padding: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
});
