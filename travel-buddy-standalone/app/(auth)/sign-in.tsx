/**
 * sign-in.tsx — Portava login / welcome screen (redesigned).
 *
 * Visual redesign only. All auth logic (signIn, signUp, requestPasswordReset,
 * lookupUsernameByEmail) is preserved byte-for-byte from the previous version.
 * Only the JSX and styles changed; no service, context, or routing contract was
 * altered.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Animated,
  Platform,
  ScrollView,
  Alert,
  Dimensions,
} from 'react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Path,
  Rect,
  Defs,
  LinearGradient as SvgLinearGradient,
  Stop,
  G,
  Text as SvgText,
  Line as SvgLine,
} from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Lock,
  Eye,
  EyeOff,
  Globe,
  Shield,
  ArrowRight,
  ArrowLeft,
  ChevronRight,
  User as UserIcon,
  Mail,
} from 'lucide-react-native';

import { signIn, signUp, requestPasswordReset, lookupUsernameByEmail, ensureProfile, reportEnsureProfileFailure } from '../../src/services/auth';
import { signInWithApple, signInWithGoogle } from '../../src/services/ssoAuth';
import { getMyProfile } from '../../src/services/profile';
import { useSession } from '../../src/context/SessionContext';
import { isSupabaseConfigured } from '../../src/lib/supabase';
import { PortavaLogoMark, PortavaWordmark } from '../../src/components/brand/PortavaLogo';
import {
  LOGIN_BACKGROUNDS,
  BG_DISPLAY_DURATION_MS,
  BG_FADE_DURATION_MS,
} from '../../constants/loginBackgrounds';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEAL   = '#26C6DA';
const ORANGE = '#FF7A3D';
const RED    = '#E63946';
const GOLD   = '#D4AF37';
const AMBER  = '#FFB347';

// Semi-transparent card background for dark-overlay cards
const CARD_BG     = 'rgba(10, 10, 20, 0.65)';
const CARD_BORDER = 'rgba(255,255,255,0.12)';

type Mode = 'signin' | 'signup' | 'forgot-password' | 'forgot-username';

// ─── PassportCard ─────────────────────────────────────────────────────────────

/**
 * Small illustrated passport card (≈80×110 pt) rendered as SVG.
 * Brown/leather background, gold border, inner window with the Portava P mark,
 * "PASSPORT" at top and "PORTAVA" at bottom in gold small-caps.
 */
function PassportCard() {
  return (
    <Svg width={80} height={110} viewBox="0 0 80 110" accessibilityLabel="Portava passport">
      <Defs>
        <SvgLinearGradient id="pcWarm" x1="0" y1="0" x2="0.6" y2="1">
          <Stop offset="0" stopColor={ORANGE} />
          <Stop offset="0.5" stopColor="#FF4D3D" />
          <Stop offset="1" stopColor={RED} />
        </SvgLinearGradient>
        <SvgLinearGradient id="pcTeal" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={TEAL} />
          <Stop offset="1" stopColor="#00ACC1" />
        </SvgLinearGradient>
        <SvgLinearGradient id="pcLeather" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#8B5030" />
          <Stop offset="1" stopColor="#5C3018" />
        </SvgLinearGradient>
      </Defs>

      {/* Leather background */}
      <Rect width="80" height="110" rx="8" fill="url(#pcLeather)" />

      {/* Outer gold frame */}
      <Rect
        x="4" y="4" width="72" height="102" rx="6"
        stroke={GOLD} strokeWidth="1.2" fill="none"
      />

      {/* "PASSPORT" — top label */}
      <SvgText
        x="40" y="22"
        fill={GOLD}
        fontSize="7"
        fontWeight="700"
        letterSpacing="2.5"
        textAnchor="middle"
      >
        PASSPORT
      </SvgText>

      {/* Inner window with gold border */}
      <Rect
        x="18" y="29" width="44" height="50" rx="4"
        stroke={GOLD} strokeWidth="1.2"
        fill="rgba(0,0,0,0.35)"
      />

      {/* Portava P mark inside the window */}
      {/* Original P viewBox: 70×100 → scale 0.38 → ~26×38 → center in window (40, 54) */}
      <G transform="translate(26.6, 35) scale(0.38)">
        <Path d="M 5 6 L 24 6 A 25 25 0 0 1 24 56 L 24 94 L 5 94 Z" fill="url(#pcWarm)" />
        <Path d="M 28 16 Q 46 15 48 31 Q 46 47 28 46 Z" fill="url(#pcTeal)" />
      </G>

      {/* "PORTAVA" — bottom label */}
      <SvgText
        x="40" y="94"
        fill={GOLD}
        fontSize="7"
        fontWeight="700"
        letterSpacing="2.5"
        textAnchor="middle"
      >
        PORTAVA
      </SvgText>
    </Svg>
  );
}

