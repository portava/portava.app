/**
 * StampDetailModal — full stamp detail sheet.
 * Owner sees visibility controls (Public / Friends only / Private)
 * and a display_on_passport toggle. Non-owner view is read-only.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  Modal, View, Text, Pressable, StyleSheet, ScrollView, Switch, ActivityIndicator, Image,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { X, Link, Route, Globe } from 'lucide-react-native';
import { journeysHref, myWorldHref } from '../../features/passport/passportNav.ts';
import { PortavaShareIcon } from '../icons/PortavaShareIcon.tsx';
import { StampArtwork } from '../StampArtwork.tsx';
import { StampShareCard } from '../StampShareCard.tsx';
import { useStampShare } from '../../hooks/useStampShare.ts';
import { updateStampVisibility, toggleDisplayOnPassport } from '../../services/stamps.ts';
import { stampToLegacy, makeStampShareLinks } from '../../services/stampShareUtils.ts';
import type { NewStampVisibility } from '../../services/stamps.ts';
import type { PassportStampNew } from '../../services/passportStamps.ts';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { StampAdmireBlock } from './StampAdmireBlock.tsx';

import { RARITY_COLORS, normalizeRarity } from '../../lib/stampRarity.ts';

const SOURCE_LABELS: Record<string, string> = {
  trip:        'Completed a trip',
  plan:        'Joined a travel plan',
  host:        'Hosted an experience',
  safe_return: 'Completed a verified safe meetup',
  hidden_gem:  'Discovered a hidden gem',
  check_in:    'GPS-verified check-in',
  system:      'Awarded by Portava',
  manual:      'Manually awarded',
  event:       'Attended an event',
  rent_buddy:  'Rent a Buddy activity',
};

const VISIBILITY_OPTIONS: { value: NewStampVisibility; label: string }[] = [
  { value: 'public',       label: 'Public' },
  { value: 'friends_only', label: 'Friends only' },
  { value: 'private',      label: 'Private' },
];

interface Props {
  stamp: PassportStampNew | null;
  isOwner: boolean;
  visible: boolean;
  onClose: () => void;
  onStampUpdated?: (updated: PassportStampNew) => void;
  /** Username of the stamp owner — shown on the share card footer. Optional. */
  username?: string | null;
}

