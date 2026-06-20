import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Image, Pressable, StyleSheet, ActivityIndicator, RefreshControl, Alert } from 'react-native';
import { router } from 'expo-router';
import { MessageCircle, CalendarClock, ChevronDown, ChevronUp } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { getMyFollowing, getMyFollowers, type FollowUser } from '../src/services/follows';
import { openCircleChat } from '../src/services/messaging';
import { getCircleAvailability, type MemberAvailability } from '../src/services/availability';
import { useSession } from '../src/context/SessionContext';
import { color, space, radius, type as t } from '../src/theme/tokens';

const QUICK_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  free_now:      { bg: '#DCFCE7', fg: '#16A34A', label: '🟢 Free now' },
  free_tonight:  { bg: '#E0F2FE', fg: '#0369A1', label: '🌙 Tonight' },
  open_to_plans: { bg: '#FEF9C3', fg: '#A16207', label: '✨ Open' },
  busy:          { bg: '#FEE2E2', fg: '#DC2626', label: '🔴 Busy' },
};

const DAY_ORDER = ['mon','tue','wed','thu','fri','sat','sun'] as const;
const DAY_SHORT: Record<string, string> = { mon: 'M', tue: 'T', wed: 'W', thu: 'Th', fri: 'F', sat: 'Sa', sun: 'Su' };

