/**
 * NotificationToast
 *
 * In-app toast banner that fires when a new notification arrives via the
 * polling refresh. Priority determines display duration and style.
 *
 * Safety-priority toasts use a distinct but non-alarming style.
 * Banner text always uses the privacy-guarded title/body from the notification
 * record — never raw metadata.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, Pressable, StyleSheet, Text, View, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { X } from 'lucide-react-native';
import { color, space, type as t, radius, shadow } from '../theme/tokens.ts';
import type { AppNotification } from '../services/notifications.ts';

const DISPLAY_DURATIONS: Record<string, number> = {
  urgent:    8000,
  important: 6000,
  normal:    4000,
  low:       3000,
};

const PRIORITY_STYLES: Record<string, { bg: string; border: string; titleColor: string }> = {
  urgent:    { bg: '#FEF2F2', border: '#FCA5A5', titleColor: '#DC2626' },
  important: { bg: '#FFFBEB', border: '#FCD34D', titleColor: '#92400E' },
  normal:    { bg: color.paperRaised, border: color.haze, titleColor: color.ink },
  low:       { bg: color.paper, border: color.haze, titleColor: color.mute },
};

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

interface ToastItem {
  id: string;
  notification: AppNotification;
}

interface NotificationToastProps {
  notification: AppNotification | null;
  onDismiss?: () => void;
}

function SingleToast({
  notification,
  onDismiss,
}: { notification: AppNotification; onDismiss: () => void }) {
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(-120)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: -120, duration: 250, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start(onDismiss);
  }, [translateY, opacity, onDismiss]);

  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, tension: 120, friction: 10, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();

    const duration = DISPLAY_DURATIONS[notification.priority] ?? 4000;
    timerRef.current = setTimeout(dismiss, duration);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const style = PRIORITY_STYLES[notification.priority] ?? PRIORITY_STYLES.normal;
  const icon = CATEGORY_ICONS[notification.category] ?? '🔔';

  const handlePress = useCallback(() => {
    dismiss();
    if (notification.actionUrl) {
      router.push(notification.actionUrl as any);
    }
  }, [notification, dismiss]);

  return (
    <Animated.View
      style={[
        styles.toast,
        {
          top: insets.top + space.md,
          backgroundColor: style.bg,
          borderColor: style.border,
          transform: [{ translateY }],
          opacity,
        },
      ]}
    >
      <Pressable style={styles.toastInner} onPress={handlePress}>
        <Text style={styles.toastIcon}>{icon}</Text>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.toastTitle, { color: style.titleColor }]} numberOfLines={1}>
            {notification.title}
          </Text>
          <Text style={styles.toastBody} numberOfLines={2}>{notification.body}</Text>
        </View>
        <Pressable style={styles.closeBtn} onPress={dismiss} hitSlop={8}>
          <X size={14} color={color.mute} />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

// ── ToastQueue: manages up to 2 concurrent toasts ─────────────────────────────

const toastQueue: Array<() => void> = [];
let globalShowToast: ((notification: AppNotification) => void) | null = null;

export function showNotificationToast(notification: AppNotification) {
  if (globalShowToast) {
    globalShowToast(notification);
  } else {
    toastQueue.push(() => globalShowToast?.(notification));
  }
}

export function NotificationToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((notification: AppNotification) => {
    const id = `${notification.id}_${Date.now()}`;
    setToasts((prev) => [...prev.slice(-1), { id, notification }]);
  }, []);

  useEffect(() => {
    globalShowToast = show;
    // Drain any queued toasts
    const drained = toastQueue.splice(0);
    drained.forEach((fn) => fn());
    return () => { if (globalShowToast === show) globalShowToast = null; };
  }, [show]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <>
      {children}
      {toasts.map((item) => (
        <SingleToast
          key={item.id}
          notification={item.notification}
          onDismiss={() => dismiss(item.id)}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    zIndex: 9999,
    ...shadow.float,
    elevation: 20,
  },
  toastInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    padding: space.md,
  },
  toastIcon: {
    fontSize: 20,
    lineHeight: 24,
  },
  toastTitle: {
    ...t.small,
    fontWeight: '700',
  },
  toastBody: {
    ...t.small,
    color: color.mute,
    lineHeight: 17,
  },
  closeBtn: {
    padding: space.xs,
    marginTop: -2,
  },
});
