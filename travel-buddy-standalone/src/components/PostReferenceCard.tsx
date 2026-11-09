import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image as ImageIcon, Play } from 'lucide-react-native';
import { useSession } from '../context/SessionContext.tsx';
import { useMediaSurfaceActivity } from '../hooks/useMediaSurfaceActivity.ts';
import { usePrivateSurfaceKey } from '../hooks/usePrivateSurfaceKey.ts';
import { legacySharedPostId, POST_UUID, POST_REFERENCE_MEDIA_TYPE } from '../constants/postReference.ts';
import { capturePostDestinationOwner, postReferenceId, readPostReference, readPostSharePreview,
  type PostReferenceView, type ReferenceMedia } from '../services/postDestinations.ts';
import { FeedAutoplayVideo } from './media/FeedAutoplayVideo.tsx';
import { DisplayMediaImage } from './ui/DisplayMediaImage.tsx';
import { PostTakeover } from './PostTakeover.tsx';
import { color } from '../theme/tokens.ts';

type ShareTarget = { referenceId: string; legacyPostId?: never } | { referenceId?: never; legacyPostId: string };
export function postShareTarget(referenceId?: string | null, content?: string | null): ShareTarget | null {
  if (referenceId && POST_UUID.test(referenceId)) return { referenceId };
  const legacyPostId = legacySharedPostId(content);
  return legacyPostId ? { legacyPostId } : null;
}

type LiveState = { data?: PostReferenceView; error?: string };
type PreviewProps = { target: ShareTarget | null; active?: boolean; cover?: boolean; autoplay?: boolean; onOpen?: (id: string) => void };

export function PostSharePreview(props: PreviewProps) {
  const scope = usePrivateSurfaceKey();
  const { userId } = useSession();
  return <CheckedPreview key={JSON.stringify([scope, userId, props.target, props.active])} {...props} userId={userId} />;
}

function CheckedPreview({ target, userId, active = true, cover = false, autoplay = false, onOpen }: PreviewProps & { userId: string | null | undefined }) {
  const [state, setState] = useState<LiveState>({});
  const [attempt, retry] = useState(0);
  const [selectedMedia, setSelectedMedia] = useState<string | null>(null);
  const [mediaIndex, setMediaIndex] = useState(0);
  const videoPosition = useRef(0);
  const notePosition = useCallback((position: number) => { videoPosition.current = position; }, []);
  const [opened, setOpened] = useState(false);
  const activity = useMediaSurfaceActivity(() => { setState({}); setOpened(false); });
  const request = useRef<AbortController | null>(null);
  const id = target?.referenceId ?? target?.legacyPostId ?? null;
  const isReference = !!target?.referenceId;
  const read = useCallback(async () => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    const owner = capturePostDestinationOwner();
    if (!id || !owner || owner.ownerId !== userId || !owner.isCurrent()) {
      setState({ data: { available: false } });
      owner?.invalidate();
      return null;
    }
    try {
      const result = await (isReference ? readPostReference : readPostSharePreview)(id, owner, abort.signal);
      if (abort.signal.aborted || !owner.isCurrent() || !activity.isCurrent()) return null;
      setState(result.ok ? { data: result.data } : { error: result.message });
      return result.ok && result.data.available ? result.data : null;
    } finally {
      owner.invalidate();
    }
  }, [id, isReference, userId, activity.isCurrent]);
  useEffect(() => {
    if (active && activity.active) { setState({}); void read(); }
    return () => request.current?.abort();
  }, [active, activity.active, read, attempt]);

  if (!active || !activity.active) return null;
  const source = state.data?.available ? state.data : null;
  const media = source?.media ?? [];
  async function open(uri?: string) {
    // Recheck the destination as well as the source before exposing a full post.
    const checked = await read();
    if (!checked) return;
    if (onOpen) { onOpen(checked.postId); return; }
    setSelectedMedia(uri && checked.media?.some(item => item.uri === uri) ? uri : null);
    setOpened(true);
  }

  const selected = media[mediaIndex] ?? media[0];
  if (cover) {
    const first = media[0];
    return <View style={s.cover} accessibilityLabel={source ? `Shared post by ${source.author}` : 'Shared post'}>
      {first ? <MediaPoster item={first} /> : source
        ? <Text style={s.coverText} numberOfLines={3}>{source.text || source.author}</Text>
        : <ImageIcon color={color.mute} size={18} />}
    </View>;
  }
  return <View style={s.card} testID="post-reference-card">
    <Text style={s.eyebrow}>SHARED POST</Text>
    {state.error ? <>
      <Text style={s.body} accessibilityRole="alert">{state.error}</Text>
      <Pressable accessibilityRole="button" onPress={() => retry(value => value + 1)}><Text style={s.link}>Retry</Text></Pressable>
    </> : !state.data ? <ActivityIndicator accessibilityLabel="Checking shared post" />
      : source ? <>
        <Text style={s.label}>{source.author}</Text>
        {source.text ? <Text style={s.body} numberOfLines={8}>{source.text}</Text> : null}
        {selected && <Pressable style={s.poster} accessibilityRole="button"
          accessibilityLabel={`${selected.type === 'video' ? 'Play shared video' : 'View shared photo'}${media.length > 1 ? ` ${mediaIndex + 1} of ${media.length}` : ''}`}
          onPress={event => { event?.stopPropagation?.(); void open(selected.uri); }}>
          <MediaPoster item={selected} />
          {selected.type === 'video' && autoplay && !opened && <FeedAutoplayVideo key={selected.uri} uri={selected.uri}
            initialPositionMillis={videoPosition.current} onPositionChange={notePosition} />}
        </Pressable>}
        {media.length > 1 && <View style={s.gallery}>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous attachment" disabled={mediaIndex === 0}
            onPress={() => { videoPosition.current = 0; setMediaIndex(i => Math.max(0, i - 1)); }}><Text style={s.link}>Previous</Text></Pressable>
          <Text style={s.body}>{mediaIndex + 1} / {media.length}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Next attachment" disabled={mediaIndex >= media.length - 1}
            onPress={() => { videoPosition.current = 0; setMediaIndex(i => Math.min(media.length - 1, i + 1)); }}><Text style={s.link}>Next</Text></Pressable>
        </View>}
        <Pressable accessibilityRole="button" accessibilityLabel="Open original post" onPress={event => { event?.stopPropagation?.(); void open(); }}>
          <Text style={s.link}>Open original post</Text>
        </Pressable>
        {opened && <PostTakeover postId={source.postId} initialMediaUri={selectedMedia ?? undefined} authorizedMedia={source.media} initialPositionMillis={videoPosition.current} onPositionChange={notePosition} onClose={() => setOpened(false)} />}
      </> : <Text style={s.body}>This post is no longer available to you.</Text>}
  </View>;
}

