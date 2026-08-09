/**
 * StoryViewer — full-screen modal story player.
 *
 * Features:
 * - Progress bar per story, auto-advances after 5s
 * - Long-press to pause
 * - Tap left/right halves to navigate stories
 * - Swipe-down to dismiss (via close button)
 * - Viewer list sheet for story owner
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  ActivityIndicator, Animated, Dimensions, Modal, Pressable,
  StyleSheet, Text, TouchableWithoutFeedback, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Eye, Users } from 'lucide-react-native';
import { color, radius, space, type as t, avatar } from '../theme/tokens.ts';
import type { Story, StoryFeedUser } from '../services/stories.ts';
import { getViewers, type StoryViewer } from '../services/stories.ts';
import { useSession } from '../context/SessionContext.tsx';
import { formatRelativeTime as formatRelative } from '../lib/dateTime/formatters.ts';
import { primaryIdentityText } from '../lib/displayIdentity.ts';
import { VerifiedStamp } from './ui/VerifiedStamp.tsx';
import { UserIdentityLink } from './interaction/UserIdentityLink.tsx';
import { DisplayMediaImage } from './ui/DisplayMediaImage.tsx';

const STORY_DURATION_MS = 5000;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

interface Props {
  visible: boolean;
  feedUser: StoryFeedUser | null;
  onClose: () => void;
}

export function StoryViewer({ visible, feedUser, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { userId } = useSession();
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewersOpen, setViewersOpen] = useState(false);
  const [viewers, setViewers] = useState<StoryViewer[]>([]);
  const [viewersHidden, setViewersHidden] = useState(false);
  const [loadingViewers, setLoadingViewers] = useState(false);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const stories: Story[] = feedUser?.stories ?? [];
  const current: Story | undefined = stories[idx];

  const advance = useCallback(() => {
    setIdx((i) => {
      if (i + 1 < stories.length) return i + 1;
      onClose();
      return i;
    });
  }, [stories.length, onClose]);

  const startProgress = useCallback(() => {
    progressAnim.setValue(0);
    animRef.current = Animated.timing(progressAnim, {
      toValue: 1,
      duration: STORY_DURATION_MS,
      useNativeDriver: false,
    });
    animRef.current.start(({ finished }) => { if (finished) advance(); });
  }, [progressAnim, advance]);

  useEffect(() => {
    if (!visible || !current) return;
    if (paused) {
      animRef.current?.stop();
    } else {
      startProgress();
    }
    return () => { animRef.current?.stop(); };
  }, [visible, idx, paused, current, startProgress]);

  useEffect(() => {
    if (visible) { setIdx(0); setPaused(false); }
  }, [visible, feedUser]);

  async function openViewers() {
    if (!current) return;
    setViewersOpen(true);
    setLoadingViewers(true);
    const res = await getViewers(current.id);
    setLoadingViewers(false);
    if (res.ok) {
      setViewers(res.viewers);
      setViewersHidden(res.hidden);
    }
  }

  if (!visible || !feedUser || !current) return null;

  const isOwner = userId === feedUser.userId;

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={[s.root, { paddingTop: insets.top }]}>
        {/* Progress bars */}
        <View style={s.progressRow}>
          {stories.map((_, i) => (
            <View key={i} style={s.progressTrack}>
              <Animated.View
                style={[
                  s.progressFill,
                  {
                    width: i < idx ? '100%' : i === idx
                      ? progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
                      : '0%',
                  },
                ]}
              />
            </View>
          ))}
        </View>

        {/* Header */}
        <View style={s.header}>
          <UserIdentityLink
            userId={feedUser.userId}
            handle={feedUser.handle}
            currentUserId={userId}
            testID="story-author-identity"
          >
            <View style={s.authorRow}>
              <View style={s.avatar} />
              <View>
                <View style={s.authorNameRow}>
                  <Text style={s.authorName}>{primaryIdentityText({ name: feedUser.name, handle: feedUser.handle })}</Text>
                  {feedUser.verified ? <VerifiedStamp size="sm" dark /> : null}
                </View>
                <Text style={s.timeAgo}>{formatRelative(current.created_at)}</Text>
              </View>
            </View>
          </UserIdentityLink>
          <Pressable onPress={onClose} hitSlop={12}>
            <X size={24} color="#fff" />
          </Pressable>
        </View>

        {/* Media — routed through DisplayMediaImage for signed-URL hydration */}
        <TouchableWithoutFeedback
          onLongPress={() => setPaused(true)}
          onPressOut={() => setPaused(false)}
          onPress={(e) => {
            const w = e.nativeEvent.locationX;
            const screenW = 390;
            if (w < screenW / 2) {
              setIdx((i) => Math.max(0, i - 1));
            } else {
              advance();
            }
          }}
        >
          <View style={{ flex: 1 }}>
            <DisplayMediaImage
              uri={current.media_url}
              width={SCREEN_W}
              height={SCREEN_H}
              resizeMode="cover"
            />
            {current.caption ? (
              <View style={s.captionBg}>
                <Text style={s.caption}>{current.caption}</Text>
              </View>
            ) : null}
          </View>
        </TouchableWithoutFeedback>

        {/* Footer */}
        {isOwner && (
          <Pressable style={[s.viewersBtn, { marginBottom: insets.bottom + space.md }]} onPress={openViewers}>
            <Eye size={16} color="#fff" />
            <Text style={s.viewersBtnText}>Viewers</Text>
          </Pressable>
        )}

        {/* Viewers sheet */}
        {viewersOpen && (
          <Modal visible={viewersOpen} transparent animationType="slide" onRequestClose={() => setViewersOpen(false)}>
            <Pressable style={s.sheetOverlay} onPress={() => setViewersOpen(false)} />
            <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
              <View style={s.sheetHandle} />
              <Text style={s.sheetTitle}>Viewers</Text>
              {loadingViewers ? (
                <ActivityIndicator color={color.deep} style={{ marginVertical: 24 }} />
              ) : viewersHidden ? (
                <View style={s.hiddenMsg}>
                  <Users size={24} color={color.mute} />
                  <Text style={s.hiddenText}>Viewer list is hidden</Text>
                </View>
              ) : viewers.length === 0 ? (
                <Text style={s.emptyText}>No viewers yet</Text>
              ) : (
                viewers.map((v) => (
                  <UserIdentityLink
                    key={v.userId}
                    userId={v.userId}
                    handle={v.handle}
                    currentUserId={userId}
                    testID={`viewer-identity-${v.userId}`}
                  >
                    <View style={s.viewerRow}>
                      <View style={s.viewerAvatar} />
                      <View style={s.viewerNameRow}>
                        <Text style={s.viewerName}>{primaryIdentityText({ name: v.name, handle: v.handle })}</Text>
                        {v.verified ? <VerifiedStamp size="sm" /> : null}
                      </View>
                      <Text style={s.viewerTime}>{formatRelative(v.viewedAt)}</Text>
                    </View>
                  </UserIdentityLink>
                ))
              )}
            </View>
          </Modal>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  progressRow: { flexDirection: 'row', gap: 4, paddingHorizontal: space.sm, paddingVertical: space.xs ?? 4 },
  progressTrack: { flex: 1, height: 2, backgroundColor: 'rgba(255,255,255,0.4)', borderRadius: 1, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#fff', borderRadius: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.md, paddingVertical: space.sm },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  avatar: { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, backgroundColor: 'rgba(255,255,255,0.2)' },
  authorNameRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4 },
  authorName: { color: '#fff', fontWeight: '700', fontSize: 14 },
  timeAgo: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
  captionBg: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: space.lg, backgroundColor: 'rgba(0,0,0,0.4)' },
  caption: { color: '#fff', fontSize: 15, lineHeight: 22 },
  viewersBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, justifyContent: 'center', paddingVertical: space.md },
  viewersBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  sheetOverlay: { flex: 1 },
  sheet: { backgroundColor: color.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: space.lg, minHeight: 200 },
  sheetHandle: { width: 36, height: 4, backgroundColor: color.haze, borderRadius: 2, alignSelf: 'center', marginBottom: space.lg },
  sheetTitle: { ...t.heading, color: color.ink, marginBottom: space.md },
  hiddenMsg: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
  hiddenText: { ...t.body, color: color.mute },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center', paddingVertical: space.xl },
  viewerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  viewerAvatar: { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, backgroundColor: color.haze },
  viewerNameRow: { flex: 1, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 3 },
  viewerName: { flexShrink: 1, ...t.body, color: color.ink },
  viewerTime: { ...t.small, color: color.mute },
});
