/**
 * MediaMoreMenu — contextual action sheet for Watch and Gems feed items.
 *
 * Actions shown depend on:
 *   - `isOwner`    — whether the viewer created this item.
 *   - `isGems`     — whether this is a Gems (hidden gem) item.
 *   - Feature flags (MEDIA_COMMENTS_ENABLED, MEDIA_SHARING_ENABLED).
 *
 * Viewer actions: Not Interested · Hide · Mute Creator · Unfollow · Block · Report · Why This?
 * Owner actions:  Edit · Delete · Change Visibility
 * Gems extra:     Wrong Place
 *
 * Calls the corresponding API service functions; navigation to edit screens
 * uses expo-router.
 */
import React, { useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
  Alert,
  Platform,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  ThumbsDown,
  EyeOff,
  BellOff,
  UserMinus,
  Ban,
  Flag,
  HelpCircle,
  Edit2,
  Trash2,
  Globe,
  Lock,
  Users,
  AlertTriangle,
  X,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  reportMedia,
  hideMedia,
  deleteMedia,
  updateMediaVisibility,
} from '../../services/mediaInteractions.ts';
import { muteUser } from '../../services/mutes.ts';
import { unfollowUser } from '../../services/follows.ts';
import { blockUser } from '../../services/blocks.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MediaMoreMenuProps {
  visible: boolean;
  /** Media item (post) ID. */
  mediaId: string | null;
  /** Creator user ID. */
  creatorId: string | null;
  /** Whether the viewing user owns this media item. */
  isOwner: boolean;
  /** Whether this is a Gems (hidden gem) item. */
  isGems?: boolean;
  /**
   * Current visibility for owner controls.
   *
   * `posts.visibility` is the `post_visibility` enum — public | trip_only |
   * private | followers_only. 'friends' was never one of them: PATCH
   * /api/media/:id sent it straight to PostgREST, which failed the enum cast
   * (22P02), so the "Friends only" row here returned an error 100% of the time
   * it was tapped. It is gone rather than remapped, because deciding which real
   * label it meant is a product decision. trip_only is not offered here either:
   * it requires the post to HAVE a trip, a cross-field rule only the post
   * editor enforces.
   */
  currentVisibility?: 'public' | 'private';
  /** compassExplanation from the media item — passed to Why This? sheet. */
  compassExplanation?: string | null;
  /** Called when the user chooses "Why This?" */
  onWhyThis?: () => void;
  /** Called when a destructive action removes the item from the feed. */
  onItemRemoved?: (mediaId: string) => void;
  onClose: () => void;
}

// ── Row component ─────────────────────────────────────────────────────────────

