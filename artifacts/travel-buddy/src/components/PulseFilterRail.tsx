/**
 * PulseFilterRail — compact underline-tab row for feed/content category filters.
 *
 * Tab anatomy (icon mode):
 *   • Per-category icon on top, label underneath
 *   • Active tab: heavy-weight ink text + 2.5 px signal-red pill underline
 *   • Inactive tab: muted text/icon, zero chrome
 *   • Row is CENTERED across the rail width (scrolls only on overflow)
 *
 * Scroll collapse:
 *   Labels collapse (height + opacity → 0) in sync with the floating nav bar
 *   (navBarProgress 0 → 1), leaving a compact icon-only strip while the user
 *   scrolls down the feed. Restores on scroll-up. Only applies when `icons`
 *   are provided — text-only rails keep their labels visible.
 *
 * Usage:
 *   <PulseFilterRail
 *     filters={['All', 'Plans', 'Posts', 'Hidden Gems', 'Circle']}
 *     active={active}                    // string[]
 *     onPress={(f) => toggle(f)}         // parent owns toggle logic
 *     labels={{ 'Hidden Gems': 'Gems' }} // display-only rename
 *     icons={{ All: LayoutGrid, ... }}   // per-value icon components
 *   />
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, interpolate } from 'react-native-reanimated';
import { color, space } from '../theme/tokens';
import { navBarProgress } from '../hooks/useNavBarCollapse';

export interface PulseFilterRailProps {
  /** Ordered list of filter values. These are also matched by string equality for active state. */
  filters: string[];
  /** Currently active filters — matched by string equality against `filters` values. */
  active: string[];
  /** Called when a filter is tapped — receives the filter value (not the display label). */
  onPress: (filter: string) => void;
  /**
   * Horizontal padding at both ends of the rail. Kept symmetric so the
   * centered layout stays balanced. Default: space.lg (16).
   */
  leadingPad?: number;
  /**
   * Optional display label overrides. Keys are filter values; values are the
   * label shown to the user. Unspecified filters fall back to the value itself.
   * Example: { 'Hidden Gems': 'Gems' } shows "Gems" but the value passed to
   * onPress and matched in `active` is still 'Hidden Gems'.
   */
  labels?: Record<string, string>;
  /**
   * Optional per-value icon components (e.g. lucide icons). When provided,
   * each tab renders icon-above-label and the labels collapse on scroll-down
   * leaving an icon-only strip.
   */
  icons?: Record<string, React.ComponentType<{ size?: number; color?: string }>>;
}

// The internal horizontal padding of each tab. The indicator is inset by 2 px
// so it feels narrower than the touch target but wider than the text.
const TAB_PAD_H = 12;
// Label line box height — the collapse animation shrinks exactly this.
const LABEL_H = 18;

export function PulseFilterRail({
  filters,
  active,
  onPress,
  leadingPad = space.lg,
  labels,
  icons,
}: PulseFilterRailProps) {
  const hasIcons = !!icons;

  // Label block collapses when the nav bar collapses. Static (full) when the
  // rail has no icons — otherwise collapsing would leave empty tabs.
  const animatedLabelWrap = useAnimatedStyle(() => {
    if (!hasIcons) return { height: LABEL_H, marginTop: 0, opacity: 1 };
    const p = navBarProgress.value;
    return {
      height: interpolate(p, [0, 1], [LABEL_H, 0]),
      marginTop: interpolate(p, [0, 1], [3, 0]),
      opacity: interpolate(p, [0, 0.5], [1, 0], 'clamp'),
    };
  }, [hasIcons]);

  return (
    <View style={s.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[
          s.row,
          { paddingHorizontal: Math.max(0, leadingPad - TAB_PAD_H) },
        ]}
      >
        {filters.map((f) => {
          const isActive = active.includes(f);
          const displayLabel = labels?.[f] ?? f;
          const Icon = icons?.[f];
          return (
            <Pressable
              key={f}
              style={s.tab}
              onPress={() => onPress(f)}
              hitSlop={{ top: 6, bottom: 6, left: 0, right: 0 }}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={`${displayLabel} filter${isActive ? ', selected' : ''}`}
            >
              {Icon ? (
                <>
                  <Icon size={16} color={isActive ? color.ink : color.mute} />
                  <Animated.View style={[s.labelClip, animatedLabelWrap]}>
                    <Text style={[s.label, isActive && s.labelActive]} numberOfLines={1}>
                      {displayLabel}
                    </Text>
                  </Animated.View>
                </>
              ) : (
                <Text style={[s.label, isActive && s.labelActive]} numberOfLines={1}>
                  {displayLabel}
                </Text>
              )}
              {isActive && <View style={s.indicator} />}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  row: {
    // Center the tab group; ScrollView still scrolls if tabs overflow.
    flexGrow: 1,
    justifyContent: 'center',
    paddingTop: 2,
    // No paddingBottom — indicator sits flush at bottom: 0 of each tab
  },
  tab: {
    paddingHorizontal: TAB_PAD_H,
    paddingTop: 8,
    paddingBottom: 10,
    alignItems: 'center',
    // RN default position: 'relative' is the containing block for the indicator
  },
  labelClip: {
    overflow: 'hidden',
    alignItems: 'center',
  },
  label: {
    fontSize: 13,
    lineHeight: LABEL_H,
    fontWeight: '500',
    color: color.mute,
    letterSpacing: 0.15,
  },
  labelActive: {
    fontWeight: '800',
    color: color.ink,
    letterSpacing: -0.3,
  },
  indicator: {
    // Spans full tab width minus a small inset — wider than the text,
    // narrower than the touch area — for a proportional underline.
    position: 'absolute',
    bottom: 0,
    left: TAB_PAD_H - 2,
    right: TAB_PAD_H - 2,
    height: 2.5,
    borderRadius: 1.5,
    backgroundColor: color.signal,
  },
});
