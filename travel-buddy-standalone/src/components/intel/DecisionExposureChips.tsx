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
import { Info, Radio, Clock, AlertTriangle } from 'lucide-react-native';
import { color, space, radius, typography } from '../../theme/tokens.ts';
import { normalizeConflictState, conflictExplanation } from '../../lib/intel/conflict.ts';
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

/** The wire's source-class vocabulary. An value outside it is not attributed. */
const KNOWN_SOURCE_CLASSES = new Set<SourceClass>([
  'verified_firsthand', 'firsthand_unverified', 'official_signed', 'sponsored',
  'imported_owned', 'historical_pattern', 'portava_prediction', 'hearsay',
]);

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
    // VALIDATED, and never defaulted to a traveller report. The old
    // `?? 'firsthand_unverified'` was a §37 fail-open: a claim the wire did not
    // attribute — a sponsored one whose class was dropped, or a class this
    // build does not know — rendered as a firsthand traveller observation. The
    // `as SourceClass` cast also let an unrecognised value through unchecked.
    // The band directly above already validates against a known set; this
    // follows that precedent rather than inventing one.
    sourceClass:
      dto.sourceClass && KNOWN_SOURCE_CLASSES.has(dto.sourceClass as SourceClass)
        ? (dto.sourceClass as SourceClass)
        : null,
    // Prefer the served bucket; tolerate a legacy numeric count from an old payload.
    sourceCountBucket:
      dto.sourceCountBucket ??
      (typeof dto.sourceCount === 'number' ? sourceCountBucketFromCount(dto.sourceCount) : null),
    // The server's authoritative live/emerging state (never over-labelled as Live).
    serverState: dto.state ?? null,
    observedAt: dto.observedAt ?? null,
    validUntil: dto.validUntil ?? null,
    // §10 conflict state — normalised the same way the server does (absent ⇒
    // 'none'; an unrecognised marker ⇒ 'material', fail-closed for the label).
    conflictState: normalizeConflictState(dto.conflictState ?? dto.conflict?.state ?? null),
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
    //
    // §37 RULING on sourceClass, assessed separately from the dtoToClaim fix
    // above and reaching the same answer for a DIFFERENT reason:
    //
    // The justification above is about FRESHNESS and PRIVACY. It says nothing
    // about who is speaking, and those are different gates. Checked against the
    // producer rather than inferred: readLiveCrowdLevel (api-server
    // lib/liveClaimRead.ts) does `readLiveClaims(...{claimTypes:['crowd.level']})`
    // and takes `claims.find(...)` — there is NO source-class filter anywhere on
    // that path. A SPONSORED crowd.level claim can be the one returned.
    //
    // So hardcoding 'firsthand_unverified' here was the same §37 fail-open: a
    // paid claim borrowing a traveller's credibility, reached by a route the
    // comment's reasoning did not cover.
    //
    // null is also the literally accurate answer. The server reduced the claim
    // to a bare STRING on this path; the attribution was dropped upstream, so
    // the client does not have it. It renders "Source not attributed", and
    // liveState() degrades it to 'typical' rather than 'live' — which is right:
    // an unattributed level should not assert a present-tense observation.
    //
    // If this path should carry an attribution, the fix belongs on the server —
    // readLiveCrowdLevel would have to return the class alongside the level, or
    // exclude non-consensus classes. Inventing one here is what §37 forbids.
    return [
      {
        claimType: 'crowd.level',
        value: { level: living.crowdLevel },
        band: 'likely_current',
        confidence: null,
        sourceClass: null,
        // A bare crowd level carries no cohort and no server state: it degrades to
        // the honest 'emerging' (band likely_current), never overstated as Live.
        sourceCountBucket: null,
        serverState: null,
        observedAt: living.generatedAt ?? null,
        validUntil: null,
        // A bare string carries no conflict marker — and the server returns
        // null for the bare crowdLevel under a material conflict precisely so
        // an unlabelled plurality never reaches this path.
        conflictState: null,
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
  /**
   * §10 contradiction-resolution opportunity: when set, a materially-
   * conflicted claim's sheet offers "What's it like now?" and calls this with
   * the claim. The caller decides whether a prompt may be shown at all
   * (useIntelPrompts.conflictReask) — leave it undefined to offer nothing.
   */
  onResolveConflict?: (claim: LiveIntelClaim) => void;
}

export function DecisionExposureChips({ living, enabled, onResolveConflict }: DecisionExposureChipsProps) {
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
          const stateColor = liveStateColor(state, claim.conflictState);
          const material = normalizeConflictState(claim.conflictState) === 'material';
          return (
            <Pressable
              key={`${claim.claimType}-${i}`}
              testID={`intel-chip-${claim.claimType}`}
              accessibilityRole="button"
              accessibilityLabel={`${claimTypeLabel(claim.claimType)} ${formatClaimValue(claim.claimType, claim.value)}, ${liveStateLabel(state, claim.conflictState)}. Tap for why.`}
              onPress={() => setOpenClaim(claim)}
              style={({ pressed }) => [styles.chip, { borderColor: stateColor + '55' }, pressed && styles.chipPressed]}
            >
              {material ? (
                <AlertTriangle size={11} color={stateColor} />
              ) : (
                <View style={[styles.dot, { backgroundColor: stateColor }]} />
              )}
              <Text style={styles.chipLabel}>{claimTypeLabel(claim.claimType)}</Text>
              <Text style={[styles.chipValue, { color: stateColor }]} numberOfLines={1}>
                {formatClaimValue(claim.claimType, claim.value)}
              </Text>
              {/* §10: the conflict is said in TEXT on the chip itself, not only in the sheet. */}
              {material ? (
                <Text style={[styles.chipConflict, { color: stateColor }]} testID={`intel-chip-conflict-${claim.claimType}`}>
                  {liveStateLabel(state, claim.conflictState)}
                </Text>
              ) : null}
              <Info size={12} color={color.faint} />
            </Pressable>
          );
        })}
      </ScrollView>

      <WhySheet claim={openClaim} onClose={() => setOpenClaim(null)} onResolveConflict={onResolveConflict} />
    </>
  );
}

