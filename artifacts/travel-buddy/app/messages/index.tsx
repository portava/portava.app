import React, { useCallback } from 'react';
import { View, Text, FlatList, Image, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Zap, Users, Globe } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMyThreads } from '../../src/hooks/useMessaging';
import { useSession } from '../../src/context/SessionContext';
import { color, space, type as t } from '../../src/theme/tokens';
import type { ThreadSummary } from '../../src/services/messaging';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function navigateToThread(item: ThreadSummary) {
  const title = item.threadType !== 'direct'
    ? (item.title ?? '')
    : (item.otherMembers[0]?.name ?? '');
  const params = new URLSearchParams({ title, threadType: item.threadType });
  router.push(`/messages/${item.id}?${params.toString()}`);
}

function ThreadAvatar({ item }: { item: ThreadSummary }) {
  if (item.threadType === 'trip') {
    return (
      <View style={[styles.avatar, styles.groupAvatar, { backgroundColor: '#E8F4F8' }]}>
        <Globe size={22} color={color.deep} />
      </View>
    );
  }
  if (item.threadType === 'circle') {
    return (
      <View style={[styles.avatar, styles.groupAvatar, { backgroundColor: '#F0EDE8' }]}>
        <Users size={22} color={color.ink} />
      </View>
    );
  }
  const other = item.otherMembers[0];
  if (other?.avatarUrl) {
    return <Image source={{ uri: other.avatarUrl }} style={styles.avatar} />;
  }
  return (
    <View style={[styles.avatar, styles.avatarPlaceholder]}>
      <Text style={styles.avatarInitial}>
        {(other?.name?.[0] ?? '?').toUpperCase()}
      </Text>
    </View>
  );
}

export default function TelegraphInbox() {
  const insets = useSafeAreaInsets();
  const { isAuthed, userId } = useSession();
  const { data: threads, loading, error, reload } = useMyThreads();

  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  const groupThreads = threads.filter((t) => t.threadType !== 'direct');
  const dmThreads = threads.filter((t) => t.threadType === 'direct');

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <View style={styles.brandIcon}>
            <Zap size={14} color={color.onInk} fill={color.onInk} />
          </View>
          <Text style={styles.brandName}>Telegraph</Text>
        </View>
        <Text style={styles.brandSub}>Messages · Translations · Suggestions</Text>
      </View>

      {!isAuthed ? (
        <View style={styles.center}>
          <Text style={styles.empty}>Sign in to view your messages.</Text>
        </View>
      ) : loading ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : error ? (
        <View style={styles.center}><Text style={styles.empty}>{error}</Text></View>
      ) : threads.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No messages yet.</Text>
          <Text style={[styles.empty, { marginTop: space.sm }]}>
            Visit someone's profile to start a conversation.
          </Text>
        </View>
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: space.xxxl }}
          renderItem={({ item }) => {
            const isGroup = item.threadType !== 'direct';
            const displayName = isGroup
              ? (item.title ?? (item.threadType === 'trip' ? 'Trip Chat' : 'Circle Chat'))
              : (item.otherMembers[0]?.name ?? 'Unknown');
            const lmp = item.lastMessagePreview;
            const isMine = lmp?.senderId === userId;
            const previewText = lmp
              ? (isMine ? lmp.body : (lmp.displayBody ?? lmp.body))
              : '';
            const lastAt = lmp?.createdAt;

            return (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => navigateToThread(item)}
              >
                <ThreadAvatar item={item} />
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.nameRow}>
                    <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
                    {lastAt ? <Text style={styles.time}>{timeAgo(lastAt)}</Text> : null}
                  </View>
                  {previewText ? (
                    <Text style={styles.preview} numberOfLines={1}>{previewText}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListHeaderComponent={() => (
            <>
              {groupThreads.length > 0 && (
                <View style={styles.sectionLabel}>
                  <Text style={styles.sectionText}>GROUP CHATS</Text>
                </View>
              )}
            </>
          )}
          ListFooterComponent={() => (
            <>
              {dmThreads.length > 0 && (
                <View style={styles.sectionLabel}>
                  <Text style={styles.sectionText}>DIRECT MESSAGES</Text>
                </View>
              )}
            </>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  empty: { ...t.body, color: color.mute, textAlign: 'center' },

  header: {
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: 4,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  brandIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandName: { fontSize: 22, fontWeight: '800', color: color.ink, letterSpacing: -0.5 },
  brandSub: { ...t.small, color: color.mute, fontSize: 11, fontFamily: 'Courier', letterSpacing: 0.3 },

  sectionLabel: { paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.sm },
  sectionText: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, letterSpacing: 1 },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.xl, paddingVertical: space.md },
  rowPressed: { opacity: 0.6 },

  avatar: { width: 50, height: 50, borderRadius: 25, backgroundColor: color.haze, flexShrink: 0 },
  groupAvatar: { borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  avatarInitial: { ...t.bodyStrong, color: color.ink },

  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  name: { ...t.bodyStrong, color: color.ink, flex: 1 },
  time: { ...t.small, color: color.faint, fontSize: 11 },
  preview: { ...t.small, color: color.mute },

  sep: { height: 1, backgroundColor: color.haze, marginHorizontal: space.xl, opacity: 0.5 },
});
