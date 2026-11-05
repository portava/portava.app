import { OutcomeFeedback } from './OutcomeFeedback.tsx';
import { usePrivateSurfaceKey } from '../../../hooks/usePrivateSurfaceKey.ts';
import { useMediaSurfaceActivity } from '../../../hooks/useMediaSurfaceActivity.ts';
import { captureMessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
/**
 * Telegraph §10.3 — the end-of-night recap.
 *
 *   "4 places · 6 people · 18 photos · 2 videos
 *    [ Create Memory ] [ Share Photos ] [ Follow People You Met ] [ Done ]
 *    Recap is derived from confirmed session context and shared content
 *    references. It is an invitation to curate, not automatic historical
 *    truth."
 *
 * THE LAST SENTENCE IS THE DESIGN, not a footnote about it. Three things in
 * this sheet exist only to honour it:
 *
 *  1. Nothing is created before a button is pressed. `GET /threads/:id/recap`
 *     is a read; the sheet renders the server's own `wrote: "nothing"` so the
 *     user is told, not merely not-lied-to.
 *  2. A thread with no COMPLETED plan gets no recap at all — the server
 *     answers `reason: "no_completed_plan"` and this sheet says so instead of
 *     inventing a session out of "the last few hours of chat". A recap that
 *     appears whenever the app feels like it IS automatic historical truth.
 *  3. `Done` is a first-class button of equal weight, not a dismissal X in a
 *     corner. Declining to curate is one of the four offered outcomes.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import {
  curateActionLabel,
  fetchRecap,
  recapHeadline,
  type RecapCurateAction,
  type RecapResponse,
} from './memoryApi.ts';

export interface RecapSheetProps {
  visible: boolean;
  threadId: string;
  planId?: string | null;
  onClose: () => void;
  /** Each action is an OFFER. The host screen decides what accepting means. */
  onCurate?: (action: RecapCurateAction) => void;
  /** Test seam: skip the fetch and render this. */
  initialRecap?: RecapResponse | null;
}

