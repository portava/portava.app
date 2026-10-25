/**
 * SaveOwnPostToMemorySheet — "Save to a Memory" from the viewer's OWN post
 * (census-media MD385, lead ruling D-26j). The entry is the post detail's
 * overflow sheet, shown only on the viewer's own post with media and only while
 * `memory_from_own_media_enabled` is on (seeded FALSE: nothing shows).
 *
 * The person picks one of their own Memories, or makes a new private one from
 * the post. Every media item of the post is copied server-side by INDEX — the
 * client never sends a URL — through `POST /memories/:id/items/from-post`,
 * which refuses anyone else's post.
 *
 * HONEST STATES
 *   - the Memories list could not be read → said so, with Try again; the
 *     "new Memory" path still works;
 *   - the switch is off on the server, the post is gone or not theirs, the
 *     Memory is not theirs → the refusal, in words, and no Try again;
 *   - unavailable / offline / failed → "nothing was saved" with Try again;
 *   - a copy that stopped part-way → "2 of 3 saved", never "saved";
 *   - saved → where it went.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { createMemory, getUserMemories, type Memory } from '../../services/memories.ts';
import {
  describeSavePostReport, isRetryable, saveOwnPostToMemory, MEMORY_FROM_OWN_MEDIA_FLAG, MAX_POST_MEDIA,
  type SavePostReport,
} from '../../services/memoryFromPost.ts';

export { MEMORY_FROM_OWN_MEDIA_FLAG };

/** The fields of a post this action needs. */
export interface OwnPostForMemory {
  id: string;
  authorId?: string | null;
  author?: { id?: string | null } | null;
  mediaUrls?: string[] | null;
  /** The post's media items (post_media rows, or #795's media_urls fallback). Uploads live here since 3924. */
  media?: readonly unknown[] | null;
  content?: string | null;
}

/**
 * How many media the server will index for this post (2026-10-24, video on every surface). Mirrors api-server
 * services/memory/memoryFromOwnMedia.ts ownPostMediaList: the post's media items first, then its EXTERNAL
 * `media_urls` entries; a post with no items keeps the old `media_urls` count. Uploads have lived in `post_media`
 * only since 3924, so counting `media_urls` alone hid the action on every upload post.
 *
 * 2026-10-25 (#808 verdict finding 2): this is an ESTIMATE that only decides whether to offer the action and opens
 * the copy; the server's own count, on every answer, decides how far it goes (services/memoryFromPost.ts). It errs
 * LOW: a `media_urls` entry is counted as external only when it is plainly not ours — an http(s) URL that names no
 * Supabase Storage path and no media relay. A signed / authenticated / render storage URL, a public storage URL in
 * any bucket and an unclean relay URL are all left out, because the server does not offer them.
 */
export function ownPostMediaCount(post: OwnPostForMemory): number {
  const urls = Array.isArray(post.mediaUrls) ? post.mediaUrls.filter((u): u is string => typeof u === 'string' && u.length > 0) : [];
  const items = Array.isArray(post.media) ? post.media.length : 0;
  if (items === 0) return urls.length;
  return items + urls.filter((u) => !isPrivateMediaRefOf(u) && isPlainlyExternalMediaUrl(u)).length;
}

const STORAGE_OR_RELAY_PATH = /\/storage\/v1\/|\/api\/media\/file\//i;

