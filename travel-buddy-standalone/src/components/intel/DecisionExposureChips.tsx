/**
 * DecisionExposureChips — the place card's "why should I trust this?" surface.
 *
 * The spec's decision-exposure rule: a live claim is never a bare value. Each
 * chip shows the value AND its honest state (Live / Typical / Unknown); tapping
 * opens a sheet with the confidence band, the source-class label, when it was
 * observed, and a one-line "why". Nothing is invented — an expired or
 * below-band or non-observation claim degrades down, and with no claim at all
 * the strip renders nothing (the honest "Unknown" is silence, not a guess).
 *
 * Gated by `intel_live_label_crowd` upstream (the caller passes `enabled`). Off
 * ⇒ this renders null and the place card is exactly as it was.
 *
 * DATA. Prefers a rich `living.liveClaims` array (the forward read contract).
 * Falls back to the bare `living.crowdLevel` string the read path returns today:
 * that string only exists when the gated projection already cleared the live
 * floor + privacy gate, so it is surfaced as a Live crowd chip with limited
 * detail, never with a fabricated confidence number.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Info, Radio, Clock } from 'lucide-react-native';
import { color, space, radius, typography } from '../../theme/tokens.ts';
import { PortavaSheet } from '../ui/PortavaSheet.tsx';
import type { PlaceLivingResponse, LiveClaimDTO } from '../../types/placeLiving.ts';
import {
  type LiveIntelClaim,
  liveState,
  liveStateLabel,
  liveStateColor,
  claimTypeLabel,
  formatClaimValue,
  sourceLabel,
  whyExplanation,
  observedVerb,
  relativeTime,
  confidenceBand,
  sourceCountBucketFromCount,
  BAND_LABEL,
} from '../../lib/intel/display.ts';
import type { SourceClass, ConfidenceBand } from '../../lib/intel/contracts.ts';

/** A claim carrying whether it was synthesised from the bare crowd string. */
interface ChipClaim extends LiveIntelClaim {
  synthesized: boolean;
}

const KNOWN_BANDS = new Set<ConfidenceBand>(['unverified', 'provisional', 'likely_current', 'live', 'strong']);

function dtoToClaim(dto: LiveClaimDTO): ChipClaim {
  const band: ConfidenceBand =
    dto.band && KNOWN_BANDS.has(dto.band as ConfidenceBand)
      ? (dto.band as ConfidenceBand)
      : confidenceBand(dto.confidence ?? null);
  return {
    id: dto.id ?? null,
    claimType: dto.claimType,
    value: dto.value,
    band,
    confidence: dto.confidence ?? null,
    sourceClass: (dto.sourceClass as SourceClass) ?? 'firsthand_unverified',
    // Prefer the served bucket; tolerate a legacy numeric count from an old payload.
    sourceCountBucket:
      dto.sourceCountBucket ??
      (typeof dto.sourceCount === 'number' ? sourceCountBucketFromCount(dto.sourceCount) : null),
    // The server's authoritative live/emerging state (never over-labelled as Live).
    serverState: dto.state ?? null,
    observedAt: dto.observedAt ?? null,
    validUntil: dto.validUntil ?? null,
    synthesized: false,
  };
}

/** Build the display claims from the place DTO (rich array preferred). */
export function buildLiveClaims(living: PlaceLivingResponse): ChipClaim[] {
  if (Array.isArray(living.liveClaims) && living.liveClaims.length > 0) {
    return living.liveClaims.map(dtoToClaim);
  }
  if (living.crowdLevel) {
    // The gated read path only returns a crowd level once it cleared the live
    // floor + privacy gate, so treat it as a live-eligible crowd claim, but with
    // no fabricated number — band is set to the live-state floor and marked
    // synthesised so the sheet says detail is limited.
    return [
      {
        claimType: 'crowd.level',
        value: { level: living.crowdLevel },
        band: 'likely_current',
        confidence: null,
        sourceClass: 'firsthand_unverified',
        // A bare crowd level carries no cohort and no server state: it degrades to
        // the honest 'emerging' (band likely_current), never overstated as Live.
        sourceCountBucket: null,
        serverState: null,
        observedAt: living.generatedAt ?? null,
        validUntil: null,
        synthesized: true,
      },
    ];
  }
  return [];
}

export interface DecisionExposureChipsProps {
  living: PlaceLivingResponse;
  /** intel_live_label_crowd — off ⇒ render nothing. */
  enabled: boolean;
}

