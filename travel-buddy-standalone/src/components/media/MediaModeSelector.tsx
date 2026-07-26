/**
 * MediaModeSelector — horizontal Watch · Grid · Gems mode picker.
 *
 * Rendering rules:
 *   - Watch and Gems overlay full-screen media: translucent/gradient backing,
 *     light text, announced to screen readers.
 *   - Grid uses a solid surface (color.paper) with dark text.
 *
 * Accessibility:
 *   - Each item has accessibilityRole="tab" and accessibilityState selected.
 *   - Minimum 44pt touch targets enforced.
 *   - Web: keyboard-focusable via focusable prop.
 */

import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { MediaMode } from '../../stores/mediaStore.ts';
import { color, space, type as t } from '../../theme/tokens.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ModeItem {
  key: MediaMode;
  label: string;
}

interface MediaModeSelectorProps {
  /** Which modes are currently enabled (controlled by MEDIA_VIEW_MODE_* flags). */
  modes: ModeItem[];
  /** Currently active mode. */
  selectedMode: MediaMode;
  /** Called when the user selects a different mode. */
  onSelect: (mode: MediaMode) => void;
}

// ── Backing surfaces ─────────────────────────────────────────────────────────
// Watch and Gems overlay full-screen media → translucent pill.
// Grid sits on a solid surface → opaque bar.

const IMMERSIVE_MODES: MediaMode[] = ['watch', 'gems'];

function isImmersive(mode: MediaMode): boolean {
  return IMMERSIVE_MODES.includes(mode);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MediaModeSelector({ modes, selectedMode, onSelect }: MediaModeSelectorProps) {
  const immersive = isImmersive(selectedMode);

  const container = (
    <View
      style={[styles.row, immersive ? styles.rowImmersive : styles.rowSolid]}
      accessibilityRole="tablist"
    >
      {modes.map(({ key, label }) => {
        const active = key === selectedMode;
        return (
          <Pressable
            key={key}
            style={({ pressed }) => [
              styles.item,
              active && (immersive ? styles.itemActiveImmersive : styles.itemActiveSolid),
              pressed && styles.itemPressed,
            ]}
            onPress={() => onSelect(key)}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected: active }}
            // Web keyboard navigation
            {...(Platform.OS === 'web' ? { focusable: true } : {})}
          >
            <Text
              style={[
                styles.label,
                immersive ? styles.labelImmersive : styles.labelSolid,
                active && (immersive ? styles.labelActiveImmersive : styles.labelActiveSolid),
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  // For immersive (Watch/Gems): wrap in a gradient scrim so the selector
  // remains legible over dark video backgrounds.
  if (immersive) {
    return (
      <LinearGradient
        colors={['rgba(0,0,0,0.45)', 'transparent']}
        style={styles.gradient}
        pointerEvents="box-none"
      >
        {container}
      </LinearGradient>
    );
  }

  return container;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  gradient: {
    // Sits at the very top of the screen, inside the safe area.
    paddingBottom: space.xl,
  },
  row: {
    flexDirection: 'row',
    alignSelf: 'center',
    borderRadius: 999,
    overflow: 'hidden',
    marginHorizontal: space.xl,
  },
  rowImmersive: {
    backgroundColor: 'rgba(0,0,0,0.30)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  rowSolid: {
    backgroundColor: color.haze,
  },
  item: {
    // Minimum 44pt touch target (height enforced via paddingVertical).
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 72,
    minHeight: 44,
  },
  itemActiveImmersive: {
    backgroundColor: 'rgba(255,255,255,0.20)',
    borderRadius: 999,
  },
  itemActiveSolid: {
    backgroundColor: color.paperRaised,
    borderRadius: 999,
  },
  itemPressed: {
    opacity: 0.75,
  },
  label: {
    ...t.stamp,
    letterSpacing: 0.3,
  },
  labelImmersive: {
    color: color.onInkMute,
  },
  labelSolid: {
    color: color.mute,
  },
  labelActiveImmersive: {
    color: color.onInk,
    fontWeight: '700',
  },
  labelActiveSolid: {
    color: color.ink,
    fontWeight: '700',
  },
});
