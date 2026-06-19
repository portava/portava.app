import React, { useState } from 'react';
import { View, Text, ScrollView, TextInput, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { X, Image as ImageIcon } from 'lucide-react-native';
import { Stamp, Chip } from '../src/components/ui';
import type { PostCategory } from '../src/types/models';
import { color, space, radius, type as t } from '../src/theme/tokens';

const CATS: PostCategory[] = ['hotel','food','nightlife','beach','activity','transport','airport','visa','safety','tip','question'];
const VIS = ['Public', 'Friends', 'Private'];

export default function Create() {
  const [cat, setCat] = useState<PostCategory>('beach');
  const [vis, setVis] = useState('Public');
  const [caption, setCaption] = useState('');
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={8}><X size={24} color={color.ink} /></Pressable>
        <Text style={styles.title}>New post</Text>
        <View style={{ flex: 1 }} />
        <Pressable style={styles.post} onPress={() => router.back()}><Text style={styles.postText}>Share</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        <Pressable style={styles.media}><ImageIcon size={28} color={color.mute} /><Text style={styles.mediaText}>Add photo or video</Text></Pressable>
        <TextInput style={styles.caption} placeholder="Share a tip, review, question, or moment…" placeholderTextColor={color.faint} multiline value={caption} onChangeText={setCaption} />
        <View>
          <Text style={styles.label}>Category</Text>
          <View style={styles.wrap}>{CATS.map((c) => <Chip key={c} label={c} active={c===cat} onPress={() => setCat(c)} />)}</View>
        </View>
        <View>
          <Text style={styles.label}>Destination</Text>
          <View style={styles.wrap}><Stamp label="Cebu, Philippines" tone="deep" /></View>
        </View>
        <View>
          <Text style={styles.label}>Visibility</Text>
          <View style={styles.wrap}>{VIS.map((v) => <Chip key={v} label={v} active={v===vis} onPress={() => setVis(v)} />)}</View>
        </View>
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, paddingTop: space.xxl, borderBottomWidth: 1, borderBottomColor: color.haze },
  title: { ...t.heading, color: color.ink },
  post: { backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill },
  postText: { ...t.small, fontWeight: '800', color: color.onInk },
  media: { height: 180, borderRadius: radius.lg, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.haze, alignItems: 'center', justifyContent: 'center', gap: space.sm, backgroundColor: color.paperRaised },
  mediaText: { ...t.body, color: color.mute },
  caption: { ...t.body, color: color.ink, minHeight: 90, textAlignVertical: 'top' },
  label: { ...t.stamp, fontFamily: 'Courier', color: color.mute, marginBottom: space.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
