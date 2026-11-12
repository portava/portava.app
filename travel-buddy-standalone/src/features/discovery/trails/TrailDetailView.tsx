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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { MapPin, FileText, Calendar, Route as RouteIcon, Flag } from 'lucide-react-native';

import { color, space } from '../../../theme/tokens.ts';
import { ds } from '../shared/discoveryStyles.ts';
import { writeFailureText, type ApiRead } from '../shared/discoveryApi.ts';
import { usePlaceName, placeLabel, fetchPlaceName } from '../shared/placeNames.ts';
import {
  getTrail, getTrailModules, getRelatedTrails, getTrailFollow, setTrailFollow, followAfter, reportTrail, getMoreTrailContent,
  TRAIL_REPORT_REASONS, type TrailDetail, type TrailModule, type RelatedTrail, type TrailModuleItem, type TrailReportReason,
} from './trailsApi.ts';
import { moduleLabel, hrefForItem, SOURCE_LABEL, REPORT_REASON_LABEL, lifecycleNote, reviewNote, isUnderReview } from './trailModel.ts';
import { useDiscoveryTrailOpen } from '../../../hooks/useDiscoveryTrailOpen.ts';
import { KeyboardSafeView } from '../../../components/ui/KeyboardSafeView.tsx';
import { TrailContributionForm } from './TrailContributionForm.tsx';

export interface TrailDetailDeps {
  loadTrail?: typeof getTrail;
  loadModules?: typeof getTrailModules;
  loadRelated?: typeof getRelatedTrails;
  loadFollow?: typeof getTrailFollow;
  follow?: typeof setTrailFollow;
  report?: typeof reportTrail;
  loadPlaceName?: typeof fetchPlaceName;
  loadMore?: typeof getMoreTrailContent;
}

interface Props extends TrailDetailDeps {
  trailId: string;
  onNavigate: (href: string) => void;
  visible?: boolean;
}

export function TrailDetailView(props: Props) {
  return <TrailDetailContent key={props.trailId} {...props} />;
}

