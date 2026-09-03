/**
 * EntitySuggestionRow — a single entity suggestion (spec §13, §28 preview
 * anatomy, §46 accessibility).
 *
 * Renders enough context to choose without opening the entity: leading type
 * glyph (or a caller-provided leading node, e.g. a hydrated avatar), primary
 * title + entity-type, a location/subtitle line, an optional freshness badge
 * (§31 — never fabricated; shown only when the suggestion carries a fresh
 * `freshness`), and an optional "why this is suggested" reason.
 *
 * Accessibility: role=button, a composed accessibilityLabel announcing the
 * title, type, subtitle and freshness, and `selected` state for keyboard nav.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import { EntityIcon } from './entityIcon.tsx';
import { freshnessDisplay } from './freshnessDisplay.ts';
import { color, space, radius, type as t, avatar } from '../../../theme/tokens.ts';

export interface EntitySuggestionRowProps {
  suggestion: InputSuggestion;
  onPress: (s: InputSuggestion) => void;
  /** True when this row is the keyboard-active row (§46 arrow-key nav). */
  active?: boolean;
  /** Optional custom leading element (e.g. a sanctioned avatar wrapper). */
  leading?: React.ReactNode;
  testID?: string;
}

function EntitySuggestionRowBase({ suggestion, onPress, active, leading, testID }: EntitySuggestionRowProps) {
  // §31: render ONLY the freshness the server attached — the state label plus the
  // "Updated 4m ago" age, verbatim. Never synthesized; absent ⇒ no chip.
  const fresh = freshnessDisplay(suggestion.freshness).text;
  const a11yLabel = [
    suggestion.label,
    suggestion.entityType,
    suggestion.subtitle,
    fresh,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
      onPress={() => onPress(suggestion)}
      style={[styles.row, active && styles.rowActive]}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityHint={suggestion.reason ?? undefined}
      accessibilityState={{ selected: !!active }}
      testID={testID ?? `ia-entity-row-${suggestion.id}`}
    >
      <View style={styles.leading}>
        {leading ?? <EntityIcon entityType={suggestion.entityType} tint={color.deep} />}
      </View>

      <View style={styles.body}>
        <View style={styles.titleLine}>
          <Text style={styles.title} numberOfLines={1}>
            {suggestion.label}
          </Text>
          {fresh ? (
            <View style={styles.freshBadge}>
              <Text style={styles.freshText} numberOfLines={1}>
                {fresh}
              </Text>
            </View>
          ) : null}
        </View>
        {suggestion.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {suggestion.subtitle}
          </Text>
        ) : null}
        {suggestion.reason ? (
          <Text style={styles.reason} numberOfLines={1}>
            {suggestion.reason}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export const EntitySuggestionRow = React.memo(EntitySuggestionRowBase);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    gap: space.md,
    borderRadius: radius.md,
  },
  rowActive: {
    backgroundColor: color.haze,
  },
  leading: {
    width: avatar.s32,
    height: avatar.s32,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    flexShrink: 1,
  },
  subtitle: {
    ...t.small,
    color: color.mute,
    marginTop: 1,
  },
  reason: {
    ...t.small,
    color: color.faint,
    marginTop: 1,
  },
  freshBadge: {
    paddingHorizontal: space.sm,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: color.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
  },
  freshText: {
    ...t.stamp,
    color: color.deep,
  },
});
