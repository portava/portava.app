/**
 * VerifiedBadge — the identity-verified badge (census-trust TV-0e / TV-2c).
 *
 * Teal = the person's identity check is approved (`id`); gold = identity check
 * plus a selfie match (`id_selfie`). It renders ONLY from the server's
 * `identityBadge` — the one definition of a CURRENT verification
 * (`services/identityVerification/verifiedBadges.ts`): most recent finished
 * check approved, not a test check, not withdrawn. Never from the legacy
 * `profiles.verified` boolean, which the identity pipeline does not write.
 *
 * OD-TRUST-3 (owner, 2026-10-04): "for a defined, current verification state
 * only. Make criteria visible; don't sell the badge or present it as an
 * endorsement." So a tap opens the criteria and the statement — word for word
 * the server's (parity: verifiedBadgeCriteriaParity.test.ts) — and nothing here
 * links to buying, upgrading or ranking.
 *
 * Absent / null / an unknown tier → renders nothing (a badge is a claim; an
 * unrecognised one is not made).
 */
import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { ShieldCheck } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';

export type VerifiedBadgeTier = 'id' | 'id_selfie';
export interface IdentityBadge { tier: VerifiedBadgeTier }

/** Word for word `VERIFIED_BADGE_PUBLIC_CRITERIA` in services/identityVerification/verifiedBadges.ts. */
export const VERIFIED_BADGE_PUBLIC_CRITERIA: readonly string[] = [
  'Their most recent identity check with our verification provider was approved.',
  'The check used a government-issued ID, and was not a test or practice check.',
  'Their verification has not been withdrawn.',
];

/** Word for word `VERIFIED_BADGE_PUBLIC_STATEMENT` there. */
export const VERIFIED_BADGE_PUBLIC_STATEMENT =
  'Verified means this person passed an identity check. It is not an endorsement, and it cannot be bought.';

/** Teal and gold, as the Verified Foundation plan specifies. */
export const BADGE_TIER_COLOR: Record<VerifiedBadgeTier, string> = {
  id: '#0F7C7A',
  id_selfie: color.warn,
};

const TIER_LABEL: Record<VerifiedBadgeTier, string> = {
  id: 'ID verified',
  id_selfie: 'ID and selfie verified',
};

/** The badge to draw, or null. Defensive: the value arrives over the wire. */
export function readIdentityBadge(raw: unknown): IdentityBadge | null {
  if (!raw || typeof raw !== 'object') return null;
  const tier = (raw as { tier?: unknown }).tier;
  return tier === 'id' || tier === 'id_selfie' ? { tier } : null;
}

export interface VerifiedBadgeProps {
  badge: unknown;
  size?: number;
  testID?: string;
}

export function VerifiedBadge({ badge, size = 14, testID }: VerifiedBadgeProps) {
  const [open, setOpen] = useState(false);
  const b = readIdentityBadge(badge);
  if (!b) return null;
  const label = TIER_LABEL[b.tier];
  return (
    <>
      <Pressable
        onPress={(e) => { e?.stopPropagation?.(); setOpen(true); }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${label}. Shows what this means.`}
        testID={testID ?? `verified-badge-${b.tier}`}
        style={styles.badge}
      >
        <ShieldCheck size={size} color={BADGE_TIER_COLOR[b.tier]} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setOpen(false)} accessibilityLabel="Close">
          <View style={styles.sheet} testID="verified-badge-criteria">
            <View style={styles.titleRow}>
              <ShieldCheck size={18} color={BADGE_TIER_COLOR[b.tier]} />
              <Text style={styles.title}>{label}</Text>
            </View>
            {VERIFIED_BADGE_PUBLIC_CRITERIA.map((c) => (
              <Text key={c} style={styles.criterion}>{`• ${c}`}</Text>
            ))}
            <Text style={styles.statement}>{VERIFIED_BADGE_PUBLIC_STATEMENT}</Text>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  badge: { marginLeft: 3, justifyContent: 'center' },
  scrim: { flex: 1, backgroundColor: 'rgba(17,17,15,0.45)', justifyContent: 'center', padding: space.lg },
  sheet: { backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.body, color: color.ink, fontWeight: '700' },
  criterion: { ...t.small, color: color.ink },
  statement: { ...t.small, color: color.mute, marginTop: space.xs },
});
