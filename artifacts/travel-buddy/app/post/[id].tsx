import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { MoreVertical } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { PostCard } from '../../src/components/PostCard';
import { ReportPostSheet } from '../../src/components/ReportPostSheet';
import { postById } from '../../src/data/cebu';
import { useSession } from '../../src/context/SessionContext';
import { color, space, type as t } from '../../src/theme/tokens';

export default function PostDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const post = postById(id);
  const { userId } = useSession();
  const [reportOpen, setReportOpen] = useState(false);

  const isOwnPost = !!(userId && post?.author.id === userId);

  const headerRight = post && !isOwnPost ? (
    <Pressable onPress={() => setReportOpen(true)} hitSlop={8} accessibilityLabel="More options">
      <MoreVertical size={22} color={color.ink} />
    </Pressable>
  ) : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Post" back right={headerRight} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        {post
          ? <PostCard post={post} />
          : <Text style={{ ...t.body, color: color.mute }}>Post not found.</Text>}
        <Text style={{ ...t.heading, color: color.ink }}>Comments</Text>
        <Text style={{ ...t.body, color: color.mute }}>Comments thread shell — wire to backend later.</Text>
      </ScrollView>
      {post && !isOwnPost && (
        <ReportPostSheet
          postId={post.id}
          visible={reportOpen}
          onClose={() => setReportOpen(false)}
        />
      )}
    </View>
  );
}
