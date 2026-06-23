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
exports.PostcardTile = PostcardTile;
exports.PostcardWall = PostcardWall;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var filters_1 = require("../lib/media/filters");
function PostcardTile(_a) {
    var _b, _c, _d, _e, _f, _g;
    var post = _a.post, _h = _a.variant, variant = _h === void 0 ? 'square' : _h, _j = _a.rotate, rotate = _j === void 0 ? 0 : _j;
    var h = variant === 'tall' ? 230 : variant === 'wide' ? 150 : 190;
    var date = new Date(post.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    var isVideo = ((_b = post.media[0]) === null || _b === void 0 ? void 0 : _b.kind) === 'video' || ((_c = post.mediaType) === null || _c === void 0 ? void 0 : _c.startsWith('video/'));
    var hasFilterId = post.filterId && post.filterId !== 'original';
    var shouldApplyCssFilter = isVideo && hasFilterId;
    var cssFilter = shouldApplyCssFilter
        ? (0, filters_1.buildCssFilter)((0, filters_1.getMediaFilter)(post.filterId), (_d = post.filterIntensity) !== null && _d !== void 0 ? _d : 100)
        : 'none';
    return (<react_native_1.Pressable onPress={function () { return expo_router_1.router.push("/post/".concat(post.id)); }} style={[pt.card, { height: h, transform: [{ rotate: "".concat(rotate, "deg") }] }]}>
      {/* image side */}
      <react_native_1.View style={pt.media}>
        {post.media[0] ? (<react_native_1.Image source={{ uri: post.media[0].url }} style={[
                react_native_1.StyleSheet.absoluteFill,
                shouldApplyCssFilter && react_native_1.Platform.OS === 'web' ? { filter: cssFilter } : undefined,
            ]}/>) : (<react_native_1.View style={[react_native_1.StyleSheet.absoluteFill, pt.noImage]}><react_native_1.Text style={pt.noImageText} numberOfLines={3}>{(_e = post.title) !== null && _e !== void 0 ? _e : post.caption}</react_native_1.Text></react_native_1.View>)}
        {/* video play badge */}
        {((_f = post.media[0]) === null || _f === void 0 ? void 0 : _f.kind) === 'video' && (<react_native_1.View style={pt.playBadge}>
            <lucide_react_native_1.PlayCircle size={28} color="#FFFFFF"/>
          </react_native_1.View>)}
        {/* corner date stamp */}
        <react_native_1.View style={pt.dateStamp}><react_native_1.Text style={pt.dateText}>{date.toUpperCase()}</react_native_1.Text></react_native_1.View>
      </react_native_1.View>
      {/* postcard footer (printed strip) */}
      <react_native_1.View style={pt.footer}>
        <react_native_1.View style={pt.locRow}>
          <lucide_react_native_1.MapPin size={11} color={tokens_1.color.deep}/>
          <react_native_1.Text style={pt.loc} numberOfLines={1}>{post.destination.city}</react_native_1.Text>
        </react_native_1.View>
        {(post.title || post.caption) ? (<react_native_1.Text style={pt.caption} numberOfLines={2}>{(_g = post.title) !== null && _g !== void 0 ? _g : post.caption}</react_native_1.Text>) : null}
      </react_native_1.View>
    </react_native_1.Pressable>);
}
/** Staggered two-column postcard wall. */
function PostcardWall(_a) {
    var posts = _a.posts;
    if (posts.length === 0) {
        return (<react_native_1.View style={pt.empty}>
        <react_native_1.Text style={pt.emptyTitle}>No postcards yet</react_native_1.Text>
        <react_native_1.Text style={pt.emptySub}>Share a travel moment to start your wall.</react_native_1.Text>
      </react_native_1.View>);
    }
    // split into two columns, alternating variants for stagger
    var variants = ['tall', 'square', 'wide', 'square', 'tall', 'wide'];
    var left = [], right = [];
    posts.forEach(function (p, i) { return (i % 2 === 0 ? left : right).push(p); });
    return (<react_native_1.View style={pt.wall}>
      <react_native_1.View style={pt.col}>
        {left.map(function (p, i) { return <PostcardTile key={p.id} post={p} variant={variants[(i * 2) % variants.length]} rotate={i % 2 === 0 ? -1.5 : 1}/>; })}
      </react_native_1.View>
      <react_native_1.View style={pt.col}>
        {right.map(function (p, i) { return <PostcardTile key={p.id} post={p} variant={variants[(i * 2 + 1) % variants.length]} rotate={i % 2 === 0 ? 1.5 : -1}/>; })}
      </react_native_1.View>
    </react_native_1.View>);
}
var pt = react_native_1.StyleSheet.create({
    card: __assign({ backgroundColor: tokens_1.color.paper, borderRadius: 6, borderWidth: 4, borderColor: '#FFFFFF', overflow: 'hidden' }, tokens_1.shadow.card),
    media: { flex: 1, backgroundColor: tokens_1.color.deep },
    noImage: { backgroundColor: tokens_1.color.deep, alignItems: 'center', justifyContent: 'center', padding: tokens_1.space.md },
    noImageText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.onInk, textAlign: 'center' }),
    playBadge: {
        position: 'absolute', top: '50%', left: '50%',
        transform: [{ translateX: -14 }, { translateY: -14 }],
    },
    dateStamp: {
        position: 'absolute', top: 6, right: 6,
        borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)', borderStyle: 'dashed',
        paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3,
    },
    dateText: { fontFamily: 'Courier', fontSize: 8, fontWeight: '700', color: tokens_1.color.onInk, letterSpacing: 1 },
    footer: { backgroundColor: tokens_1.color.paper, padding: tokens_1.space.sm, gap: 2, borderTopWidth: 1, borderTopColor: tokens_1.color.haze },
    locRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    loc: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: tokens_1.color.deep, letterSpacing: 0.5 },
    caption: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontSize: 12 }),
    wall: { flexDirection: 'row', gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg },
    col: { flex: 1, gap: tokens_1.space.md },
    empty: { marginHorizontal: tokens_1.space.lg, padding: tokens_1.space.xl, borderRadius: tokens_1.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: tokens_1.color.haze, alignItems: 'center', gap: 4 },
    emptyTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    emptySub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center' }),
});
