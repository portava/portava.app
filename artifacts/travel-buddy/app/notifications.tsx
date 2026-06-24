/**
 * Activity Center — unified notification & activity feed.
 *
 * Tabs: All / Plans / Trips / Telegraph / Safety / Compass / Pulse / Passport / Hidden Gems / Trust / Admin
 *
 * Each ActivityCard shows:
 *   category icon, title, short body, relative time,
 *   unread dot, priority badge, deep-link action button.
 *
 * Supports: mark-all-read, pull-to-refresh, infinite scroll pagination.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, FlatList, ActivityIndicator,
  RefreshControl, ScrollView,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, CheckCheck } from 'lucide-react-native';
import { color, space, type as t, radius, shadow } from '../src/theme/tokens';
import { useNotifications } from '../src/hooks/useNotifications';
import type { AppNotification, NotificationCategory } from '../src/services/notifications';

// ── Tab definitions ───────────────────────────────────────────────────────────

interface TabDef {
  key: string;
  label: string;
  category?: NotificationCategory;
}

const TABS: TabDef[] = [
  { key: 'all',         label: 'All' },
  { key: 'plans',       label: 'Plans',       category: 'plans' },
  { key: 'trips',       label: 'Trips',       category: 'trips' },
  { key: 'telegraph',   label: 'Telegraph',   category: 'telegraph' },
  { key: 'safe_return', label: 'Safety',      category: 'safe_return' },
  { key: 'compass',     label: 'Compass',     category: 'compass' },
  { key: 'pulse',       label: 'Pulse',       category: 'pulse' },
  { key: 'passport',    label: 'Passport',    category: 'passport' },
  { key: 'hidden_gems', label: 'Hidden Gems', category: 'hidden_gems' },
  { key: 'trust',       label: 'Trust',       category: 'trust' },
  { key: 'admin',       label: 'Admin',       category: 'admin' },
];

// ── Visual helpers ────────────────────────────────────────────────────────────

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

const PRIORITY_BADGE: Record<string, { bg: string; text: string; label: string } | null> = {
  urgent:    { bg: '#FEE2E2', text: '#DC2626', label: 'Urgent' },
  important: { bg: '#FEF3C7', text: '#92400E', label: 'Important' },
  normal:    null,
  low:       null,
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86400000);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ── ActivityCard ──────────────────────────────────────────────────────────────

function ActivityCard({
  notification,
  onMarkRead,
  onDismiss,
}: {
  notification: AppNotification;
  onMarkRead: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const isUnread = !notification.readAt;
  const badge = PRIORITY_BADGE[notification.priority];
  const icon = CATEGORY_ICONS[notification.category] ?? '🔔';

  const handlePress = useCallback(() => {
    if (isUnread) onMarkRead(notification.id);
    if (notification.actionUrl) {
      router.push(notification.actionUrl as any);
    }
  }, [notification, isUnread, onMarkRead]);

  return (
    <Pressable
      style={[styles.card, isUnread && styles.cardUnread]}
      onPress={handlePress}
    >
      {/* Unread dot */}
      {isUnread && <View style={styles.unreadDot} />}

      {/* Category icon */}
      <View style={[styles.iconWrap, notification.category === 'safe_return' && styles.iconWrapSafety]}>
        <Text style={styles.catIcon}>{icon}</Text>
      </View>

      {/* Content */}
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' }}>
          <Text
            style={[styles.cardTitle, isUnread && styles.cardTitleUnread]}
            numberOfLines={1}
          >
            {notification.title}
          </Text>
          {badge && (
            <View style={[styles.priorityBadge, { backgroundColor: badge.bg }]}>
              <Text style={[styles.priorityBadgeText, { color: badge.text }]}>{badge.label}</Text>
            </View>
          )}
        </View>

        <Text style={styles.cardBody} numberOfLines={3}>{notification.body}</Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
          <Text style={styles.cardTime}>{relativeTime(notification.createdAt)}</Text>

          {/* Action button */}
          {notification.actionUrl && (
            <Pressable
              style={styles.actionBtn}
              onPress={handlePress}
              hitSlop={4}
            >
              <Text style={styles.actionBtnText}>View ›</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Dismiss */}
      <Pressable
        style={styles.dismissBtn}
        onPress={() => onDismiss(notification.id)}
        hitSlop={8}
      >
        <X size={14} color={color.faint} />
      </Pressable>
    </Pressable>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ label }: { label: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyIcon}>🔔</Text>
      <Text style={styles.emptyTitle}>All caught up</Text>
      <Text style={styles.emptyBody}>
        No {label.toLowerCase()} notifications yet.
      </Text>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ActivityCenter() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState('all');
  const tabScrollRef = useRef<ScrollView>(null);

  const activeTabDef = TABS.find((t) => t.key === activeTab) ?? TABS[0];
  const { notifications, loading, loadingMore, unreadCount, reload, loadMore, markRead, markAllRead, dismiss } =
    useNotifications(activeTabDef.category ? { category: activeTabDef.category } : {});

  // Mark all read on focus when Activity Center is opened
  useFocusEffect(useCallback(() => {
    // Slight delay so the user sees the unread state briefly
    const timer = setTimeout(() => {
      if (unreadCount > 0) markAllRead(activeTabDef.category);
    }, 800);
    return () => clearTimeout(timer);
  }, [activeTab]));

  const handleTabPress = useCallback((tabKey: string) => {
    setActiveTab(tabKey);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + space.md }]}>
        <Text style={styles.headerTitle}>Activity Center</Text>
        <View style={{ flex: 1 }} />
        {unreadCount > 0 && (
          <Pressable
            style={styles.markAllBtn}
            onPress={() => markAllRead(activeTabDef.category)}
            hitSlop={8}
          >
            <CheckCheck size={16} color={color.deep} />
            <Text style={styles.markAllBtnText}>Mark all read</Text>
          </Pressable>
        )}
        <Pressable onPress={() => router.back()} hitSlop={8} style={{ marginLeft: space.md }}>
          <X size={24} color={color.ink} />
        </Pressable>
      </View>

      {/* Tab bar (horizontally scrollable) */}
      <ScrollView
        ref={tabScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabBar}
        contentContainerStyle={styles.tabBarContent}
      >
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <Pressable
              key={tab.key}
              style={[styles.tab, isActive && styles.tabActive]}
              onPress={() => handleTabPress(tab.key)}
            >
              <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Content */}
      {loading && notifications.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={color.signal} />
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(n) => n.id}
          renderItem={({ item }) => (
            <ActivityCard
              notification={item}
              onMarkRead={markRead}
              onDismiss={dismiss}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={[
            styles.listContent,
            notifications.length === 0 && { flex: 1 },
          ]}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={reload}
              tintColor={color.signal}
            />
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          ListFooterComponent={loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" color={color.mute} />
            </View>
          ) : null}
          ListEmptyComponent={
            <EmptyState label={activeTabDef.label} />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    backgroundColor: color.paperRaised,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  headerTitle: {
    ...t.heading,
    color: color.ink,
  },
  markAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: '#EEF6FF',
  },
  markAllBtnText: {
    ...t.small,
    color: color.deep,
    fontWeight: '600',
  },
  tabBar: {
    backgroundColor: color.paperRaised,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    flexGrow: 0,
  },
  tabBarContent: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.xs,
  },
  tab: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: 'transparent',
  },
  tabActive: {
    backgroundColor: color.ink,
  },
  tabText: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
  },
  tabTextActive: {
    color: color.onInk,
  },
  listContent: {
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    ...shadow.card,
    position: 'relative',
  },
  cardUnread: {
    backgroundColor: '#F0F9FF',
    borderLeftWidth: 3,
    borderLeftColor: color.deep,
  },
  unreadDot: {
    position: 'absolute',
    top: space.md,
    left: -10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: color.signal,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapSafety: {
    backgroundColor: '#FEE2E2',
  },
  catIcon: {
    fontSize: 20,
    lineHeight: 24,
  },
  cardTitle: {
    ...t.small,
    fontWeight: '600',
    color: color.mute,
    flex: 1,
  },
  cardTitleUnread: {
    color: color.ink,
    fontWeight: '700',
  },
  priorityBadge: {
    paddingHorizontal: space.xs,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  priorityBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 14,
  },
  cardBody: {
    ...t.small,
    color: color.mute,
    lineHeight: 18,
  },
  cardTime: {
    ...t.stamp,
    color: color.faint,
  },
  actionBtn: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
  },
  actionBtnText: {
    ...t.stamp,
    color: color.deep,
    fontWeight: '700',
  },
  dismissBtn: {
    padding: space.xs,
    marginTop: -2,
  },
  sep: {
    height: space.sm,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    padding: space.xl,
    alignItems: 'center',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xxl,
    gap: space.md,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyTitle: {
    ...t.heading,
    color: color.ink,
    textAlign: 'center',
  },
  emptyBody: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
});
