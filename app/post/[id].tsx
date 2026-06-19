import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { PostCard } from '../../src/components/PostCard';
import { postById } from '../../src/data/cebu';
import { color, space, type as t } from '../../src/theme/tokens';

export default function PostDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const post = postById(id);
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Post" back />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        {post ? <PostCard post={post} /> : <Text style={{ ...t.body, color: color.mute }}>Post not found.</Text>}
        <Text style={{ ...t.heading, color: color.ink }}>Comments</Text>
        <Text style={{ ...t.body, color: color.mute }}>Comments thread shell — wire to backend later.</Text>
      </ScrollView>
    </View>
  );
}