function MediaPoster({ item }: { item: ReferenceMedia }) {
  const image = item.thumbnailUri || (item.type === 'image' ? item.uri : null);
  return <View style={s.posterFill}>
    {image ? <DisplayMediaImage uri={image} width={400} height={260} style={s.image} resizeMode="cover" /> : null}
    {item.type === 'video' && <View style={s.play}><Play size={22} color={color.onInk} fill={color.onInk} /></View>}
  </View>;
}

export function PostReferenceCover({ uri }: { uri?: string | null }) {
  const id = postReferenceId(POST_REFERENCE_MEDIA_TYPE, uri);
  return <PostSharePreview cover target={id ? { referenceId: id } : null} />;
}

export function PostReferenceCard({ mediaType, uri, active = true, autoplay = false, onOpen }: { mediaType: string; uri: string; active?: boolean; autoplay?: boolean; onOpen?: (postId: string) => void }) {
  const id = postReferenceId(mediaType, uri);
  return <PostSharePreview target={id ? { referenceId: id } : null} active={active} autoplay={autoplay} onOpen={onOpen} />;
}

const s = StyleSheet.create({
  card: { backgroundColor: color.paper, padding: 16, gap: 8, borderWidth: 1, borderColor: color.haze, borderRadius: 16 },
  cover: { flex: 1, width: '100%', overflow: 'hidden', backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center' },
  coverText: { fontSize: 12, color: color.ink, padding: 4 },
  eyebrow: { color: color.mute, fontSize: 12, letterSpacing: 2 },
  label: { color: color.ink, fontSize: 17, fontWeight: '600' },
  body: { color: color.ink, fontSize: 16, lineHeight: 23 },
  link: { paddingVertical: 10, color: color.ink, fontSize: 16, textDecorationLine: 'underline' },
  gallery: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  poster: { width: '100%', aspectRatio: 1.6, overflow: 'hidden', borderRadius: 8 },
  posterFill: { ...StyleSheet.absoluteFillObject, backgroundColor: color.ink, alignItems: 'center', justifyContent: 'center' },
  image: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  play: { position: 'absolute', borderRadius: 24, padding: 10, backgroundColor: 'rgba(0,0,0,0.68)' },
});
