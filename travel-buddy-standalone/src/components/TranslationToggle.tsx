/**
 * TranslationToggle
 *
 * Renders the "Translated from X · See original" / "See translation" inline
 * toggle that appears below translatable content blocks.
 *
 * Pass the state object returned by useContentTranslation.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, space, typography } from '../theme/tokens.ts';
import type { ContentTranslationState } from '../hooks/useContentTranslation.ts';

interface Props {
  tx: ContentTranslationState;
}

export function TranslationToggle({ tx }: Props) {
  const { canTranslate, loading, translated, translationLabel, toggle } = tx;

  if (!canTranslate) return null;

  if (loading) {
    return (
      <View style={styles.row}>
        <ActivityIndicator size="small" color={color.faint} />
        <Text style={styles.labelText}> Translating…</Text>
      </View>
    );
  }

  if (translated) {
    return (
      <View style={styles.row}>
        {translationLabel ? (
          <Text style={styles.labelText}>{translationLabel}</Text>
        ) : null}
        {translationLabel ? <Text style={styles.separator}> · </Text> : null}
        <Pressable onPress={toggle} hitSlop={8}>
          <Text style={styles.toggleText}>See original</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <Pressable onPress={toggle} hitSlop={8}>
        <Text style={styles.toggleText}>See translation</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.xs,
    flexWrap: 'wrap',
  },
  labelText: {
    ...typography.caption,
    color: color.mute,
  },
  separator: {
    ...typography.caption,
    color: color.mute,
  },
  toggleText: {
    ...typography.caption,
    color: color.deep,
    textDecorationLine: 'underline',
  },
});
