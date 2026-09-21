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
 * title, type, subtitle and freshness, `selected` state for keyboard nav, a
 * caret glyph that marks the keyboard-active row WITHOUT relying on colour
 * (§46 "non-color-only state indicators" — see the activeSlot comment below),
 * and a line budget that grows with the OS text scale instead of truncating
 * (§46 "dynamic type and large text support" — see `rowLineLimit`).
 */
import React from 'react';
import { View, Text, Pressable, PixelRatio, StyleSheet } from 'react-native';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import { rowLineLimit } from './overlayFit.ts';
import { EntityIcon } from './entityIcon.tsx';
import { freshnessDisplay } from './freshnessDisplay.ts';
import { suggestionBadges } from './suggestionBadges.ts';
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
  // §20 verification / official / Hidden Gem protection. Derived from the SAME
  // helper the announcement below joins, so a badge can never be visible and
  // unannounced (or the reverse).
  const badges = suggestionBadges(suggestion);
  // §46 dynamic type — at a large OS text scale `numberOfLines={1}` does not
  // make the row fit, it makes the ANSWER shorter: "Đà Nẵng, Vietnam" becomes
  // "Đà Na…" for exactly the readers who need the whole of it. The budget grows
  // with the scale and the overlay's internal ScrollView absorbs the height.
  const lines = rowLineLimit(PixelRatio.getFontScale());
  const a11yLabel = [
    suggestion.label,
    suggestion.entityType,
    suggestion.subtitle,
    ...badges.map((b) => b.label),
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
      {/*
        §46 "high contrast and NON-COLOUR-ONLY state indicators".
        The keyboard-active row used to differ from every other row by exactly
        one property — `backgroundColor` — so a sighted user who cannot resolve
        that hue against the row ground had no way to tell which row Enter would
        take. `accessibilityState.selected` (above) serves assistive tech and
        does nothing for them.
        This slot is the second, non-colour channel: a caret GLYPH that is
        present on the active row and absent everywhere else. Presence/absence of
        a mark survives any colour vision, any contrast setting and a greyscale
        screenshot. The slot keeps its width whether or not the caret is drawn,
        so arrowing down the list moves the highlight without shifting the text.
        It is hidden from assistive tech on purpose: `selected` already carries
        this to a screen reader, and announcing a decorative caret would be a
        second, redundant reading of the same fact.
      */}
      <View style={styles.activeSlot}>
        {active ? (
          <Text
            style={styles.activeMarker}
            accessibilityElementsHidden
            importantForAccessibility="no"
            testID="ia-row-active-marker"
          >
            ▸
          </Text>
        ) : null}
      </View>

      <View style={styles.leading}>
        {leading ?? <EntityIcon entityType={suggestion.entityType} tint={color.deep} />}
      </View>

      <View style={styles.body}>
        <View style={styles.titleLine}>
          <Text style={styles.title} numberOfLines={lines} testID="ia-row-title">
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
          <Text style={styles.subtitle} numberOfLines={lines} testID="ia-row-subtitle">
            {suggestion.subtitle}
          </Text>
        ) : null}
        {badges.length > 0 ? (
          <View style={styles.badgeLine}>
            {badges.map((b) => (
              <View key={b.id} style={styles.badge} testID={`ia-badge-${b.id}`}>
                <Text style={styles.badgeText} numberOfLines={1}>
                  {b.label}
                </Text>
              </View>
            ))}
          </View>
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
  /** Fixed width so the caret's presence never reflows the row (§46). */
  activeSlot: {
    width: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeMarker: {
    ...t.bodyStrong,
    color: color.deep,
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
  badgeLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: space.sm,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: color.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
  },
  badgeText: {
    ...t.stamp,
    color: color.deep,
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
