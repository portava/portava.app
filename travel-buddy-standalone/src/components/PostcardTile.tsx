import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { MapPin, PlayCircle } from 'lucide-react-native';
import type { Post } from '../types/models.ts';
import { color, space, radius, type as t, shadow } from '../theme/tokens.ts';
import { MediaStampOverlay } from './StampOverlayBadge.tsx';
import { CachedImage } from './CachedImage.tsx';

/**
 * PostcardTile — postcard-styled tile (image-heavy, paper border, corner
 * location/date stamp, caption preview, slight rotation). Staggered sizes via
 * the `variant` prop so the grid feels collectible, not like feed cards.
 */
type Variant = 'tall' | 'wide' | 'square';

export function PostcardTile({ post, variant = 'square', rotate = 0 }: { post: Post; variant?: Variant; rotate?: number }) {
  const h = variant === 'tall' ? 290 : variant === 'wide' ? 200 : 250;
  const date = new Date(post.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const [imgFailed, setImgFailed] = React.useState(false);


  return (
    <Pressable
      onPress={() => router.push(`/post/${post.id}`)}
      style={[pt.card, { height: h, transform: [{ rotate: `${rotate}deg` }] }]}
    >
      {/* image side */}
      <View style={pt.media}>
        {post.media[0] && !imgFailed ? (
          <CachedImage
            // `?width=500` used to be here and never did anything: appStorageUrlInfo()
            // (lib/mediaUrl.ts) matches on url.pathname only — "Query strings are
            // ignored" — and /api/media/sign runs every URL through it before signing,
            // so the param was stripped before the signed URL existed. The tile was
            // fetching the full-size original and scaling it on-device. It now uses the
            // real server-side derivative, falling back to the original when the item
            // has none (pre-0208 uploads, videos, failed derives).
            source={{ uri: post.media[0].feedUrl ?? post.media[0].url }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            filterId={post.filterId}
            filterIntensity={post.filterIntensity}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, pt.noImage]}>
            <MapPin size={22} color={color.onInk} />
            <Text style={pt.noImageText} numberOfLines={2}>{post.destination.city.toUpperCase()}</Text>
          </View>
        )}
        {/* passport-stamp overlay (images only; parse-gated) */}
        {post.media[0] && <MediaStampOverlay raw={post.media[0].stampOverlay} />}
        {/* video play badge */}
        {post.media[0]?.kind === 'video' && (
          <View style={pt.playBadge}>
            <PlayCircle size={28} color="#FFFFFF" />
          </View>
        )}
        {/* corner date stamp */}
        <View style={pt.dateStamp}><Text style={pt.dateText}>{date.toUpperCase()}</Text></View>
      </View>
      {/* postcard footer (printed strip) */}
      <View style={pt.footer}>
        <View style={pt.locRow}>
          <MapPin size={11} color={color.deep} />
          <Text style={pt.loc} numberOfLines={1}>{post.destination.city}</Text>
        </View>
        {(post.title || post.caption) ? (
          <Text style={pt.caption} numberOfLines={2}>{post.title ?? post.caption}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Staggered two-column postcard wall. */
export function PostcardWall({ posts }: { posts: Post[] }) {
  if (posts.length === 0) {
    return (
      <View style={pt.empty}>
        <Text style={pt.emptyTitle}>No postcards yet</Text>
        <Text style={pt.emptySub}>Share a travel moment to start your wall.</Text>
      </View>
    );
  }
  // split into two columns, alternating variants for stagger
  const variants: Variant[] = ['tall', 'square', 'wide', 'square', 'tall', 'wide'];
  const left: Post[] = [], right: Post[] = [];
  posts.forEach((p, i) => (i % 2 === 0 ? left : right).push(p));
  return (
    <View style={pt.wall}>
      <View style={pt.col}>
        {left.map((p, i) => <PostcardTile key={p.id} post={p} variant={variants[(i * 2) % variants.length]} rotate={i % 2 === 0 ? -1.5 : 1} />)}
      </View>
      <View style={pt.col}>
        {right.map((p, i) => <PostcardTile key={p.id} post={p} variant={variants[(i * 2 + 1) % variants.length]} rotate={i % 2 === 0 ? 1.5 : -1} />)}
      </View>
    </View>
  );
}

const pt = StyleSheet.create({
  card: {
    backgroundColor: color.paper, borderRadius: 6,
    borderWidth: 6, borderColor: '#FFFFFF',
    overflow: 'hidden', ...shadow.card,
  },
  media: { flex: 1, backgroundColor: color.deep },
  noImage: { backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center', padding: space.md, gap: 8 },
  noImageText: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.onInk, letterSpacing: 1, textAlign: 'center' },
  playBadge: {
    position: 'absolute', top: '50%', left: '50%',
    transform: [{ translateX: -14 }, { translateY: -14 }],
  },
  dateStamp: {
    position: 'absolute', top: 6, right: 6,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)', borderStyle: 'dashed',
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3,
  },
  dateText: { fontFamily: 'Courier', fontSize: 8, fontWeight: '700', color: color.onInk, letterSpacing: 1 },
  footer: { backgroundColor: color.paper, padding: space.md, gap: 2, borderTopWidth: 1, borderTopColor: color.haze },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  loc: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.deep, letterSpacing: 0.5 },
  caption: { ...t.small, color: color.ink, fontSize: 12 },

  wall: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.md, maxWidth: 600, alignSelf: 'center', width: '100%' },
  col: { flex: 1, gap: space.md },
  empty: { maxWidth: 600, alignSelf: 'center', width: '100%', marginHorizontal: space.lg, padding: space.xl, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.haze, alignItems: 'center', gap: 4 },
  emptyTitle: { ...t.bodyStrong, color: color.ink },
  emptySub: { ...t.small, color: color.mute, textAlign: 'center' },
});