export function DecisionExposureChips({ living, enabled }: DecisionExposureChipsProps) {
  const claims = useMemo(() => (enabled ? buildLiveClaims(living) : []), [enabled, living]);
  const [openClaim, setOpenClaim] = useState<ChipClaim | null>(null);

  if (!enabled || claims.length === 0) return null;

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        style={styles.scroll}
      >
        <View style={styles.leadLabel}>
          <Radio size={12} color={color.mute} />
          <Text style={styles.leadText}>Live intel</Text>
        </View>
        {claims.map((claim, i) => {
          const state = liveState(claim);
          const stateColor = liveStateColor(state);
          return (
            <Pressable
              key={`${claim.claimType}-${i}`}
              testID={`intel-chip-${claim.claimType}`}
              accessibilityRole="button"
              accessibilityLabel={`${claimTypeLabel(claim.claimType)} ${formatClaimValue(claim.claimType, claim.value)}, ${liveStateLabel(state)}. Tap for why.`}
              onPress={() => setOpenClaim(claim)}
              style={({ pressed }) => [styles.chip, { borderColor: stateColor + '55' }, pressed && styles.chipPressed]}
            >
              <View style={[styles.dot, { backgroundColor: stateColor }]} />
              <Text style={styles.chipLabel}>{claimTypeLabel(claim.claimType)}</Text>
              <Text style={[styles.chipValue, { color: stateColor }]} numberOfLines={1}>
                {formatClaimValue(claim.claimType, claim.value)}
              </Text>
              <Info size={12} color={color.faint} />
            </Pressable>
          );
        })}
      </ScrollView>

      <WhySheet claim={openClaim} onClose={() => setOpenClaim(null)} />
    </>
  );
}

function WhySheet({ claim, onClose }: { claim: ChipClaim | null; onClose: () => void }) {
  if (!claim) return null;
  const state = liveState(claim);
  const stateColor = liveStateColor(state);
  const showBand = !claim.synthesized;
  return (
    <PortavaSheet visible={!!claim} onClose={onClose} accessibilityLabel="Why we show this" maxHeightPercent={70}>
      <View style={sheet.container}>
        <View style={sheet.header}>
          <Text style={sheet.title}>
            {claimTypeLabel(claim.claimType)} · {formatClaimValue(claim.claimType, claim.value)}
          </Text>
          <View style={[sheet.statePill, { backgroundColor: stateColor + '18', borderColor: stateColor + '55' }]}>
            {state === 'live' ? <Radio size={12} color={stateColor} /> : null}
            <Text style={[sheet.statePillText, { color: stateColor }]}>{liveStateLabel(state)}</Text>
          </View>
        </View>

        {showBand ? (
          <Row label="Confidence" value={BAND_LABEL[claim.band]} />
        ) : null}
        <Row label="Source" value={sourceLabel(claim.sourceClass)} />
        {/* Labelled "Freshness" (not "Observed") so it never collides with the
            "Observed" live-state pill above; the value already says "Checked …". */}
        <Row
          label="Freshness"
          value={
            claim.observedAt
              ? `${observedVerb(claim.sourceClass)} ${relativeTime(claim.observedAt)}`
              : 'Recently'
          }
          icon={<Clock size={13} color={color.mute} />}
        />

        <Text style={sheet.why}>{whyExplanation(claim)}</Text>
        {claim.synthesized ? (
          <Text style={sheet.note}>
            Detailed confidence isn't in this view yet — this reflects the latest gated live read for the place.
          </Text>
        ) : null}
      </View>
    </PortavaSheet>
  );
}

function Row({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <View style={sheet.detailRow}>
      <Text style={sheet.detailLabel}>{label}</Text>
      <View style={sheet.detailValueWrap}>
        {icon ?? null}
        <Text style={sheet.detailValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    backgroundColor: color.paperRaised,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  leadLabel: { flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: 2 },
  leadText: { ...typography.metadata, color: color.mute, textTransform: 'uppercase' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.paper,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 32,
  },
  chipPressed: { opacity: 0.8 },
  dot: { width: 7, height: 7, borderRadius: 999 },
  chipLabel: { ...typography.metadata, color: color.mute, textTransform: 'uppercase' },
  chipValue: { ...typography.label, color: color.ink },
});

const sheet = StyleSheet.create({
  container: { gap: space.md, paddingBottom: space.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  title: { ...typography.sectionTitle, color: color.ink, flexShrink: 1 },
  statePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  statePillText: { ...typography.metadata, textTransform: 'uppercase' },
  detailRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  detailLabel: { ...typography.label, color: color.mute },
  detailValueWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  detailValue: { ...typography.body, color: color.ink, flexShrink: 1, textAlign: 'right' },
  why: { ...typography.caption, color: color.mute, lineHeight: 19 },
  note: { ...typography.caption, color: color.faint, fontStyle: 'italic', lineHeight: 18 },
});
