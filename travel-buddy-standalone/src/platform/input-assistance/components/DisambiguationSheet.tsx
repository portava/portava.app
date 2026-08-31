/**
 * DisambiguationSheet — confidence-tiered clarification (spec §19, §27 bottom
 * sheet, §46).
 *
 * "Ambiguity must result in clarification choices, not silent guesses" (§19).
 * Renders the ranked candidates (e.g. Paris, France · Paris, Texas · Paris saved
 * collection) plus an always-present "Search «query» instead" escape so raw
 * input stays reachable (§19 LOW/VERY-LOW: do not auto-replace).
 *
 * Presented as a Modal bottom sheet. The keyboard is dismissed on open so the
 * choices are never trapped behind it (§46). Selecting a candidate resolves the
 * ambiguity; the parent owns what "resolve" does.
 */
import React, { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Keyboard } from 'react-native';
import { Search } from 'lucide-react-native';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import { EntitySuggestionRow } from './EntitySuggestionRow.tsx';
import { color, space, radius, type as t, icon as iconToken } from '../../../theme/tokens.ts';

export interface DisambiguationSheetProps {
  visible: boolean;
  /** The raw query being disambiguated (for the "Search … instead" row). */
  query: string;
  /** Ranked candidate entities (§19 MEDIUM confidence → multiple choices). */
  candidates: InputSuggestion[];
  onSelect: (s: InputSuggestion) => void;
  /** Fall back to a raw search on `query`. */
  onSearchInstead: (query: string) => void;
  onClose: () => void;
  /** Sheet title. Default derived from the query. */
  title?: string;
}

export function DisambiguationSheet({
  visible,
  query,
  candidates,
  onSelect,
  onSearchInstead,
  onClose,
  title,
}: DisambiguationSheetProps) {
  useEffect(() => {
    if (visible) Keyboard.dismiss(); // choices must not sit behind the keyboard (§46)
  }, [visible]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={styles.sheet} accessibilityViewIsModal>
        <View style={styles.handle} />
        <Text style={styles.title} accessibilityRole="header">
          {title ?? `Which "${query}"?`}
        </Text>

        <View style={styles.list}>
          {candidates.map((c) => (
            <EntitySuggestionRow key={c.id} suggestion={c} onPress={onSelect} />
          ))}
        </View>

        <Pressable
          onPress={() => onSearchInstead(query)}
          style={styles.searchInstead}
          accessibilityRole="button"
          accessibilityLabel={`Search ${query} instead`}
        >
          <Search size={iconToken.s18} color={color.deep} />
          <Text style={styles.searchInsteadText} numberOfLines={1}>
            Search “{query}” instead
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: color.scrimBottom,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.xxl,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
    marginBottom: space.sm,
  },
  title: {
    ...t.heading,
    color: color.ink,
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
  },
  list: {
    marginBottom: space.sm,
  },
  searchInstead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  searchInsteadText: {
    ...t.bodyStrong,
    color: color.deep,
  },
});
