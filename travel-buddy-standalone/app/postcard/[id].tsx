/**
 * app/postcard/[id] — the canonical Postcard viewer (Wall spec §10/§24).
 *
 * A Postcard is a first-class travel-story object, NOT a normal Post with a
 * badge (§10). Opening one from the Wall (or the Passport) lands HERE, in a
 * distinct story presentation — paper frame, prominent place + experience date,
 * collectible typography — rather than the standard post detail. The Wall
 * projection is never the object (§24): this route is keyed by the canonical
 * `posts` row id (a postcard IS a posts row) and reads the postcard's data
 * through the shared post-detail fetch (GET /api/posts/:id → structured
 * post_media with stamp overlays), so it does not invent a second data system.
 *
 * Fail-soft (§34/§40): a not-found / blocked / offline postcard renders a calm
 * message with a way back, never a crash or a blank.
 */

import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import { MapPin } from 'lucide-react-native';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { CachedImage } from '../../src/components/CachedImage';
import { AvatarImage } from '../../src/components/ui/DisplayMediaImage.tsx';
import { MediaStampOverlay } from '../../src/components/StampOverlayBadge';
import { SharedVideoPlayer } from '../../src/components/ui/SharedVideoPlayer';
import { getPostById, type PostRow } from '../../src/services/posts';
import type { PostcardMediaItem } from '../../src/types/models.ts';
import { color, space, radius, type as t, font, aspect } from '../../src/theme/tokens';

/** "AUGUST 30, 2026" — a printed-stamp date for the story header. */
function formatStoryDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d
    .toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    .toUpperCase();
}

function placeLabelOf(post: PostRow): string | null {
  return post.locationName ?? post.locationCity ?? post.locationCountry ?? null;
}

/** One framed media item in the story (image with stamp overlay, or video). */
function PostcardMedia({ item, filterId, filterIntensity }: {
  item: PostcardMediaItem;
  filterId?: string;
  filterIntensity?: number;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <View style={s.mediaFrame}>
      {item.media_type === 'video' ? (
        <SharedVideoPlayer
          uri={item.url}
          poster={item.thumbnail_url ?? undefined}
          autoplay={false}
          muted
          style={s.mediaFill}
        />
      ) : (
        <>
          <CachedImage
            // feed_url ?? url — never construct the derivative path (it 404s for
            // pre-0208 uploads / failed derives); CachedImage signs the
            // private-bucket reference through the shared hydration path.
            source={{ uri: item.feed_url ?? item.url }}
            style={s.mediaFill}
            aspect={aspect.card}
            resizeMode="cover"
            filterId={filterId}
            filterIntensity={filterIntensity}
            onError={() => setFailed(true)}
            fallbackLabel=""
          />
          {!failed ? <MediaStampOverlay raw={item.stamp_overlay} /> : null}
        </>
      )}
    </View>
  );
}

export default function PostcardViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [post, setPost] = useState<PostRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!id) {
        setLoading(false);
        setError('Postcard not found.');
        return;
      }
      let cancelled = false;
      setLoading(true);
      setError(null);
      getPostById(id)
        .then((result) => {
          if (cancelled) return;
          if (result.ok && result.data) {
            setPost(result.data);
          } else {
            setError(
              result.errorKind === 'not_found'
                ? 'Postcard not found.'
                : 'Could not load this postcard.',
            );
          }
        })
        .catch(() => {
          if (!cancelled) setError('Could not load this postcard.');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [id]),
  );

  const readyMedia = (post?.media ?? []).filter((m) => m.processing_status !== 'failed');
  const place = post ? placeLabelOf(post) : null;
  const experienceDate = formatStoryDate(post?.publishedAt ?? post?.createdAt);
  const authorName = post?.author?.name ?? 'A traveler';

  return (
    <View style={s.root} testID="postcard-viewer">
      <AppHeader variant="detail" title="Postcard" onBack={router.back} />
      {loading ? (
        <View style={s.center} testID="postcard-loading">
          <ActivityIndicator color={color.signal} />
        </View>
      ) : error || !post ? (
        <View style={s.center}>
          <Text style={s.errorText} testID="postcard-error">
            {error ?? 'Could not load this postcard.'}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
          testID="postcard-story"
        >
          {/* The card breaks the normal post language: a rotated paper frame. */}
          <View style={s.card}>
            <View style={s.stampRow}>
              {experienceDate ? (
                <Text style={s.dateStamp} testID="postcard-date">
                  {experienceDate}
                </Text>
              ) : null}
            </View>

            {readyMedia.length > 0 ? (
              readyMedia.map((m) => (
                <PostcardMedia
                  key={m.id}
                  item={m}
                  filterId={post.filterId}
                  filterIntensity={post.filterIntensity}
                />
              ))
            ) : (
              <View style={[s.mediaFrame, s.mediaPlaceholder]}>
                <MapPin size={26} color={color.onInk} />
                <Text style={s.placeholderText} numberOfLines={1}>
                  {(place ?? 'TRAVEL').toUpperCase()}
                </Text>
              </View>
            )}

            <View style={s.footer}>
              {place ? (
                <View style={s.locRow}>
                  <MapPin size={14} color={color.deep} />
                  <Text style={s.place} numberOfLines={2} testID="postcard-place">
                    {place}
                  </Text>
                </View>
              ) : null}

              {post.content ? (
                <Text style={s.caption} testID="postcard-caption">
                  {post.content}
                </Text>
              ) : null}

              <View style={s.byline}>
                <AvatarImage uri={post.author?.avatarUrl ?? null} user={post.author ?? undefined} size={28} />
                <Text style={s.bylineText} numberOfLines={1}>
                  Postcard · {authorName}
                </Text>
              </View>
            </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  errorText: { ...t.body, color: color.mute, textAlign: 'center' },
  scroll: { padding: space.lg, paddingBottom: space.xxxl },
  // A slight rotation + thick paper border makes the Postcard feel collectible
  // and distinct from the feed's post cards (§10/§35).
  card: {
    backgroundColor: '#FFFDF7',
    borderRadius: radius.sm,
    borderWidth: 8,
    borderColor: '#FFFFFF',
    overflow: 'hidden',
    transform: [{ rotate: '-0.5deg' }],
  },
  stampRow: { flexDirection: 'row', justifyContent: 'flex-end', padding: space.sm },
  dateStamp: {
    fontFamily: font.stamp,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: color.deep,
    borderWidth: 1.5,
    borderColor: color.deep,
    borderStyle: 'dashed',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: 3,
  },
  mediaFrame: {
    width: '100%',
    aspectRatio: aspect.card,
    backgroundColor: color.deep,
    marginBottom: space.xs,
  },
  mediaFill: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  mediaPlaceholder: { alignItems: 'center', justifyContent: 'center', gap: space.sm },
  placeholderText: { fontFamily: font.stamp, fontSize: 11, fontWeight: '700', color: color.onInk, letterSpacing: 1 },
  footer: { padding: space.lg, gap: space.md },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  place: { fontFamily: font.stamp, fontSize: 14, fontWeight: '700', letterSpacing: 0.5, color: color.deep, flex: 1 },
  // Story typography: larger, airier than a post caption (§10 distinct type).
  caption: { ...t.body, fontSize: 17, lineHeight: 26, color: color.ink },
  byline: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs },
  bylineText: { ...t.small, color: color.mute, flex: 1 },
});
