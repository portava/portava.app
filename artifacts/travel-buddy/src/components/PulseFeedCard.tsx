import React from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
  MapPin, Heart, MessageCircle, Bookmark, MoreHorizontal, HelpCircle, Users,
  Sparkles, Gem, Route, Info, Plus, ShieldCheck, Clock,
} from 'lucide-react-native';
import type { PulseFeedItem } from '../types/models';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens';
import { usePlanPicker } from './PlanPickerController';
import { TelegraphFeedbackMenu } from './TelegraphFeedbackMenu';
import { PostEngagementBar } from './PostEngagementBar';

/* shared bits */
function AuthorRow({ item, badge }: { item: PulseFeedItem; badge?: { label: string; bg: string; fg: string } }) {
  return (
    <View style={s.authorRow}>
      {item.author ? <Image source={{ uri: item.author.avatarUrl }} style={s.avatar} /> : null}
      <View style={{ flex: 1 }}>
        {badge ? <View style={[s.kindBadge, { backgroundColor: badge.bg }]}><Text style={[s.kindText, { color: badge.fg }]}>{badge.label}</Text></View> : null}
        {item.author ? <Text style={s.author}>{item.author.name}</Text> : null}
        <Text style={s.meta}>{item.timeAgo}{item.neighborhood ? ` · ${item.neighborhood}` : item.city ? ` · ${item.city}` : ''}</Text>
      </View>
      <Pressable hitSlop={layout.hitSlop}><MoreHorizontal size={18} color={color.faint} /></Pressable>
    </View>
  );
}

function TagRow({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <View style={s.tags}>
      {tags.map((tg) => <View key={tg} style={s.tag}><Text style={s.tagText}>{tg}</Text></View>)}
    </View>
  );
}

function FitBadge() {
  return <View style={s.fit}><Clock size={11} color={color.success} /><Text style={s.fitText}>Fits your time</Text></View>;
}

/* ── Traveler Post ── */
function PostCard({ item }: { item: PulseFeedItem }) {
  return (
    <View style={s.card}>
      <AuthorRow item={item} />
      {item.mediaUrl || true ? (
        <View style={s.media}>
          {item.mediaUrl ? <Image source={{ uri: item.mediaUrl }} style={StyleSheet.absoluteFill} /> : null}
          <View style={s.mediaTag}><Text style={s.mediaTagText}>POST</Text></View>
        </View>
      ) : null}
      {item.caption ? <Text style={s.caption}>{item.caption}</Text> : null}
      <TagRow tags={item.tags} />
      <PostEngagementBar
        postId={item.id}
        likeCount={item.likeCount ?? 0}
        commentCount={item.commentCount ?? 0}
        likedByMe={item.likedByMe ?? false}
        canLike={item.canLike !== false}
        canComment={item.canComment !== false}
        canShare={item.canShare !== false}
      />
    </View>
  );
}

/* ── Question ── */
function QuestionCard({ item }: { item: PulseFeedItem }) {
  return (
    <View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'QUESTION', bg: '#EFE7FA', fg: '#7A4DBF' }} />
      <Text style={s.question}>{item.question}</Text>
      <TagRow tags={item.tags} />
      <View style={s.actions}>
        <View style={s.action}><HelpCircle size={15} color={color.mute} /><Text style={s.actionText}>{item.replyCount ?? 0} answers</Text></View>
        <View style={{ flex: 1 }} />
        <Pressable style={s.outlineBtn} onPress={() => router.push('/(tabs)/ai')}><Text style={s.outlineText}>Answer</Text></Pressable>
      </View>
      {item.source === 'user' && (
        <PostEngagementBar
          postId={item.id}
          likeCount={item.likeCount ?? 0}
          commentCount={item.commentCount ?? 0}
          likedByMe={item.likedByMe ?? false}
          canLike={item.canLike !== false}
          canComment={item.canComment !== false}
          canShare={item.canShare !== false}
        />
      )}
    </View>
  );
}

/* ── Open Plan ── */
function PlanCard({ item }: { item: PulseFeedItem }) {
  const planPicker = usePlanPicker();
  return (
    <View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'OPEN PLAN', bg: '#E3F1EA', fg: color.success }} />
      <Text style={s.title}>{item.title}</Text>
      {item.time ? <View style={s.line}><Clock size={13} color={color.mute} /><Text style={s.lineText}>{item.time}</Text></View> : null}
      {item.neighborhood || item.city ? <View style={s.line}><MapPin size={13} color={color.mute} /><Text style={s.lineText}>{item.neighborhood ?? item.city}</Text></View> : null}
      {item.availabilityMatch ? <FitBadge /> : null}
      <TagRow tags={item.tags} />
      <View style={s.actions}>
        <Text style={s.going}>{item.attendeeCount ?? 0} going</Text>
        <View style={{ flex: 1 }} />
        <Pressable
          style={({ pressed }) => [s.outlineBtn, pressed && { opacity: 0.7 }]}
          onPress={() => planPicker.open({ id: item.id, type: 'meetup', title: item.title ?? 'Meetup', city: item.city })}
        >
          <Text style={s.outlineText}>Add to Plan</Text>
        </Pressable>
        <Pressable style={s.solidBtn} onPress={() => router.push('/(tabs)/trips')}><Text style={s.solidText}>Join Plan</Text></Pressable>
        <TelegraphFeedbackMenu recommendationId={item.id} category={item.type} />
      </View>
    </View>
  );
}

