/**
 * SuggestionGroup — a labeled section of suggestions (spec §12/§13 grouped
 * results: CITIES / PLACES / PEOPLE / HIDDEN GEMS …). A header row (announced
 * to screen readers as a header, §46) over a SuggestionList of the section's
 * items. Empty groups render nothing.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import { SuggestionList } from './SuggestionList.tsx';
import type { SuggestionSection } from './suggestionGrouping.ts';
import { color, space, type as t } from '../../../theme/tokens.ts';

// Re-export the pure grouping logic (moved to suggestionGrouping.ts so it is
// node:test-safe) so every existing import site — the barrel, SuggestionOverlay —
// keeps importing it from here unchanged.
export { groupSuggestions, defaultLabelFor, type SuggestionSection } from './suggestionGrouping.ts';

export interface SuggestionGroupProps {
  section: SuggestionSection;
  onSelect: (s: InputSuggestion) => void;
  activeId?: string | null;
  renderLeading?: (s: InputSuggestion) => React.ReactNode;
}

export function SuggestionGroup({ section, onSelect, activeId, renderLeading }: SuggestionGroupProps) {
  if (!section.suggestions.length) return null;
  return (
    <View style={styles.group}>
      <Text
        style={styles.header}
        accessibilityRole="header"
        numberOfLines={1}
      >
        {section.label.toUpperCase()}
      </Text>
      <SuggestionList
        suggestions={section.suggestions}
        onSelect={onSelect}
        activeId={activeId}
        renderLeading={renderLeading}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    marginBottom: space.sm,
  },
  header: {
    ...t.stamp,
    color: color.faint,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.xs,
  },
});
