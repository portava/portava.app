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
exports.PostCard = PostCard;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var filters_1 = require("../lib/media/filters");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var ui_1 = require("./ui");
var ActionBar_1 = require("./ActionBar");
/** Routes a post to the right card by kind. Hero falls back to standard if image too bright. */
function PostCard(_a) {
    var _b;
    var post = _a.post;
    if (post.kind === 'hero') {
        var bright = (0, ui_1.needsContrastFallback)((_b = post.media[0]) === null || _b === void 0 ? void 0 : _b.brightness);
        return bright ? <StandardCard post={post}/> : <HeroCard post={post}/>;
    }
    if (post.kind === 'question')
        return <QuestionCard post={post}/>;
    if (post.kind === 'itinerary')
        return <ItineraryCard post={post}/>;
    return <StandardCard post={post}/>;
}
function Locator(_a) {
    var post = _a.post, onInk = _a.onInk;
    return (<react_native_1.Pressable onPress={function () { return expo_router_1.router.push("/destination/".concat(post.destination.slug)); }} style={styles.locator} hitSlop={6}>
      <lucide_react_native_1.MapPin size={12} color={onInk ? tokens_1.color.onInk : tokens_1.color.deep}/>
      <react_native_1.Text style={[styles.locatorText, { color: onInk ? tokens_1.color.onInk : tokens_1.color.deep }]}>
        {post.destination.city}
      </react_native_1.Text>
    </react_native_1.Pressable>);
}
function Byline(_a) {
    var post = _a.post, onInk = _a.onInk;
    return (<react_native_1.Pressable style={styles.byline} onPress={function () { return expo_router_1.router.push("/profile/".concat(post.author.handle)); }}>
      <ui_1.Avatar uri={post.author.avatarUrl} size={28}/>
      <react_native_1.Text style={[styles.bylineName, { color: onInk ? tokens_1.color.onInk : tokens_1.color.ink }]}>
        {post.author.name}
      </react_native_1.Text>
    </react_native_1.Pressable>);
}
/* 1. HERO — full-bleed image, scrim, editorial title overlaid. */
function HeroCard(_a) {
    var post = _a.post;
    return (<react_native_1.Pressable style={[styles.card, styles.hero]} onPress={function () { return expo_router_1.router.push("/post/".concat(post.id)); }}>
      <react_native_1.Image source={{ uri: post.media[0].url }} style={react_native_1.StyleSheet.absoluteFill}/>
      <ui_1.Scrim />
      <react_native_1.View style={styles.heroTop}>
        <ui_1.Stamp label={post.category} tone="onInk"/>
      </react_native_1.View>
      <react_native_1.View style={styles.heroBottom}>
        <Locator post={post} onInk/>
        <react_native_1.Text style={styles.heroTitle} numberOfLines={2}>{post.title}</react_native_1.Text>
        <react_native_1.View style={styles.heroByRow}>
          <Byline post={post} onInk/>
          <react_native_1.View style={{ flex: 1 }}/>
        </react_native_1.View>
        <react_native_1.View style={styles.heroActions}>
          <ActionBar_1.ActionBar tint={tokens_1.color.onInk} liked={post.liked} saved={post.saved} likeCount={post.likeCount} commentCount={post.commentCount} saveCount={post.saveCount}/>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.Pressable>);
}
/* 2. STANDARD — image first (if any), caption below. Cleaner, readable. */
function StandardCard(_a) {
    var _b, _c, _d, _e;
    var post = _a.post;
    var hasMedia = post.media.length > 0;
    var isVideo = ((_b = post.media[0]) === null || _b === void 0 ? void 0 : _b.kind) === 'video' || ((_c = post.mediaType) === null || _c === void 0 ? void 0 : _c.startsWith('video/'));
    var hasFilterId = post.filterId && post.filterId !== 'original';
    var shouldApplyCssFilter = isVideo && hasFilterId;
    var cssFilter = shouldApplyCssFilter
        ? (0, filters_1.buildCssFilter)((0, filters_1.getMediaFilter)(post.filterId), (_d = post.filterIntensity) !== null && _d !== void 0 ? _d : 100)
        : 'none';
    return (<react_native_1.View style={[styles.card, styles.standard]}>
      <react_native_1.View style={styles.stdHead}>
        <Byline post={post}/>
        <react_native_1.View style={{ flex: 1 }}/>
        <Locator post={post}/>
      </react_native_1.View>
      {hasMedia && (<react_native_1.View>
          <react_native_1.Image source={{ uri: post.media[0].url }} style={[
                styles.stdImage,
                shouldApplyCssFilter && react_native_1.Platform.OS === 'web' ? { filter: cssFilter } : undefined,
            ]}/>
          {((_e = post.media[0]) === null || _e === void 0 ? void 0 : _e.kind) === 'video' && (<react_native_1.View style={styles.playBadge}>
              <lucide_react_native_1.PlayCircle size={32} color="#FFFFFF"/>
            </react_native_1.View>)}
        </react_native_1.View>)}
      <react_native_1.View style={styles.stdBody}>
        <react_native_1.View style={styles.stampRow}>
          <ui_1.Stamp label={post.category}/>
          {post.safetyNote && <ui_1.Stamp label="safety" tone="signal" rotate={2}/>}
          {post.rating != null && <ui_1.Stamp label={'★'.repeat(post.rating)} tone="deep" rotate={2}/>}
        </react_native_1.View>
        {post.caption && <react_native_1.Text style={styles.caption}>{post.caption}</react_native_1.Text>}
        <ActionBar_1.ActionBar liked={post.liked} saved={post.saved} likeCount={post.likeCount} commentCount={post.commentCount} saveCount={post.saveCount}/>
      </react_native_1.View>
    </react_native_1.View>);
}
/* 3. QUESTION — no image, text-forward, Ask AI / Answer. */
function QuestionCard(_a) {
    var post = _a.post;
    return (<react_native_1.View style={[styles.card, styles.question]}>
      <react_native_1.View style={styles.stdHead}>
        <Byline post={post}/>
        <react_native_1.View style={{ flex: 1 }}/>
        <Locator post={post}/>
      </react_native_1.View>
      <react_native_1.View style={styles.qIconRow}>
        <lucide_react_native_1.MessageCircleQuestion size={18} color={tokens_1.color.deep}/>
        <react_native_1.Text style={styles.qLabel}>Question</react_native_1.Text>
      </react_native_1.View>
      <react_native_1.Text style={styles.qTitle}>{post.title}</react_native_1.Text>
      {post.caption && <react_native_1.Text style={styles.qBody} numberOfLines={4}>{post.caption}</react_native_1.Text>}
      <react_native_1.View style={styles.qFooter}>
        <react_native_1.Text style={styles.qMeta}>{post.commentCount} answers</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable style={styles.ghostBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}>
          <lucide_react_native_1.Sparkles size={14} color={tokens_1.color.ink}/>
          <react_native_1.Text style={styles.ghostBtnText}>Ask AI</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={styles.solidBtn} onPress={function () { return expo_router_1.router.push("/post/".concat(post.id)); }}>
          <react_native_1.Text style={styles.solidBtnText}>Answer</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
/* 4. ITINERARY — cover image top, trip meta, Add to Trip. */
function ItineraryCard(_a) {
    var post = _a.post;
    return (<react_native_1.Pressable style={[styles.card, styles.itin]} onPress={function () { return expo_router_1.router.push("/post/".concat(post.id)); }}>
      {post.media[0] && <react_native_1.Image source={{ uri: post.media[0].url }} style={styles.itinCover}/>}
      <react_native_1.View style={styles.itinBody}>
        <react_native_1.View style={styles.stampRow}>
          <ui_1.Stamp label="itinerary" tone="deep"/>
          <ui_1.Stamp label={"".concat(post.dayCount, " days")} rotate={2}/>
        </react_native_1.View>
        <react_native_1.Text style={styles.itinTitle}>{post.title}</react_native_1.Text>
        <react_native_1.View style={styles.itinMetaRow}>
          <lucide_react_native_1.CalendarDays size={14} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.itinMeta}>
            {post.destination.city} · {post.saveCount} saves
          </react_native_1.Text>
        </react_native_1.View>
        <react_native_1.Pressable style={styles.solidBtnWide} onPress={function () { return expo_router_1.router.push('/(tabs)/trips'); }}>
          <react_native_1.Text style={styles.solidBtnText}>Add to Trip</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.Pressable>);
}
var styles = react_native_1.StyleSheet.create({
    card: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, overflow: 'hidden' }, tokens_1.shadow.card),
    hero: { height: 460 },
    heroTop: { position: 'absolute', top: tokens_1.space.lg, left: tokens_1.space.lg },
    heroBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: tokens_1.space.lg, gap: tokens_1.space.sm },
    heroTitle: __assign(__assign({}, tokens_1.type.hero), { color: tokens_1.color.onInk }),
    heroByRow: { flexDirection: 'row', alignItems: 'center' },
    heroActions: { marginTop: tokens_1.space.sm },
    standard: {},
    stdHead: { flexDirection: 'row', alignItems: 'center', padding: tokens_1.space.md, gap: tokens_1.space.sm },
    stdImage: { width: '100%', aspectRatio: 4 / 3, backgroundColor: tokens_1.color.haze },
    playBadge: { position: 'absolute', top: '50%', left: '50%', transform: [{ translateX: -16 }, { translateY: -16 }] },
    stdBody: { padding: tokens_1.space.lg, gap: tokens_1.space.md },
    question: { padding: tokens_1.space.lg, gap: tokens_1.space.md },
    qIconRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    qLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.deep }),
    qTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    qBody: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    qFooter: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginTop: tokens_1.space.xs },
    qMeta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint }),
    itin: {},
    itinCover: { width: '100%', height: 180, backgroundColor: tokens_1.color.haze },
    itinBody: { padding: tokens_1.space.lg, gap: tokens_1.space.sm },
    itinTitle: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink }),
    itinMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    itinMeta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    stampRow: { flexDirection: 'row', gap: tokens_1.space.sm, alignItems: 'center' },
    caption: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    locator: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    locatorText: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier' }),
    byline: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    bylineName: __assign({}, tokens_1.type.bodyStrong),
    ghostBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm,
        borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze,
    },
    ghostBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    solidBtn: {
        paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm,
        borderRadius: tokens_1.radius.pill, backgroundColor: tokens_1.color.ink,
    },
    solidBtnWide: {
        marginTop: tokens_1.space.xs, paddingVertical: tokens_1.space.md,
        borderRadius: tokens_1.radius.pill, backgroundColor: tokens_1.color.ink, alignItems: 'center',
    },
    solidBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.onInk }),
});
