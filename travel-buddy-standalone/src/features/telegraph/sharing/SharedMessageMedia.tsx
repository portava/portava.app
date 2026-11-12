import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react-native';
import { DisplayMediaImage } from '../../../components/ui/DisplayMediaImage.tsx';
import { FeedAutoplayVideo } from '../../../components/media/FeedAutoplayVideo.tsx';
import { PostTakeover } from '../../../components/PostTakeover.tsx';
import { UserIdentityLink } from '../../../components/interaction/UserIdentityLink.tsx';
import { messageTreeMediaOrNull } from '../media/messageTreeMedia.ts';
import { useThreadSharePlayer } from './threadSharePlayback.tsx';
import { useTelegraphPalette } from '../theme/telegraphTheme.ts';
import type { TelegraphShareProjection } from './shareApi.ts';

function sharedMediaSource(projection: TelegraphShareProjection) {
  const media = projection.media?.find(item => (item.type === 'image' || item.type === 'video') && messageTreeMediaOrNull(item.uri));
  const original = messageTreeMediaOrNull(media?.uri);
  const poster = messageTreeMediaOrNull(media?.thumbnailUri) ?? (media?.type === 'image' ? original : null) ?? messageTreeMediaOrNull(projection.imageUrl);
  return {original, poster, video: Boolean(original && media?.type === 'video')};
}

export function hasSharedMessageMedia(projection: TelegraphShareProjection): boolean {
  const {original, poster} = sharedMediaSource(projection);
  return Boolean(original || poster);
}

/** Media and the live source author's identity; the sender's note stays outside the media. */
export function SharedPostMediaMessage({projection, messageId, caption, width, testID}: {
  projection: TelegraphShareProjection; messageId?: string | null; caption?: string | null; width: number; testID: string;
}) {
  const palette = useTelegraphPalette();
  const handle = projection.subtitle?.startsWith('@') ? projection.subtitle.slice(1) : null;
  return <View style={[s.post, {width}]} testID={testID}>
    <SharedMessageMedia key={projection.objectId} projection={projection} messageId={messageId} />
    {handle ? <UserIdentityLink userId="" handle={handle} testID="shared-post-author-identity">
      <Text style={[s.author, {color: palette.recvText}]} numberOfLines={1}>@{handle}</Text>
    </UserIdentityLink> : <Text style={[s.author, {color: palette.mute}]}>Traveler</Text>}
    {caption?.trim() ? <Text testID="shared-post-sender-note" style={[s.note, {color: palette.recvText}]} numberOfLines={3}>{caption.trim()}</Text> : null}
  </View>;
}

/** A recipient renders only the current projection. An old poster alone cannot become an original. */
export function SharedMessageMedia({projection, messageId}: {projection: TelegraphShareProjection; messageId?: string | null}) {
  const controls = useThreadSharePlayer();
  const [open, setOpen] = useState(false);
  const paused = Boolean(messageId && controls?.paused.has(messageId));
  const position = useRef(0);
  const {original, poster, video} = sharedMediaSource(projection);
  const register = controls?.register;
  const expand = controls?.expand;
  useEffect(() => {
    if (!messageId || !register || !video) return;
    register(messageId, true);
    return () => register(messageId, false);
  }, [messageId, register, video]);
  useEffect(() => {
    if (!open || !messageId || !expand) return;
    expand(messageId);
    return () => expand(null);
  }, [open, messageId, expand]);
  const selected = messageId != null && controls?.playing === messageId && !open;
  if (!original && !poster) return null;
  const isPost = projection.objectType === 'POST';
  const action = () => { if (isPost) setOpen(true); else router.push(projection.deepLink as never); };
  return <View style={s.preview} testID="shared-message-media">
    <Pressable accessibilityRole="button" accessibilityLabel={isPost ? 'Open shared post' : 'Open shared media'} onPress={action} style={StyleSheet.absoluteFill}>
      {poster ? <DisplayMediaImage uri={poster} width={244} height={152} resizeMode="cover" style={StyleSheet.absoluteFill} /> : null}
      {video && selected && !paused ? <FeedAutoplayVideo key={original!} uri={original!} muted={controls?.muted ?? true} initialPositionMillis={position.current} onPositionChange={value => { position.current = value; }} /> : null}
      {video && (!selected || paused) ? <View style={s.indicator} pointerEvents="none"><Play color="#fff" size={24} /></View> : null}
      {(projection.media?.length ?? 0) > 1 ? <Text style={s.count}>{projection.media!.length}</Text> : null}
    </Pressable>
    {video && selected && controls ? <Pressable accessibilityRole="button" accessibilityLabel={controls.muted ? 'Unmute shared video' : 'Mute shared video'} onPress={() => controls.setMuted(!controls.muted)} style={[s.pause, {right: 52}]}>
      {controls.muted ? <VolumeX color="#fff" size={18} /> : <Volume2 color="#fff" size={18} />}
    </Pressable> : null}
    {video && selected ? <Pressable accessibilityRole="button" accessibilityLabel={paused ? 'Resume shared video' : 'Pause shared video'} onPress={() => { if (messageId) controls?.togglePause(messageId); }} style={s.pause}>
      {paused ? <Play color="#fff" size={18} /> : <Pause color="#fff" size={18} />}
    </Pressable> : null}
    {open && isPost ? <PostTakeover postId={projection.objectId} initialMediaUri={original ?? undefined} initialPositionMillis={position.current} onPositionChange={value => { position.current = value; }} onClose={() => setOpen(false)} /> : null}
  </View>;
}
const s = StyleSheet.create({
  post: {padding: 0, borderWidth: 0, backgroundColor: 'transparent', gap: 5},
  author: {fontSize: 12, lineHeight: 16, fontWeight: '600'},
  note: {fontSize: 13, lineHeight: 18},
  preview: {width: '100%', height: 152, backgroundColor: '#171717', borderRadius: 8, overflow: 'hidden'},
  indicator: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center'},
  pause: {position: 'absolute', bottom: 4, right: 4, height: 44, width: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 22},
  count: {position: 'absolute', right: 8, top: 8, backgroundColor: 'rgba(0,0,0,0.65)', color: 'white', paddingHorizontal: 6, borderRadius: 4},
});
