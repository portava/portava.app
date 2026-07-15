import React, { useState } from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import Svg, { Path, Circle as SvgCircle } from 'react-native-svg';
import {
  CalendarDays, User as UserIcon, Clock, MapPin, CheckCircle2, Circle as CircleIcon,
  CalendarPlus, UserPlus, Sparkles, Settings, Bookmark, Plus, ChevronRight, Plane,
} from 'lucide-react-native';
import type { TripDetail, SavedIdea, TimelineDay } from '../types/models';
import { color, space, radius, type as t, shadow } from '../theme/tokens';
import { useAttach } from './AttachController';
import { useAttachments } from '../context/AttachmentStore';
import { mockTripDetail } from '../data/tripDetail';

/* ── Progress ring (semicircle arc) ── */
function ProgressRing({ pct }: { pct: number }) {
  const r = 46, cx = 60, cy = 60;
  // semicircle from 180° to 0°, filled by pct
  const start = Math.PI; // 180deg
  const end = Math.PI - (pct / 100) * Math.PI;
  const x1 = cx + r * Math.cos(start), y1 = cy - r * Math.sin(start);
  const x2 = cx + r * Math.cos(end), y2 = cy - r * Math.sin(end);
  const bgX = cx + r * Math.cos(0), bgY = cy - r * Math.sin(0);
  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={120} height={70} viewBox="0 0 120 70">
        <Path d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${bgX} ${bgY}`} stroke={color.haze} strokeWidth="9" fill="none" strokeLinecap="round" />
        <Path d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`} stroke={color.signal} strokeWidth="9" fill="none" strokeLinecap="round" />
      </Svg>
      <Text style={ring.pct}>{pct}%</Text>
    </View>
  );
}

