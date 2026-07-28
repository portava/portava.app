/**
 * Activity Center — unified notification & activity feed.
 *
 * Tabs: All / Plans / Trips / Telegraph / Safety / Compass / Pulse / Passport / Hidden Gems / Trust / Admin / Requests
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
  RefreshControl, ScrollView, Alert, Linking,
} from 'react-native';
import { UserAvatarButton } from '../src/components/interaction/UserAvatarButton';
import { UserNameButton } from '../src/components/interaction/UserNameButton';
import { secondaryIdentityText } from '../src/lib/displayIdentity';
import { router, useFocusEffect } from 'expo-router';
import { FEED_FOCUS_TTL_MS } from '../src/hooks/usePosts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, CheckCheck, UserCheck, UserMinus } from 'lucide-react-native';
import { color, space, type as t, radius, shadow } from '../src/theme/tokens';
import { useNotifications } from '../src/hooks/useNotifications';
import type { AppNotification, NotificationCategory } from '../src/services/notifications';
import { freshToken } from '../src/services/apiToken';
import { useRequests } from '../src/hooks/useRequests';
import { acceptRequest, declineRequest } from '../src/services/requests';
import type { InboxItem } from '../src/services/requests';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../src/hooks/useNavBarCollapse';

// ── Tab definitions ───────────────────────────────────────────────────────────

interface TabDef {
  key: string;
  label: string;
  category?: NotificationCategory;
}

const TABS: TabDef[] = [
  { key: 'all',         label: 'All' },
  { key: 'requests',    label: 'Requests' },
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
  media:       '🏆',
};

// ── Featured permission helper ────────────────────────────────────────────────

function isFeaturedPermissionRequest(notification: AppNotification): boolean {
  return (notification as any).eventType === 'featured.permission_request';
}

function getPostIdFromActionUrl(actionUrl?: string | null): string | null {
  if (!actionUrl) return null;
  const match = actionUrl.match(/\/post\/([^/?]+)/);
  return match?.[1] ?? null;
}

async function respondToFeaturedPermission(
  postId: string,
  action: 'accept' | 'decline',
  disambiguator?: { featuredId?: string; category?: string },
): Promise<{ ok: boolean; message?: string }> {
  try {
    const token = await freshToken();
    const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
    // Pass featuredId (preferred) or category in the body so the server can
    // disambiguate when the same post has multiple pending_permission rows.
    const body: Record<string, string> = {};
    if (disambiguator?.featuredId) body.featuredId = disambiguator.featuredId;
    else if (disambiguator?.category) body.category = disambiguator.category;
    const res = await fetch(
      `${apiBase}/api/admin/featured/${action === 'accept' ? 'accept-permission' : 'decline-permission'}/${postId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const resBody = await res.json().catch(() => ({}));
      return { ok: false, message: (resBody as any)?.message ?? `API ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}

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
  const isFeaturedReq = isFeaturedPermissionRequest(notification);
  const [permBusy, setPermBusy] = useState<'accept' | 'decline' | null>(null);
  const [permDone, setPermDone] = useState<'accepted' | 'declined' | null>(null);

  const handlePress = useCallback(() => {
    if (isUnread) onMarkRead(notification.id);
    if (notification.actionUrl && !isFeaturedReq) {
      try {
        router.push(notification.actionUrl as any);
      } catch {
        Alert.alert('Content unavailable', 'This content is no longer available.', [{ text: 'OK' }]);
      }
    }
  }, [notification, isUnread, onMarkRead, isFeaturedReq]);

  const handleFeaturedPermission = useCallback(async (action: 'accept' | 'decline') => {
    const postId = getPostIdFromActionUrl(notification.actionUrl);
    if (!postId) {
      Alert.alert('Error', 'Could not find post ID for this request.');
      return;
    }
    // Pass featuredId (preferred) or category from notification metadata so the
    // server can resolve the exact pending_permission row when a post has been
    // nominated in multiple categories simultaneously.
    const meta = (notification as any).metadata as Record<string, unknown> | undefined;
    const disambiguator = {
      featuredId: (meta?.featuredId as string | undefined) || undefined,
      category:   (meta?.category   as string | undefined) || undefined,
    };
    setPermBusy(action);
    const result = await respondToFeaturedPermission(postId, action, disambiguator);
    setPermBusy(null);
    if (result.ok) {
      setPermDone(action === 'accept' ? 'accepted' : 'declined');
      onMarkRead(notification.id);
    } else {
      Alert.alert(
        action === 'accept' ? 'Could not accept' : 'Could not decline',
        result.message ?? 'Please try again.',
      );
    }
  }, [notification.actionUrl, notification.id, onMarkRead]);

  return (
    <Pressable
      style={[styles.card, isUnread && styles.cardUnread]}
      onPress={handlePress}
    >
      {/* Unread dot */}
      {isUnread && <View style={styles.unreadDot} />}

      {/* Category icon */}
      <View style={[styles.iconWrap, notification.category === 'safe_return' && styles.iconWrapSafety]}>
        <Text style={styles.catIcon}>{isFeaturedReq ? '🏆' : icon}</Text>
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

          {/* Featured permission: Accept / Decline action sheet */}
          {isFeaturedReq && !permDone ? (
            <View style={styles.permActionsRow}>
              <Pressable
                style={[styles.permBtn, styles.permBtnDecline]}
                onPress={() => handleFeaturedPermission('decline')}
                disabled={permBusy !== null}
                hitSlop={4}
              >
                <Text style={styles.permBtnDeclineText}>
                  {permBusy === 'decline' ? '…' : 'Decline'}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.permBtn, styles.permBtnAccept]}
                onPress={() => handleFeaturedPermission('accept')}
                disabled={permBusy !== null}
                hitSlop={4}
              >
                <Text style={styles.permBtnAcceptText}>
                  {permBusy === 'accept' ? '…' : 'Accept'}
                </Text>
              </Pressable>
            </View>
          ) : isFeaturedReq && permDone ? (
            <Text style={styles.permDoneText}>
              {permDone === 'accepted' ? '✓ Accepted' : 'Declined'}
            </Text>
          ) : (
            /* Standard action button */
            notification.actionUrl ? (
              <Pressable
                style={styles.actionBtn}
                onPress={handlePress}
                hitSlop={4}
              >
                <Text style={styles.actionBtnText}>View ›</Text>
              </Pressable>
            ) : null
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
        {label.toLowerCase() === 'all'
          ? 'No notifications yet.'
          : `No ${label.toLowerCase()} notifications yet.`}
      </Text>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ActivityCenter() {
  const insets = useSafeAreaInsets();
  const navBarScrollHandler = useNavBarScrollHandler();
  const [activeTab, setActiveTab] = useState('all');
  const tabScrollRef = useRef<ScrollView>(null);
  const lastMarkedReadAt = useRef<Record<string, number>>({});

  const activeTabDef = TABS.find((t) => t.key === activeTab) ?? TABS[0];
  const { notifications, loading, loadingMore, unreadCount, reload, loadMore, markRead, markAllRead, dismiss } =
    useNotifications(activeTabDef.category ? { category: activeTabDef.category } : {});
  const { incoming: incomingRequests, loading: reqLoading, reload: reloadRequests } = useRequests();

  // Mark all read on focus when Activity Center is opened, gated by a per-tab
  // TTL so navigating back from a detail view doesn't fire an unnecessary API call.
  useFocusEffect(useCallback(() => {
    const now = Date.now();
    if (now - (lastMarkedReadAt.current[activeTab] ?? 0) < FEED_FOCUS_TTL_MS) return;
    // Slight delay so the user sees the unread state briefly
    const timer = setTimeout(() => {
      if (unreadCount > 0) {
        markAllRead(activeTabDef.category);
        lastMarkedReadAt.current[activeTab] = Date.now();
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [activeTab]));

  const handleTabPress = useCallback((tabKey: string) => {
    setActiveTab(tabKey);
  }, []);

  const sharedHeader = (
    <View>
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
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      {/* Content */}
      {activeTab === 'requests' ? (
        <SocialRequestsPane
          items={incomingRequests}
          loading={reqLoading}
          onReload={reloadRequests}
          headerComponent={sharedHeader}
        />
      ) : loading && notifications.length === 0 ? (
        <View style={{ flex: 1 }}>
          {sharedHeader}
          <View style={styles.center}>
            <ActivityIndicator size="large" color={color.signal} />
          </View>
        </View>
      ) : (
        <FlatList
          ListHeaderComponent={sharedHeader}
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
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListFooterComponent={
            <>
              {loadingMore && (
                <View style={styles.footer}>
                  <ActivityIndicator size="small" color={color.mute} />
                </View>
              )}
              <NavBarFiller />
            </>
          }
          ListEmptyComponent={
            <EmptyState label={activeTabDef.label} />
          }
        />
      )}
    </View>
  );
}

// ── Social requests pane ──────────────────────────────────────────────────────

const REQUEST_TYPE_LABEL: Record<string, string> = {
  friend_request: 'Friend request',
  circle_invite:  'Circle invite',
  trip_invite:    'Trip invite',
};

function SocialRequestsPane({
  items,
  loading,
  onReload,
  headerComponent,
}: {
  items: InboxItem[];
  loading: boolean;
  onReload: () => void;
  headerComponent?: React.ReactNode;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const navBarScrollHandler = useNavBarScrollHandler();

  async function handleAccept(item: InboxItem) {
    setBusy(item.id);
    const res = await acceptRequest(item.type, item.id);
    setBusy(null);
    if (res.ok) {
      onReload();
      return;
    }
    if (res.reason === 'dob_missing') {
      Alert.alert(
        'Date of birth required',
        'This circle requires age verification. Add your date of birth to your profile to join.',
        [
          { text: 'Not now', style: 'cancel' },
          {
            text: 'Go to profile',
            onPress: () => router.push('/profile/edit' as any),
          },
        ],
      );
      return;
    }
    if (res.reason === 'age_not_eligible') {
      Alert.alert('Age limit', res.message ?? 'You do not meet the age requirement for this circle.');
      return;
    }
    Alert.alert('Error', res.message ?? 'Could not accept request.');
  }

  async function handleDecline(item: InboxItem) {
    setBusy(item.id);
    await declineRequest(item.type, item.id);
    setBusy(null);
    onReload();
  }

  if (loading) {
    return (
      <View style={{ flex: 1 }}>
        {headerComponent}
        <View style={styles.center}>
          <ActivityIndicator size="large" color={color.signal} />
        </View>
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={{ flex: 1 }}>
        {headerComponent}
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>📬</Text>
          <Text style={styles.emptyTitle}>No pending requests</Text>
          <Text style={styles.emptyBody}>
            Friend requests, circle invites, and trip invites will appear here.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ paddingBottom: space.xxxl }}
      onScroll={navBarScrollHandler}
      scrollEventThrottle={16}
      ListHeaderComponent={headerComponent ? <>{headerComponent}</> : undefined}
      ListFooterComponent={<NavBarFiller />}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={onReload} tintColor={color.signal} />
      }
      renderItem={({ item }) => {
        const isBusy = busy === item.id;
        return (
          <View style={srStyles.card}>
            <View style={srStyles.headerRow}>
              <UserAvatarButton
                userId={item.actor?.id ?? ''}
                handle={item.actor?.handle}
                avatarUrl={item.actor?.avatarUrl}
                size={44}
                disabled={!item.actor?.id}
              />
              <View style={{ flex: 1 }}>
                <UserNameButton
                  userId={item.actor?.id ?? ''}
                  handle={item.actor?.handle}
                  displayName={item.actor?.name}
                  style={srStyles.name}
                  disabled={!item.actor?.id}
                />
                {secondaryIdentityText({ name: item.actor?.name, handle: item.actor?.handle }) ? (
                  <Text style={srStyles.handle}>{secondaryIdentityText({ name: item.actor?.name, handle: item.actor?.handle })}</Text>
                ) : null}
              </View>
              <View style={srStyles.typeChip}>
                <Text style={srStyles.typeChipText}>
                  {REQUEST_TYPE_LABEL[item.type] ?? item.type}
                </Text>
              </View>
            </View>
            {item.targetName ? (
              <Text style={srStyles.targetName}>{item.targetName}</Text>
            ) : null}
            <View style={srStyles.actions}>
              <Pressable
                style={[srStyles.btnAccept, isBusy && { opacity: 0.55 }]}
                onPress={() => handleAccept(item)}
                disabled={isBusy}
              >
                {isBusy
                  ? <ActivityIndicator size="small" color={color.onInk} style={{ marginRight: 4 }} />
                  : <UserCheck size={14} color={color.onInk} />
                }
                <Text style={srStyles.btnAcceptText}>Accept</Text>
              </Pressable>
              <Pressable
                style={[srStyles.btnDecline, isBusy && { opacity: 0.55 }]}
                onPress={() => handleDecline(item)}
                disabled={isBusy}
              >
                <UserMinus size={14} color={color.mute} />
                <Text style={srStyles.btnDeclineText}>Decline</Text>
              </Pressable>
            </View>
          </View>
        );
      }}
    />
  );
}

const srStyles = StyleSheet.create({
  card: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    gap: space.sm,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  name: { ...t.bodyStrong, color: color.ink, fontWeight: '700' } as any,
  handle: { ...t.small, color: color.mute, fontSize: 12, marginTop: 1 } as any,
  typeChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: '#E0EFEC',
  },
  typeChipText: { fontSize: 11, fontWeight: '600', color: color.deep },
  targetName: { ...t.small, color: color.mute, fontSize: 13 } as any,
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  btnAccept: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.ink,
  },
  btnAcceptText: { ...t.small, color: color.onInk, fontWeight: '700', fontSize: 13 } as any,
  btnDecline: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.haze,
  },
  btnDeclineText: { ...t.small, color: color.mute, fontWeight: '600', fontSize: 13 } as any,
});

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
  permActionsRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  permBtn: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: radius.pill, borderWidth: 1,
  },
  permBtnAccept: {
    backgroundColor: '#D97706', borderColor: '#D97706',
  },
  permBtnAcceptText: {
    ...t.stamp, color: '#fff', fontWeight: '700',
  },
  permBtnDecline: {
    backgroundColor: color.paper, borderColor: color.haze,
  },
  permBtnDeclineText: {
    ...t.stamp, color: color.mute, fontWeight: '700',
  },
  permDoneText: {
    ...t.stamp, color: color.success, fontWeight: '700',
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
