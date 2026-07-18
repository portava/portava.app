import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet, Image } from 'react-native';
import { KeyboardSafeView } from '../../src/components/ui/KeyboardSafeView';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Mail, Lock, User as UserIcon, ArrowLeft, Eye, EyeOff } from 'lucide-react-native';
import { signIn, signUp, requestPasswordReset, lookupUsernameByEmail } from '../../src/services/auth';
import { getMyProfile } from '../../src/services/profile';
import { useSession } from '../../src/context/SessionContext';
import { isSupabaseConfigured } from '../../src/lib/supabase';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

type Mode = 'signin' | 'signup' | 'forgot-password' | 'forgot-username';

export default function SignIn() {
  const insets = useSafeAreaInsets();
  const { isAuthed } = useSession();
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Redirect already-authed users who land on this screen.
  // Guard with !busy so we don't race against the submit handler's own navigation
  // during the signup flow (busy=true while the handler is running).
  useEffect(() => {
    if (isAuthed && !busy) router.replace('/(tabs)');
  }, [isAuthed, busy]);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
  }

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
        switchMode('signin');
        return;
      }
      // New users (just signed up with an active session) always go to onboarding.
      if (mode === 'signup' && res.userId) {
        router.replace('/(auth)/onboarding');
        return;
      }
      // Returning users: check profile completeness before routing.
      // A user who abandoned onboarding mid-flow is sent back to finish it
      // rather than landing on tabs with a blank / incomplete profile state.
      try {
        const profileRes = await getMyProfile();
        if (profileRes.ok && profileRes.data &&
            (!profileRes.data.displayName || !profileRes.data.username)) {
          router.replace('/(auth)/onboarding');
          return;
        }
      } catch {
        // Non-fatal — if the profile check fails, proceed to tabs normally.
      }
      router.replace('/(tabs)');
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function sendPasswordReset() {
    setError(null); setNotice(null);
    if (!email.trim()) { setError('Enter your email address.'); return; }
    setBusy(true);
    try {
      const res = await requestPasswordReset(email.trim());
      if (res.error) { setError(res.error); return; }
      setNotice('Password reset email sent — check your inbox (and spam folder).');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function lookupUsername() {
    setError(null); setNotice(null);
    if (!email.trim()) { setError('Enter your email address.'); return; }
    setBusy(true);
    try {
      const res = await lookupUsernameByEmail(email.trim());
      if (res.error || !res.handle) { setError(res.error ?? 'No account found with that email address.'); return; }
      setNotice(`Your username is @${res.handle}`);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const isForgot = mode === 'forgot-password' || mode === 'forgot-username';

  return (
    <KeyboardSafeView style={{ backgroundColor: color.paper }} contentContainerStyle={[s.wrap, { paddingTop: insets.top + space.xxxl, paddingBottom: insets.bottom + space.xl }]}>
        <View style={s.centreBox}>
          <View style={s.brand}>
            <Image source={require('../../assets/images/portava-icon.png')} style={s.logo} accessibilityLabel="Portava" />
            <Text style={s.title}>Portava</Text>
            <Text style={s.tagline}>Explore. Connect. Belong.</Text>
          </View>

          <View style={s.card}>
            {/* ── Sign in / Sign up tabs ── */}
            {!isForgot && (
              <View style={s.tabs}>
                <Pressable style={[s.tab, mode === 'signin' && s.tabOn]} onPress={() => switchMode('signin')}>
                  <Text style={[s.tabText, mode === 'signin' && s.tabTextOn]}>Sign in</Text>
                </Pressable>
                <Pressable style={[s.tab, mode === 'signup' && s.tabOn]} onPress={() => switchMode('signup')}>
                  <Text style={[s.tabText, mode === 'signup' && s.tabTextOn]}>Create account</Text>
                </Pressable>
              </View>
            )}

            {/* ── Forgot-flow header ── */}
            {isForgot && (
              <View style={s.forgotHeader}>
                <Pressable onPress={() => switchMode('signin')} style={s.backBtn} hitSlop={8}>
                  <ArrowLeft size={18} color={color.mute} />
                </Pressable>
                <Text style={s.forgotTitle}>
                  {mode === 'forgot-password' ? 'Reset password' : 'Find your username'}
                </Text>
              </View>
            )}

            {/* ── Name field (sign-up only) ── */}
            {mode === 'signup' && (
              <View style={s.field}>
                <UserIcon size={17} color={color.faint} />
                <TextInput style={s.input} placeholder="Your name" placeholderTextColor={color.faint}
                  value={name} onChangeText={setName} autoCapitalize="words" />
              </View>
            )}

            {/* ── Email field ── */}
            <View style={s.field}>
              <Mail size={17} color={color.faint} />
              <TextInput style={s.input} placeholder="Email" placeholderTextColor={color.faint}
                value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
            </View>

            {/* ── Password field (sign-in / sign-up only) ── */}
            {!isForgot && (
              <View style={s.field}>
                <Lock size={17} color={color.faint} />
                <TextInput style={s.input} placeholder="Password" placeholderTextColor={color.faint}
                  value={password} onChangeText={setPassword} secureTextEntry={!showPassword} autoCapitalize="none" />
                <Pressable onPress={() => setShowPassword(v => !v)} hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff size={17} color={color.mute} /> : <Eye size={17} color={color.faint} />}
                </Pressable>
              </View>
            )}

            {/* ── Forgot links (sign-in only) ── */}
            {mode === 'signin' && (
              <View style={s.forgotRow}>
                <Pressable onPress={() => switchMode('forgot-password')} hitSlop={6}>
                  <Text style={s.forgotLink}>Forgot password?</Text>
                </Pressable>
                <Text style={s.forgotSep}>·</Text>
                <Pressable onPress={() => switchMode('forgot-username')} hitSlop={6}>
                  <Text style={s.forgotLink}>Forgot username?</Text>
                </Pressable>
              </View>
            )}

            {/* ── Forgot-flow helper text ── */}
            {isForgot && !notice && (
              <Text style={s.forgotHint}>
                {mode === 'forgot-password'
                  ? "Enter your email and we'll send you a link to set a new password."
                  : "Enter the email you signed up with and we'll show you your username."}
              </Text>
            )}

            {error ? <Text style={s.error}>{error}</Text> : null}
            {notice ? <Text style={s.notice}>{notice}</Text> : null}

            {/* ── Primary action button ── */}
            <Pressable
              style={[s.submit, busy ? s.submitBusy : null]}
              onPress={mode === 'forgot-password' ? sendPasswordReset : mode === 'forgot-username' ? lookupUsername : submit}
              disabled={busy}
            >
              {busy
                ? <ActivityIndicator color={color.onInk} />
                : <Text style={s.submitText}>
                    {mode === 'signin' ? 'Sign in'
                      : mode === 'signup' ? 'Create account'
                      : mode === 'forgot-password' ? 'Send reset email'
                      : 'Find my username'}
                  </Text>}
            </Pressable>

            {/* ── Switch hint (sign-in / sign-up) ── */}
            {!isForgot && (
              <Text style={s.switchHint} onPress={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}>
                {mode === 'signin' ? "New here? Create an account" : 'Already have an account? Sign in'}
              </Text>
            )}
          </View>

          <Text style={s.legal}>By continuing you agree to travel kindly and respect fellow travelers.</Text>
        </View>
    </KeyboardSafeView>
  );
}

const s = StyleSheet.create({
  wrap:         { flexGrow: 1, paddingHorizontal: space.lg, justifyContent: 'center', gap: space.xl, alignItems: 'center' },
  centreBox:    { width: '100%', maxWidth: 480, gap: space.xl },
  brand:        { alignItems: 'center', gap: space.sm },
  logo:         { width: 76, height: 76, borderRadius: 17 },
  title:        { ...t.hero, color: color.ink, fontSize: 28 },
  tagline:      { ...t.small, color: color.mute },
  card:         { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.md, ...shadow.card },
  tabs:         { flexDirection: 'row', backgroundColor: color.paper, borderRadius: radius.md, padding: 3, marginBottom: space.sm },
  tab:          { flex: 1, paddingVertical: space.sm, borderRadius: radius.sm, alignItems: 'center' },
  tabOn:        { backgroundColor: color.signal },
  tabText:      { ...t.small, fontWeight: '700', color: color.mute },
  tabTextOn:    { color: color.onInk },
  field:        { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, backgroundColor: color.paper },
  input:        { flex: 1, paddingVertical: space.md, ...t.body, color: color.ink },
  error:        { ...t.small, color: color.signal, fontWeight: '600' },
  notice:       { ...t.small, color: color.success, fontWeight: '600' },
  submit:       { backgroundColor: color.ink, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: space.xs },
  submitBusy:   { opacity: 0.7 },
  submitText:   { ...t.bodyStrong, color: color.onInk },
  switchHint:   { ...t.small, color: color.signal, fontWeight: '600', textAlign: 'center', marginTop: space.xs },
  forgotRow:    { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: -space.xs },
  forgotLink:   { ...t.small, color: color.signal, fontWeight: '600' },
  forgotSep:    { ...t.small, color: color.faint },
  forgotHeader: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.xs },
  backBtn:      { padding: 4 },
  forgotTitle:  { ...t.bodyStrong, color: color.ink },
  forgotHint:   { ...t.small, color: color.mute, lineHeight: 18 },
  legal:        { ...t.small, color: color.faint, fontSize: 11, textAlign: 'center', paddingHorizontal: space.lg },
});
