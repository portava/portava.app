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
import { color, space, type as t } from '../../../theme/tokens.ts';

export interface SuggestionSection {
  /** Section label, e.g. "Cities", "People". */
  label: string;
  suggestions: InputSuggestion[];
}

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

/**
 * Group a flat suggestion list into sections by entity type (falling back to
 * assistance type). Preserves the server's ordering within each section and the
 * order in which section keys first appear — so the server's ranking survives.
 */
export function groupSuggestions(
  suggestions: InputSuggestion[],
  labelFor: (key: string) => string = defaultLabelFor,
): SuggestionSection[] {
  const order: string[] = [];
  const byKey = new Map<string, InputSuggestion[]>();
  for (const s of suggestions) {
    const key = s.entityType ?? s.type;
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(s);
  }
  return order.map((key) => ({ label: labelFor(key), suggestions: byKey.get(key)! }));
}

function defaultLabelFor(key: string): string {
  const map: Record<string, string> = {
    city: 'Cities',
    country: 'Countries',
    neighborhood: 'Neighborhoods',
    place: 'Places',
    hidden_gem: 'Hidden Gems',
    user: 'People',
    buddy: 'Buddies',
    trip: 'Trips',
    event: 'Events',
    plan: 'Plans',
    hashtag: 'Hashtags',
    language: 'Languages',
    interest: 'Interests',
    action: 'Actions',
    completion: 'Search',
    recent: 'Recent',
  };
  return map[key] ?? key.replace(/_/g, ' ');
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
