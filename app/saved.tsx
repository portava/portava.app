import React, { useState } from 'react';
import { View, Text, ScrollView, FlatList, StyleSheet } from 'react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { Chip } from '../src/components/ui';
import { PostCard } from '../src/components/PostCard';
import { posts } from '../src/data/cebu';
import { color, space } from '../src/theme/tokens';

const TABS = ['Posts','Places','Hotels','Nightlife','Itineraries','Questions','AI answers'];
export default function Saved() {
  const [tab, setTab] = useState('Posts');
  const saved = posts.filter((p) => p.saved);
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Saved" back />
      <FlatList data={TABS} horizontal showsHorizontalScrollIndicator={false} keyExtractor={(x)=>x}
        style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space.sm, padding: space.lg }}
        renderItem={({ item }) => <Chip label={item} active={item===tab} onPress={() => setTab(item)} />} />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: 0, gap: space.lg }}>
        {saved.map((p) => <PostCard key={p.id} post={p} />)}
      </ScrollView>
    </View>
  );
}
