import React, { useState, useEffect, type PropsWithChildren } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, space, type as typeTokens } from '../theme/tokens.ts';
import { useSession } from '../context/SessionContext.tsx';
import { reactivateAccount, cancelAccountDeletion } from '../services/profile.ts';

function formatDate(iso: string | null): string {
  if (!iso) return 'soon';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return 'soon';
  }
}

function RecoveryScreen({ kind, deadline }: { kind: 'deactivation' | 'deletion'; deadline: string | null }) {
  const { signOut, refreshAccountStatus } = useSession();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const deadlineMs = deadline ? Date.parse(deadline) : NaN;
  const available = Number.isFinite(deadlineMs) && now < deadlineMs;
  const personal = kind === 'deactivation';
  useEffect(() => {
    const remaining = deadlineMs - Date.now();
    if (!(remaining > 0)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [deadlineMs, now]);

  async function handleRecovery() {
    if (!(Date.now() < deadlineMs)) { setNow(Date.now()); return; }
    setLoading(true);
    setError(null);
    try {
      const result = personal ? await reactivateAccount() : await cancelAccountDeletion();
      if (result.ok) await refreshAccountStatus();
      else setError(result.message ?? 'Recovery could not be confirmed. Please try again.');
    } catch {
      setError('Recovery could not be confirmed. Please try again.');
    } finally { setLoading(false); }
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.inner} bounces={false}>
        <Text style={styles.heading}>{personal ? 'Your account is deactivated' : 'Your profile is deleted'}</Text>
        <Text style={styles.body}>
          {personal
            ? 'Your profile stays hidden until you reactivate it. You can reactivate a personally deactivated account for one year.'
            : 'Your profile is hidden. You can recover it for 90 days unless an admin permanently deletes it. Admin recovery remains available until permanent deletion.'}
        </Text>
        <Text style={styles.body}>
          {available
            ? `${personal ? 'Reactivate' : 'Recover your profile'} before ${formatDate(deadline)}. Your privacy settings still apply.`
            : deadline
              ? 'Your self-service recovery period has ended. Contact an admin for help. Your account is not automatically permanently deleted.'
              : 'Self-service recovery is unavailable. Contact an admin to check whether your account can be recovered.'}
        </Text>
        {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: loading || !available }}
          style={[styles.primaryBtn, (loading || !available) && styles.btnDisabled]}
          onPress={handleRecovery}
          disabled={loading || !available}
          activeOpacity={0.8}
        >
          {loading ? <ActivityIndicator color={color.onInk} /> : <Text style={styles.primaryBtnLabel}>{personal ? 'Reactivate my account' : 'Recover my profile'}</Text>}
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" style={styles.secondaryBtn} onPress={signOut} activeOpacity={0.7}>
          <Text style={styles.secondaryBtnLabel}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatusErrorScreen() {
  const { refreshAccountStatus } = useSession();
  const [retrying, setRetrying] = useState(false);

  async function handleRetry() {
    setRetrying(true);
    await refreshAccountStatus();
    setRetrying(false);
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.inner} bounces={false}>
        <Text style={styles.icon}>⚠️</Text>
        <Text style={styles.heading}>Couldn't verify your account</Text>
        <Text style={styles.body}>
          We were unable to confirm your account status. Please check your
          connection and try again.
        </Text>
        <TouchableOpacity
          style={[styles.primaryBtn, retrying && styles.btnDisabled]}
          onPress={handleRetry}
          disabled={retrying}
          activeOpacity={0.8}
        >
          {retrying ? (
            <ActivityIndicator color={color.onInk} />
          ) : (
            <Text style={styles.primaryBtnLabel}>Try again</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * AccountStatusGate — wraps the entire authenticated app tree.
 *
 * Behaviour:
 *  - Unauthenticated users pass straight through (auth stack renders normally).
 *  - Authenticated users wait behind a loading screen until the status is known
 *    so we never show the home screen before knowing the account is 'active'.
 *  - null (fetch failed) → show blocking retry screen — fail-closed: we cannot
 *    confirm the account is active so we do not let the user through.
 *  - 'deactivated'       → show reactivation interstitial.
 *  - 'pending_deletion'  → show cancellation interstitial.
 *  - 'active'            → render children.
 */
export function AccountStatusGate({ children }: PropsWithChildren) {
  const { isAuthed, accountStatus, accountStatusLoaded, reactivateUntil, selfRecoverableUntil } = useSession();

  if (!isAuthed) {
    return <>{children}</>;
  }

  if (!accountStatusLoaded) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={color.ink} />
        </View>
      </SafeAreaView>
    );
  }

  // Status fetch failed — cannot confirm account is active; block and offer retry.
  if (accountStatus === null) {
    return <StatusErrorScreen />;
  }

  if (accountStatus === 'pending_deletion') {
    return <RecoveryScreen kind="deletion" deadline={selfRecoverableUntil ?? null} />;
  }

  if (accountStatus === 'deactivated') {
    return <RecoveryScreen kind="deactivation" deadline={reactivateUntil ?? null} />;
  }

  // Only positively confirmed 'active' renders the app.
  // Any unknown future status routes to the error/retry screen.
  if (accountStatus === 'active') {
    return <>{children}</>;
  }

  return <StatusErrorScreen />;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  inner: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.xxl,
  },
  icon: {
    fontSize: 56,
    marginBottom: space.lg,
  },
  heading: {
    ...typeTokens.heading,
    fontSize: 22,
    textAlign: 'center',
    color: color.ink,
    marginBottom: space.md,
  },
  body: {
    ...typeTokens.body,
    fontSize: 15,
    textAlign: 'center',
    color: color.mute,
    lineHeight: 22,
    marginBottom: space.sm,
  },
  dateHighlight: {
    color: color.ink,
    fontWeight: '600',
  },
  error: {
    fontSize: 13,
    color: color.signal,
    textAlign: 'center',
    marginBottom: space.md,
  },
  primaryBtn: {
    backgroundColor: color.ink,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    width: '100%',
    marginTop: space.lg,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  primaryBtnLabel: {
    color: color.onInk,
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryBtn: {
    marginTop: space.md,
    paddingVertical: 12,
    alignItems: 'center',
    width: '100%',
  },
  secondaryBtnLabel: {
    color: color.mute,
    fontSize: 15,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
