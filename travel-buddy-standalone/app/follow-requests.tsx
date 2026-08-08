import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet,
  ActivityIndicator, Alert,
} from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { UserCheck } from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { Avatar } from '../src/components/ui/Avatar';
import { color, space, radius, type as t } from '../src/theme/tokens';
import {
  getMyFollowRequests,
  respondToFollowRequest,
} from '../src/services/follows';
import type { FollowRequest } from '../src/services/follows';
import { useNavBarScrollHandler, NavBarFiller } from '../src/hooks/useNavBarCollapse';

export default function FollowRequestsScreen() {
  const [requests, setRequests] = useState<FollowRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [responding, setResponding] = useState<string | null>(null);
  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMyFollowRequests();
    if (res.ok && res.data) setRequests(res.data);
    else setRequests([]);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function handleRespond(requester: FollowRequest, action: 'accept' | 'decline') {
    setResponding(requester.requestId);
    const res = await respondToFollowRequest(requester.requestId, action);
    setResponding(null);
    if (!res.ok) {
      Alert.alert('Error', `Could not ${action} request. Please try again.`);
      return;
    }
    // Remove the handled request from the list
    setRequests((prev) => prev.filter((r) => r.requestId !== requester.requestId));
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <AppHeader variant="detail" title="Follow Requests" onBack={router.back} />
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : requests.length === 0 ? (
        <View style={s.center}>
          <UserCheck size={32} color={color.haze} />
          <Text style={s.empty}>No pending requests</Text>
          <Text style={s.emptySub}>When someone requests to follow you, they'll appear here.</Text>
        </View>
      ) : (
        <FlatList
          data={requests}
          keyExtractor={(r) => r.requestId}
          contentContainerStyle={{ padding: space.lg, gap: space.sm }}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListFooterComponent={<NavBarFiller />}
          renderItem={({ item }) => {
            const isResponding = responding === item.requestId;
            return (
              <View style={s.row}>
                <Pressable
                  style={s.userInfo}
                  onPress={() => {
                    if (item.handle) router.push(`/u/${item.handle}` as any);
                  }}
                >
                  <Avatar
                    uri={item.avatarUrl}
                    name={item.name ?? item.handle}
                    size={44}
                    style={s.avatarBox}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={s.name} numberOfLines={1}>
                      {item.name ?? item.handle ?? 'Unknown'}
                    </Text>
                    {item.handle ? (
                      <Text style={s.handle} numberOfLines={1}>@{item.handle}</Text>
                    ) : null}
                  </View>
                </Pressable>
                <View style={s.actions}>
                  <Pressable
                    style={[s.btn, s.acceptBtn, isResponding && s.btnDisabled]}
                    onPress={() => handleRespond(item, 'accept')}
                    disabled={isResponding}
                    accessibilityLabel={`Accept follow request from ${item.handle ?? item.name}`}
                  >
                    {isResponding ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={s.acceptText}>Accept</Text>
                    )}
                  </Pressable>
                  <Pressable
                    style={[s.btn, s.declineBtn, isResponding && s.btnDisabled]}
                    onPress={() => handleRespond(item, 'decline')}
                    disabled={isResponding}
                    accessibilityLabel={`Decline follow request from ${item.handle ?? item.name}`}
                  >
                    <Text style={s.declineText}>Decline</Text>
                  </Pressable>
                </View>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingHorizontal: space.xl },
  empty: { ...t.body, color: color.mute, fontWeight: '600', textAlign: 'center' },
  emptySub: { ...t.small, color: color.faint, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
  },
  userInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minWidth: 0,
  },
  // Sizing/shape now come from <Avatar size>; this carries layout only.
  avatarBox: { flexShrink: 0 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  handle: { ...t.small, color: color.mute },
  actions: {
    flexDirection: 'row',
    gap: space.xs,
    flexShrink: 0,
  },
  btn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 68,
  },
  btnDisabled: { opacity: 0.5 },
  acceptBtn: { backgroundColor: color.signal },
  declineBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: color.haze,
  },
  acceptText: { ...t.small, color: '#fff', fontWeight: '600' },
  declineText: { ...t.small, color: color.mute, fontWeight: '600' },
});