/* ── Hidden Gem Share ── */
function GemCard({ item }: { item: PulseFeedItem }) {
  const planPicker = usePlanPicker();
  return (
    <View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'HIDDEN GEM', bg: '#E3F1EA', fg: color.success }} />
      <View style={s.media}><View style={s.gemIcon}><Gem size={15} color={color.onInk} /></View></View>
      <Text style={s.title}>{item.title}</Text>
      {item.blurb ? <Text style={s.blurb}>{item.blurb}</Text> : null}
      <View style={s.actions}>
        <Pressable style={s.outlineBtn} onPress={() => planPicker.open({ id: item.id, type: 'hidden_gem', title: item.title ?? 'Hidden gem', city: item.city, category: 'Hidden Gem' })}><Text style={s.outlineText}>Add to Plan</Text></Pressable>
        <View style={{ flex: 1 }} />
        <Pressable hitSlop={layout.hitSlop}><Bookmark size={17} color={color.mute} /></Pressable>
        <TelegraphFeedbackMenu recommendationId={item.id} category={item.type} />
      </View>
    </View>
  );
}

/* ── Itinerary / Plan Idea ── */
function ItineraryCard({ item }: { item: PulseFeedItem }) {
  const planPicker = usePlanPicker();
  return (
    <View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'ITINERARY', bg: '#E2EDF0', fg: color.deep }} />
      <View style={s.titleRow}>
        <Route size={16} color={color.deep} />
        <Text style={[s.title, { flex: 1 }]}>{item.title}</Text>
        {item.estimate ? <Text style={s.estimate}>{item.estimate}</Text> : null}
      </View>
      {item.steps?.map((step, i) => (
        <View key={i} style={s.step}><Text style={s.stepN}>{i + 1}</Text><Text style={s.stepText}>{step}</Text></View>
      ))}
      <TagRow tags={item.tags} />
      <View style={s.actions}>
        <Pressable style={s.outlineBtn} onPress={() => planPicker.open({ id: item.id, type: 'experience', title: item.title ?? 'Itinerary', city: item.city, category: 'Itinerary' })}><Text style={s.outlineText}>Use this plan</Text></Pressable>
        <View style={{ flex: 1 }} />
        <Pressable hitSlop={layout.hitSlop}><Bookmark size={17} color={color.mute} /></Pressable>
      </View>
    </View>
  );
}

/* ── Circle Activity ── */
function CircleCard({ item }: { item: PulseFeedItem }) {
  return (
    <View style={[s.card, s.circleCard]}>
      <View style={s.circleHead}>
        <View style={s.circleBadge}><Users size={13} color={color.onInk} /></View>
        <Text style={s.circleLabel}>CIRCLE ACTIVITY</Text>
      </View>
      <Text style={s.circleText}>{item.activityText}</Text>
      <View style={s.circleRow}>
        <View style={{ flexDirection: 'row' }}>
          {(item.participants ?? []).slice(0, 4).map((p, i) => (
            <Image key={p.id} source={{ uri: p.avatarUrl }} style={[s.circleAvatar, { marginLeft: i === 0 ? 0 : -9, zIndex: 4 - i }]} />
          ))}
        </View>
        <View style={{ flex: 1 }} />
        <Pressable style={s.outlineBtn} onPress={() => router.push('/circle')}><Text style={s.outlineText}>See Circle</Text></Pressable>
      </View>
    </View>
  );
}

/* ── Compass Suggestion (stub-real: only with explicit reason) ── */
function CompassCard({ item }: { item: PulseFeedItem }) {
  const planPicker = usePlanPicker();
  return (
    <View style={[s.card, s.compassCard]}>
      <View style={s.compassHead}>
        <View style={s.compassBadge}><Sparkles size={13} color={color.onInk} /></View>
        <Text style={s.compassLabel}>COMPASS SUGGESTION</Text>
      </View>
      <Text style={s.title}>{item.title}</Text>
      {item.reason ? <View style={s.reasonRow}><Info size={13} color={color.deep} /><Text style={s.reason}>{item.reason}</Text></View> : null}
      {item.isProvisional ? <Text style={s.prov}>Based on starter city notes — provisional</Text> : null}
      <View style={s.actions}>
        <Pressable style={s.outlineBtn} onPress={() => router.push('/(tabs)/ai')}><Text style={s.outlineText}>View Details</Text></Pressable>
        <View style={{ flex: 1 }} />
        <Pressable style={s.solidBtn} onPress={() => planPicker.open({ id: item.id, type: 'compass_suggestion', title: item.title ?? 'Compass pick', city: item.city, category: 'Compass' })}><Plus size={14} color={color.onInk} /><Text style={s.solidText}>Add to Plan</Text></Pressable>
      </View>
    </View>
  );
}

