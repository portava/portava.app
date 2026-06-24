/**
 * NotificationBell
 *
 * Bell icon with unread badge. Tapping opens a compact popover showing the
 * last 5 notifications plus a "See all" link to the Activity Center.
 * Badge clears when the Activity Center is opened.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, Modal, FlatList, StyleSheet, Platform,
  TouchableWithoutFeedback, ActivityIndicator, type StyleProp, type ViewStyle,
} from 'react-native';
import { router } from 'expo-router';
import { Bell } from 'lucide-react-native';
import { color, space, type as t, radius, shadow } from '../theme/tokens';
import { useRecentNotifications, useUnreadNotificationCount } from '../hooks/useNotifications';
import { markAllNotificationsRead, type AppNotification } from '../services/notifications';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

const CATEGORY_ICONS: Record<string, string> = {
  plans:       '📋',
  trips:       '✈️',
  telegraph:   '💬',
  safe_return: '🛡️',
  location:    '📍',
  trip_crew:   '👥',
  compass:     '🧭',
  pulse:       '🌍',
  passport:    '📘',
  hidden_gems: '💎',
  trust:       '⭐',
  airport:     '🏔️',
  admin:       '⚠️',
};

const PRIORITY_COLORS: Record<string, string> = {
  urgent:    '#DC2626',
  important: '#D97706',
  normal:    color.deep,
  low:       color.mute,
};

interface PopoverItemProps {
  notification: AppNotification;
  onPress: () => void;
}

function PopoverItem({ notification, onPress }: PopoverItemProps) {
  const icon = CATEGORY_ICONS[notification.category] ?? '🔔';
  const isUnread = !notification.readAt;
  const priorityColor = PRIORITY_COLORS[notification.priority] ?? color.mute;

  return (
    <Pressable style={[styles.popoverItem, isUnread && styles.popoverItemUnread]} onPress={onPress}>
      <Text style={styles.categoryIcon}>{icon}</Text>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
          {isUnread && <View style={[styles.unreadDot, { backgroundColor: priorityColor }]} />}
          <Text style={[styles.popoverTitle, { color: isUnread ? color.ink : color.mute }]} numberOfLines={1}>
            {notification.title}
          </Text>
        </View>
        <Text style={styles.popoverBody} numberOfLines={2}>{notification.body}</Text>
      </View>
      <Text style={styles.popoverTime}>{relativeTime(notification.createdAt)}</Text>
    </Pressable>
  );
}

export function NotificationBell({ style }: { style?: StyleProp<ViewStyle> }) {
  const [open, setOpen] = useState(false);
  const bellRef = useRef<View>(null);
  const [bellLayout, setBellLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const { count, refresh: refreshCount } = useUnreadNotificationCount();
  const { notifications, loading, reload } = useRecentNotifications();

  const handleOpen = useCallback(() => {
    bellRef.current?.measure((_fx, _fy, w, h, px, py) => {
      setBellLayout({ x: px, y: py, width: w, height: h });
    });
    reload();
    setOpen(true);
  }, [reload]);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleSeeAll = useCallback(() => {
    handleClose();
    router.push('/notifications' as any);
    if (count > 0) {
      markAllNotificationsRead().then(refreshCount);
    }
  }, [handleClose, count, refreshCount]);

  const handleItemPress = useCallback((notification: AppNotification) => {
    handleClose();
    if (notification.actionUrl) {
      router.push(notification.actionUrl as any);
    } else {
      router.push('/notifications' as any);
    }
  }, [handleClose]);

  return (
    <>
      <Pressable
        ref={bellRef as any}
        style={[styles.bellBtn, style]}
        onPress={handleOpen}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={count > 0 ? `${count} unread notifications` : 'Notifications'}
      >
        <Bell size={22} color={color.ink} />
        {count > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{count > 99 ? '99+' : String(count)}</Text>
          </View>
        )}
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={handleClose}
        statusBarTranslucent={Platform.OS === 'android'}
      >
        <TouchableWithoutFeedback onPress={handleClose}>
          <View style={styles.overlay}>
            <TouchableWithoutFeedback>
              <View style={[styles.popover, bellLayout ? {
                position: 'absolute',
                top: (bellLayout.y + bellLayout.height + 8),
                right: 16,
              } : {}]}>
                {/* Header */}
                <View style={styles.popoverHeader}>
                  <Text style={styles.popoverHeading}>Notifications</Text>
                  <Pressable onPress={handleSeeAll} hitSlop={8}>
                    <Text style={styles.seeAllLink}>See all</Text>
                  </Pressable>
                </View>

                {/* Items */}
                {loading ? (
                  <View style={styles.popoverEmpty}>
                    <ActivityIndicator size="small" color={color.mute} />
                  </View>
                ) : notifications.length === 0 ? (
                  <View style={styles.popoverEmpty}>
                    <Text style={styles.popoverEmptyText}>No notifications yet</Text>
                  </View>
                ) : (
                  <FlatList
                    data={notifications}
                    keyExtractor={(n) => n.id}
                    renderItem={({ item }) => (
                      <PopoverItem notification={item} onPress={() => handleItemPress(item)} />
                    )}
                    scrollEnabled={false}
                    ItemSeparatorComponent={() => <View style={styles.divider} />}
                  />
                )}
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bellBtn: {
    position: 'relative',
    padding: space.xs,
  },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    lineHeight: 11,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  popover: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    width: 320,
    maxHeight: 420,
    ...shadow.float,
    borderWidth: 1,
    borderColor: color.haze,
  },
  popoverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  popoverHeading: {
    ...t.bodyStrong,
    color: color.ink,
  },
  seeAllLink: {
    ...t.small,
    color: color.signal,
    fontWeight: '600',
  },
  popoverItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  popoverItemUnread: {
    backgroundColor: '#F0F9FF',
  },
  categoryIcon: {
    fontSize: 18,
    lineHeight: 22,
    marginTop: 1,
  },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  popoverTitle: {
    ...t.small,
    fontWeight: '600',
    flex: 1,
  },
  popoverBody: {
    ...t.small,
    color: color.mute,
    lineHeight: 17,
  },
  popoverTime: {
    ...t.stamp,
    color: color.faint,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: color.haze,
    marginLeft: space.lg + 18 + space.md,
  },
  popoverEmpty: {
    padding: space.xl,
    alignItems: 'center',
  },
  popoverEmptyText: {
    ...t.small,
    color: color.mute,
  },
});
