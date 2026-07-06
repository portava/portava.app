import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { ShieldCheck, Shield, Check, XCircle } from 'lucide-react-native';
import { color, space, radius } from '../theme/tokens';

export const VERIFY_TEAL = '#0D9B6F';
export const VERIFY_TEAL_DIM = 'rgba(13,155,111,0.55)';
export const VERIFY_TEAL_BG = 'rgba(13,155,111,0.10)';

type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected' | 'expired';

export interface PassportVerificationStampProps {
  status: VerificationStatus;
  verifiedSince?: string | null;
  idVerified?: boolean;
  selfieMatched?: boolean;
  homeCountryVerified?: boolean;
  noSafetyFlags?: boolean;
  isOwner?: boolean;
  onStartVerification?: () => void;
  onReviewDetails?: () => void;
}

function fmtMonthYear(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

function CheckRow({ label, checked }: { label: string; checked: boolean }) {
  return (
    <View style={s.checkRow}>
      <Text style={s.checkLabel}>{label}</Text>
      <View style={[s.checkBadge, checked && s.checkBadgeActive]}>
        <Check size={9} color={checked ? VERIFY_TEAL : 'rgba(250,249,246,0.25)'} strokeWidth={2.5} />
      </View>
    </View>
  );
}

export function PassportVerificationStamp({
  status,
  verifiedSince,
  idVerified = false,
  selfieMatched = false,
  homeCountryVerified = false,
  noSafetyFlags = true,
  isOwner = false,
  onStartVerification,
  onReviewDetails,
}: PassportVerificationStampProps) {
  if (status === 'verified') {
    return (
      <View style={s.stampCard}>
        <View style={s.innerBorder}>
          <Text style={s.eyebrow}>PASSPORT VERIFIED</Text>

          <View style={s.titleRow}>
            <ShieldCheck size={40} color={VERIFY_TEAL} strokeWidth={1.5} />
            <View style={s.titleBlock}>
              <Text style={s.stampTitle}>VERIFIED TRAVELER</Text>
              <Text style={s.stars}>★★★★★</Text>
            </View>
          </View>

          <View style={s.dividerLine} />

          <View style={s.checkList}>
            <CheckRow label="ID Verified" checked={idVerified} />
            <CheckRow label="Selfie Matched" checked={selfieMatched} />
            <CheckRow label="Home Country Verified" checked={homeCountryVerified} />
            <CheckRow label="No Safety Flags" checked={noSafetyFlags} />
          </View>

          {verifiedSince ? (
            <Text style={s.since}>Verified since {fmtMonthYear(verifiedSince)}</Text>
          ) : null}
        </View>
      </View>
    );
  }

  if (status === 'pending') {
    if (!isOwner) return null;
    return (
      <View style={[s.stampCard, s.mutedCard]}>
        <View style={s.pendingInner}>
          <Shield size={26} color="rgba(250,249,246,0.35)" strokeWidth={1.5} />
          <View>
            <Text style={s.pendingTitle}>VERIFICATION PENDING</Text>
            <Text style={s.pendingBody}>Review in progress</Text>
          </View>
        </View>
      </View>
    );
  }

  if (status === 'rejected') {
    if (!isOwner) return null;
    return (
      <View style={[s.stampCard, s.mutedCard]}>
        <View style={s.actionInner}>
          <XCircle size={22} color={color.signal} />
          <Text style={s.actionTitle}>Verification needs attention</Text>
          <Text style={s.actionBody}>Review your details to complete Passport verification.</Text>
          {onReviewDetails ? (
            <Pressable style={s.actionBtn} onPress={onReviewDetails}>
              <Text style={s.actionBtnText}>Review Details</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  if (isOwner) {
    return (
      <View style={[s.stampCard, s.ctaCard]}>
        <View style={s.actionInner}>
          <Shield size={22} color={VERIFY_TEAL} strokeWidth={1.5} />
          <Text style={s.actionTitle}>Verify your Passport</Text>
          <Text style={s.actionBody}>
            Unlock verified traveler trust across events, trips, Telegraph, and Rent a Buddy.
          </Text>
          {onStartVerification ? (
            <Pressable style={s.startBtn} onPress={onStartVerification}>
              <Text style={s.startBtnText}>Start Verification</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  return null;
}

const s = StyleSheet.create({
  stampCard: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    borderRadius: radius.md,
    backgroundColor: '#0D110F',
    borderWidth: 1.5,
    borderColor: VERIFY_TEAL_DIM,
    padding: 14,
  },
  innerBorder: {
    borderWidth: 1,
    borderColor: 'rgba(13,155,111,0.22)',
    borderStyle: 'dashed',
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  eyebrow: {
    fontFamily: 'Courier',
    fontSize: 9,
    letterSpacing: 2.5,
    color: VERIFY_TEAL,
    fontWeight: '700',
    textAlign: 'center',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  titleBlock: {
    gap: 3,
  },
  stampTitle: {
    fontFamily: 'Courier',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: '#FAF9F6',
  },
  stars: {
    fontSize: 13,
    color: VERIFY_TEAL,
    letterSpacing: 3,
  },
  dividerLine: {
    height: 1,
    backgroundColor: 'rgba(13,155,111,0.18)',
    marginVertical: 2,
  },
  checkList: {
    gap: 7,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  checkLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: 'rgba(250,249,246,0.82)',
    letterSpacing: 0.1,
  },
  checkBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(250,249,246,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBadgeActive: {
    borderColor: VERIFY_TEAL,
    backgroundColor: VERIFY_TEAL_BG,
  },
  since: {
    fontFamily: 'Courier',
    fontSize: 9,
    letterSpacing: 1,
    color: 'rgba(250,249,246,0.4)',
    textAlign: 'center',
    marginTop: 2,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(250,249,246,0.07)',
  },

  mutedCard: {
    borderColor: 'rgba(250,249,246,0.12)',
    backgroundColor: 'rgba(17,17,15,0.85)',
  },
  ctaCard: {
    borderColor: VERIFY_TEAL_DIM,
    backgroundColor: '#071310',
  },

  pendingInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 4,
  },
  pendingTitle: {
    fontFamily: 'Courier',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: 'rgba(250,249,246,0.55)',
  },
  pendingBody: {
    fontSize: 12,
    color: 'rgba(250,249,246,0.35)',
    marginTop: 2,
  },

  actionInner: {
    gap: 6,
  },
  actionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FAF9F6',
    marginTop: 2,
  },
  actionBody: {
    fontSize: 12,
    color: 'rgba(250,249,246,0.6)',
    lineHeight: 17,
  },
  actionBtn: {
    marginTop: 6,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: 'rgba(250,249,246,0.3)',
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  actionBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(250,249,246,0.8)',
  },
  startBtn: {
    marginTop: 6,
    alignSelf: 'flex-start',
    backgroundColor: VERIFY_TEAL,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 7,
  },
  startBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
});
