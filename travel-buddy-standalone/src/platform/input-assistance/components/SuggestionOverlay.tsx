/**
 * SuggestionOverlay — the container surface for suggestions under a field
 * (spec §27 UI surfaces, §37 empty/no-match, §46 accessibility, §33 stable
 * layout under the keyboard).
 *
 * Responsibilities:
 *  - render grouped sections (or a flat list) in an internally-scrolling card,
 *    capped in height and virtualized-friendly, so it never grows unbounded;
 *  - keep taps working while the software keyboard is up
 *    (keyboardShouldPersistTaps="handled") — the "no overlay trapped behind the
 *    keyboard" guarantee (§46) is met by keeping this INLINE below the field
 *    rather than in a modal;
 *  - announce loading + result count to screen readers via a polite live region
 *    (§46 "announce suggestion count");
 *  - present a context-dependent empty / no-match state (§37) and a quiet
 *    "assistance unavailable" degraded note (§38) — never an error that
 *    collapses the input.
 *
 * This component is presentational: it does not fetch. `SmartInput` (or any
 * consumer) feeds it the hook output.
 */
import React from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import { SuggestionGroup, groupSuggestions, type SuggestionSection } from './SuggestionGroup.tsx';
import { SuggestionList } from './SuggestionList.tsx';
import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';

export interface SuggestionOverlayProps {
  visible: boolean;
  loading: boolean;
  /** Endpoint unavailable / offline — show a quiet degraded note, no error. */
  unavailable?: boolean;
  /** Flat suggestions (auto-grouped) — ignored when `sections` is provided. */
  suggestions?: InputSuggestion[];
  /** Pre-built sections (overrides `suggestions`). */
  sections?: SuggestionSection[];
  onSelect: (s: InputSuggestion) => void;
  activeId?: string | null;
  renderLeading?: (s: InputSuggestion) => React.ReactNode;
  /** Whether to render section headers when auto-grouping flat suggestions. */
  grouped?: boolean;
  /** Context-dependent fallback actions for the no-match state (§37). */
  emptyState?: React.ReactNode;
  /** Cap on the overlay height. */
  maxHeight?: number;
  testID?: string;
}

export function SuggestionOverlay({
  visible,
  loading,
  unavailable,
  suggestions,
  sections,
  onSelect,
  activeId,
  renderLeading,
  grouped = true,
  emptyState,
  maxHeight = 320,
  testID,
}: SuggestionOverlayProps) {
  if (!visible) return null;

  const flat = suggestions ?? [];
  const resolvedSections: SuggestionSection[] =
    sections ?? (grouped ? groupSuggestions(flat) : [{ label: '', suggestions: flat }]);
  const total = resolvedSections.reduce((n, s) => n + s.suggestions.length, 0);

  const status = loading
    ? 'Loading suggestions'
    : total > 0
      ? `${total} suggestion${total === 1 ? '' : 's'}`
      : unavailable
        ? 'Suggestions unavailable'
        : 'No suggestions';

  return (
    <View style={[styles.card, { maxHeight }]} testID={testID ?? 'ia-suggestion-overlay'}>
      {/* Polite live region — announces count / loading to screen readers (§46). */}
      <Text
        style={styles.srStatus}
        accessibilityLiveRegion="polite"
        accessibilityRole="text"
        // Visually minimal but present; not hidden from a11y tree.
      >
        {status}
      </Text>

      {loading && total === 0 ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={color.deep} />
          <Text style={styles.loadingText}>Finding suggestions…</Text>
        </View>
      ) : null}

      {total > 0 ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
        >
          {resolvedSections.map((section, i) =>
            section.label ? (
              <SuggestionGroup
                key={`${section.label}-${i}`}
                section={section}
                onSelect={onSelect}
                activeId={activeId}
                renderLeading={renderLeading}
              />
            ) : (
              <SuggestionList
                key={`flat-${i}`}
                suggestions={section.suggestions}
                onSelect={onSelect}
                activeId={activeId}
                renderLeading={renderLeading}
              />
            ),
          )}
        </ScrollView>
      ) : !loading ? (
        <View style={styles.empty}>
          {emptyState ?? (
            <Text style={styles.emptyText}>
              {unavailable ? 'Suggestions are unavailable right now.' : 'No matches yet.'}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
    overflow: 'hidden',
    ...shadow.card,
  },
  srStatus: {
    // Kept in the a11y tree but visually unobtrusive.
    height: 0,
    opacity: 0,
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingVertical: space.xs,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  loadingText: {
    ...t.small,
    color: color.mute,
  },
  empty: {
    paddingHorizontal: space.md,
    paddingVertical: space.lg,
    alignItems: 'flex-start',
  },
  emptyText: {
    ...t.small,
    color: color.mute,
  },
});
