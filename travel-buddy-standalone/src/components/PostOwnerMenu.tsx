/**
 * PostOwnerMenu — bottom sheet of owner-only actions for a post.
 *
 * Actions: Edit (TODO — opens edit sheet), Disable/Enable Comments,
 * Hide/Show Like Count, Disable/Enable Sharing, Archive, Delete.
 */
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X, MessageCircleOff, MessageCircle, EyeOff, Eye,
  Share2, ShareIcon, Archive, Trash2,
} from 'lucide-react-native';
import { color, space, radius, shadow } from '../theme/tokens';
import { updatePostSettings, archivePost, deletePost } from '../services/postEngagement';

export interface PostSettings {
  commentsSetting: 'everyone' | 'friends' | 'circle' | 'trip_crew' | 'verified' | 'disabled';
  likesHidden: boolean;
  sharingDisabled: boolean;
  repostingDisabled: boolean;
}

interface Props {
  visible: boolean;
  postId: string;
  settings: PostSettings;
  onClose: () => void;
  onSettingsChange: (s: PostSettings) => void;
  onArchived: () => void;
  onDeleted: () => void;
}

export function PostOwnerMenu({
  visible,
  postId,
  settings,
  onClose,
  onSettingsChange,
  onArchived,
  onDeleted,
}: Props) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);

  const toggle = useCallback(
    async (field: Partial<PostSettings>) => {
      if (busy) return;
      setBusy(true);
      const next = { ...settings, ...field };
      const ok = await updatePostSettings(postId, field);
      if (ok) {
        onSettingsChange(next);
      } else {
        Alert.alert('Error', 'Could not update setting. Please try again.');
      }
      setBusy(false);
    },
    [busy, postId, settings, onSettingsChange],
  );

  const handleArchive = useCallback(async () => {
    Alert.alert(
      'Archive post?',
      'This post will be hidden from your feed and others. You can unarchive it later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          onPress: async () => {
            onClose();
            const ok = await archivePost(postId);
            if (ok) {
              onArchived();
            } else {
              Alert.alert('Error', 'Could not archive post. Please try again.');
            }
          },
        },
      ],
    );
  }, [postId, onClose, onArchived]);

  const handleDelete = useCallback(async () => {
    Alert.alert(
      'Delete post?',
      'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            onClose();
            const ok = await deletePost(postId);
            if (ok) {
              onDeleted();
            } else {
              Alert.alert('Error', 'Could not delete post. Please try again.');
            }
          },
        },
      ],
    );
  }, [postId, onClose, onDeleted]);

  const commentsDisabled = settings.commentsSetting === 'disabled';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.md }]}>
        <View style={s.header}>
          <Text style={s.title}>Post Options</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        {busy && (
          <View style={s.busyOverlay} pointerEvents="none">
            <ActivityIndicator color={color.signal} />
          </View>
        )}

        <MenuRow
          icon={
            commentsDisabled
              ? <MessageCircle size={20} color={color.ink} />
              : <MessageCircleOff size={20} color={color.ink} />
          }
          label={commentsDisabled ? 'Enable Comments' : 'Disable Comments'}
          onPress={() =>
            toggle({ commentsSetting: commentsDisabled ? 'everyone' : 'disabled' })
          }
        />

        <MenuRow
          icon={
            settings.likesHidden
              ? <Eye size={20} color={color.ink} />
              : <EyeOff size={20} color={color.ink} />
          }
          label={settings.likesHidden ? 'Show Like Count' : 'Hide Like Count'}
          onPress={() => toggle({ likesHidden: !settings.likesHidden })}
        />

        <MenuRow
          icon={
            settings.sharingDisabled
              ? <Share2 size={20} color={color.ink} />
              : <ShareIcon size={20} color={color.ink} />
          }
          label={settings.sharingDisabled ? 'Allow Sharing' : 'Disable Sharing'}
          onPress={() => toggle({ sharingDisabled: !settings.sharingDisabled })}
        />

        <View style={s.divider} />

        <MenuRow
          icon={<Archive size={20} color={color.mute} />}
          label="Archive Post"
          labelColor={color.mute}
          onPress={handleArchive}
        />

        <MenuRow
          icon={<Trash2 size={20} color={color.signal} />}
          label="Delete Post"
          labelColor={color.signal}
          onPress={handleDelete}
        />
      </View>
    </Modal>
  );
}

function MenuRow({
  icon,
  label,
  labelColor,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  labelColor?: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={s.row} onPress={onPress} hitSlop={4}>
      <View style={s.rowIcon}>{icon}</View>
      <Text style={[s.rowLabel, labelColor ? { color: labelColor } : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,15,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: space.md,
    ...shadow.card,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    marginBottom: space.xs,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: color.ink,
  },
  busyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  divider: {
    height: 1,
    backgroundColor: color.haze,
    marginHorizontal: space.lg,
    marginVertical: space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  rowIcon: {
    width: 36,
    alignItems: 'center',
  },
  rowLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: color.ink,
    flex: 1,
  },
});
