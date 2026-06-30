/**
 * ShareSheet — share options for a post.
 *
 * Options:
 *   Share Post  → native OS share sheet → records target='external'
 *   Copy Link   → copies/shares URL only → records target='copy_link'
 *
 * Uses React Native's built-in Share API — no extra packages needed.
 * DM / Group Chat / Trip Crew / Circle share targets are planned TODOs.
 */
import React, { useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Share2, Link, X } from 'lucide-react-native';
import { color, space, radius, shadow } from '../theme/tokens';

export type ShareTarget = 'external' | 'copy_link' | 'dm' | 'group_chat' | 'trip_crew' | 'circle';

interface Props {
  visible: boolean;
  postId: string;
  onClose: () => void;
  onShareSuccess?: (target: ShareTarget) => void;
}

function postPermalink(postId: string): string {
  return `https://travelbuddy.app/posts/${postId}`;
}

export function ShareSheet({ visible, postId, onClose, onShareSuccess }: Props) {
  const insets = useSafeAreaInsets();

  const handleNativeShare = useCallback(async () => {
    onClose();
    try {
      const result = await Share.share({
        message: `Check out this post on Travel Buddy!\n${postPermalink(postId)}`,
        ...(Platform.OS === 'ios' ? { url: postPermalink(postId) } : {}),
      });
      if (result.action === Share.sharedAction) {
        onShareSuccess?.('external');
      }
    } catch (_) {
      // User cancelled or share unavailable — silent
    }
  }, [postId, onClose, onShareSuccess]);

  const handleCopyLink = useCallback(async () => {
    onClose();
    try {
      await Share.share({
        message: postPermalink(postId),
        ...(Platform.OS === 'ios' ? { url: postPermalink(postId) } : {}),
      });
      onShareSuccess?.('copy_link');
    } catch (_) {
      // Silent
    }
  }, [postId, onClose, onShareSuccess]);

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
          <Text style={s.title}>Share Post</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        <Pressable style={s.option} onPress={handleNativeShare}>
          <View style={[s.iconWrap, { backgroundColor: '#EEF1FF' }]}>
            <Share2 size={20} color="#4A6CF7" />
          </View>
          <View style={s.optionText}>
            <Text style={s.optionLabel}>Share Post</Text>
            <Text style={s.optionSub}>Open share menu</Text>
          </View>
        </Pressable>

        <Pressable style={s.option} onPress={handleCopyLink}>
          <View style={[s.iconWrap, { backgroundColor: '#EDF7EE' }]}>
            <Link size={20} color={color.success} />
          </View>
          <View style={s.optionText}>
            <Text style={s.optionLabel}>Copy Link</Text>
            <Text style={s.optionSub}>Share the post URL</Text>
          </View>
        </Pressable>

        <Pressable style={s.cancel} onPress={onClose}>
          <Text style={s.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
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
    gap: space.xs,
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
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: color.ink,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  optionLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: color.ink,
  },
  optionSub: {
    fontSize: 12,
    color: color.faint,
  },
  cancel: {
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.haze,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: color.ink,
  },
});
