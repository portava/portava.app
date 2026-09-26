/**
 * LayoverDiscoveryCard — §25.2 / census L269, the layover Discovery surface.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `GET /api/hidden-gems/layover-safe` and `services/hiddenGems.getLayoverGems`
 * have both existed for several census passes with NO CALLER UNDER
 * `app/layover/`. `layover_discovery_mode_enabled` (migration 2971) is the gate
 * that narrows what that endpoint serves inside an airport session, and it
 * cannot sensibly be enabled against a capability no screen reaches — the
 * deployed consumer is the thing to verify before the flag moves. This is it.
 *
 * ── FOUR ANSWERS, FOUR RENDERINGS, AND THE THIRD IS THE ONE THAT MATTERS ─────
 *   served, non-empty  the gems.
 *   served, empty      a MEASURED empty, said as one.
 *   gate OFF           NOTHING. No card, no heading, no "nothing nearby", no
 *                      spinner left spinning. The capability was not offered,
 *                      so the traveller is told nothing about it — which is a
 *                      different fact from "we looked and found none", and the
 *                      two must not share a rendering.
 *   read failed        the SERVER's refusal sentence.
 *
 * A FAILED READ IS NEVER AN EMPTY RESULT. `services/layover.getLayoverDiscovery`
 * answers a discriminated union precisely so that this component cannot
 * collapse the four; the only other layover-gem reader on this tree,
 * `useHiddenGems.useLayoverGems`, does `.catch(() => setGems([]))`, which turns
 * an offline device into an empty city. Nothing here does that.
 *
 * ── THIS CARD DECIDES NO FEASIBILITY ─────────────────────────────────────────
 * `availableMinutes` arrives as a prop and is the server's certified
 * `window.usableMinutes`. The route filters on it. Each gem's
 * `minimumLayoverMinutes` is stated as the SERVER's figure and is never
 * compared against anything here — no "fits" badge, no re-sort by margin.
 * `LayoverReturnPanel.tsx` was deleted at `a718beb5` for carrying its own
 * thresholds, and a second opinion about whether a place fits a layover would
 * be that defect on a surface that invites the traveller to leave the airport.
 *
 * ── PLACEMENT ────────────────────────────────────────────────────────────────
 * Mounted inside the dashboard's exploration block, so at RETURN_NOW it
 * collapses with the recommendations, the map and the people — the certified
 * posture decides whether exploration is the default answer, not this card.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gem, RefreshCw } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { getLayoverDiscovery, type LayoverDiscoveryRead } from '../../services/layover.ts';

interface Props {
  /**
   * The server's certified `window.usableMinutes`. Zero or less means the
   * certified window does not exist, and nothing is asked for — see `load`.
   */
  availableMinutes: number;
  city: string | null;
  /** Bumped by the parent on pull-to-refresh so this card reloads with it. */
  refreshKey?: number;
}

type LoadState = { kind: 'loading' } | { kind: 'idle' } | { kind: 'done'; read: LayoverDiscoveryRead };

export function LayoverDiscoveryCard({ availableMinutes, city, refreshKey = 0 }: Props) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });

  const run = useCallback(async () => {
    // A window that does not exist is not a window of zero minutes. The route
    // rejects `availableMinutes < 1` as `invalid_payload`, so asking anyway
    // would turn a certified "you cannot leave the airport" into a 400 and then
    // into a refusal sentence about a database — which is not what happened.
    if (!Number.isFinite(availableMinutes) || availableMinutes < 1) {
      setLoad({ kind: 'idle' });
      return;
    }
    setLoad({ kind: 'loading' });
    setLoad({ kind: 'done', read: await getLayoverDiscovery(availableMinutes, city) });
  }, [availableMinutes, city]);

  useEffect(() => { void run(); }, [run, refreshKey]);

  if (load.kind === 'idle') return null;

  if (load.kind === 'loading') {
    return (
      <View style={styles.card} testID="layover-discovery-loading">
        <Header />
        <ActivityIndicator color={color.deep} style={{ marginTop: space.md }} />
      </View>
    );
  }

  const { read } = load;

  // THE GATE IS OFF. Render nothing at all — see the header.
  if (!read.ok && read.reason === 'gated_off') return null;

  if (!read.ok) {
    return (
      <View style={styles.card} testID="layover-discovery-error">
        <Header />
        {/* The server's sentence, quoted. Not a sentence written here about
            what might have gone wrong. */}
        <Text style={styles.errorText}>{read.message}</Text>
        {read.retryable ? (
          <Pressable
            accessibilityRole="button"
            style={styles.retryBtn}
            onPress={() => { void run(); }}
            testID="layover-discovery-retry"
          >
            <RefreshCw size={13} color={color.ink} />
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (read.gems.length === 0) {
    return (
      <View style={styles.card} testID="layover-discovery-empty">
        <Header />
        <Text style={styles.emptyText}>
          Nothing local is logged{city ? ` in ${city}` : ''} for a layover this length yet.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card} testID="layover-discovery-card">
      <Header />
      <Text style={styles.sub}>
        Places other travellers logged that fit a layover of this length.
      </Text>
      {read.gems.map((gem) => (
        <View key={gem.id} style={styles.row} testID={`layover-discovery-gem-${gem.id}`}>
          <Text style={styles.gemName}>{gem.name}</Text>
          <View style={styles.metaRow}>
            {gem.neighborhood ? <Text style={styles.meta}>{gem.neighborhood}</Text> : null}
            {/* The SERVER's figure for this gem, stated. Never compared with
                `availableMinutes` here — see the header. */}
            {gem.minimumLayoverMinutes != null ? (
              <Text style={styles.meta}>needs {gem.minimumLayoverMinutes} min</Text>
            ) : (
              <Text style={styles.meta}>no minimum logged</Text>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

function Header() {
  return (
    <View style={styles.headRow}>
      <Gem size={18} color={color.ink} />
      <Text style={styles.heading}>Worth leaving for</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card:      { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headRow:   { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading:   { ...t.heading, color: color.ink },
  sub:       { ...t.small, color: color.faint },

  row:       { backgroundColor: color.paper, borderRadius: radius.md, padding: space.md, gap: 2 },
  gemName:   { ...t.bodyStrong, color: color.ink },
  metaRow:   { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  meta:      { ...t.stamp, color: color.faint },

  // A measured empty is not a problem, so it is not coloured like one.
  emptyText: { ...t.small, color: color.mute },
  errorText: { ...t.small, color: color.ink, fontWeight: '600' },
  retryBtn:  { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.sm, backgroundColor: color.haze },
  retryText: { ...t.small, color: color.ink, fontWeight: '600' },
});
