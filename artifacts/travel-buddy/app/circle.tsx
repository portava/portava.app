import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Image, Pressable, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { getMyFollowing, getMyFollowers, type FollowUser } from '../src/services/follows';
import { color, space, radius, type as t } from '../src/theme/tokens';

/** Circle page — Travel Circle (following) + Followers. */
export default function Circle() {
  const [tab, setTab] = useState<'circle' | 'followers'>('circle');
  const [following, setFollowing] = useState<FollowUser[]>([]);
  const [followers, setFollowers] = useState<FollowUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    const [fwRes, frRes] = await Promise.all([getMyFollowing(), getMyFollowers()]);
    setFollowing(fwRes.data ?? []);
    setFollowers(frRes.data ?? []);
    if (isRefresh) setRefreshing(false); else setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const list = tab === 'circle' ? following : followers;

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
