import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Plane, ShieldCheck } from 'lucide-react-native';
import type { OwnProfile } from '../types/models';
import { isTravelBuddyVerified } from '../lib/verification';

/**
 * About tab — secondary profile information relocated out of the header.
 * Side-by-side passport-detail rows per the reference design. Renders only
 * fields that exist; never shows placeholder values.
 */

const INTEREST_LABEL: Record<string, string> = {
  nightlife: 'Nightlife', food: 'Food', beach: 'Beach', luxury: 'Luxury',
  culture: 'Culture', adventure: 'Adventure', wellness: 'Wellness',
  photography: 'Photography', backpacking: 'Backpacking', shopping: 'Shopping',
  business: 'Business', dating: 'Social', events: 'Events',
};

function fmtMemberSince(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

function Row({ label, value, right }: { label: string; value?: string; right?: React.ReactNode }) {
  if (!value && !right) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {right ?? <Text style={styles.rowValue} numberOfLines={2}>{value}</Text>}
    </View>
  );
}

export function PassportAbout({
  profile,
  countriesVisited,
  citiesVisited,
  tripsCompleted,
  stampsCount,
  trustScore,
  trustLabel,
}: {
  profile: OwnProfile;
  countriesVisited?: number | null;
  citiesVisited?: number | null;
  tripsCompleted?: number | null;
  stampsCount?: number | null;
  trustScore?: number | null;
  trustLabel?: string | null;
}) {
  const interests = (profile.interests ?? []).map((i) => INTEREST_LABEL[i] ?? i);
  const travelStyles = (profile.travelStyles ?? []).filter(Boolean);
  const languages = (profile.spokenLanguages ?? []).filter(Boolean);
  const home = [profile.homeCity, profile.homeCountry].filter(Boolean).join(', ');
  const memberSince = fmtMemberSince(profile.createdAt);
  const isVerified = isTravelBuddyVerified(profile);
  const safeTrust = trustScore != null ? Math.min(100, Math.max(0, Math.round(trustScore))) : null;
  const availabilityTags = (profile.availabilityTags ?? []).filter(Boolean);

  return (
    <View style={styles.wrap}>
      {profile.bio ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>About Me</Text>
          <Text style={styles.bio}>{profile.bio}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Traveler Profile</Text>
        <Row label="Travel Style" value={travelStyles.join(', ')} />
        <Row label="Interests" value={interests.join(', ')} />
        <Row label="Languages" value={languages.join(', ')} />
        <Row label="Home" value={home} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Passport Details</Text>
        <Row label="Member Since" value={memberSince} />
        <Row
          label="Countries Visited"
          value={countriesVisited != null && countriesVisited > 0 ? String(countriesVisited) : ''}
        />
        <Row
          label="Cities Visited"
          value={citiesVisited != null && citiesVisited > 0 ? String(citiesVisited) : ''}
        />
        <Row
          label="Trips Completed"
          value={tripsCompleted != null && tripsCompleted > 0 ? String(tripsCompleted) : ''}
        />
        <Row
          label="Passport Stamps"
          value={stampsCount != null && stampsCount > 0 ? String(stampsCount) : ''}
        />
        {isVerified ? (
          <Row
            label="Verification"
            right={
              <View style={styles.verifiedRow}>
                <Text style={styles.verifiedText}>Verified Traveler</Text>
                <View style={styles.verifiedStamp} accessibilityLabel="Verified traveler">
                  <Plane size={10} color="#2383F7" strokeWidth={2.2} />
                </View>
              </View>
            }
          />
        ) : null}
      </View>

      {safeTrust != null ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Trust & Verification</Text>
          <View style={styles.trustRow}>
            <ShieldCheck size={18} color="#159447" strokeWidth={2.2} />
            <Text style={styles.trustLabel}>Trust Score</Text>
            <Text style={styles.trustValue}>{safeTrust} <Text style={styles.trustOutOf}>/ 100</Text></Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${safeTrust}%` }]} />
          </View>
          {trustLabel ? <Text style={styles.trustCaption}>{trustLabel}</Text> : null}
        </View>
      ) : null}

      {(typeof profile.openToMeet === 'boolean' || availabilityTags.length > 0) ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Travel Availability</Text>
          {typeof profile.openToMeet === 'boolean' ? (
            <Row
              label="Open to meet travelers"
              right={
                <Text style={[styles.availValue, { color: profile.openToMeet ? '#159447' : '#667085' }]}>
                  {profile.openToMeet ? 'Yes' : 'No'}
                </Text>
              }
            />
          ) : null}
          {availabilityTags.length > 0 ? (
            <Row label="Availability" value={availabilityTags.join(', ')} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 16, gap: 12 },
  card: {
    borderRadius: 16, borderWidth: 1, borderColor: '#EAECF0',
    backgroundColor: '#FFFFFF', padding: 14, gap: 11,
  },
  cardTitle: { fontSize: 18, lineHeight: 23, fontWeight: '700', color: '#101828' },
  bio: { fontSize: 14, lineHeight: 20, color: '#344054' },
  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    justifyContent: 'space-between', gap: 16,
  },
  rowLabel: { fontSize: 13.5, color: '#667085' },
  rowValue: { flex: 1, fontSize: 13.5, fontWeight: '600', color: '#344054', textAlign: 'right' },

  verifiedRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  verifiedText: { fontSize: 13.5, fontWeight: '600', color: '#344054' },
  verifiedStamp: {
    width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#2383F7', backgroundColor: 'rgba(35,131,247,0.06)',
    transform: [{ rotate: '-8deg' }],
  },

  trustRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  trustLabel: { flex: 1, fontSize: 13.5, color: '#667085' },
  trustValue: { fontSize: 15, fontWeight: '700', color: '#159447' },
  trustOutOf: { fontSize: 12, fontWeight: '500', color: '#344054' },
  progressTrack: { height: 3, borderRadius: 999, backgroundColor: '#E4E7EC', overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 999, backgroundColor: '#159447' },
  trustCaption: { fontSize: 12, fontWeight: '600', color: '#159447' },

  availValue: { fontSize: 13.5, fontWeight: '700' },
});
