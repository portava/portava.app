/**
 * OptimizeTodaySheet — the §11 "Optimize Today" proposal.
 *
 * THE RULE THIS COMPONENT ENFORCES
 * ================================
 * Spec §11: "Proposed changes require user acceptance; the map should not
 * silently rewrite the canonical Trip."
 *
 * So this sheet is a *diff viewer with two buttons*, never an applier. It shows
 * what would move, why it would move, and what it would cost — then hands the
 * decision back through `onAccept` / `onDismiss`. It calls neither
 * `acceptProposal` nor `dismissProposal` itself: those return data the CALLER
 * persists, and putting the call in here would put the write one careless
 * refactor away from happening on render.
 *
 * `optimizeToday` already guarantees the proposal is a deep copy, so nothing
 * this component does can reach the caller's stops either.
 *
 * WHY THE RATIONALE IS NOT DECORATION
 * ===================================
 * §11 lists eight factors a proposal may weigh (distance, reservation times,
 * event schedules, live conditions, closing times, crew position, saved ideas,
 * weather). `optimizeToday` cites only the factors that ACTUALLY moved
 * something, so an empty rationale means nothing had a reason to move — and the
 * sheet says exactly that rather than inventing a justification. A reordering
 * the user cannot explain to themselves is one they should not accept.
 *
 * Dark-mode-first per §4, matching AskCompassBar / LivePulseCard chrome so the
 * floating surfaces read as one system.
 */
import React, { useMemo } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  CloudSun,
  Footprints,
  Minus,
  Plus,
  Sparkles,
  Users,
  X,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { proposalMoves } from '../../features/map/trip/tripMapModel.ts';
import type {
  OptimizeFactor,
  OptimizeProposal,
  ProposalMove,
} from '../../features/map/trip/tripMapModel.ts';

// Matches AskCompassBar / LivePulseCard so the floating surfaces read as one system.
const BRAND_BG = '#0A3D4A';
const SHEET_BG = '#0E1216';
const HAIRLINE = 'rgba(255,255,255,0.14)';
const CHIP_BG = 'rgba(255,255,255,0.08)';

/** One icon per §11 factor, so a rationale line is scannable without reading it. */
const FACTOR_ICON: Record<OptimizeFactor, React.ComponentType<any>> = {
  distance: Footprints,
  reservation_times: Clock,
  event_schedules: Sparkles,
  live_conditions: Sparkles,
  closing_times: Clock,
  crew_position: Users,
  saved_ideas: Plus,
  weather: CloudSun,
};

export interface OptimizeTodaySheetProps {
  /** The proposal to present. `null` renders nothing. */
  proposal: OptimizeProposal | null;
  /**
   * The user accepted. The CALLER calls `acceptProposal(proposal, at)` and
   * persists the result — this component never writes.
   */
  onAccept: (proposal: OptimizeProposal) => void;
  /** The user declined. The canonical ordering stands. */
  onDismiss: (proposal: OptimizeProposal) => void;
  onClose?: () => void;
}

function MoveRow({ move }: { move: ProposalMove }) {
  const moved = move.delta != null && move.delta !== 0;
  const up = move.delta != null && move.delta < 0;

  const Icon = move.added ? Plus : moved ? (up ? ArrowUp : ArrowDown) : Minus;
  const tint = move.added
    ? color.signal
    : moved
      ? up
        ? color.signal
        : color.onInkMute
      : color.onInkMute;

  return (
    <View style={styles.moveRow}>
      <View style={[styles.movePos, move.added && styles.movePosAdded]}>
        <Text style={styles.movePosText}>{move.to + 1}</Text>
      </View>
      <Text style={styles.moveTitle} numberOfLines={1}>
        {move.title}
      </Text>
      <View style={styles.moveDelta}>
        <Icon size={14} color={tint} />
        <Text style={[styles.moveDeltaText, { color: tint }]}>
          {move.added
            ? 'Added'
            : moved
              ? `${up ? 'Up' : 'Down'} ${Math.abs(move.delta as number)}`
              : 'Same'}
        </Text>
      </View>
    </View>
  );
}

