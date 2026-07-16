import React, { useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { ShieldCheck, Lock, ChevronRight } from 'lucide-react-native';
import type { TrustValue, TravelStats, Plan, Perk, User } from '../types/models';
import { Stamp } from './ui';
import { color, space, radius, type as t } from '../theme/tokens';

const TIER_LABEL: Record<TrustValue['tier'], string> = {
  new: 'New Traveler', rising: 'Rising', trusted: 'Trusted', pillar: 'Community Pillar',
};

/* Small Trust credibility chip — sits beside the name in the header. */
export function TrustChip({ score }: { score: number }) {
  return (
    <View style={styles.trustChip}>
      <ShieldCheck size={12} color={color.success} />
      <Text style={styles.trustChipText}>Trust {score}</Text>
    </View>
  );
}

/* Compact 4-stat row for the header area. */
export function CompactStats({ stats }: { stats: TravelStats }) {
  const items = [
    { n: stats.citiesVisited, label: 'Cities' },
    { n: stats.plansJoined, label: 'Plans' },
    { n: stats.buddies, label: 'Buddies' },
    { n: stats.stamps, label: 'Stamps' },
  ];
  return (
    <View style={styles.compactWrap}>
      {items.map((it, i) => (
        <React.Fragment key={it.label}>
          {i > 0 && <View style={styles.compactDivider} />}
          <View style={styles.compactCell}>
            <Text style={styles.compactN}>{it.n >= 1000 ? (it.n / 1000).toFixed(1) + 'k' : it.n}</Text>
            <Text style={styles.compactL}>{it.label}</Text>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

/* Compact one-line trust row — denser than the full card. */
export function TrustRow({ trust }: { trust: TrustValue }) {
  return (
    <View style={styles.trustRow}>
      <ShieldCheck size={16} color={color.success} />
      <Text style={styles.trustRowTier}>{TIER_LABEL[trust.tier]}</Text>
      <View style={styles.trustRowBar}>
        <View style={[styles.trustRowFill, { width: `${trust.score}%` }]} />
      </View>
      <Text style={styles.trustRowScore}>{trust.score}</Text>
    </View>
  );
}

/* Compact buddy preview — avatars + count, "View Circle". */
export function BuddyPreview({ buddies }: { buddies: User[] }) {
  const shown = buddies.slice(0, 5);
  return (
    <View style={styles.buddyPrev}>
      <View style={styles.buddyStack}>
        {shown.map((u, i) => (
          <Pressable
            key={u.id}
            onPress={() => router.push(`/profile/${u.handle}`)}
            style={[styles.buddyStackAvatar, { marginLeft: i === 0 ? 0 : -12, zIndex: shown.length - i }]}
          >
            <Image source={{ uri: u.avatarUrl }} style={styles.buddyStackImg} />
          </Pressable>
        ))}
      </View>
      <Text style={styles.buddyPrevText}>{buddies.length} buddies</Text>
      <View style={{ flex: 1 }} />
      <Pressable style={styles.findBtn} onPress={() => router.push('/(tabs)/discovery')}>
        <Text style={styles.findBtnText}>Find buddies</Text>
      </Pressable>
    </View>
  );
}

function PostcardMediaImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <View style={[styles.pcMedia, { backgroundColor: '#E5E7EB' }]} />;
  return <Image source={{ uri: url }} style={styles.pcMedia} onError={() => setFailed(true)} />;
}

/* Postcards/Posts tab — user's posted content with media, caption, location, date. */
export function PostcardList({ posts }: { posts: import('../types/models').Post[] }) {
  if (posts.length === 0) {
    return (
      <View style={styles.pcEmpty}>
        <Text style={styles.pcEmptyTitle}>No postcards yet</Text>
        <Text style={styles.pcEmptySub}>Share a moment from your travels and it’ll show up here.</Text>
      </View>
    );
  }
  return (
    <View style={{ gap: space.md }}>
      {posts.map((p) => (
        <Pressable key={p.id} style={styles.pc} onPress={() => router.push(`/post/${p.id}`)}>
          {p.media[0] ? (
            <PostcardMediaImage url={p.media[0].url} />
          ) : null}
          <View style={styles.pcBody}>
            <View style={styles.pcMetaRow}>
              <Stamp label={p.destination.city} tone="deep" />
              <Text style={styles.pcDate}>{new Date(p.createdAt).toLocaleDateString()}</Text>
            </View>
            {(p.title || p.caption) ? (
              <Text style={styles.pcCaption} numberOfLines={3}>{p.title ?? p.caption}</Text>
            ) : null}
            <Text style={styles.pcEngage}>{p.likeCount} likes · {p.commentCount} comments</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/* Section wrapper — consistent header + optional action, used by all below. */
export function PassportSection({
  title, action, onAction, children,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action ? (
          <Pressable onPress={onAction} hitSlop={8} style={styles.sectionAction}>
            <Text style={styles.sectionActionText}>{action}</Text>
            <ChevronRight size={14} color={color.mute} />
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/* Travel stats — extends the original 3-stat row to the full six. */
export function StatsRow({ stats, trustScore }: { stats: TravelStats; trustScore: number }) {
  const items = [
    { n: stats.citiesVisited, label: 'cities' },
    { n: stats.plansJoined, label: 'plans' },
    { n: stats.buddies, label: 'buddies' },
    { n: stats.stamps, label: 'stamps' },
    { n: trustScore, label: 'trust' },
    { n: stats.hostedPlans, label: 'hosted' },
  ];
  return (
    <View style={styles.statsWrap}>
      {items.map((it) => (
        <View key={it.label} style={styles.statCell}>
          <Text style={styles.statN}>{it.n >= 1000 ? (it.n / 1000).toFixed(1) + 'k' : it.n}</Text>
          <Text style={styles.statL}>{it.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function TrustValueCard({ trust }: { trust: TrustValue }) {
  return (
    <View style={styles.trust}>
      <View style={styles.trustTop}>
        <ShieldCheck size={20} color={color.success} />
        <Text style={styles.trustTier}>{TIER_LABEL[trust.tier]}</Text>
        <View style={{ flex: 1 }} />
        <Text style={styles.trustScore}>{trust.score}</Text>
        <Text style={styles.trustOf}>/100</Text>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${trust.score}%` }]} />
      </View>
      <View style={styles.trustMeta}>
        {trust.verifiedId && <Stamp label="ID verified" tone="deep" />}
        <Stamp label={`${trust.completedPlans} plans done`} rotate={2} />
        <Stamp label={`${trust.safeMeetups} safe meetups`} tone="signal" rotate={-2} />
      </View>
    </View>
  );
}

export function PlanRow({ plans }: { plans: Plan[] }) {
  return (
    <View style={{ gap: space.sm }}>
      {plans.map((p) => (
        <Pressable key={p.id} style={styles.planRow} onPress={() => router.push('/(tabs)/trips')}>
          <View style={styles.planDot} />
          <View style={{ flex: 1 }}>
            <Text style={styles.planTitle} numberOfLines={1}>{p.title}</Text>
            <Text style={styles.planMeta}>{p.destination.city} · {p.attendeeCount}/{p.capacity} going</Text>
          </View>
          <Stamp label={p.status.replace('_', ' ')} tone={p.status === 'joined' ? 'signal' : 'deep'} rotate={0} />
        </Pressable>
      ))}
    </View>
  );
}

export function BuddyRow({ buddies }: { buddies: User[] }) {
  return (
    <View style={styles.buddyRow}>
      {buddies.slice(0, 6).map((u) => (
        <Pressable key={u.id} onPress={() => router.push(`/profile/${u.handle}`)} style={styles.buddy}>
          <Image source={{ uri: u.avatarUrl }} style={styles.buddyAvatar} />
          <Text style={styles.buddyName} numberOfLines={1}>{u.name.split(' ')[0]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function PerksRow({ perks }: { perks: Perk[] }) {
  return (
    <View style={{ gap: space.sm }}>
      {perks.map((pk) => (
        <View key={pk.id} style={[styles.perk, !pk.unlocked && styles.perkLocked]}>
          {pk.unlocked ? <Ticket /> : <Lock size={16} color={color.faint} />}
          <View style={{ flex: 1 }}>
            <Text style={[styles.perkTitle, !pk.unlocked && { color: color.faint }]}>{pk.title}</Text>
            <Text style={styles.perkDetail}>{pk.unlocked ? pk.detail : pk.requirement}</Text>
          </View>
          {pk.unlocked ? <Stamp label="ready" tone="signal" /> : <Stamp label="locked" />}
        </View>
      ))}
    </View>
  );
}

function Ticket() {
  return <View style={styles.ticketDot} />;
}

const styles = StyleSheet.create({
  pc: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden' },
  pcMedia: { width: '100%', height: 180, backgroundColor: color.haze },
  pcBody: { padding: space.md, gap: space.sm },
  pcMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pcDate: { ...t.small, color: color.faint, fontFamily: 'Courier' },
  pcCaption: { ...t.body, color: color.ink },
  pcEngage: { ...t.small, color: color.mute },
  pcEmpty: { padding: space.xl, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.haze, alignItems: 'center', gap: 4 },
  pcEmptyTitle: { ...t.bodyStrong, color: color.ink },
  pcEmptySub: { ...t.small, color: color.mute, textAlign: 'center' },
  trustChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill,
  },
  trustChipText: { ...t.stamp, fontFamily: 'Courier', color: color.success },

  compactWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    paddingVertical: space.md, marginTop: space.md,
  },
  compactCell: { flex: 1, alignItems: 'center' },
  compactDivider: { width: 1, height: 24, backgroundColor: color.haze },
  compactN: { ...t.heading, color: color.ink },
  compactL: { ...t.small, color: color.mute, fontFamily: 'Courier', fontSize: 11 },

  trustRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: space.md,
  },
  trustRowTier: { ...t.bodyStrong, color: color.ink },
  trustRowBar: { flex: 1, height: 6, borderRadius: 3, backgroundColor: color.haze, overflow: 'hidden' },
  trustRowFill: { height: 6, borderRadius: 3, backgroundColor: color.success },
  trustRowScore: { ...t.bodyStrong, color: color.success },

  buddyPrev: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  buddyStack: { flexDirection: 'row' },
  buddyStackAvatar: { borderRadius: 18, borderWidth: 2, borderColor: color.paperRaised },
  buddyStackImg: { width: 34, height: 34, borderRadius: 17, backgroundColor: color.haze },
  buddyPrevText: { ...t.small, color: color.mute, fontWeight: '600' },
  findBtn: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: color.ink },
  findBtnText: { ...t.small, fontWeight: '700', color: color.onInk },

  section: { marginHorizontal: space.lg, marginTop: space.lg },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: space.sm },
  sectionTitle: { ...t.heading, color: color.ink },
  sectionAction: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  sectionActionText: { ...t.small, color: color.mute, fontWeight: '600' },

  statsWrap: {
    flexDirection: 'row', flexWrap: 'wrap',
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze,
    paddingVertical: space.lg,
  },
  statCell: { width: '33.33%', alignItems: 'center', paddingVertical: space.sm },
  statN: { ...t.title, color: color.ink },
  statL: { ...t.small, color: color.mute, fontFamily: 'Courier' },

  trust: {
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.md,
  },
  trustTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  trustTier: { ...t.bodyStrong, color: color.ink },
  trustScore: { ...t.title, color: color.success },
  trustOf: { ...t.small, color: color.mute },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: color.haze, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4, backgroundColor: color.success },
  trustMeta: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },

  planRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  planDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.signal },
  planTitle: { ...t.bodyStrong, color: color.ink },
  planMeta: { ...t.small, color: color.mute, marginTop: 2 },

  buddyRow: { flexDirection: 'row', gap: space.md },
  buddy: { alignItems: 'center', width: 56 },
  buddyAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: color.haze },
  buddyName: { ...t.small, color: color.ink, marginTop: 4 },

  perk: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  perkLocked: { backgroundColor: color.paper },
  perkTitle: { ...t.bodyStrong, color: color.ink },
  perkDetail: { ...t.small, color: color.mute, marginTop: 2 },
  ticketDot: { width: 16, height: 16, borderRadius: 4, backgroundColor: color.signal },
});
