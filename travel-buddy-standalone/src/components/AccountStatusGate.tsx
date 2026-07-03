import React, { useState, type PropsWithChildren } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, space, type as typeTokens } from '../theme/tokens';
import { useSession } from '../context/SessionContext';
import { reactivateAccount } from '../services/profile';

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

function DeactivatedScreen() {
  const { signOut, refreshAccountStatus } = useSession();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReactivate() {
    setLoading(true);
    setError(null);
    const result = await reactivateAccount();
    if (result.ok) {
      await refreshAccountStatus();
    } else {
      setError(result.message ?? 'Could not reactivate. Please try again.');
    }
    setLoading(false);
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.inner} bounces={false}>
        <Text style={styles.icon}>🔒</Text>
        <Text style={styles.heading}>Your account is deactivated</Text>
        <Text style={styles.body}>
          Your account is currently deactivated. Your profile and trips are hidden from other
          travelers. Tap below to restore your account instantly.
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.primaryBtn, loading && styles.btnDisabled]}
          onPress={handleReactivate}
          disabled={loading}
          activeOpacity={0.8}
        >
          {loading ? (
            <ActivityIndicator color={color.onInk} />
          ) : (
            <Text style={styles.primaryBtnLabel}>Reactivate my account</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryBtn} onPress={signOut} activeOpacity={0.7}>
          <Text style={styles.secondaryBtnLabel}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function PendingDeletionScreen({ scheduledAt }: { scheduledAt: string | null }) {
  const { signOut, refreshAccountStatus } = useSession();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCancelDeletion() {
    setLoading(true);
    setError(null);
    const result = await reactivateAccount();
    if (result.ok) {
      await refreshAccountStatus();
    } else {
      setError(result.message ?? 'Could not cancel deletion. Please try again.');
    }
    setLoading(false);
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.inner} bounces={false}>
        <Text style={styles.icon}>⚠️</Text>
        <Text style={styles.heading}>Account scheduled for deletion</Text>
        <Text style={styles.body}>
          Your account is scheduled to be permanently deleted on{' '}
          <Text style={styles.dateHighlight}>{formatDate(scheduledAt)}</Text>. After that date,
          your profile, trips, and stamps cannot be recovered.
        </Text>
        <Text style={styles.body}>
          Changed your mind? Tap below to cancel the deletion and restore your account.
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.primaryBtn, loading && styles.btnDisabled]}
          onPress={handleCancelDeletion}
          disabled={loading}
          activeOpacity={0.8}
        >
          {loading ? (
            <ActivityIndicator color={color.onInk} />
          ) : (
            <Text style={styles.primaryBtnLabel}>Cancel deletion</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryBtn} onPress={signOut} activeOpacity={0.7}>
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
  const { isAuthed, accountStatus, accountStatusLoaded, deletionScheduledAt } = useSession();

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
    return <PendingDeletionScreen scheduledAt={deletionScheduledAt} />;
  }

  if (accountStatus === 'deactivated') {
    return <DeactivatedScreen />;
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