export function RecapSheet(props: RecapSheetProps) {
  const scope=usePrivateSurfaceKey();
  return props.visible ? <OwnedRecapSheet key={`${scope}:${props.threadId}:${props.planId}`} {...props} /> : null;
}
function OwnedRecapSheet({
  visible,
  threadId,
  planId = null,
  onClose,
  onCurate,
  initialRecap = null,
}: RecapSheetProps) {
  const palette = useTelegraphPalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [data, setData] = useState<RecapResponse | null>(initialRecap);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const controller=useRef<AbortController|null>(null);
  const owner=useMemo(()=>captureMessagingOwnerRequest(),[]);
  const activity=useMediaSurfaceActivity(()=>controller.current?.abort());
  const [revision,retry]=useState(0);
  useEffect(()=>{
    const abort=new AbortController();controller.current=abort;
    setData(null);setFailed(false);setLoading(true);
    if(!owner||!activity.active){setLoading(false);return()=>abort.abort();}
    if(initialRecap!==null&&activity.epoch===0){setData(initialRecap);setLoading(false);return()=>abort.abort();}
    void fetchRecap(threadId,planId,{owner,signal:abort.signal,isCurrent:activity.isCurrent}).then(result=>{
      if(abort.signal.aborted||!owner.isCurrent()||!activity.isCurrent())return;
      if(result.ok)setData(result.data);else setFailed(true);
      setLoading(false);
    });
    return()=>abort.abort();
  },[threadId,planId,initialRecap,owner,activity.active,activity.epoch,activity.isCurrent,revision]);

  const recap = activity.active && owner?.isCurrent() ? data?.recap ?? null : null;
  // The server sends a headline; recomputing it here would be a second source
  // of truth, so it is only the fallback when the field is missing.
  const headline = data?.headline || (recap ? recapHeadline(recap.counts) : '');

  const press = useCallback(
    (action: RecapCurateAction) => {
      if (!owner?.isCurrent() || !activity.isCurrent()) return;
      onCurate?.(action);
      if (action === 'DONE') onClose();
    },
    [onCurate, onClose, owner, activity.isCurrent],
  );

  return (
    <Modal visible={visible && activity.active} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="telegraph-recap-sheet">
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>That was the night</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close recap" onPress={onClose} style={styles.close}>
              <Text style={styles.actionTextQuiet}>Close</Text>
            </Pressable>
          </View>

          {loading ? (
            <View style={styles.center} accessibilityLabel="Loading recap">
              <ActivityIndicator size="small" color={palette.operational} />
            </View>
          ) : null}

          {failed ? (
            <Text style={styles.note} testID="telegraph-recap-failed">
              We could not put this recap together. Nothing was created.
            </Text>
          ) : null}

          {failed && <Pressable accessibilityRole="button" onPress={()=>retry(n=>n+1)} style={styles.action}><Text style={styles.actionText}>Retry recap</Text></Pressable>}
          {!failed && !loading && recap === null ? (
            <Text style={styles.note} testID="telegraph-recap-none">
              There is no finished plan in this conversation to look back on yet.
            </Text>
          ) : null}

          {!failed && recap !== null ? (
            <ScrollView contentContainerStyle={styles.body}>
              <Text style={styles.headline} testID="telegraph-recap-headline">
                {headline}
              </Text>

              <Text style={styles.note} testID="telegraph-recap-invitation">
                Derived from the plan you all confirmed and what was shared during it. This is an
                invitation to curate, not a record of what happened.
              </Text>

              {data?.wrote === 'nothing' ? (
                <Text style={styles.wrote} testID="telegraph-recap-wrote-nothing">
                  Nothing has been saved yet.
                </Text>
              ) : null}

              {recap.planId && <OutcomeFeedback key={recap.planId} threadId={threadId} planId={recap.planId} />}
              <View style={styles.actions}>
                {(recap.curateActions ?? []).map((action) => (
                  <Pressable
                    key={action}
                    accessibilityRole="button"
                    accessibilityLabel={curateActionLabel(action)}
                    accessibilityHint={
                      action === 'DONE'
                        ? 'Closes the recap without saving anything'
                        : 'Nothing is saved until you choose this'
                    }
                    onPress={() => press(action)}
                    style={[styles.action, action === 'DONE' ? styles.actionQuiet : null]}
                    testID={`telegraph-recap-action-${action}`}
                  >
                    <Text
                      style={[styles.actionText, action === 'DONE' ? styles.actionTextQuiet : null]}
                    >
                      {curateActionLabel(action)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          ) : null}

          {recap === null && !loading ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done"
              onPress={onClose}
              style={[styles.action, styles.actionQuiet]}
              testID="telegraph-recap-action-DONE"
            >
              <Text style={[styles.actionText, styles.actionTextQuiet]}>Done</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: p.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingHorizontal: space.lg,
      paddingTop: space.lg,
      paddingBottom: space.xl,
      maxHeight: '80%',
      gap: space.sm,
    },
    body: { gap: space.md, paddingBottom: space.md },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
    close: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
    title: { ...t.body, color: p.recvText, fontWeight: '800' },
    headline: { ...t.body, color: p.recvText, fontWeight: '700' },
    note: { ...t.small, color: p.mute },
    wrote: { ...t.small, color: p.mute, fontStyle: 'italic' },
    center: { paddingVertical: space.lg, alignItems: 'center' },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    action: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: space.lg,
      paddingVertical: 9,
      borderRadius: radius.pill,
      backgroundColor: p.operational,
    },
    actionQuiet: { backgroundColor: p.chipFill },
    actionText: { ...t.small, color: p.operationalOn, fontWeight: '700' },
    actionTextQuiet: { color: p.mute },
  });
}

export default RecapSheet;
