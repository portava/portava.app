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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForYouTab = ForYouTab;
/**
 * For You tab — AI-backed recommendations from Telegraph.
 *
 * Uses PlaceCard for full interaction parity (Save, Get Directions, Add to Plan,
 * tap to open PlaceDetailSheet). Shows a "Why this?" reason banner above each card.
 * Falls back to OSM attraction mix when Telegraph is unavailable or user is not signed in.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var DiscoveryShareSheet_1 = require("../DiscoveryShareSheet");
var telegraphRecommend_1 = require("../../services/telegraphRecommend");
var discovery_1 = require("../../services/discovery");
var PlaceSkeleton_1 = require("./PlaceSkeleton");
var PlaceCard_1 = require("./PlaceCard");
var PlaceDetailSheet_1 = require("./PlaceDetailSheet");
var tokens_1 = require("../../theme/tokens");
var SessionContext_1 = require("../../context/SessionContext");
var useCommunityDiscovery_1 = require("../../hooks/useCommunityDiscovery");
var DiscoveryWall2_1 = require("../DiscoveryWall2");
// ── Convert a Telegraph recommendation to DiscoveryPlace shape ────────────────
function recToPlace(rec) {
    var tags = [rec.estimatedTime, rec.priceLevel].filter(function (s) { return s && s !== 'free'; });
    return {
        id: rec.id,
        name: rec.title,
        category: 'for_you',
        type: rec.category || null,
        description: rec.locationContext || null,
        distanceKm: null,
        lat: null,
        lng: null,
        tags: tags,
        address: rec.locationContext || null,
        website: null,
        phone: null,
        openingHours: null,
        rating: null,
        isOpenNow: null,
    };
}
function ForYouTab(_a) {
    var _this = this;
    var destination = _a.destination, onAddToPlan = _a.onAddToPlan, contextMode = _a.contextMode;
    var isAuthed = (0, SessionContext_1.useSession)().isAuthed;
    var _b = (0, react_1.useState)([]), items = _b[0], setItems = _b[1];
    var _c = (0, react_1.useState)(false), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)(false), refreshing = _d[0], setRefreshing = _d[1];
    var _e = (0, react_1.useState)('none'), source = _e[0], setSource = _e[1];
    var _f = (0, react_1.useState)(null), detail = _f[0], setDetail = _f[1];
    var _g = (0, react_1.useState)(null), shareItem = _g[0], setShareItem = _g[1];
    var community = (0, useCommunityDiscovery_1.useCommunityDiscovery)(destination !== null && destination !== void 0 ? destination : null);
    // Monotonically-increasing counter so stale async callbacks from an old
    // load() call can detect they've been superseded and bail out safely.
    var loadIdRef = react_1.default.useRef(0);
    var load = (0, react_1.useCallback)(function () {
        var args_1 = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args_1[_i] = arguments[_i];
        }
        return __awaiter(_this, __spreadArray([], args_1, true), void 0, function (isRefresh) {
            var myId, stale, osmPromise, telPromise, tel, _a;
            if (isRefresh === void 0) { isRefresh = false; }
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!destination)
                            return [2 /*return*/];
                        myId = ++loadIdRef.current;
                        stale = function () { return loadIdRef.current !== myId; };
                        if (!isRefresh)
                            setLoading(true);
                        osmPromise = (0, discovery_1.getDiscoveryPlaces)(destination, 'for_you', { radiusKm: 25, openNow: false, minRating: null }, 1, contextMode);
                        telPromise = isAuthed
                            ? (0, telegraphRecommend_1.getForYouRecommendations)({ destination: destination, count: 5 })
                            : null;
                        // Show OSM content the instant it resolves — clears the skeleton immediately.
                        osmPromise.then(function (osm) {
                            if (stale())
                                return;
                            setLoading(false);
                            setRefreshing(false);
                            if (osm.ok && osm.data.places.length > 0) {
                                setItems(osm.data.places.slice(0, 15).map(function (p) { return ({ kind: 'osm', place: p }); }));
                                setSource('osm');
                            }
                            else {
                                setItems([]);
                                setSource('none');
                            }
                        }).catch(function () {
                            if (!stale()) {
                                setLoading(false);
                                setRefreshing(false);
                            }
                        });
                        if (!telPromise) return [3 /*break*/, 5];
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, telPromise];
                    case 2:
                        tel = _b.sent();
                        if (!stale() && tel.ok && tel.recommendations.length > 0) {
                            setItems(tel.recommendations.map(function (rec) { return ({
                                kind: 'telegraph',
                                rec: rec,
                                place: recToPlace(rec),
                            }); }));
                            setSource('telegraph');
                        }
                        return [3 /*break*/, 4];
                    case 3:
                        _a = _b.sent();
                        return [3 /*break*/, 4];
                    case 4:
                        // Guarantee loading is cleared even if osmPromise somehow never resolved
                        if (!stale()) {
                            setLoading(false);
                            setRefreshing(false);
                        }
                        _b.label = 5;
                    case 5: return [2 /*return*/];
                }
            });
        });
    }, [destination, isAuthed]);
    (0, react_1.useEffect)(function () {
        setItems([]);
        setSource('none');
        load(false);
    }, [destination, isAuthed, load]);
    var handleRefresh = function () {
        setRefreshing(true);
        load(true);
    };
    if (!destination)
        return null;
    if (loading && items.length === 0) {
        return <PlaceSkeleton_1.PlaceSkeletonList count={5}/>;
    }
    return (<>
      <react_native_1.ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.list} refreshControl={<react_native_1.RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={tokens_1.color.signal}/>}>
        {/* Source label */}
        <react_native_1.View style={styles.sourceRow}>
          <lucide_react_native_1.Sparkles size={13} color={tokens_1.color.signal}/>
          <react_native_1.Text style={styles.sourceLabel}>
            {source === 'telegraph'
            ? 'Personalised picks · powered by Telegraph AI'
            : source === 'osm'
                ? 'Popular spots from OpenStreetMap · sign in for personalised picks'
                : 'Curated picks'}
          </react_native_1.Text>
        </react_native_1.View>

        {items.map(function (item) { return (<react_native_1.View key={item.place.id}>
            {/* "Why this?" reason banner — only for Telegraph cards */}
            {item.kind === 'telegraph' && item.rec.reason ? (<react_native_1.View style={styles.reasonBanner}>
                <lucide_react_native_1.Info size={11} color={tokens_1.color.signal}/>
                <react_native_1.Text style={styles.reasonText} numberOfLines={2}>
                  {item.rec.reason}
                </react_native_1.Text>
              </react_native_1.View>) : null}

            <PlaceCard_1.default place={item.place} onPress={function () { return setDetail(item.place); }} onAddToPlan={function () { return onAddToPlan({
                id: item.place.id,
                name: item.place.name,
                category: item.place.category,
                address: item.place.address,
            }); }}/>

            {/* Send to Telegraph */}
            <react_native_1.Pressable style={styles.shareRow} onPress={function () { return setShareItem(item); }}>
              <lucide_react_native_1.Share2 size={12} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.shareLabel}>Send to Telegraph</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>); })}

        {source === 'none' && (<react_native_1.View style={styles.empty}>
            <lucide_react_native_1.Sparkles size={28} color={tokens_1.color.faint}/>
            <react_native_1.Text style={styles.emptyTitle}>No recommendations yet</react_native_1.Text>
            <react_native_1.Text style={styles.emptyDesc}>
              {isAuthed
                ? "Couldn't load recommendations for ".concat(destination, ". Pull to refresh.")
                : "Sign in to get personalised picks for ".concat(destination, ".")}
            </react_native_1.Text>
          </react_native_1.View>)}

        {/* ── Community sections: traveler-submitted from Supabase ── */}
        {community.gems.length > 0 && (<react_native_1.View style={styles.communitySection}>
            <DiscoveryWall2_1.HiddenGemsSection gems={community.gems}/>
          </react_native_1.View>)}
        {community.picks.length > 0 && (<react_native_1.View style={styles.communitySection}>
            <DiscoveryWall2_1.TravelerPicksSection picks={community.picks}/>
          </react_native_1.View>)}
      </react_native_1.ScrollView>

      {/* Full-parity detail sheet (same as OSM tabs) */}
      <PlaceDetailSheet_1.PlaceDetailSheet place={detail} visible={detail !== null} onClose={function () { return setDetail(null); }} onAddToPlan={function (p) {
            setDetail(null);
            onAddToPlan({ id: p.id, name: p.name, category: p.category, address: p.address });
        }}/>

      {/* Discovery share sheet */}
      <DiscoveryShareSheet_1.DiscoveryShareSheet visible={shareItem !== null} item={shareItem ? buildSharePayload(shareItem) : null} onClose={function () { return setShareItem(null); }}/>
    </>);
}
function buildSharePayload(item) {
    var _a, _b, _c, _d, _e;
    if (item.kind === 'telegraph') {
        return {
            sourceId: item.rec.id,
            sourceType: 'for_you',
            title: item.rec.title,
            category: (_a = item.rec.category) !== null && _a !== void 0 ? _a : 'for_you',
            city: (_b = item.rec.locationContext) !== null && _b !== void 0 ? _b : '',
            blurb: item.rec.reason,
        };
    }
    return {
        sourceId: item.place.id,
        sourceType: 'place',
        title: item.place.name,
        category: (_c = item.place.category) !== null && _c !== void 0 ? _c : 'place',
        city: (_d = item.place.address) !== null && _d !== void 0 ? _d : '',
        blurb: (_e = item.place.description) !== null && _e !== void 0 ? _e : undefined,
    };
}
var styles = react_native_1.StyleSheet.create({
    list: {
        paddingTop: tokens_1.space.md,
        paddingBottom: tokens_1.space.xxxl,
    },
    communitySection: {
        marginTop: tokens_1.space.xl,
    },
    sourceRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.xs,
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: tokens_1.space.md,
    },
    sourceLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, flex: 1, lineHeight: 16 }),
    reasonBanner: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: tokens_1.space.xs,
        marginHorizontal: tokens_1.space.lg,
        marginBottom: -tokens_1.space.xs,
        backgroundColor: tokens_1.color.signal + '10',
        borderTopLeftRadius: tokens_1.radius.md,
        borderTopRightRadius: tokens_1.radius.md,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.sm,
        borderWidth: 1,
        borderBottomWidth: 0,
        borderColor: tokens_1.color.signal + '30',
    },
    reasonText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontStyle: 'italic', fontSize: 11, flex: 1, lineHeight: 15 }),
    shareRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.xs,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: 7,
        borderTopWidth: react_native_1.StyleSheet.hairlineWidth,
        borderTopColor: tokens_1.color.haze,
        marginTop: -react_native_1.StyleSheet.hairlineWidth,
    },
    shareLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    empty: {
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.xxl,
        paddingTop: tokens_1.space.xxl,
    },
    emptyTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, textAlign: 'center' }),
    emptyDesc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center', lineHeight: 19 }),
});
exports.default = ForYouTab;
