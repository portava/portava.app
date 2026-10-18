/**
 * JoinRequestsList — the owner's review of join requests (TRIP-F06, WP-10).
 *
 * Mounted twice: on the trip page, scoped to that trip (`tripId`), and as the
 * whole of app/trip/join-requests.tsx across every trip the viewer owns.
 * Approve is the kernel's ADD_PARTICIPANT behind the route and is sent with a
 * key minted for that tap; a response that never arrived is offered again with
 * the same key, so the member cannot be added twice. A request leaves the list
 * only when the server says it was approved or declined — never on the tap.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { UserPlus, UserCheck, UserX, CloudOff } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { intentKey, writeFailureText, type ApiRead, type ApiWrite } from '../shared/tripApi.ts';
import {
  fetchJoinRequests, approveJoinRequest, declineJoinRequest, requestsForTrip, requesterLabel,
  type JoinRequest,
} from './tripJoinRequests.ts';

interface Props {
  /** Scope to one trip (the trip page). Omit on the review screen. */
  tripId?: string;
  /** Trip titles for the review screen's group headings. Enrichment only. */
  tripTitles?: Record<string, string>;
  /** Trip page: open the full review screen. */
  onOpenAll?: () => void;
  /** Called after an approval, so the page can refresh its crew. */
  onApproved?: (r: JoinRequest) => void;
  /** Test seams. */
  load?: typeof fetchJoinRequests;
  approve?: typeof approveJoinRequest;
  decline?: typeof declineJoinRequest;
}

type Decision = 'approve' | 'decline';
type Outcome = { decision: Decision; result: ApiWrite<unknown> | 'pending' };

export function JoinRequestsList({
  tripId, tripTitles, onOpenAll, onApproved,
  load = fetchJoinRequests, approve = approveJoinRequest, decline = declineJoinRequest,
}: Props) {
  const [read, setRead] = useState<ApiRead<JoinRequest[]> | undefined>(undefined);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const approveKeys = useRef<Record<string, string>>({});

  const run = useCallback(async () => {
    setRead(undefined);
    try { setRead(await load()); }
    catch (e: any) { setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') }); }
  }, [load]);
  useEffect(() => { void run(); }, [run]);

  const decide = useCallback(async (r: JoinRequest, decision: Decision) => {
    setOutcomes((o) => ({ ...o, [r.id]: { decision, result: 'pending' } }));
    let result: ApiWrite<unknown>;
    if (decision === 'approve') {
      approveKeys.current[r.id] ??= intentKey(`join-approve:${r.id}`);
      result = await approve(r.tripId, r.id, approveKeys.current[r.id]!);
    } else {
      result = await decline(r.tripId, r.id);
    }
    setOutcomes((o) => ({ ...o, [r.id]: { decision, result } }));
    if (result.state === 'done' && decision === 'approve') onApproved?.(r);
  }, [approve, decline, onApproved]);

  if (read === undefined) {
    return <View style={s.wrap} testID="join-requests-loading"><ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} /></View>;
  }
  if (read.state === 'off') return null;
  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="join-requests-unavailable">
        <View style={s.row}>
          <CloudOff size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Join requests unavailable</Text>
            <Text style={s.detail}>We couldn&apos;t read who has asked to join. That isn&apos;t the same as nobody.</Text>
            <Pressable onPress={() => void run()} style={s.button} testID="join-requests-retry" accessibilityRole="button">
              <Text style={s.buttonText}>Try again</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  const list = tripId ? requestsForTrip(read.data, tripId) : [...read.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (list.length === 0) {
    // On the trip page an empty queue is not worth a card; the review screen says it.
    if (tripId) return null;
    return (
      <View style={s.wrap} testID="join-requests-empty">
        <View style={s.row}>
          <UserPlus size={14} color={color.mute} />
          <Text style={[s.detail, { flex: 1, marginTop: 0 }]}>No one is waiting to join your trips.</Text>
        </View>
      </View>
    );
  }

  let lastTrip: string | null = null;
  return (
    <View style={s.wrap} testID="join-requests-card">
      <View style={s.headRow}>
        <Text style={s.heading}>{list.length === 1 ? '1 request to join' : `${list.length} requests to join`}</Text>
        {onOpenAll ? (
          <Pressable onPress={onOpenAll} testID="join-requests-open-all" accessibilityRole="link"><Text style={s.link}>Review all</Text></Pressable>
        ) : null}
      </View>
      {list.map((r) => {
        const header = !tripId && r.tripId !== lastTrip ? (tripTitles?.[r.tripId] ?? 'One of your trips') : null;
        lastTrip = r.tripId;
        const o = outcomes[r.id];
        const busy = o?.result === 'pending';
        const res = o && o.result !== 'pending' ? o.result : null;
        return (
          <View key={r.id}>
            {header ? <Text style={s.group} testID={`join-requests-trip-${r.tripId}`}>{header}</Text> : null}
            <View style={s.row} testID={`join-request-${r.id}`}>
              <UserPlus size={14} color={color.deep} />
              <View style={{ flex: 1 }}>
                <Text style={s.title}>{requesterLabel(r)}</Text>
                {r.message ? <Text style={s.detail}>&ldquo;{r.message}&rdquo;</Text> : null}
                {res?.state === 'done' ? (
                  <View style={s.inline} testID={`join-request-${o!.decision}d-${r.id}`}>
                    {o!.decision === 'approve' ? <UserCheck size={12} color={color.success} /> : <UserX size={12} color={color.mute} />}
                    <Text style={[s.detail, { marginTop: 0, color: o!.decision === 'approve' ? color.success : color.mute }]}>
                      {o!.decision === 'approve' ? 'Approved — they are on the crew' : 'Declined'}
                    </Text>
                  </View>
                ) : (
                  <View style={s.buttons}>
                    <Pressable disabled={busy} onPress={() => void decide(r, 'approve')} style={[s.button, s.approve, busy && { opacity: 0.5 }]} testID={`join-request-approve-${r.id}`} accessibilityRole="button">
                      <Text style={[s.buttonText, { color: '#fff' }]}>{res?.state === 'unavailable' && o!.decision === 'approve' ? 'Try approving again' : 'Approve'}</Text>
                    </Pressable>
                    <Pressable disabled={busy} onPress={() => void decide(r, 'decline')} style={[s.button, busy && { opacity: 0.5 }]} testID={`join-request-decline-${r.id}`} accessibilityRole="button">
                      <Text style={s.buttonText}>Decline</Text>
                    </Pressable>
                    {busy ? <ActivityIndicator size="small" color={color.signal} /> : null}
                  </View>
                )}
                {res && res.state !== 'done' ? (
                  <Text style={[s.detail, { color: color.signalStrong }]} testID={`join-request-failed-${r.id}`}>{writeFailureText(res)}</Text>
                ) : null}
              </View>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden', paddingVertical: space.xs },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.sm },
  heading: { ...t.small, fontWeight: '700', color: color.ink },
  link: { ...t.small, color: color.signalStrong, fontWeight: '600' },
  group: { ...t.stamp, color: color.mute, fontWeight: '700', paddingHorizontal: space.lg, paddingTop: space.sm, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  buttons: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  button: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  approve: { backgroundColor: color.deep, borderColor: color.deep },
  buttonText: { ...t.small, color: color.ink },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
});
