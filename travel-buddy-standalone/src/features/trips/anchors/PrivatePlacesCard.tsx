/**
 * PrivatePlacesCard — a traveller's private places on a trip, and who they
 * chose to show each one to (census-trips TR256; owner decision 2026-10-04:
 * "Owner-only by default. The owner can share an individual anchor with
 * selected trip members; trip membership or organizer status alone does not
 * grant access.").
 *
 * WHAT IT SHOWS
 *   "Your private places" — the viewer's own anchors. Each can be opened to a
 *     list of the crew with a switch per person. A grant is shown as made only
 *     when the SERVER's read-back says so; a failed write says so in words.
 *   "Shared with you" — anchors another member granted this viewer.
 *
 * WHAT IT WILL NOT DO
 *   It will not draw an anchor the server did not mark `own` or
 *     `shared_with_me` (an older server served everyone's; see privateAnchors.ts).
 *   It will not show a COUNT of anyone else's places.
 *   It will not draw an unreadable layer, or an unreadable grant list, as
 *     "none": both are named.
 *   It will not offer to grant while sharing is off — but it always offers to
 *     take a grant back.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Pressable, Switch } from 'react-native';
import { Lock, CloudOff } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { writeFailureText, type ApiRead } from '../shared/tripApi.ts';
import { fetchTripMapProjection, type ProjectionRead } from '../map/tripMapProjection.ts';
import { getTripMembers, type FriendUser } from '../../../services/friends.ts';
import {
  privatePlacesOf, fetchAnchorShares, grantAnchorShare, revokeAnchorShare, sharesAfter, toggleAllowed,
  placeLabel, type PrivatePlace, type AnchorShares,
} from './privateAnchors.ts';

interface Props {
  tripId: string;
  currentUserId: string;
  /** Test seams. */
  load?: typeof fetchTripMapProjection;
  loadMembers?: (tripId: string) => Promise<{ ok: boolean; data: { members: FriendUser[] } | null }>;
  loadShares?: typeof fetchAnchorShares;
  grant?: typeof grantAnchorShare;
  revoke?: typeof revokeAnchorShare;
}

