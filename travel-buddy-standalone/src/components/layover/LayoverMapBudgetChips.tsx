/**
 * LayoverMapBudgetChips — spec §13's TIME-BUDGET CHIPS on the layover map
 * (census-layover L118): *"Changing time-budget chips triggers
 * simulation/replanning, not local visual filtering alone."*
 *
 * ── WHAT A CHIP DOES ─────────────────────────────────────────────────────────
 * It asks the SERVER (`POST /airport/sessions/:id/simulate`) to re-band the
 * plan as if the traveller had only that many usable minutes, and the map then
 * draws the stops exactly as the server sent them — pins, blocked list and
 * route. Nothing in this file or in `LayoverMapCard` measures a stop against a
 * budget: there is no filter, no comparison with `neededMin`, no band picked
 * on the device. While the answer is in flight the map keeps the certified
 * bands; a refusal or a failure keeps them too and says why. It never falls
 * back to filtering locally.
 *
 * ── WHICH CHIPS ──────────────────────────────────────────────────────────────
 * Exactly the budgets `GET /overview` offers in `mapBudgetChips` (the server's
 * ladder, each below the certified usable minutes and at or above its floor),
 * plus "All" — the certified time itself, which is the overview's own bands and
 * needs no call. No chips at all unless the server says `available`.
 *
 * ── WHEN THE PLAN CHANGES UNDER AN ACTIVE CHIP ───────────────────────────────
 * The simulation is asked again (the server replans; the old answer is not
 * patched). A budget the server no longer offers clears the chip.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { simulateMapBudget, type MapBudgetChips, type PlanStop } from '../../services/layover.ts';
import { fmtDur } from './layoverFormat.ts';

export interface MapBudgetSimulation {
  /** The chips to offer, or null when the server offers none. */
  chips: MapBudgetChips | null;
  /** The budget whose SERVER answer is on the map; null = the certified time. */
  activeBudget: number | null;
  /** The budget a request is in flight for. */
  pendingBudget: number | null;
  /** The server's stops for `activeBudget`; null = draw the certified stops. */
  stops: PlanStop[] | null;
  /** The server's own sentence for the active simulation. */
  statement: string | null;
  /** Why the last chip press did not change the map. */
  error: string | null;
  /** Press a chip (a budget the server offered), or `null` for the certified time. */
  choose: (budget: number | null) => void;
}

/** What a stop is, as far as the server's banding of it can be affected. */
function stopsSignature(stops: PlanStop[]): string {
  return JSON.stringify(stops.map((s) => [s.id, s.travelMin, s.durationMin, s.insideAirport, s.lat, s.lng]));
}

export function useMapBudgetSimulation(
  sessionId: string | null | undefined,
  offered: MapBudgetChips | null | undefined,
  certifiedStops: PlanStop[],
): MapBudgetSimulation {
  const chips = offered?.available === true && sessionId ? offered : null;
  const [activeBudget, setActiveBudget] = useState<number | null>(null);
  const [pendingBudget, setPendingBudget] = useState<number | null>(null);
  const [stops, setStops] = useState<PlanStop[] | null>(null);
  const [statement, setStatement] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The latest press wins: an earlier answer arriving late is dropped.
  const seq = useRef(0);

  const clear = useCallback(() => {
    seq.current += 1;
    setActiveBudget(null); setPendingBudget(null); setStops(null); setStatement(null);
  }, []);

  const choose = useCallback((budget: number | null) => {
    setError(null);
    if (budget === null || !chips || !sessionId || !chips.budgets.includes(budget)) { clear(); return; }
    const mine = ++seq.current;
    setPendingBudget(budget);
    void simulateMapBudget(sessionId, budget).then((r) => {
      if (mine !== seq.current) return;
      setPendingBudget(null);
      if (r.ok) {
        setActiveBudget(r.budgetMinutes); setStops(r.stops); setStatement(r.statement);
      } else {
        setActiveBudget(null); setStops(null); setStatement(null); setError(r.message);
      }
    });
  }, [chips, sessionId, clear]);

  // A budget the server no longer offers is cleared; a changed plan is simulated again.
  const budgetsKey = chips ? chips.budgets.join(',') : '';
  const planKey = useMemo(() => stopsSignature(certifiedStops), [certifiedStops]);
  const lastPlanKey = useRef(planKey);
  useEffect(() => {
    const planChanged = lastPlanKey.current !== planKey;
    lastPlanKey.current = planKey;
    const current = activeBudget ?? pendingBudget;
    if (current === null) return;
    if (!chips || !chips.budgets.includes(current)) { clear(); return; }
    if (planChanged) choose(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run on the offer or the plan, not on our own state
  }, [budgetsKey, planKey]);

  return { chips, activeBudget, pendingBudget, stops, statement, error, choose };
}

export function LayoverMapBudgetChips({ sim }: { sim: MapBudgetSimulation }) {
  if (!sim.chips) return null;
  const certified = sim.chips.certifiedUsableMinutes;
  const allSelected = sim.activeBudget === null && sim.pendingBudget === null;
  return (
    <View style={styles.wrap} testID="layover-map-budget-chips">
      <Text style={styles.label}>TIME OUT OF THE AIRPORT</Text>
      <View style={styles.row}>
        {sim.chips.budgets.map((b) => {
          const selected = sim.activeBudget === b && sim.pendingBudget === null;
          const pending = sim.pendingBudget === b;
          return (
            <Pressable
              key={b}
              accessibilityRole="button"
              accessibilityLabel={`Simulate ${fmtDur(b)} out of the airport`}
              accessibilityState={{ selected, busy: pending }}
              testID={`layover-map-budget-chip-${b}`}
              style={[styles.chip, selected && styles.chipOn]}
              onPress={() => sim.choose(b)}
            >
              {pending ? <ActivityIndicator size="small" color={color.ink} /> : null}
              <Text style={[styles.chipText, selected && styles.chipTextOn]}>{fmtDur(b)}</Text>
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show your certified time"
          accessibilityState={{ selected: allSelected }}
          testID="layover-map-budget-chip-all"
          style={[styles.chip, allSelected && styles.chipOn]}
          onPress={() => sim.choose(null)}
        >
          <Text style={[styles.chipText, allSelected && styles.chipTextOn]}>
            {certified !== null ? `All ${fmtDur(certified)}` : 'All'}
          </Text>
        </Pressable>
      </View>
      {sim.statement && sim.activeBudget !== null ? (
        <Text style={styles.statement} testID="layover-map-budget-statement">{sim.statement}</Text>
      ) : null}
      {sim.error ? (
        <Text style={styles.error} testID="layover-map-budget-error">{sim.error}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:      { gap: 6 },
  label:     { ...t.stamp, color: color.mute },
  row:       { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip:      { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper, paddingHorizontal: space.sm, paddingVertical: 4 },
  chipOn:    { borderColor: color.ink, backgroundColor: color.ink },
  chipText:  { ...t.small, color: color.ink },
  chipTextOn: { color: color.onInk },
  statement: { ...t.small, color: color.mute },
  error:     { ...t.small, color: color.ink },
});
