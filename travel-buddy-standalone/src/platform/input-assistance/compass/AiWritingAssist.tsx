/**
 * AiWritingAssist — the inline, OPT-IN AI writing surface (spec §22, §2, §38).
 *
 * One drop-in surface a screen renders BELOW a writing field (caption /
 * event title+description / trip+plan title / compass prompt). It shows the
 * gateway's `ai_suggestion` proposals — provenance-marked, tap-to-insert — via
 * the shared `AiSuggestionRow`. It is SECONDARY by placement (rendered after the
 * field's own value and any canonical assistance) and SAFE by contract:
 *
 *   §22  Every proposal is tap-to-insert into an EDITABLE field. NOTHING is
 *        auto-applied and NOTHING is auto-submitted — `onInsert` fires only on a
 *        user tap, and the consumer places the editable text in the field.
 *   §38  Degrade: when there are no proposals (the AI flag is off ⇒ the gateway
 *        returns none, or the endpoint is unavailable) and nothing is loading,
 *        this renders `null` — the field behaves exactly as before, no error.
 *
 * Presentational: the screen owns the hook (`useAiWritingAssist`) and feeds
 * `proposals` / `loading` here — mirroring how `CreationAssist` is fed.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Sparkles } from 'lucide-react-native';
import { AiSuggestionRow } from '../components/AiSuggestionRow.tsx';
import type { AiWritingProposal } from './aiWriting.ts';
import { color, space, radius, type as t, icon as iconToken } from '../../../theme/tokens.ts';

export interface AiWritingAssistProps {
  /** The opt-in AI proposals mapped from the gateway (empty ⇒ nothing shows). */
  proposals: AiWritingProposal[];
  /** True while an opted-in AI request is in flight. */
  loading?: boolean;
  /** User TAPPED a proposal — insert its editable text into the field (§22). */
  onInsert: (p: AiWritingProposal) => void;
  /** User dismissed a proposal. Optional. */
  onDismiss?: (p: AiWritingProposal) => void;
  /** Header label (default "AI suggestions"). */
  heading?: string;
  testID?: string;
}

function AiWritingAssistBase({
  proposals,
  loading,
  onInsert,
  onDismiss,
  heading = 'AI suggestions',
  testID,
}: AiWritingAssistProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const visible = proposals.filter((p) => !dismissed.has(p.id));

  // §38 degrade: nothing to show and nothing loading ⇒ render nothing at all.
  if (visible.length === 0 && !loading) return null;

  const handleDismiss = (p: AiWritingProposal) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(p.id);
      return next;
    });
    onDismiss?.(p);
  };

  return (
    <View style={styles.wrap} testID={testID ?? 'ai-writing-assist'}>
      <View style={styles.headingRow}>
        <Sparkles size={iconToken.s14} color={color.signal} />
        <Text style={styles.heading} accessibilityRole="header">
          {heading}
        </Text>
        <Text style={styles.provenance}> · you can edit before using</Text>
      </View>

      {loading && visible.length === 0 ? (
        <View style={styles.loadingRow} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={color.signal} />
          <Text style={styles.loadingText}>Drafting a suggestion…</Text>
        </View>
      ) : null}

      {visible.map((p) => (
        <AiSuggestionRow
          key={p.id}
          suggestion={p.suggestion}
          onInsert={() => onInsert(p)}
          onDismiss={() => handleDismiss(p)}
        />
      ))}
    </View>
  );
}

export const AiWritingAssist = React.memo(AiWritingAssistBase);

const styles = StyleSheet.create({
  wrap: {
    gap: space.sm,
    marginTop: space.sm,
    padding: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  heading: {
    ...t.stamp,
    color: color.signal,
  },
  provenance: {
    ...t.stamp,
    color: color.faint,
    flexShrink: 1,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
  },
  loadingText: {
    ...t.small,
    color: color.mute,
  },
});