/* ── Trip hero header ── */
export function TripHero({ trip }: { trip: TripDetail }) {
  const dates = `${fmt(trip.startDate)} – ${fmt(trip.endDate)}, ${new Date(trip.endDate).getFullYear()}`;
  return (
    <View style={hero.wrap}>
      {/* image card with overlaid identity */}
      <View style={hero.imageCard}>
        <View style={hero.imageBg}>
          {/* passport stamp motif corner */}
          <View style={hero.stampMark}><Plane size={16} color={color.onInk} /><Text style={hero.stampText}>CEBU</Text></View>
        </View>
        <View style={hero.identity}>
          <View style={hero.titleRow}>
            <Text style={hero.title}>{trip.title}</Text>
            <View style={hero.activeChip}><Text style={hero.activeText}>{cap(trip.status)}</Text></View>
          </View>
          <Text style={hero.dest}>{trip.destinationCity}, {trip.destinationCountry}</Text>
          <View style={hero.metaRow}><CalendarDays size={14} color={color.onInk} /><Text style={hero.meta}>{dates} ({trip.nights} nights)</Text></View>
          <View style={hero.metaRow}>
            <UserIcon size={14} color={color.onInk} />
            <Text style={hero.meta}>{trip.travelStyle} · {trip.openToMeet ? 'Open to Meet' : 'Private'}</Text>
            {trip.openToMeet && <View style={hero.openChip}><Text style={hero.openText}>Open</Text></View>}
          </View>
          {trip.availabilityLabel ? (
            <View style={hero.availChip}><Clock size={13} color={color.onInk} /><Text style={hero.availText}>{trip.availabilityLabel}</Text></View>
          ) : null}
        </View>
      </View>

      {/* quick actions */}
      <View style={hero.actions}>
        <Action icon={<CalendarPlus size={18} color={color.signal} />} label="Add Plan" onPress={() => router.push('/create')} />
        <Action icon={<UserPlus size={18} color={color.ink} />} label="Invite Buddy" onPress={() => router.push('/circle')} />
        <Action icon={<Sparkles size={18} color={color.signal} />} label="Ask Compass" onPress={() => router.push('/(tabs)/ai')} />
        <Action icon={<Settings size={18} color={color.ink} />} label="Trip Settings" onPress={() => router.push('/settings')} />
      </View>

      {/* progress card */}
      <View style={hero.progressCard}>
        <Text style={hero.progressTitle}>Trip Progress</Text>
        <ProgressRing pct={trip.progress} />
        <Text style={hero.progressSub}>Your trip is coming together!</Text>
        <View style={{ gap: space.sm, marginTop: space.md, alignSelf: 'stretch' }}>
          {trip.progressSteps.map((s) => (
            <View key={s.label} style={hero.stepRow}>
              {s.done ? <CheckCircle2 size={18} color={color.success} /> : <CircleIcon size={18} color={color.faint} />}
              <Text style={[hero.stepText, s.done && hero.stepDone]}>{s.label}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function Action({ icon, label, onPress }: { icon: React.ReactNode; label: string; onPress: () => void }) {
  return (
    <Pressable style={hero.action} onPress={onPress}>
      {icon}
      <Text style={hero.actionText}>{label}</Text>
    </Pressable>
  );
}

/* ── Today / Next Up ── */
export function TodayNextUp({ nextUp }: { nextUp: any | null }) {
  return (
    <View style={section.wrap}>
      <SectionHead title="Today / Next Up" onViewAll={nextUp ? () => router.push('/(tabs)/trips') : undefined} />
      {!nextUp ? (
        <View style={nx.empty}>
          <Text style={nx.emptyText}>Nothing planned yet. Add a plan or ask Compass to build your first night.</Text>
          <Pressable style={nx.emptyBtn} onPress={() => router.push('/(tabs)/ai')}><Text style={nx.emptyBtnText}>Ask Compass</Text></Pressable>
        </View>
      ) : (
        <View style={nx.card}>
          <View style={nx.media} />
          <View style={nx.body}>
            <View style={nx.badgeRow}>
              <View style={nx.badge}><Text style={nx.badgeText}>{nextUp.badge}</Text></View>
              <Text style={nx.time}>{nextUp.time}</Text>
            </View>
            <Text style={nx.title}>{nextUp.title}</Text>
            <View style={nx.metaRow}><MapPin size={13} color={color.mute} /><Text style={nx.meta}>{nextUp.place}</Text></View>
            <View style={nx.hostRow}>
              <Image source={{ uri: nextUp.host.avatarUrl }} style={nx.hostAvatar} />
              <Text style={nx.host}>Hosted by {nextUp.host.name.split(' ')[0]}</Text>
            </View>
            <View style={nx.attRow}>
              <AvatarRow people={nextUp.attendees} />
              <Text style={nx.going}>{nextUp.attendeeCount} going</Text>
            </View>
            <View style={nx.btns}>
              <Pressable style={nx.primary} onPress={() => router.push('/(tabs)/trips')}><Text style={nx.primaryText}>View Plan</Text></Pressable>
              <Pressable style={nx.ghost} onPress={() => router.push('/messages')}><Text style={nx.ghostText}>Message Group</Text></Pressable>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

function AvatarRow({ people }: { people: any[] }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      {people.slice(0, 4).map((u, i) => (
        <Image key={u.id} source={{ uri: u.avatarUrl }} style={[nx.attAvatar, { marginLeft: i === 0 ? 0 : -9, zIndex: 4 - i }]} />
      ))}
    </View>
  );
}

/* ── Trip Timeline ── */
export function TripTimeline({ days }: { days: TimelineDay[] }) {
  const [active, setActive] = useState(0);
  const day = days[active] ?? days[0];
  return (
    <View style={section.wrap}>
      <SectionHead title="Trip Timeline" />
      {/* day tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={tl.dayRow}>
        {days.map((d, i) => (
          <Pressable key={d.iso} style={[tl.dayTab, i === active && tl.dayTabOn]} onPress={() => setActive(i)}>
            <Text style={[tl.dayLabel, i === active && tl.dayLabelOn]}>{d.dateLabel}</Text>
            <Text style={[tl.daySub, i === active && tl.dayLabelOn]}>{d.dateSub}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {/* items */}
      <View style={tl.items}>
        {day.items.length === 0 ? (
          <Text style={tl.empty}>No plans this day yet. Add one or ask Compass.</Text>
        ) : day.items.map((it) => (
          <View key={it.id} style={tl.item}>
            <View style={tl.timeCol}>
              <Text style={tl.itemTime}>{it.time}</Text>
              <View style={[tl.dot, it.kind === 'free' && tl.dotOpen]} />
            </View>
            <View style={[tl.itemCard, it.kind === 'free' && tl.itemFree]}>
              <Text style={tl.itemTitle}>{it.title}</Text>
              {it.place ? <Text style={tl.itemPlace}>{it.place}</Text> : null}
              {it.attendeeCount ? <Text style={tl.itemGoing}>{it.attendeeCount} going</Text> : null}
            </View>
          </View>
        ))}
      </View>
      <Pressable style={tl.viewFull} onPress={() => router.push('/(tabs)/trips')}>
        <Text style={tl.viewFullText}>View full itinerary</Text>
        <ChevronRight size={15} color={color.signal} />
      </Pressable>
    </View>
  );
}

/* ── Saved Ideas ── */
export function SavedIdeas({ ideas }: { ideas: SavedIdea[] }) {
  const attach = useAttach();
  const { listAttachmentsByTarget } = useAttachments();
  const CAT_TONE: Record<string, { bg: string; fg: string }> = {
    Food: { bg: '#FCE9E4', fg: color.signal },
    Nightlife: { bg: '#EFE7FA', fg: '#7A4DBF' },
    Nature: { bg: '#E3F1EA', fg: color.success },
    Beach: { bg: '#E2EDF0', fg: color.deep },
  };
  // session attachments added to this trip — shown alongside seed ideas (honest, in-memory)
  const added = listAttachmentsByTarget(mockTripDetail.id);
  const hasAny = ideas.length > 0 || added.length > 0;
  return (
    <View style={section.wrap}>
      <SectionHead title="Saved Ideas" onViewAll={hasAny ? () => router.push('/saved') : undefined} />
      {!hasAny ? (
        <View style={si.empty}><Text style={si.emptyText}>Save places from the Discovery Wall to build this trip.</Text></View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={si.strip}>
          {added.map((att) => (
            <View key={att.id} style={si.card}>
              <View style={si.media}>
                <View style={si.bookmark}><Bookmark size={15} color={color.onInk} fill={color.onInk} /></View>
              </View>
              <View style={si.body}>
                <Text style={si.name} numberOfLines={1}>{att.sourceTitle}</Text>
                <Text style={si.hood} numberOfLines={1}>{att.sourceCity ?? 'Added this session'}</Text>
                <View style={[si.cat, { backgroundColor: '#E3F1EA' }]}><Text style={[si.catText, { color: color.success }]}>Added</Text></View>
              </View>
            </View>
          ))}
          {ideas.map((idea) => {
            const tone = CAT_TONE[idea.category] ?? { bg: color.haze, fg: color.mute };
            return (
              <View key={idea.id} style={si.card}>
                <View style={si.media}>
                  <View style={si.bookmark}><Bookmark size={15} color={color.onInk} fill={color.onInk} /></View>
                </View>
                <View style={si.body}>
                  <Text style={si.name} numberOfLines={1}>{idea.name}</Text>
                  <Text style={si.hood} numberOfLines={1}>{idea.neighborhood}</Text>
                  <View style={[si.cat, { backgroundColor: tone.bg }]}><Text style={[si.catText, { color: tone.fg }]}>{idea.category}</Text></View>
                  <Pressable style={si.addBtn} onPress={() => attach.open({ id: idea.id, type: 'place', title: idea.name, city: idea.neighborhood, category: idea.category }, 'plan')}><Text style={si.addText}>Add to Plan</Text></Pressable>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

/* shared section header */
export function SectionHead({ title, onViewAll }: { title: string; onViewAll?: () => void }) {
  return (
    <View style={section.head}>
      <Text style={section.title}>{title}</Text>
      <View style={{ flex: 1 }} />
      {onViewAll && (
        <Pressable style={section.viewAll} onPress={onViewAll} hitSlop={6}>
          <Text style={section.viewAllText}>View all</Text>
          <ChevronRight size={15} color={color.signal} />
        </Pressable>
      )}
    </View>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

const ring = StyleSheet.create({
  pct: { ...t.hero, color: color.ink, fontSize: 28, marginTop: -18 },
});

const hero = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  imageCard: { borderRadius: radius.lg, overflow: 'hidden', backgroundColor: color.ink, ...shadow.card },
  imageBg: { height: 150, backgroundColor: color.deep, alignItems: 'flex-end', padding: space.md },
  stampMark: { alignItems: 'center', gap: 2, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)', borderRadius: radius.sm, padding: 6 },
  stampText: { fontFamily: 'Courier', fontSize: 9, color: color.onInk, fontWeight: '700', letterSpacing: 1 },
  identity: { padding: space.lg, gap: 5, backgroundColor: color.ink },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.hero, color: color.onInk, fontSize: 30 },
  activeChip: { backgroundColor: color.signal, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  activeText: { ...t.small, color: color.onInk, fontWeight: '800', fontSize: 11 },
  dest: { ...t.bodyStrong, color: color.onInk },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' },
  meta: { ...t.small, color: color.haze },
  openChip: { backgroundColor: color.success, paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  openText: { ...t.small, color: color.onInk, fontWeight: '700', fontSize: 10 },
  availChip: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.12)', paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, marginTop: space.sm },
  availText: { ...t.small, color: color.onInk, fontWeight: '600' },

  actions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  action: { flexGrow: 1, flexBasis: '47%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.md },
  actionText: { ...t.small, fontWeight: '700', color: color.ink },

  progressCard: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.lg, padding: space.lg, alignItems: 'center' },
  progressTitle: { ...t.title, color: color.ink, fontSize: 18, alignSelf: 'flex-start' },
  progressSub: { ...t.small, color: color.mute, fontWeight: '600', marginTop: 4 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stepText: { ...t.body, color: color.mute },
  stepDone: { color: color.ink },
});

const section = StyleSheet.create({
  wrap: { marginTop: space.lg },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, marginBottom: space.md },
  title: { ...t.title, color: color.ink, fontSize: 20 },
  viewAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  viewAllText: { ...t.small, color: color.signal, fontWeight: '700' },
});

const nx = StyleSheet.create({
  card: { flexDirection: 'row', marginHorizontal: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { width: 120, backgroundColor: color.deep },
  body: { flex: 1, padding: space.md, gap: 4 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  badge: { backgroundColor: '#EFE7FA', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  badgeText: { ...t.small, color: '#7A4DBF', fontWeight: '800', fontSize: 10 },
  time: { ...t.small, color: color.mute, fontFamily: 'Courier' },
  title: { ...t.heading, color: color.ink, fontSize: 16 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meta: { ...t.small, color: color.mute },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  hostAvatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: color.haze },
  host: { ...t.small, color: color.mute },
  attRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  attAvatar: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: color.paperRaised, backgroundColor: color.haze },
  going: { ...t.small, color: color.mute },
  btns: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  primary: { flex: 1, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.sm, alignItems: 'center' },
  primaryText: { ...t.small, fontWeight: '800', color: color.onInk },
  ghost: { flex: 1, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.md, paddingVertical: space.sm, alignItems: 'center' },
  ghostText: { ...t.small, fontWeight: '800', color: color.signal },
  empty: { marginHorizontal: space.lg, padding: space.lg, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.haze, gap: space.md, alignItems: 'flex-start' },
  emptyText: { ...t.body, color: color.mute },
  emptyBtn: { backgroundColor: color.signal, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  emptyBtnText: { ...t.small, fontWeight: '800', color: color.onInk },
});

const tl = StyleSheet.create({
  dayRow: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  dayTab: { alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, minWidth: 56 },
  dayTabOn: { backgroundColor: color.signal, borderColor: color.signal },
  dayLabel: { ...t.small, fontWeight: '800', color: color.ink, fontSize: 11 },
  daySub: { ...t.small, color: color.mute, fontSize: 11 },
  dayLabelOn: { color: color.onInk },
  items: { paddingHorizontal: space.lg, gap: space.md },
  item: { flexDirection: 'row', gap: space.md },
  timeCol: { width: 56, alignItems: 'flex-start' },
  itemTime: { ...t.small, color: color.mute, fontFamily: 'Courier', fontSize: 11 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.signal, marginTop: 4 },
  dotOpen: { backgroundColor: color.paper, borderWidth: 2, borderColor: color.faint },
  itemCard: { flex: 1, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: 2 },
  itemFree: { borderStyle: 'dashed', backgroundColor: color.paper },
  itemTitle: { ...t.bodyStrong, color: color.ink },
  itemPlace: { ...t.small, color: color.mute },
  itemGoing: { ...t.small, color: color.mute, marginTop: 2 },
  empty: { ...t.body, color: color.mute, paddingHorizontal: space.lg },
  viewFull: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, marginTop: space.md },
  viewFullText: { ...t.small, color: color.signal, fontWeight: '700' },
});

const si = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.sm },
  card: { width: 150, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { height: 100, backgroundColor: color.deep, alignItems: 'flex-end', padding: space.sm },
  bookmark: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(17,17,15,0.4)', alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.md, gap: 4 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  hood: { ...t.small, color: color.mute, fontSize: 11 },
  cat: { alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  catText: { ...t.small, fontWeight: '700', fontSize: 11 },
  addBtn: { borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingVertical: 6, alignItems: 'center', marginTop: 2 },
  addText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
  empty: { marginHorizontal: space.lg, padding: space.lg, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.haze },
  emptyText: { ...t.body, color: color.mute },
});
