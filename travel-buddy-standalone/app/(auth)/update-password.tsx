/**
 * update-password.tsx — Password-reset completion screen.
 *
 * Reached via the Supabase password-reset deep link:
 *   travelbuddy://update-password?access_token=...&type=recovery
 *
 * Supabase-js picks up the recovery token from the URL fragment /
 * query params and fires a PASSWORD_RECOVERY onAuthStateChange event,
 * which the root layout detects and navigates here.  This screen then
 * calls supabase.auth.updateUser to set the new password.
 *
 * On mount, the screen verifies that a recovery session is actually
 * present before showing the password form.  If the session is missing
 * after SESSION_TIMEOUT_MS, it shows a clear expiry error so the user
 * knows to request a new reset link.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { Lock, Eye, EyeOff, CheckCircle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../src/lib/supabase';
import { color, space, radius, typography } from '../../src/theme/tokens';

const MIN_PASSWORD_LENGTH = 8;
/** How long to wait for a recovery session before showing the expiry error. */
const SESSION_TIMEOUT_MS = 5000;

type SessionState = 'checking' | 'ready' | 'expired';

export default function UpdatePassword() {
  const insets = useSafeAreaInsets();
  const [sessionState, setSessionState] = useState<SessionState>('checking');
  const [password, setPassword]       = useState('');
  const [confirm, setConfirm]         = useState('');
  const [showPw, setShowPw]           = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [success, setSuccess]         = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    let timeoutId: ReturnType<typeof setTimeout>;

    async function checkSession() {
      try {
        const { data } = await supabase.auth.getSession();
        if (!mountedRef.current) return;
        if (data.session) {
          setSessionState('ready');
        } else {
          // Session not yet present — wait for the timeout, then expire.
          timeoutId = setTimeout(() => {
            if (mountedRef.current) setSessionState('expired');
          }, SESSION_TIMEOUT_MS);
        }
      } catch {
        if (mountedRef.current) {
          timeoutId = setTimeout(() => {
            if (mountedRef.current) setSessionState('expired');
          }, SESSION_TIMEOUT_MS);
        }
      }
    }

    checkSession();

    // Also listen for the recovery auth event in case the session arrives
    // slightly after mount (deep-link handler race).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mountedRef.current) return;
      if ((event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') && session) {
        clearTimeout(timeoutId);
        setSessionState('ready');
      }
    });

    return () => {
      mountedRef.current = false;
      clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  }, []);

  async function handleUpdate() {
    setError(null);
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) {
        setError(err.message ?? 'Could not update password. Please try again.');
        return;
      }
      setSuccess(true);
      // Sign out so the user starts a fresh session with their new password.
      await supabase.auth.signOut();
      setTimeout(() => router.replace('/(auth)' as any), 2500);
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <CheckCircle size={56} color={color.success} />
        <Text style={styles.successTitle}>Password updated!</Text>
        <Text style={styles.successSub}>Redirecting you to sign in…</Text>
      </View>
    );
  }

  if (sessionState === 'checking') {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={color.ink} />
        <Text style={styles.checkingText}>Verifying your reset link…</Text>
      </View>
    );
  }

  if (sessionState === 'expired') {
    return (
      <View style={[styles.center, { paddingTop: insets.top, paddingHorizontal: space.xl }]}>
        <Text style={styles.expiredTitle}>Link expired</Text>
        <Text style={styles.expiredBody}>
          Your reset link has expired. Please request a new one.
        </Text>
        <Pressable
          style={styles.btn}
          onPress={() => router.replace('/(auth)/forgot-password' as any)}
          accessibilityRole="button"
          accessibilityLabel="Go to forgot password"
        >
          <Text style={styles.btnText}>Request a new link</Text>
        </Pressable>
        <Pressable
          style={styles.cancelBtn}
          onPress={() => router.replace('/(auth)' as any)}
          accessibilityRole="button"
          accessibilityLabel="Back to sign in"
        >
          <Text style={styles.cancelText}>Back to sign in</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={[
        styles.root,
        { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xl },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Set a new password</Text>
      <Text style={styles.subtitle}>
        Choose a strong password of at least {MIN_PASSWORD_LENGTH} characters.
      </Text>

      {/* New password field */}
      <View style={styles.field}>
        <Lock size={16} color={color.faint} />
        <TextInput
          style={styles.input}
          placeholder="New password"
          placeholderTextColor={color.faint}
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPw}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="New password"
        />
        <Pressable
          onPress={() => setShowPw(v => !v)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={showPw ? 'Hide password' : 'Show password'}
        >
          {showPw
            ? <EyeOff size={16} color={color.faint} />
            : <Eye    size={16} color={color.faint} />}
        </Pressable>
      </View>

      {/* Confirm password field */}
      <View style={styles.field}>
        <Lock size={16} color={color.faint} />
        <TextInput
          style={styles.input}
          placeholder="Confirm new password"
          placeholderTextColor={color.faint}
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry={!showConfirm}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Confirm new password"
        />
        <Pressable
          onPress={() => setShowConfirm(v => !v)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={showConfirm ? 'Hide confirm password' : 'Show confirm password'}
        >
          {showConfirm
            ? <EyeOff size={16} color={color.faint} />
            : <Eye    size={16} color={color.faint} />}
        </Pressable>
      </View>

      {error && <Text style={styles.errorText}>{error}</Text>}

      <Pressable
        style={[styles.btn, busy && { opacity: 0.7 }]}
        onPress={handleUpdate}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Update password"
      >
        {busy
          ? <ActivityIndicator color={color.onInk} />
          : <Text style={styles.btnText}>Update password</Text>}
      </Pressable>

      <Pressable
        style={styles.cancelBtn}
        onPress={() => router.replace('/(auth)' as any)}
        accessibilityRole="button"
        accessibilityLabel="Back to sign in"
      >
        <Text style={styles.cancelText}>Back to sign in</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flexGrow: 1,
    paddingHorizontal: space.xl,
    backgroundColor: color.paper,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
    gap: space.md,
  },
  title: {
    ...typography.pageTitle,
    color: color.ink,
    marginBottom: space.sm,
  },
  subtitle: {
    ...typography.body,
    color: color.mute,
    marginBottom: space.xl,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    marginBottom: space.md,
    gap: space.sm,
    backgroundColor: color.paperRaised,
  },
  input: {
    flex: 1,
    ...typography.body,
    color: color.ink,
  },
  errorText: {
    ...typography.caption,
    color: color.signal,
    marginBottom: space.md,
  },
  btn: {
    backgroundColor: color.ink,
    borderRadius: radius.md,
    paddingVertical: space.lg,
    alignItems: 'center',
    marginTop: space.sm,
    marginBottom: space.md,
    width: '100%',
  },
  btnText: {
    ...typography.button,
    color: color.onInk,
  },
  cancelBtn: {
    alignItems: 'center',
    paddingVertical: space.md,
  },
  cancelText: {
    ...typography.body,
    color: color.mute,
  },
  successTitle: {
    ...typography.pageTitle,
    color: color.ink,
    marginTop: space.md,
  },
  successSub: {
    ...typography.body,
    color: color.mute,
  },
  checkingText: {
    ...typography.body,
    color: color.mute,
    marginTop: space.sm,
  },
  expiredTitle: {
    ...typography.pageTitle,
    color: color.ink,
    marginBottom: space.sm,
    textAlign: 'center',
  },
  expiredBody: {
    ...typography.body,
    color: color.mute,
    textAlign: 'center',
    marginBottom: space.xl,
  },
});
