/**
 * The OD-INPUT-1 opt-in, as a self-contained settings row.
 *
 * "Explicit opt-in, off by default, purpose-limited, and separated from core
 * assistance." How each clause shows up here:
 *   - EXPLICIT: turning the switch on does not grant anything. It opens the
 *     disclosure (outcomeLearning.ts OUTCOME_DISCLOSURE_BODY) and only "Allow"
 *     sends the grant — with the version of the words shown, which the server
 *     checks against the version it stamps.
 *   - OFF BY DEFAULT: the switch reflects the SERVER's answer and starts off.
 *   - PURPOSE-LIMITED: the words say what is kept, for what, for how long.
 *   - SEPARATED: nothing about suggestions changes either way; the row says so.
 *   - WITHDRAWAL IS ONE TAP, and the row says whether what was kept was deleted
 *     now or will expire — a failed delete is reported, not hidden.
 *
 * An UNREADABLE setting renders as unreadable with a retry — never as "off",
 * which would invite the person to re-grant a consent they already gave or hide
 * one they came here to withdraw.
 *
 * Rendered by app/settings/index.tsx behind `input_outcome_learning_enabled`;
 * it also hides itself when the server says the setting is not offered, unless
 * the person is still opted in (they must always be able to withdraw).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Switch, Pressable, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import {
  OUTCOME_DISCLOSURE_BODY,
  OUTCOME_DISCLOSURE_TITLE,
  applyOutcomeConsent,
  currentOutcomeAccount,
  stateGrantsOutcomes,
  type OutcomeConsentState,
} from '../services/outcomeLearning.ts';
import {
  readOutcomeConsent as defaultRead,
  writeOutcomeConsent as defaultWrite,
  type OutcomeConsentRead,
  type OutcomeConsentWrite,
} from '../services/outcomeLearningTransport.ts';

export interface OutcomeLearningSettingProps {
  read?: () => Promise<OutcomeConsentRead>;
  write?: (enabled: boolean) => Promise<OutcomeConsentWrite>;
}

type View_ =
  | { kind: 'loading' }
  | { kind: 'unreadable' }
  | { kind: 'ready'; state: OutcomeConsentState };

export function OutcomeLearningSetting({ read = defaultRead, write = defaultWrite }: OutcomeLearningSettingProps) {
  const [view, setView] = useState<View_>({ kind: 'loading' });
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setView({ kind: 'loading' });
    const r = await read();
    if (r.status === 'ok') {
      setView({ kind: 'ready', state: r.state });
      applyOutcomeConsent(currentOutcomeAccount(), stateGrantsOutcomes(r.state));
    } else {
      setView({ kind: 'unreadable' });
    }
  }, [read]);

  useEffect(() => {
    void load();
  }, [load]);

  const commit = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      setNote(null);
      const w = await write(enabled);
      setBusy(false);
      setReviewing(false);
      if (w.status === 'ok') {
        setView({ kind: 'ready', state: w.state });
        applyOutcomeConsent(currentOutcomeAccount(), stateGrantsOutcomes(w.state));
        if (!enabled) {
          setNote(
            w.countersErased === false
              ? 'Turned off. What we kept will be deleted within 30 days.'
              : 'Turned off. What we kept has been deleted.',
          );
        }
        return;
      }
      if (w.status === 'stale_disclosure') {
        setNote('This explanation has changed. Please read it again.');
        void load();
        return;
      }
      if (w.status === 'unavailable') {
        setNote('This setting isn’t available yet.');
        return;
      }
      setNote('Your change couldn’t be saved. Please try again.');
    },
    [write, load],
  );

  if (view.kind === 'loading') return null;

  if (view.kind === 'unreadable') {
    return (
      <View style={styles.card} testID="outcome-learning-unreadable">
        <Text style={styles.title}>{OUTCOME_DISCLOSURE_TITLE}</Text>
        <Text style={styles.body}>This setting couldn’t be loaded.</Text>
        <Pressable accessibilityRole="button" onPress={() => void load()} testID="outcome-learning-retry">
          <Text style={styles.link}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const { state } = view;
  // Offered, or still on (a person can always withdraw).
  if (!state.available && !state.enabled) return null;

  return (
    <View style={styles.card} testID="outcome-learning-setting">
      <View style={styles.row}>
        <Text style={styles.title}>{OUTCOME_DISCLOSURE_TITLE}</Text>
        <Switch
          value={state.enabled || reviewing}
          disabled={busy}
          onValueChange={(next) => {
            if (next) {
              setNote(null);
              setReviewing(true);
            } else if (reviewing) {
              setReviewing(false);
            } else {
              void commit(false);
            }
          }}
          accessibilityLabel={OUTCOME_DISCLOSURE_TITLE}
          testID="outcome-learning-switch"
        />
      </View>
      <Text style={styles.small}>Your suggestions work the same either way.</Text>
      {reviewing ? (
        <View style={styles.review} testID="outcome-learning-disclosure">
          <Text style={styles.body}>{OUTCOME_DISCLOSURE_BODY}</Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => setReviewing(false)}
              testID="outcome-learning-decline"
            >
              <Text style={styles.link}>Not now</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void commit(true)}
              testID="outcome-learning-allow"
            >
              <Text style={styles.primary}>Allow</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {note ? (
        <Text style={styles.small} accessibilityLiveRegion="polite" testID="outcome-learning-note">
          {note}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    gap: space.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  title: { ...t.bodyStrong, color: color.ink, flexShrink: 1 },
  body: { ...t.body, color: color.ink },
  small: { ...t.small, color: color.mute },
  review: { gap: space.md, paddingTop: space.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.xl },
  link: { ...t.bodyStrong, color: color.deep },
  primary: { ...t.bodyStrong, color: color.ink },
});
