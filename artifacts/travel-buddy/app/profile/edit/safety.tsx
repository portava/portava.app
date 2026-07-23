/**
 * Safety & Verification — Edit Profile & Settings sub-page.
 *
 * Read-only ID-verification status cards (from getMyProfile — no invented data),
 * then navigation rows to the EXISTING Blocked / Muted / Restricted screens,
 * Emergency Contacts, and a link to Location & Availability (Safe Return lives
 * in location prefs, so we link rather than duplicate the toggle).
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
  ShieldCheck, ShieldOff, Clock, BadgeCheck, ScanFace, Globe,
  UserX, VolumeX, EyeOff, LifeBuoy, MapPin, Award,
} from 'lucide-react-native';
import {
  SettingsScreen, SettingsSection, SettingsRow, SettingsDivider,
} from '../../../src/components/settings/SettingsUI';
import { Flag } from 'lucide-react-native';
import { PP } from '../../../src/theme/passportTokens';
import { space, radius, type as t } from '../../../src/theme/tokens';
import { getMyProfile } from '../../../src/services/profile';
import type { OwnProfile } from '../../../src/types/models';

const VERIF_STATUS_LABEL: Record<OwnProfile['verificationStatus'], { label: string; tone: 'ok' | 'pending' | 'off' }> = {
  unverified: { label: 'Not verified', tone: 'off' },
  pending:    { label: 'Verification pending', tone: 'pending' },
  verified:   { label: 'Verified', tone: 'ok' },
  rejected:   { label: 'Verification rejected', tone: 'off' },
  expired:    { label: 'Verification expired', tone: 'off' },
};

const LEVEL_LABEL: Record<NonNullable<OwnProfile['verificationLevel']>, string> = {
  none: 'None',
  basic_verified: 'Basic verified',
  trusted_traveler: 'Trusted traveler',
  host_verified: 'Host verified',
  buddy_verified: 'Buddy verified',
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '—';
  }
}

export default function SafetyVerificationScreen() {
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await getMyProfile();
      if (!alive) return;
      setLoading(false);
      if (res.ok && res.data) setProfile(res.data);
      else setLoadError(res.message ?? 'Could not load verification status');
    })();
    return () => { alive = false; };
  }, []);

  return (
    <SettingsScreen title="Safety & Verification" subtitle="Verification, blocked users, emergency contacts">
      {/* Verification status (read-only) */}
      <SettingsSection title="Identity Verification">
        {loading ? (
          <View style={sx.loading}><ActivityIndicator color={PP.ink} /></View>
        ) : loadError ? (
          <View style={sx.loading}><Text style={sx.errorText}>{loadError}</Text></View>
        ) : profile ? (
          <VerificationCards profile={profile} />
        ) : null}
      </SettingsSection>

      {profile && !loading && (
        <Text style={sx.note}>
          Verification is reviewed by our safety team. Statuses shown here reflect your latest review.
        </Text>
      )}

      {/* People controls — existing screens */}
      <SettingsSection title="People">
        <SettingsRow
          icon={<UserX size={18} color={PP.ink} />}
          title="Blocked Users"
          subtitle="Accounts you've blocked"
          onPress={() => router.push('/blocked-users' as any)}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<VolumeX size={18} color={PP.ink} />}
          title="Muted Users"
          subtitle="Accounts whose activity you've muted"
          onPress={() => router.push('/muted-users' as any)}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<EyeOff size={18} color={PP.ink} />}
          title="Restricted Users"
          subtitle="Accounts with limited access to you"
          onPress={() => router.push('/restricted-users' as any)}
        />
      </SettingsSection>

      {/* Report history */}
      <SettingsSection title="Reports">
        <SettingsRow
          icon={<Flag size={18} color={PP.ink} />}
          title="Your Reports"
          subtitle="Reports you've submitted for review"
          onPress={() => router.push('/profile/edit/reports' as any)}
        />
      </SettingsSection>

      {/* Safety features */}
      <SettingsSection title="Safety">
        <SettingsRow
          icon={<LifeBuoy size={18} color={PP.ink} />}
          title="Emergency Contacts"
          subtitle="People we can reach if something goes wrong"
          onPress={() => router.push('/profile/edit/emergency-contacts' as any)}
        />
        <SettingsDivider />
        <SettingsRow
          icon={<MapPin size={18} color={PP.ink} />}
          title="Safe Return"
          subtitle="Manage in Location & Availability"
          onPress={() => router.push('/profile/edit/location' as any)}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}

function VerificationCards({ profile }: { profile: OwnProfile }) {
  const status = VERIF_STATUS_LABEL[profile.verificationStatus] ?? VERIF_STATUS_LABEL.unverified;
  const StatusIcon = status.tone === 'ok' ? ShieldCheck : status.tone === 'pending' ? Clock : ShieldOff;
  const statusColor = status.tone === 'ok' ? PP.inkLight : status.tone === 'pending' ? PP.gold : PP.inkMuted;

  const level = profile.verificationLevel && profile.verificationLevel !== 'none'
    ? LEVEL_LABEL[profile.verificationLevel]
    : null;

  return (
    <>
      <SettingsRow
        icon={<StatusIcon size={18} color={statusColor} />}
        title={status.label}
        subtitle={profile.verifiedAt ? `Verified ${fmtDate(profile.verifiedAt)}` : 'Complete verification to build trust'}
        chevron={false}
      />

      {level && (
        <>
          <SettingsDivider />
          <SettingsRow
            icon={<Award size={18} color={PP.gold} />}
            title="Verification level"
            subtitle={level}
            chevron={false}
          />
        </>
      )}

      {profile.trustLabel ? (
        <>
          <SettingsDivider />
          <SettingsRow
            icon={<BadgeCheck size={18} color={PP.inkLight} />}
            title="Trust"
            subtitle={
              profile.trustScore != null
                ? `${profile.trustLabel} · Score ${profile.trustScore}`
                : profile.trustLabel
            }
            chevron={false}
          />
        </>
      ) : null}

      <SettingsDivider />
      <SettingsRow
        icon={<BadgeCheck size={18} color={profile.idVerifiedAt ? PP.inkLight : PP.inkMuted} />}
        title="ID document"
        subtitle={profile.idVerifiedAt ? `Verified ${fmtDate(profile.idVerifiedAt)}` : 'Not verified'}
        chevron={false}
      />
      <SettingsDivider />
      <SettingsRow
        icon={<ScanFace size={18} color={profile.selfieVerifiedAt ? PP.inkLight : PP.inkMuted} />}
        title="Selfie check"
        subtitle={profile.selfieVerifiedAt ? `Verified ${fmtDate(profile.selfieVerifiedAt)}` : 'Not verified'}
        chevron={false}
      />
      <SettingsDivider />
      <SettingsRow
        icon={<Globe size={18} color={profile.homeCountryVerifiedAt ? PP.inkLight : PP.inkMuted} />}
        title="Home country"
        subtitle={profile.homeCountryVerifiedAt ? `Verified ${fmtDate(profile.homeCountryVerifiedAt)}` : 'Not verified'}
        chevron={false}
      />
    </>
  );
}

const sx = StyleSheet.create({
  loading: { padding: space.xl, alignItems: 'center' },
  errorText: { ...t.body, color: PP.inkMuted, textAlign: 'center' },
  note: {
    ...t.small, color: PP.inkMuted, fontSize: 11, lineHeight: 15,
    textAlign: 'center', paddingHorizontal: space.md,
  },
});
