/**
 * MediaWorldHeader — the World/NOW header (spec §4.1).
 *
 *   MEDIA
 *   Da Nang · Right Now
 *
 * World-first framing: the place and moment lead, not a creator. Optional
 * Compass and Search affordances (Compass is a primary intelligence control,
 * §46). A subtle "as of" line honours §39 (never presented as continuously live).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Compass, Search } from 'lucide-react-native';
import { color, space, avatar } from '../../../theme/tokens.ts';

export interface MediaWorldHeaderProps {
  cityName: string | null;
  /** Short right-hand context, defaults to "Right Now". */
  contextLabel?: string;
  /** "as of" freshness line, e.g. "Updated 2m ago" (§39). */
  asOfLabel?: string | null;
  onCompass?: () => void;
  onSearch?: () => void;
}

export function MediaWorldHeader({
  cityName,
  contextLabel = 'Right Now',
  asOfLabel,
  onCompass,
  onSearch,
}: MediaWorldHeaderProps) {
  return (
    <View style={styles.wrap}>
      <View style={styles.textCol}>
        <Text style={styles.wordmark}>MEDIA</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {cityName ? `${cityName} · ${contextLabel}` : contextLabel}
        </Text>
        {asOfLabel ? <Text style={styles.asOf}>{asOfLabel}</Text> : null}
      </View>
      <View style={styles.actions}>
        {onSearch ? (
          <Pressable style={styles.iconBtn} onPress={onSearch} hitSlop={8} accessibilityLabel="Search media">
            <Search size={20} color={color.onInk} strokeWidth={2} />
          </Pressable>
        ) : null}
        {onCompass ? (
          <Pressable style={styles.iconBtn} onPress={onCompass} hitSlop={8} accessibilityLabel="Ask Compass">
            <Compass size={20} color={color.onInk} strokeWidth={2} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  textCol: { flex: 1 },
  wordmark: {
    color: color.onInk,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 3,
  },
  subtitle: {
    color: color.onInk,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.6,
    marginTop: 2,
  },
  asOf: { color: color.onInkMute, fontSize: 12, fontWeight: '600', marginTop: 3 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: 4 },
  iconBtn: {
    width: avatar.s40,
    height: avatar.s40,
    borderRadius: avatar.s40 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(250,249,246,0.08)',
  },
});
