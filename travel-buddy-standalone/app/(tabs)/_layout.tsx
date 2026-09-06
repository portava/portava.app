import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, useColorScheme } from 'react-native';
import Animated, { useAnimatedStyle, interpolate, useSharedValue, withTiming } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { BlurView } from 'expo-blur';
import { Tabs, router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Activity, Compass, Plus, Plane, Film, LayoutGrid } from 'lucide-react-native';
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
import { useFeatureFlags } from '../../src/context/FeatureFlagsContext';
import { navBarProgress } from '../../src/hooks/useNavBarCollapse';
import { CreateHubSheet } from '../../src/components/create/CreateHubSheet';
import { useLocationContext } from '../../src/context/LocationContext';
import { getDiscoveryCategoryCountsBatch, getDiscoveryPlaces } from '../../src/services/discovery';
import { LocationPermissionPrompt } from '../../src/components/LocationPermissionPrompt';

const NAV_ITEMS = [
  { href: '/(tabs)/', label: 'Pulse', icon: Activity, match: ['/(tabs)', '/(tabs)/'] },
  { href: '/(tabs)/discovery', label: 'Discovery', icon: Compass, match: ['/(tabs)/discovery'] },
  { href: '/(tabs)/media', label: 'Roam', icon: Film, match: ['/(tabs)/media'] },
  { href: '/(tabs)/trips', label: 'Trips', icon: Plane, match: ['/(tabs)/trips'] },
  { href: '/(tabs)/passport', label: 'Passport', icon: PassportIcon, match: ['/(tabs)/passport'] },
] as const;

/**
 * The Wall's nav entry, kept OUT of NAV_ITEMS because NAV_ITEMS is the
 * always-on set and this one is conditional on the server flag `wall_enabled`
 * — the same flag that gates every route in routes/wall.ts.
 *
 * Why this exists at all: setting `href` on <Tabs.Screen name="wall"> is NOT
 * enough. That controls expo-router's DEFAULT tab bar, and this app does not
 * render it — FloatingTabBar and DesktopSidebar draw the visible navigation
 * from NAV_ITEMS instead. A Wall that is mounted, flag-enabled and absent from
 * NAV_ITEMS is reachable only by deep link, which to a user is
 * indistinguishable from not existing.
 */
