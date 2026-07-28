/**
 * BeforeYouGoSection — "Before you go" wrapper shown near the top of every
 * trip detail screen.
 *
 * Groups TripEntrySection (visa / entry requirements) and
 * TripCountryEssentialsSection (plugs, drive side, emergency numbers) under a
 * single prominent section header so travellers can't miss the info.
 *
 * Always renders the header. Shows a helpful passport-setup nudge when both
 * sub-sections report they have no content (feature flag off, no passport, or
 * country not yet covered).
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Luggage } from 'lucide-react-native';
import { color, space, type as t } from '../../theme/tokens.ts';
import { TripEntrySection } from './TripEntrySection.tsx';
import { TripCountryEssentialsSection } from './TripCountryEssentialsSection.tsx';

interface Props {
  tripId: string;
}

export function BeforeYouGoSection({ tripId }: Props) {
  // Track whether each sub-section has finished loading and has content.
  const [entryLoaded,      setEntryLoaded]      = useState(false);
  const [essentialsLoaded, setEssentialsLoaded] = useState(false);
  const [entryHas,         setEntryHas]         = useState(false);
  const [essentialsHas,    setEssentialsHas]    = useState(false);

  const bothLoaded    = entryLoaded && essentialsLoaded;
  const hasAnyContent = entryHas || essentialsHas;

  return (
    <View>
      {/* ── Section header — always visible ─────────────────────────── */}
      <View style={styles.header}>
        <Luggage size={15} color={color.signal} />
        <Text style={styles.headerText}>Before you go</Text>
      </View>

      {/* ── Sub-sections fill in asynchronously ─────────────────────── */}
      <TripEntrySection
        tripId={tripId}
        onLoad={(has) => { setEntryLoaded(true); setEntryHas(has); }}
      />
      <TripCountryEssentialsSection
        tripId={tripId}
        onLoad={(has) => { setEssentialsLoaded(true); setEssentialsHas(has); }}
      />

      {/* ── Fallback — only when both have finished loading with nothing ─ */}
      {bothLoaded && !hasAnyContent && (
        <View style={styles.fallback}>
          <Text style={styles.fallbackTitle}>Passport &amp; entry info</Text>
          <Text style={styles.fallbackSub}>
            Add a passport in your profile to see visa and entry requirements for
            this destination. Country-specific travel info (plug types, emergency
            numbers) is being added for more destinations over time.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginHorizontal: space.lg,
    marginTop: space.xl,
    marginBottom: space.sm,
  },
  headerText: {
    ...t.title,
    color: color.ink,
    fontSize: 18,
  },
  fallback: {
    marginHorizontal: space.lg,
    marginTop: space.sm,
    marginBottom: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
  },
  fallbackTitle: {
    ...t.bodyStrong,
    color: color.ink,
  },
  fallbackSub: {
    ...t.small,
    color: color.mute,
    lineHeight: 18,
  },
});