export function OptimizeTodaySheet({
  proposal,
  onAccept,
  onDismiss,
  onClose,
}: OptimizeTodaySheetProps) {
  const insets = useSafeAreaInsets();
  const moves = useMemo(() => (proposal ? proposalMoves(proposal) : []), [proposal]);

  if (!proposal) return null;

  const { rationale, unchanged, distanceKm, insertions } = proposal;
  const saved = distanceKm.current - distanceKm.proposed;
  const changedCount = moves.filter((m) => m.added || (m.delta != null && m.delta !== 0)).length;

  return (
    <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Optimize today</Text>
          <Text style={styles.subtitle}>
            {unchanged
              ? 'Your plan is already in a good order'
              : `${changedCount} ${changedCount === 1 ? 'change' : 'changes'} proposed`}
          </Text>
        </View>
        {onClose ? (
          <Pressable
            onPress={onClose}
            style={styles.closeBtn}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <X size={18} color={color.onInkMute} />
          </Pressable>
        ) : null}
      </View>

      {unchanged ? (
        <Text style={styles.emptyNote}>
          Nothing worth moving right now. Your current order already accounts for what Portava can
          see.
        </Text>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollInner}>
          {/* Cost line — the one number that makes the diff worth reading. */}
          <View style={styles.statRow}>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Now</Text>
              <Text style={styles.statValue}>{distanceKm.current.toFixed(1)} km</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Proposed</Text>
              <Text style={[styles.statValue, saved > 0 && styles.statValueGood]}>
                {distanceKm.proposed.toFixed(1)} km
              </Text>
            </View>
            {saved > 0.05 ? (
              <View style={styles.savedChip}>
                <Footprints size={12} color={color.signal} />
                <Text style={styles.savedChipText}>−{saved.toFixed(1)} km</Text>
              </View>
            ) : null}
          </View>

          <Text style={styles.sectionLabel}>PROPOSED ORDER</Text>
          <View style={styles.moves}>
            {moves.map((m) => (
              <MoveRow key={m.stopId} move={m} />
            ))}
          </View>

          <Text style={styles.sectionLabel}>WHY</Text>
          {rationale.length === 0 ? (
            // §11: cite only factors that actually moved something. No reason
            // is a real answer, and a more honest one than a generic sentence.
            <Text style={styles.emptyNote}>
              No single factor drove this — the order just shortens the walk.
            </Text>
          ) : (
            <View style={styles.rationale}>
              {rationale.map((line, i) => {
                const Icon = FACTOR_ICON[line.factor] ?? Sparkles;
                return (
                  <View key={`${line.factor}-${i}`} style={styles.rationaleRow}>
                    <Icon size={14} color={color.onInkMute} style={styles.rationaleIcon} />
                    <Text style={styles.rationaleText}>{line.text}</Text>
                  </View>
                );
              })}
            </View>
          )}

          {insertions.length > 0 ? (
            <>
              <Text style={styles.sectionLabel}>ADDED FROM SAVED IDEAS</Text>
              <Text style={styles.emptyNote}>
                {insertions.map((s) => s.title).join(' · ')}
              </Text>
            </>
          ) : null}
        </ScrollView>
      )}

      <View style={styles.actions}>
        <Pressable
          onPress={() => onDismiss(proposal)}
          style={[styles.btn, styles.btnGhost]}
          accessibilityRole="button"
          accessibilityLabel="Keep my current plan"
        >
          <Text style={styles.btnGhostText}>Keep mine</Text>
        </Pressable>
        <Pressable
          onPress={() => onAccept(proposal)}
          disabled={unchanged}
          style={[styles.btn, styles.btnPrimary, unchanged && styles.btnDisabled]}
          accessibilityRole="button"
          accessibilityLabel="Accept the proposed order"
          accessibilityState={{ disabled: unchanged }}
        >
          <Check size={16} color="#fff" />
          <Text style={styles.btnPrimaryText}>Accept</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: SHEET_BG,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: HAIRLINE,
    paddingHorizontal: space.md,
    paddingTop: space.md,
    maxHeight: '80%',
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  headerText: { flex: 1 },
  title: { ...t.heading, color: color.onInk },
  subtitle: { ...t.small, color: color.onInkMute, marginTop: 2 },
  closeBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: CHIP_BG,
  },

  scroll: { marginTop: space.md },
  scrollInner: { paddingBottom: space.md },

  statRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  stat: {},
  statLabel: { ...t.small, color: color.onInkMute },
  statValue: { ...t.body, color: color.onInk, fontWeight: '600' },
  statValueGood: { color: color.signal },
  savedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: CHIP_BG,
  },
  savedChipText: { ...t.small, color: color.signal, fontWeight: '600' },

  sectionLabel: {
    ...t.small,
    color: color.onInkMute,
    letterSpacing: 0.8,
    marginTop: space.lg,
    marginBottom: space.sm,
  },

  moves: { gap: space.xs },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    backgroundColor: CHIP_BG,
  },
  movePos: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: BRAND_BG,
  },
  movePosAdded: { backgroundColor: color.signal },
  movePosText: { ...t.small, color: '#fff', fontWeight: '700' },
  moveTitle: { ...t.body, color: color.onInk, flex: 1 },
  moveDelta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  moveDeltaText: { ...t.small, fontWeight: '600' },

  rationale: { gap: space.sm },
  rationaleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  rationaleIcon: { marginTop: 2 },
  rationaleText: { ...t.body, color: color.onInk, flex: 1 },

  emptyNote: { ...t.body, color: color.onInkMute, marginTop: space.sm },

  actions: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: HAIRLINE,
  },
  btn: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderRadius: radius.md,
  },
  btnGhost: { backgroundColor: CHIP_BG },
  btnGhostText: { ...t.body, color: color.onInk, fontWeight: '600' },
  btnPrimary: { backgroundColor: color.signal },
  btnPrimaryText: { ...t.body, color: '#fff', fontWeight: '700' },
  btnDisabled: { opacity: 0.4 },
});

export default OptimizeTodaySheet;
