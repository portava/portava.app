import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';

export default function Destination() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const name = slug
    ? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Destination';

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.back}>
          <ChevronLeft size={24} color={color.ink} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{name}</Text>
        <View style={{ width: 32 }} />
      </View>

      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <MapPin size={36} color={color.deep} />
        </View>
        <Text style={styles.heading}>Destination pages coming soon</Text>
        <Text style={styles.sub}>
          We're building rich destination guides — local tips, top posts, nearby travelers, and more. Check back soon.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  back: { padding: 4 },
  title: { ...t.bodyStrong, color: color.ink, flex: 1, textAlign: 'center', fontSize: 16 },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  heading: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 17,
    textAlign: 'center',
  },
  sub: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 21,
  },
});
