import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Stamp, Chip } from '../../src/components/ui';
import type { Interest, TravelStyle } from '../../src/types/models';
import { color, space, radius, type as t } from '../../src/theme/tokens';

const INTERESTS: Interest[] = ['nightlife','beach','food','luxury','backpacking','culture','adventure','shopping','photography','business','dating','wellness','events'];
const STYLES: TravelStyle[] = ['solo','couple','group','business'];

export default function Onboarding() {
  const [picked, setPicked] = useState<Interest[]>([]);
  const [style, setStyle] = useState<TravelStyle>('solo');
  const toggle = (i: Interest) => setPicked((p) => p.includes(i) ? p.filter((x) => x!==i) : [...p, i]);
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.xxxl, gap: space.xl }}>
        <View>
          <Stamp label="welcome aboard" tone="signal" />
          <Text style={styles.title}>Set up your{'\n'}travel passport</Text>
          <Text style={styles.sub}>We’ll tune your feed and who you meet.</Text>
        </View>
        <View>
          <Text style={styles.label}>How do you travel?</Text>
          <View style={styles.wrap}>{STYLES.map((s) => <Chip key={s} label={s} active={s===style} onPress={() => setStyle(s)} />)}</View>
        </View>
        <View>
          <Text style={styles.label}>What are you into?</Text>
          <View style={styles.wrap}>{INTERESTS.map((i) => <Chip key={i} label={i} active={picked.includes(i)} onPress={() => toggle(i)} />)}</View>
        </View>
      </ScrollView>
      <Pressable style={styles.cta} onPress={() => router.replace('/(tabs)')}>
        <Text style={styles.ctaText}>Enter Travel Buddy</Text>
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create({
  title: { ...t.hero, fontSize: 34, lineHeight: 36, color: color.ink, marginTop: space.md },
  sub: { ...t.body, color: color.mute, marginTop: space.sm },
  label: { ...t.heading, color: color.ink, marginBottom: space.md },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  cta: { margin: space.lg, backgroundColor: color.signal, paddingVertical: space.lg, borderRadius: radius.pill, alignItems: 'center' },
  ctaText: { ...t.heading, color: color.onInk },
});