function WhySheet({
  claim,
  onClose,
  onResolveConflict,
}: {
  claim: ChipClaim | null;
  onClose: () => void;
  onResolveConflict?: (claim: LiveIntelClaim) => void;
}) {
  if (!claim) return null;
  const state = liveState(claim);
  const stateColor = liveStateColor(state, claim.conflictState);
  const showBand = !claim.synthesized;
  const conflictState = normalizeConflictState(claim.conflictState);
  const conflictWhy = conflictExplanation(conflictState);
  return (
    <PortavaSheet visible={!!claim} onClose={onClose} accessibilityLabel="Why we show this" maxHeightPercent={70}>
      <View style={sheet.container}>
        <View style={sheet.header}>
          <Text style={sheet.title}>
            {claimTypeLabel(claim.claimType)} · {formatClaimValue(claim.claimType, claim.value)}
          </Text>
          <View style={[sheet.statePill, { backgroundColor: stateColor + '18', borderColor: stateColor + '55' }]}>
            {state === 'live' ? <Radio size={12} color={stateColor} /> : null}
            {conflictState === 'material' ? <AlertTriangle size={12} color={stateColor} /> : null}
            <Text style={[sheet.statePillText, { color: stateColor }]}>{liveStateLabel(state, claim.conflictState)}</Text>
          </View>
        </View>

        {conflictWhy ? (
          <View style={[sheet.conflictBox, { borderColor: stateColor + '55' }]} testID="intel-why-conflict">
            <Text style={sheet.conflictTitle}>
              {conflictState === 'material' ? 'Reports differ right now' : 'Reports vary a little'}
            </Text>
            <Text style={sheet.why}>{conflictWhy}</Text>
            {conflictState === 'material' && onResolveConflict ? (
              <Pressable
                testID="intel-conflict-reask"
                accessibilityRole="button"
                accessibilityLabel="Help settle it — what's it like now?"
                onPress={() => {
                  onClose();
                  onResolveConflict(claim);
                }}
                style={({ pressed }) => [sheet.reaskBtn, pressed && { opacity: 0.85 }]}
              >
                <Radio size={14} color={color.signal} />
                <Text style={sheet.reaskText}>What’s it like now?</Text>
                <Text style={sheet.reaskHint}>· 5 seconds, private</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

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
  chipConflict: { ...typography.metadata, textTransform: 'uppercase' },
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
  conflictBox: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: color.paperRaised,
  },
  conflictTitle: { ...typography.cardTitle, color: color.ink },
  reaskBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: 2,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.signal + '55',
    backgroundColor: color.paper,
  },
  reaskText: { ...typography.label, color: color.ink },
  reaskHint: { ...typography.metadata, color: color.mute },
});
