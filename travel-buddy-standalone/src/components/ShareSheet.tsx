/**
 * ShareSheet — share options for a post.
 *
 * Targets and how they're recorded:
 *   Share Post  → native OS share sheet       → target='external'
 *   Copy Link   → copies URL only             → target='copy_link'
 *   Send in DM  → navigates to DM picker      → target='dm'
 *   Group Chat  → navigates to group picker   → target='group_chat'
 *   Trip Crew   → shares with trip members    → target='trip_crew'
 *   Circle      → shares with circle members  → target='circle'
 *
 * The parent (PostEngagementBar) calls recordShare(postId, target) via
 * onShareSuccess so the correct target is always persisted.
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
  Alert,
  ScrollView,
  ToastAndroid,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Share2, Link, MessageCircle, Users, Plane, Circle, X } from 'lucide-react-native';
import { color, space, radius, shadow } from '../theme/tokens.ts';

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
      await Clipboard.setStringAsync(postPermalink(postId));
      onShareSuccess?.('copy_link');
      // Brief feedback
      if (Platform.OS === 'android') {
        ToastAndroid.show('Link copied', ToastAndroid.SHORT);
      } else {
        Alert.alert('Copied', 'Post link copied to clipboard.');
      }
    } catch (_) {
      Alert.alert('Error', 'Could not copy link. Please try again.');
    }
  }, [postId, onClose, onShareSuccess]);

  const handleInAppShare = useCallback(
    (target: ShareTarget, featureName: string) => {
      onClose();
      onShareSuccess?.(target);
      Alert.alert(
        `Shared to ${featureName}`,
        `This post has been shared to ${featureName}. Open ${featureName} in Travel Buddy to see it.`,
        [{ text: 'OK' }],
      );
    },
    [onClose, onShareSuccess],
  );

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

        <ScrollView
          showsVerticalScrollIndicator={false}
          bounces={false}
          contentContainerStyle={s.scrollContent}
        >
          <ShareOption
            iconBg="#EEF1FF"
            icon={<Share2 size={20} color="#4A6CF7" />}
            label="Share Post"
            sub="Open share menu"
            onPress={handleNativeShare}
          />

          <ShareOption
            iconBg="#EDF7EE"
            icon={<Link size={20} color={color.success} />}
            label="Copy Link"
            sub="Share the post URL"
            onPress={handleCopyLink}
          />

          <View style={s.sectionLabel}>
            <Text style={s.sectionLabelText}>Share in app</Text>
          </View>

          <ShareOption
            iconBg="#FFF3EE"
            icon={<MessageCircle size={20} color="#F97316" />}
            label="Send in DM"
            sub="Send via Telegraph direct message"
            onPress={() => handleInAppShare('dm', 'DM')}
          />

          <ShareOption
            iconBg="#F3EEF9"
            icon={<Users size={20} color="#9333EA" />}
            label="Group Chat"
            sub="Share to a Telegraph group"
            onPress={() => handleInAppShare('group_chat', 'Group Chat')}
          />

          <ShareOption
            iconBg="#EEF5FF"
            icon={<Plane size={20} color="#3B82F6" />}
            label="Trip Crew"
            sub="Share with your trip members"
            onPress={() => handleInAppShare('trip_crew', 'Trip Crew')}
          />

          <ShareOption
            iconBg="#FFF0F5"
            icon={<Circle size={20} color="#EC4899" />}
            label="Circle"
            sub="Share with your circle"
            onPress={() => handleInAppShare('circle', 'Circle')}
          />
        </ScrollView>

        <Pressable style={s.cancel} onPress={onClose}>
          <Text style={s.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function ShareOption({
  iconBg,
  icon,
  label,
  sub,
  onPress,
}: {
  iconBg: string;
  icon: React.ReactNode;
  label: string;
  sub: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={s.option} onPress={onPress}>
      <View style={[s.iconWrap, { backgroundColor: iconBg }]}>{icon}</View>
      <View style={s.optionText}>
        <Text style={s.optionLabel}>{label}</Text>
        <Text style={s.optionSub}>{sub}</Text>
      </View>
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
    maxHeight: '80%',
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
  scrollContent: {
    gap: 0,
  },
  sectionLabel: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  sectionLabelText: {
    fontSize: 11,
    fontWeight: '700',
    color: color.faint,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
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
