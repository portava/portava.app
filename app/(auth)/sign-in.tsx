import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Image } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Mail, Lock, User as UserIcon } from 'lucide-react-native';
import { signIn, signUp } from '../../src/services/auth';
import { useSession } from '../../src/context/SessionContext';
import { isSupabaseConfigured } from '../../src/lib/supabase';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

type Mode = 'signin' | 'signup';

export default function SignIn() {
  const insets = useSafeAreaInsets();
  const { isAuthed } = useSession();
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // already signed in -> go to app
  useEffect(() => {
    if (isAuthed) router.replace('/(tabs)');
  }, [isAuthed]);

  async function submit() {
    setError(null); setNotice(null);
    if (!isSupabaseConfigured) { setError('Backend not configured. Add your Supabase keys to .env.'); return; }
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    if (mode === 'signup' && password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    setBusy(true);
    try {
      const res = mode === 'signin'
        ? await signIn(email.trim(), password)
        : await signUp(email.trim(), password, { name: name.trim() || email.split('@')[0] });
      if (res.error) { setError(res.error); return; }
      if (mode === 'signup' && !res.userId) {
        setNotice('Check your email to confirm your account, then sign in.');
        setMode('signin');
        return;
      }
      router.replace('/(tabs)');
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.paper }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[s.wrap, { paddingTop: insets.top + space.xxxl, paddingBottom: insets.bottom + space.xl }]} keyboardShouldPersistTaps="handled">
        <View style={s.brand}>
          <Image source={require('../../assets/images/portava-icon.png')} style={s.logo} accessibilityLabel="Portava" />
          <Text style={s.title}>Portava</Text>
          <Text style={s.tagline}>Explore. Connect. Belong.</Text>
        </View>

        <View style={s.card}>
          <View style={s.tabs}>
            <Pressable style={[s.tab, mode === 'signin' && s.tabOn]} onPress={() => { setMode('signin'); setError(null); }}>
              <Text style={[s.tabText, mode === 'signin' && s.tabTextOn]}>Sign in</Text>
            </Pressable>
            <Pressable style={[s.tab, mode === 'signup' && s.tabOn]} onPress={() => { setMode('signup'); setError(null); }}>
              <Text style={[s.tabText, mode === 'signup' && s.tabTextOn]}>Create account</Text>
            </Pressable>
          </View>

          {mode === 'signup' ? (
            <View style={s.field}>
              <UserIcon size={17} color={color.faint} />
              <TextInput style={s.input} placeholder="Your name" placeholderTextColor={color.faint}
                value={name} onChangeText={setName} autoCapitalize="words" />
            </View>
          ) : null}

          <View style={s.field}>
            <Mail size={17} color={color.faint} />
            <TextInput style={s.input} placeholder="Email" placeholderTextColor={color.faint}
              value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
          </View>

          <View style={s.field}>
            <Lock size={17} color={color.faint} />
            <TextInput style={s.input} placeholder="Password" placeholderTextColor={color.faint}
              value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" />
          </View>

          {error ? <Text style={s.error}>{error}</Text> : null}
          {notice ? <Text style={s.notice}>{notice}</Text> : null}

          <Pressable style={[s.submit, busy ? s.submitBusy : null]} onPress={submit} disabled={busy}>
            {busy ? <ActivityIndicator color={color.onInk} /> : <Text style={s.submitText}>{mode === 'signin' ? 'Sign in' : 'Create account'}</Text>}
          </Pressable>

          <Text style={s.switchHint} onPress={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
            {mode === 'signin' ? "New here? Create an account" : 'Already have an account? Sign in'}
          </Text>
        </View>

        <Text style={s.legal}>By continuing you agree to travel kindly and respect fellow travelers.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: { flexGrow: 1, paddingHorizontal: space.lg, justifyContent: 'center', gap: space.xl },
  brand: { alignItems: 'center', gap: space.sm },
  logo:         { width: 76, height: 76, borderRadius: 17 },
  title: { ...t.hero, color: color.ink, fontSize: 28 },
  tagline: { ...t.small, color: color.mute },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.md, ...shadow.card },
  tabs: { flexDirection: 'row', backgroundColor: color.paper, borderRadius: radius.md, padding: 3, marginBottom: space.sm },
  tab: { flex: 1, paddingVertical: space.sm, borderRadius: radius.sm, alignItems: 'center' },
  tabOn: { backgroundColor: color.signal },
  tabText: { ...t.small, fontWeight: '700', color: color.mute },
  tabTextOn: { color: color.onInk },
  field: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, backgroundColor: color.paper },
  input: { flex: 1, paddingVertical: space.md, ...t.body, color: color.ink },
  error: { ...t.small, color: color.signal, fontWeight: '600' },
  notice: { ...t.small, color: color.success, fontWeight: '600' },
  submit: { backgroundColor: color.ink, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: space.xs },
  submitBusy: { opacity: 0.7 },
  submitText: { ...t.bodyStrong, color: color.onInk },
  switchHint: { ...t.small, color: color.signal, fontWeight: '600', textAlign: 'center', marginTop: space.xs },
  legal: { ...t.small, color: color.faint, fontSize: 11, textAlign: 'center', paddingHorizontal: space.lg },
});
