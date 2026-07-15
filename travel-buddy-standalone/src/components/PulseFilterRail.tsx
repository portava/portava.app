/**
 * PulseFilterRail — compact underline-tab row for feed/content category filters.
 *
 * Replaces bulky pill-button chip rows with a clean, low-chrome tab-bar pattern:
 *   • Active tab: heavy-weight ink text + 2.5 px signal-red pill underline
 *   • Inactive tab: muted-weight text, zero chrome (no borders, no backgrounds)
 *   • Full-height pressable with hitSlop for comfortable one-handed use
 *   • Hairline bottom border anchors the indicator to the section visually
 *
 * Usage:
 *   <PulseFilterRail
 *     filters={['All', 'Plans', 'Posts', 'Hidden Gems', 'Circle']}
 *     active={active}            // string[]
 *     onPress={(f) => toggle(f)} // parent owns toggle/single-select logic
 *   />
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { color, space } from '../theme/tokens';

export interface PulseFilterRailProps {
  /** Ordered list of filter values. These are also matched by string equality for active state. */
  filters: string[];
  /** Currently active filters — matched by string equality against `filters` values. */
  active: string[];
  /** Called when a filter is tapped — receives the filter value (not the display label). */
  onPress: (filter: string) => void;
  /**
   * Horizontal padding for the first tab so its text aligns with the page grid.
   * Default: space.lg (16). Subtract TAB_PAD_H internally so the text left-edge
   * lands exactly at this value.
   */
  leadingPad?: number;
  /**
   * Optional display label overrides. Keys are filter values; values are the
   * label shown to the user. Unspecified filters fall back to the value itself.
   * Example: { 'Hidden Gems': 'Gems' } shows "Gems" but the value passed to
   * onPress and matched in `active` is still 'Hidden Gems'.
   */
  labels?: Record<string, string>;
}

// The internal horizontal padding of each tab. The indicator is inset by 2 px
// so it feels narrower than the touch target but wider than the text.
const TAB_PAD_H = 12;

export function PulseFilterRail({
  filters,
  active,
  onPress,
  leadingPad = space.lg,
  labels,
}: PulseFilterRailProps) {
  return (
    <View style={s.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[
          s.row,
          { paddingLeft: Math.max(0, leadingPad - TAB_PAD_H) },
        ]}
      >
        {filters.map((f) => {
          const isActive = active.includes(f);
          const displayLabel = labels?.[f] ?? f;
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
              <Text
                style={[s.label, isActive && s.labelActive]}
                numberOfLines={1}
              >
                {displayLabel}
              </Text>
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
    paddingRight: space.lg,
    paddingTop: 2,
    // No paddingBottom — indicator sits flush at bottom: 0 of each tab
  },
  tab: {
    paddingHorizontal: TAB_PAD_H,
    paddingTop: 10,
    paddingBottom: 13,
    alignItems: 'center',
    // RN default position: 'relative' is the containing block for the indicator
  },
  label: {
    fontSize: 14,
    lineHeight: 18,
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
