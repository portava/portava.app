import React from 'react';
import { View, Text, FlatList, Image, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { notifications } from '../src/data/cebu';
import { color, space, type as t } from '../src/theme/tokens';

export default function Notifications() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={[styles.head, { paddingTop: insets.top + space.md }]}>
        <Text style={styles.title}>Notifications</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => router.back()} hitSlop={8}><X size={24} color={color.ink} /></Pressable>
      </View>
      <FlatList
        data={notifications}
        keyExtractor={(n) => n.id}
        contentContainerStyle={{ padding: space.lg, gap: space.md }}
        renderItem={({ item }) => (
          <View style={[styles.row, !item.read && styles.unread]}>
            {item.actor && <Image source={{ uri: item.actor.avatarUrl }} style={styles.avatar} />}
            <Text style={styles.text}>{item.text}</Text>
          </View>
        )}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingBottom: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  title: { ...t.title, color: color.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: 12 },
  unread: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.haze },
  text: { ...t.body, color: color.ink, flex: 1 },
});
