import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Tabs, router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Activity, Compass, Map, User, Plus, Plane } from 'lucide-react-native';
import { NotificationBell } from '../../src/components/NotificationBell';
import { color, space, type as t, shadow } from '../../src/theme/tokens';
import { useIsDesktop } from '../../src/hooks/useBreakpoint';
import { useUnreadCounts } from '../../src/hooks/useMessaging';
import { useGeofenceMonitor } from '../../src/hooks/useGeofenceMonitor';
import { getIncomingMessageRequests } from '../../src/services/messaging';
import { getPendingTripInvites } from '../../src/services/trips';
import { useSession } from '../../src/context/SessionContext';

const NAV_ITEMS = [
  { href: '/(tabs)/', label: 'Pulse', icon: Activity, match: ['/(tabs)', '/(tabs)/'] },
  { href: '/(tabs)/discovery', label: 'Explore', icon: Compass, match: ['/(tabs)/discovery'] },
  { href: '/(tabs)/trips', label: 'Trips', icon: Map, match: ['/(tabs)/trips'] },
  { href: '/(tabs)/passport', label: 'Passport', icon: User, match: ['/(tabs)/passport'] },
] as const;

/* ─── Desktop sidebar ──────────────────────────────────────────────────── */
function DesktopSidebar({
  unreadNotifications,
  unreadMessages,
  pendingRequests,
}: {
  unreadNotifications: number;
  unreadMessages: number;
  pendingRequests: number;
}) {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  return (
    <View style={[ds.sidebar, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg }]}>
      <View style={ds.brand}>
        <View style={ds.brandIcon}><Plane size={18} color={color.onInk} /></View>
        <Text style={ds.brandName}>Travel Buddy</Text>
      </View>

      <View style={ds.navLinks}>
        {NAV_ITEMS.map(({ href, label, icon: Icon, match }) => {
          const active = match.some((m) => pathname === m || pathname.startsWith(m + '/'));
          return (
            <Pressable
              key={href}
              style={[ds.navItem, active && ds.navItemActive]}
              onPress={() => router.push(href as any)}
            >
              <Icon size={20} color={active ? color.signal : color.mute} />
              <Text style={[ds.navLabel, active && ds.navLabelActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={{ flex: 1 }} />

      <View style={ds.notifBtn}>
        <NotificationBell />
        <Text style={ds.navLabel}>Notifications</Text>
      </View>

      <Pressable style={ds.composeBtn} onPress={() => router.push('/create')}>
        <Plus size={18} color={color.onInk} />
        <Text style={ds.composeBtnText}>New Post</Text>
      </Pressable>
    </View>
  );
}

/* ─── Floating tab bar ─────────────────────────────────────────────────── */

const FLOAT_PILL_H = 64;

interface FloatBarProps {
  newHighlights: number;
  pendingTripInvites: number;
  unreadNotifications: number;
}

function FloatingTabBar({ newHighlights, pendingTripInvites, unreadNotifications }: FloatBarProps) {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  const isActive = (match: readonly string[]) =>
    match.some((m) => pathname === m || pathname.startsWith(m + '/'));

  return (
    <View
      style={[fb.wrapper, { bottom: insets.bottom + 12 }]}
      pointerEvents="box-none"
    >
      <View style={fb.pill}>
        {/* Left items: Pulse, Explore */}
        {NAV_ITEMS.slice(0, 2).map(({ href, label, icon: Icon, match }) => {
          const active = isActive(match);
          const badge =
            label === 'Explore' ? newHighlights : 0;
          return (
            <Pressable
              key={href}
              style={fb.item}
              onPress={() => router.push(href as any)}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={label}
            >
              <View style={[fb.itemInner, active && fb.itemInnerActive]}>
                <View>
                  <Icon size={20} color={active ? color.ink : color.mute} />
                  {badge > 0 && (
                    <View style={fb.dot}>
                      <Text style={fb.dotText}>{badge > 9 ? '9+' : String(badge)}</Text>
                    </View>
                  )}
                </View>
                <Text style={[fb.label, active && fb.labelActive]}>{label}</Text>
              </View>
            </Pressable>
          );
        })}

        {/* Center: Create / + button */}
        <Pressable
          style={fb.plusWrap}
          onPress={() => router.push('/create')}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="Create a post"
        >
          <View style={fb.plusBtn}>
            <Plus size={22} color="#fff" strokeWidth={2.5} />
          </View>
        </Pressable>

        {/* Right items: Trips, Passport */}
        {NAV_ITEMS.slice(2).map(({ href, label, icon: Icon, match }) => {
          const active = isActive(match);
          const badge =
            label === 'Trips' ? pendingTripInvites
            : label === 'Passport' ? unreadNotifications
            : 0;
          return (
            <Pressable
              key={href}
              style={fb.item}
              onPress={() => router.push(href as any)}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={label}
            >
              <View style={[fb.itemInner, active && fb.itemInnerActive]}>
                <View>
                  <Icon size={20} color={active ? color.ink : color.mute} />
                  {badge > 0 && (
                    <View style={fb.dot}>
                      <Text style={fb.dotText}>{badge > 9 ? '9+' : String(badge)}</Text>
                    </View>
                  )}
                </View>
                <Text style={[fb.label, active && fb.labelActive]}>{label}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/* ─── Root layout ──────────────────────────────────────────────────────── */

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const isDesktop = useIsDesktop();
  const { messages: unreadMessages, notifications: unreadNotifications, newHighlights, refresh: refreshUnread } = useUnreadCounts();
  const [pendingRequests, setPendingRequests] = useState(0);
  const [pendingTripInvites, setPendingTripInvites] = useState(0);
  const { isAuthed, loading, configured } = useSession();

  useEffect(() => {
    if (configured && !loading && !isAuthed) {
      router.replace('/(auth)/sign-in' as any);
    }
  }, [configured, loading, isAuthed]);

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
        tabBarShowLabel: false,
        tabBarStyle: isDesktop
          ? { display: 'none' }
          : { display: 'none' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Pulse' }} />
      <Tabs.Screen
        name="discovery"
        options={{ title: 'Explore' }}
        listeners={{ focus: refreshUnread }}
      />
      <Tabs.Screen name="events" options={{ title: 'Events', href: null }} />
      <Tabs.Screen
        name="create-tab"
        options={{ title: 'Post', href: null }}
        listeners={{ tabPress: (e) => { e.preventDefault(); router.push('/create'); } }}
      />
      <Tabs.Screen
        name="trips"
        options={{ title: 'Trips' }}
        listeners={{
          focus: () => {
            getPendingTripInvites().then((invites) => setPendingTripInvites(invites.length)).catch(() => {});
          },
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{ href: null, title: 'Telegraph' }}
      />
      <Tabs.Screen
        name="passport"
        options={{ title: 'Passport' }}
        listeners={{ focus: refreshUnread, tabPress: refreshUnread }}
      />
      <Tabs.Screen name="ai" options={{ href: null, title: 'AI' }} />
    </Tabs>
  );

  if (isDesktop) {
    return (
      <View style={ds.desktopShell}>
        <DesktopSidebar
          unreadNotifications={unreadNotifications}
          unreadMessages={unreadMessages}
          pendingRequests={pendingRequests}
        />
        <View style={ds.desktopContent}>{tabs}</View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {tabs}
      <FloatingTabBar
        newHighlights={newHighlights}
        pendingTripInvites={pendingTripInvites}
        unreadNotifications={unreadNotifications}
      />
    </View>
  );
}

/* ─── Floating bar styles ──────────────────────────────────────────────── */

const fb = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 100,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 36,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.07)',
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  item: {
    flex: 1,
    alignItems: 'center',
  },
  itemInner: {
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 24,
    minWidth: 52,
  },
  itemInnerActive: {
    backgroundColor: 'rgba(0,0,0,0.07)',
  },
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: color.mute,
    letterSpacing: 0.1,
  },
  labelActive: {
    color: color.ink,
    fontWeight: '700',
  },
  dot: {
    position: 'absolute',
    top: -3,
    right: -5,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  dotText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '700',
    lineHeight: 10,
  },
  plusWrap: {
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  plusBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: color.signal,
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});

/* ─── Desktop styles ───────────────────────────────────────────────────── */

const SIDEBAR_WIDTH = 220;

const ds = StyleSheet.create({
  desktopShell: { flex: 1, flexDirection: 'row', backgroundColor: color.paper },
  desktopContent: { flex: 1, maxWidth: 720 },
  sidebar: {
    width: SIDEBAR_WIDTH,
    backgroundColor: color.paperRaised,
    borderRightWidth: 1,
    borderRightColor: color.haze,
    paddingHorizontal: space.lg,
    gap: space.xl,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  brandIcon: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: color.signal,
    alignItems: 'center', justifyContent: 'center',
  },
  brandName: { ...t.bodyStrong, color: color.ink, fontWeight: '800' },
  navLinks: { gap: space.xs },
  navItem: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.md, paddingHorizontal: space.md, borderRadius: 10,
  },
  navItemActive: { backgroundColor: color.paper },
  navLabel: { ...t.body, color: color.mute, fontWeight: '500', flex: 1 },
  navLabelActive: { color: color.ink, fontWeight: '700' },
  notifBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.md, paddingHorizontal: space.md, borderRadius: 10,
  },
  composeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, backgroundColor: color.signal,
    borderRadius: 12, paddingVertical: space.md, paddingHorizontal: space.lg,
    ...shadow.card,
  },
  composeBtnText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
});
