/**
 * DiscoveryIntentModeSelector — Sensing §8's eight intent modes on the
 * Discovery screen. census-discovery §71 (lane P31), rows A05 and DV-42.
 *
 * Sensing §8: "Support intent modes using the same shared intelligence: Right
 * Now, Tonight, Explore, Quiet, Social, High Energy, Nearby, Trip." The chosen
 * mode is sent as `?intentMode=` on GET /discovery (services/discovery.ts); the
 * server's live rank reads it.
 *
 * SHOWN ONLY WHEN THE SERVER REPORTS THE CAPABILITY. The live rank that reads
 * the mode is gated by `discovery_live_rank_enabled` (migration 2850, seeded
 * FALSE). With it off the server ignores the mode, so a selector would be
 * decorative, which DSV2-03 rules out ("UI selection is not merely
 * decorative"). The app already reads server flags through FeatureFlagsContext,
 * which is fail-soft: an unreadable or absent flag is OFF. So capability
 * unknown ⇒ hidden. Whether to show it while 2850 is off is an owner question
 * (census-discovery §71); this is the fail-safe answer until it is decided.
 *
 * NO DEFAULT. Nothing is chosen until the user chooses. Pressing the chosen
 * mode again clears it, which sends today's request. The screen holds the
 * choice in memory for the session; it is not persisted (no spec states a
 * persistence rule).
 *
 * Labels are the spec's mode names verbatim. Owner-overrulable copy.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { useFeatureFlags } from '../../context/FeatureFlagsContext.tsx';
import {
  DISCOVERY_INTENT_MODES,
  DISCOVERY_INTENT_MODE_LABELS,
  DISCOVERY_LIVE_RANK_FLAG,
  type DiscoveryIntentMode,
} from '../../services/discovery.ts';
import { color, radius, space } from '../../theme/tokens.ts';

/** True only when the server reports that it ranks on the intent mode. */
export function useDiscoveryIntentModeCapability(): boolean {
  const { isEnabled } = useFeatureFlags();
  return isEnabled(DISCOVERY_LIVE_RANK_FLAG);
}

interface Props {
  /** The chosen mode, or null for none. */
  selected: DiscoveryIntentMode | null;
  /** Called with the mode pressed, or null when the chosen mode is pressed again. */
  onChange: (mode: DiscoveryIntentMode | null) => void;
}

export function DiscoveryIntentModeSelector({ selected, onChange }: Props) {
  const capable = useDiscoveryIntentModeCapability();
  if (!capable) return null;
  return (
    <ScrollView
      testID="discovery-intent-mode-selector"
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.bar}
      contentContainerStyle={styles.barContent}
      accessibilityLabel="Intent mode"
    >
      {DISCOVERY_INTENT_MODES.map((mode) => {
        const active = mode === selected;
        return (
          <Pressable
            key={mode}
            testID={`discovery-intent-mode-${mode}`}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => onChange(active ? null : mode)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>
              {DISCOVERY_INTENT_MODE_LABELS[mode]}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// The Discovery screen's context-mode chip styles (app/(tabs)/discovery.tsx `modeChip`), so the two rows read as one panel.
const styles = StyleSheet.create({
  bar: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  barContent: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    gap: space.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: color.haze,
  },
  chipActive: {
    backgroundColor: color.signal + '14',
    borderColor: color.signal + '50',
  },
  chipLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: color.mute,
  },
  chipLabelActive: {
    color: color.signal,
  },
});
