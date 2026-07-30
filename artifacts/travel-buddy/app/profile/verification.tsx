/**
 * Verification — shows the user's current verification status and lets them
 * submit a verification request. Uses the existing verification service which
 * talks to POST /api/verification/session and GET /api/verification/status.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, Linking, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, ShieldCheck, ShieldAlert, Shield, Clock, CheckCircle, XCircle, RefreshCw } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getVerificationStatus, createVerificationSession,
  type VerificationStatusResult, type VerificationLevel, type NormalizedVerificationStatus,
} from '../../src/services/verification';
import { PP, PP_LABEL } from '../../src/theme/passportTokens';
import { space } from '../../src/theme/tokens';

// ── Status helpers ────────────────────────────────────────────────────────────

const LEVEL_LABELS: Record<VerificationLevel, string> = {
  none:             'Not Verified',
  id_verified:      'ID Verified',
  id_selfie_verified: 'ID + Selfie Verified',
};

const LEVEL_COLORS: Record<VerificationLevel, string> = {
  none:             PP.inkMuted,
  id_verified:      '#2E7D5B',
  id_selfie_verified: '#1565C0',
};

const STATUS_LABELS: Record<NormalizedVerificationStatus, string> = {
  created:    'Session created',
  pending:    'Pending review',
  processing: 'Processing',
  verified:   'Verified',
  failed:     'Verification failed',
  expired:    'Session expired',
  canceled:   'Canceled',
};

const POLL_INTERVAL_MS = 4_000;
const ACTIVE_STATUSES: NormalizedVerificationStatus[] = ['created', 'pending', 'processing'];

function StatusIcon({ level }: { level: VerificationLevel }) {
  if (level === 'id_selfie_verified') return <ShieldCheck size={40} color="#1565C0" />;
  if (level === 'id_verified') return <ShieldCheck size={40} color="#2E7D5B" />;
  return <Shield size={40} color={PP.inkMuted} />;
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function VerificationScreen() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<VerificationStatusResult | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    const res = await getVerificationStatus();
    if (!aliveRef.current) return;
    if (res.ok) {
      setStatus(res.result);
      setFetchError(null);
    } else {
      setFetchError(res.error);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Poll while a session is active
  useEffect(() => {
    aliveRef.current = true;
    loadStatus();
    return () => {
      aliveRef.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [loadStatus]);

  useEffect(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    const rowStatus = status?.verificationRow?.status;
    if (rowStatus && ACTIVE_STATUSES.includes(rowStatus)) {
      pollTimer.current = setTimeout(() => loadStatus(true), POLL_INTERVAL_MS);
    }
  }, [status, loadStatus]);

  const handleStartVerification = async (level: 'id' | 'id_selfie') => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await createVerificationSession(level);
      if (!res.ok) {
        Alert.alert('Could not start verification', res.error);
        return;
      }
      const { redirectUrl } = res.result;
      if (redirectUrl) {
        // Open the provider redirect (mock deep link or real provider URL)
        const canOpen = await Linking.canOpenURL(redirectUrl).catch(() => false);
        if (canOpen) {
          await Linking.openURL(redirectUrl);
        } else {
          Alert.alert('Verification started', 'Your verification request has been submitted. Check back shortly for a status update.');
        }
      }
      // Reload status after kicking off
      await loadStatus();
    } finally {
      setSubmitting(false);
    }
  };

  const level = status?.verificationLevel ?? 'none';
  const row = status?.verificationRow ?? null;
  const isActive = row?.status ? ACTIVE_STATUSES.includes(row.status) : false;
  const isFailed = row?.status === 'failed' || row?.status === 'expired';
  const isVerified = level !== 'none';

  return (
    <View style={[v.root, { backgroundColor: PP.paper }]}>
      {/* Header */}
      <View style={[v.header, { paddingTop: Math.max(insets.top + space.sm, 54) }]}>
        <Pressable
          style={v.backBtn}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/passport' as any))}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={22} color={PP.ink} />
        </Pressable>
        <Text style={v.headerTitle}>Verification</Text>
        <Pressable
          style={v.refreshBtn}
          onPress={() => loadStatus()}
          disabled={refreshing || loading}
          hitSlop={8}
          accessibilityLabel="Refresh verification status"
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={PP.inkMuted} />
          ) : (
            <RefreshCw size={18} color={PP.inkMuted} />
          )}
        </Pressable>
      </View>

      {loading ? (
        <View style={v.center}>
          <ActivityIndicator color={PP.ink} size="large" />
        </View>
      ) : fetchError ? (
        <View style={v.center}>
          <ShieldAlert size={40} color={PP.seal} />
          <Text style={v.errorText}>{fetchError}</Text>
          <Pressable style={v.retryBtn} onPress={() => loadStatus()}>
            <Text style={v.retryBtnText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={v.content}>
          {/* Status card */}
          <View style={v.statusCard}>
            <StatusIcon level={level} />
            <Text style={[v.levelLabel, { color: LEVEL_COLORS[level] }]}>
              {LEVEL_LABELS[level]}
            </Text>
            {isVerified && status?.verifiedAt ? (
              <Text style={v.verifiedAt}>
                Verified {new Date(status.verifiedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </Text>
            ) : null}
          </View>

          {/* Current session row */}
          {row ? (
            <View style={v.section}>
              <Text style={v.sectionTitle}>LATEST REQUEST</Text>
              <View style={v.card}>
                <View style={v.sessionRow}>
                  {isActive ? (
                    <Clock size={18} color="#D97706" />
                  ) : row.status === 'verified' ? (
                    <CheckCircle size={18} color="#2E7D5B" />
                  ) : (
                    <XCircle size={18} color={PP.seal} />
                  )}
                  <View style={v.sessionBody}>
                    <Text style={v.sessionStatus}>
                      {STATUS_LABELS[row.status] ?? row.status}
                    </Text>
                    {row.failureReason ? (
                      <Text style={v.sessionHint}>
                        Reason: {row.failureReason.replace(/_/g, ' ')}
                      </Text>
                    ) : null}
                    {isActive ? (
                      <Text style={v.sessionHint}>Checking for updates…</Text>
                    ) : null}
                    <Text style={v.sessionDate}>
                      Submitted {new Date(row.createdAt).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </Text>
                  </View>
                </View>
              </View>
            </View>
          ) : null}

          {/* What verification unlocks */}
          <View style={v.section}>
            <Text style={v.sectionTitle}>WHAT YOU GET</Text>
            <View style={v.card}>
              {[
                { icon: '🛡️', text: 'Verified badge on your passport' },
                { icon: '🤝', text: 'Higher trust score for meetups' },
                { icon: '🌍', text: 'Access to verified-only features' },
              ].map((item, i, arr) => (
                <View key={item.text}>
                  <View style={v.benefitRow}>
                    <Text style={v.benefitIcon}>{item.icon}</Text>
                    <Text style={v.benefitText}>{item.text}</Text>
                  </View>
                  {i < arr.length - 1 && <View style={v.divider} />}
                </View>
              ))}
            </View>
          </View>

          {/* CTA */}
          {!isActive && (!isVerified || isFailed) ? (
            <View style={v.section}>
              <Text style={v.sectionTitle}>GET VERIFIED</Text>
              <Text style={v.ctaHint}>
                Choose a verification level. A basic ID check is quick; adding a selfie provides the highest trust level.
              </Text>
              <View style={v.ctaRow}>
                <Pressable
                  style={[v.ctaBtn, submitting && v.ctaBtnDisabled]}
                  onPress={() => handleStartVerification('id')}
                  disabled={submitting}
                  accessibilityRole="button"
                >
                  {submitting
                    ? <ActivityIndicator size="small" color={PP.paper} />
                    : <Text style={v.ctaBtnText}>ID Verification</Text>}
                </Pressable>
                <Pressable
                  style={[v.ctaBtn, v.ctaBtnPrimary, submitting && v.ctaBtnDisabled]}
                  onPress={() => handleStartVerification('id_selfie')}
                  disabled={submitting}
                  accessibilityRole="button"
                >
                  {submitting
                    ? <ActivityIndicator size="small" color={PP.paper} />
                    : <Text style={v.ctaBtnText}>ID + Selfie</Text>}
                </Pressable>
              </View>
            </View>
          ) : null}

          {isVerified && !isActive ? (
            <View style={v.section}>
              <Text style={v.ctaHint}>
                Your identity is verified. You can re-verify to upgrade your verification level.
              </Text>
              <Pressable
                style={[v.ctaBtn, submitting && v.ctaBtnDisabled]}
                onPress={() => handleStartVerification('id_selfie')}
                disabled={submitting}
                accessibilityRole="button"
              >
                {submitting
                  ? <ActivityIndicator size="small" color={PP.paper} />
                  : <Text style={v.ctaBtnText}>Re-verify (ID + Selfie)</Text>}
              </Pressable>
            </View>
          ) : null}

          <Text style={v.disclaimer}>
            Verification is handled securely. No document images are stored on our servers.
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

const v = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.lg, paddingBottom: space.md,
    borderBottomWidth: 1, borderBottomColor: PP.borderLight,
    backgroundColor: PP.paper,
  },
  backBtn: { padding: 4 },
  headerTitle: {
    flex: 1, textAlign: 'center',
    fontFamily: 'Courier', fontWeight: '700',
    fontSize: 17, color: PP.ink, letterSpacing: 0.5,
  },
  refreshBtn: { width: 30, alignItems: 'flex-end' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  errorText: { fontSize: 15, color: PP.seal, textAlign: 'center' },
  retryBtn: {
    paddingHorizontal: space.xl, paddingVertical: space.sm,
    backgroundColor: PP.ink, borderRadius: 20, marginTop: space.sm,
  },
  retryBtnText: { color: PP.paper, fontWeight: '700', fontSize: 14 },
  content: { padding: space.lg, gap: space.xl, paddingBottom: 60 },
  statusCard: {
    alignItems: 'center', gap: space.sm,
    backgroundColor: PP.paper, borderRadius: 16,
    borderWidth: 1, borderColor: PP.borderLight,
    padding: space.xl,
  },
  levelLabel: { fontFamily: 'Courier', fontSize: 18, fontWeight: '700', letterSpacing: 0.5 },
  verifiedAt: { fontSize: 13, color: PP.inkMuted },
  section: { gap: space.sm },
  sectionTitle: { ...PP_LABEL, fontSize: 10, color: PP.ink, letterSpacing: 2 },
  card: {
    backgroundColor: PP.paper,
    borderRadius: 12, borderWidth: 1, borderColor: PP.borderLight,
    overflow: 'hidden',
  },
  sessionRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    padding: space.md, gap: space.sm,
  },
  sessionBody: { flex: 1, gap: 3 },
  sessionStatus: { fontFamily: 'Courier', fontSize: 14, fontWeight: '700', color: PP.ink },
  sessionHint: { fontSize: 13, color: PP.inkMuted },
  sessionDate: { fontSize: 12, color: PP.inkMuted },
  divider: { height: 1, backgroundColor: PP.borderLight },
  benefitRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.md, paddingVertical: 12, gap: space.sm,
  },
  benefitIcon: { fontSize: 18, width: 28, textAlign: 'center' },
  benefitText: { fontSize: 14, color: PP.ink, flex: 1 },
  ctaHint: { fontSize: 14, color: PP.inkMuted, lineHeight: 20 },
  ctaRow: { flexDirection: 'row', gap: space.sm },
  ctaBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 12,
    backgroundColor: PP.ink, alignItems: 'center', justifyContent: 'center',
    minHeight: 48,
  },
  ctaBtnPrimary: { backgroundColor: '#1565C0' },
  ctaBtnDisabled: { opacity: 0.5 },
  ctaBtnText: {
    color: PP.paper, fontFamily: 'Courier',
    fontWeight: '700', fontSize: 14, letterSpacing: 0.3,
  },
  disclaimer: {
    fontSize: 12, color: PP.inkMuted, textAlign: 'center',
    lineHeight: 18, paddingHorizontal: space.lg,
  },
});
