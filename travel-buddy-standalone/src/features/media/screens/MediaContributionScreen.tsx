/**
 * MediaContributionScreen — the §4 "Media Contribution" screen (spec §4 / §9 /
 * §40 / §50 "CAPTURE ↓ CONTRIBUTE"; census-media §19: MD28).
 *
 * Contribute a current perspective of ONE canonical place. The screen owns the
 * I/O; `state/mediaContribution` owns every decision:
 *
 *   1. load the canonical place (`getCanonicalPlace`) — its own public name,
 *      city and VENUE coordinates are what bind the post to it;
 *   2. pick a photo or clip (the app's picker);
 *   3. compose in MediaContributionSheet (what it shows · who sees it · how
 *      precisely the place is shown · an optional note);
 *   4. `uploadMedia` — the app's single upload path, which strips EXIF/GPS —
 *      then `createPost`, the gated post write with server-owned location
 *      verification and delayed publishing.
 *
 * A failed SAVE is retried with the URL already uploaded; the same file is
 * never uploaded twice. A post the server holds back (delayed until the
 * contributor leaves) is reported as held back, never as already live.
 */
import React, { useCallback, useEffect, useReducer, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import { getCanonicalPlace } from '../../../services/places.ts';
import { uploadMedia } from '../../../services/media.ts';
import { createPost } from '../../../services/posts.ts';
import { KeyboardSafeScrollView } from '../../../components/ui/KeyboardSafeView.tsx';
import { LensStateView } from '../components/LensStateView.tsx';
import { MediaContributionSheet } from '../components/MediaContributionSheet.tsx'; import { useFeatureFlags } from '../../../context/FeatureFlagsContext.tsx'; import { NEIGHBORHOOD_ONLY_MODE_FLAG } from '../../../services/media/mediaPrivacy.ts';
import {
  INITIAL_CONTRIBUTION_DRAFT,
  contributionBlocker,
  contributionReducer,
  doneCopy,
  retryStartsAt,
  toCreatePostInput,
  type ContributionDraft,
  type ContributionPhase,
  type ContributionPlace,
} from '../state/mediaContribution.ts';

export interface MediaContributionScreenProps {
  placeId: string;
  /** The viewer's device fix, sent ONLY as the private verification pair. */
  deviceGps?: { lat: number; lng: number } | null;
  /** Opens the app's picker; resolves to the chosen asset or null. */
  pickMedia: () => Promise<ContributionDraft['media']>;
  onDone?: () => void;
}

type PlaceState = { status: 'loading' } | { status: 'ready'; place: ContributionPlace } | { status: 'missing' };

export function MediaContributionScreen({ placeId, deviceGps = null, pickMedia, onDone }: MediaContributionScreenProps) {
  const [placeState, setPlaceState] = useState<PlaceState>({ status: 'loading' });
  const [draft, dispatch] = useReducer(contributionReducer, INITIAL_CONTRIBUTION_DRAFT);
  const [phase, setPhase] = useState<ContributionPhase>({ kind: 'editing' }); const { isEnabled } = useFeatureFlags(); // census-media §36

  useEffect(() => {
    let cancelled = false;
    setPlaceState({ status: 'loading' });
    void getCanonicalPlace(placeId).then((p) => {
      if (cancelled) return;
      if (!p || !p.coordinates || !Number.isFinite(p.coordinates.lat) || !Number.isFinite(p.coordinates.lng)) {
        setPlaceState({ status: 'missing' });
        return;
      }
      setPlaceState({
        status: 'ready',
        place: { id: p.id, name: p.name, city: p.city ?? null, countryCode: p.countryCode ?? null, coordinates: p.coordinates },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [placeId]);

  const place = placeState.status === 'ready' ? placeState.place : null;
  const blocker = contributionBlocker(draft, place);
  const busy = phase.kind === 'uploading' || phase.kind === 'saving';

  const onPick = useCallback(async () => {
    const m = await pickMedia();
    if (m) dispatch({ type: 'pick_media', media: m });
  }, [pickMedia]);

  const save = useCallback(
    async (uploadedUrl: string, mediaType: 'image' | 'video' | null) => {
      if (!place) return;
      setPhase({ kind: 'saving', uploadedUrl, mediaType });
      const res = await createPost(toCreatePostInput(draft, place, { url: uploadedUrl, mediaType }, deviceGps));
      if (!res.ok || !res.data) {
        setPhase({ kind: 'failed', step: 'save', message: res.message ?? 'Could not save your perspective.', uploadedUrl, mediaType });
        return;
      }
      const status = res.data.postStatus ?? 'published';
      setPhase({ kind: 'done', pending: status !== 'published' });
    },
    [draft, place, deviceGps],
  );

  const submit = useCallback(async () => {
    if (!place || !draft.media) return;
    if (retryStartsAt(phase) === 'save' && phase.kind === 'failed' && phase.uploadedUrl) {
      await save(phase.uploadedUrl, phase.mediaType);
      return;
    }
    setPhase({ kind: 'uploading' });
    const up = await uploadMedia(draft.media, { surface: 'postcard' });
    if (!up.ok || !up.url) {
      setPhase({ kind: 'failed', step: 'upload', message: up.message ?? 'Could not upload.', uploadedUrl: null, mediaType: null });
      return;
    }
    const mediaType = up.mediaType === 'video' ? 'video' : up.mediaType === 'image' ? 'image' : null;
    await save(up.url, mediaType);
  }, [place, draft.media, phase, save]);

  if (placeState.status !== 'ready') {
    return (
      <LensStateView
        status={placeState.status === 'loading' ? 'loading' : 'error'}
        title="This place could not be loaded"
        message="A perspective needs a place to belong to. Try again from the place itself."
      />
    );
  }

  if (phase.kind === 'done') {
    return (
      <View style={styles.done} testID="media-contribution-done">
        <Text style={styles.doneTitle}>{doneCopy(phase.pending, draft.precision)}</Text>
        {onDone ? (
          <Pressable style={styles.doneBtn} onPress={onDone} accessibilityRole="button">
            <Text style={styles.doneBtnText}>Back to {placeState.place.name}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <KeyboardSafeScrollView style={styles.wrap}>
      {phase.kind === 'failed' ? (
        <Text style={styles.failed} testID="media-contribution-failed">
          {phase.step === 'save' ? 'Uploaded, but not saved yet — ' : 'Upload failed — '}
          {phase.message} Try again.
        </Text>
      ) : null}
      <MediaContributionSheet
        placeName={placeState.place.name}
        draft={draft}
        dispatch={dispatch}
        onPickMedia={() => void onPick()}
        onSubmit={() => void submit()}
        blocker={blocker}
        busy={busy} neighborhoodOffered={isEnabled(NEIGHBORHOOD_ONLY_MODE_FLAG)}
      />
    </KeyboardSafeScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  failed: { color: color.warn, fontSize: 13, lineHeight: 18, paddingHorizontal: space.lg, paddingTop: space.md },
  done: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.lg },
  doneTitle: { color: color.onInk, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  doneBtn: { paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.pill, backgroundColor: color.onInk },
  doneBtnText: { color: color.ink, fontSize: 14, fontWeight: '800' },
});
