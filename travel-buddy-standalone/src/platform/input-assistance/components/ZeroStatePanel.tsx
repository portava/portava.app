/**
 * ZeroStatePanel — the §27 surface for "useful suggestions BEFORE typing".
 *
 * §27 names seven suggestion surfaces. Six of them shipped as components
 * (dropdown, bottom sheet, inline chip, action chip, correction banner, entity
 * preview row); the seventh did not. The zero-character rows the gateway
 * returns (§14 recents / defaults / saved places) were rendered through the
 * ordinary result list, which is not the same surface: an ordinary list says
 * "these matched what you typed", and the user has typed nothing. The spec's
 * one-line description of this surface — *"Useful suggestions before typing"* —
 * is a statement about FRAMING, and framing is what was missing.
 *
 * What it adds over the flat list:
 *   - a panel HEADING that names why the rows are there, announced as a header
 *     so a screen-reader user hears the framing too (§46);
 *   - an explicit pre-typing EMPTY state ("start typing…"), which is a
 *     different sentence from "no matches yet" — the second is a search result
 *     and the first is not (§37 "empty and no-match states" are two states);
 *   - a `body` slot so the container can hand it the VIRTUALIZED list rather
 *     than the panel mounting every row itself (§33 / G211).
 *
 * It is presentational only. It fetches nothing, decides nothing about which
 * rows are zero-state rows, and applies no policy — the gateway already did
 * both (`personalization.ts` recents, `geoResolver.ts` defaults).
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, space, type as t } from '../../../theme/tokens.ts';

export const ZERO_STATE_DEFAULT_TITLE = 'Suggestions';
export const ZERO_STATE_DEFAULT_HINT = 'Start typing to search.';

export interface ZeroStatePanelProps {
  /** Panel heading — names WHY these rows are here ("Recent", "Nearby", …). */
  title?: string;
  /** Shown when the field is empty and the zero-state set is empty too. */
  hint?: string;
  /** How many zero-state rows `body` is about to render. 0 ⇒ the hint. */
  count: number;
  /** The rows themselves, supplied by the container so they can be virtualized. */
  body?: React.ReactNode;
  testID?: string;
}

export function ZeroStatePanel({
  title = ZERO_STATE_DEFAULT_TITLE,
  hint = ZERO_STATE_DEFAULT_HINT,
  count,
  body,
  testID,
}: ZeroStatePanelProps) {
  return (
    <View style={styles.panel} testID={testID ?? 'ia-zero-state-panel'}>
      <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
        {title.toUpperCase()}
      </Text>
      {count > 0 ? (
        body ?? null
      ) : (
        <Text style={styles.hint} testID="ia-zero-state-hint">
          {hint}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    paddingTop: space.sm,
  },
  title: {
    ...t.stamp,
    color: color.faint,
    paddingHorizontal: space.md,
    paddingBottom: space.xs,
  },
  hint: {
    ...t.small,
    color: color.mute,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
});
