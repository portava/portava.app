/**
 * LayoverCrewLocationShareControl — census-layover L166: "Precise crew sharing:
 * separate explicit control, off by default". B58 lane LAY-C1.
 *
 * SEPARATE: it is not `share_city_status` (the people section's city-level
 * toggle, a different and coarser thing) and it shares nothing on its own — it
 * asks the server to RECORD a permission (`POST …/crew/location-grant`) or to
 * revoke every one (`DELETE`). The server decides everything else.
 *
 * OFF BY DEFAULT, three ways: the feature flag is seeded FALSE, so the server
 * answers `yourShare.available: false` and this renders NOTHING; a crew member
 * who has never tapped reads `never_granted`; and nothing here ever grants
 * without a press.
 *
 * THIS COMPONENT DECIDES NOTHING. Whether the share is live, until when, and why
 * not are the server's (`crewLocationShareView` over `yourShare`). It derives no
 * time: the end it shows is the server's `expiresAt`, and no duration is chosen
 * on the client. `null` from the server is UNKNOWN and is never drawn as "not
 * sharing"; the only action offered then is the one that can only reduce what
 * is shared — stopping.
 *
 * WHO CAN SEE IT is owner question OQ-1, built at its fail-closed default
 * (current crewmates who follow you and whom you follow, no block either way).
 * The sentence below states that default; it is not an approved policy.
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { fmtClock } from './layoverFormat.ts';
import { crewLocationShareView, type CrewLocationShare } from '../../services/layover.ts';

/** The audience at OQ-1's default, in a traveller's words (D-103's label). */
export const CREW_LOCATION_AUDIENCE =
  'Only crewmates you follow who follow you back can see it, and never anyone who has blocked you or whom you blocked.';

/** The server's reasons, in a traveller's words. Unknown reasons fall back to the plain "off" sentence. */
const OFF_TEXT: Record<string, string> = {
  'no_live_grant:never_granted': 'Your crew cannot see your precise location.',
  'no_live_grant:user_revoked': 'You stopped sharing your precise location with this crew.',
  'no_live_grant:ttl_elapsed': 'Your location share reached its end time.',
  'no_live_grant:boarding': 'Your location share ended at boarding.',
  'no_live_grant:airport_reentry': 'Your location share ended when you got back to the airport.',
  'no_live_grant:session_expired': 'Your location share ended with your layover.',
  'no_live_grant:crew_dissolved': 'Your location share ended with the crew.',
  hard_return_passed: 'Your location share ended at your return deadline.',
  granted_before_membership: 'You rejoined this crew, so an earlier share does not carry over.',
  reentry_unverifiable: 'Sharing is not available yet: we cannot tell when you are back at the airport, which is what ends a share.',
  sharing_gate_closed: 'Your location sharing is paused or off in your settings.',
};

interface Props {
  share: CrewLocationShare | null | undefined;
  timezone: string | null;
  /** The section's busy key, so one press at a time across the whole card. */
  busy: string | null;
  onShare: () => void;
  onStop: () => void;
}

export function LayoverCrewLocationShareControl({ share, timezone, busy, onShare, onStop }: Props) {
  const view = crewLocationShareView(share);
  if (view.kind === 'hidden') return null;

  const stopButton = (
    <Pressable
      onPress={onStop}
      disabled={busy !== null}
      accessibilityRole="button"
      accessibilityLabel="Stop sharing my precise location"
      accessibilityState={{ disabled: busy !== null, busy: busy === 'location-stop' }}
      style={styles.secondaryBtn}
      testID="layover-crew-location-stop"
    >
      {busy === 'location-stop'
        ? <ActivityIndicator size="small" color={color.deep} />
        : <Text style={styles.secondaryBtnText}>Stop sharing my location</Text>}
    </Pressable>
  );

  return (
    <View style={styles.block} testID={`layover-crew-location-${view.kind}`}>
      <View style={styles.row}>
        <MapPin size={13} color={color.deep} />
        <Text style={styles.label}>Precise location</Text>
      </View>
      {view.kind === 'unknown' ? (
        <>
          <Text style={styles.body}>We could not check whether your crew can see your precise location.</Text>
          {stopButton}
        </>
      ) : view.kind === 'live' ? (
        <>
          <Text style={styles.body}>
            Your crew is allowed to see your precise location
            {view.until ? <Text testID="layover-crew-location-until"> until {fmtClock(view.until, timezone)}</Text> : null}.
          </Text>
          <Text style={styles.note}>{CREW_LOCATION_AUDIENCE} It ends when you leave the crew, board, or get back to the airport.</Text>
          {stopButton}
        </>
      ) : (
        <>
          <Text style={styles.body} testID="layover-crew-location-off-reason">
            {OFF_TEXT[view.reason] ?? OFF_TEXT['no_live_grant:never_granted']}
          </Text>
          <Text style={styles.note}>{CREW_LOCATION_AUDIENCE}</Text>
          <Pressable
            onPress={onShare}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel="Allow my crew to see my precise location"
            accessibilityState={{ disabled: busy !== null, busy: busy === 'location-share' }}
            style={styles.secondaryBtn}
            testID="layover-crew-location-share"
          >
            {busy === 'location-share'
              ? <ActivityIndicator size="small" color={color.deep} />
              : <Text style={styles.secondaryBtnText}>Allow my crew to see my precise location</Text>}
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    padding: space.md,
    gap: space.xs,
    marginTop: space.xs,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  label: { ...t.small, color: color.ink, fontWeight: '600' },
  body: { ...t.small, color: color.ink },
  note: { ...t.small, color: color.faint, fontSize: 12, lineHeight: 17 },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    minHeight: 36,
    alignSelf: 'flex-start',
    marginTop: space.xs,
  },
  secondaryBtnText: { ...t.small, color: color.deep, fontWeight: '600' },
});
