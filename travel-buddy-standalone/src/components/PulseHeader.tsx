import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Image, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, interpolate } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search, SlidersHorizontal, MapPin, Pencil, MessageCircle, CircleUserRound } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { pv } from '../theme/pulseTheme.ts';
import { useUnreadCounts } from '../hooks/useMessaging.ts';
import { NotificationBell } from './NotificationBell.tsx';
import { navBarProgress } from '../hooks/useNavBarCollapse.ts';
import { getMyProfile } from '../services/profile.ts';

/**
 * Portava Pulse top bar — approved dark-navy concept.
 *
 * Row 1 (always visible): user avatar → Passport, centered PORTAVA wordmark,
 * and right-side actions: search, Telegraph, notifications, filters.
 * Row 2+3 (collapse on scroll-down, in sync with the floating nav bar):
 * large "Pulse" title + subtitle, then the My City pill and availability pill.
 *
 * All previous actions stay wired: search → onSearch, city pill → onCityPress,
 * availability pill → /availability, messages → Telegraph, filter → onFilter.
 */

// Hero block natural height, derived from line boxes (fontSize overrides do
// not shrink lineHeight — collapse must use these exact numbers):
//   title 34 + subtitle (18 + 2 marginTop) + pill row (30 + 10 marginTop) = 94
const HERO_H = 94;

export function PulseHeader({
  city = 'Cebu',
  cityFull = 'Cebu City',
  availabilityText = 'Open tonight',
  filterCount = 0,
  onSearch,
  onFilter,
  onCityPress,
}: {
  city?: string;
  area?: string;
  cityFull?: string;
  availabilityText?: string;
  availabilityTime?: string;
  travelerType?: string;
  openToMeet?: boolean;
  filterCount?: number;
  onSearch?: () => void;
  onFilter?: () => void;
  onCityPress?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { messages: unreadMessages } = useUnreadCounts();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // Best-effort avatar load — the fallback glyph renders until it arrives.
  useEffect(() => {
    let alive = true;
    getMyProfile().then((res) => {
      if (alive && res.ok && res.data?.avatarUrl) setAvatarUrl(res.data.avatarUrl);
    }).catch(() => { /* keep fallback */ });
    return () => { alive = false; };
  }, []);

  const animatedHero = useAnimatedStyle(() => {
    const p = navBarProgress.value;
    return {
      height: interpolate(p, [0, 1], [HERO_H, 0]),
      marginTop: interpolate(p, [0, 1], [8, 0]),
      opacity: interpolate(p, [0, 0.6], [1, 0], 'clamp'),
    };
  });

  const animatedWrap = useAnimatedStyle(() => ({
    paddingBottom: interpolate(navBarProgress.value, [0, 1], [10, 4]),
  }));

  return (
    <Animated.View style={[styles.wrap, { paddingTop: insets.top + 6 }, animatedWrap]}>
      {/* Top bar: avatar · wordmark · actions */}
      <View style={styles.topRow}>
        <Pressable
          onPress={() => router.push('/(tabs)/passport')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Your profile"
        >
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <CircleUserRound size={20} color={pv.textMute} />
            </View>
          )}
        </Pressable>

        <View pointerEvents="none" style={styles.wordmarkWrap}>
          <Text style={styles.wordmark}>PORTAVA</Text>
        </View>

        <View style={{ flex: 1 }} />

        <Pressable
          style={styles.iconBtn}
          onPress={onSearch ?? (() => router.push('/(tabs)/discovery'))}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Search"
        >
          <Search size={17} color={color.ink} />
        </Pressable>

        <Pressable
          style={styles.iconBtn}
          onPress={() => router.push('/(tabs)/messages')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Telegraph messages"
        >
          <MessageCircle size={17} color={color.ink} />
          {unreadMessages > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unreadMessages > 9 ? '9+' : String(unreadMessages)}</Text>
            </View>
          )}
        </Pressable>

        <View style={styles.bellWrap}>
          <NotificationBell />
        </View>

        <Pressable
          style={styles.iconBtn}
          onPress={onFilter}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Feed filters"
        >
          <SlidersHorizontal size={17} color={color.ink} />
          {filterCount > 0 && (
            <View style={styles.badge}><Text style={styles.badgeText}>{filterCount}</Text></View>
          )}
        </Pressable>
      </View>

      {/* Hero: Pulse title + subtitle + city/availability pills — collapses */}
      <Animated.View style={[styles.heroClip, animatedHero]}>
        <Text style={styles.heroTitle}>Pulse</Text>
        <Text style={styles.heroSub} numberOfLines={1}>What's alive in {cityFull || city} right now</Text>

        <View style={styles.pillRow}>
          <Pressable
            style={styles.pill}
            onPress={onCityPress ?? (() => router.push('/(tabs)/discovery'))}
            accessibilityRole="button"
            accessibilityLabel={`Change city, currently ${cityFull || city}`}
          >
            <MapPin size={12} color={pv.teal} />
            <Text style={styles.pillText} numberOfLines={1}>My City: {city}</Text>
          </Pressable>

          <Pressable
            style={styles.pill}
            onPress={() => router.push('/availability')}
            accessibilityRole="button"
            accessibilityLabel="Edit availability"
          >
            <View style={styles.liveDot} />
            <Text style={styles.pillText} numberOfLines={1}>{availabilityText}</Text>
            <Pencil size={10} color={pv.textFaint} />
          </Pressable>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: pv.navy,
    paddingHorizontal: space.lg,
    // paddingBottom is animated (10 → 4) via animatedWrap
    borderBottomWidth: 1,
    borderBottomColor: pv.navyEdge,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: pv.navyEdge,
  },
  avatarFallback: {
    backgroundColor: pv.navySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordmarkWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  wordmark: {
    fontFamily: 'Courier',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 3.5,
    color: pv.textMute,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F4F7FB',
  },
  bellWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F4F7FB',
  },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    backgroundColor: pv.coral,
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
  heroClip: {
    overflow: 'hidden',
    // height + marginTop animated via animatedHero
  },
  heroTitle: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.6,
    color: pv.text,
  },
  heroSub: {
    ...t.small,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
    color: pv.textMute,
  },
  pillRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 10,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: pv.navySoft,
    borderWidth: 1,
    borderColor: pv.navyEdge,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  pillText: {
    ...t.small,
    fontSize: 11,
    lineHeight: 18,
    color: pv.text,
    fontWeight: '600',
    maxWidth: 150,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: pv.teal,
  },
});
