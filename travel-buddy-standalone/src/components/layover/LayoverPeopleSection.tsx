/**
 * LayoverPeopleSection — opt-in city-level presence sharing + local
 * Rent-a-Buddy surfacing (booking stays in the marketplace flow).
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, Switch, Image, ScrollView } from 'react-native';
import { Users, Star, BadgeCheck } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { LayoverBuddy, PresenceTraveler } from '../../services/layover.ts';
import { primaryIdentityText } from '../../lib/displayIdentity.ts';

interface Props {
  city: string | null;
  shareEnabled: boolean;
  shareBusy: boolean;
  presenceCount: number;
  travelers: PresenceTraveler[];
  buddies: LayoverBuddy[];
  canEdit: boolean;
  onToggleShare: (enabled: boolean) => void;
  onOpenBuddy: (buddy: LayoverBuddy) => void;
}

function initials(name: string | null, handle: string | null): string {
  const src = primaryIdentityText({ name, handle }).replace(/^@/, '').trim() || '?';
  const parts = src.split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

export function LayoverPeopleSection({
  city, shareEnabled, shareBusy, presenceCount, travelers, buddies,
  canEdit, onToggleShare, onOpenBuddy,
}: Props) {
  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Users size={18} color={color.ink} />
        <Text style={styles.heading}>People{city ? ` in ${city}` : ''}</Text>
      </View>

      {/* Opt-in presence */}
      <View style={styles.shareRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.shareTitle}>Show me to other layover travelers</Text>
          <Text style={styles.shareDesc}>
            City-level only — never your exact location. You see others only while you're sharing too.
          </Text>
        </View>
        <Switch
          value={shareEnabled}
          disabled={!canEdit || shareBusy}
          onValueChange={onToggleShare}
          trackColor={{ true: color.deep, false: color.haze }}
        />
      </View>

      {shareEnabled && (
        <View style={styles.presenceBox}>
          {presenceCount > 0 ? (
            <>
              <View style={styles.avatarRow}>
                {travelers.slice(0, 6).map((p) => (
                  <View key={p.id} style={styles.avatarWrap}>
                    {p.avatarUrl
                      ? <Image source={{ uri: p.avatarUrl }} style={styles.avatar} />
                      : <View style={[styles.avatar, styles.avatarFallback]}><Text style={styles.avatarInitials}>{initials(p.name, p.handle)}</Text></View>}
                  </View>
                ))}
              </View>
              <Text style={styles.presenceText}>
                {presenceCount} {presenceCount === 1 ? 'traveler is' : 'travelers are'} also on a layover here
              </Text>
            </>
          ) : (
            <Text style={styles.presenceText}>No other shared layovers here right now — you're the first.</Text>
          )}
        </View>
      )}

      {/* Rent-a-Buddy */}
      {buddies.length > 0 && (
        <>
          <Text style={styles.buddyHead}>Local buddies for a few hours</Text>
          <Text style={styles.buddySub}>Booked through the regular Rent-a-Buddy flow</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.buddyRow}>
            {buddies.map((b) => (
              <Pressable key={b.id} style={styles.buddyCard} onPress={() => onOpenBuddy(b)}>
                {b.coverPhotoUrl
                  ? <Image source={{ uri: b.coverPhotoUrl }} style={styles.buddyPhoto} />
                  : <View style={[styles.buddyPhoto, styles.buddyPhotoFallback]}>
                      <Text style={styles.buddyPhotoInitials}>{initials(b.displayName, null)}</Text>
                    </View>}
                {b.availableDuringLayover && (
                  <View style={styles.availTag}><Text style={styles.availTagText}>free during your layover</Text></View>
                )}
                <View style={styles.buddyBody}>
                  <View style={styles.buddyNameRow}>
                    <Text style={styles.buddyName} numberOfLines={1}>{b.displayName ? primaryIdentityText({ displayName: b.displayName }) : 'Buddy'}</Text>
                    {b.verified && <BadgeCheck size={13} color={color.deep} />}
                  </View>
                  <View style={styles.buddyMeta}>
                    {b.averageRating != null && (
                      <View style={styles.ratingRow}>
                        <Star size={11} color={color.warn} fill={color.warn} />
                        <Text style={styles.metaStamp}>{Number(b.averageRating).toFixed(1)} ({b.reviewCount})</Text>
                      </View>
                    )}
                    {b.hourlyRateUsd != null && <Text style={styles.metaStamp}>${b.hourlyRateUsd}/hr</Text>}
                  </View>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card:      { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headRow:   { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading:   { ...t.heading, color: color.ink },

  shareRow:  { flexDirection: 'row', alignItems: 'center', gap: space.md },
  shareTitle:{ ...t.bodyStrong, color: color.ink },
  shareDesc: { ...t.small, color: color.faint, marginTop: 2 },

  presenceBox: { backgroundColor: color.paper, borderRadius: radius.md, padding: space.md, gap: space.sm },
  avatarRow: { flexDirection: 'row' },
  avatarWrap:{ marginRight: -8 },
  avatar:    { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: color.paperRaised },
  avatarFallback: { backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { ...t.stamp, color: color.onInk },
  presenceText: { ...t.small, color: color.mute },

  buddyHead: { ...t.bodyStrong, color: color.ink, marginTop: space.sm },
  buddySub:  { ...t.small, color: color.faint, marginTop: -4 },
  buddyRow:  { gap: space.md, paddingVertical: space.xs },
  buddyCard: { width: 150, backgroundColor: color.paper, borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: color.haze },
  buddyPhoto:{ width: '100%', height: 84 },
  buddyPhotoFallback: { backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  buddyPhotoInitials: { ...t.title, color: color.onInk },
  availTag:  { position: 'absolute', top: 6, left: 6, backgroundColor: color.success, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  availTagText: { fontSize: 9, fontWeight: '700', color: color.onInk, letterSpacing: 0.3 },
  buddyBody: { padding: space.sm, gap: 4 },
  buddyNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  buddyName: { ...t.small, fontWeight: '700', color: color.ink, flexShrink: 1 },
  buddyMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaStamp: { ...t.stamp, color: color.faint },
});