function MemberAvailRow({ m }: { m: MemberAvailability }) {
  const q = m.quickStatus ? QUICK_STYLE[m.quickStatus.status] : null;
  return (
    <View style={av.row}>
      {m.avatarUrl ? (
        <Image source={{ uri: m.avatarUrl }} style={av.avatar} />
      ) : (
        <View style={[av.avatar, av.avatarFallback]}>
          <Text style={av.avatarInitial}>{((m.name ?? m.handle ?? '?')[0]).toUpperCase()}</Text>
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={av.name} numberOfLines={1}>{m.name ?? m.handle ?? 'Traveler'}</Text>
        {q ? (
          <View style={[av.chip, { backgroundColor: q.bg }]}>
            <Text style={[av.chipText, { color: q.fg }]}>{q.label}</Text>
          </View>
        ) : (
          <View style={av.daysRow}>
            {DAY_ORDER.map((d) => {
              const on = (m.weeklyDays[d]?.length ?? 0) > 0;
              return (
                <View key={d} style={[av.dayDot, on && av.dayDotOn]}>
                  <Text style={[av.dayLabel, on && av.dayLabelOn]}>{DAY_SHORT[d]}</Text>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </View>
  );
}
const av = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: color.haze },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  avatarInitial: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  chip: { alignSelf: 'flex-start', paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, marginTop: 3 },
  chipText: { fontSize: 11, fontWeight: '700' },
  daysRow: { flexDirection: 'row', gap: 2, marginTop: 4 },
  dayDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  dayDotOn: { backgroundColor: color.signal },
  dayLabel: { fontSize: 8, fontWeight: '700', color: color.mute },
  dayLabelOn: { color: color.onInk },
});

export default function Circle() {
  const { userId, isAuthed, configured } = useSession();
  const [tab, setTab] = useState<'circle' | 'followers'>('circle');
  const [following, setFollowing] = useState<FollowUser[]>([]);
  const [followers, setFollowers] = useState<FollowUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [avMembers, setAvMembers] = useState<MemberAvailability[]>([]);
  const [avExpanded, setAvExpanded] = useState(false);

  const live = configured && isAuthed;

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    const [fwRes, frRes] = await Promise.all([getMyFollowing(), getMyFollowers()]);
    setFollowing(fwRes.data ?? []);
    setFollowers(frRes.data ?? []);
    if (isRefresh) setRefreshing(false); else setLoading(false);
  }, []);

  // Load circle availability if authenticated
  useEffect(() => {
    if (live && userId) {
      getCircleAvailability(userId).then((res) => {
        if (res.ok && res.data) setAvMembers(res.data.members);
      });
    }
  }, [live, userId]);

  useEffect(() => { load(); }, [load]);

  const list = tab === 'circle' ? following : followers;

  async function handleOpenCircleChat() {
    if (!userId || chatLoading) return;
    setChatLoading(true);
    const res = await openCircleChat(userId);
    setChatLoading(false);
    if (res.ok && res.data) {
      const { threadId, title } = res.data;
      const params = new URLSearchParams({ title: title ?? 'My Circle', threadType: 'circle', contextId: userId ?? '' });
      router.push(`/messages/${threadId}?${params.toString()}`);
    } else {
      Alert.alert('Chat unavailable', res.message ?? 'Could not open your circle chat.');
    }
  }

  const freeCount = avMembers.filter((m) => m.quickStatus?.status === 'free_now').length;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Circle" back />

      {userId ? (
        <Pressable
          style={styles.chatBtn}
          onPress={() => router.push(`/circle-chat?ownerId=${userId}` as any)}
        >
          <View style={{ position: 'relative' }}>
            <MessageCircle size={15} color={color.onInk} />
            <View style={styles.unreadDot} />
          </View>
          <Text style={styles.chatBtnText}>Circle Chat</Text>
        </Pressable>
      ) : null}

      <View style={styles.tabBar}>
        <Pressable style={[styles.tab, tab === 'circle' && styles.tabActive]} onPress={() => setTab('circle')}>
          <Text style={[styles.tabText, tab === 'circle' && styles.tabTextActive]}>
            Following{following.length > 0 ? ` ${following.length}` : ''}
          </Text>
        </Pressable>
        <Pressable style={[styles.tab, tab === 'followers' && styles.tabActive]} onPress={() => setTab('followers')}>
          <Text style={[styles.tabText, tab === 'followers' && styles.tabTextActive]}>
            Followers{followers.length > 0 ? ` ${followers.length}` : ''}
          </Text>
        </Pressable>
      </View>

      {tab === 'circle' && userId && (
        <Pressable
          style={[styles.chatBanner, chatLoading && { opacity: 0.6 }]}
          onPress={handleOpenCircleChat}
          disabled={chatLoading}
        >
          {chatLoading
            ? <ActivityIndicator size="small" color={color.onInk} />
            : <MessageCircle size={16} color={color.onInk} />
          }
          <Text style={styles.chatBannerText}>Circle Group Chat</Text>
          <Text style={styles.chatBannerSub}>Message everyone in your circle</Text>
        </Pressable>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: space.lg, gap: space.md }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={color.signal} />}
        >
          {/* Availability section — shown when circle data loaded */}
          {live && avMembers.length > 0 && (
            <View style={styles.avSection}>
              <Pressable style={styles.avHead} onPress={() => setAvExpanded((v) => !v)}>
                <CalendarClock size={14} color={color.deep} />
                <Text style={styles.avTitle}>Circle Availability</Text>
                {freeCount > 0 && (
                  <View style={styles.avBadge}>
                    <Text style={styles.avBadgeText}>{freeCount} free now</Text>
                  </View>
                )}
                <View style={{ flex: 1 }} />
                {avExpanded ? <ChevronUp size={16} color={color.mute} /> : <ChevronDown size={16} color={color.mute} />}
              </Pressable>
              {avExpanded && (
                <View style={styles.avCard}>
                  {avMembers.map((m, i) => (
                    <View key={m.userId}>
                      {i > 0 && <View style={styles.avDivider} />}
                      <MemberAvailRow m={m} />
                    </View>
                  ))}
                  <Pressable style={styles.avEditBtn} onPress={() => router.push('/availability')}>
                    <Text style={styles.avEditBtnText}>Update my availability →</Text>
                  </Pressable>
                </View>
              )}
            </View>
          )}

          {list.map((u) => (
            <Pressable
              key={u.id}
              style={styles.row}
              onPress={() => u.handle ? router.push(`/u/${u.handle}`) : undefined}
            >
              {u.avatarUrl ? (
                <Image source={{ uri: u.avatarUrl }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarEmpty]}>
                  <Text style={{ fontSize: 22 }}>👤</Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{u.name ?? u.handle ?? 'Traveler'}</Text>
                {u.handle ? <Text style={styles.handle}>@{u.handle}</Text> : null}
              </View>
            </Pressable>
          ))}
          {list.length === 0 && (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyIcon}>{tab === 'circle' ? '🌍' : '👥'}</Text>
              <Text style={styles.emptyTitle}>
                {tab === 'circle' ? 'No one in your circle yet' : 'No followers yet'}
              </Text>
              <Text style={styles.emptyNote}>
                {tab === 'circle'
                  ? 'Find travelers and follow them to build your circle.'
                  : 'Share your passport and connect with other travelers.'}
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chatBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginHorizontal: space.lg, marginTop: space.md, paddingVertical: space.sm + 2, paddingHorizontal: space.lg, borderRadius: radius.pill, backgroundColor: color.signal },
  chatBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
  unreadDot: { position: 'absolute', top: -3, right: -3, width: 7, height: 7, borderRadius: 4, backgroundColor: color.onInk },
  tabBar: { flexDirection: 'row', gap: space.sm, margin: space.lg, marginBottom: 0, padding: 4, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill },
  tab: { flex: 1, paddingVertical: space.sm, borderRadius: radius.pill, alignItems: 'center' },
  tabActive: { backgroundColor: color.ink },
  tabText: { ...t.bodyStrong, color: color.mute, fontSize: 13 },
  tabTextActive: { color: color.onInk },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  chatBanner: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    marginHorizontal: space.lg, marginTop: space.md, marginBottom: 0,
    backgroundColor: color.signal, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.md,
  },
  chatBannerText: { ...t.bodyStrong, color: color.onInk, flex: 1 },
  chatBannerSub: { ...t.small, color: color.onInk + 'BB', fontSize: 11 },

  avSection: { borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, overflow: 'hidden' },
  avHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md },
  avTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  avBadge: { backgroundColor: '#FEF9C3', paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill },
  avBadgeText: { fontSize: 11, fontWeight: '700', color: '#A16207' },
  avCard: { borderTopWidth: 1, borderTopColor: color.haze, paddingHorizontal: space.md, paddingBottom: space.md },
  avDivider: { height: 1, backgroundColor: color.haze },
  avEditBtn: { alignSelf: 'flex-start', marginTop: space.sm },
  avEditBtnText: { ...t.small, color: color.signal, fontWeight: '700' },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: color.haze },
  avatarEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0EDE8' },
  name: { ...t.bodyStrong, color: color.ink },
  handle: { ...t.small, color: color.mute, marginTop: 2, fontFamily: 'Courier' },
  emptyBox: { alignItems: 'center', gap: space.sm, paddingVertical: space.xxl },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptyNote: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 18 },
});
