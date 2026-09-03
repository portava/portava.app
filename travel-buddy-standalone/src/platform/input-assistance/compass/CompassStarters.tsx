/**
 * CompassStarters — the deterministic compass-prompt starter chips (spec §56, §14).
 *
 * Presentational: renders a wrap of tappable starter prompts (built by
 * `buildCompassStarters`, which is deterministic and FLAG-INDEPENDENT). Tapping a
 * chip hands its full prompt text up via `onSelect` — the screen decides what to
 * do with it (seed the input for the user to review, per §22 "never auto-submit").
 * Renders `null` when there are no starters. Reuses the shared `SuggestionChip`.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Compass } from 'lucide-react-native';
import { SuggestionChip } from '../components/SuggestionChip.tsx';
import type { CompassStarter } from './compassPrompt.ts';
import { color, space, type as t, icon as iconToken } from '../../../theme/tokens.ts';

export interface CompassStartersProps {
  starters: CompassStarter[];
  /** Called with the full prompt text of the tapped starter. */
  onSelect: (prompt: string) => void;
  /** Optional header label (default "Try asking"). */
  heading?: string;
  testID?: string;
}

function CompassStartersBase({ starters, onSelect, heading = 'Try asking', testID }: CompassStartersProps) {
  if (!starters.length) return null;
  return (
    <View style={styles.wrap} testID={testID ?? 'compass-starters'}>
      <View style={styles.headingRow}>
        <Compass size={iconToken.s14} color={color.mute} />
        <Text style={styles.heading} accessibilityRole="header">
          {heading}
        </Text>
      </View>
      <View style={styles.chips}>
        {starters.map((s) => (
          <SuggestionChip
            key={s.id}
            label={s.label}
            onPress={() => onSelect(s.prompt)}
            testID={`compass-starter-${s.id}`}
          />
        ))}
      </View>
    </View>
  );
}

export const CompassStarters = React.memo(CompassStartersBase);

const styles = StyleSheet.create({
  wrap: {
    gap: space.sm,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  heading: {
    ...t.stamp,
    color: color.mute,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
});
