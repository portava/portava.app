/**
 * TripInvitePickerSheet — the viewer-side "Invite to trip" action (§3 primary
 * viewer actions · TABLE 29 `can_invite_trip` · §32 trip_invite_from_passport).
 *
 * The existing TripInviteSheet answers "who do I invite to THIS trip?" from a
 * trip page. This sheet is the inverse the Passport needs: "which of MY trips
 * do I invite THIS traveler to?". It lists the trips the viewer OWNS (the
 * server's `POST /trips/:tripId/invite` is owner-only, so listing anything else
 * would offer an action that is guaranteed to fail), sends the invite through
 * the same `sendTripInvite` the trip page uses, and reports the outcome inline
 * per row so several trips can be tried in one visit.
 *
 * The sheet is only ever mounted when the projection said `can_invite_trip`
 * (§30 — the server owns eligibility); it does not re-derive that. The
 * `trip_invite_from_passport` event fires once per SUCCESSFUL send (or an
 * idempotent "already invited/member" answer) — an invite that never reached
 * the server is not an initiated invite.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { CalendarPlus, Check, MapPin, X } from 'lucide-react-native';
import { PortavaSheet } from '../../components/ui/PortavaSheet.tsx';
import { listMyTrips, type TripRow } from '../../services/trips.ts';
import { sendTripInvite } from '../../services/friends.ts';
import { color, space, radius, type as t, icon } from '../../theme/tokens.ts';
import { trackTripInviteFromPassport } from './passportTelemetry.ts';

export interface TripInvitePickerSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The traveler being invited (the viewed Passport's user id). */
  subjectId: string;
  /** Display name for the sheet copy — never leaves the device. */
  subjectName?: string | null;
  /** The signed-in viewer — only trips they own are listed. */
  viewerUserId: string | null;
  /** Test/DI seams — default to the real services. */
  loadTrips?: () => Promise<TripRow[]>;
  invite?: (tripId: string, userId: string) => Promise<{ ok: boolean; data: { status: string } | null }>;
}

type RowState = 'idle' | 'sending' | 'invited' | 'already' | 'failed';

const STATUS_CLOSED = new Set(['completed', 'cancelled', 'canceled', 'archived']);

/** Trips the viewer can actually invite to: owned, and not closed out. Pure. */
export function selectInvitableTrips(trips: TripRow[], viewerUserId: string | null): TripRow[] {
  if (!viewerUserId) return [];
  return trips
    .filter((tr) => tr.ownerId === viewerUserId)
    .filter((tr) => !STATUS_CLOSED.has(String(tr.status ?? '').toLowerCase()));
}

function tripMeta(tr: TripRow): string {
  const place = [tr.destinationCity, tr.destinationCountry].filter((x): x is string => !!x).join(', ');
  const dates = tr.startDate ? (tr.endDate && tr.endDate !== tr.startDate ? `${tr.startDate} – ${tr.endDate}` : tr.startDate) : null;
  return [place, dates].filter(Boolean).join(' · ');
}