/* ── City Note (provisional) ── */
function CityNoteCard({ item }: { item: PulseFeedItem }) {
  return (
    <View style={[s.card, s.noteCard]}>
      <View style={s.noteHead}><Text style={s.noteLabel}>STARTER CITY NOTE</Text></View>
      <Text style={s.title}>{item.title}</Text>
      {item.blurb ? <Text style={s.blurb}>{item.blurb}</Text> : null}
      <View style={s.provRow}><Info size={11} color={color.mute} /><Text style={s.provInline}>Provisional — not verified</Text></View>
    </View>
  );
}

/* ── Safety (only renders when item present) ── */
function SafetyCard({ item }: { item: PulseFeedItem }) {
  return (
    <View style={[s.card, s.safetyCard]}>
      <View style={s.safetyHead}><ShieldCheck size={16} color={color.success} /><Text style={s.safetyLabel}>HEADS-UP</Text></View>
      <Text style={s.blurb}>{item.blurb}</Text>
    </View>
  );
}

/* ── Unified renderer: switch on type ── */
export function PulseFeedCard({ item }: { item: PulseFeedItem }) {
  switch (item.type) {
    case 'post': return <PostCard item={item} />;
    case 'question': return <QuestionCard item={item} />;
    case 'plan': return <PlanCard item={item} />;
    case 'hidden_gem': return <GemCard item={item} />;
    case 'itinerary': return <ItineraryCard item={item} />;
    case 'circle_activity': return <CircleCard item={item} />;
    case 'compass_suggestion': return item.reason ? <CompassCard item={item} /> : null; // stub: only with real reason
    case 'city_note': return item.isProvisional ? <CityNoteCard item={item} /> : null;  // stub: only provisional-labeled
    case 'safety': return item.blurb ? <SafetyCard item={item} /> : null;               // stub: only when condition exists
    default: return null;
  }
}

const s = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm, ...shadow.card },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.haze },
  author: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  meta: { ...t.small, color: color.faint, fontSize: 11 },
  kindBadge: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm, marginBottom: 3 },
  kindText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },

  media: { height: 150, borderRadius: radius.sm, backgroundColor: color.deep, overflow: 'hidden', justifyContent: 'flex-start', padding: space.sm },
  mediaTag: { alignSelf: 'flex-start', backgroundColor: 'rgba(17,17,15,0.5)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm },
  mediaTagText: { ...t.stamp, color: color.onInk, fontFamily: 'Courier' },
  gemIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: color.success, alignItems: 'center', justifyContent: 'center' },

  caption: { ...t.body, color: color.ink },
  question: { ...t.heading, color: color.ink, fontSize: 17 },
  title: { ...t.heading, color: color.ink, fontSize: 16 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  estimate: { ...t.small, color: color.mute, fontFamily: 'Courier' },
  blurb: { ...t.small, color: color.mute },
  line: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  lineText: { ...t.small, color: color.mute },

  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 3 },
  tagText: { ...t.small, color: color.ink, fontWeight: '600', fontSize: 11 },

  fit: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', backgroundColor: '#E3F1EA', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  fitText: { ...t.small, color: color.success, fontWeight: '700', fontSize: 11 },

  actions: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 2 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionText: { ...t.small, color: color.mute, fontWeight: '600' },
  going: { ...t.small, color: color.mute },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 6 },
  outlineText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
  solidBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.signal, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 6 },
  solidText: { ...t.small, fontWeight: '800', color: color.onInk, fontSize: 12 },

  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  stepN: { fontFamily: 'Courier', fontSize: 11, fontWeight: '700', color: color.deep, width: 16 },
  stepText: { ...t.small, color: color.ink, flex: 1 },

  circleCard: { backgroundColor: '#F3F0FB', borderColor: '#E0D6F5' },
  circleHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  circleBadge: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#7A4DBF', alignItems: 'center', justifyContent: 'center' },
  circleLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: '#7A4DBF', letterSpacing: 1 },
  circleText: { ...t.bodyStrong, color: color.ink },
  circleRow: { flexDirection: 'row', alignItems: 'center' },
  circleAvatar: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: '#F3F0FB', backgroundColor: color.haze },

  compassCard: { borderColor: color.deep, borderWidth: 1.5 },
  compassHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  compassBadge: { width: 22, height: 22, borderRadius: 11, backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  compassLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.deep, letterSpacing: 1 },
  reasonRow: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#E2EDF0', alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  reason: { ...t.small, color: color.deep, fontSize: 11 },
  prov: { ...t.small, color: color.faint, fontStyle: 'italic', fontSize: 11 },

  noteCard: { backgroundColor: color.paper, borderStyle: 'dashed' },
  noteHead: {},
  noteLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 1 },
  provRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  provInline: { ...t.small, color: color.mute, fontSize: 10, fontStyle: 'italic' },

  safetyCard: { backgroundColor: '#FBF6EC', borderColor: '#EAD9B5' },
  safetyHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  safetyLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.warn, letterSpacing: 1 },
});
