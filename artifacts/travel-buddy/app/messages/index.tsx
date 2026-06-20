/**
 * Telegraph Inbox — lists all conversations.
 * Renamed from "Messages" to "Telegraph" with the unified message +
 * AI recommendation layer branding.
 */
import React from 'react';
import { View, Text, FlatList, Image, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Zap } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { conversations, me } from '../../src/data/cebu';
import { color, space, radius, type as t } from '../../src/theme/tokens';

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

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <View style={styles.brandIcon}>
            <Zap size={14} color={color.onInk} fill={color.onInk} />
          </View>
          <Text style={styles.brandName}>Telegraph</Text>
        </View>
        <Text style={styles.brandSub}>Messages · Translations · Suggestions</Text>
      </View>

      <FlatList
        data={conversations}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ paddingBottom: space.xxxl }}
        renderItem={({ item }) => {
          const other = item.participants.find((p) => p.id !== me.id)!;
          const hasUnread = item.unread > 0;
          return (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => router.push(`/messages/${item.id}`)}
            >
              <View style={styles.avatarWrap}>
                <Image source={{ uri: other.avatarUrl }} style={styles.avatar} />
                {/* Online indicator could go here */}
              </View>

              <View style={{ flex: 1, gap: 2 }}>
                <View style={styles.nameRow}>
                  <Text style={[styles.name, hasUnread && styles.nameUnread]} numberOfLines={1}>
                    {other.name}
                  </Text>
                  <Text style={styles.time}>{timeAgo(item.lastAt)}</Text>
                </View>
                <View style={styles.previewRow}>
                  <Text
                    style={[styles.preview, hasUnread && styles.previewUnread]}
                    numberOfLines={1}
                  >
                    {item.lastMessage}
                  </Text>
                  {hasUnread && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{item.unread}</Text>
                    </View>
                  )}
                </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },

  header: {
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: 4,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  brandIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandName: {
    fontSize: 22,
    fontWeight: '800',
    color: color.ink,
    letterSpacing: -0.5,
  },
  brandSub: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    fontFamily: 'Courier',
    letterSpacing: 0.3,
  },

  sectionLabel: {
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  sectionText: {
    ...t.stamp,
    fontFamily: 'Courier',
    color: color.mute,
    fontSize: 10,
    letterSpacing: 1,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
  },
  rowPressed: { opacity: 0.6 },

  avatarWrap: { position: 'relative' },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: color.haze,
  },

  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  name: { ...t.body, color: color.ink, flex: 1 },
  nameUnread: { fontWeight: '700' },
  time: { ...t.small, color: color.faint, fontSize: 11 },

  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  preview: { ...t.small, color: color.mute, flex: 1 },
  previewUnread: { color: color.ink, fontWeight: '600' },

  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeText: {
    ...t.stamp,
    fontFamily: 'Courier',
    color: color.onInk,
    fontSize: 11,
  },

  sep: {
    height: 1,
    backgroundColor: color.haze,
    marginHorizontal: space.xl,
    opacity: 0.5,
  },
});
