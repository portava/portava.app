/**
 * Structured Moment (Intelligence Gathering / IG-03) — the curate-and-publish
 * flow for a captured observation, plus corroboration and correction.
 *
 * Two entry paths:
 *   • author   — an `observationId` from a just-sent Quick Signal. The author
 *                proposes it as a claim (candidate) and approves it (active).
 *   • confirm  — a `claimId` for an existing live claim, to agree / disagree /
 *                unsure, or to suggest a correction that supersedes it.
 *
 * Every write is gated on `intel_capture_quick_signal` and suppressed during an
 * active Safe Return. Corrections carry an Idempotency-Key (minted in the
 * service); confirmations are naturally idempotent per (claim, actor).
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Sparkles, Check, Pencil, AlertCircle, CircleCheck } from 'lucide-react-native';
import { color, space, radius, typography } from '../../src/theme/tokens';
import { IntelModalScaffold } from '../../src/components/intel/IntelModalScaffold';
import { SuppressedNotice } from '../../src/components/intel/IntelBits';
import { ClaimConfirmBar } from '../../src/components/intel/ClaimConfirmBar';
import { OptionPills } from '../../src/components/intel/OptionPills';
import { TravelButton } from '../../src/components/primitives';
import { useIntelPrompts } from '../../src/hooks/useIntelPrompts';
import { proposeClaim, approveClaim, confirmClaim, correctClaim } from '../../src/services/intelCapture';
import {
  correctionOptionsFor,
  optionToClaimValue,
  type ConfirmStance,
} from '../../src/lib/intel/contracts';
import { claimTypeLabel, formatClaimValue } from '../../src/lib/intel/display';

export default function MomentScreen() {
  const params = useLocalSearchParams<{
    observationId?: string;
    claimId?: string;
    subjectId?: string;
    subjectName?: string;
    claimType?: string;
  }>();
  const observationId = typeof params.observationId === 'string' ? params.observationId : undefined;
  const subjectId = typeof params.subjectId === 'string' ? params.subjectId : undefined;
  const subjectName = typeof params.subjectName === 'string' ? params.subjectName : undefined;
  const claimType = typeof params.claimType === 'string' ? params.claimType : undefined;

  const { captureEnabled, safeReturnActive } = useIntelPrompts();

  // Author lifecycle
  const [claimId, setClaimId] = useState<string | null>(typeof params.claimId === 'string' ? params.claimId : null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState<null | 'propose' | 'approve'>(null);
  const [authorError, setAuthorError] = useState<string | null>(null);

  const propose = useCallback(async () => {
    if (!observationId) return;
    setAuthorError(null);
    setBusy('propose');
    const res = await proposeClaim(observationId);
    setBusy(null);
    if (res.ok && res.claim?.id) setClaimId(res.claim.id);
    else setAuthorError(res.code === 'feature_disabled' ? 'Capture is turned off.' : 'Could not propose — try again.');
  }, [observationId]);

  const approve = useCallback(async () => {
    if (!observationId || !claimId) return;
    setAuthorError(null);
    setBusy('approve');
    const res = await approveClaim(observationId, claimId);
    setBusy(null);
    if (res.ok) setApproved(true);
    else setAuthorError(res.code === 'feature_disabled' ? 'Capture is turned off.' : 'Could not approve — try again.');
  }, [observationId, claimId]);

  const canActOnClaim = !!claimId && (approved || !observationId); // active claim available

  let body: React.ReactNode;
  if (!captureEnabled) {
    body = <SuppressedNotice reason="disabled" />;
  } else if (safeReturnActive) {
    body = <SuppressedNotice reason="safe_return" />;
  } else {
    body = (
      <>
        {observationId ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Publish this Moment</Text>
            <Text style={styles.sectionBody}>
              Turn your report{subjectName ? ` at ${subjectName}` : ''} into a structured Moment others can rely on. Two
              quick steps — propose, then approve.
            </Text>

            <StepRow
              index={1}
              title="Propose as a claim"
              state={claimId ? 'done' : busy === 'propose' ? 'busy' : 'todo'}
            />
            {!claimId ? (
              <TravelButton
                label="Propose Moment"
                variant="primary"
                icon={<Sparkles size={16} color={color.onInk} />}
                onPress={propose}
              />
            ) : null}

            <StepRow
              index={2}
              title="Approve & make it live"
              state={approved ? 'done' : busy === 'approve' ? 'busy' : claimId ? 'todo' : 'blocked'}
            />
            {claimId && !approved ? (
              <TravelButton label="Approve & publish" variant="primary" icon={<Check size={16} color={color.onInk} />} onPress={approve} />
            ) : null}

            {approved ? (
              <View style={styles.doneBanner}>
                <CircleCheck size={16} color={color.success} />
                <Text style={styles.doneBannerText}>Moment is live. Others can now confirm or correct it.</Text>
              </View>
            ) : null}

            {authorError ? (
              <View style={styles.errorRow}>
                <AlertCircle size={13} color={color.signal} />
                <Text style={styles.errorText}>{authorError}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {canActOnClaim && claimId ? (
          <>
            <ConfirmSection claimId={claimId} />
            <CorrectionSection claimId={claimId} subjectId={subjectId} claimType={claimType} />
          </>
        ) : null}
      </>
    );
  }

  return (
    <IntelModalScaffold title="Structured Moment" subtitle={subjectName ?? undefined}>
      {body}
    </IntelModalScaffold>
  );
}

// ── Steps ─────────────────────────────────────────────────────────────────────
function StepRow({ index, title, state }: { index: number; title: string; state: 'todo' | 'busy' | 'done' | 'blocked' }) {
  const tint = state === 'done' ? color.success : state === 'blocked' ? color.faint : color.ink;
  return (
    <View style={[styles.stepRow, state === 'blocked' && { opacity: 0.5 }]}>
      <View style={[styles.stepBadge, { borderColor: tint }]}>
        {state === 'done' ? <Check size={13} color={color.success} /> : <Text style={[styles.stepIndex, { color: tint }]}>{index}</Text>}
      </View>
      <Text style={styles.stepTitle}>{title}</Text>
    </View>
  );
}

// ── Confirm ─────────────────────────────────────────────────────────────────
function ConfirmSection({ claimId }: { claimId: string }) {
  const [busy, setBusy] = useState<ConfirmStance | null>(null);
  const [selected, setSelected] = useState<ConfirmStance | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = useCallback(
    async (stance: ConfirmStance) => {
      setError(null);
      setBusy(stance);
      const res = await confirmClaim(claimId, stance);
      setBusy(null);
      if (res.ok) setSelected(stance);
      else setError(res.code === 'feature_disabled' ? 'Capture is turned off.' : 'Could not record — try again.');
    },
    [claimId],
  );

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Is this still true?</Text>
      <Text style={styles.sectionBody}>Your independent take helps confirm — or contest — what others reported.</Text>
      <ClaimConfirmBar onConfirm={onConfirm} busy={busy} selected={selected} />
      {selected ? <Text style={styles.confirmedNote}>Recorded. Thanks for keeping it honest.</Text> : null}
      {error ? (
        <View style={styles.errorRow}>
          <AlertCircle size={13} color={color.signal} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ── Correction ────────────────────────────────────────────────────────────────
function CorrectionSection({ claimId, subjectId, claimType }: { claimId: string; subjectId?: string; claimType?: string }) {
  const options = claimType ? correctionOptionsFor(claimType) : null;
  const [busyOption, setBusyOption] = useState<string | null>(null);
  const [corrected, setCorrected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onCorrect = useCallback(
    async (option: string) => {
      if (!subjectId || !claimType) return;
      const value = optionToClaimValue(claimType, option);
      if (!value) {
        setError('That option can’t be applied here.');
        return;
      }
      setError(null);
      setBusyOption(option);
      const res = await correctClaim(claimId, { subjectId, claimType, value });
      setBusyOption(null);
      if (res.ok) setCorrected(option);
      else setError(res.code === 'feature_disabled' ? 'Capture is turned off.' : 'Could not submit — try again.');
    },
    [claimId, subjectId, claimType],
  );

  if (!claimType || !options) {
    return (
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Pencil size={16} color={color.mute} />
          <Text style={styles.sectionTitle}>Suggest a correction</Text>
        </View>
        <Text style={styles.sectionBody}>Corrections for this kind of claim aren’t available yet.</Text>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionTitleRow}>
        <Pencil size={16} color={color.mute} />
        <Text style={styles.sectionTitle}>Suggest a correction</Text>
      </View>
      <Text style={styles.sectionBody}>
        What’s the {claimTypeLabel(claimType).toLowerCase()} actually like now? Your report supersedes the old one.
      </Text>
      {!subjectId ? (
        <Text style={styles.plannedNote}>Open from a place to submit a correction.</Text>
      ) : (
        <OptionPills options={options} onSelect={onCorrect} busyOption={busyOption} selectedOption={corrected} testIDPrefix="intel-correct" />
      )}
      {corrected ? (
        <Text style={styles.confirmedNote}>Correction sent: {formatClaimValue(claimType, optionToClaimValue(claimType, corrected) ?? {})}.</Text>
      ) : null}
      {error ? (
        <View style={styles.errorRow}>
          <AlertCircle size={13} color={color.signal} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  sectionTitle: { ...typography.sectionTitle, color: color.ink },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionBody: { ...typography.caption, color: color.mute, lineHeight: 19 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stepBadge: {
    width: 26,
    height: 26,
    borderRadius: 999,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepIndex: { ...typography.button },
  stepTitle: { ...typography.body, color: color.ink },
  doneBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.success + '14',
  },
  doneBannerText: { ...typography.caption, color: color.success, flexShrink: 1 },
  confirmedNote: { ...typography.caption, color: color.success },
  plannedNote: { ...typography.caption, color: color.faint, fontStyle: 'italic' },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorText: { ...typography.caption, color: color.signal },
});
