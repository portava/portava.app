/**
 * Account — email display, account status, reactivate/deactivate/delete flows,
 * and log out. All confirmation flows are preserved verbatim from
 * app/settings/index.tsx. Delete uses a two-step confirmation inside a
 * danger-zone card. No unsaved guard (no form fields).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, Alert, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { LogOut, Mail } from 'lucide-react-native';
import { supabase } from '../../../src/lib/supabase';
import { useSession } from '../../../src/context/SessionContext';
import {
  SettingsScreen, SettingsSection, SettingsRow, SettingsDivider,
} from '../../../src/components/settings/SettingsUI';
import { PP } from '../../../src/theme/passportTokens';
import { space, radius, type as t } from '../../../src/theme/tokens';
import {
  getAccountStatus, deactivateAccount, reactivateAccount, requestAccountDeletion,
  type AccountStatus,
} from '../../../src/services/profile';

export default function AccountScreen() {
  const { signOut, isAuthed, configured } = useSession();
  const live = configured && isAuthed;

  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setEmail(data.session?.user?.email ?? null);
    });
    getAccountStatus().then((res) => {
      if (!alive) return;
      if (res.ok && res.data) setAccountStatus(res.data.accountStatus);
      setLoading(false);
    }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // ── Confirmation flows — copied verbatim from settings/index.tsx ──────────

  const handleDeactivate = useCallback(() => {
    Alert.alert(
      'Deactivate account?',
      'Your profile will be hidden from other users. You can reactivate by signing back in.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate', style: 'destructive',
          onPress: async () => {
            const res = await deactivateAccount();
            if (res.ok) {
              await signOut();
              router.replace('/(auth)/sign-in');
            } else {
              Alert.alert('Error', res.message ?? 'Could not deactivate. Try again.');
            }
          },
        },
      ],
    );
  }, [signOut]);

  const handleReactivate = useCallback(() => {
    Alert.alert(
      'Reactivate account?',
      'Your profile will become visible to other users again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reactivate',
          onPress: async () => {
            const res = await reactivateAccount();
            if (res.ok) {
              setAccountStatus('active');
              Alert.alert('Account reactivated', 'Your profile is now visible to other users.');
            } else {
              const msg = res.errorKind === 'forbidden'
                ? 'This account cannot be self-reactivated. Please contact support.'
                : (res.message ?? 'Could not reactivate. Try again.');
              Alert.alert('Error', msg);
            }
          },
        },
      ],
    );
  }, []);

  // Delete — two-step confirmation. First Alert, then a second confirm before
  // hitting requestAccountDeletion (whose success flow is copied verbatim).
  const handleRequestDeletion = useCallback(() => {
    Alert.alert(
      'Request account deletion?',
      'Your account will be permanently deleted within 30 days. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue', style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Are you absolutely sure?',
              'This permanently deletes your account and all your data within 30 days. This action cannot be undone.',
              [
                { text: 'Keep my account', style: 'cancel' },
                {
                  text: 'Delete my account', style: 'destructive',
                  onPress: async () => {
                    const res = await requestAccountDeletion();
                    if (res.ok) {
                      Alert.alert('Request submitted', 'We will contact you to confirm. Your account will be deleted within 30 days.');
                    } else {
                      Alert.alert('Error', res.message ?? 'Could not submit request. Try again.');
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }, []);

  const handleLogout = useCallback(async () => {
    await signOut();
    router.replace('/(auth)/sign-in');
  }, [signOut]);

  if (loading) {
    return (
      <SettingsScreen title="Account">
        <View style={styles.loading}><ActivityIndicator color={PP.ink} size="large" /></View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title="Account" subtitle="Email, status & danger zone">
      <SettingsSection title="Sign In">
        <SettingsRow
          icon={<Mail size={18} color={PP.ink} />}
          title="Email"
          subtitle={email ?? 'Not available'}
          chevron={false}
        />
      </SettingsSection>

      {live && (
        <>
          <SettingsSection title="Account Status">
            {accountStatus === 'deactivated' ? (
              <SettingsRow
                title="Reactivate account"
                subtitle="Your profile is currently hidden from other users"
                onPress={handleReactivate}
              />
            ) : (
              <SettingsRow
                title="Deactivate account"
                subtitle="Hide your profile from other users"
                onPress={handleDeactivate}
              />
            )}
            <SettingsDivider />
            <SettingsRow
              icon={<LogOut size={18} color={PP.seal} />}
              title="Log out"
              danger
              onPress={handleLogout}
              chevron={false}
            />
          </SettingsSection>

          <View style={styles.dangerCard}>
            <Text style={styles.dangerTitle}>Danger Zone</Text>
            <Text style={styles.dangerDesc}>
              Permanently delete your account and all your data. This cannot be undone.
            </Text>
            <Pressable
              style={({ pressed }) => [styles.dangerBtn, pressed && { opacity: 0.8 }]}
              onPress={handleRequestDeletion}
              accessibilityRole="button"
              accessibilityLabel="Delete account"
            >
              <Text style={styles.dangerBtnText}>Delete account</Text>
            </Pressable>
          </View>
        </>
      )}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: space.xxxl, alignItems: 'center' },
  dangerCard: {
    backgroundColor: PP.sealLight,
    borderRadius: radius.md,
    borderWidth: 1.5, borderColor: PP.seal,
    padding: space.lg, gap: space.sm,
  },
  dangerTitle: {
    fontFamily: 'Courier', fontSize: 11, fontWeight: '700',
    color: PP.seal, letterSpacing: 1.4, textTransform: 'uppercase',
  },
  dangerDesc: { ...t.small, color: PP.ink, fontSize: 12, lineHeight: 17 },
  dangerBtn: {
    marginTop: space.xs, backgroundColor: PP.seal, borderRadius: radius.pill,
    paddingVertical: 12, alignItems: 'center', justifyContent: 'center', minHeight: 44,
  },
  dangerBtnText: { ...t.bodyStrong, color: PP.paper, fontWeight: '700' },
});
