/**
 * PassportQrSheet — the Share-Passport sheet (spec §25).
 *
 * Offers the four sharing options QR · Share Link · Copy Link · Bump.
 *
 * Privacy guarantees baked into this component:
 *   • The preview + QR expose ONLY the minimal projection (photo, first name,
 *     @handle, verification, permitted home country/interests, Follow/Connect).
 *     The projection is built by passportQrProjection.buildQrProjection — a
 *     closed allow-list — and the QR image encodes just the deep link
 *     (buildQrPayload), so scanning re-projects under normal privacy policy and
 *     never bypasses it.
 *   • Bump requires an AFFIRMATIVE, two-step confirmation before anything is
 *     exchanged. Opening the Bump panel, or being physically near someone,
 *     never reveals the profile: `onBumpConfirmed` fires only after the explicit
 *     "Confirm exchange" press.
 *
 * Share Link reuses the existing usePassportShare hook + PassportShareCard
 * (native share sheet + captured card); Copy Link uses expo-clipboard.
 */
import React, { useCallback, useState } from 'react';
import { Modal, View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  X,
  QrCode as QrIcon,
  Share2,
  Copy,
  Radar,
  Check,
  UserPlus,
  Sparkles,
  MapPin,
} from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import { CachedImage } from '../../components/CachedImage.tsx';
import { VerifiedStamp } from '../../components/ui/VerifiedStamp.tsx';
import { PassportShareCard } from '../../components/PassportShareCard.tsx';
import { usePassportShare } from '../../hooks/usePassportShare.ts';
import { PassportQrCode } from './PassportQrCode.tsx';
import {
  buildQrPayload,
  buildShareUrls,
  type MinimalQrProjection,
} from './passportQrProjection.ts';
import { trackPassportShared } from './passportTelemetry.ts';

type Panel = 'qr' | 'bump';
type BumpState = 'idle' | 'awaiting' | 'confirmed';

export interface PassportQrSheetProps {
  visible: boolean;
  onClose: () => void;
  /** @handle used to build the deep link / share URL. */
  username: string | null;
  /** The minimal, already-whitelisted projection (buildQrProjection output). */
  projection: MinimalQrProjection;
  /** Stats for the shared PassportShareCard (Share Link). Defaults to 0/0. */
  stats?: { tripCount: number; stampCount: number; tagline?: string | null };
  /** Fired once, only after the affirmative Bump confirmation. */
  onBumpConfirmed?: () => void;
  /** Preview affordances a scanner would use — optional callbacks. */
  onFollow?: () => void;
  onConnect?: () => void;
  /** Test seam. */
  initialPanel?: Panel;
}