export function PrivatePlacesCard({
  tripId, currentUserId,
  load = fetchTripMapProjection,
  loadMembers = getTripMembers,
  loadShares = fetchAnchorShares,
  grant = grantAnchorShare,
  revoke = revokeAnchorShare,
}: Props) {
  const [read, setRead] = useState<ProjectionRead | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRead(undefined);
    try {
      setRead(await load(tripId));
    } catch (e: unknown) {
      setRead({ state: 'unavailable', detail: e instanceof Error ? e.message : 'unexpected error' });
    }
  }, [tripId, load]);

  useEffect(() => { void run(); }, [run]);

  if (read === undefined) return null; // the layers card beside it already shows the projection loading
  if (read.state === 'off') return null;
  if (read.state === 'unavailable') return null; // the layers card names the projection outage
  const view = privatePlacesOf(read.projection);
  if (view.state === 'no_source') return null;
  if (view.state === 'unread') {
    return (
      <View style={s.wrap} testID="private-places-unread">
        <View style={s.row}>
          <CloudOff size={16} color={color.warn} />
          <Text style={s.detail}>Your private places couldn't be loaded. They are not gone.</Text>
        </View>
        <Pressable onPress={() => { void run(); }} accessibilityRole="button" testID="private-places-retry">
          <Text style={s.action}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (view.own.length === 0 && view.sharedWithMe.length === 0) return null;

  return (
    <View style={s.wrap} testID="private-places">
      {view.own.length > 0 ? <Text style={s.heading}>Your private places</Text> : null}
      {view.own.map((place) => (
        <View key={place.id}>
          <Pressable
            style={s.row}
            onPress={() => setOpen((o) => (o === place.id ? null : place.id))}
            accessibilityRole="button"
            accessibilityLabel={`${placeLabel(place)}. Only you can see it unless you share it. Choose who can see it.`}
            testID={`private-place-${place.id}`}
          >
            <Lock size={16} color={color.mute} />
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{placeLabel(place)}</Text>
              <Text style={s.detail}>Only you, and anyone you choose, can see this place.</Text>
            </View>
            <Text style={s.action}>{open === place.id ? 'Done' : 'Share…'}</Text>
          </Pressable>
          {open === place.id ? (
            <AnchorSharePicker
              tripId={tripId}
              place={place}
              currentUserId={currentUserId}
              loadMembers={loadMembers}
              loadShares={loadShares}
              grant={grant}
              revoke={revoke}
            />
          ) : null}
        </View>
      ))}
      {view.sharedWithMe.length > 0 ? <Text style={s.heading}>Shared with you</Text> : null}
      {view.sharedWithMe.map((place) => (
        <View key={place.id} style={s.row} testID={`shared-place-${place.id}`}>
          <Lock size={16} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>{placeLabel(place)}</Text>
            <Text style={s.detail}>A crew member shared this private place with you.</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function AnchorSharePicker({
  tripId, place, currentUserId, loadMembers, loadShares, grant, revoke,
}: {
  tripId: string;
  place: PrivatePlace;
  currentUserId: string;
  loadMembers: NonNullable<Props['loadMembers']>;
  loadShares: typeof fetchAnchorShares;
  grant: typeof grantAnchorShare;
  revoke: typeof revokeAnchorShare;
}) {
  const [members, setMembers] = useState<FriendUser[] | 'unread' | undefined>(undefined);
  const [shares, setShares] = useState<ApiRead<AnchorShares> | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [m, sh] = await Promise.all([loadMembers(tripId), loadShares(tripId, place.id)]);
      if (!live) return;
      setMembers(m.ok && m.data ? m.data.members.filter((u) => u.id !== currentUserId) : 'unread');
      setShares(sh);
    })();
    return () => { live = false; };
  }, [tripId, place.id, currentUserId, loadMembers, loadShares]);

  if (members === undefined || shares === undefined) {
    return <ActivityIndicator size="small" color={color.signal} style={{ margin: space.md }} testID="anchor-share-loading" />;
  }
  if (members === 'unread' || shares.state !== 'ok') {
    return (
      <Text style={[s.detail, s.indent]} testID="anchor-share-unread">
        Who can see this place couldn't be loaded. Nothing was changed.
      </Text>
    );
  }
  const current = shares.data;

  const toggle = async (memberId: string) => {
    const allowed = toggleAllowed(current, memberId);
    if (allowed === 'unavailable') return;
    setBusy(memberId);
    setFailure(null);
    const w = allowed === 'grant' ? await grant(tripId, place.id, memberId) : await revoke(tripId, place.id, memberId);
    const after = sharesAfter(w);
    if (after) setShares({ state: 'ok', data: after });
    else setFailure(w.state === 'done' ? 'The answer could not be read. Open this list again to see who can see it.' : writeFailureText(w));
    setBusy(null);
  };

  return (
    <View style={s.indent} testID={`anchor-share-picker-${place.id}`}>
      {!current.sharingEnabled ? (
        <Text style={s.detail} testID="anchor-share-off">
          Sharing private places isn't available yet. You can still stop sharing with anyone below.
        </Text>
      ) : null}
      {members.length === 0 ? <Text style={s.detail}>Nobody else is on this trip yet.</Text> : null}
      {members.map((m) => {
        const on = current.memberIds.includes(m.id);
        const allowed = toggleAllowed(current, m.id);
        return (
          <View key={m.id} style={s.memberRow}>
            <Text style={[s.title, { flex: 1 }]}>{m.name || `@${m.handle}`}</Text>
            <Switch
              value={on}
              disabled={busy !== null || allowed === 'unavailable'}
              onValueChange={() => { void toggle(m.id); }}
              accessibilityLabel={on ? `Stop showing this place to ${m.name || m.handle}` : `Show this place to ${m.name || m.handle}`}
              testID={`anchor-share-toggle-${m.id}`}
            />
          </View>
        );
      })}
      {failure ? <Text style={[s.detail, { color: color.warn }]} testID="anchor-share-failure">{failure}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginHorizontal: space.lg, marginTop: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, ...shadow.card,
    overflow: 'hidden', paddingVertical: space.sm,
  },
  heading: { ...t.small, fontWeight: '700', color: color.ink, paddingHorizontal: space.lg, paddingTop: space.sm },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.sm, minHeight: 44,
  },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.xs, minHeight: 44 },
  indent: { paddingHorizontal: space.lg + space.lg, paddingBottom: space.sm },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  action: { ...t.small, fontWeight: '600', color: color.signalStrong, paddingHorizontal: space.lg, paddingVertical: space.xs },
});
