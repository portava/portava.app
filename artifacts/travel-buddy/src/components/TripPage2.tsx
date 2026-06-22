import React, { useState } from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import {
  MapPin, Clock, MessageCircle, UserPlus, Sparkles, ShieldCheck, Map, ImagePlus,
  ChevronRight, Info, Plus,
} from 'lucide-react-native';
import type { TripPlan, TripPlanStatus } from '../data/tripDetail';
import type { PassportStamp, User } from '../types/models';
import { PassportStampCard } from './PassportStampCard';
import { TravelSectionHeader, TravelEmptyState } from './primitives';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens';

const PLAN_TABS: { key: TripPlanStatus; label: string }[] = [
  { key: 'joined', label: 'Joined' },
  { key: 'hosting', label: 'Hosting' },
  { key: 'requested', label: 'Requested' },
  { key: 'past', label: 'Past' },
  { key: 'saved', label: 'Saved' },
];

/* ── Plans ── */
export function TripPlans({ plans }: { plans: TripPlan[] }) {
  const [tab, setTab] = useState<TripPlanStatus>('joined');
  const visible = plans.filter((p) => p.status === tab);
  return (
    <View>
      <TravelSectionHeader title="Plans" onAction={() => router.push('/(tabs)/trips')} actionLabel="View all" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={p.tabs}>
        {PLAN_TABS.map((tb) => (
          <Pressable key={tb.key} style={[p.tab, tab === tb.key && p.tabOn]} onPress={() => setTab(tb.key)}>
            <Text style={[p.tabText, tab === tb.key && p.tabTextOn]}>{tb.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {visible.length === 0 ? (
        <TravelEmptyState title="No trip plans yet" sub="Add one from Pulse or create your own." action="Browse Pulse" onAction={() => router.push('/' as any)} />
      ) : (
        <View style={p.list}>
          {visible.map((plan) => (
            <View key={plan.id} style={p.card}>
              <View style={p.media} />
              <View style={p.body}>
                <Text style={p.title} numberOfLines={1}>{plan.title}</Text>
                <View style={p.line}><Clock size={12} color={color.mute} /><Text style={p.lineText}>{plan.time}</Text></View>
                <View style={p.line}><MapPin size={12} color={color.mute} /><Text style={p.lineText} numberOfLines={1}>{plan.neighborhood}</Text></View>
                <Text style={p.going}>{plan.attendeeCount} going</Text>
              </View>
              <View style={p.actions}>
                <Pressable style={p.viewBtn} onPress={() => router.push('/(tabs)/trips')}><Text style={p.viewText}>View Plan</Text></Pressable>
                {plan.hasGroup ? (
                  <Pressable style={p.msgBtn} onPress={() => router.push('/messages')} hitSlop={layout.hitSlop}><MessageCircle size={15} color={color.mute} /></Pressable>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/* ── Trip Circle ── */
export function TripCircle({ cityCount, inCity, suggested }: { cityCount: number; inCity: User[]; suggested: User[] }) {
  return (
    <View>
      <TravelSectionHeader title="Trip Circle" onAction={() => router.push('/circle')} actionLabel="View all" />
      <View style={c.card}>
        <Text style={c.count}>{cityCount} buddies are in Cebu</Text>
        <View style={c.avatars}>
          {inCity.map((u) => (
            <Pressable key={u.id} onPress={() => router.push(`/profile/${u.handle}`)} style={c.avatarWrap}>
              <Image source={{ uri: u.avatarUrl }} style={c.avatar} />
              <View style={c.onlineDot} />
            </Pressable>
          ))}
          <Pressable style={c.inviteBtn} onPress={() => router.push('/circle')}>
            <UserPlus size={16} color={color.signal} />
          </Pressable>
        </View>
        <Pressable style={c.inviteRow} onPress={() => router.push('/circle')}>
          <Plus size={14} color={color.signal} /><Text style={c.inviteText}>Invite more buddies</Text>
        </Pressable>

        <View style={c.divider} />
        <Text style={c.suggestLabel}>People you may want to connect with</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={c.suggestRow}>
          {suggested.map((u) => (
            <Pressable key={u.id} onPress={() => router.push(`/profile/${u.handle}`)}>
              <Image source={{ uri: u.avatarUrl }} style={c.suggestAvatar} />
            </Pressable>
          ))}
          <Pressable style={c.suggestMore} onPress={() => router.push('/circle')}><ChevronRight size={18} color={color.mute} /></Pressable>
        </ScrollView>
      </View>
    </View>
  );
}

/* ── Compass Trip Brief ── */
export function CompassTripBrief() {
  const prompts = ['Build tonight from saved ideas', 'Find plans that fit my availability', 'Summarize this trip', 'Suggest what to do next'];
  return (
    <View>
      <TravelSectionHeader title="Compass Trip Brief" />
      <View style={cb.card}>
        <View style={cb.head}>
          <View style={cb.icon}><Sparkles size={18} color={color.onInk} /></View>
          <View style={{ flex: 1 }}>
            <Text style={cb.title}>Let Compass build your perfect night</Text>
            <Text style={cb.sub}>Based on your trip city, dates, saved ideas, and availability.</Text>
          </View>
        </View>
        <Pressable style={cb.cta} onPress={() => router.push('/(tabs)/ai')}>
          <Sparkles size={16} color={color.onInk} /><Text style={cb.ctaText}>Ask Compass</Text>
        </Pressable>
        <View style={cb.chips}>
          {prompts.map((pr) => (
            <Pressable key={pr} style={cb.chip} onPress={() => router.push('/(tabs)/ai')}>
              <Text style={cb.chipText}>{pr}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

/* ── Trip Stamps ── */
export function TripStamps({ stamps }: { stamps: PassportStamp[] }) {
  const earned = stamps.filter((s) => !s.locked);
  return (
    <View>
      <TravelSectionHeader title="Trip Stamps" onAction={() => router.push('/stamps')} actionLabel="View all" />
      {stamps.length === 0 ? (
        <TravelEmptyState title="No trip stamps yet" sub="Earn stamps by joining plans, checking in, and sharing discoveries." />
      ) : (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ts.strip}>
            {stamps.map((s, i) => <PassportStampCard key={s.id} stamp={s} rotate={((i % 3) - 1) * 2} onPress={() => router.push('/stamps')} />)}
          </ScrollView>
          <Text style={ts.note}>{earned.length} earned · {stamps.length - earned.length} to unlock</Text>
        </View>
      )}
    </View>
  );
}

/* ── Map Preview (compact stub — approximate only, no live location) ── */
export function TripMapPreview() {
  return (
    <View>
      <TravelSectionHeader title="Map Preview" onAction={() => router.push('/(tabs)/discovery')} actionLabel="View map" />
      <View style={m.card}>
        <View style={m.map}>
          {/* stylized markers — approximate only */}
          <View style={[m.pin, { top: '30%', left: '25%', backgroundColor: color.signal }]} />
          <View style={[m.pin, { top: '55%', left: '60%', backgroundColor: color.deep }]} />
          <View style={[m.pin, { top: '40%', left: '75%', backgroundColor: color.success }]} />
          <View style={m.cityLabel}><Text style={m.cityText}>Cebu City</Text></View>
        </View>
        <View style={m.legend}>
          <View style={m.legendItem}><View style={[m.dot, { backgroundColor: color.signal }]} /><Text style={m.legendText}>Plans</Text></View>
          <View style={m.legendItem}><View style={[m.dot, { backgroundColor: color.deep }]} /><Text style={m.legendText}>Saved</Text></View>
          <View style={m.legendItem}><View style={[m.dot, { backgroundColor: color.success }]} /><Text style={m.legendText}>Hidden Gems</Text></View>
        </View>
        <View style={m.noteRow}><Info size={11} color={color.mute} /><Text style={m.note}>Approximate areas only — exact locations stay private.</Text></View>
      </View>
    </View>
  );
}

/* ── Safety / Check-In (compact stub) ── */
export function TripSafety() {
  return (
    <View>
      <TravelSectionHeader title="Safety & Check-In" />
      <View style={sf.card}>
        <View style={sf.head}>
          <View style={sf.icon}><ShieldCheck size={18} color={color.success} /></View>
          <View style={{ flex: 1 }}>
            <Text style={sf.title}>All good!</Text>
            <Text style={sf.sub}>You're checked in and sharing your trip with your Circle.</Text>
          </View>
        </View>
        <View style={sf.btns}>
          <Pressable style={sf.btn} onPress={() => Alert.alert('Coming Soon', 'Safe Return check-ins are coming in a future update.', [{ text: 'OK' }])}><Text style={sf.btnText}>Start Safe Return</Text></Pressable>
          <Pressable style={sf.btn} onPress={() => Alert.alert('Coming Soon', 'Emergency Contacts management is coming in a future update.', [{ text: 'OK' }])}><Text style={sf.btnText}>Emergency Contacts</Text></Pressable>
        </View>
        <View style={sf.noteRow}><Info size={11} color={color.mute} /><Text style={sf.note}>Privacy-first — you control what your Circle sees.</Text></View>
      </View>
    </View>
  );
}

/* ── Trip Posts (compact stub) ── */
export function TripPostsSection({ posts }: { posts: { id: string; city: string; caption: string; mediaUrl?: string }[] }) {
  return (
    <View>
      <TravelSectionHeader title="Trip Posts" onAction={posts.length ? () => router.push('/(tabs)/passport') : undefined} actionLabel="View all" />
      {posts.length === 0 ? (
        <TravelEmptyState title="No trip posts yet" sub="Share a moment from this trip — it’ll appear here and on your Passport." action="Add Post" onAction={() => router.push('/create')} />
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={tp.strip}>
          {posts.map((post) => (
            <Pressable key={post.id} style={tp.tile} onPress={() => router.push('/(tabs)/passport')}>
              <View style={tp.media} />
              <Text style={tp.caption} numberOfLines={2}>{post.caption}</Text>
            </Pressable>
          ))}
          <Pressable style={tp.addTile} onPress={() => router.push('/create')}>
            <ImagePlus size={20} color={color.signal} /><Text style={tp.addText}>Add Post</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

const p = StyleSheet.create({
  tabs: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  tab: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  tabOn: { backgroundColor: color.signal, borderColor: color.signal },
  tabText: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 13 },
  tabTextOn: { color: color.onInk },
  list: { gap: space.md, paddingHorizontal: space.lg },
  card: { flexDirection: 'row', backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { width: 84, backgroundColor: color.deep },
  body: { flex: 1, padding: space.md, gap: 2 },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  lineText: { ...t.small, color: color.mute, fontSize: 11 },
  going: { ...t.small, color: color.mute, fontSize: 11, marginTop: 2 },
  actions: { justifyContent: 'center', alignItems: 'center', gap: space.sm, paddingRight: space.md },
  viewBtn: { borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 6 },
  viewText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
  msgBtn: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
});

const c = StyleSheet.create({
  card: { marginHorizontal: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.md, ...shadow.card },
  count: { ...t.bodyStrong, color: color.ink },
  avatars: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  avatarWrap: {},
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: color.haze },
  onlineDot: { position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: color.success, borderWidth: 2, borderColor: color.paperRaised },
  inviteBtn: { width: 48, height: 48, borderRadius: 24, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  inviteRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  inviteText: { ...t.small, fontWeight: '700', color: color.signal },
  divider: { height: 1, backgroundColor: color.haze },
  suggestLabel: { ...t.small, color: color.mute, fontWeight: '600' },
  suggestRow: { gap: space.sm, alignItems: 'center' },
  suggestAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.haze },
  suggestMore: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
});

const cb = StyleSheet.create({
  card: { marginHorizontal: space.lg, backgroundColor: color.ink, borderRadius: radius.lg, padding: space.lg, gap: space.md, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  title: { ...t.bodyStrong, color: color.onInk, fontSize: 16 },
  sub: { ...t.small, color: color.onInkMute, marginTop: 1 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md },
  ctaText: { ...t.bodyStrong, color: color.onInk },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm },
  chipText: { ...t.small, color: color.onInk, fontWeight: '600', fontSize: 12 },
});

const ts = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.xs },
  note: { ...t.small, color: color.mute, paddingHorizontal: space.lg, marginTop: space.sm },
});

const m = StyleSheet.create({
  card: { marginHorizontal: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  map: { height: 150, backgroundColor: '#DDE6E8' },
  pin: { position: 'absolute', width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: color.paper },
  cityLabel: { position: 'absolute', top: '44%', left: '38%', backgroundColor: 'rgba(255,255,255,0.7)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  cityText: { ...t.small, color: color.ink, fontWeight: '700', fontSize: 11 },
  legend: { flexDirection: 'row', gap: space.lg, padding: space.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { ...t.small, color: color.mute, fontSize: 12 },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingBottom: space.md },
  note: { ...t.small, color: color.mute, fontSize: 11 },
});

const sf = StyleSheet.create({
  card: { marginHorizontal: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.md, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#E3F1EA', alignItems: 'center', justifyContent: 'center' },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  sub: { ...t.small, color: color.mute, marginTop: 1 },
  btns: { flexDirection: 'row', gap: space.sm },
  btn: { flex: 1, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.sm, alignItems: 'center' },
  btnText: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  note: { ...t.small, color: color.mute, fontSize: 11 },
});

const tp = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg },
  tile: { width: 140, gap: 6 },
  media: { height: 100, borderRadius: radius.sm, backgroundColor: color.deep },
  caption: { ...t.small, color: color.ink, fontSize: 12 },
  addTile: { width: 140, height: 130, borderRadius: radius.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.signal, alignItems: 'center', justifyContent: 'center', gap: 6 },
  addText: { ...t.small, fontWeight: '700', color: color.signal },
});
