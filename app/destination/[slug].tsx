import React, { useState } from 'react';
import { View, Text, ScrollView, Image, Pressable, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, Sparkles } from 'lucide-react-native';
import { Stamp, Chip } from '../../src/components/ui';
import { PostCard } from '../../src/components/PostCard';
import { cebu, posts } from '../../src/data/cebu';
import { color, space, radius, type as t } from '../../src/theme/tokens';

const TABS = ['Feed', 'Questions', 'Best areas', 'Travelers', 'Events'];

export default function Destination() {
  useLocalSearchParams();
  const [tab, setTab] = useState('Feed');
  const feed = posts.filter((p) => tab === 'Questions' ? p.kind === 'question' : true);
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScrollView stickyHeaderIndices={[1]} contentContainerStyle={{ paddingBottom: space.xxxl }}>
        <View style={styles.hero}>
          <Image source={{ uri: cebu.coverUrl }} style={StyleSheet.absoluteFill} />
          <View style={styles.heroScrim} />
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8}><ChevronLeft size={26} color={color.onInk} /></Pressable>
          <View style={styles.heroBody}>
            <Stamp label={cebu.trending ? 'trending' : 'destination'} tone="onInk" />
            <Text style={styles.heroTitle}>{cebu.city}</Text>
            <Text style={styles.heroSub}>{cebu.travelerCount.toLocaleString()} travelers · {cebu.country}</Text>
          </View>
        </View>
        <View style={styles.tabBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md }}>
            {TABS.map((x) => <Chip key={x} label={x} active={x===tab} onPress={() => setTab(x)} />)}
          </ScrollView>
        </View>
        <Pressable style={styles.aiBanner} onPress={() => router.push('/(tabs)/ai')}>
          <Sparkles size={16} color={color.signal} />
          <Text style={styles.aiText}>Ask AI to summarize Cebu nightlife, beaches, or build a plan</Text>
        </Pressable>
        <View style={{ padding: space.lg, gap: space.lg }}>
          {feed.map((p) => <PostCard key={p.id} post={p} />)}
        </View>
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  hero: { height: 240, justifyContent: 'flex-end' },
  heroScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,17,15,0.35)' },
  back: { position: 'absolute', top: space.xxl, left: space.lg },
  heroBody: { padding: space.lg, gap: space.sm },
  heroTitle: { ...t.hero, fontSize: 40, lineHeight: 42, color: color.onInk },
  heroSub: { ...t.body, color: color.onInkMute },
  tabBar: { backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.haze },
  aiBanner: { flexDirection: 'row', alignItems: 'center', gap: space.sm, margin: space.lg, marginBottom: 0, padding: space.md, borderRadius: radius.md, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  aiText: { ...t.small, color: color.ink, flex: 1 },
});
