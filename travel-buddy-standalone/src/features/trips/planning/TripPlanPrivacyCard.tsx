/**
 * TripPlanPrivacyCard — who can see each plan you added to this trip, and the
 * control to change it (census-trips TR116, §6.3).
 *
 * The server has stored, enforced and served a plan's `privacyScope` since
 * 2770 and §90/§96; the app never read or wrote it. This card reads it for the
 * viewer's own plans (tripPlanPrivacy.ts) and sets it through the plan route.
 *
 * WHAT IT DOES NOT DO
 * ===================
 * It does not show an audience it was not told. A scope the server did not
 * read is "not known", never "Trip crew". "Saved" is shown only on the
 * server's answer, and the scope then drawn is the one the server returned. A
 * refusal is shown with its message; an unreachable server is "nothing
 * changed" with a retry of the SAME choice. A plan read that failed is said,
 * not drawn as a trip with no plans.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { Eye } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import type { ApiRead } from '../shared/tripApi.ts';
import {
  readOwnPlanScopes, setPlanItemPrivacyScope, OFFERED_PRIVACY_SCOPES, PRIVACY_SCOPE_LABEL,
  type OwnPlanItem, type ScopeWrite, type TripPlanPrivacyScope,
} from './tripPlanPrivacy.ts';

interface Props {
  tripId: string;
  currentUserId: string;
  /** Test seams. */
  load?: typeof readOwnPlanScopes;
  setScope?: typeof setPlanItemPrivacyScope;
}

type Change = { scope: TripPlanPrivacyScope; result: ScopeWrite | 'pending' };

export function TripPlanPrivacyCard({ tripId, currentUserId, load = readOwnPlanScopes, setScope = setPlanItemPrivacyScope }: Props) {
  const [read, setRead] = useState<ApiRead<OwnPlanItem[]> | undefined>(undefined);
  const [changes, setChanges] = useState<Record<string, Change>>({});

  useEffect(() => {
    let current = true;
    void load(tripId, currentUserId).then((r) => { if (current) setRead(r); });
    return () => { current = false; };
  }, [tripId, currentUserId, load]);
  const reload = useCallback(async () => {
    setRead(undefined);
    setRead(await load(tripId, currentUserId));
  }, [tripId, currentUserId, load]);

  const choose = useCallback(async (itemId: string, scope: TripPlanPrivacyScope) => {
    setChanges((c) => ({ ...c, [itemId]: { scope, result: 'pending' } }));
    const result = await setScope(tripId, itemId, scope);
    setChanges((c) => ({ ...c, [itemId]: { scope, result } }));
    if (result.state === 'saved') {
      // The server's answer, not the tap: if it says something else, that is what is true.
      setRead((r) => (r?.state === 'ok'
        ? { state: 'ok', data: r.data.map((it) => (it.id === itemId ? { ...it, scope: result.scope } : it)) }
        : r));
    }
  }, [tripId, setScope]);

  return (
    <View style={s.wrap} testID="trip-plan-privacy-card">
      <View style={s.row}>
        <Eye size={14} color={color.deep} />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Who can see your plans</Text>
          {read === undefined ? (
            <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: space.xs }} testID="plan-privacy-reading" accessibilityLabel="Reading your plans" />
          ) : read.state !== 'ok' ? (
            <View testID="plan-privacy-read-failed">
              <Text style={[s.detail, { color: color.signalStrong }]}>
                Couldn&apos;t read this trip&apos;s plan — {read.state === 'off' ? 'not signed in' : read.detail}
              </Text>
              <Pressable onPress={() => void reload()} style={s.button} testID="plan-privacy-reread" accessibilityRole="button" accessibilityLabel="Read your plans again">
                <Text style={s.buttonText}>Try again</Text>
              </Pressable>
            </View>
          ) : read.data.length === 0 ? (
            <Text style={s.detail} testID="plan-privacy-empty">You haven&apos;t added any plans to this trip.</Text>
          ) : read.data.map((item) => {
            const change = changes[item.id];
            const res = change && change.result !== 'pending' ? change.result : null;
            const pending = change?.result === 'pending';
            return (
              <View key={item.id} style={s.item} testID={`plan-privacy-${item.id}`}>
                <Text style={s.itemTitle} numberOfLines={1}>{item.title || 'Untitled plan'}</Text>
                <Text style={s.detail} testID={`plan-privacy-scope-${item.id}`}>
                  Seen by: {item.scope ? PRIVACY_SCOPE_LABEL[item.scope] : 'not known'}
                </Text>
                <View style={s.buttons}>
                  {OFFERED_PRIVACY_SCOPES.map((scope) => {
                    const on = item.scope === scope;
                    return (
                      <Pressable
                        key={scope}
                        disabled={pending}
                        onPress={() => void choose(item.id, scope)}
                        style={[s.button, on && s.buttonOn, pending && { opacity: 0.5 }]}
                        testID={`plan-privacy-set-${item.id}-${scope}`}
                        accessibilityRole="button"
                        accessibilityLabel={`${item.title || 'Untitled plan'}: ${PRIVACY_SCOPE_LABEL[scope]}`}
                        accessibilityState={{ selected: on, disabled: pending }}
                      >
                        <Text style={[s.buttonText, on && s.buttonTextOn]}>{PRIVACY_SCOPE_LABEL[scope]}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                {pending ? <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: space.xs }} testID={`plan-privacy-saving-${item.id}`} accessibilityLabel="Saving" /> : null}
                {res?.state === 'saved' ? (
                  <Text style={[s.detail, { color: color.success }]} testID={`plan-privacy-saved-${item.id}`}>Saved</Text>
                ) : res?.state === 'refused' ? (
                  <Text style={[s.detail, { color: color.signalStrong }]} testID={`plan-privacy-refused-${item.id}`}>Not changed — {res.detail}</Text>
                ) : res?.state === 'unavailable' ? (
                  <View testID={`plan-privacy-unavailable-${item.id}`}>
                    <Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing changed.</Text>
                    <Pressable onPress={() => change && void choose(item.id, change.scope)} style={s.button} testID={`plan-privacy-retry-${item.id}`} accessibilityRole="button" accessibilityLabel="Try saving it again">
                      <Text style={s.buttonText}>Try again</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden', paddingVertical: space.xs },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  item: { marginTop: space.sm },
  itemTitle: { ...t.small, color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: space.xs },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  button: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  buttonOn: { backgroundColor: color.deep, borderColor: color.deep },
  buttonText: { ...t.small, color: color.ink },
  buttonTextOn: { color: '#fff' },
});
