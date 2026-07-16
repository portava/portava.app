/**
 * PassportDivider — perforation-style section divider.
 * Row of evenly-spaced dots flanked by thin ruled lines.
 * Optional centred label in PP_LABEL caps.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { PP, PP_LABEL } from '../../theme/passportTokens';

interface Props {
  label?: string;
}

const DOT_COUNT = 8;
const DOT_SIZE = 5;

function Perforations() {
  return (
    <View style={s.dots}>
      {Array.from({ length: DOT_COUNT }).map((_, i) => (
        <View key={i} style={s.dot} />
      ))}
    </View>
  );
}

export function PassportDivider({ label }: Props) {
  return (
    <View style={s.row}>
      <View style={s.line} />
      <Perforations />
      {label ? (
        <View style={s.labelWrap}>
          <Text style={s.label}>{label}</Text>
        </View>
      ) : null}
      <Perforations />
      <View style={s.line} />
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 14,
    paddingHorizontal: 20,
  },
  line: {
    flex: 1,
    height: 1,
    backgroundColor: PP.borderLight,
  },
  dots: {
    flexDirection: 'row',
    gap: 5,
    marginHorizontal: 6,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    backgroundColor: PP.borderLight,
  },
  labelWrap: {
    marginHorizontal: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: PP.borderLight,
    borderRadius: 4,
    backgroundColor: PP.paper,
  },
  label: {
    ...PP_LABEL,
    fontSize: 8,
    letterSpacing: 2,
  },
});
