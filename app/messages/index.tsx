import React from 'react';
import { View, Text, FlatList, Image, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { conversations, me } from '../../src/data/cebu';
import { color, space, type as t } from '../../src/theme/tokens';

export default function Messages() {
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Messages" back />
      <FlatList
        data={conversations}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ padding: space.lg, gap: space.md }}
        renderItem={({ item }) => {
          const other = item.participants.find((p) => p.id !== me.id)!;
          return (
            <Pressable style={styles.row} onPress={() => router.push(`/messages/${item.id}`)}>
              <Image source={{ uri: other.avatarUrl }} style={styles.avatar} />
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{other.name}</Text>
                <Text style={styles.preview} numberOfLines={1}>{item.lastMessage}</Text>
              </View>
              {item.unread > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{item.unread}</Text></View>}
            </Pressable>
          );
        }}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: color.haze },
  name: { ...t.bodyStrong, color: color.ink },
  preview: { ...t.small, color: color.mute, marginTop: 2 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { ...t.stamp, fontFamily: 'Courier', color: color.onInk },
});