const WALL_NAV_ITEM = {
  href: '/(tabs)/wall',
  label: 'Wall',
  icon: LayoutGrid,
  match: ['/(tabs)/wall'],
} as const;

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
  const [hubVisible, setHubVisible] = useState(false);

  // isEnabled() is false for an unknown key and while the first fetch is in
  // flight, so the Wall entry fails closed: no link until the server says yes.
  const { isEnabled } = useFeatureFlags();
  const sidebarItems = isEnabled('wall_enabled')
    ? [...NAV_ITEMS, WALL_NAV_ITEM]
    : [...NAV_ITEMS];

  return (
    <View style={[ds.sidebar, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg }]}>
      <View style={ds.brand}>
        <View style={ds.brandIcon}><Plane size={18} color={color.onInk} /></View>
        <Text style={ds.brandName}>Portava</Text>
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

      <Pressable style={ds.composeBtn} onPress={() => setHubVisible(true)}>
        <Plus size={18} color={color.onInk} />
        <Text style={ds.composeBtnText}>Create</Text>
      </Pressable>

      <CreateHubSheet visible={hubVisible} onClose={() => setHubVisible(false)} />
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
  const { isEnabled } = useFeatureFlags();
  const wallEnabled = isEnabled('wall_enabled');
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const pillBg      = isDark ? '#1a1a1a' : '#ffffff';
  const pillBorder  = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const blurTint    = (isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterial') as
    'systemChromeMaterialDark' | 'systemChromeMaterial';
  const iconActive  = isDark ? color.onInk               : color.ink;
  const iconMuted   = isDark ? color.onInkMute            : color.mute;
  const activeHighlight = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)';

  // Shared values for pill background/border so Reanimated always applies them
  // through its own style pipeline.  Passing colors in a plain inline-style
  // array alongside an Animated.View can be silently ignored on Android/web
  // (Reanimated processes its own style last and doesn't merge non-animated
  // array entries reliably), leaving the static 30%-opacity fallback visible.
  const pillBgSV     = useSharedValue(pillBg);
  const pillBorderSV = useSharedValue(pillBorder);
  useEffect(() => {
    pillBgSV.value     = pillBg;
    pillBorderSV.value = pillBorder;
  }, [pillBg, pillBorder]);

  const isActive = (match: readonly string[]) =>
    match.some((m) => pathname === m || pathname.startsWith(m + '/'));

  // Animated styles driven by the module-level navBarProgress shared value.
  // Collapse is primarily VERTICAL: 64 → 40 px. Anything below ~40 px clips
  // the icons (their layout box stays 20 px + label height even at opacity 0).
  const animatedPillStyle = useAnimatedStyle(() => {
    const progress = navBarProgress.value;
    return {
      height:          interpolate(progress, [0, 1], [64, 40]),
      borderRadius:    interpolate(progress, [0, 1], [36, 22]),
      paddingVertical: interpolate(progress, [0, 1], [6, 2]),
      backgroundColor: pillBgSV.value,
      borderColor:     pillBorderSV.value,
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
      <Animated.View style={[fb.pill, animatedPillStyle]}>
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

        {/* Wall — only once the server flag that gates its routes is on. */}
        {wallEnabled && (
          <TabItem
            href={WALL_NAV_ITEM.href}
            label={WALL_NAV_ITEM.label}
            icon={WALL_NAV_ITEM.icon}
            match={WALL_NAV_ITEM.match}
          />
        )}
      </Animated.View>
    </View>
  );
}

/* ─── Root layout ──────────────────────────────────────────────────────── */

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  // The Wall's tab-bar entry is driven by the same server flag that gates its
  // routes, so the tab cannot appear while /wall would refuse to serve it.
  // isEnabled() returns false for an unknown key and while the initial fetch is
  // in flight, so this fails closed: no tab until the server says yes.
  const { isEnabled } = useFeatureFlags();
  const wallEnabled = isEnabled('wall_enabled');
  const isDesktop = useIsDesktop();
  const { messages: unreadMessages, notifications: unreadNotifications, newHighlights, refresh: refreshUnread } = useUnreadCounts();
  const [pendingRequests, setPendingRequests] = useState(0);
  const [pendingTripInvites, setPendingTripInvites] = useState(0);
  const { isAuthed, loading, configured } = useSession();
  const { resolvedLocation } = useLocationContext();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  useEffect(() => { pathnameRef.current = pathname; }, [pathname]);

  // ── Slide-in animation shared values ──────────────────────────────────
  const slideX = useSharedValue(0);
  const slideOpacity = useSharedValue(1);

  const animatedSlideStyle = useAnimatedStyle(() => ({
    flex: 1,
    transform: [{ translateX: slideX.value }],
    opacity: slideOpacity.value,
  }));

  // ── Inter-tab swipe gesture ────────────────────────────────────────────
  const swipePan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(30)
        .runOnJS(true)
        .onEnd((e) => {
          // Only act on strongly horizontal swipes
          if (Math.abs(e.translationX) <= Math.abs(e.translationY) * 1.5) return;
          const distOk = Math.abs(e.translationX) > 80;
          const velOk  = Math.abs(e.velocityX) > 300;
          if (!distOk && !velOk) return;

          // Find active tab index
          const p = pathnameRef.current;
          let currentIdx = 0;
          for (let i = 0; i < NAV_ITEMS.length; i++) {
            if (NAV_ITEMS[i].match.some((m) => p === m || p.startsWith(m + '/'))) {
              currentIdx = i;
              break;
            }
          }

          // Skip when on Roam — Watch feed owns its own horizontal gestures
          if (NAV_ITEMS[currentIdx].label === 'Roam') return;

          // swipe left (translationX < 0) → advance; swipe right → go back
          const delta    = e.translationX < 0 ? 1 : -1;
          const nextIdx  = currentIdx + delta;
          if (nextIdx < 0 || nextIdx >= NAV_ITEMS.length) return;

          const nextHref = NAV_ITEMS[nextIdx].href;

          // Brief slide-in: incoming content enters from ±20 px, fades in
          slideX.value      = -delta * 20;
          slideOpacity.value = 0;
          router.replace(nextHref as any);
          slideX.value       = withTiming(0, { duration: 200 });
          slideOpacity.value = withTiming(1, { duration: 200 });
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Prefetch Discovery data when the user is on an adjacent tab (Pulse or Trips).
  // Warms the client-side in-memory cache so the Discovery tab paints instantly
  // from cache when the user navigates there. Fires once per city change, after a
  // 300 ms delay so it doesn't compete with the active tab's own data fetches.
  const prefetchCity = resolvedLocation.place.city ?? null;
  useEffect(() => {
    if (!prefetchCity) return;
    const onAdjacentTab =
      pathname === '/(tabs)' || pathname === '/(tabs)/' ||
      pathname.startsWith('/(tabs)/trips');
    if (!onAdjacentTab) return;
    const timer = setTimeout(() => {
      // Warm the batch counts endpoint (1 request covers all 7 category tabs)
      getDiscoveryCategoryCountsBatch(prefetchCity, 10).catch(() => {});
      // Warm the For You OSM baseline (populates the client result cache)
      getDiscoveryPlaces(
        prefetchCity, 'for_you',
        { radiusKm: 25, openNow: false, minRating: null },
      ).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [pathname, prefetchCity]);

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
        options={{ title: 'Roam' }}
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
      {/* Wall — the tab-bar entry follows `wall_enabled`, the same flag that gates
          routes/wall.ts. While it is OFF this is href: null exactly as before, so
          the Pulse landing tab and every existing tab are unchanged; the route
          stays reachable as a secondary surface (deep-link / push) either way.
          Hardcoding href: null meant the flag could be turned on server-side and
          the surface would still have no entry point — the Wall would be live and
          invisible, which reads as "the feature does not work". */}
      <Tabs.Screen
        name="wall"
        options={{ href: wallEnabled ? '/wall' : null, title: 'Wall' }}
      />
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
    <GestureDetector gesture={swipePan}>
      <View style={{ flex: 1 }}>
        <Animated.View style={animatedSlideStyle}>
          {tabs}
        </Animated.View>
        <FloatingTabBar
          newHighlights={newHighlights}
          pendingTripInvites={pendingTripInvites}
          unreadNotifications={unreadNotifications}
        />
        <LocationPermissionPrompt />
      </View>
    </GestureDetector>
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
    backgroundColor: '#ffffff', // solid fallback; overridden by animatedPillStyle
    borderRadius: 36,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)', // solid fallback; overridden by animatedPillStyle
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
