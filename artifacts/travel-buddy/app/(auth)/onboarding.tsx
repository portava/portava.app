import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { router } from 'expo-router';
import { Stamp, Chip } from '../../src/components/ui';
import type { Interest, TravelStyle } from '../../src/types/models';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { updateMyProfile } from '../../src/services/profile';

const INTERESTS: Interest[] = ['nightlife','beach','food','luxury','backpacking','culture','adventure','shopping','photography','business','dating','wellness','events'];
const STYLES: TravelStyle[] = ['solo','couple','group','business'];

export default function Onboarding() {
  const [picked, setPicked] = useState<Interest[]>([]);
  const [style, setStyle] = useState<TravelStyle>('solo');
  const [saving, setSaving] = useState(false);
  const toggle = (i: Interest) => setPicked((p) => p.includes(i) ? p.filter((x) => x!==i) : [...p, i]);

  async function handleEnter() {
    setSaving(true);
    const result = await updateMyProfile({
      interests: picked,
      travelStyle: style,
    });
    setSaving(false);
    if (!result.ok && result.errorKind !== 'config_error' && result.errorKind !== 'unauthenticated') {
      Alert.alert(
        'Could not save preferences',
        'Your interests and travel style couldn\'t be saved right now. You can update them later in your profile.',
        [{ text: 'Continue anyway', onPress: () => router.replace('/(tabs)' as any) }, { text: 'Retry', onPress: handleEnter }],
      );
      return;
    }
    router.replace('/(tabs)' as any);
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.xxxl, gap: space.xl }}>
        <View>
          <Stamp label="welcome aboard" tone="signal" />
          <Text style={styles.title}>Set up your{'\n'}travel passport</Text>
          <Text style={styles.sub}>We'll tune your feed and who you meet.</Text>
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
      <Pressable style={[styles.cta, saving && styles.ctaDisabled]} onPress={handleEnter} disabled={saving}>
        {saving
          ? <ActivityIndicator color={color.onInk} />
          : <Text style={styles.ctaText}>Enter Travel Buddy</Text>
        }
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
  ctaDisabled: { opacity: 0.6 },
  ctaText: { ...t.heading, color: color.onInk },
});