/** True only for an http(s) URL that names no Supabase Storage path and no media relay, however it is spelled. */
export function isPlainlyExternalMediaUrl(raw: string): boolean {
  const s = raw.trim();
  if (!/^https?:\/\//i.test(s)) return false;
  let decoded = s;
  try { decoded = decodeURIComponent(s); } catch { return false; }
  return !STORAGE_OR_RELAY_PATH.test(s) && !STORAGE_OR_RELAY_PATH.test(decoded);
}

/** True when the post is the viewer's own and carries media. The SERVER is the guard; this only decides what to offer. */
export function canOfferSaveToMemory(post: OwnPostForMemory | null | undefined, viewerId: string | null | undefined): boolean {
  if (!post || !viewerId) return false;
  const author = post.author?.id ?? post.authorId ?? null;
  return author === viewerId && ownPostMediaCount(post) > 0;
}

/** A short title for a new Memory made from a post: its first line, or nothing. */
export function titleFromPost(content: string | null | undefined): string | null {
  const first = (content ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!first) return null;
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

type ListState = { s: 'loading' } | { s: 'error' } | { s: 'ok'; memories: Memory[] };
type SaveState =
  | { s: 'idle' }
  | { s: 'saving'; target: string }
  | { s: 'done'; report: SavePostReport; title: string | null; retry: (() => void) | null };

export function SaveOwnPostToMemorySheet({
  visible, post, viewerId, onClose,
}: { visible: boolean; post: OwnPostForMemory; viewerId: string; onClose: () => void }) {
  const [list, setList] = useState<ListState>({ s: 'loading' });
  const [save, setSave] = useState<SaveState>({ s: 'idle' });
  const inFlight = useRef(false);
  const mediaCount = Math.min(MAX_POST_MEDIA, ownPostMediaCount(post));

  const load = useCallback(async () => {
    setList({ s: 'loading' });
    const r = await getUserMemories(viewerId);
    if (!r.ok) { setList({ s: 'error' }); return; }
    setList({ s: 'ok', memories: r.memories.filter((m) => m.ownerId === viewerId) });
  }, [viewerId]);

  useEffect(() => {
    if (!visible) return;
    setSave({ s: 'idle' });
    void load();
  }, [visible, load]);

  const copyInto = useCallback(async (memoryId: string, title: string | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSave({ s: 'saving', target: memoryId });
    try {
      const report = await saveOwnPostToMemory({ memoryId, postId: post.id, mediaCount });
      const retry = report.refusal && isRetryable(report.refusal) ? () => { void copyInto(memoryId, title); } : null;
      setSave({ s: 'done', report, title, retry });
    } finally {
      inFlight.current = false;
    }
  }, [post.id, mediaCount]);

  const makeNew = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSave({ s: 'saving', target: 'new' });
    const title = titleFromPost(post.content);
    let created: Awaited<ReturnType<typeof createMemory>>;
    try {
      created = await createMemory({ title, visibility: 'only_me' });
    } finally {
      inFlight.current = false;
    }
    if (!created.ok) {
      const kind = created.kind === 'network_unreachable' ? 'network' : created.kind === 'degraded_unavailable' ? 'unavailable' : 'failed';
      setSave({ s: 'done', report: { saved: 0, alreadyThere: 0, total: mediaCount, refusal: kind }, title, retry: () => { void makeNew(); } });
      return;
    }
    await copyInto(created.memory.id, created.memory.title ?? title);
  }, [post.content, mediaCount, copyInto]);

  const busy = save.s === 'saving';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.overlay}>
        <Pressable style={{ flex: 1 }} onPress={busy ? undefined : onClose} accessibilityLabel="Close" />
        <View style={s.sheet} testID="save-to-memory-sheet">
          <View style={s.handle} />
          <Text style={s.title}>Save to a Memory</Text>
          <Text style={s.sub}>
            {mediaCount === 1 ? 'This post’s photo' : `This post’s ${mediaCount} photos and videos`} will be copied into the Memory you pick. The post stays as it is.
          </Text>

          {save.s === 'done' ? (
            <View style={s.result} testID="save-to-memory-result">
              <Text style={s.resultText} testID="save-to-memory-message">{describeSavePostReport(save.report, save.title)}</Text>
              <View style={s.resultActions}>
                {save.retry && (
                  <Pressable style={s.primary} onPress={save.retry} testID="save-to-memory-retry" accessibilityRole="button">
                    <Text style={s.primaryText}>Try again</Text>
                  </Pressable>
                )}
                <Pressable style={s.secondary} onPress={onClose} testID="save-to-memory-done" accessibilityRole="button">
                  <Text style={s.secondaryText}>Done</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: space.xs }}>
              <Pressable style={s.row} onPress={makeNew} disabled={busy} testID="save-to-memory-new" accessibilityRole="button">
                <Text style={s.rowLabel}>New private Memory from this post</Text>
                {busy && save.target === 'new' && <ActivityIndicator color={color.signal} />}
              </Pressable>
              {list.s === 'loading' && <ActivityIndicator color={color.signal} testID="save-to-memory-loading" />}
              {list.s === 'error' && (
                <View style={s.inline} testID="save-to-memory-list-error">
                  <Text style={s.mute}>Couldn’t load your Memories.</Text>
                  <Pressable onPress={load} testID="save-to-memory-list-retry" accessibilityRole="button"><Text style={s.link}>Try again</Text></Pressable>
                </View>
              )}
              {list.s === 'ok' && list.memories.length === 0 && <Text style={s.mute}>You have no Memories yet.</Text>}
              {list.s === 'ok' && list.memories.map((m) => (
                <Pressable key={m.id} style={s.row} onPress={() => copyInto(m.id, m.title)} disabled={busy} testID={`save-to-memory-pick-${m.id}`} accessibilityRole="button">
                  <Text style={s.rowLabel} numberOfLines={1}>{m.title || 'Untitled Memory'}</Text>
                  {busy && save.target === m.id && <ActivityIndicator color={color.signal} />}
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(17,17,15,0.45)' },
  sheet: { backgroundColor: color.paperRaised, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, gap: space.sm },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze, marginBottom: space.xs },
  title: { ...t.heading, color: color.ink },
  sub: { ...t.small, color: color.mute },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze },
  rowLabel: { ...t.body, color: color.ink, flex: 1 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  mute: { ...t.small, color: color.mute },
  link: { ...t.small, color: color.signal },
  result: { gap: space.md, paddingVertical: space.sm },
  resultText: { ...t.body, color: color.ink },
  resultActions: { flexDirection: 'row', gap: space.sm },
  primary: { backgroundColor: color.signal, paddingVertical: space.sm, paddingHorizontal: space.lg, borderRadius: radius.md },
  primaryText: { ...t.bodyStrong, color: color.onInk },
  secondary: { paddingVertical: space.sm, paddingHorizontal: space.lg, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze },
  secondaryText: { ...t.bodyStrong, color: color.ink },
});
import { isPrivateMediaRefOf } from '../../services/playbackUri.ts'; // 2026-10-24: the one private-ref rule
