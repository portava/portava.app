import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
  MapPin, Moon, Utensils, Users, Gem, ShieldCheck, Plane, Lock, ChevronRight,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import type { PassportStamp } from '../types/models.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';

type LucideIcon = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

/**
 * Header stamp strip — Level-1 OFFICIAL passport format (CITY · CATEGORY ink
 * stamps), NOT illustrated city art (that's reserved for the full Stamps page).
 * Consistent frame, muted ink, distressed border, no overflow. 4–6 max.
 *
 * Maps the existing stamp data model into {city, category, date/status} without
 * faking dates: missing date -> "LOCKED"/"SOON" or omitted.
 */

type StampView = { city: string; category: string; status: string; Icon: LucideIcon; locked: boolean };

const KIND_CATEGORY: Record<string, { category: string; Icon: LucideIcon }> = {
  city: { category: 'ARRIVAL', Icon: Plane },
  plan: { category: 'JOINED', Icon: Users },
  gem: { category: 'FOUND', Icon: Gem },
  safe: { category: 'CHECKED', Icon: ShieldCheck },
  host: { category: 'HOSTED', Icon: MapPin },
  perk: { category: 'PERK', Icon: Gem },
};

/** Derive a clean CITY · CATEGORY view from a stamp, honest about dates. */
function toView(s: PassportStamp): StampView {
  const km = KIND_CATEGORY[s.kind] ?? { category: 'STAMP', Icon: MapPin };
  // city stamps: label is the city; non-city: label is the achievement
  const city = s.label.toUpperCase();
  // category: prefer an explicit sublabel hint, else kind-based
  let category = km.category;
  let Icon = km.Icon;
  const sub = (s.sublabel ?? '').toLowerCase();
  if (sub.includes('night')) { category = 'NIGHTLIFE'; Icon = Moon; }
  else if (sub.includes('food') || sub.includes('lechon')) { category = 'FOOD'; Icon = Utensils; }
  // status / date — never fabricated
  let status: string;
  if (s.locked) status = 'LOCKED';
  else if (s.earnedAt) status = new Date(s.earnedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }).toUpperCase();
  else status = 'EARNED';
  return { city, category, status, Icon, locked: !!s.locked };
}

export function PassportStampCard({ stamp, rotate = 0, onPress }: { stamp: PassportStamp; rotate?: number; onPress?: () => void }) {
  const v = toView(stamp);
  const tint = v.locked ? color.faint : color.deep;
  return (
    <Pressable onPress={onPress} hitSlop={4} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }]}>
      <View style={[sc.card, { borderColor: tint, transform: [{ rotate: `${rotate}deg` }] }, v.locked && sc.locked]}>
        {/* inner distressed ring */}
        <View style={[sc.innerRing, { borderColor: tint }]} />
        {/* icon */}
        <View style={sc.iconRow}>
          {v.locked ? <Lock size={15} color={tint} /> : <v.Icon size={15} color={tint} strokeWidth={2} />}
        </View>
        {/* city */}
        <Text style={[sc.city, { color: tint }]} numberOfLines={1}>{v.city}</Text>
        {/* category */}
        <Text style={[sc.category, { color: tint }]} numberOfLines={1}>{v.category}</Text>
        {/* status divider + date */}
        <View style={[sc.statusDivider, { backgroundColor: tint }]} />
        <Text style={[sc.status, { color: tint }]} numberOfLines={1}>{v.status}</Text>
      </View>
    </Pressable>
  );
}

export function PassportStampStrip({ stamps }: { stamps: PassportStamp[] }) {
  const earned = stamps.filter((s) => !s.locked);
  const featured = (earned.length ? [...earned, ...stamps.filter((s) => s.locked)] : stamps).slice(0, 6);
  return (
    <View style={sc.stripWrap}>
      <Pressable style={sc.head} onPress={() => router.push('/stamps')}>
        <Plane size={14} color={color.deep} />
        <Text style={sc.headTitle}>PASSPORT STAMPS</Text>
        <Text style={sc.headCount}>{earned.length} earned</Text>
        <View style={{ flex: 1 }} />
        <Text style={sc.viewAll}>View all</Text>
        <ChevronRight size={15} color={color.mute} />
      </Pressable>
      {earned.length === 0 ? (
        <View style={sc.empty}><Text style={sc.emptyText}>No stamps yet — join a plan or visit a city to earn your first.</Text></View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={sc.strip}>
          {featured.map((s, i) => (
            <PassportStampCard key={s.id} stamp={s} rotate={((i % 3) - 1) * 2.5} onPress={() => router.push('/stamps')} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const STAMP_W = 104;
const sc = StyleSheet.create({
  card: {
    width: STAMP_W, height: STAMP_W * 1.12,
    borderWidth: 2, borderStyle: 'dashed', borderRadius: radius.sm,
    backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 6, gap: 2,
  },
  locked: { backgroundColor: '#F2F0EB' },
  innerRing: { position: 'absolute', top: 4, left: 4, right: 4, bottom: 4, borderWidth: 0.8, borderRadius: 4, opacity: 0.3 },
  iconRow: { marginBottom: 1 },
  city: { fontFamily: 'Courier', fontWeight: '700', fontSize: 13, letterSpacing: 0.5, textAlign: 'center' },
  category: { fontFamily: 'Courier', fontWeight: '700', fontSize: 9, letterSpacing: 1, textAlign: 'center', opacity: 0.85 },
  statusDivider: { width: 36, height: 0.8, opacity: 0.4, marginVertical: 3 },
  status: { fontFamily: 'Courier', fontSize: 7.5, letterSpacing: 0.5, opacity: 0.7 },

  stripWrap: { marginTop: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.lg, marginBottom: space.sm },
  headTitle: { fontFamily: 'Courier', fontSize: 12, fontWeight: '700', letterSpacing: 1.5, color: color.ink },
  headCount: { ...t.small, color: color.signal, fontFamily: 'Courier', fontSize: 11 },
  viewAll: { ...t.small, color: color.mute, fontWeight: '600' },
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  empty: { marginHorizontal: space.lg, padding: space.lg, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.haze },
  emptyText: { ...t.small, color: color.mute },
});
