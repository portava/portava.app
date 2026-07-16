import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
  MapPin, Users, Gem, ShieldCheck, Crown, Ticket, ChevronRight,
  Fish, Landmark, Soup, Building2, Sparkles, Lock,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import type { PassportStamp } from '../types/models.ts';
import { motifFor } from '../lib/stampMotif.ts';
import { IllustratedStamp, CITY_ART } from './IllustratedStamp.tsx';
import { color, space, radius, type as t } from '../theme/tokens.ts';

/* Safe icon resolution — every iconKey maps to a real lucide icon, with a
 * guaranteed fallback so an unknown key never crashes the stamp. */
type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
const ICONS: Record<string, IconCmp> = {
  MapPin, Users, Gem, ShieldCheck, Crown, Ticket,
  Fish, Landmark, Soup, Building2,
  TorusIcon: Building2, // tokyo placeholder until a temple icon/Level-2 art
};
function iconFor(key: string): IconCmp {
  return ICONS[key] ?? MapPin;
}

/** One collectible stamp badge. Motif-driven: city icon+accent, else category. */
export function StampBadge({
  stamp, size = 84, rotate = 0, onPress,
}: {
  stamp: PassportStamp;
  size?: number;
  rotate?: number;
  onPress?: () => void;
}) {
  const motif = motifFor(stamp);
  const Icon = iconFor(motif.iconKey);
  const locked = stamp.locked;
  const tint = locked ? color.faint : motif.accent;
  const isOval = motif.frame === 'oval';

  const inner = (
    <View
      style={[
        styles.badge,
        {
          width: size, height: size,
          borderColor: tint,
          borderRadius: isOval ? size / 2 : radius.md,
          transform: [{ rotate: `${rotate}deg` }],
        },
        locked && styles.badgeLocked,
      ]}
    >
      <View
        style={[
          styles.innerRing,
          { borderColor: tint, borderRadius: isOval ? size / 2 : radius.sm },
        ]}
      />
      <Icon size={size * 0.24} color={tint} strokeWidth={2.2} />
      <Text style={[styles.badgeLabel, { color: tint, fontSize: size * 0.12 }]} numberOfLines={1}>
        {stamp.label}
      </Text>
      {(motif.caption || stamp.sublabel) ? (
        <Text style={[styles.badgeSub, { color: tint, fontSize: size * 0.095 }]} numberOfLines={1}>
          {motif.caption ?? stamp.sublabel}
        </Text>
      ) : null}
    </View>
  );
  return onPress ? <Pressable onPress={onPress} hitSlop={4}>{inner}</Pressable> : inner;
}

/** Small horizontal hero strip for the profile. 4–6 featured, taps to /stamps. */
export function StampStrip({ stamps }: { stamps: PassportStamp[] }) {
  const earned = stamps.filter((s) => !s.locked);
  const featured = (earned.length ? earned : stamps).slice(0, 6);
  return (
    <View style={styles.stripWrap}>
      <Pressable style={styles.stripHead} onPress={() => router.push('/stamps')}>
        <Text style={styles.stripTitle}>Passport Stamps</Text>
        <Text style={styles.stripCount}>{earned.length} earned</Text>
        <View style={{ flex: 1 }} />
        <Text style={styles.viewAll}>View all</Text>
        <ChevronRight size={15} color={color.mute} />
      </Pressable>
      {earned.length === 0 ? (
        <View style={styles.emptyStrip}>
          <Text style={styles.emptyText}>No stamps yet — join a plan or visit a city to earn your first.</Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {featured.map((s, i) => (
            <StampBadge key={s.id} stamp={s} size={76} rotate={((i % 3) - 1) * 3} onPress={() => router.push('/stamps')} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderWidth: 2, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 4,
    backgroundColor: color.paper,
  },
  badgeLocked: { opacity: 0.6 },
  innerRing: { position: 'absolute', top: 5, left: 5, right: 5, bottom: 5, borderWidth: 1, opacity: 0.3 },
  badgeLabel: { ...t.stamp, fontFamily: 'Courier', textAlign: 'center' },
  badgeSub: { fontFamily: 'Courier', opacity: 0.85, letterSpacing: 0.5 },

  stripWrap: { marginTop: space.lg },
  stripHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm, paddingHorizontal: space.lg, marginBottom: space.sm },
  stripTitle: { ...t.heading, color: color.ink },
  stripCount: { ...t.stamp, fontFamily: 'Courier', color: color.signal },
  viewAll: { ...t.small, color: color.mute, fontWeight: '600' },
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  emptyStrip: { marginHorizontal: space.lg, padding: space.lg, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.haze },
  emptyText: { ...t.small, color: color.mute },
});

/* ── Featured strip using Level-2 illustrated stamps (matches the mockup) ── */
function citySlugOf(stamp: PassportStamp): string | null {
  const hay = `${stamp.label} ${stamp.sublabel ?? ''}`.toLowerCase();
  for (const slug of Object.keys(CITY_ART)) if (hay.includes(slug)) return slug;
  return null;
}

export function FeaturedStamps({ stamps }: { stamps: PassportStamp[] }) {
  const earned = stamps.filter((s) => !s.locked);
  const featured = (earned.length ? earned : stamps).slice(0, 5);
  return (
    <View style={fs.wrap}>
      <Pressable style={fs.head} onPress={() => router.push('/stamps')}>
        <Sparkles size={15} color={color.signal} />
        <Text style={fs.title}>FEATURED STAMPS</Text>
        <View style={{ flex: 1 }} />
        <Text style={fs.viewAll}>View all</Text>
        <ChevronRight size={15} color={color.mute} />
      </Pressable>
      {earned.length === 0 ? (
        <View style={fs.empty}><Text style={fs.emptyText}>No stamps yet — join a plan or visit a city to earn your first.</Text></View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={fs.strip}>
          {featured.map((s) => {
            const slug = citySlugOf(s);
            const isExp = !slug; // non-city -> experience-style stamp
            return (
              <Pressable key={s.id} onPress={() => router.push('/stamps')}>
                <IllustratedStamp
                  slug={slug ?? 'generic'}
                  size={92}
                  locked={s.locked}
                  experienceLabel={isExp ? { title: s.label, sub: s.sublabel ?? '', tint: color.signal } : undefined}
                />
              </Pressable>
            );
          })}
          {/* "More stamps" locked tile */}
          <Pressable style={fs.more} onPress={() => router.push('/stamps')}>
            <Lock size={20} color={color.faint} />
            <Text style={fs.moreText}>More{'\n'}Stamps</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

const fs = StyleSheet.create({
  wrap: { marginTop: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.lg, marginBottom: space.sm },
  title: { fontFamily: 'Courier', fontSize: 12, fontWeight: '700', letterSpacing: 1.5, color: color.ink },
  viewAll: { ...t.small, color: color.mute, fontWeight: '600' },
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  empty: { marginHorizontal: space.lg, padding: space.lg, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.haze },
  emptyText: { ...t.small, color: color.mute },
  more: { width: 92, height: 120, borderRadius: radius.md, borderWidth: 2, borderStyle: 'dashed', borderColor: color.haze, alignItems: 'center', justifyContent: 'center', gap: 6 },
  moreText: { ...t.small, color: color.faint, fontWeight: '600', textAlign: 'center', fontFamily: 'Courier' },
});
