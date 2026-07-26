import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, useColorScheme } from 'react-native';
import Animated, { useAnimatedStyle, interpolate } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { Tabs, router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Activity, Compass, Plus, Plane, Film } from 'lucide-react-native';
import { PassportIcon } from '../../src/components/icons/PassportIcon';
import { NotificationBell } from '../../src/components/NotificationBell';
import { color, space, type as t, shadow } from '../../src/theme/tokens';
import { useIsDesktop } from '../../src/hooks/useBreakpoint';
import { useUnreadCounts } from '../../src/hooks/useMessaging';
import { useGeofenceMonitor } from '../../src/hooks/useGeofenceMonitor';
import { getIncomingMessageRequests } from '../../src/services/messaging';
import { getPendingTripInvites } from '../../src/services/trips';
import { getMyProfile } from '../../src/services/profile';
import { useSession } from '../../src/context/SessionContext';
import { navBarProgress } from '../../src/hooks/useNavBarCollapse';

const NAV_ITEMS = [
  { href: '/(tabs)/', label: 'Pulse', icon: Activity, match: ['/(tabs)', '/(tabs)/'] },
  { href: '/(tabs)/discovery', label: 'Discovery', icon: Compass, match: ['/(tabs)/discovery'] },
  { href: '/(tabs)/media', label: 'Media', icon: Film, match: ['/(tabs)/media'] },
  { href: '/(tabs)/trips', label: 'Trips', icon: Plane, match: ['/(tabs)/trips'] },
  { href: '/(tabs)/passport', label: 'Passport', icon: PassportIcon, match: ['/(tabs)/passport'] },
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

  const sidebarItems = [...NAV_ITEMS];

  return (
    <View style={[ds.sidebar, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg }]}>
      <View style={ds.brand}>
        <View style={ds.brandIcon}><Plane size={18} color={color.onInk} /></View>
        <Text style={ds.brandName}>Travel Buddy</Text>
      </View>

      <View style={ds.navLinks}>
        {sidebarItems.map(({ href, label, icon: Icon, match }) => {
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
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const pillBg      = isDark ? 'rgba(20,20,20,0.30)'     : 'rgba(255,255,255,0.30)';
  const pillBorder  = isDark ? 'rgba(255,255,255,0.12)'  : 'rgba(255,255,255,0.45)';
  const blurTint    = (isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterial') as
    'systemChromeMaterialDark' | 'systemChromeMaterial';
  const iconActive  = isDark ? color.onInk               : color.ink;
  const iconMuted   = isDark ? color.onInkMute            : color.mute;
  const activeHighlight = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)';

  const isActive = (match: readonly string[]) =>
    match.some((m) => pathname === m || pathname.startsWith(m + '/'));

  // Animated styles driven by the module-level navBarProgress shared value.
  // Collapse is primarily VERTICAL: 64 → 40 px. Anything below ~40 px clips
  // the icons (their layout box stays 20 px + label height even at opacity 0).
  const animatedPillStyle = useAnimatedStyle(() => {
    const progress = navBarProgress.value;
    return {
      height:         interpolate(progress, [0, 1], [64, 40]),
      borderRadius:   interpolate(progress, [0, 1], [36, 22]),
      paddingVertical: interpolate(progress, [0, 1], [6, 2]),
    };
  });

  const animatedLabelStyle = useAnimatedStyle(() => {
    // Labels fade out fast, then their LAYOUT height collapses to 0 so the
    // icon re-centres inside the shorter pill. Without the height collapse the
    // invisible label keeps 13 px of layout and pushes the icon off-centre —
    // that's what caused the clipped/cut-off look at the old 20 px height.
    // Applied to a clip WRAPPER (not the Text itself) — animating height
    // directly on text is unreliable on RN web.
    const progress = navBarProgress.value;
    return {
      opacity: interpolate(progress, [0, 0.4], [1, 0], 'clamp'),
      height:  interpolate(progress, [0, 1], [13, 0]),
    };
  });

  // Nav icons shrink uniformly (scale, not scaleY) so they look like miniature
  // icons rather than vertically-squished glyphs. 0.80 keeps them clearly
  // recognisable — 20 px × 0.80 = 16 px rendered.
  const animatedIconStyle = useAnimatedStyle(() => {
    const scale = interpolate(navBarProgress.value, [0, 1], [1, 0.80]);
    return { transform: [{ scale }] };
  });

  // Item inner padding compresses vertically so icon + (collapsed) label fit
  // the 40 px pill: 3 + 20 + 3 + 0 + 3 = 29 px < 36 px inner space.
  const animatedItemInnerStyle = useAnimatedStyle(() => {
    const paddingVertical = interpolate(navBarProgress.value, [0, 1], [7, 3]);
    return { paddingVertical };
  });

  const TAB_HITSLOP = { top: 10, bottom: 10, left: 6, right: 6 };

  // Renders a standard tab item (icon + animated label).
  function TabItem({
    href,
    label,
    icon: Icon,
    match,
    badge,
  }: {
    href: string;
    label: string;
    icon: React.ComponentType<{ size: number; color: string }>;
    match: readonly string[];
    badge?: number;
  }) {
    const active = isActive(match);
    return (
      <Pressable
        style={fb.item}
        onPress={() => router.push(href as any)}
        hitSlop={TAB_HITSLOP}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <Animated.View style={[fb.itemInner, active && { backgroundColor: activeHighlight }, animatedItemInnerStyle]}>
          <Animated.View style={animatedIconStyle}>
            <View>
              <Icon size={20} color={active ? iconActive : iconMuted} />
              {(badge ?? 0) > 0 && (
                <View style={fb.dot}>
                  <Text style={fb.dotText}>{(badge ?? 0) > 9 ? '9+' : String(badge)}</Text>
                </View>
              )}
            </View>
          </Animated.View>
          <Animated.View style={[fb.labelClip, animatedLabelStyle]}>
            <Text style={[fb.label, active && fb.labelActive, { color: active ? iconActive : iconMuted }]}>{label}</Text>
          </Animated.View>
        </Animated.View>
      </Pressable>
    );
  }

  return (
    <View
      style={[fb.wrapper, { bottom: insets.bottom + 12 }]}
      pointerEvents="box-none"
    >
      <Animated.View style={[fb.pill, { backgroundColor: pillBg, borderColor: pillBorder }, animatedPillStyle]}>
        {/* Glass blur layer — iOS: real blur; Android: rgba only */}
        {Platform.OS === 'ios' && (
          <BlurView
            tint={blurTint}
            intensity={70}
            style={StyleSheet.absoluteFillObject}
          />
        )}

        {/* Pulse, Discovery */}
        <TabItem href={NAV_ITEMS[0].href} label={NAV_ITEMS[0].label} icon={NAV_ITEMS[0].icon} match={NAV_ITEMS[0].match} badge={0} />
        <TabItem href={NAV_ITEMS[1].href} label={NAV_ITEMS[1].label} icon={NAV_ITEMS[1].icon} match={NAV_ITEMS[1].match} badge={newHighlights} />

        {/* Center: Media */}
        <TabItem href={NAV_ITEMS[2].href} label={NAV_ITEMS[2].label} icon={NAV_ITEMS[2].icon} match={NAV_ITEMS[2].match} />

        {/* Trips, Passport */}
        <TabItem href={NAV_ITEMS[3].href} label={NAV_ITEMS[3].label} icon={NAV_ITEMS[3].icon} match={NAV_ITEMS[3].match} badge={pendingTripInvites} />
        <TabItem href={NAV_ITEMS[4].href} label={NAV_ITEMS[4].label} icon={NAV_ITEMS[4].icon} match={NAV_ITEMS[4].match} badge={unreadNotifications} />
      </Animated.View>
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

  // Profile-completeness gate for cold-start / session-restore paths.
  // Fires once per authenticated session. When the profile lacks displayName
  // or username (user abandoned onboarding mid-flow), redirect back to finish.
  const profileGateChecked = useRef(false);
  useEffect(() => {
    if (!isAuthed || loading) return;
    if (profileGateChecked.current) return;
    profileGateChecked.current = true;
    getMyProfile().then((res) => {
      if (res.ok && res.data && (!res.data.displayName || !res.data.username)) {
        router.replace('/(auth)/onboarding' as any);
      }
    }).catch(() => {
      // Non-fatal — leave user on tabs if profile check fails.
    });
  }, [isAuthed, loading]);

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
        options={{ title: 'Discovery' }}
        listeners={{ focus: refreshUnread }}
      />
      <Tabs.Screen
        name="media"
        options={{ title: 'Media' }}
      />
      <Tabs.Screen name="events" options={{ title: 'Events', href: null }} />
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
    borderRadius: 36,
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.30)',
    borderRadius: 36,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.45)',
    overflow: 'hidden',
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
  labelClip: {
    // Carries the animated height (13 → 0) + opacity; clips the static Text
    // inside. Web-safe: RN web handles height animation on Views reliably.
    overflow: 'hidden',
    alignItems: 'center',
  },
  label: {
    fontSize: 10,
    lineHeight: 13, // matches labelClip's full animated height
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
    paddingVertical: space.md,
  },
  composeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.signal, borderRadius: 10,
    paddingVertical: space.md, paddingHorizontal: space.lg,
    justifyContent: 'center',
  },
  composeBtnText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
});