export function StampDetailModal({ stamp, isOwner, visible, onClose, onStampUpdated, username }: Props) {
  const [visUpdating, setVisUpdating] = useState(false);
  const [displayUpdating, setDisplayUpdating] = useState(false);
  const { cardRef, share, sharing, onArtworkSettled } = useStampShare(stamp, username ?? null);
  const [copied, setCopied] = useState(false);

  /* Prefetch the AI artwork as soon as the modal opens so the share capture
     (which waits for the artwork to load) is nearly always instant. */
  const artworkUrl = stamp?.definition?.universalArtworkUrl ?? null;
  useEffect(() => {
    if (visible && artworkUrl) {
      Image.prefetch(artworkUrl).catch(() => {
        /* best-effort warm-up; share flow has its own bounded wait + fallback */
      });
    }
  }, [visible, artworkUrl]);

  const copyLink = useCallback(async () => {
    if (!stamp) return;
    const { webUrl } = makeStampShareLinks(stamp, username);
    await Clipboard.setStringAsync(webUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [stamp, username]);

  // §13: the stamp detail can link to Journey and My World, respecting
  // historical-location privacy (the destinations enforce their own). Close
  // the sheet first, then navigate. For a VIEWER (not owner) the Journey link
  // carries the stamp owner's @handle so the journeys endpoint resolves the
  // right traveler; the owner opens their own (no id). My World is the OWNER's
  // personal geographic history (§26) — no viewer variant — so it is offered
  // only to the owner.
  const openJourney = useCallback(() => {
    if (!stamp) return;
    onClose();
    const target = isOwner ? undefined : (username ?? undefined);
    // Defer past the sheet's close animation so navigation does not fire on the
    // unmounting modal (BUG CC/CD close-then-navigate race).
    setTimeout(() => router.push(journeysHref(target, stamp.tripId ?? undefined) as never), 80);
  }, [stamp, isOwner, username, onClose]);

  const openMyWorld = useCallback(() => {
    onClose();
    // Defer past the sheet's close animation (BUG CC/CD close-then-navigate race).
    setTimeout(() => router.push(myWorldHref() as never), 80);
  }, [onClose]);

  if (!stamp) return null;

  const legacy = stampToLegacy(stamp);
  const rarity = stamp.definition?.rarity ? normalizeRarity(stamp.definition.rarity) : null;
  const rarityColor = rarity ? RARITY_COLORS[rarity].ring : null;

  async function handleVisChange(vis: NewStampVisibility) {
    if (!stamp) return;
    setVisUpdating(true);
    const res = await updateStampVisibility(stamp.id, vis);
    setVisUpdating(false);
    if (res.ok) {
      onStampUpdated?.({ ...stamp, visibility: vis });
    }
  }

  async function handleDisplayToggle(val: boolean) {
    if (!stamp) return;
    setDisplayUpdating(true);
    const res = await toggleDisplayOnPassport(stamp.id, val);
    setDisplayUpdating(false);
    if (res.ok) {
      onStampUpdated?.({ ...stamp, displayOnPassport: val });
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8}>
            <X size={20} color={color.ink} />
          </Pressable>

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.body}
            bounces={false}
          >
            {/* Artwork */}
            <View style={styles.artworkWrap}>
              <StampArtwork stamp={legacy} size={120} />
            </View>

            {/* Name + rarity */}
            <Text style={styles.name} numberOfLines={3}>
              {stamp.titleOverride ?? stamp.definition?.name ?? legacy.label}
            </Text>

            {rarity && rarityColor && (
              <View style={[styles.rarityBadge, { backgroundColor: rarityColor + '25' }]}>
                <Text style={[styles.rarityText, { color: RARITY_COLORS[rarity].text }]}>
                  {rarity.toUpperCase()}
                </Text>
              </View>
            )}

            {/* Description */}
            {stamp.definition?.description ? (
              <Text style={styles.desc}>{stamp.definition.description}</Text>
            ) : null}

            <View style={styles.divider} />

            {/* Details grid */}
            {(stamp.city || stamp.country) && (
              <View style={styles.row}>
                <Text style={styles.rowKey}>Location</Text>
                <Text style={styles.rowVal}>
                  {[stamp.city, stamp.country].filter(Boolean).join(', ')}
                </Text>
              </View>
            )}

            <View style={styles.row}>
              <Text style={styles.rowKey}>How earned</Text>
              <Text style={styles.rowVal}>
                {SOURCE_LABELS[stamp.sourceType] ?? stamp.sourceType.replace(/_/g, ' ')}
              </Text>
            </View>

            <View style={styles.row}>
              <Text style={styles.rowKey}>Earned</Text>
              <Text style={styles.rowVal}>
                {new Date(stamp.earnedAt).toLocaleDateString(undefined, {
                  year: 'numeric', month: 'long', day: 'numeric',
                })}
              </Text>
            </View>

            {/* §13: explore links — Journey (this stamp in its trip history) and,
                for the owner, My World (personal geographic history). */}
            <View style={styles.linkRow}>
              <Pressable
                style={styles.linkBtn}
                onPress={openJourney}
                accessibilityRole="button"
                accessibilityLabel="View in Journeys"
                testID="stamp-open-journey"
              >
                <Route size={16} color={color.ink} />
                <Text style={styles.linkText}>View Journey</Text>
              </Pressable>
              {isOwner ? (
                <Pressable
                  style={styles.linkBtn}
                  onPress={openMyWorld}
                  accessibilityRole="button"
                  accessibilityLabel="Open My World"
                  testID="stamp-open-my-world"
                >
                  <Globe size={16} color={color.ink} />
                  <Text style={styles.linkText}>My World</Text>
                </Pressable>
              ) : null}
            </View>

            {/* Admire block */}
            <StampAdmireBlock userStampId={stamp.id} isOwner={isOwner} />

            {/* Revoked notice */}
            {stamp.isRevoked && (
              <View style={styles.revokedBanner}>
                <Text style={styles.revokedText}>This stamp has been revoked.</Text>
              </View>
            )}

            {/* Owner controls */}
            {isOwner && !stamp.isRevoked && (
              <>
                <View style={styles.divider} />

                <Text style={styles.sectionLabel}>Visibility</Text>
                <View style={styles.visRow}>
                  {VISIBILITY_OPTIONS.map((opt) => (
                    <Pressable
                      key={opt.value}
                      style={[
                        styles.visBtn,
                        stamp.visibility === opt.value && styles.visBtnActive,
                        visUpdating && styles.visBtnDisabled,
                      ]}
                      onPress={() => handleVisChange(opt.value)}
                      disabled={visUpdating}
                    >
                      {visUpdating && stamp.visibility === opt.value ? (
                        <ActivityIndicator size="small" color={color.signal} />
                      ) : (
                        <Text style={[styles.visBtnText, stamp.visibility === opt.value && styles.visBtnTextActive]}>
                          {opt.label}
                        </Text>
                      )}
                    </Pressable>
                  ))}
                </View>

                <View style={styles.toggleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.toggleLabel}>Show on Passport</Text>
                    <Text style={styles.toggleSub}>Display this stamp on your public profile</Text>
                  </View>
                  {displayUpdating ? (
                    <ActivityIndicator size="small" color={color.signal} />
                  ) : (
                    <Switch
                      value={stamp.displayOnPassport}
                      onValueChange={handleDisplayToggle}
                      trackColor={{ false: color.haze, true: color.signal }}
                      thumbColor="#fff"
                    />
                  )}
                </View>
              </>
            )}

            {/* Share / copy-link row (public stamps only) */}
            {stamp.visibility === 'public' && !stamp.isRevoked && (
              <View style={styles.shareRow}>
                <Pressable
                  style={[styles.shareBtn, sharing && styles.shareBtnDisabled, { flex: 1 }]}
                  onPress={share}
                  disabled={sharing}
                >
                  {sharing ? (
                    <ActivityIndicator size="small" color={color.ink} />
                  ) : (
                    <PortavaShareIcon size={16} color={color.ink} />
                  )}
                  <Text style={styles.shareBtnText}>
                    {sharing ? 'Sharing…' : 'Share'}
                  </Text>
                </Pressable>

                <Pressable
                  style={[styles.shareBtn, copied && styles.shareBtnCopied, { flex: 1 }]}
                  onPress={copyLink}
                >
                  <Link size={16} color={copied ? '#16A34A' : color.ink} />
                  <Text style={[styles.shareBtnText, copied && styles.shareBtnTextCopied]}>
                    {copied ? 'Copied!' : 'Copy link'}
                  </Text>
                </Pressable>
              </View>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>

      {/* Off-screen StampShareCard — captured by useStampShare for the native share sheet */}
      <View ref={cardRef} style={styles.offscreen} collapsable={false}>
        <StampShareCard key={stamp.id} stamp={legacy} visibility="public" username={username ?? undefined} onArtworkSettled={onArtworkSettled} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  sheet: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '90%',
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    ...shadow.float,
  },
  closeBtn: { position: 'absolute', right: space.md, top: space.md, zIndex: 10, padding: 4 },
  body: { padding: space.xl, paddingTop: space.xl + 8, gap: space.sm, alignItems: 'center' },
  artworkWrap: { marginBottom: space.xs },
  name: {
    ...t.title,
    color: color.ink,
    fontWeight: '800',
    textAlign: 'center',
  },
  rarityBadge: {
    alignSelf: 'center',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  rarityText: { ...t.small, fontWeight: '700', letterSpacing: 0.5 },
  desc: { ...t.body, color: color.mute, textAlign: 'center', fontStyle: 'italic', marginTop: 4 },
  divider: { width: '100%', height: 1, backgroundColor: color.haze, marginVertical: space.sm },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.sm,
    width: '100%',
  },
  rowKey: { ...t.small, color: color.mute, fontWeight: '600', flex: 1 },
  rowVal: { ...t.small, color: color.ink, fontWeight: '500', flex: 2, textAlign: 'right' },
  revokedBanner: {
    width: '100%',
    backgroundColor: '#FEE2E2',
    borderRadius: radius.md,
    padding: space.sm,
    alignItems: 'center',
  },
  revokedText: { ...t.small, color: '#DC2626', fontWeight: '600' },
  sectionLabel: {
    ...t.small,
    color: color.mute,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    alignSelf: 'flex-start',
    marginTop: space.xs,
  },
  visRow: { flexDirection: 'row', gap: space.sm, width: '100%' },
  visBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
    minHeight: 40,
  },
  visBtnActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  visBtnDisabled: { opacity: 0.5 },
  visBtnText: { ...t.small, color: color.mute, fontWeight: '600', fontSize: 12 },
  visBtnTextActive: { color: color.signal },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    width: '100%',
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    marginTop: space.xs,
  },
  toggleLabel: { ...t.bodyStrong, color: color.ink },
  toggleSub: { ...t.small, color: color.mute, marginTop: 2 },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
    marginTop: space.sm,
  },
  linkRow:  { flexDirection: 'row', gap: space.sm, width: '100%', marginTop: space.xs },
  linkBtn:  {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper,
  },
  linkText: { ...t.small, color: color.ink, fontWeight: '700' },
  shareRow:           { flexDirection: 'row', gap: space.sm, width: '100%', marginTop: space.sm },
  shareBtnDisabled:   { opacity: 0.6 },
  shareBtnCopied:     { borderColor: '#16A34A', backgroundColor: '#F0FDF4' },
  shareBtnText:       { ...t.bodyStrong, color: color.ink },
  shareBtnTextCopied: { color: '#16A34A' },
  offscreen:          { position: 'absolute', left: -2000, top: 0 },
});