interface RowProps {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

function Row({ icon, label, onPress, destructive }: RowProps) {
  return (
    <Pressable
      style={({ pressed }) => [s.row, pressed && s.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={s.rowIcon}>{icon}</View>
      <Text style={[s.rowLabel, destructive && s.rowLabelDestructive]}>{label}</Text>
    </Pressable>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function MediaMoreMenu({
  visible,
  mediaId,
  creatorId,
  isOwner,
  isGems = false,
  currentVisibility = 'public',
  onWhyThis,
  onItemRemoved,
  onClose,
}: MediaMoreMenuProps) {
  const insets = useSafeAreaInsets();
  const iconSize = 20;
  const iconColor = color.ink;

  // ── Viewer actions ────────────────────────────────────────────────────────

  const handleNotInterested = useCallback(async () => {
    onClose();
    if (!mediaId) return;
    await hideMedia(mediaId);
    onItemRemoved?.(mediaId);
  }, [mediaId, onClose, onItemRemoved]);

  const handleHide = useCallback(async () => {
    onClose();
    if (!mediaId) return;
    await reportMedia(mediaId, 'hide_from_feed');
    onItemRemoved?.(mediaId);
  }, [mediaId, onClose, onItemRemoved]);

  const handleMuteCreator = useCallback(async () => {
    onClose();
    if (!creatorId) return;
    Alert.alert(
      'Mute creator',
      "You won\u2019t see posts from this creator in your feed.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mute',
          onPress: async () => {
            await muteUser(creatorId, ['posts']);
          },
        },
      ],
    );
  }, [creatorId, onClose]);

  const handleUnfollow = useCallback(async () => {
    onClose();
    if (!creatorId) return;
    Alert.alert(
      'Unfollow creator',
      "You\u2019ll stop seeing their posts in your Following feed.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unfollow',
          onPress: async () => { await unfollowUser(creatorId); },
        },
      ],
    );
  }, [creatorId, onClose]);

  const handleBlock = useCallback(async () => {
    onClose();
    if (!creatorId) return;
    Alert.alert(
      'Block creator',
      "They won\u2019t be able to see your profile or content.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            await blockUser(creatorId);
            if (mediaId) onItemRemoved?.(mediaId);
          },
        },
      ],
    );
  }, [creatorId, mediaId, onClose, onItemRemoved]);

  const handleReport = useCallback(() => {
    onClose();
    if (!mediaId) return;
    Alert.alert(
      'Report this content',
      'Select a reason:',
      [
        { text: 'Spam', onPress: () => reportMedia(mediaId, 'spam') },
        { text: 'Misleading', onPress: () => reportMedia(mediaId, 'misinformation') },
        { text: 'Inappropriate', onPress: () => reportMedia(mediaId, 'nudity') },
        { text: 'Harassment', onPress: () => reportMedia(mediaId, 'harassment') },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [mediaId, onClose]);

  const handleWhyThis = useCallback(() => {
    onClose();
    onWhyThis?.();
  }, [onClose, onWhyThis]);

  // ── Owner actions ─────────────────────────────────────────────────────────

  const handleEdit = useCallback(() => {
    onClose();
    if (!mediaId) return;
    router.push(`/post/edit/${mediaId}`);
  }, [mediaId, onClose]);

  const handleDelete = useCallback(() => {
    onClose();
    if (!mediaId) return;
    Alert.alert(
      'Delete this post?',
      'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const result = await deleteMedia(mediaId);
            if (result.ok) onItemRemoved?.(mediaId);
          },
        },
      ],
    );
  }, [mediaId, onClose, onItemRemoved]);

  const handleChangeVisibility = useCallback(() => {
    onClose();
    if (!mediaId) return;
    const options: Array<{ text: string; vis: 'public' | 'private' }> = [
      { text: 'Public', vis: 'public' },
      { text: 'Private', vis: 'private' },
    ];
    Alert.alert(
      'Change visibility',
      `Currently: ${currentVisibility}`,
      [
        ...options
          .filter((o) => o.vis !== currentVisibility)
          .map((o) => ({
            text: o.text,
            onPress: () => updateMediaVisibility(mediaId, o.vis),
          })),
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [mediaId, currentVisibility, onClose]);

  // ── Gems extra action ─────────────────────────────────────────────────────

  const handleWrongPlace = useCallback(() => {
    onClose();
    if (!mediaId) return;
    Alert.alert(
      'Wrong place?',
      'Report this content as not matching the listed location.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Report wrong place',
          style: 'destructive',
          onPress: async () => {
            const result = await reportMedia(mediaId, 'media_does_not_match_place');
            if (result.ok) onItemRemoved?.(mediaId);
          },
        },
      ],
    );
  }, [mediaId, onClose, onItemRemoved]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Backdrop */}
      <Pressable style={s.backdrop} onPress={onClose} />

      {/* Sheet */}
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.md }]}>
        <View style={s.handle} />

        {/* Header */}
        <View style={s.sheetHeader}>
          <Text style={s.sheetTitle}>Options</Text>
          <Pressable onPress={onClose} style={s.closeBtn} hitSlop={8} accessibilityLabel="Close">
            <X size={20} color={color.mute} strokeWidth={1.8} />
          </Pressable>
        </View>

        <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
          {isOwner ? (
            /* ── Owner rows ─────────────────────────────────── */
            /* Gems (isGems=true) only support Delete — Edit and Change visibility are post-only. */
            <>
              {!isGems && (
                <Row icon={<Edit2 size={iconSize} color={iconColor} strokeWidth={1.8} />} label="Edit" onPress={handleEdit} />
              )}
              {!isGems && (
                <Row
                  icon={<Globe size={iconSize} color={iconColor} strokeWidth={1.8} />}
                  label="Change visibility"
                  onPress={handleChangeVisibility}
                />
              )}
              {!isGems && <View style={s.separator} />}
              <Row
                icon={<Trash2 size={iconSize} color={color.signal} strokeWidth={1.8} />}
                label={isGems ? 'Remove gem' : 'Delete'}
                onPress={handleDelete}
                destructive
              />
            </>
          ) : (
            /* ── Viewer rows ─────────────────────────────────── */
            <>
              <Row
                icon={<ThumbsDown size={iconSize} color={iconColor} strokeWidth={1.8} />}
                label="Not interested"
                onPress={handleNotInterested}
              />
              <Row
                icon={<EyeOff size={iconSize} color={iconColor} strokeWidth={1.8} />}
                label="Hide"
                onPress={handleHide}
              />
              <Row
                icon={<BellOff size={iconSize} color={iconColor} strokeWidth={1.8} />}
                label="Mute creator"
                onPress={handleMuteCreator}
              />
              <Row
                icon={<UserMinus size={iconSize} color={iconColor} strokeWidth={1.8} />}
                label="Unfollow creator"
                onPress={handleUnfollow}
              />
              <View style={s.separator} />
              <Row
                icon={<HelpCircle size={iconSize} color={iconColor} strokeWidth={1.8} />}
                label="Why this?"
                onPress={handleWhyThis}
              />
              <Row
                icon={<Flag size={iconSize} color={iconColor} strokeWidth={1.8} />}
                label="Report"
                onPress={handleReport}
              />
              <View style={s.separator} />
              <Row
                icon={<Ban size={iconSize} color={color.signal} strokeWidth={1.8} />}
                label="Block creator"
                onPress={handleBlock}
                destructive
              />
              {isGems && (
                <Row
                  icon={<AlertTriangle size={iconSize} color={color.signal} strokeWidth={1.8} />}
                  label="Wrong place"
                  onPress={handleWrongPlace}
                  destructive
                />
              )}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: space.sm,
    maxHeight: '75%',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: -4 } },
      android: { elevation: 12 },
    }),
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    marginBottom: space.sm,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  sheetTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 16,
  },
  closeBtn: {
    padding: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: 14,
    gap: space.md,
  },
  rowPressed: {
    backgroundColor: color.haze,
  },
  rowIcon: {
    width: 24,
    alignItems: 'center',
  },
  rowLabel: {
    ...t.body,
    color: color.ink,
    flex: 1,
  },
  rowLabelDestructive: {
    color: color.signal,
  },
  separator: {
    height: 1,
    backgroundColor: color.haze,
    marginHorizontal: space.lg,
    marginVertical: space.xs,
  },
});
