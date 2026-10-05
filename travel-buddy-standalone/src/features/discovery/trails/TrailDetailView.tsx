/**
 * One Discovery Trail (owner decision 2026-10-04: Trails are a user-facing
 * feature; `11` §3 actions: view, modules, related, follow, report).
 *
 * WHAT IT WILL NOT DO
 *   Show a score or a count of impressions — the server sends none (`11` §4).
 *   Show Follow as on or off before the server said which.
 *   Draw an unreadable module list as "nothing here".
 *   Report anything the server did not accept: a report is "sent" only on 202.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { MapPin, FileText, Calendar, Route as RouteIcon, Flag } from 'lucide-react-native';

import { color, space } from '../../../theme/tokens.ts';
import { ds } from '../shared/discoveryStyles.ts';
import { writeFailureText, type ApiRead } from '../shared/discoveryApi.ts';
import { usePlaceName, placeLabel, fetchPlaceName } from '../shared/placeNames.ts';
import {
  getTrail, getTrailModules, getRelatedTrails, getTrailFollow, setTrailFollow, followAfter, reportTrail,
  TRAIL_REPORT_REASONS, type TrailDetail, type TrailModule, type RelatedTrail, type TrailModuleItem, type TrailReportReason,
} from './trailsApi.ts';
import { moduleLabel, hrefForItem, SOURCE_LABEL, REPORT_REASON_LABEL, lifecycleNote } from './trailModel.ts';

export interface TrailDetailDeps {
  loadTrail?: typeof getTrail;
  loadModules?: typeof getTrailModules;
  loadRelated?: typeof getRelatedTrails;
  loadFollow?: typeof getTrailFollow;
  follow?: typeof setTrailFollow;
  report?: typeof reportTrail;
  loadPlaceName?: typeof fetchPlaceName;
}

interface Props extends TrailDetailDeps {
  trailId: string;
  onNavigate: (href: string) => void;
}

export function TrailDetailView({
  trailId, onNavigate,
  loadTrail = getTrail, loadModules = getTrailModules, loadRelated = getRelatedTrails,
  loadFollow = getTrailFollow, follow = setTrailFollow, report = reportTrail, loadPlaceName = fetchPlaceName,
}: Props) {
  const [detail, setDetail] = useState<ApiRead<TrailDetail> | undefined>(undefined);
  const [modules, setModules] = useState<ApiRead<TrailModule[]> | undefined>(undefined);
  const [related, setRelated] = useState<ApiRead<RelatedTrail[]> | undefined>(undefined);
  const [following, setFollowing] = useState<boolean | 'unknown' | undefined>(undefined);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportState, setReportState] = useState<'idle' | 'busy' | 'sent' | string>('idle');

  const run = useCallback(async () => {
    setDetail(undefined); setModules(undefined); setRelated(undefined); setFollowing(undefined);
    const [d, m, r, f] = await Promise.all([loadTrail(trailId), loadModules(trailId), loadRelated(trailId), loadFollow(trailId)]);
    setDetail(d); setModules(m); setRelated(r);
    setFollowing(f.state === 'ok' ? f.data : 'unknown');
  }, [trailId, loadTrail, loadModules, loadRelated, loadFollow]);

  useEffect(() => { void run(); }, [run]);

  if (detail === undefined) return <ActivityIndicator style={{ margin: space.xl }} color={color.signal} testID="trail-loading" />;
  if (detail.state !== 'ok') {
    return (
      <View testID="trail-unavailable">
        <Text style={ds.notice}>{detail.state === 'off' ? "Trails aren't available yet." : `This Trail couldn't be loaded — ${detail.detail}.`}</Text>
        {detail.state === 'unavailable' ? (
          <Pressable onPress={() => { void run(); }} accessibilityRole="button" testID="trail-retry">
            <Text style={[ds.link, { textAlign: 'center' }]}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  const { trail, status } = detail.data;

  const toggleFollow = async () => {
    if (typeof following !== 'boolean') return;
    setFollowBusy(true); setFollowError(null);
    const w = await follow(trailId, !following);
    const after = followAfter(w);
    if (after === null) setFollowError(w.state === 'done' ? 'The answer could not be read. Open the Trail again to check.' : writeFailureText(w));
    else setFollowing(after);
    setFollowBusy(false);
  };

  const sendReport = async (reason: TrailReportReason) => {
    setReportState('busy');
    const w = await report(trailId, reason);
    setReportState(w.state === 'done' ? 'sent' : writeFailureText(w));
  };

  return (
    <ScrollView testID="trail-detail">
      <View style={[ds.card, { padding: space.lg }]}>
        <Text style={[ds.title, { fontSize: 20 }]}>{trail.title}</Text>
        {trail.destination ? <Text style={ds.detail}>{trail.destination}</Text> : null}
        {trail.description ? <Text style={[ds.body, { marginTop: space.sm }]}>{trail.description}</Text> : null}
        {status ? <Text style={ds.detail} testID="trail-status">{status.charAt(0).toUpperCase() + status.slice(1)}</Text> : null}
        {lifecycleNote(trail.lifecycle) ? <Text style={ds.detail}>{lifecycleNote(trail.lifecycle)}</Text> : null}
        <View style={[ds.chips, { paddingHorizontal: 0 }]}>
          {following === undefined ? (
            <ActivityIndicator size="small" color={color.signal} />
          ) : following === 'unknown' ? (
            <Text style={ds.detail} testID="trail-follow-unknown">Whether you follow this Trail couldn't be checked.</Text>
          ) : (
            <Pressable
              style={[ds.ghost, following && ds.ghostOn]} onPress={() => { void toggleFollow(); }} disabled={followBusy}
              accessibilityRole="button" accessibilityState={{ selected: following, busy: followBusy }}
              accessibilityLabel={following ? 'Unfollow this Trail' : 'Follow this Trail'} testID="trail-follow"
            >
              <Text style={[ds.ghostText, following && ds.ghostTextOn]}>{following ? 'Following' : 'Follow'}</Text>
            </Pressable>
          )}
          <Pressable style={ds.ghost} onPress={() => setReporting((v) => !v)} accessibilityRole="button" accessibilityLabel="Report a problem with this Trail" testID="trail-report-open">
            <Flag size={14} color={color.ink} />
          </Pressable>
        </View>
        {followError ? <Text style={ds.warn} testID="trail-follow-error">{followError}</Text> : null}
        {reporting ? (
          <View testID="trail-report-menu" style={{ marginTop: space.sm }}>
            {reportState === 'sent' ? (
              <Text style={ds.detail} testID="trail-report-sent">Thanks — your report was sent.</Text>
            ) : (
              TRAIL_REPORT_REASONS.map((r) => (
                <Pressable key={r} onPress={() => { void sendReport(r); }} disabled={reportState === 'busy'} accessibilityRole="button" testID={`trail-report-${r}`} style={{ paddingVertical: space.sm }}>
                  <Text style={ds.body}>{REPORT_REASON_LABEL[r]}</Text>
                </Pressable>
              ))
            )}
            {reportState !== 'idle' && reportState !== 'busy' && reportState !== 'sent' ? <Text style={ds.warn} testID="trail-report-error">{reportState}</Text> : null}
          </View>
        ) : null}
      </View>

      {modules === undefined ? null : modules.state !== 'ok' ? (
        <Text style={ds.notice} testID="trail-modules-unavailable">
          {modules.state === 'off' ? "This Trail's sections aren't available yet." : `This Trail's places and posts couldn't be loaded — ${modules.detail}.`}
        </Text>
      ) : modules.data.every((m) => m.items.length === 0) ? (
        <Text style={ds.notice} testID="trail-modules-empty">Nothing has been added to this Trail yet.</Text>
      ) : (
        modules.data.filter((m) => m.items.length > 0).map((m) => (
          <View key={m.key} style={ds.card} testID={`trail-module-${m.key}`}>
            <Text style={ds.heading}>{moduleLabel(m.key)}</Text>
            {m.items.map((item, i) => (
              <TrailItemRow key={item.id} item={item} first={i === 0} onNavigate={onNavigate} loadPlaceName={loadPlaceName} />
            ))}
          </View>
        ))
      )}

      {related?.state === 'ok' && related.data.length > 0 ? (
        <View style={ds.card} testID="trail-related">
          <Text style={ds.heading}>Related Trails</Text>
          {related.data.map((r, i) => (
            <Pressable key={`${r.trail.id}:${r.edgeType}`} style={[ds.row, i > 0 && ds.rowDivider]} onPress={() => onNavigate(`/trails/${encodeURIComponent(r.trail.id)}`)} accessibilityRole="button" testID={`trail-related-${r.trail.id}`}>
              <RouteIcon size={16} color={color.deep} />
              <Text style={[ds.title, { flex: 1 }]}>{r.trail.title}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={{ height: space.xxl }} />
    </ScrollView>
  );
}

function TrailItemRow({ item, first, onNavigate, loadPlaceName }: {
  item: TrailModuleItem; first: boolean; onNavigate: (href: string) => void; loadPlaceName: typeof fetchPlaceName;
}) {
  const href = hrefForItem(item);
  const Icon = item.sourceType === 'place' ? MapPin : item.sourceType === 'event' ? Calendar : item.sourceType === 'route' ? RouteIcon : FileText;
  const label = item.sourceType === 'place' ? <PlaceLabel id={item.sourceId} load={loadPlaceName} /> : <Text style={ds.title}>{SOURCE_LABEL[item.sourceType] ?? 'Item'}</Text>;
  return (
    <Pressable
      style={[ds.row, !first && ds.rowDivider]} onPress={href ? () => onNavigate(href) : undefined} disabled={!href}
      accessibilityRole={href ? 'button' : undefined} testID={`trail-item-${item.id}`}
    >
      <Icon size={16} color={color.mute} />
      <View style={{ flex: 1 }}>{label}</View>
      {!href ? <Text style={ds.detail}>Not viewable in the app</Text> : null}
    </Pressable>
  );
}

function PlaceLabel({ id, load }: { id: string; load: typeof fetchPlaceName }) {
  const s = usePlaceName(id, load);
  return <Text style={s.state === 'ok' ? ds.title : ds.detail}>{placeLabel(s)}</Text>;
}
