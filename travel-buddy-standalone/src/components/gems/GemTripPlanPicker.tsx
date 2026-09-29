/**
 * GemTripPlanPicker — add a hidden gem to one of my trips' PLAN.
 * TM-social, PLAT-F37.
 *
 * POST /api/hidden-gems/:id/plan (routes/hiddenGems.ts) writes a
 * trip_plan_items row — the itinerary the trip's crew sees. That is a
 * different thing from the trip WISHLIST (TripWishlistPicker, a saved-places
 * list), which is what "Add to Plan" used to open; the wishlist stays one tap
 * away at the foot of this sheet.
 *
 * Every outcome is the server's, reported as it is:
 *   201            → "Added"
 *   409 duplicate  → "Already in plan" (the end state the user asked for)
 *   403            → this trip's plan is not yours to edit
 *   404            → the trip or gem is gone / hidden gems are off
 *   anything else  → "Couldn't add", and the row can be tried again.
 * A failed trips read is "couldn't load your trips" with a retry, never "you
 * have no trips" (listMyTrips throws for exactly this reason).
 *
 * Location: the server decides what coordinates the plan row carries
 * (resolveGemCoords), so a protected gem is never revealed by this sheet.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { X, Check, CalendarPlus, AlertCircle } from 'lucide-react-native';
import { listMyTrips, type TripRow } from '../../services/trips.ts';
import { addGemToPlan } from '../../services/hiddenGems.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

export type GemPlanOutcome = 'added' | 'duplicate' | 'forbidden' | 'not_found' | 'failed';

/** Map a thrown apiFetch error (status + code attached) to an outcome. */
export function gemPlanOutcomeFromError(e: unknown): GemPlanOutcome {
  const err = (e ?? {}) as { status?: unknown; code?: unknown };
  if (err.status === 409 || err.code === 'duplicate') return 'duplicate';
  if (err.status === 403 || err.code === 'forbidden') return 'forbidden';
  if (err.status === 404 || err.code === 'not_found' || err.code === 'feature_disabled') return 'not_found';
  return 'failed';
}

const OUTCOME_COPY: Record<GemPlanOutcome, string> = {
  added: 'Added to plan',
  duplicate: 'Already in plan',
  forbidden: "You can't edit this trip's plan",
  not_found: 'This trip or gem is no longer available',
  failed: "Couldn't add — tap to try again",
};

interface Props {
  gemId: string;
  gemName: string;
  visible: boolean;
  onClose: () => void;
  /** Opens the trip WISHLIST picker instead. */
  onOpenWishlist?: () => void;
}

type TripsLoad = { state: 'loading' } | { state: 'error' } | { state: 'ok'; trips: TripRow[] };

export function GemTripPlanPicker({ gemId, gemName, visible, onClose, onOpenWishlist }: Props) {
  const [trips, setTrips] = useState<TripsLoad>({ state: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, GemPlanOutcome>>({});

  const load = useCallback(async () => {
    setTrips({ state: 'loading' });
    try {
      const rows = await listMyTrips();
      // Only trips still ahead or under way are worth planning into.
      setTrips({ state: 'ok', trips: rows.filter((r) => r.status !== 'cancelled' && r.status !== 'completed') });
    } catch {
      setTrips({ state: 'error' });
    }
  }, []);

  useEffect(() => { if (visible) { setOutcomes({}); void load(); } }, [visible, load]);

  async function pick(trip: TripRow) {
    if (busy) return;
    const prev = outcomes[trip.id];
    if (prev === 'added' || prev === 'duplicate' || prev === 'forbidden' || prev === 'not_found') return;
    setBusy(trip.id);
    let outcome: GemPlanOutcome;
    try {
      const res = await addGemToPlan(gemId, trip.id);
      outcome = res?.ok ? 'added' : 'failed';
    } catch (e) {
      outcome = gemPlanOutcomeFromError(e);
    }
    setBusy(null);
    setOutcomes((o) => ({ ...o, [trip.id]: outcome }));
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={s.sheet} testID="gem-plan-picker">
        <View style={s.head}>
          <CalendarPlus size={18} color={color.ink} />
          <Text style={s.title} numberOfLines={1}>Add {gemName} to a trip plan</Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8}>
            <X size={18} color={color.mute} />
          </Pressable>
        </View>

        {trips.state === 'loading' ? (
          <ActivityIndicator color={color.signal} style={{ marginVertical: space.lg }} testID="gem-plan-loading" />
        ) : trips.state === 'error' ? (
          <View style={s.stateBox}>
            <Text style={s.stateText}>Couldn't load your trips.</Text>
            <Pressable onPress={() => { void load(); }} accessibilityRole="button" testID="gem-plan-retry">
              <Text style={s.link}>Try again</Text>
            </Pressable>
          </View>
        ) : trips.trips.length === 0 ? (
          <Text style={s.stateText}>You have no upcoming trips to plan into.</Text>
        ) : (
          <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: space.xs }}>
            {trips.trips.map((trip) => {
              const outcome = outcomes[trip.id];
              const done = outcome === 'added' || outcome === 'duplicate';
              const bad = outcome === 'forbidden' || outcome === 'not_found' || outcome === 'failed';
              return (
                <Pressable
                  key={trip.id}
                  style={s.row}
                  onPress={() => { void pick(trip); }}
                  disabled={busy !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`Add to ${trip.title || trip.destinationCity}`}
                  testID={`gem-plan-trip-${trip.id}`}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.tripTitle} numberOfLines={1}>{trip.title || trip.destinationCity}</Text>
                    {outcome ? (
                      <Text style={[s.outcome, bad && s.outcomeBad]} testID={`gem-plan-outcome-${trip.id}`}>
                        {OUTCOME_COPY[outcome]}
                      </Text>
                    ) : (
                      <Text style={s.sub} numberOfLines={1}>{[trip.destinationCity, trip.destinationCountry].filter(Boolean).join(', ')}</Text>
                    )}
                  </View>
                  {busy === trip.id ? <ActivityIndicator size="small" color={color.signal} />
                    : done ? <Check size={18} color={color.deep} />
                    : bad ? <AlertCircle size={18} color={color.signal} />
                    : null}
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {onOpenWishlist ? (
          <Pressable style={s.footer} onPress={onOpenWishlist} accessibilityRole="button" testID="gem-plan-wishlist">
            <Text style={s.link}>Save to a trip wishlist instead</Text>
          </Pressable>
        ) : null}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: space.lg, gap: space.md, paddingBottom: space.xl,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.bodyStrong, color: color.ink, flex: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  tripTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  sub: { ...t.small, color: color.mute },
  outcome: { ...t.small, color: color.deep, fontWeight: '600' },
  outcomeBad: { color: color.signal },
  stateBox: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  stateText: { ...t.small, color: color.mute, paddingVertical: space.sm },
  link: { ...t.small, color: color.signal, fontWeight: '700' },
  footer: { alignItems: 'center', paddingTop: space.sm },
});
