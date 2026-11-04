/**
 * Become a Local Guide — the application form for POST /api/hidden-gems/guides/apply.
 *
 * The apply route, the admin review queue (app/admin/local-guides.tsx) and the
 * guide profile (app/gems/guide.tsx) all existed, but nothing in the app called
 * the route, so nobody could ever apply. PRODUCT CALL (2026-11-04): open
 * applications to every signed-in traveller, keep the admin review as the gate.
 *
 * Route: /gems/become-guide. Entry points: the Hidden Gems screen and Explore
 * Portava, both shown only while `local_guides_enabled` is on.
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { KeyboardSafeView } from '../../src/components/ui/KeyboardSafeView';
import { applyForGuide, getGuideProfile } from '../../src/services/hiddenGems';
import { useSession } from '../../src/context/SessionContext';
import {
  MAX_GUIDE_BIO,
  MAX_GUIDE_CITIES,
  guideApplicationOutcome,
  guideApplyErrorCopy,
  parseCityList,
  type GuideApplicationOutcome,
} from '../../src/lib/gems/guideApplication.ts';

export default function BecomeGuideScreen() {
  const router = useRouter();
  const { userId } = useSession();

  const [checking, setChecking] = useState(true);
  const [outcome, setOutcome] = useState<GuideApplicationOutcome | null>(null);
  const [citiesText, setCitiesText] = useState('');
  const [bio, setBio] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An active guide is told so instead of being shown the form. (The public
  // profile read answers only for ACTIVE guides; a pending applicant finds out
  // on submit, which the route answers idempotently with their application.)
  useEffect(() => {
    let alive = true;
    if (!userId) { setChecking(false); return; }
    getGuideProfile(userId).then((g) => {
      if (!alive) return;
      if (g?.status === 'active') setOutcome('active');
      setChecking(false);
    });
    return () => { alive = false; };
  }, [userId]);

  const cities = parseCityList(citiesText);
  const canSend = cities.length > 0 && !sending;

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const res = await applyForGuide(bio.trim() || undefined, cities);
      setOutcome(guideApplicationOutcome((res.guide as any)?.status));
    } catch (e: any) {
      setError(guideApplyErrorCopy(e?.code));
    } finally {
      setSending(false);
    }
  };

  const header = (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} style={styles.headerBack} accessibilityRole="button" accessibilityLabel="Back">
        <Ionicons name="arrow-back" size={22} color="#E8F0FE" />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Become a Local Guide</Text>
      <View style={{ width: 30 }} />
    </View>
  );

  if (checking) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        {header}
        <View style={styles.center}><ActivityIndicator size="large" color="#4C8BF5" /></View>
      </SafeAreaView>
    );
  }

  if (!userId) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        {header}
        <View style={styles.center}><Text style={styles.body}>Sign in to apply.</Text></View>
      </SafeAreaView>
    );
  }

  if (outcome) {
    const done = {
      active: { icon: 'ribbon', title: "You're a Local Guide", body: 'Your gems carry the guide badge, and your profile lists the cities you know.' },
      pending: { icon: 'time-outline', title: 'Application sent', body: 'A Portava reviewer looks at every application. Keep adding gems in the meantime; they count toward your guide level.' },
      paused: { icon: 'pause-circle-outline', title: 'Your guide profile is paused', body: 'Your Local Guide profile is not active right now. If you think that is a mistake, use Report a Problem in Settings.' },
    }[outcome];
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        {header}
        <View style={styles.center} testID={`guide-apply-${outcome}`}>
          <Ionicons name={done.icon as any} size={48} color="#4C8BF5" />
          <Text style={styles.doneTitle}>{done.title}</Text>
          <Text style={[styles.body, { textAlign: 'center' }]}>{done.body}</Text>
          {outcome === 'active' ? (
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => router.replace(`/gems/guide?userId=${userId}` as any)}>
              <Text style={styles.secondaryBtnText}>View your guide profile</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => router.replace('/gems/submit')}>
              <Text style={styles.secondaryBtnText}>Add a gem</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      {header}
      <KeyboardSafeView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        <Text style={styles.body}>
          Local Guides are travellers who know a city well. Their gems carry a guide badge, and their profile shows the
          cities they know. A Portava reviewer looks at every application.
        </Text>

        <Text style={styles.label}>Cities you know well</Text>
        <TextInput
          style={styles.input}
          value={citiesText}
          onChangeText={setCitiesText}
          placeholder="Cebu, Manila"
          placeholderTextColor="#5A6B85"
          autoCapitalize="words"
          accessibilityLabel="Cities you know well"
        />
        <Text style={styles.hint}>
          Separate cities with commas, up to {MAX_GUIDE_CITIES}.{cities.length > 0 ? ` ${cities.length} added.` : ''}
        </Text>

        <Text style={styles.label}>About you (optional)</Text>
        <TextInput
          style={[styles.input, styles.bio]}
          value={bio}
          onChangeText={(v) => setBio(v.slice(0, MAX_GUIDE_BIO))}
          placeholder="How do you know these places? What do you like to recommend?"
          placeholderTextColor="#5A6B85"
          multiline
          textAlignVertical="top"
          accessibilityLabel="About you"
        />
        <Text style={styles.hint}>{bio.length} / {MAX_GUIDE_BIO}</Text>

        {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}

        <TouchableOpacity
          style={[styles.primaryBtn, !canSend && { opacity: 0.5 }]}
          onPress={submit}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Send application"
          accessibilityState={{ disabled: !canSend }}
        >
          {sending ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Send application</Text>}
        </TouchableOpacity>
      </KeyboardSafeView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A1628' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 28 },
  scroll: { paddingHorizontal: 20, paddingBottom: 40, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  headerBack: { padding: 4 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#E8F0FE' },
  body: { color: '#B8C4D6', fontSize: 15, lineHeight: 21 },
  label: { color: '#E8F0FE', fontSize: 14, fontWeight: '600', marginTop: 16 },
  hint: { color: '#8A9BB5', fontSize: 12 },
  input: { backgroundColor: '#1E2D45', color: '#E8F0FE', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  bio: { minHeight: 110 },
  error: { color: '#FF6B6B', fontSize: 14, marginTop: 8 },
  primaryBtn: { backgroundColor: '#4C8BF5', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  doneTitle: { color: '#E8F0FE', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  secondaryBtn: { backgroundColor: '#1E2D45', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 8 },
  secondaryBtnText: { color: '#4C8BF5', fontWeight: '600' },
});
