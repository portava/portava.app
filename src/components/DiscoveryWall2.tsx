import React from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
  Gem, MapPin, Bookmark, Plus, Star, Info, Sparkles, ChevronRight,
} from 'lucide-react-native';
import type { DiscoveryItem } from '../data/discovery';
import type { NeighborhoodVibe, TravelerPick, SavedDiscoveryItem } from '../data/discovery';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens';
import { TravelSectionHeader, TravelEmptyState } from './primitives';
import { useAttach } from './AttachController';

/* small provisional note */
function Prov({ text = 'Starter city note — provisional' }: { text?: string }) {
  return (
    <View style={g.provRow}>
      <Info size={11} color={color.mute} />
      <Text style={g.provText}>{text}</Text>
    </View>
  );
}

/* ── Hidden Gems ── */
export function HiddenGemCard({ gem }: { gem: DiscoveryItem }) {
  const attach = useAttach();
  return (
    <View style={g.card}>
      <View style={g.media}>
        <View style={g.gemBadge}><Gem size={14} color={color.onInk} /></View>
        <Pressable style={g.saveIcon} hitSlop={layout.hitSlop}><Bookmark size={15} color={color.onInk} /></Pressable>
      </View>
      <View style={g.body}>
        <Text style={g.name} numberOfLines={1}>{gem.name}</Text>
        <View style={g.locRow}><MapPin size={11} color={color.mute} /><Text style={g.loc} numberOfLines={1}>{gem.neighborhood}</Text></View>
        <Text style={g.blurb} numberOfLines={2}>{gem.blurb}</Text>
        {gem.submittedBy ? (
          <View style={g.byRow}>
            <Image source={{ uri: gem.submittedBy.avatarUrl }} style={g.byAvatar} />
            <Text style={g.by}>By {gem.submittedBy.name}</Text>
          </View>
        ) : null}
        <View style={g.btnRow}>
          <Pressable style={({ pressed }) => [g.addBtn, pressed && { opacity: layout.pressedOpacity }]}
            onPress={() => attach.open({ id: gem.id, type: 'hidden_gem', title: gem.name, city: gem.city, category: 'Hidden Gem' }, 'plan')}>
            <Text style={g.addText}>Add to Plan</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export function HiddenGemsSection({ gems }: { gems: DiscoveryItem[] }) {
  return (
    <View>
      <TravelSectionHeader title="Hidden Gems (By Travelers)" onAction={() => router.push('/saved')} />
      {gems.length === 0 ? (
        <TravelEmptyState title="No hidden gems yet" sub="Be the first to share a spot travelers should know about." />
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={g.strip}>
          {gems.slice(0, 5).map((gem) => <HiddenGemCard key={gem.id} gem={gem} />)}
        </ScrollView>
      )}
    </View>
  );
}

/* ── Neighborhoods / Areas by Vibe ── */
export function NeighborhoodCard({ n }: { n: NeighborhoodVibe }) {
  return (
    <Pressable style={nb.card} onPress={() => router.push('/(tabs)/ai')}>
      <View style={nb.media} />
      <View style={nb.overlay}>
        <Text style={nb.vibe} numberOfLines={1}>{n.vibe}</Text>
        <Text style={nb.area} numberOfLines={1}>{n.area}</Text>
      </View>
    </Pressable>
  );
}

export function NeighborhoodsSection({ items }: { items: NeighborhoodVibe[] }) {
  return (
    <View>
      <TravelSectionHeader title="Neighborhoods / Areas by Vibe" onAction={() => router.push('/saved')} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={nb.strip}>
        {items.slice(0, 5).map((n) => <NeighborhoodCard key={n.id} n={n} />)}
      </ScrollView>
      <View style={{ paddingHorizontal: space.lg }}><Prov text="Often associated with — starter city notes, provisional" /></View>
    </View>
  );
}

/* ── Traveler Picks ── */
export function TravelerPickCard({ pick }: { pick: TravelerPick }) {
  const attach = useAttach();
  return (
    <View style={tp.card}>
      <View style={tp.head}>
        <Image source={{ uri: pick.user.avatarUrl }} style={tp.avatar} />
        <View style={{ flex: 1 }}>
          <Text style={tp.user}>{pick.user.name}</Text>
          <Text style={tp.time}>{pick.timeAgo}</Text>
        </View>
        <View style={tp.tag}><Text style={tp.tagText}>{pick.tag}</Text></View>
      </View>
      <View style={tp.placeRow}>
        <Text style={tp.place} numberOfLines={1}>{pick.place}</Text>
        {pick.rating ? (
          <View style={tp.rating}><Star size={12} color={color.warn} fill={color.warn} /><Text style={tp.ratingText}>{pick.rating}</Text></View>
        ) : null}
      </View>
      <Text style={tp.note} numberOfLines={1}>{pick.note}</Text>
      <View style={tp.btnRow}>
        <Pressable style={({ pressed }) => [tp.saveBtn, pressed && { opacity: layout.pressedOpacity }]} hitSlop={layout.hitSlop}>
          <Bookmark size={14} color={color.mute} /><Text style={tp.saveText}>Save</Text>
        </Pressable>
        <Pressable style={({ pressed }) => [tp.addBtn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={() => attach.open({ id: pick.id, type: 'place', title: pick.place, city: pick.city, category: pick.tag }, 'plan')}>
          <Text style={tp.addText}>Add to Plan</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function TravelerPicksSection({ picks }: { picks: TravelerPick[] }) {
  return (
    <View>
      <TravelSectionHeader title="Traveler Picks" onAction={() => router.push('/saved')} />
      {picks.length === 0 ? (
        <TravelEmptyState title="No traveler picks yet" sub="Recommendations from travelers will show up here." />
      ) : (
        <View style={tp.strip}>
          {picks.slice(0, 3).map((p) => <TravelerPickCard key={p.id} pick={p} />)}
        </View>
      )}
    </View>
  );
}

/* ── Saved Ideas ── */
export function SavedIdeasSection({ items }: { items: SavedDiscoveryItem[] }) {
  const attach = useAttach();
  return (
    <View>
      <TravelSectionHeader title="Saved Ideas" onAction={() => router.push('/saved')} />
      {items.length === 0 ? (
        <TravelEmptyState title="Nothing saved yet" sub="Save places, gems, and experiences to build your trip." action="Explore the city" onAction={() => router.push('/(tabs)/discovery')} />
      ) : (
        <View style={sv.list}>
          {items.map((it) => (
            <View key={it.id} style={sv.row}>
              <View style={sv.thumb} />
              <View style={{ flex: 1 }}>
                <Text style={sv.name} numberOfLines={1}>{it.name}</Text>
                <Text style={sv.meta} numberOfLines={1}>{it.type} · {it.neighborhood}</Text>
              </View>
              <Pressable style={({ pressed }) => [sv.addBtn, pressed && { opacity: layout.pressedOpacity }]}
                onPress={() => attach.open({ id: it.id, type: 'place', title: it.name, city: it.neighborhood, category: it.type }, 'trip')}>
                <Plus size={13} color={color.signal} /><Text style={sv.addText}>Add to Trip</Text>
              </Pressable>
              <Pressable hitSlop={layout.hitSlop}><Bookmark size={17} color={color.signal} fill={color.signal} /></Pressable>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/* ── Ask Compass card ── */
export function AskCompassCard() {
  const prompts = ['Build a night from these', 'Find more like this', 'Turn saved ideas into a plan', "What matches my vibe?"];
  return (
    <View style={ac.card}>
      <View style={ac.head}>
        <View style={ac.icon}><Sparkles size={18} color={color.onInk} /></View>
        <View style={{ flex: 1 }}>
          <Text style={ac.title}>Ask Compass</Text>
          <Text style={ac.sub}>Turn discoveries into a plan. Uses your saved ideas and interests.</Text>
        </View>
      </View>
      <View style={ac.prompts}>
        {prompts.map((p) => (
          <Pressable key={p} style={({ pressed }) => [ac.prompt, pressed && { opacity: layout.pressedOpacity }]} onPress={() => router.push('/(tabs)/ai')}>
            <Text style={ac.promptText}>{p}</Text>
            <ChevronRight size={14} color={color.signal} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const g = StyleSheet.create({
  provRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.sm },
  provText: { ...t.small, color: color.mute, fontSize: 11, fontStyle: 'italic' },
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.xs },
  card: { width: 200, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { height: 120, backgroundColor: color.deep, padding: space.sm, justifyContent: 'space-between', flexDirection: 'row' },
  gemBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: color.success, alignItems: 'center', justifyContent: 'center' },
  saveIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(17,17,15,0.4)', alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.md, gap: 3 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  loc: { ...t.small, color: color.mute, fontSize: 11 },
  blurb: { ...t.small, color: color.mute, fontSize: 12, marginTop: 2 },
  byRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  byAvatar: { width: 18, height: 18, borderRadius: 9, backgroundColor: color.haze },
  by: { ...t.small, color: color.mute, fontSize: 11 },
  btnRow: { marginTop: space.sm },
  addBtn: { borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingVertical: 6, alignItems: 'center' },
  addText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
});

const nb = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.xs },
  card: { width: 150, height: 96, borderRadius: radius.md, overflow: 'hidden', backgroundColor: color.ink, ...shadow.card },
  media: { ...StyleSheet.absoluteFillObject, backgroundColor: color.deep },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', padding: space.sm, backgroundColor: 'rgba(17,17,15,0.28)' },
  vibe: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
  area: { ...t.small, color: color.onInkMute, fontSize: 11 },
});

const tp = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: 6, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: color.haze },
  user: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  time: { ...t.small, color: color.faint, fontSize: 11 },
  tag: { backgroundColor: color.haze, paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  tagText: { ...t.small, color: color.mute, fontWeight: '700', fontSize: 11 },
  placeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  place: { ...t.bodyStrong, color: color.ink, flex: 1 },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  ratingText: { ...t.small, color: color.ink, fontWeight: '700' },
  note: { ...t.small, color: color.mute },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze },
  saveText: { ...t.small, color: color.mute, fontWeight: '700' },
  addBtn: { flex: 1, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingVertical: 6, alignItems: 'center' },
  addText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
});

const sv = StyleSheet.create({
  list: { gap: space.sm, paddingHorizontal: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.sm },
  thumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: color.deep },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  meta: { ...t.small, color: color.mute, fontSize: 11 },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: space.sm, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze },
  addText: { ...t.small, fontWeight: '700', color: color.signal, fontSize: 12 },
});

const ac = StyleSheet.create({
  card: { marginHorizontal: space.lg, marginTop: space.xl, backgroundColor: color.ink, borderRadius: radius.lg, padding: space.lg, gap: space.md, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  title: { ...t.title, color: color.onInk, fontSize: 18 },
  sub: { ...t.small, color: color.onInkMute, marginTop: 1 },
  prompts: { gap: space.sm },
  prompt: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.md },
  promptText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
});
