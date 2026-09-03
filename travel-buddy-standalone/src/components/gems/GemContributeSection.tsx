/**
 * GemContributeSection — §16.3 structured gem contributions.
 *
 * Offers the nine structured contribution actions (still here / still worth it /
 * access changed / closed / too crowded / seasonal / harder to reach / better
 * entrance / no longer hidden). Each is an OBSERVATION the visitor shares; the
 * backend guarantees a single one never flips the gem's canonical state, so the
 * copy here frames it as "an update", never a verdict.
 *
 * Posts to POST /hidden-gems/:id/contribute via contributeToGem(). On success
 * the freshly-derived (still community-derived, not flipped) gemState +
 * gemConfidence are handed back to the parent so the visible status can update.
 *
 * Additive: this sits alongside the existing verify-visit / report UI and does
 * not replace them. It reuses the gem-protection model — no precise-location
 * capture, no popularity language.
 */
import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  GEM_CONTRIBUTION_ACTIONS,
  type GemContributionType,
  type GemContributionTone,
  type GemState,
  type GemConfidence,
} from '../../lib/gems/gemStateDisplay.ts';
import { contributeToGem } from '../../services/hiddenGems.ts';

const TONE_FG: Record<GemContributionTone, string> = {
  positive: '#6FD39A',
  neutral: '#9DB8E8',
  caution: '#E8B24D',
};

export interface GemContributeSectionProps {
  gemId: string;
  isAuthed: boolean;
  /** Called after a successful contribution with the re-derived projection. */
  onContributed?: (gemState: GemState | null, gemConfidence: GemConfidence | null) => void;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting'; type: GemContributionType }
  | { kind: 'done'; type: GemContributionType; already: boolean }
  | { kind: 'error' };

export function GemContributeSection({ gemId, isAuthed, onContributed }: GemContributeSectionProps) {
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });

  const handlePress = useCallback(async (type: GemContributionType) => {
    if (submit.kind === 'submitting') return;
    setSubmit({ kind: 'submitting', type });
    try {
      const res = await contributeToGem(gemId, type);
      setSubmit({ kind: 'done', type, already: res.alreadyObserved });
      onContributed?.(res.gemState, res.gemConfidence);
    } catch {
      setSubmit({ kind: 'error' });
    }
  }, [gemId, submit.kind, onContributed]);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Been here recently?</Text>
      <Text style={styles.subtitle}>
        Share what you found — it helps keep this gem accurate. One update is an
        observation, not the final word.
      </Text>

      {!isAuthed ? (
        <View style={styles.signedOut}>
          <Ionicons name="lock-closed-outline" size={15} color="#8A9BB5" />
          <Text style={styles.signedOutText}>Sign in to share an update.</Text>
        </View>
      ) : (
        <>
          <View style={styles.grid}>
            {GEM_CONTRIBUTION_ACTIONS.map((action) => {
              const isThis = submit.kind === 'submitting' && submit.type === action.type;
              const isDoneThis = submit.kind === 'done' && submit.type === action.type;
              const fg = TONE_FG[action.tone];
              return (
                <Pressable
                  key={action.type}
                  style={({ pressed }) => [
                    styles.chip,
                    { borderColor: `${fg}55` },
                    isDoneThis && { backgroundColor: `${fg}22`, borderColor: `${fg}99` },
                    pressed && styles.chipPressed,
                  ]}
                  onPress={() => handlePress(action.type)}
                  disabled={submit.kind === 'submitting'}
                  accessibilityRole="button"
                  accessibilityLabel={action.description}
                >
                  {isThis ? (
                    <ActivityIndicator size="small" color={fg} />
                  ) : (
                    <Ionicons
                      name={(isDoneThis ? 'checkmark-circle' : action.icon) as any}
                      size={14}
                      color={fg}
                    />
                  )}
                  <Text style={[styles.chipText, { color: fg }]}>{action.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {submit.kind === 'done' ? (
            <Text style={styles.feedback}>
              {submit.already
                ? "You'd already shared this — thanks for confirming."
                : 'Thanks — your observation was noted.'}
            </Text>
          ) : null}
          {submit.kind === 'error' ? (
            <Text style={styles.feedbackError}>Could not save that just now. Try again.</Text>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#13213A',
    borderRadius: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 16,
    gap: 6,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#E8F0FE',
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    color: '#8A9BB5',
    marginBottom: 6,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 36,
  },
  chipPressed: {
    opacity: 0.7,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  feedback: {
    fontSize: 13,
    color: '#6FD39A',
    marginTop: 8,
  },
  feedbackError: {
    fontSize: 13,
    color: '#FF6B6B',
    marginTop: 8,
  },
  signedOut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  signedOutText: {
    fontSize: 13,
    color: '#8A9BB5',
  },
});