function TrailDetailContent({
  trailId, onNavigate, visible = false,
  loadTrail = getTrail, loadModules = getTrailModules, loadRelated = getRelatedTrails,
  loadFollow = getTrailFollow, follow = setTrailFollow, report = reportTrail, loadPlaceName = fetchPlaceName,
  loadMore = getMoreTrailContent,
}: Props) {
  const [detail, setDetail] = useState<ApiRead<TrailDetail> | undefined>(undefined);
  const [modules, setModules] = useState<ApiRead<TrailModule[]> | undefined>(undefined);
  const [related, setRelated] = useState<ApiRead<RelatedTrail[]> | undefined>(undefined);
  const [following, setFollowing] = useState<boolean | 'unknown' | undefined>(undefined);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [contributing, setContributing] = useState(false);
  const [reportState, setReportState] = useState<'idle' | 'busy' | 'sent' | string>('idle');
  const generation = useRef(0);
  const followPending = useRef(false);
  const reportPending = useRef(false);
  const morePending = useRef(false);
  const [moreItems, setMoreItems] = useState<TrailModuleItem[]>([]);
  const [moreCursor, setMoreCursor] = useState<string | null | undefined>(undefined);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  useDiscoveryTrailOpen(trailId, detail?.state === 'ok', visible);

  const run = useCallback(async () => {
    const request = ++generation.current;
    morePending.current = false; setMoreItems([]); setMoreCursor(undefined); setMoreBusy(false); setMoreError(null);
    setDetail(undefined); setModules(undefined); setRelated(undefined); setFollowing(undefined);
    const read = async <T,>(load: () => Promise<ApiRead<T>>, apply: (answer: ApiRead<T>) => void) => {
      let answer: ApiRead<T>;
      try { answer = await load(); }
      catch { answer = { state: 'unavailable', detail: 'Connection interrupted. Please try again.' }; }
      if (request === generation.current) apply(answer);
    };
    // A slow related/follow read must not hold the Trail and its places off screen.
    await Promise.all([
      read(() => loadTrail(trailId), setDetail),
      read(() => loadModules(trailId), setModules),
      read(() => loadRelated(trailId), setRelated),
      read(() => loadFollow(trailId), (f) => setFollowing(f.state === 'ok' ? f.data : 'unknown')),
    ]);
  }, [trailId, loadTrail, loadModules, loadRelated, loadFollow]);

  useEffect(() => { void run(); return () => { generation.current++; }; }, [run]);

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
  // Lead ruling D-66: a Trail under review is its creator's alone — it cannot be followed, reported or linked yet.
  const underReview = isUnderReview(trail.review);

  const toggleFollow = async () => {
    if (typeof following !== 'boolean' || followPending.current) return;
    followPending.current = true;
    const request = generation.current;
    setFollowBusy(true); setFollowError(null);
    try {
      const w = await follow(trailId, !following);
      if (request !== generation.current) return;
      const after = followAfter(w);
      if (after === null) setFollowError(w.state === 'done' ? 'The answer could not be read. Open the Trail again to check.' : writeFailureText(w));
      else setFollowing(after);
    } catch {
      if (request === generation.current) setFollowError('Following could not be updated. Please try again.');
    } finally {
      followPending.current = false;
      if (request === generation.current) setFollowBusy(false);
    }
  };

  const sendReport = async (reason: TrailReportReason) => {
    if (reportPending.current) return;
    reportPending.current = true;
    const request = generation.current;
    setReportState('busy');
    try {
      const w = await report(trailId, reason);
      if (request === generation.current) setReportState(w.state === 'done' ? 'sent' : writeFailureText(w));
    } catch {
      if (request === generation.current) setReportState('The report could not be sent. Please try again.');
    } finally { reportPending.current = false; }
  };

  const showMore = async () => {
    if (morePending.current || moreCursor === null) return;
    morePending.current = true; setMoreBusy(true); setMoreError(null);
    const request = generation.current;
    try {
      const answer = await loadMore(trailId, moreCursor ?? null);
      if (request !== generation.current) return;
      if (answer.state !== 'ok') { setMoreError('More Trail content could not be loaded. Please try again.'); return; }
      if (moreCursor && answer.data.next === moreCursor) { setMoreError('More Trail content could not be loaded. Please try again.'); return; }
      const batch = answer.data.lists.flatMap((list) => [...list.unplaced, ...Object.values(list.byPlace).flat()]);
      setMoreItems((previous) => {
        const seen = new Set([...(modules?.state === 'ok' ? modules.data.flatMap((m) => m.items.map((item) => item.id)) : []), ...previous.map((item) => item.id)]);
        return [...previous, ...batch.filter((item) => { if (seen.has(item.id)) return false; seen.add(item.id); return true; })];
      });
      setMoreCursor(answer.data.next);
    } catch {
      if (request === generation.current) setMoreError('More Trail content could not be loaded. Please try again.');
    } finally {
      if (request === generation.current) { morePending.current = false; setMoreBusy(false); }
    }
  };

  return (
    <KeyboardSafeView scrollViewProps={{ testID: 'trail-detail' }}>
      <View style={[ds.card, { padding: space.lg }]}>
        <Text style={[ds.title, { fontSize: 20 }]}>{trail.title}</Text>
        {trail.destination ? <Text style={ds.detail}>{trail.destination}</Text> : null}
        {trail.description ? <Text style={[ds.body, { marginTop: space.sm }]}>{trail.description}</Text> : null}
        {status ? <Text style={ds.detail} testID="trail-status">{status.charAt(0).toUpperCase() + status.slice(1)}</Text> : null}
        {lifecycleNote(trail.lifecycle) && !underReview ? <Text style={ds.detail}>{lifecycleNote(trail.lifecycle)}</Text> : null}
        {underReview ? (
          <Text style={trail.review?.state === 'rejected' ? ds.warn : ds.detail} testID={`trail-review-${trail.review?.state ?? 'unknown'}`}>{reviewNote(trail.review)}</Text>
        ) : null}
        {underReview ? null : <View style={[ds.chips, { paddingHorizontal: 0 }]}>
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
        </View>}
        {!underReview ? <Pressable style={ds.button} accessibilityRole="button" testID="trail-contribute" onPress={() => setContributing((value) => !value)}>
          <Text style={ds.buttonText}>Add to Trail</Text>
        </Pressable> : null}
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

      {contributing && !underReview ? <TrailContributionForm trailId={trailId} onDone={() => { setContributing(false); void run(); }} /> : null}

      {modules === undefined ? <ActivityIndicator color={color.signal} testID="trail-modules-loading" /> : modules.state !== 'ok' ? (
        <View>
        <Text style={ds.notice} testID="trail-modules-unavailable">
          {modules.state === 'off' ? "This Trail's sections aren't available yet." : `This Trail's places and posts couldn't be loaded — ${modules.detail}.`}
        </Text>
        {modules.state === 'unavailable' ? <Pressable accessibilityRole="button" testID="trail-modules-retry" onPress={() => { void run(); }}><Text style={ds.link}>Try again</Text></Pressable> : null}
        </View>
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

      {moreItems.length > 0 ? <View style={ds.card} testID="trail-more-content">
        <Text style={ds.heading}>More from this Trail</Text>
        {moreItems.map((item, i) => <TrailItemRow key={item.id} item={item} first={i === 0} onNavigate={onNavigate} loadPlaceName={loadPlaceName} />)}
      </View> : null}
      {moreError ? <Text style={ds.warn} testID="trail-more-error">{moreError}</Text> : null}
      {modules?.state === 'ok' && moreCursor !== null ? <Pressable style={ds.ghost} accessibilityRole="button" disabled={moreBusy}
        accessibilityState={{ busy: moreBusy }} testID="trail-more" onPress={() => { void showMore(); }}>
        <Text style={ds.ghostText}>{moreBusy ? 'Loading…' : moreError ? 'Try again' : 'More from this Trail'}</Text>
      </Pressable> : null}
      {!underReview && related?.state === 'unavailable' ? <View testID="trail-related-unavailable">
        <Text style={ds.notice}>Related Trails couldn't be loaded.</Text>
        <Pressable accessibilityRole="button" testID="trail-related-retry" onPress={() => { void run(); }}><Text style={ds.link}>Try again</Text></Pressable>
      </View> : null}
      {!underReview && related?.state === 'ok' && related.data.length > 0 ? (
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
    </KeyboardSafeView>
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
