/**
 * EventCommunitySection — posts, photos and comments on the event page
 * (PLAT-F30).
 *
 * Shown to participants only (host/co-host, Going or Maybe — the scope the
 * three GET routes apply, lib/eventCommunity.ts `isEventParticipant`). Three
 * tabs, each loaded on first open:
 *   Posts     GET/POST /api/events/:id/posts     text posts from people going
 *   Photos    GET/POST /api/events/:id/media     uploaded through /api/media/upload
 *   Comments  GET/POST /api/events/:id/comments  the event's comment thread
 *
 * Every tab has a true loading, error-with-Retry and empty state: a failed read
 * is never shown as "nothing posted yet". The composer is offered to staff and
 * Going attendees; the host's attendee-posting setting is not in the event
 * payload, so a refusal from the server is shown as its message (decision
 * TM-EV-05, docs/ops/testing-mode-flows.md).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, TextInput } from 'react-native';
import { ImagePlus, Send, MessageSquare, Image as ImageIcon, Newspaper, Pin } from 'lucide-react-native';
import {
  getEventPosts, createEventPost, getEventMedia, addEventMedia, getEventComments, postEventComment,
  type EventDetail, type EventPost, type EventMediaItem, type EventComment, type EventAuthor,
} from '../../services/events.ts';
import { uploadMedia } from '../../services/media.ts';
import { useMediaPicker } from '../../hooks/useMediaPicker.ts';
import { canOfferEventContribution } from '../../lib/eventCommunity.ts';
import { CachedImage } from '../CachedImage.tsx';
import { Avatar } from '../ui.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

type Tab = 'posts' | 'photos' | 'comments';
type Load<T> = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: T[] };

interface Props {
  event: Pick<EventDetail, 'id' | 'isHost' | 'myRole' | 'myRsvp'>;
}

function authorName(a: EventAuthor | null | undefined): string {
  if (!a) return 'Traveler';
  return a.displayName ?? (a.handle ? `@${a.handle}` : 'Traveler');
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function EventCommunitySection({ event }: Props) {
  const [tab, setTab] = useState<Tab>('posts');
  const [posts, setPosts] = useState<Load<EventPost>>({ status: 'idle' });
  const [photos, setPhotos] = useState<Load<EventMediaItem>>({ status: 'idle' });
  const [comments, setComments] = useState<Load<EventComment>>({ status: 'idle' });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const { pickMedia } = useMediaPicker();
  const canContribute = canOfferEventContribution(event);

  const loadTab = useCallback(async (which: Tab) => {
    if (which === 'posts') {
      setPosts({ status: 'loading' });
      const r = await getEventPosts(event.id);
      setPosts(r.ok && Array.isArray(r.data?.posts) ? { status: 'ready', items: r.data!.posts } : { status: 'error', message: r.message ?? "We couldn't load posts." });
    } else if (which === 'photos') {
      setPhotos({ status: 'loading' });
      const r = await getEventMedia(event.id);
      setPhotos(r.ok && Array.isArray(r.data?.media) ? { status: 'ready', items: r.data!.media } : { status: 'error', message: r.message ?? "We couldn't load photos." });
    } else {
      setComments({ status: 'loading' });
      const r = await getEventComments(event.id);
      setComments(r.ok && Array.isArray(r.data?.updates) ? { status: 'ready', items: r.data!.updates } : { status: 'error', message: r.message ?? "We couldn't load comments." });
    }
  }, [event.id]);

  const current = tab === 'posts' ? posts : tab === 'photos' ? photos : comments;
  useEffect(() => { if (current.status === 'idle') loadTab(tab); }, [tab, current.status, loadTab]);

  function switchTab(next: Tab) { setTab(next); setDraft(''); setSendError(null); }

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    const r = tab === 'posts' ? await createEventPost(event.id, body) : await postEventComment(event.id, body);
    setSending(false);
    if (!r.ok) { setSendError(r.message ?? 'That did not post. Please try again.'); return; }
    setDraft('');
    loadTab(tab);
  }

  async function addPhoto() {
    if (sending) return;
    const assets = await pickMedia({ title: 'Add a photo to this event' });
    const asset = assets?.[0];
    if (!asset) return;
    setSending(true);
    setSendError(null);
    const up = await uploadMedia({
      uri: asset.uri, mimeType: asset.mimeType ?? 'image/jpeg', fileName: asset.fileName,
      fileSize: asset.fileSize, width: asset.width, height: asset.height, type: 'image',
    }, { surface: 'event' });
    if (!up.ok || !up.url) {
      setSending(false);
      setSendError(up.message ?? 'The photo did not upload. Please try again.');
      return;
    }
    const r = await addEventMedia(event.id, up.url, 'image');
    setSending(false);
    if (!r.ok) { setSendError(r.message ?? 'The photo was not added. Please try again.'); return; }
    loadTab('photos');
  }

  const TABS: { key: Tab; label: string; Icon: typeof Newspaper }[] = [
    { key: 'posts', label: 'Posts', Icon: Newspaper },
    { key: 'photos', label: 'Photos', Icon: ImageIcon },
    { key: 'comments', label: 'Comments', Icon: MessageSquare },
  ];

  return (
    <View style={s.card} testID="event-community">
      <View style={s.tabs}>
        {TABS.map(({ key, label, Icon }) => (
          <Pressable
            key={key}
            style={[s.tab, tab === key && s.tabOn]}
            onPress={() => switchTab(key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}
            accessibilityLabel={label}
          >
            <Icon size={14} color={tab === key ? color.ink : color.mute} />
            <Text style={[s.tabText, tab === key && s.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {current.status === 'idle' || current.status === 'loading' ? (
        <ActivityIndicator color={color.signal} style={{ marginVertical: space.lg }} testID="event-community-loading" />
      ) : current.status === 'error' ? (
        <View style={s.center} testID="event-community-error">
          <Text style={s.muted}>{current.message}</Text>
          <Pressable style={s.retryBtn} onPress={() => loadTab(tab)} accessibilityRole="button" accessibilityLabel="Retry">
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : tab === 'photos' ? (
        (photos.status === 'ready' && photos.items.length === 0) ? (
          <Text style={[s.muted, s.emptyLine]} testID="event-community-empty">No photos yet.</Text>
        ) : (
          <View style={s.grid}>
            {(photos.status === 'ready' ? photos.items : []).map((m) => (
              <CachedImage key={m.id} source={{ uri: m.media_url }} style={s.photo} accessibilityLabel={m.caption ?? 'Event photo'} />
            ))}
          </View>
        )
      ) : (
        (() => {
          const items = (tab === 'posts' ? (posts.status === 'ready' ? posts.items : []) : (comments.status === 'ready' ? comments.items : [])) as Array<EventPost | EventComment>;
          if (items.length === 0) {
            return <Text style={[s.muted, s.emptyLine]} testID="event-community-empty">{tab === 'posts' ? 'No posts yet.' : 'No comments yet.'}</Text>;
          }
          return items.map((it) => {
            const createdAt = 'createdAt' in it ? it.createdAt : it.created_at;
            return (
              <View key={it.id} style={s.item}>
                <Avatar uri={it.author?.avatarUrl ?? ''} size={28} />
                <View style={{ flex: 1 }}>
                  <View style={s.itemHead}>
                    <Text style={s.author} numberOfLines={1}>{authorName(it.author)}</Text>
                    {it.pinned ? <Pin size={11} color={color.mute} /> : null}
                    <Text style={s.time}>{when(createdAt)}</Text>
                  </View>
                  <Text style={s.body}>{it.body}</Text>
                </View>
              </View>
            );
          });
        })()
      )}

      {canContribute && (
        tab === 'photos' ? (
          <Pressable
            style={[s.photoBtn, sending && { opacity: 0.6 }]}
            onPress={addPhoto}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel="Add a photo"
            testID="event-community-add-photo"
          >
            {sending ? <ActivityIndicator size="small" color={color.ink} /> : <ImagePlus size={16} color={color.ink} />}
            <Text style={s.photoBtnText}>Add a photo</Text>
          </Pressable>
        ) : (
          <View style={s.composer}>
            <TextInput
              style={s.input}
              placeholder={tab === 'posts' ? 'Share something with everyone going…' : 'Add a comment…'}
              placeholderTextColor={color.faint}
              value={draft}
              onChangeText={setDraft}
              maxLength={tab === 'posts' ? 2000 : 1000}
              multiline
              accessibilityLabel={tab === 'posts' ? 'New post' : 'New comment'}
            />
            <Pressable
              style={[s.send, (!draft.trim() || sending) && { opacity: 0.5 }]}
              onPress={send}
              disabled={!draft.trim() || sending}
              accessibilityRole="button"
              accessibilityLabel={tab === 'posts' ? 'Post' : 'Send comment'}
              testID="event-community-send"
            >
              {sending ? <ActivityIndicator size="small" color={color.onInk} /> : <Send size={16} color={color.onInk} />}
            </Pressable>
          </View>
        )
      )}
      {sendError ? <Text style={s.error} testID="event-community-send-error">{sendError}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card:     { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm },
  tabs:     { flexDirection: 'row', gap: space.xs, marginBottom: space.xs },
  tab:      { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: color.haze },
  tabOn:    { backgroundColor: color.paper, borderWidth: 1, borderColor: color.ink },
  tabText:  { ...t.small, color: color.muteStrong, fontWeight: '600' },
  tabTextOn:{ color: color.ink, fontWeight: '700' },
  center:   { alignItems: 'center', gap: space.sm, paddingVertical: space.md },
  muted:    { ...t.small, color: color.mute, textAlign: 'center' },
  emptyLine:{ paddingVertical: space.md },
  retryBtn: { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText:{ ...t.small, color: color.onInk, fontWeight: '700' },
  item:     { flexDirection: 'row', gap: space.sm, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  author:   { ...t.small, color: color.ink, fontWeight: '700', flexShrink: 1 },
  time:     { ...t.small, color: color.mute, fontSize: 11 },
  body:     { ...t.body, color: color.ink, marginTop: 2 },
  grid:     { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  photo:    { width: '32%', height: 104, borderRadius: radius.sm },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, marginTop: space.xs },
  input:    { flex: 1, backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: space.sm, ...t.body, color: color.ink, maxHeight: 120 },
  send:     { backgroundColor: color.signal, borderRadius: radius.pill, padding: space.sm + 2 },
  photoBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingVertical: space.sm, marginTop: space.xs },
  photoBtnText: { ...t.body, color: color.ink, fontWeight: '600' },
  error:    { ...t.small, color: '#DC2626' },
});
