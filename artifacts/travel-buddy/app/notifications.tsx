import React, { useCallback } from 'react';
import { View, Text, Image, Pressable, StyleSheet, ActivityIndicator, SectionList } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, MessageCircle, UserPlus } from 'lucide-react-native';
import { useIncomingFriendRequests } from '../src/hooks/useFriends';
import { useIncomingMessageRequests } from '../src/hooks/useMessaging';
import { color, space, type as t } from '../src/theme/tokens';

type InboxRow = { type: 'message_request'; item: any } | { type: 'friend_request'; item: any };
type InboxSection = { title: string; data: InboxRow[] };

export default function Notifications() {
  const insets = useSafeAreaInsets();
  const friendReqs = useIncomingFriendRequests();
  const msgReqs = useIncomingMessageRequests();

  useFocusEffect(useCallback(() => {
    friendReqs.reload();
    msgReqs.reload();
  }, [friendReqs.reload, msgReqs.reload]));

  const loading = friendReqs.loading || msgReqs.loading;

  const sections: InboxSection[] = [
    ...(msgReqs.data.length > 0
      ? [{
          title: 'Message Requests',
          data: msgReqs.data.map((r): InboxRow => ({ type: 'message_request', item: r })),
        }]
      : []),
    ...(friendReqs.data.length > 0
      ? [{
          title: 'Friend Requests',
          data: friendReqs.data.map((r): InboxRow => ({ type: 'friend_request', item: r })),
        }]
      : []),
  ];

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={[styles.head, { paddingTop: insets.top + space.md }]}>
        <Text style={styles.title}>Inbox</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => router.back()} hitSlop={8}><X size={24} color={color.ink} /></Pressable>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : sections.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>All caught up! No pending requests.</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(row) => (row.item as any).requestId}
          contentContainerStyle={{ padding: space.lg, gap: space.md }}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          renderItem={({ item: row }) => {
            if (row.type === 'message_request') {
              const r = row.item as any;
              const sender = r.sender;
              return (
                <View style={styles.row}>
                  <View style={styles.iconBadge}>
                    <MessageCircle size={18} color={color.signal} />
                  </View>
                  {sender?.avatarUrl ? (
                    <Image source={{ uri: sender.avatarUrl }} style={styles.avatar} />
                  ) : (
                    <View style={[styles.avatar, styles.avatarPlaceholder]}>
                      <Text style={styles.avatarInitial}>{(sender?.name?.[0] ?? '?').toUpperCase()}</Text>
                    </View>
                  )}
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={styles.rowText}>
                      <Text style={{ fontWeight: '700' }}>{sender?.name ?? 'Someone'}</Text>
                      {' wants to message you'}
                    </Text>
                    {r.previewText ? (
                      <Text style={styles.preview} numberOfLines={2}>"{r.previewText}"</Text>
                    ) : null}
                    <View style={styles.actionsRow}>
                      <Pressable
                        style={styles.acceptBtn}
                        onPress={async () => { await msgReqs.accept(r.requestId); }}
                      >
                        <Text style={styles.acceptBtnText}>Accept</Text>
                      </Pressable>
                      <Pressable
                        style={styles.declineBtn}
                        onPress={async () => { await msgReqs.decline(r.requestId); }}
                      >
                        <Text style={styles.declineBtnText}>Decline</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              );
            }

            // friend_request
            const r = row.item as any;
            const sender = r.user;
            return (
              <View style={styles.row}>
                <View style={styles.iconBadge}>
                  <UserPlus size={18} color={color.deep} />
                </View>
                {sender?.avatarUrl ? (
                  <Image source={{ uri: sender.avatarUrl }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarPlaceholder]}>
                    <Text style={styles.avatarInitial}>{(sender?.name?.[0] ?? '?').toUpperCase()}</Text>
                  </View>
                )}
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.rowText}>
                    <Text style={{ fontWeight: '700' }}>{sender?.name ?? 'Someone'}</Text>
                    {' sent you a friend request'}
                  </Text>
                  <View style={styles.actionsRow}>
                    <Pressable
                      style={styles.acceptBtn}
                      onPress={async () => { await friendReqs.accept(r.requestId); }}
                    >
                      <Text style={styles.acceptBtnText}>Accept</Text>
                    </Pressable>
                    <Pressable
                      style={styles.declineBtn}
                      onPress={async () => { await friendReqs.decline(r.requestId); }}
                    >
                      <Text style={styles.declineBtnText}>Decline</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.lg, paddingBottom: space.lg,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  title: { ...t.title, color: color.ink },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  sectionHeader: { ...t.stamp, color: color.mute, letterSpacing: 1, marginBottom: space.sm, marginTop: space.sm },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: space.sm },
  iconBadge: { width: 32, height: 32, borderRadius: 16, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.haze, flexShrink: 0 },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  avatarInitial: { ...t.bodyStrong, color: color.ink },
  rowText: { ...t.body, color: color.ink, flex: 1 },
  preview: { ...t.small, color: color.mute, fontStyle: 'italic' },
  actionsRow: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  acceptBtn: { paddingVertical: 7, paddingHorizontal: space.lg, backgroundColor: color.signal, borderRadius: 999 },
  acceptBtnText: { ...t.stamp, color: '#fff' },
  declineBtn: { paddingVertical: 7, paddingHorizontal: space.lg, borderWidth: 1, borderColor: color.haze, borderRadius: 999 },
  declineBtnText: { ...t.stamp, color: color.mute },
});
