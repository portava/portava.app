import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Image, Pressable, StyleSheet, ActivityIndicator, RefreshControl, Alert } from 'react-native';
import { router } from 'expo-router';
import { MessageSquare } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { getMyFollowing, getMyFollowers, type FollowUser } from '../src/services/follows';
import { openCircleChat } from '../src/services/messaging';
import { useSession } from '../src/context/SessionContext';
import { color, space, radius, type as t } from '../src/theme/tokens';

export default function Circle() {
  const [tab, setTab] = useState<'circle' | 'followers'>('circle');
  const [following, setFollowing] = useState<FollowUser[]>([]);
  const [followers, setFollowers] = useState<FollowUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const { userId } = useSession();

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    const [fwRes, frRes] = await Promise.all([getMyFollowing(), getMyFollowers()]);
    setFollowing(fwRes.data ?? []);
    setFollowers(frRes.data ?? []);
    if (isRefresh) setRefreshing(false); else setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const list = tab === 'circle' ? following : followers;

  async function handleOpenCircleChat() {
    if (!userId || chatLoading) return;
    setChatLoading(true);
    const res = await openCircleChat(userId);
    setChatLoading(false);
    if (res.ok && res.data) {
      const { threadId, title } = res.data;
      const params = new URLSearchParams({ title: title ?? 'My Circle', threadType: 'circle' });
      router.push(`/messages/${threadId}?${params.toString()}`);
    } else {
      Alert.alert('Chat unavailable', res.message ?? 'Could not open your circle chat.');
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Circle" back />
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
            : <MessageSquare size={16} color={color.onInk} />
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
  tabBar: { flexDirection: 'row', gap: space.sm, margin: space.lg, marginBottom: 0, padding: 4, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill },
  tab: { flex: 1, paddingVertical: space.sm, borderRadius: radius.pill, alignItems: 'center' },
  tabActive: { backgroundColor: color.ink },
  tabText: { ...t.bodyStrong, color: color.mute, fontSize: 13 },
  tabTextActive: { color: color.onInk },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  chatBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.md,
    marginBottom: 0,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  chatBannerText: { ...t.bodyStrong, color: color.onInk, flex: 1 },
  chatBannerSub: { ...t.small, color: color.onInk + 'BB', fontSize: 11 },

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
