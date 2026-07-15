/**
 * PostOwnerMenu — bottom sheet of owner-only actions for a post.
 *
 * Actions:
 *   - Edit Post
 *   - Edit History  (opens EditHistorySheet with real data)
 *   - Comment Audience (everyone / friends / circle / trip crew / verified / disabled)
 *   - Hide/Show Like Count
 *   - Disable/Enable Sharing
 *   - Disable/Enable Reposting
 *   - Archive
 *   - Delete
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
  ActionSheetIOS,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X, Pencil, Clock, Users, EyeOff, Eye,
  Share2, Repeat2, Archive, Trash2, ChevronRight,
} from 'lucide-react-native';
import { color, space, shadow } from '../theme/tokens';
import { updatePostSettings, archivePost, deletePost } from '../services/postEngagement';
import { EditHistorySheet } from './EditHistorySheet';

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
  onEdit?: () => void;
}

const AUDIENCE_OPTIONS: PostSettings['commentsSetting'][] = [
  'everyone', 'friends', 'circle', 'trip_crew', 'verified', 'disabled',
];

const AUDIENCE_LABELS: Record<PostSettings['commentsSetting'], string> = {
  everyone: 'Everyone',
  friends: 'Friends only',
  circle: 'Circle members',
  trip_crew: 'Trip crew',
  verified: 'Verified accounts',
  disabled: 'No one (disabled)',
};

function showAudiencePicker(
  current: PostSettings['commentsSetting'],
  onSelect: (v: PostSettings['commentsSetting']) => void,
) {
  const options = AUDIENCE_OPTIONS.map((k) => AUDIENCE_LABELS[k]);
  const cancelIndex = options.length;

  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Who can comment?',
        options: [...options, 'Cancel'],
        cancelButtonIndex: cancelIndex,
        destructiveButtonIndex: AUDIENCE_OPTIONS.indexOf('disabled'),
      },
      (idx) => {
        if (idx < AUDIENCE_OPTIONS.length) onSelect(AUDIENCE_OPTIONS[idx]);
      },
    );
  } else {
    const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }> = [
      ...AUDIENCE_OPTIONS.map((k) => ({
        text: AUDIENCE_LABELS[k],
        onPress: () => onSelect(k),
        style: k === 'disabled' ? ('destructive' as const) : undefined,
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ];
    Alert.alert('Who can comment?', undefined, buttons);
  }
}

export function PostOwnerMenu({
  visible,
  postId,
  settings,
  onClose,
  onSettingsChange,
  onArchived,
  onDeleted,
  onEdit,
}: Props) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [editHistoryOpen, setEditHistoryOpen] = useState(false);

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

  const handleAudiencePicker = useCallback(() => {
    onClose();
    setTimeout(() => {
      showAudiencePicker(settings.commentsSetting, async (value) => {
        setBusy(true);
        const next = { ...settings, commentsSetting: value };
        const ok = await updatePostSettings(postId, { commentsSetting: value });
        if (ok) {
          onSettingsChange(next);
        } else {
          Alert.alert('Error', 'Could not update comment audience. Please try again.');
        }
        setBusy(false);
      });
    }, 400);
  }, [postId, settings, onClose, onSettingsChange]);

  const handleEditHistory = useCallback(() => {
    onClose();
    setTimeout(() => setEditHistoryOpen(true), 350);
  }, [onClose]);

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

  return (
    <>
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

          {onEdit && (
            <MenuRow
              icon={<Pencil size={20} color={color.ink} />}
              label="Edit Post"
              onPress={() => { onClose(); onEdit(); }}
            />
          )}

          <MenuRow
            icon={<Clock size={20} color={color.ink} />}
            label="Edit History"
            onPress={handleEditHistory}
          />

          <View style={s.divider} />

          <MenuRow
            icon={<Users size={20} color={color.ink} />}
            label="Who can comment"
            value={AUDIENCE_LABELS[settings.commentsSetting]}
            onPress={handleAudiencePicker}
            showChevron
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
            icon={<Share2 size={20} color={color.ink} />}
            label={settings.sharingDisabled ? 'Allow Sharing' : 'Disable Sharing'}
            onPress={() => toggle({ sharingDisabled: !settings.sharingDisabled })}
          />

          <MenuRow
            icon={<Repeat2 size={20} color={color.ink} />}
            label={settings.repostingDisabled ? 'Allow Reposts' : 'Disable Reposts'}
            onPress={() => toggle({ repostingDisabled: !settings.repostingDisabled })}
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

      <EditHistorySheet
        visible={editHistoryOpen}
        postId={postId}
        onClose={() => setEditHistoryOpen(false)}
      />
    </>
  );
}

function MenuRow({
  icon,
  label,
  labelColor,
  value,
  showChevron,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  labelColor?: string;
  value?: string;
  showChevron?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={s.row} onPress={onPress} hitSlop={4}>
      <View style={s.rowIcon}>{icon}</View>
      <Text style={[s.rowLabel, labelColor ? { color: labelColor } : null]}>
        {label}
      </Text>
      {value != null && (
        <Text style={s.rowValue} numberOfLines={1}>{value}</Text>
      )}
      {showChevron && <ChevronRight size={16} color={color.faint} />}
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
  rowValue: {
    fontSize: 13,
    color: color.faint,
    maxWidth: 120,
    textAlign: 'right',
  },
});
