/**
 * NotificationCard — shared card for notification list surfaces.
 * Icon/avatar, text, timestamp, action.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Bell } from 'lucide-react-native';
import { AvatarImage } from '../ui/DisplayMediaImage.tsx';
import { color, space, radius, typography, layout } from '../../theme/tokens.ts';
import type { AppNotification } from '../../services/notifications.ts';

export interface NotificationCardProps {
  notification: AppNotification;
  onPress?: () => void;
  actionLabel?: string;
  onAction?: () => void;
}

function formatTimeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function NotificationCard({ notification, onPress, actionLabel, onAction }: NotificationCardProps) {
  const isUnread = !notification.readAt;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        isUnread && styles.cardUnread,
        pressed && { opacity: layout.pressedOpacity },
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={notification.title}
    >
      {/* Unread dot */}
      {isUnread ? <View style={styles.unreadDot} /> : null}

      {/* Icon or avatar */}
      <View style={styles.iconWrap}>
        {notification.imageUrl ? (
          <AvatarImage
            uri={notification.imageUrl}
            user={{ displayName: notification.title }}
            size={40}
          />
        ) : (
          <View style={styles.bellWrap}>
            <Bell size={18} color={color.signal} strokeWidth={1.5} />
          </View>
        )}
      </View>

      {/* Content */}
      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={1}>{notification.title}</Text>
        <Text style={styles.body} numberOfLines={2}>{notification.body}</Text>
        <Text style={styles.timestamp}>{formatTimeAgo(notification.createdAt)}</Text>
      </View>

      {/* Optional action */}
      {onAction && actionLabel ? (
        <Pressable
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
          onPress={(e) => { e.stopPropagation?.(); onAction(); }}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
        >
          <Text style={styles.actionBtnText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: color.paperRaised,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  cardUnread: {
    backgroundColor: '#F0F8FF',
  },
  unreadDot: {
    position: 'absolute',
    left: space.sm,
    top: '50%',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.signal,
    marginTop: -3,
  },
  iconWrap: {
    flexShrink: 0,
  },
  bellWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    gap: 2,
  },
  title: {
    ...typography.label,
    color: color.ink,
  },
  body: {
    ...typography.caption,
    color: color.mute,
  },
  timestamp: {
    ...typography.metadata,
    color: color.faint,
    marginTop: 2,
  },
  actionBtn: {
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: color.signal,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    flexShrink: 0,
  },
  actionBtnText: {
    ...typography.button,
    color: color.signal,
    fontSize: 12,
  },
});
