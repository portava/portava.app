import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Tabs, router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Activity, Compass, Map, User, Plus, Plane } from 'lucide-react-native';
import { NotificationBell } from '../../src/components/NotificationBell';
import { color, space, type as t, shadow } from '../../src/theme/tokens';
import { useIsDesktop } from '../../src/hooks/useBreakpoint';
import { useUnreadCounts, markHighlightsViewed } from '../../src/hooks/useMessaging';
import { useGeofenceMonitor } from '../../src/hooks/useGeofenceMonitor';
import { getIncomingMessageRequests } from '../../src/services/messaging';
import { getPendingTripInvites } from '../../src/services/trips';

const NAV_ITEMS = [
  { href: '/(tabs)/', label: 'Pulse', icon: Activity, match: ['/(tabs)', '/(tabs)/'] },
  { href: '/(tabs)/discovery', label: 'Explore', icon: Compass, match: ['/(tabs)/discovery'] },
  { href: '/(tabs)/trips', label: 'Trips', icon: Map, match: ['/(tabs)/trips'] },
  { href: '/(tabs)/passport', label: 'Passport', icon: User, match: ['/(tabs)/passport'] },
] as const;

function DesktopSidebar({ unreadNotifications, unreadMessages, pendingRequests }: { unreadNotifications: number; unreadMessages: number; pendingRequests: number }) {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.sidebar, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg }]}>
      {/* Brand */}
      <View style={styles.brand}>
        <View style={styles.brandIcon}><Plane size={18} color={color.onInk} /></View>
        <Text style={styles.brandName}>Travel Buddy</Text>
      </View>

      {/* Nav links */}
      <View style={styles.navLinks}>
        {NAV_ITEMS.map(({ href, label, icon: Icon, match }) => {
          const active = match.some((m) => pathname === m || pathname.startsWith(m + '/'));
          return (
            <Pressable
              key={href}
              style={[styles.navItem, active && styles.navItemActive]}
              onPress={() => router.push(href as any)}
            >
              <Icon size={20} color={active ? color.signal : color.mute} />
              <Text style={[styles.navLabel, active && styles.navLabelActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={{ flex: 1 }} />

      {/* Notifications — bell with popover preview */}
      <View style={styles.notifBtn}>
        <NotificationBell />
        <Text style={styles.navLabel}>Notifications</Text>
      </View>

      {/* Compose button */}
      <Pressable style={styles.composeBtn} onPress={() => router.push('/create')}>
        <Plus size={18} color={color.onInk} />
        <Text style={styles.composeBtnText}>New Post</Text>
      </Pressable>
    </View>
  );
}

/** Flat Post tab button — same size and alignment as all other nav items. */
function PostTabButton() {
  return (
    <Pressable
      onPress={() => router.push('/create')}
      style={({ pressed }) => [styles.postTabBtn, pressed && { opacity: 0.6 }]}
      accessibilityRole="button"
      accessibilityLabel="Create a post"
    >
      <Plus size={22} color={color.signal} />
      <Text style={[styles.label, styles.postTabLabel]}>Post</Text>
    </Pressable>
  );
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const isDesktop = useIsDesktop();
  const { messages: unreadMessages, notifications: unreadNotifications, newHighlights, refresh: refreshUnread } = useUnreadCounts();
  const [pendingRequests, setPendingRequests] = useState(0);
  const [pendingTripInvites, setPendingTripInvites] = useState(0);

  // Monitor geofence exits for pending_location_exit posts.
  // Lives here so it runs across all tabs, not just passport.
  useGeofenceMonitor();

  useEffect(() => {
    getIncomingMessageRequests().then((res) => {
      if (res.ok && res.data) setPendingRequests(res.data.requests.length);
    });
    const timer = setInterval(() => {
      getIncomingMessageRequests().then((res) => {
        if (res.ok && res.data) setPendingRequests(res.data.requests.length);
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    getPendingTripInvites().then((invites) => setPendingTripInvites(invites.length)).catch(() => {});
    const timer = setInterval(() => {
      getPendingTripInvites().then((invites) => setPendingTripInvites(invites.length)).catch(() => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const tabs = (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: !isDesktop,
        tabBarActiveTintColor: color.ink,
        tabBarInactiveTintColor: color.faint,
        tabBarStyle: isDesktop
          ? { display: 'none' }
          : [styles.bar, { height: 58 + insets.bottom, paddingBottom: insets.bottom }],
        tabBarLabelStyle: styles.label,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Pulse',
          tabBarIcon: ({ color: c }) => <Activity size={22} color={c} />,
        }}
      />
      <Tabs.Screen
        name="discovery"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color: c }) => (
            <View>
              <Compass size={22} color={c} />
              {newHighlights > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>
                    {newHighlights > 99 ? '99+' : String(newHighlights)}
                  </Text>
                </View>
              )}
            </View>
          ),
        }}
        listeners={{ focus: refreshUnread }}
      />
      <Tabs.Screen
        name="create-tab"
        options={{
          title: 'Post',
          tabBarButton: () => (isDesktop ? <View style={{ width: 0 }} /> : <PostTabButton />),
        }}
        listeners={{ tabPress: (e) => { e.preventDefault(); router.push('/create'); } }}
      />
      <Tabs.Screen
        name="trips"
        options={{
          title: 'Trips',
          tabBarIcon: ({ color: c }) => (
            <View>
              <Map size={22} color={c} />
              {pendingTripInvites > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>
                    {pendingTripInvites > 99 ? '99+' : String(pendingTripInvites)}
                  </Text>
                </View>
              )}
            </View>
          ),
        }}
        listeners={{ focus: () => { getPendingTripInvites().then((invites) => setPendingTripInvites(invites.length)).catch(() => {}); } }}
      />
      <Tabs.Screen
        name="messages"
        options={{ href: null, title: 'Telegraph' }}
      />
      <Tabs.Screen
        name="passport"
        options={{
          title: 'Passport',
          tabBarIcon: ({ color: c }) => (
            <View>
              <User size={22} color={c} />
              {unreadNotifications > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>
                    {unreadNotifications > 99 ? '99+' : String(unreadNotifications)}
                  </Text>
                </View>
              )}
            </View>
          ),
        }}
        listeners={{ focus: refreshUnread, tabPress: refreshUnread }}
      />
      <Tabs.Screen name="ai" options={{ href: null, title: 'AI' }} />
    </Tabs>
  );

  if (isDesktop) {
    return (
      <View style={styles.desktopShell}>
        <DesktopSidebar unreadNotifications={unreadNotifications} unreadMessages={unreadMessages} pendingRequests={pendingRequests} />
        <View style={styles.desktopContent}>{tabs}</View>
      </View>
    );
  }

  return tabs;
}

const SIDEBAR_WIDTH = 220;

const styles = StyleSheet.create({
  /* ── Desktop shell ── */
  desktopShell: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: color.paper,
  },
  desktopContent: {
    flex: 1,
    maxWidth: 720,
  },
  /* ── Sidebar ── */
  sidebar: {
    width: SIDEBAR_WIDTH,
    backgroundColor: color.paperRaised,
    borderRightWidth: 1,
    borderRightColor: color.haze,
    paddingHorizontal: space.lg,
    gap: space.xl,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  brandIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandName: {
    ...t.bodyStrong,
    color: color.ink,
    fontWeight: '800',
  },
  navLinks: {
    gap: space.xs,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: 10,
  },
  navItemActive: {
    backgroundColor: color.paper,
  },
  navLabel: {
    ...t.body,
    color: color.mute,
    fontWeight: '500',
    flex: 1,
  },
  navLabelActive: {
    color: color.ink,
    fontWeight: '700',
  },
  notifBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: 10,
  },
  sidebarBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  sidebarBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 12,
  },
  composeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.signal,
    borderRadius: 12,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    ...shadow.card,
  },
  composeBtnText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontWeight: '700',
  },
  /* ── Mobile tab bar ── */
  bar: {
    backgroundColor: 'rgba(255, 255, 255, 0.30)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.18)',
    paddingTop: 6,
  },
  label: { ...t.stamp, fontFamily: 'Courier', marginTop: 2 },
  postTabBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: 58,
    gap: 2,
  },
  postTabLabel: {
    color: color.signal,
  },
  /* ── Tab badge ── */
  tabBadge: {
    position: 'absolute',
    top: -4,
    right: -6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  tabBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    lineHeight: 11,
  },
});
