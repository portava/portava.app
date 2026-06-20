import React, { useCallback } from 'react';
import { View, Text, FlatList, Image, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Zap } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMyThreads } from '../../src/hooks/useMessaging';
import { useSession } from '../../src/context/SessionContext';
import { color, space, type as t } from '../../src/theme/tokens';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function TelegraphInbox() {
  const insets = useSafeAreaInsets();
  const { isAuthed } = useSession();
  const { data: threads, loading, error, reload } = useMyThreads();

  useFocusEffect(useCallback(() => { reload(); }, [reload]));

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
            const other = item.otherMembers[0];
            const preview = item.lastMessagePreview?.body ?? '';
            const lastAt = item.lastMessagePreview?.createdAt;
            return (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => router.push(`/messages/${item.id}`)}
              >
                {other?.avatarUrl ? (
                  <Image source={{ uri: other.avatarUrl }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarPlaceholder]}>
                    <Text style={styles.avatarInitial}>
                      {(other?.name?.[0] ?? '?').toUpperCase()}
                    </Text>
                  </View>
                )}
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.nameRow}>
                    <Text style={styles.name} numberOfLines={1}>
                      {other?.name ?? 'Unknown'}
                    </Text>
                    {lastAt ? <Text style={styles.time}>{timeAgo(lastAt)}</Text> : null}
                  </View>
                  {preview ? (
                    <Text style={styles.preview} numberOfLines={1}>{preview}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListHeaderComponent={() => (
            <View style={styles.sectionLabel}>
              <Text style={styles.sectionText}>DIRECT MESSAGES</Text>
            </View>
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
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  avatarInitial: { ...t.bodyStrong, color: color.ink },

  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  name: { ...t.bodyStrong, color: color.ink, flex: 1 },
  time: { ...t.small, color: color.faint, fontSize: 11 },
  preview: { ...t.small, color: color.mute },

  sep: { height: 1, backgroundColor: color.haze, marginHorizontal: space.xl, opacity: 0.5 },
});
