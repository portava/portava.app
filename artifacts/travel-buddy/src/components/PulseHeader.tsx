import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, interpolate } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Activity, SlidersHorizontal, MapPin, Pencil, MessageCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';
import { useUnreadCounts } from '../hooks/useMessaging';
import { NotificationBell } from './NotificationBell';
import { navBarProgress } from '../hooks/useNavBarCollapse';

/**
 * Pulse Wall header — compact city title, status chips, and action icons.
 *
 * The status-chip row (city + availability) collapses in sync with the
 * floating nav bar (navBarProgress 0 → 1) on scroll-down and restores on
 * scroll-up, so the fixed header area shrinks to just the title row while
 * the user is reading the feed.
 */
export function PulseHeader({
  city = 'Cebu',
  cityFull = 'Cebu City',
  availabilityText = 'Open tonight',
  filterCount = 0,
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

  // Chip row natural height 30 px: lineHeight 18 (t.small — fontSize override
  // does not shrink it) + chip paddingVertical 5×2 + border 1×2. Plus 6 px
  // marginTop. Collapses to 0; opacity leads so text never squishes.
  const animatedChipRow = useAnimatedStyle(() => {
    const p = navBarProgress.value;
    return {
      height: interpolate(p, [0, 1], [30, 0]),
      marginTop: interpolate(p, [0, 1], [6, 0]),
      opacity: interpolate(p, [0, 0.6], [1, 0], 'clamp'),
    };
  });

  // Header bottom padding tightens as the chips collapse.
  const animatedWrap = useAnimatedStyle(() => ({
    paddingBottom: interpolate(navBarProgress.value, [0, 1], [8, 3]),
  }));

  return (
    <Animated.View style={[styles.wrap, { paddingTop: insets.top + 4 }, animatedWrap]}>
      {/* title row */}
      <View style={styles.titleRow}>
        <Activity size={16} color={color.signal} />
        <Text style={styles.title}>{city} Pulse</Text>
        <View style={{ flex: 1 }} />

        {/* Notification bell */}
        <NotificationBell />

        {/* Telegraph / Messages icon */}
        <Pressable style={styles.iconBtn} onPress={() => router.push('/(tabs)/messages')} hitSlop={8}>
          <MessageCircle size={17} color={color.ink} />
          {unreadMessages > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unreadMessages > 9 ? '9+' : String(unreadMessages)}</Text>
            </View>
          )}
        </Pressable>

        {/* Filter icon */}
        <Pressable style={styles.iconBtn} onPress={onFilter} hitSlop={8}>
          <SlidersHorizontal size={17} color={color.ink} />
          {filterCount > 0 && (
            <View style={styles.badge}><Text style={styles.badgeText}>{filterCount}</Text></View>
          )}
        </Pressable>
      </View>

      {/* compact status chips — collapse on scroll-down */}
      <Animated.View style={[styles.statusRow, animatedChipRow]}>
        <Pressable style={styles.chip} onPress={onCityPress ?? (() => router.push('/(tabs)/discovery'))}>
          <MapPin size={11} color={color.deep} />
          <Text style={styles.chipText} numberOfLines={1}>{cityFull || city}</Text>
        </Pressable>

        <Pressable style={styles.chip} onPress={() => router.push('/availability')}>
          <View style={styles.liveDot} />
          <Text style={styles.chipText} numberOfLines={1}>{availabilityText}</Text>
          <Pencil size={10} color={color.faint} />
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: color.paper,
    paddingHorizontal: space.lg,
    // paddingBottom is animated (8 → 3) via animatedWrap
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    ...t.bodyStrong,
    fontSize: 17,
    color: color.ink,
    fontWeight: '800',
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paperRaised,
  },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 15,
    height: 15,
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
  statusRow: {
    flexDirection: 'row',
    gap: 6,
    // marginTop is animated (6 → 0) via animatedChipRow
    overflow: 'hidden',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipText: {
    ...t.small,
    fontSize: 11,
    color: color.ink,
    fontWeight: '600',
    maxWidth: 120,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: color.success,
  },
});
