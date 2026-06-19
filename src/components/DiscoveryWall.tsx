import React from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Compass, Search, SlidersHorizontal, Bookmark, MapPin, Plus, Sparkles, Info, ChevronRight,
} from 'lucide-react-native';
import type { DiscoveryItem } from '../data/discovery';
import { color, space, radius, type as t, shadow } from '../theme/tokens';

/* ── Header ── */
export function DiscoveryHeader({
  city = 'Cebu', filterCount = 0, onSearch, onFilter, onSaved,
}: {
  city?: string; filterCount?: number;
  onSearch?: () => void; onFilter?: () => void; onSaved?: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[h.wrap, { paddingTop: insets.top + space.sm }]}>
      <View style={h.row}>
        <Compass size={26} color={color.signal} />
        <View style={{ flex: 1 }}>
          <Text style={h.title}>{city} Discovery</Text>
          <Text style={h.sub}>Places, gems, and experiences that match your vibe</Text>
        </View>
      </View>
      <View style={h.controls}>
        <Pressable style={h.iconBtn} onPress={onSearch} hitSlop={6}><Search size={20} color={color.ink} /></Pressable>
        <Pressable style={h.filterBtn} onPress={onFilter} hitSlop={6}>
          <SlidersHorizontal size={18} color={color.ink} />
          <Text style={h.filterText}>Filter</Text>
          {filterCount > 0 && <View style={h.badge}><Text style={h.badgeText}>{filterCount}</Text></View>}
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable style={h.savedBtn} onPress={onSaved} hitSlop={6}>
          <Bookmark size={17} color={color.signal} />
          <Text style={h.savedText}>Saved</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ── Provisional label pill ── */
function ProvNote({ text }: { text: string }) {
  return (
    <View style={p.row}>
      <Info size={12} color={color.mute} />
      <Text style={p.text}>{text}</Text>
    </View>
  );
}

/* ── Compass Pick / For You ── */
export function CompassPickBlock({ pick, side }: { pick: DiscoveryItem; side: DiscoveryItem[] }) {
  return (
    <View style={cp.wrap}>
      {/* hero pick */}
      <Pressable style={cp.hero} onPress={() => router.push('/(tabs)/ai')}>
        <View style={cp.heroMedia}>
          <View style={cp.labelDark}><Text style={cp.labelDarkText}>COMPASS PICK</Text></View>
        </View>
        <View style={cp.heroBody}>
          <View style={cp.heroTitleRow}>
            <Text style={cp.heroTitle}>{pick.name}</Text>
            <Sparkles size={16} color={color.signal} />
          </View>
          <Text style={cp.heroSub}>Top nightlife spot right now</Text>
          <View style={cp.locRow}><MapPin size={13} color={color.onInk} /><Text style={cp.heroLoc}>{pick.neighborhood}, {pick.city}</Text></View>
          <View style={cp.matchRow}><Info size={13} color={color.onInk} /><Text style={cp.matchText}>Matches your nightlife interest</Text></View>
          <View style={cp.heroBtns}>
            <Pressable style={cp.ghostBtn}><Text style={cp.ghostText}>View Details</Text></Pressable>
            <Pressable style={cp.addBtn}><Plus size={15} color={color.onInk} /><Text style={cp.addText}>Add to Plan</Text></Pressable>
          </View>
        </View>
      </Pressable>

      {/* two side cards */}
      <View style={cp.sideCol}>
        {side.map((s) => (
          <Pressable key={s.id} style={cp.sideCard} onPress={() => router.push('/(tabs)/ai')}>
            <View style={cp.sideBody}>
              <View style={[cp.sideTag, s.source === 'traveler' ? cp.tagGreen : cp.tagGray]}>
                <Text style={[cp.sideTagText, s.source === 'traveler' ? cp.tagGreenText : cp.tagGrayText]}>
                  {s.source === 'traveler' ? 'POPULAR WITH TRAVELERS' : 'STARTER CITY NOTE'}
                </Text>
              </View>
              <Text style={cp.sideTitle}>{s.name}</Text>
              <Text style={cp.sideBlurb} numberOfLines={2}>{s.blurb}</Text>
              {s.source === 'traveler' && s.savedCount
                ? <View style={cp.savedRow}><Bookmark size={11} color={color.mute} /><Text style={cp.savedNote}>Saved by {s.savedCount} travelers</Text></View>
                : <ProvNote text="Starter city note — provisional" />}
            </View>
            <View style={cp.sideThumb} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/* ── Category chips with icons ── */
export function CategoryChips({ active, onPick, categories }: { active: string; onPick: (c: string) => void; categories: readonly string[] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cc.row}>
      {categories.map((c) => {
        const on = c === active;
        return (
          <Pressable key={c} style={[cc.chip, on && cc.chipOn]} onPress={() => onPick(c)}>
            <Text style={[cc.chipText, on && cc.chipTextOn]}>{c}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/* ── Featured experience card (horizontal) ── */
export function FeaturedCard({ item, onAdd }: { item: DiscoveryItem; onAdd?: () => void }) {
  return (
    <Pressable style={fc.card} onPress={() => router.push('/(tabs)/ai')}>
      <View style={fc.media}>
        <View style={fc.sparkle}><Sparkles size={14} color={color.onInk} /></View>
      </View>
      <View style={fc.body}>
        <Text style={fc.title} numberOfLines={1}>{item.name}</Text>
        <Text style={fc.sub} numberOfLines={1}>{item.blurb}</Text>
        <View style={fc.locRow}><MapPin size={11} color={color.mute} /><Text style={fc.loc} numberOfLines={1}>{item.neighborhood}</Text></View>
        <View style={fc.btnRow}>
          <Pressable style={fc.addBtn} onPress={onAdd}><Text style={fc.addText}>Add to Plan</Text></Pressable>
          <Pressable style={fc.saveBtn} hitSlop={6}><Bookmark size={16} color={color.mute} /></Pressable>
        </View>
      </View>
    </Pressable>
  );
}

export function SectionHead({ title, onViewAll }: { title: string; onViewAll?: () => void }) {
  return (
    <View style={sh.row}>
      <Text style={sh.title}>{title}</Text>
      <View style={{ flex: 1 }} />
      {onViewAll && (
        <Pressable style={sh.viewAll} onPress={onViewAll} hitSlop={6}>
          <Text style={sh.viewAllText}>View all</Text>
          <ChevronRight size={15} color={color.signal} />
        </Pressable>
      )}
    </View>
  );
}

const h = StyleSheet.create({
  wrap: { backgroundColor: color.paper, paddingHorizontal: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.hero, color: color.ink, fontSize: 28 },
  sub: { ...t.small, color: color.mute, marginTop: 1 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md },
  iconBtn: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, height: 42, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  filterText: { ...t.bodyStrong, color: color.ink },
  badge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  badgeText: { ...t.stamp, color: color.onInk, fontFamily: 'Courier' },
  savedBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, height: 42, borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.signal, backgroundColor: color.paperRaised },
  savedText: { ...t.bodyStrong, color: color.signal },
});

const p = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  text: { ...t.small, color: color.mute, fontSize: 11, fontStyle: 'italic' },
});

const cp = StyleSheet.create({
  wrap: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg },
  hero: { flex: 1.3, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: color.ink, ...shadow.card },
  heroMedia: { height: 90, backgroundColor: color.deep, padding: space.md },
  labelDark: { alignSelf: 'flex-start', backgroundColor: color.signal, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  labelDarkText: { ...t.stamp, color: color.onInk, fontFamily: 'Courier' },
  heroBody: { padding: space.md, gap: 5 },
  heroTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroTitle: { ...t.title, color: color.onInk, fontSize: 19 },
  heroSub: { ...t.small, color: color.haze },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  heroLoc: { ...t.small, color: color.onInk },
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.12)', alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm, marginTop: 2 },
  matchText: { ...t.small, color: color.onInk, fontSize: 11 },
  heroBtns: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  ghostBtn: { flex: 1, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.sm, alignItems: 'center' },
  ghostText: { ...t.small, fontWeight: '700', color: color.onInk },
  addBtn: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 4, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.sm },
  addText: { ...t.small, fontWeight: '800', color: color.onInk },

  sideCol: { flex: 1, gap: space.md },
  sideCard: { flex: 1, flexDirection: 'row', backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden' },
  sideBody: { flex: 1, padding: space.sm, gap: 3 },
  sideTag: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm },
  tagGray: { backgroundColor: color.haze },
  tagGreen: { backgroundColor: '#E3F1EA' },
  sideTagText: { fontFamily: 'Courier', fontSize: 7.5, fontWeight: '700', letterSpacing: 0.5 },
  tagGrayText: { color: color.mute },
  tagGreenText: { color: color.success },
  sideTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  sideBlurb: { ...t.small, color: color.mute, fontSize: 11 },
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  savedNote: { ...t.small, color: color.mute, fontSize: 10 },
  sideThumb: { width: 60, backgroundColor: color.deep },
});

const cc = StyleSheet.create({
  row: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  chipOn: { backgroundColor: color.signal, borderColor: color.signal },
  chipText: { ...t.small, fontWeight: '700', color: color.ink },
  chipTextOn: { color: color.onInk },
});

const fc = StyleSheet.create({
  card: { width: 160, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { height: 110, backgroundColor: color.deep, padding: space.sm },
  sparkle: { width: 26, height: 26, borderRadius: 13, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.md, gap: 3 },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  sub: { ...t.small, color: color.mute, fontSize: 11 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  loc: { ...t.small, color: color.mute, fontSize: 11 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  addBtn: { flex: 1, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingVertical: 6, alignItems: 'center' },
  addText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
  saveBtn: { padding: 4 },
});

const sh = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, marginTop: space.xl, marginBottom: space.md },
  title: { ...t.title, color: color.ink, fontSize: 20 },
  viewAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  viewAllText: { ...t.small, color: color.signal, fontWeight: '700' },
});
