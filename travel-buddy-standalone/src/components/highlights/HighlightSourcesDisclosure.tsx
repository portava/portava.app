/**
 * HighlightSourcesDisclosure — "what this Highlight is built from".
 *
 * Highlights/Memories Development Architecture Spec v1 §12 (a Highlight is a
 * projection over Memories) and §4 (TruthLevel: USER_ASSERTED, SYSTEM_OBSERVED,
 * MUTUALLY_CONFIRMED, INFERRED, UNKNOWN). Census H93.
 *
 * ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────
 *
 * 1. IT NEVER PRINTS "BUILT FROM NOTHING" FOR A READ THAT DID NOT HAPPEN.
 *    Four states in, four states out. `idle`, `loading` and `refused` each say
 *    what they are; only a 200 that returned an empty list is allowed to say
 *    this Highlight is sourceless. §28.11.
 *
 * 2. IT NEVER RENDERS THE FIVE TRUTH LEVELS AS ONE. §4 exists because "a
 *    person said so" and "an engine guessed" are different claims. The label is
 *    per source and comes from the row.
 *
 * 3. IT DOES NOT OFFER A RETRY FOR `feature_disabled`. That answer means
 *    migration 2722 is absent on the deployment being talked to, and no number
 *    of taps will change it. `degraded_unavailable` and `network_unreachable`
 *    do get one, because for those the read genuinely might succeed next time.
 *
 * ── WHERE IT IS MOUNTED, AND WHERE IT SHOULD ALSO BE ───────────────────────
 *
 * Mounted in `app/highlights/archived.tsx`, the owner's retained record, which
 * is where "what was this made from" is the question a person actually has
 * before restoring something. `src/components/HighlightViewer.tsx` is the other
 * place it belongs and is outside this lane's file ownership — see LANE_REPORT
 * "NOT DONE AND WHY" (b).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  useHighlightSources,
  type HighlightSourcesState,
} from '../../hooks/useHighlightSources.ts';
import type { HighlightErrorKind, HighlightSourceProvenance } from '../../services/highlights.ts';

/**
 * §4's five, in words a person reads, with the distinction kept.
 *
 * `UNKNOWN` is a stored value, not a gap: 2722's CHECK admits it, and a link
 * whose provenance nobody recorded is a different thing from a link that was
 * inferred.
 */
const PROVENANCE_LABEL: Record<HighlightSourceProvenance, string> = {
  USER_ASSERTED: 'You said so',
  SYSTEM_OBSERVED: 'Observed by Portava',
  MUTUALLY_CONFIRMED: 'Confirmed by everyone involved',
  INFERRED: 'Inferred',
  UNKNOWN: 'Source recorded without a provenance',
};

/** Which refusals are worth a "Try again", and which are permanent. */
function isRetryable(kind: HighlightErrorKind | null): boolean {
  return kind === 'degraded_unavailable' || kind === 'network_unreachable' || kind === 'db_error';
}

function refusalText(kind: HighlightErrorKind | null, message: string | null): string {
  switch (kind) {
    case 'feature_disabled':
      return 'This build can’t tell you what a highlight was built from.';
    case 'degraded_unavailable':
      return 'We couldn’t check what this was built from. Please try again in a moment.';
    case 'network_unreachable':
      return 'You appear to be offline, so we couldn’t check what this was built from.';
    case 'not_found':
      return 'We couldn’t find this highlight.';
    case 'unauthenticated':
      return 'Please sign in again to see what this was built from.';
    case 'config_error':
      return 'Highlight sources aren’t available on this build.';
    default:
      return message ?? 'We couldn’t check what this was built from.';
  }
}

export interface HighlightSourcesDisclosureProps {
  highlightId: string;
  expanded: boolean;
  onToggle: () => void;
  /**
   * Injected only by tests, which must not reach the network. Production
   * callers omit it and get the real hook.
   */
  stateOverride?: HighlightSourcesState;
}

export function HighlightSourcesDisclosure({
  highlightId,
  expanded,
  onToggle,
  stateOverride,
}: HighlightSourcesDisclosureProps) {
  // Hooks are unconditional; the override only replaces what is READ, so the
  // hook order is identical in both paths.
  const live = useHighlightSources(highlightId, expanded && !stateOverride);
  const state = stateOverride ?? live;

  return (
    <View style={s.wrap} testID={`highlight-sources-${highlightId}`}>
      <Pressable
        onPress={onToggle}
        style={s.header}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel="What this highlight is built from"
        testID={`highlight-sources-toggle-${highlightId}`}
      >
        {expanded
          ? <ChevronDown size={14} color={color.mute} />
          : <ChevronRight size={14} color={color.mute} />}
        <Layers size={13} color={color.mute} />
        <Text style={s.headerText}>What this is built from</Text>
      </Pressable>

      {!expanded ? null : state.status === 'loading' ? (
        <View style={s.body} testID={`highlight-sources-loading-${highlightId}`}>
          <ActivityIndicator size="small" color={color.signal} />
        </View>
      ) : state.status === 'refused' ? (
        <View style={s.body} testID={`highlight-sources-refused-${highlightId}`}>
          <Text style={s.note}>{refusalText(state.errorKind, state.message)}</Text>
          {isRetryable(state.errorKind) ? (
            <Pressable
              onPress={state.load}
              style={s.retry}
              accessibilityRole="button"
              testID={`highlight-sources-retry-${highlightId}`}
            >
              <Text style={s.retryText}>Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : state.status === 'ready' && state.sources.length === 0 ? (
        <View style={s.body} testID={`highlight-sources-none-${highlightId}`}>
          {/* The ONE place an empty answer may be printed as an empty answer:
              the server returned 200, so "sourceless" is a finding. §12 / H93. */}
          <Text style={s.note}>
            This highlight isn’t built from a memory. It was posted on its own.
          </Text>
        </View>
      ) : state.status === 'ready' ? (
        <View style={s.body} testID={`highlight-sources-list-${highlightId}`}>
          {state.sources.map((src) => (
            <View key={`${src.sourceType}:${src.sourceId}`} style={s.sourceRow}>
              <Text style={s.sourceTitle} numberOfLines={1}>
                {src.sourceType === 'MEMORY' ? 'Memory' : 'Episode'}
              </Text>
              <Text style={s.sourceNote} numberOfLines={1}>
                {PROVENANCE_LABEL[src.provenance] ?? PROVENANCE_LABEL.UNKNOWN}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        // `idle` with the row expanded is the single frame before the hook's
        // effect runs. It says nothing rather than guessing.
        <View style={s.body} testID={`highlight-sources-idle-${highlightId}`} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: space.xs },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.xs },
  headerText: { ...t.small, color: color.mute, fontSize: 11 },
  body: { paddingLeft: space.lg, gap: space.xs },
  note: { ...t.small, color: color.faint, fontSize: 11 },
  sourceRow: { gap: 1 },
  sourceTitle: { ...t.bodyStrong, color: color.ink, fontSize: 12 },
  sourceNote: { ...t.small, color: color.faint, fontSize: 11 },
  retry: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  retryText: { ...t.bodyStrong, color: color.ink, fontSize: 12 },
});
