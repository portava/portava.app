"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealPostsList = RealPostsList;
var react_1 = require("react");
var react_native_1 = require("react-native");
var tokens_1 = require("../theme/tokens");
/**
 * Real-posts list — renders ACTUAL backend posts from GET /api/posts (via
 * useGlobalFeed). This is a proof-of-round-trip surface, not the final feed
 * design. The rich mock PulseFeedItem cards remain elsewhere on the screen.
 *
 * Pass data/loading/error/reload from useGlobalFeed() in the parent so refetch
 * can be triggered on screen focus (after the composer creates a post).
 */
function timeAgo(iso) {
    var then = new Date(iso).getTime();
    if (Number.isNaN(then))
        return '';
    var s = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (s < 60)
        return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60)
        return "".concat(m, "m ago");
    var h = Math.floor(m / 60);
    if (h < 24)
        return "".concat(h, "h ago");
    var d = Math.floor(h / 24);
    return "".concat(d, "d ago");
}
function RealPostCard(_a) {
    var post = _a.post;
    return (<react_native_1.View style={s.card}>
      <react_native_1.View style={s.metaRow}>
        <react_native_1.Text style={s.author} numberOfLines={1}>{shortId(post.authorId)}</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.View style={[s.badge, post.visibility !== 'public' && s.badgeAlt]}>
          <react_native_1.Text style={s.badgeText}>{post.visibility}</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>
      <react_native_1.Text style={s.body}>{post.content}</react_native_1.Text>
      <react_native_1.View style={s.footRow}>
        {post.tripId ? <react_native_1.Text style={s.trip}>· trip post</react_native_1.Text> : null}
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Text style={s.time}>{timeAgo(post.createdAt)}</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.View>);
}
function shortId(id) {
    // No author profile join in this proof step; show a short stable handle.
    return id ? "@".concat(id.slice(0, 8)) : '@unknown';
}
function RealPostsList(_a) {
    var data = _a.data, loading = _a.loading, error = _a.error, onRetry = _a.onRetry;
    return (<react_native_1.View style={s.section}>
      <react_native_1.View style={s.headRow}>
        <react_native_1.Text style={s.heading}>Live posts</react_native_1.Text>
        <react_native_1.View style={s.liveDot}/>
      </react_native_1.View>

      {loading && data.length === 0 ? (<react_native_1.View style={s.stateBox}><react_native_1.ActivityIndicator color={tokens_1.color.signal}/></react_native_1.View>) : error ? (<react_native_1.View style={s.stateBox}>
          <react_native_1.Text style={s.errText}>{error}</react_native_1.Text>
          {onRetry ? (<react_native_1.Pressable onPress={onRetry} style={s.retry}><react_native_1.Text style={s.retryText}>Retry</react_native_1.Text></react_native_1.Pressable>) : null}
        </react_native_1.View>) : data.length === 0 ? (<react_native_1.View style={s.stateBox}>
          <react_native_1.Text style={s.emptyText}>No posts yet. Be the first to share something.</react_native_1.Text>
        </react_native_1.View>) : (<react_native_1.View style={{ gap: tokens_1.space.sm }}>
          {data.map(function (p) { return <RealPostCard key={p.id} post={p}/>; })}
        </react_native_1.View>)}
    </react_native_1.View>);
}
var s = react_native_1.StyleSheet.create({
    section: { paddingHorizontal: tokens_1.space.lg, gap: tokens_1.space.sm, marginBottom: tokens_1.space.lg },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    heading: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18 }),
    liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens_1.color.success },
    card: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md, gap: tokens_1.space.sm }, tokens_1.shadow.card),
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    author: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14, maxWidth: 160 }),
    badge: { paddingHorizontal: tokens_1.space.sm, paddingVertical: 2, borderRadius: tokens_1.radius.pill, backgroundColor: tokens_1.color.haze },
    badgeAlt: { backgroundColor: tokens_1.color.deep },
    badgeText: __assign(__assign({}, tokens_1.type.small), { fontSize: 11, fontWeight: '700', color: tokens_1.color.onInk }),
    body: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    footRow: { flexDirection: 'row', alignItems: 'center' },
    trip: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    time: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    stateBox: { padding: tokens_1.space.lg, alignItems: 'center', gap: tokens_1.space.sm, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
    errText: __assign(__assign({}, tokens_1.type.body), { color: '#B23B3B', textAlign: 'center' }),
    retry: { paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, backgroundColor: tokens_1.color.ink, borderRadius: tokens_1.radius.pill },
    retryText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
});
