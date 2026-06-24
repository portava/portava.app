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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = PassportDeepLinkScreen;
/**
 * app/passport/[username].tsx
 * Deep-link target: travelbuddy://passport/@<username>  /  HTTPS universal link /passport/@<username>
 * Public-facing Passport viewer. Works without auth (read-only).
 * Fetches from GET /api/users/:username/profile (new profile endpoint) +
 * GET /api/users/:username/passport/postcards (existing public postcards endpoint).
 * Private profiles show a minimal "This profile is private" stub.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var profile_1 = require("../../src/services/profile");
var SessionContext_1 = require("../../src/context/SessionContext");
var useFollow_1 = require("../../src/hooks/useFollow");
var useHighlightRingState_1 = require("../../src/hooks/useHighlightRingState");
var PassportHero_1 = require("../../src/components/PassportHero");
var HighlightViewer_1 = require("../../src/components/HighlightViewer");
var PostcardsTab_1 = require("../../src/components/PostcardsTab");
var StampsTab_1 = require("../../src/components/StampsTab");
var AboutTab_1 = require("../../src/components/AboutTab");
var MapTab_1 = require("../../src/components/MapTab");
var tokens_1 = require("../../src/theme/tokens");
var TABS = [
    { key: 'postcards', label: 'Postcards' },
    { key: 'stamps', label: 'Stamps' },
    { key: 'map', label: 'Map' },
    { key: 'about', label: 'About' },
];
function PassportDeepLinkScreen() {
    var _this = this;
    var _a, _b, _c, _d;
    var rawUsername = (0, expo_router_1.useLocalSearchParams)().username;
    var username = (rawUsername !== null && rawUsername !== void 0 ? rawUsername : '').replace(/^@/, '');
    var _e = (0, react_1.useState)({
        profile: null, postcards: [], loading: true,
        error: null, isPrivate: false, notFound: false,
    }), state = _e[0], setState = _e[1];
    (0, react_1.useEffect)(function () {
        if (!username)
            return;
        var alive = true;
        setState({ profile: null, postcards: [], loading: true, error: null, isPrivate: false, notFound: false });
        (0, profile_1.getPublicProfile)(username).then(function (res) { return __awaiter(_this, void 0, void 0, function () {
            var card, profile, pcRes;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!alive)
                            return [2 /*return*/];
                        if (!res.ok) {
                            if (res.errorKind === 'not_found') {
                                setState(function (s) { return (__assign(__assign({}, s), { loading: false, notFound: true })); });
                            }
                            else {
                                setState(function (s) { var _a; return (__assign(__assign({}, s), { loading: false, error: (_a = res.message) !== null && _a !== void 0 ? _a : 'Failed to load profile' })); });
                            }
                            return [2 /*return*/];
                        }
                        card = res.data;
                        if (card.private || card.visibility === 'private') {
                            setState(function (s) { return (__assign(__assign({}, s), { loading: false, isPrivate: true })); });
                            return [2 /*return*/];
                        }
                        profile = {
                            id: (_a = card.id) !== null && _a !== void 0 ? _a : '',
                            username: card.username,
                            displayName: card.displayName,
                            bio: (_b = card.bio) !== null && _b !== void 0 ? _b : null,
                            avatarUrl: card.avatarUrl,
                            homeCity: null,
                            homeCountry: null,
                            travelStyle: null,
                            interests: [],
                            verified: false,
                            verificationStatus: 'unverified',
                            verifiedAt: null,
                            passportVisibility: 'public',
                            createdAt: null,
                        };
                        setState(function (s) { return (__assign(__assign({}, s), { profile: profile, loading: false })); });
                        return [4 /*yield*/, (0, profile_1.getPublicPostcards)(username)];
                    case 1:
                        pcRes = _c.sent();
                        if (alive) {
                            setState(function (s) { var _a; return (__assign(__assign({}, s), { postcards: pcRes.ok ? ((_a = pcRes.data) !== null && _a !== void 0 ? _a : []) : [] })); });
                        }
                        return [2 /*return*/];
                }
            });
        }); }).catch(function () {
            if (alive)
                setState(function (s) { return (__assign(__assign({}, s), { loading: false, error: 'Failed to load profile' })); });
        });
        return function () { alive = false; };
    }, [username]);
    var profile = state.profile, postcards = state.postcards, loading = state.loading, error = state.error, isPrivate = state.isPrivate, notFound = state.notFound;
    var isAuthed = (0, SessionContext_1.useSession)().isAuthed;
    var follow = (0, useFollow_1.useFollow)((_a = profile === null || profile === void 0 ? void 0 : profile.id) !== null && _a !== void 0 ? _a : null);
    var ringState = (0, useHighlightRingState_1.useHighlightRingState)((_b = profile === null || profile === void 0 ? void 0 : profile.id) !== null && _b !== void 0 ? _b : null);
    var _f = (0, react_1.useState)(false), highlightViewerOpen = _f[0], setHighlightViewerOpen = _f[1];
    var _g = (0, react_1.useState)('postcards'), tab = _g[0], setTab = _g[1];
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var renderContent = function () {
        if (loading) {
            return (<react_native_1.View style={styles.center}>
          <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
        </react_native_1.View>);
        }
        if (notFound) {
            return (<react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.stateIcon}>🔍</react_native_1.Text>
          <react_native_1.Text style={styles.stateTitle}>No one here</react_native_1.Text>
          <react_native_1.Text style={styles.stateSub}>@{username} doesn't exist.</react_native_1.Text>
          <react_native_1.Pressable style={styles.homeBtn} onPress={function () { return expo_router_1.router.replace('/(tabs)/'); }}>
            <react_native_1.Text style={styles.homeBtnText}>Go home</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>);
        }
        if (isPrivate) {
            return (<react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.stateIcon}>🔒</react_native_1.Text>
          <react_native_1.Text style={styles.stateTitle}>This Passport is private</react_native_1.Text>
          <react_native_1.Text style={styles.stateSub}>@{username} hasn't made their Passport public yet.</react_native_1.Text>
        </react_native_1.View>);
        }
        if (error) {
            return (<react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.stateTitle}>Couldn't load Passport</react_native_1.Text>
          <react_native_1.Text style={styles.stateSub}>{error}</react_native_1.Text>
        </react_native_1.View>);
        }
        if (!profile)
            return null;
        var countries = new Set(postcards.map(function (c) { return c.locationCountry; }).filter(Boolean)).size;
        var cities = new Set(postcards.map(function (c) { return c.locationCity; }).filter(Boolean)).size;
        return (<react_native_1.ScrollView style={{ flex: 1, backgroundColor: tokens_1.color.paper }} contentContainerStyle={{ paddingBottom: tokens_1.space.xxxl }} showsVerticalScrollIndicator={false}>
        <PassportHero_1.PassportHero profile={profile} isOwner={false} isFollowing={isAuthed ? follow.isFollowing : undefined} followLoading={isAuthed ? (follow.loading || follow.toggling) : undefined} onFollowPress={isAuthed ? follow.toggle : undefined} hasHighlights={ringState === null || ringState === void 0 ? void 0 : ringState.hasActive} allHighlightsViewed={ringState === null || ringState === void 0 ? void 0 : ringState.allViewed} onHighlightRingPress={(ringState === null || ringState === void 0 ? void 0 : ringState.hasActive) ? function () { return setHighlightViewerOpen(true); } : undefined}/>

        <react_native_1.View style={styles.statsRow}>
          {[
                { n: postcards.length, label: 'Postcards' },
                { n: countries, label: 'Countries' },
                { n: cities, label: 'Cities' },
                { n: follow.followersCount, label: 'Followers' },
            ].map(function (item, i) { return (<react_1.default.Fragment key={item.label}>
              {i > 0 && <react_native_1.View style={styles.statsDivider}/>}
              <react_native_1.View style={styles.statsCell}>
                <react_native_1.Text style={styles.statsN}>
                  {follow.loading && item.label === 'Followers' ? '—' : item.n}
                </react_native_1.Text>
                <react_native_1.Text style={styles.statsL}>{item.label}</react_native_1.Text>
              </react_native_1.View>
            </react_1.default.Fragment>); })}
        </react_native_1.View>

        {follow.followingCount > 0 && (<react_native_1.View style={styles.followingPill}>
            <lucide_react_native_1.Users size={12} color={tokens_1.color.mute}/>
            <react_native_1.Text style={styles.followingText}>
              Following {follow.followingCount}{' '}
              {follow.followingCount === 1 ? 'traveler' : 'travelers'}
            </react_native_1.Text>
          </react_native_1.View>)}

        <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBarWrap} contentContainerStyle={styles.tabBarContent}>
          {TABS.map(function (tb) { return (<react_native_1.Pressable key={tb.key} style={[styles.tab, tab === tb.key && styles.tabActive]} onPress={function () { return setTab(tb.key); }}>
              <react_native_1.Text style={[styles.tabText, tab === tb.key && styles.tabTextActive]}>
                {tb.label}
              </react_native_1.Text>
            </react_native_1.Pressable>); })}
        </react_native_1.ScrollView>

        <react_native_1.View style={{ marginTop: tokens_1.space.md }}>
          {tab === 'postcards' && <PostcardsTab_1.PostcardsTab postcards={postcards} isOwner={false}/>}
          {tab === 'stamps' && <StampsTab_1.StampsTab stamps={[]}/>}
          {tab === 'map' && <MapTab_1.MapTab postcards={postcards}/>}
          {tab === 'about' && <AboutTab_1.AboutTab profile={profile} isOwner={false}/>}
        </react_native_1.View>
      </react_native_1.ScrollView>);
    };
    return (<react_native_1.View style={[styles.container, { paddingTop: insets.top }]}>
      <react_native_1.View style={styles.header}>
        <react_native_1.Pressable onPress={function () { return (expo_router_1.router.canGoBack() ? expo_router_1.router.back() : expo_router_1.router.replace('/(tabs)/')); }} style={styles.backBtn} hitSlop={8}>
          <lucide_react_native_1.ArrowLeft size={22} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>
        <react_native_1.Text style={styles.headerTitle} numberOfLines={1}>
          {profile
            ? (profile.displayName || "@".concat((_c = profile.username) !== null && _c !== void 0 ? _c : username))
            : "@".concat(username || 'Passport')}
        </react_native_1.Text>
        <react_native_1.View style={{ width: 38 }}/>
      </react_native_1.View>
      {renderContent()}
      <HighlightViewer_1.HighlightViewer visible={highlightViewerOpen} highlights={(_d = ringState === null || ringState === void 0 ? void 0 : ringState.highlights) !== null && _d !== void 0 ? _d : []} onClose={function () { return setHighlightViewerOpen(false); }}/>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    container: { flex: 1, backgroundColor: tokens_1.color.paper },
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: tokens_1.space.md, paddingVertical: 10,
        borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paper,
    },
    backBtn: { padding: 6 },
    headerTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, flex: 1, textAlign: 'center' }),
    center: {
        flex: 1, alignItems: 'center', justifyContent: 'center',
        paddingHorizontal: tokens_1.space.xl, gap: tokens_1.space.md, minHeight: 300,
    },
    stateIcon: { fontSize: 56 },
    stateTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, textAlign: 'center' }),
    stateSub: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
    homeBtn: {
        marginTop: tokens_1.space.sm,
        paddingVertical: tokens_1.space.md, paddingHorizontal: tokens_1.space.xl,
        backgroundColor: tokens_1.color.ink, borderRadius: tokens_1.radius.pill,
    },
    homeBtnText: { color: tokens_1.color.onInk, fontWeight: '700', fontSize: 14 },
    statsRow: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg,
        borderWidth: 1, borderColor: tokens_1.color.haze,
        marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.sm,
        paddingVertical: 10,
    },
    statsCell: { flex: 1, alignItems: 'center' },
    statsDivider: { width: 1, height: 28, backgroundColor: tokens_1.color.haze },
    statsN: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 18 }),
    statsL: { fontFamily: 'Courier', fontSize: 9, color: tokens_1.color.mute, fontWeight: '700' },
    followingPill: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.sm,
        paddingVertical: 6, paddingHorizontal: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.pill,
        borderWidth: 1, borderColor: tokens_1.color.haze, alignSelf: 'flex-start',
    },
    followingText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12 }),
    tabBarWrap: { marginTop: tokens_1.space.md },
    tabBarContent: { paddingHorizontal: tokens_1.space.lg, gap: tokens_1.space.xs },
    tab: {
        paddingHorizontal: tokens_1.space.md, paddingVertical: 8,
        borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    tabActive: { backgroundColor: tokens_1.color.ink, borderColor: tokens_1.color.ink },
    tabText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '700', fontSize: 13 }),
    tabTextActive: { color: tokens_1.color.onInk },
});