export function PassportQrSheet({
  visible,
  onClose,
  username,
  projection,
  stats,
  onBumpConfirmed,
  onFollow,
  onConnect,
  initialPanel = 'qr',
}: PassportQrSheetProps) {
  const [panel, setPanel] = useState<Panel>(initialPanel);
  const [bump, setBump] = useState<BumpState>('idle');
  const [copied, setCopied] = useState(false);

  const { cardRef, share } = usePassportShare(username);

  const payload = username ? buildQrPayload(username) : '';
  const urls = username ? buildShareUrls(username) : null;

  // §32 passport_shared — the native share sheet was opened for this passport.
  const handleShare = useCallback(() => {
    trackPassportShared('share_sheet');
    share();
  }, [share]);

  const handleCopy = useCallback(async () => {
    if (!urls) return;
    try {
      await Clipboard.setStringAsync(urls.webFallback);
      setCopied(true);
      trackPassportShared('copy');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }, [urls]);

  const startBump = useCallback(() => {
    setPanel('bump');
    setBump('awaiting');
  }, []);

  const confirmBump = useCallback(() => {
    setBump('confirmed');
    // §32 passport_shared — only after the AFFIRMATIVE Bump confirmation (§25).
    trackPassportShared('bump');
    onBumpConfirmed?.();
  }, [onBumpConfirmed]);

  const cancelBump = useCallback(() => setBump('idle'), []);

  // Reset transient state whenever the sheet is dismissed.
  const close = useCallback(() => {
    setBump('idle');
    setCopied(false);
    setPanel(initialPanel);
    onClose();
  }, [initialPanel, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={s.backdrop}>
        <Pressable style={s.backdropFill} onPress={close} accessibilityRole="button" accessibilityLabel="Dismiss" />
        <View style={s.sheet}>
          {/* Header */}
          <View style={s.header}>
            <Text style={s.title}>Share Passport</Text>
            <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
              <X size={icon.s20} color={color.mute} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
            {/* Minimal projection preview (§25 — nothing beyond these fields) */}
            <View style={s.preview}>
              <View style={s.avatarWrap}>
                {projection.avatarUrl ? (
                  <CachedImage source={{ uri: projection.avatarUrl }} style={s.avatar} fallbackLabel="" />
                ) : (
                  <View style={[s.avatar, s.avatarPlaceholder]}>
                    <Text style={s.avatarEmoji}>✈️</Text>
                  </View>
                )}
              </View>
              <View style={s.nameRow}>
                <Text style={s.firstName} numberOfLines={1}>
                  {projection.firstName ?? 'Traveler'}
                </Text>
                {projection.verified ? <VerifiedStamp size="md" /> : null}
              </View>
              {projection.handle ? <Text style={s.handle}>@{projection.handle}</Text> : null}
              {projection.homeCountry ? (
                <View style={s.homeRow}>
                  <MapPin size={icon.s14} color={color.mute} />
                  <Text style={s.homeText}>{projection.homeCountry}</Text>
                </View>
              ) : null}
              {projection.interests.length > 0 ? (
                <View style={s.interests}>
                  {projection.interests.slice(0, 5).map((it) => (
                    <View key={it} style={s.interestPill}>
                      <Text style={s.interestText}>{it}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* Follow / Connect — what a scanner is offered (§25) */}
              <View style={s.previewActions}>
                <Pressable style={[s.previewBtn, s.followBtn]} onPress={onFollow} accessibilityRole="button" accessibilityLabel="Follow">
                  <UserPlus size={icon.s16} color={color.paper} />
                  <Text style={s.followText}>Follow</Text>
                </Pressable>
                <Pressable style={[s.previewBtn, s.connectBtn]} onPress={onConnect} accessibilityRole="button" accessibilityLabel="Connect">
                  <Sparkles size={icon.s16} color={color.deep} />
                  <Text style={s.connectText}>Connect</Text>
                </Pressable>
              </View>
            </View>

            {/* Four share options */}
            <View style={s.optionRow}>
              <OptionButton label="QR" active={panel === 'qr'} onPress={() => setPanel('qr')}>
                <QrIcon size={icon.s20} color={panel === 'qr' ? color.paper : color.ink} />
              </OptionButton>
              <OptionButton label="Share Link" onPress={handleShare}>
                <Share2 size={icon.s20} color={color.ink} />
              </OptionButton>
              <OptionButton label={copied ? 'Copied' : 'Copy Link'} onPress={handleCopy}>
                {copied ? <Check size={icon.s20} color={color.success} /> : <Copy size={icon.s20} color={color.ink} />}
              </OptionButton>
              <OptionButton label="Bump" active={panel === 'bump'} onPress={startBump}>
                <Radar size={icon.s20} color={panel === 'bump' ? color.paper : color.ink} />
              </OptionButton>
            </View>

            {/* Panel */}
            {panel === 'qr' ? (
              <View style={s.qrPanel}>
                {payload ? <PassportQrCode value={payload} size={200} /> : null}
                <Text style={s.qrCaption}>
                  Scan to open this passport. Scanning always respects the owner&apos;s privacy settings.
                </Text>
              </View>
            ) : (
              <BumpPanel state={bump} onStart={startBump} onConfirm={confirmBump} onCancel={cancelBump} />
            )}
          </ScrollView>

          {/* Offscreen capture target for Share Link (reuses PassportShareCard). */}
          <View style={s.offscreen} pointerEvents="none">
            <PassportShareCard
              ref={cardRef}
              displayName={projection.firstName}
              username={projection.handle}
              avatarUrl={projection.avatarUrl}
              tripCount={stats?.tripCount ?? 0}
              stampCount={stats?.stampCount ?? 0}
              tagline={stats?.tagline ?? null}
              verified={projection.verified}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function OptionButton({
  label,
  active,
  onPress,
  children,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      style={[s.option, active && s.optionActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[s.optionIcon, active && s.optionIconActive]}>{children}</View>
      <Text style={[s.optionLabel, active && s.optionLabelActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function BumpPanel({
  state,
  onStart,
  onConfirm,
  onCancel,
}: {
  state: BumpState;
  onStart: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <View style={s.bumpPanel}>
      <Radar size={icon.s26} color={color.deep} />
      <Text style={s.bumpTitle}>Bump to exchange</Text>
      <Text style={s.bumpNote}>
        Bump shares your passport only after you confirm. Being nearby never reveals your profile on its own.
      </Text>

      {state === 'confirmed' ? (
        <View style={s.bumpDone} accessibilityLabel="Passport shared">
          <Check size={icon.s20} color={color.success} />
          <Text style={s.bumpDoneText}>Passport shared</Text>
        </View>
      ) : state === 'awaiting' ? (
        <>
          <Text style={s.bumpConfirmPrompt}>Confirm the exchange with the person you just met?</Text>
          <Pressable style={s.bumpConfirmBtn} onPress={onConfirm} accessibilityRole="button" accessibilityLabel="Confirm exchange">
            <Check size={icon.s16} color={color.paper} />
            <Text style={s.bumpConfirmText}>Confirm exchange</Text>
          </Pressable>
          <Pressable style={s.bumpCancelBtn} onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel bump">
            <Text style={s.bumpCancelText}>Cancel</Text>
          </Pressable>
        </>
      ) : (
        <Pressable style={s.bumpStartBtn} onPress={onStart} accessibilityRole="button" accessibilityLabel="Start Bump">
          <Radar size={icon.s16} color={color.paper} />
          <Text style={s.bumpStartText}>Start Bump</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17,17,15,0.5)',
    justifyContent: 'flex-end',
  },
  backdropFill: { ...StyleSheet.absoluteFillObject },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '90%',
    paddingBottom: space.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  title: { ...t.heading, color: color.ink },
  body: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.lg },

  // Preview
  preview: {
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
    gap: space.xs,
  },
  avatarWrap: {
    borderRadius: avatar.s72 / 2,
    borderWidth: 2,
    borderColor: color.haze,
    overflow: 'hidden',
    marginBottom: space.xs,
  },
  avatar: { width: avatar.s72, height: avatar.s72, borderRadius: avatar.s72 / 2 },
  avatarPlaceholder: { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  avatarEmoji: { fontSize: 28 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  firstName: { ...t.title, fontSize: 20, color: color.ink, flexShrink: 1 },
  handle: { ...t.small, color: color.mute, fontFamily: 'Courier' },
  homeRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  homeText: { ...t.small, color: color.mute },
  interests: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, justifyContent: 'center', marginTop: space.xs },
  interestPill: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(10,61,74,0.08)',
  },
  interestText: { ...t.small, color: color.deep, fontSize: 12 },
  previewActions: { flexDirection: 'row', gap: space.sm, marginTop: space.md, alignSelf: 'stretch' },
  previewBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  followBtn: { backgroundColor: color.deep },
  followText: { ...t.bodyStrong, color: color.paper, fontSize: 14 },
  connectBtn: { borderWidth: 1, borderColor: color.deep },
  connectText: { ...t.bodyStrong, color: color.deep, fontSize: 14 },

  // Option row
  optionRow: { flexDirection: 'row', gap: space.sm },
  option: { flex: 1, alignItems: 'center', gap: space.xs },
  optionActive: {},
  optionIcon: {
    width: avatar.s48,
    height: avatar.s48,
    borderRadius: avatar.s48 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  optionIconActive: { backgroundColor: color.ink, borderColor: color.ink },
  optionLabel: { ...t.small, color: color.mute, fontSize: 11 },
  optionLabelActive: { color: color.ink, fontWeight: '700' },

  // QR panel
  qrPanel: { alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  qrCaption: { ...t.small, color: color.mute, textAlign: 'center', paddingHorizontal: space.lg },

  // Bump panel
  bumpPanel: {
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  bumpTitle: { ...t.heading, color: color.ink },
  bumpNote: { ...t.small, color: color.mute, textAlign: 'center' },
  bumpStartBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingVertical: space.md,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    backgroundColor: color.deep,
    marginTop: space.sm,
  },
  bumpStartText: { ...t.bodyStrong, color: color.paper, fontSize: 14 },
  bumpConfirmPrompt: { ...t.body, color: color.ink, textAlign: 'center', marginTop: space.xs },
  bumpConfirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingVertical: space.md,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
    marginTop: space.xs,
  },
  bumpConfirmText: { ...t.bodyStrong, color: color.paper, fontSize: 14 },
  bumpCancelBtn: { paddingVertical: space.sm, paddingHorizontal: space.lg },
  bumpCancelText: { ...t.bodyStrong, color: color.mute, fontSize: 14 },
  bumpDone: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.sm },
  bumpDoneText: { ...t.bodyStrong, color: color.success, fontSize: 15 },

  // Offscreen share-card capture target
  offscreen: { position: 'absolute', left: -10000, top: -10000, opacity: 0 },
});
