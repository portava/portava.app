import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, AppState } from 'react-native';
import { Tabs, router, usePathname, Link } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Activity, Compass, Map, User, Plus, Plane, Bell } from 'lucide-react-native';
import { color, space, type as t, shadow } from '../../src/theme/tokens';
import { useIsDesktop } from '../../src/hooks/useBreakpoint';
import { getRequestCount } from '../../src/services/requests';
import { isSupabaseConfigured } from '../../src/lib/supabase';

const NAV_ITEMS = [
  { href: '/(tabs)/', label: 'Pulse', icon: Activity, match: ['/(tabs)', '/(tabs)/'] },
  { href: '/(tabs)/discovery', label: 'Explore', icon: Compass, match: ['/(tabs)/discovery'] },
  { href: '/(tabs)/trips', label: 'Trips', icon: Map, match: ['/(tabs)/trips'] },
  { href: '/(tabs)/passport', label: 'Passport', icon: User, match: ['/(tabs)/passport'] },
] as const;

function DesktopSidebar({ requestCount }: { requestCount: number }) {
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
              {label === 'Passport' && requestCount > 0 && (
                <View style={styles.sidebarBadge}>
                  <Text style={styles.sidebarBadgeText}>{requestCount > 9 ? '9+' : String(requestCount)}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      <View style={{ flex: 1 }} />

      {/* Notifications link */}
      <Pressable style={styles.notifBtn} onPress={() => router.push('/notifications' as any)}>
        <Bell size={18} color={color.mute} />
        <Text style={styles.navLabel}>Notifications</Text>
        {requestCount > 0 && (
          <View style={styles.sidebarBadge}>
            <Text style={styles.sidebarBadgeText}>{requestCount > 9 ? '9+' : String(requestCount)}</Text>
          </View>
        )}
      </Pressable>

      {/* Compose button */}
      <Pressable style={styles.composeBtn} onPress={() => router.push('/create')}>
        <Plus size={18} color={color.onInk} />
        <Text style={styles.composeBtnText}>New Post</Text>
      </Pressable>
    </View>
  );
}

/** Center vermilion passport-stamp create button. */
function StampButton() {
  return (
    <Pressable
      onPress={() => router.push('/create')}
      style={styles.stampBtn}
      accessibilityRole="button"
      accessibilityLabel="Share a travel post"
    >
      <View style={styles.stampInner}>
        <Text style={styles.stampGlyph}>✛</Text>
        <Text style={styles.stampWord}>POST</Text>
      </View>
    </Pressable>
  );
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const isDesktop = useIsDesktop();
  const [requestCount, setRequestCount] = useState(0);

  const refreshCount = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    const res = await getRequestCount();
    if (res.ok && res.data) setRequestCount((res.data as { count: number }).count ?? 0);
  }, []);

  useEffect(() => {
    refreshCount();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshCount();
    });
    return () => sub.remove();
  }, [refreshCount]);

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
          tabBarIcon: ({ color: c }) => <Compass size={22} color={c} />,
        }}
      />
      <Tabs.Screen
        name="create-tab"
        options={{
          title: '',
          tabBarButton: () => (isDesktop ? <View style={{ width: 0 }} /> : <StampButton />),
        }}
        listeners={{ tabPress: (e) => { e.preventDefault(); router.push('/create'); } }}
      />
      <Tabs.Screen
        name="trips"
        options={{
          title: 'Trips',
          tabBarIcon: ({ color: c }) => <Map size={22} color={c} />,
        }}
      />
      <Tabs.Screen
        name="passport"
        options={{
          title: 'Passport',
          tabBarIcon: ({ color: c }) => (
            <View>
              <User size={22} color={c} />
              {requestCount > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>{requestCount > 9 ? '9+' : String(requestCount)}</Text>
                </View>
              )}
            </View>
          ),
        }}
      />
      <Tabs.Screen name="ai" options={{ href: null, title: 'AI' }} />
    </Tabs>
  );

  if (isDesktop) {
    return (
      <View style={styles.desktopShell}>
        <DesktopSidebar requestCount={requestCount} />
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
    backgroundColor: color.paperRaised,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    paddingTop: 6,
  },
  label: { ...t.stamp, fontFamily: 'Courier', marginTop: 2 },
  stampBtn: {
    top: -18,
    alignSelf: 'center',
    width: 62,
    height: 62,
    ...shadow.float,
  },
  stampInner: {
    flex: 1,
    borderRadius: 16,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-6deg' }],
    borderWidth: 2,
    borderColor: color.signalDim,
  },
  stampGlyph: { color: color.onInk, fontSize: 20, lineHeight: 22, fontWeight: '900' },
  stampWord: {
    color: color.onInk, fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 1,
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