export function TripInvitePickerSheet({
  visible,
  onClose,
  subjectId,
  subjectName,
  viewerUserId,
  loadTrips = listMyTrips,
  invite = sendTripInvite,
}: TripInvitePickerSheetProps) {
  const [trips, setTrips] = useState<TripRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const load = useCallback(async () => {
    setLoadError(null);
    setTrips(null);
    try {
      const all = await loadTrips();
      setTrips(selectInvitableTrips(all, viewerUserId));
    } catch {
      setLoadError("Couldn't load your trips.");
      setTrips([]);
    }
  }, [loadTrips, viewerUserId]);

  useEffect(() => {
    if (!visible) return;
    setRows({});
    void load();
  }, [visible, load]);

  const handleInvite = useCallback(async (tripId: string) => {
    setRows((r) => ({ ...r, [tripId]: 'sending' }));
    let next: RowState = 'failed';
    try {
      const res = await invite(tripId, subjectId);
      if (res.ok) {
        next = res.data?.status === 'already_member' ? 'already' : 'invited';
        // §32: the invite reached the server — that is an initiated invite.
        trackTripInviteFromPassport(subjectId);
      }
    } catch {
      next = 'failed';
    }
    setRows((r) => ({ ...r, [tripId]: next }));
  }, [invite, subjectId]);

  const name = subjectName?.trim() || 'this traveler';

  return (
    <PortavaSheet visible={visible} onClose={onClose} accessibilityLabel="Invite to trip" testID="trip-invite-picker">
      <View style={s.header}>
        <View style={s.titleRow}>
          <CalendarPlus size={icon.s18} color={color.ink} />
          <Text style={s.title}>Invite to a trip</Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" testID="trip-invite-close">
          <X size={icon.s20} color={color.ink} />
        </Pressable>
      </View>
      <Text style={s.sub}>Pick one of your trips to invite {name} to.</Text>

      {trips === null ? (
        <View style={s.center} testID="trip-invite-loading"><ActivityIndicator color={color.signal} /></View>
      ) : loadError ? (
        <View style={s.center}>
          <Text style={s.emptyText}>{loadError}</Text>
          <Pressable style={s.retryBtn} onPress={() => void load()} accessibilityRole="button" testID="trip-invite-retry">
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : trips.length === 0 ? (
        <View style={s.center} testID="trip-invite-empty">
          <Text style={s.emptyTitle}>No trips you can invite to</Text>
          <Text style={s.emptyText}>Only trips you host can send invitations. Create a trip first, then invite {name}.</Text>
        </View>
      ) : (
        <ScrollView style={s.list} contentContainerStyle={s.listContent} showsVerticalScrollIndicator={false}>
          {trips.map((tr) => {
            const state = rows[tr.id] ?? 'idle';
            const done = state === 'invited' || state === 'already';
            return (
              <View key={tr.id} style={s.row} testID={`trip-invite-row-${tr.id}`}>
                <View style={s.rowIcon}><MapPin size={icon.s16} color={color.ink} /></View>
                <View style={s.rowText}>
                  <Text style={s.rowTitle} numberOfLines={1}>{tr.title}</Text>
                  {tripMeta(tr) ? <Text style={s.rowMeta} numberOfLines={1}>{tripMeta(tr)}</Text> : null}
                  {state === 'failed' ? <Text style={s.rowError}>Couldn't send — try again</Text> : null}
                </View>
                <Pressable
                  style={[s.inviteBtn, done && s.inviteBtnDone]}
                  onPress={() => void handleInvite(tr.id)}
                  disabled={state === 'sending' || done}
                  accessibilityRole="button"
                  accessibilityLabel={done ? 'Invited' : `Invite to ${tr.title}`}
                  testID={`trip-invite-btn-${tr.id}`}
                >
                  {state === 'sending' ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : done ? (
                    <>
                      <Check size={icon.s14} color={color.ink} />
                      <Text style={s.inviteBtnDoneText}>{state === 'already' ? 'Already on trip' : 'Invited'}</Text>
                    </>
                  ) : (
                    <Text style={s.inviteBtnText}>{state === 'failed' ? 'Retry' : 'Invite'}</Text>
                  )}
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      )}
    </PortavaSheet>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.title, color: color.ink, fontWeight: '800' },
  sub: { ...t.small, color: color.mute, paddingHorizontal: space.lg, paddingBottom: space.sm },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: space.xl, paddingHorizontal: space.lg, gap: space.sm },
  emptyTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptyText: { ...t.small, color: color.mute, textAlign: 'center' },
  retryBtn: { marginTop: space.xs, paddingVertical: 8, paddingHorizontal: space.lg, borderRadius: radius.pill, backgroundColor: color.ink },
  retryText: { ...t.small, color: '#fff', fontWeight: '700' },
  list: { maxHeight: 420 },
  listContent: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper,
  },
  rowIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: color.haze },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { ...t.bodyStrong, color: color.ink },
  rowMeta: { ...t.small, color: color.mute },
  rowError: { ...t.small, color: '#B91C1C' },
  inviteBtn: {
    minWidth: 76, minHeight: 36, paddingHorizontal: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    borderRadius: radius.pill, backgroundColor: color.ink,
  },
  inviteBtnDone: { backgroundColor: color.haze },
  inviteBtnText: { ...t.small, color: '#fff', fontWeight: '700' },
  inviteBtnDoneText: { ...t.small, color: color.ink, fontWeight: '700' },
});

export default TripInvitePickerSheet;
