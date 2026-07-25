/**
 * NotificationBell
 *
 * Bell icon with unread badge. Tapping navigates directly to the full
 * Activity Center (/notifications) and clears the badge.
 */
import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Bell } from 'lucide-react-native';
import { color, space } from '../theme/tokens.ts';
import { useUnreadNotificationCount } from '../hooks/useNotifications.ts';
import { markAllNotificationsRead } from '../services/notifications.ts';

export function NotificationBell({ style }: { style?: StyleProp<ViewStyle> }) {
  const { count, refresh: refreshCount } = useUnreadNotificationCount();

  const handlePress = useCallback(() => {
    router.push('/notifications' as any);
    if (count > 0) {
      markAllNotificationsRead().then(refreshCount);
    }
  }, [count, refreshCount]);

  return (
    <Pressable
      style={[styles.bellBtn, style]}
      onPress={handlePress}
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
});