// ─── Feature icons row ────────────────────────────────────────────────────────

const FEATURES = [
  { icon: 'people-outline',      label: 'MEET',     sub: 'new people',  color: TEAL   },
  { icon: 'calendar-outline',    label: 'DISCOVER',  sub: 'events',      color: '#FF6B35' },
  { icon: 'person-add-outline',  label: 'JOIN',      sub: 'get togethers', color: RED  },
  { icon: 'wine-outline',        label: 'EXPLORE',   sub: 'nightlife',   color: '#9C6FDE' },
  { icon: 'camera-outline',      label: 'SHARE',     sub: 'your journey', color: ORANGE },
] as const;

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function SignIn() {
  const insets   = useSafeAreaInsets();
  const { isAuthed } = useSession();
  const { mode: modeParam } = useLocalSearchParams<{ mode?: string }>();

  // ── Existing auth state (UNCHANGED) ────────────────────────────────────────
  const [mode,         setMode]         = useState<Mode>('signin');
  const [name,         setName]         = useState('');
  const [email,        setEmail]        = useState('');
  const [password,     setPassword]     = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy,         setBusy]         = useState(false);
  const [oauthBusy,    setOauthBusy]    = useState<'apple' | 'google' | null>(null);
  const [error,        setError]        = useState<string | null>(null);
  const [notice,       setNotice]       = useState<string | null>(null);

  // ── New visual state ────────────────────────────────────────────────────────
  // TODO: wire rememberMe to a persistent session preference when auth supports it
  const [rememberMe, setRememberMe] = useState(false);

  // Background rotation
  const bgCurrentRef  = useRef(0);
  const bgNextRef     = useRef(1 % LOGIN_BACKGROUNDS.length);
  const [bgState, setBgState] = useState({ current: 0, next: 1 % LOGIN_BACKGROUNDS.length });
  const fadeAnim      = useRef(new Animated.Value(0)).current;
  const isAnimating   = useRef(false);
  const isPaused      = useRef(false);
  const resumeTimer   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rotationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ── Redirect once authenticated (suppressed during any in-flight SSO request
  //    so the handler can make onboarding/tabs routing decisions itself) ───────
  useEffect(() => {
    if (isAuthed && !busy && !oauthBusy) router.replace('/(tabs)');
  }, [isAuthed, busy, oauthBusy]);

  // Honour ?mode=forgot-password deep links (e.g. from the expired reset screen)
  useEffect(() => {
    if (modeParam === 'forgot-password') switchMode('forgot-password');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeParam]);

  // ── Background rotation ─────────────────────────────────────────────────────
  const scheduleNextRef = useRef<(() => void) | undefined>(undefined);
  scheduleNextRef.current = useCallback(() => {
    rotationTimer.current = setTimeout(() => {
      if (isPaused.current || isAnimating.current) {
        scheduleNextRef.current?.();
        return;
      }
      isAnimating.current = true;
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: BG_FADE_DURATION_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          bgCurrentRef.current = bgNextRef.current;
          bgNextRef.current    = (bgNextRef.current + 1) % LOGIN_BACKGROUNDS.length;
          setBgState({ current: bgCurrentRef.current, next: bgNextRef.current });
          fadeAnim.setValue(0);
          isAnimating.current = false;
          scheduleNextRef.current?.();
        }
      });
    }, BG_DISPLAY_DURATION_MS);
  }, [fadeAnim]);

  useEffect(() => {
    scheduleNextRef.current?.();
    return () => {
      clearTimeout(rotationTimer.current);
      clearTimeout(resumeTimer.current);
      fadeAnim.stopAnimation();
    };
  }, []);

  // Pause rotation while the user is typing; resume 5 s after activity stops
  const handleInputActivity = useCallback(() => {
    isPaused.current = true;
    clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => { isPaused.current = false; }, 5000);
  }, []);

  // ── Existing auth functions (UNCHANGED logic) ───────────────────────────────

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
      if (mode === 'signup' && res.userId) {
        router.replace('/(auth)/onboarding');
        return;
      }
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

  // ── OAuth handlers ──────────────────────────────────────────────────────────

  /**
   * Post-SSO routing helper — shared by Apple and Google handlers.
   * Calls ensureProfile (non-fatal) then routes to onboarding or tabs.
   */
  async function _finishSSOSignIn(
    userId: string,
    email: string,
    displayName: string | undefined,
  ) {
    try {
      await ensureProfile(userId, email, { name: displayName });
    } catch (e) {
      // Non-fatal: profile row may already exist, or SessionContext will recover.
      // Still surface it — this is the one point in the SSO flow where a
      // profile-creation failure is directly attributable to a foreground
      // user action, so a silent failure here is the least visible of all.
      reportEnsureProfileFailure('sso', userId, e);
      Alert.alert(
        "We're finishing setup",
        "You're signed in, but we hit a snag setting up your profile. If some features seem unavailable, try signing out and back in.",
      );
    }
    try {
      const profileRes = await getMyProfile();
      if (
        profileRes.ok &&
        profileRes.data &&
        (!profileRes.data.displayName || !profileRes.data.username)
      ) {
        router.replace('/(auth)/onboarding');
        return;
      }
    } catch {
      // Non-fatal: if the check fails, proceed to tabs normally.
    }
    router.replace('/(tabs)');
  }

  async function handleAppleSignIn() {
    if (busy || oauthBusy) return;
    setError(null);
    setNotice(null);
    setOauthBusy('apple');
    try {
      const result = await signInWithApple();
      if (result.cancelled) return;   // user dismissed — silent
      if (!result.userId || result.error) {
        setError(result.error ?? 'Apple sign-in failed. Please try again.');
        return;
      }
      await _finishSSOSignIn(result.userId, result.email ?? '', result.displayName);
    } catch (e: any) {
      setError(e?.message ?? 'Apple sign-in failed. Please try again.');
    } finally {
      setOauthBusy(null);
    }
  }

  async function handleGoogleSignIn() {
    if (busy || oauthBusy) return;
    setError(null);
    setNotice(null);
    setOauthBusy('google');
    try {
      const result = await signInWithGoogle();
      if (result.cancelled) return;   // user dismissed — silent
      if (!result.userId || result.error) {
        setError(result.error ?? 'Google sign-in failed. Please try again.');
        return;
      }
      await _finishSSOSignIn(result.userId, result.email ?? '', result.displayName);
    } catch (e: any) {
      setError(e?.message ?? 'Google sign-in failed. Please try again.');
    } finally {
      setOauthBusy(null);
    }
  }

  const isForgot    = mode === 'forgot-password' || mode === 'forgot-username';
  const isSignin    = mode === 'signin';

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={s.root}>

      {/* ── Background image layer ── */}
      <Animated.Image
        source={LOGIN_BACKGROUNDS[bgState.current]}
        style={s.bgImage}
        resizeMode="cover"
      />
      <Animated.Image
        source={LOGIN_BACKGROUNDS[bgState.next]}
        style={[s.bgImage, { opacity: fadeAnim }]}
        resizeMode="cover"
      />

      {/* ── Dark gradient overlay (darker at top+bottom, lighter mid) ── */}
      <LinearGradient
        colors={[
          'rgba(4,8,18,0.82)',
          'rgba(4,8,18,0.30)',
          'rgba(4,8,18,0.30)',
          'rgba(4,8,18,0.88)',
        ]}
        locations={[0, 0.25, 0.65, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {/* ── Scrollable foreground content ── */}
      <KeyboardSafeScrollView style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[
            s.scroll,
            { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >

          {/* 1 ── Logo block ────────────────────────────────────────── */}
          <View style={s.logoBlock}>
            <PortavaLogoMark size="xl" />
            <View style={{ marginTop: 14 }}>
              <PortavaWordmark size="lg" variant="light" />
            </View>
            {/* Tri-color gradient tagline */}
            <View style={s.taglineRow}>
              <Text style={[s.taglineWord, { color: TEAL }]}>EXPLORE</Text>
              <Text style={s.taglineSep}>·</Text>
              <Text style={[s.taglineWord, { color: '#FF5533' }]}>CONNECT</Text>
              <Text style={s.taglineSep}>·</Text>
              <Text style={[s.taglineWord, { color: AMBER }]}>BELONG</Text>
            </View>
          </View>

          {/* 2 ── Divider with globe icon (signin only) ─────────────── */}
          {isSignin && (
            <View style={s.globeRow}>
              <View style={s.globeLine} />
              <View style={s.globeIconWrap}>
                <Globe size={14} color="rgba(255,255,255,0.45)" />
              </View>
              <View style={s.globeLine} />
            </View>
          )}

          {/* 3+4 ── Welcome back / subtitle (signin only) ────────────── */}
          {isSignin && (
            <View style={s.welcomeBlock}>
              <Text style={s.welcomeHead}>Welcome back</Text>
              <Text style={s.welcomeSub}>
                Good people. Great places. Real connections.
              </Text>
            </View>
          )}

          {/* 5 ── Auth card ──────────────────────────────────────────── */}
          <View style={s.card} accessibilityLabel="Sign in form">

            {/* Forgot flow header */}
            {isForgot && (
              <View style={s.forgotHeader}>
                <Pressable onPress={() => switchMode('signin')} style={s.backBtn} hitSlop={8}>
                  <ArrowLeft size={18} color="rgba(255,255,255,0.6)" />
                </Pressable>
                <Text style={s.forgotTitle}>
                  {mode === 'forgot-password' ? 'Reset password' : 'Find your username'}
                </Text>
              </View>
            )}

            {/* Signup header */}
            {mode === 'signup' && (
              <View style={s.forgotHeader}>
                <Pressable onPress={() => switchMode('signin')} style={s.backBtn} hitSlop={8}>
                  <ArrowLeft size={18} color="rgba(255,255,255,0.6)" />
                </Pressable>
                <Text style={s.forgotTitle}>Create your Passport</Text>
              </View>
            )}

            {/* Social buttons — signin only */}
            {isSignin && (
              <>
                {/* Apple sign-in — iOS only
                    Android: Apple web OAuth not implemented; button hidden.
                    See completion report for why and how to add it later. */}
                {Platform.OS === 'ios' && (
                  <Pressable
                    style={[s.socialBtn, (busy || !!oauthBusy) && s.socialBtnDisabled]}
                    onPress={handleAppleSignIn}
                    disabled={busy || !!oauthBusy}
                    accessibilityRole="button"
                    accessibilityLabel="Continue with Apple"
                    accessibilityState={{ busy: oauthBusy === 'apple' }}
                  >
                    {oauthBusy === 'apple'
                      ? <ActivityIndicator size="small" color="#000" style={{ width: 20 }} />
                      : <Ionicons name="logo-apple" size={20} color="#000" />
                    }
                    <Text style={s.socialBtnText}>Continue with Apple</Text>
                  </Pressable>
                )}

                {/* Google sign-in — iOS and Android */}
                <Pressable
                  style={[s.socialBtn, (busy || !!oauthBusy) && s.socialBtnDisabled]}
                  onPress={handleGoogleSignIn}
                  disabled={busy || !!oauthBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Continue with Google"
                  accessibilityState={{ busy: oauthBusy === 'google' }}
                >
                  {oauthBusy === 'google'
                    ? <ActivityIndicator size="small" color="#4285F4" style={{ width: 20, height: 20 }} />
                    : <View style={s.googleG}><Text style={s.googleGText}>G</Text></View>
                  }
                  <Text style={s.socialBtnText}>Continue with Google</Text>
                </Pressable>

                {/* OR divider */}
                <View style={s.orRow}>
                  <View style={s.orLine} />
                  <Text style={s.orText}>OR</Text>
                  <View style={s.orLine} />
                </View>
              </>
            )}

            {/* Name field (signup only) */}
            {mode === 'signup' && (
              <View style={s.field}>
                <UserIcon size={16} color="rgba(255,255,255,0.45)" />
                <TextInput
                  style={s.input}
                  placeholder="Your name"
                  placeholderTextColor="rgba(255,255,255,0.30)"
                  value={name}
                  onChangeText={v => { setName(v); handleInputActivity(); }}
                  onFocus={handleInputActivity}
                  autoCapitalize="words"
                  accessibilityLabel="Name"
                />
              </View>
            )}

            {/* Email field */}
            <View style={s.field}>
              <Mail size={16} color="rgba(255,255,255,0.45)" />
              <TextInput
                style={s.input}
                placeholder={isForgot ? 'Your email address' : 'Email or username'}
                placeholderTextColor="rgba(255,255,255,0.30)"
                value={email}
                onChangeText={v => { setEmail(v); handleInputActivity(); }}
                onFocus={handleInputActivity}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                accessibilityLabel="Email"
              />
            </View>

            {/* Password field (signin / signup only) */}
            {!isForgot && (
              <View style={s.field}>
                <Lock size={16} color="rgba(255,255,255,0.45)" />
                <TextInput
                  style={s.input}
                  placeholder="Password"
                  placeholderTextColor="rgba(255,255,255,0.30)"
                  value={password}
                  onChangeText={v => { setPassword(v); handleInputActivity(); }}
                  onFocus={handleInputActivity}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  accessibilityLabel="Password"
                />
                <Pressable
                  onPress={() => setShowPassword(v => !v)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword
                    ? <EyeOff size={16} color="rgba(255,255,255,0.45)" />
                    : <Eye    size={16} color="rgba(255,255,255,0.45)" />}
                </Pressable>
              </View>
            )}

            {/* Remember me + Forgot password row (signin only) */}
            {isSignin && (
              <View style={s.rememberRow}>
                <Pressable
                  style={s.rememberLeft}
                  onPress={() => setRememberMe(v => !v)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: rememberMe }}
                >
                  <View style={[s.checkbox, rememberMe && s.checkboxOn]}>
                    {rememberMe && <Ionicons name="checkmark" size={11} color="#fff" />}
                  </View>
                  <Text style={s.rememberText}>Remember me</Text>
                </Pressable>
                <Pressable onPress={() => switchMode('forgot-password')} hitSlop={6}>
                  <Text style={s.forgotLink}>Forgot password?</Text>
                </Pressable>
              </View>
            )}

            {/* Forgot flow hint */}
            {isForgot && !notice && (
              <Text style={s.forgotHint}>
                {mode === 'forgot-password'
                  ? "Enter your email and we'll send you a link to set a new password."
                  : "Enter the email you signed up with and we'll show you your username."}
              </Text>
            )}

            {/* Error / notice */}
            {error  && <Text style={s.errorText}>{error}</Text>}
            {notice && <Text style={s.noticeText}>{notice}</Text>}

            {/* Primary CTA */}
            {isSignin ? (
              /* Gradient Sign In button */
              <Pressable
                onPress={submit}
                disabled={busy || !!oauthBusy}
                style={{ borderRadius: 14, overflow: 'hidden', marginTop: 4 }}
                accessibilityRole="button"
                accessibilityLabel="Sign In"
              >
                <LinearGradient
                  colors={[TEAL, ORANGE, AMBER]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={s.signInBtn}
                >
                  {busy
                    ? <ActivityIndicator color="#fff" />
                    : <>
                        <Text style={s.signInText}>Sign In</Text>
                        <ArrowRight size={18} color="#fff" />
                      </>}
                </LinearGradient>
              </Pressable>
            ) : (
              /* Plain dark CTA for signup / forgot flows */
              <Pressable
                style={[s.darkBtn, (busy || !!oauthBusy) && { opacity: 0.7 }]}
                onPress={
                  mode === 'forgot-password' ? sendPasswordReset
                  : mode === 'forgot-username' ? lookupUsername
                  : submit
                }
                disabled={busy || !!oauthBusy}
                accessibilityRole="button"
              >
                {busy
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={s.darkBtnText}>
                      {mode === 'signup'          ? 'Create Account'
                       : mode === 'forgot-password' ? 'Send reset email'
                       : 'Find my username'}
                    </Text>}
              </Pressable>
            )}

            {/* Privacy note (signin only) */}
            {isSignin && (
              <View style={s.privacyRow}>
                <Shield size={12} color="rgba(255,255,255,0.35)" />
                <Text style={s.privacyText}>Your data is private and secure</Text>
              </View>
            )}
          </View>

          {/* 6 ── New to Portava card (signin only) ─────────────────── */}
          {isSignin && (
            <View style={s.card}>
              <View style={s.passportRow}>
                <PassportCard />
                <View style={s.passportContent}>
                  <Text style={s.passportHead}>New to Portava?</Text>
                  <Pressable
                    style={s.createPassportBtn}
                    onPress={() => switchMode('signup')}
                    accessibilityRole="button"
                    accessibilityLabel="Create your Passport"
                  >
                    <Text style={s.createPassportText}>Create your Passport</Text>
                    <ChevronRight size={15} color={ORANGE} />
                  </Pressable>
                  <Text style={s.passportSub}>Join the community.</Text>
                </View>
              </View>
            </View>
          )}

          {/* 7 ── Feature icons (signin only) ───────────────────────── */}
          {isSignin && (
            <View style={s.featureRow} accessibilityLabel="App features">
              {FEATURES.map(f => (
                <View
                  key={f.label}
                  style={s.featureItem}
                  accessibilityRole="none"
                  accessibilityLabel={`${f.label}: ${f.sub}`}
                >
                  <Ionicons
                    name={f.icon as any}
                    size={22}
                    color={f.color}
                  />
                  <Text style={[s.featureLabel, { color: f.color }]}>{f.label}</Text>
                  <Text style={s.featureSub}>{f.sub}</Text>
                </View>
              ))}
            </View>
          )}

          {/* 8 ── Script tagline (signin only) ──────────────────────── */}
          {isSignin && (
            <View style={s.scriptRow}>
              <Text style={[s.scriptText, { color: TEAL }]}>Your world.</Text>
              <Text style={[s.scriptText, { color: '#FF4444' }]}> Your people.</Text>
              <Text style={[s.scriptText, { color: AMBER }]}> Your journey.</Text>
              <Ionicons name="airplane-outline" size={13} color={ORANGE} style={{ marginLeft: 5 }} />
            </View>
          )}

          <Text style={s.legal}>
            By continuing you agree to travel kindly and respect fellow travelers.
          </Text>

        </ScrollView>
      </KeyboardSafeScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#04080C',
  },
  bgImage: {
    ...StyleSheet.absoluteFillObject,
  },

  scroll: {
    flexGrow: 1,
    paddingHorizontal: 20,
    gap: 18,
    alignItems: 'center',
  },

  // ── Logo block
  logoBlock: {
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  taglineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  taglineWord: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  taglineSep: {
    color: 'rgba(255,255,255,0.30)',
    fontSize: 10,
  },

  // ── Globe divider
  globeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    gap: 8,
  },
  globeLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  globeIconWrap: {
    padding: 2,
  },

  // ── Welcome back
  welcomeBlock: {
    alignItems: 'center',
    gap: 4,
  },
  welcomeHead: {
    fontSize: 26,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.4,
  },
  welcomeSub: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.60)',
    textAlign: 'center',
    lineHeight: 20,
  },

  // ── Card (auth card + passport card)
  card: {
    width: '100%',
    backgroundColor: CARD_BG,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: CARD_BORDER,
    padding: 18,
    gap: 12,
  },

  // ── Social buttons
  socialBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 13,
  },
  socialBtnDisabled: {
    opacity: 0.55,
  },
  socialBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111',
  },
  googleG: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleGText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#4285F4',
  },

  // ── OR divider
  orRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  orLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  orText: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.40)',
    letterSpacing: 1,
  },

  // ── Input fields
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 2,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#fff',
    paddingVertical: 13,
  },

  // ── Remember me row
  rememberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: -4,
  },
  rememberLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: TEAL,
    borderColor: TEAL,
  },
  rememberText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.55)',
  },
  forgotLink: {
    fontSize: 13,
    color: ORANGE,
    fontWeight: '600',
  },

  // ── Forgot flow
  forgotHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  backBtn: { padding: 2 },
  forgotTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
  forgotHint: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.50)',
    lineHeight: 19,
  },

  // ── Error / notice
  errorText: {
    fontSize: 13,
    color: '#FF6B6B',
    fontWeight: '600',
  },
  noticeText: {
    fontSize: 13,
    color: '#4CAF50',
    fontWeight: '600',
  },

  // ── Sign In gradient button
  signInBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 15,
    borderRadius: 14,
  },
  signInText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.3,
  },

  // ── Dark CTA (signup / forgot flows)
  darkBtn: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  darkBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },

  // ── Privacy note
  privacyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: -4,
  },
  privacyText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.35)',
  },

  // ── New to Portava card
  passportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  passportContent: {
    flex: 1,
    gap: 6,
  },
  passportHead: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  createPassportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  createPassportText: {
    fontSize: 14,
    fontWeight: '700',
    color: ORANGE,
  },
  passportSub: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.45)',
  },

  // ── Feature icons
  featureRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 4,
  },
  featureItem: {
    alignItems: 'center',
    gap: 4,
    minWidth: 52,
  },
  featureLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  featureSub: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.40)',
    textAlign: 'center',
  },

  // ── Script tagline
  scriptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  scriptText: {
    fontSize: 13,
    fontStyle: 'italic',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },

  // ── Legal
  legal: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.28)',
    textAlign: 'center',
    paddingHorizontal: 12,
    marginTop: 4,
  },
});
