/**
 * TelegraphSystemNotice — centered notice pill for system_notice messages.
 * Used for things like "You matched availability this weekend",
 * "Trip plan updated", or "Activity confirmed by host".
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Info } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';

interface Props {
  text: string;
}

export function TelegraphSystemNotice({ text }: Props) {
  return (
    <View style={styles.wrap}>
      <View style={styles.pill}>
        <Info size={11} color={color.mute} />
        <Text style={styles.text}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    maxWidth: '80%',
  },
  text: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    textAlign: 'center',
    fontFamily: 'Courier',
  },
});
