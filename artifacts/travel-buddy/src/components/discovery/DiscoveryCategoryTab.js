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
exports.DiscoveryCategoryTab = DiscoveryCategoryTab;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var discovery_1 = require("../../services/discovery");
var tokens_1 = require("../../theme/tokens");
var PlaceCard_1 = require("./PlaceCard");
var PlaceSkeleton_1 = require("./PlaceSkeleton");
// ── Radius chips ──────────────────────────────────────────────────────────────
var RADIUS_OPTIONS = [
    { label: '5 km', km: 5 },
    { label: '10 km', km: 10 },
    { label: '25 km', km: 25 },
    { label: '50 km', km: 50 },
];
var MIN_RATING_OPTIONS = [
    { label: 'Any', value: null },
    { label: '3+', value: 3 },
    { label: '4+', value: 4 },
    { label: '4.5+', value: 4.5 },
];
function FilterStrip(_a) {
    var filters = _a.filters, onChange = _a.onChange;
    return (<react_native_1.View style={fs.wrap}>
      {/* Radius chips */}
      <react_native_1.View style={fs.row}>
        {RADIUS_OPTIONS.map(function (opt) {
            var active = filters.radiusKm === opt.km;
            return (<react_native_1.Pressable key={opt.km} style={[fs.chip, active && fs.chipActive]} onPress={function () { return onChange(__assign(__assign({}, filters), { radiusKm: opt.km })); }}>
              <react_native_1.Text style={[fs.chipText, active && fs.chipTextActive]}>{opt.label}</react_native_1.Text>
            </react_native_1.Pressable>);
        })}
      </react_native_1.View>

      {/* Open Now toggle + Min rating */}
      <react_native_1.View style={fs.row2}>
        <react_native_1.View style={fs.toggleRow}>
          <react_native_1.Switch value={filters.openNow} onValueChange={function (v) { return onChange(__assign(__assign({}, filters), { openNow: v })); }} trackColor={{ false: tokens_1.color.haze, true: tokens_1.color.signal + '60' }} thumbColor={filters.openNow ? tokens_1.color.signal : tokens_1.color.faint} style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}/>
          <react_native_1.Text style={fs.toggleLabel}>Open now</react_native_1.Text>
        </react_native_1.View>

        <react_native_1.View style={fs.ratingRow}>
          <react_native_1.Text style={fs.ratingLabel}>Rating:</react_native_1.Text>
          {MIN_RATING_OPTIONS.map(function (opt) {
            var active = filters.minRating === opt.value;
            return (<react_native_1.Pressable key={String(opt.value)} style={[fs.chip, active && fs.chipActive]} onPress={function () { return onChange(__assign(__assign({}, filters), { minRating: opt.value })); }}>
                <react_native_1.Text style={[fs.chipText, active && fs.chipTextActive]}>{opt.label}</react_native_1.Text>
              </react_native_1.Pressable>);
        })}
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.View>);
}
var fs = react_native_1.StyleSheet.create({
    wrap: {
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.sm,
        gap: tokens_1.space.sm,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    row: {
        flexDirection: 'row',
        gap: tokens_1.space.sm,
    },
    row2: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.lg,
    },
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.xs,
    },
    toggleLabel: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.mute, fontSize: 11 }),
    ratingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.xs,
        flex: 1,
        flexWrap: 'wrap',
    },
    ratingLabel: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint, fontSize: 10 }),
    chip: {
        paddingHorizontal: tokens_1.space.sm + 2,
        paddingVertical: tokens_1.space.xs + 1,
        borderRadius: tokens_1.radius.pill,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    chipActive: {
        borderColor: tokens_1.color.signal,
        backgroundColor: tokens_1.color.signal + '12',
    },
    chipText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.mute, fontSize: 11 }),
    chipTextActive: {
        color: tokens_1.color.signal,
        fontWeight: '700',
    },
});
// ── Popular destinations fallback ─────────────────────────────────────────────
var POPULAR_CITIES = [
    'Paris', 'Tokyo', 'Bali', 'Barcelona', 'London',
    'New York', 'Rome', 'Amsterdam', 'Bangkok', 'Sydney',
];
function NoDestinationView(_a) {
    var onPickCity = _a.onPickCity;
    return (<react_native_1.View style={nd.wrap}>
      <lucide_react_native_1.Search size={32} color={tokens_1.color.faint}/>
      <react_native_1.Text style={nd.title}>Pick a destination</react_native_1.Text>
      <react_native_1.Text style={nd.sub}>Tap the city bar above, or choose a popular one:</react_native_1.Text>
      <react_native_1.View style={nd.chips}>
        {POPULAR_CITIES.map(function (city) { return (<react_native_1.Pressable key={city} style={nd.chip} onPress={function () { return onPickCity(city); }}>
            <react_native_1.Text style={nd.chipText}>{city}</react_native_1.Text>
          </react_native_1.Pressable>); })}
      </react_native_1.View>
    </react_native_1.View>);
}
var nd = react_native_1.StyleSheet.create({
    wrap: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.xl,
    },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, textAlign: 'center' }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center', lineHeight: 19 }),
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm, justifyContent: 'center' },
    chip: {
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.sm,
        borderRadius: tokens_1.radius.pill,
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
    },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '600' }),
});
function DiscoveryCategoryTab(_a) {
    var _this = this;
    var category = _a.category, destination = _a.destination, onSelectPlace = _a.onSelectPlace, onAddToPlan = _a.onAddToPlan, onPickDestination = _a.onPickDestination, contextMode = _a.contextMode;
    var _b = (0, react_1.useState)([]), places = _b[0], setPlaces = _b[1];
    var _c = (0, react_1.useState)(false), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)(false), refreshing = _d[0], setRefreshing = _d[1];
    var _e = (0, react_1.useState)(null), error = _e[0], setError = _e[1];
    var _f = (0, react_1.useState)(1), page = _f[0], setPage = _f[1];
    var _g = (0, react_1.useState)(0), total = _g[0], setTotal = _g[1];
    var _h = (0, react_1.useState)({ radiusKm: 10, openNow: false, minRating: null }), filters = _h[0], setFilters = _h[1];
    var loadingMore = (0, react_1.useRef)(false);
    var applyClientFilters = function (raw) {
        var result = raw;
        // Open Now filter: OSM has opening_hours occasionally — filter where present
        if (filters.openNow) {
            result = result.filter(function (p) {
                if (!p.openingHours)
                    return true; // no data → include optimistically
                return isLikelyOpen(p.openingHours);
            });
        }
        // Min rating: OSM rarely carries ratings — no-op client-side for now
        // (kept as a UI affordance; future backend pass can honour it)
        return result;
    };
    var load = (0, react_1.useCallback)(function (nextPage, currentFilters, reset) { return __awaiter(_this, void 0, void 0, function () {
        var res, filtered;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!destination)
                        return [2 /*return*/];
                    if (reset)
                        setLoading(true);
                    setError(null);
                    return [4 /*yield*/, (0, discovery_1.getDiscoveryPlaces)(destination, category, currentFilters, nextPage, contextMode)];
                case 1:
                    res = _a.sent();
                    setLoading(false);
                    setRefreshing(false);
                    loadingMore.current = false;
                    if (!res.ok) {
                        setError(res.error);
                        return [2 /*return*/];
                    }
                    filtered = applyClientFilters(res.data.places);
                    setTotal(res.data.total);
                    setPlaces(function (prev) { return reset ? filtered : __spreadArray(__spreadArray([], prev, true), filtered, true); });
                    setPage(nextPage);
                    return [2 /*return*/];
            }
        });
    }); }, [destination, category, filters]); // eslint-disable-line react-hooks/exhaustive-deps
    (0, react_1.useEffect)(function () {
        setPlaces([]);
        setPage(1);
        load(1, filters, true);
    }, [destination, category, filters, load]);
    var handleRefresh = function () {
        setRefreshing(true);
        setPlaces([]);
        load(1, filters, false);
    };
    var handleLoadMore = function () {
        if (loadingMore.current || places.length >= total)
            return;
        loadingMore.current = true;
        load(page + 1, filters, false);
    };
    var handleFilterChange = function (f) {
        setFilters(f);
        setPlaces([]);
        setPage(1);
    };
    if (!destination) {
        return (<NoDestinationView onPickCity={function (city) { return onPickDestination === null || onPickDestination === void 0 ? void 0 : onPickDestination(city); }}/>);
    }
    return (<react_native_1.View style={{ flex: 1 }}>
      <FilterStrip filters={filters} onChange={handleFilterChange}/>

      {loading && places.length === 0 ? (<PlaceSkeleton_1.PlaceSkeletonList count={6}/>) : error && places.length === 0 ? (<react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.emptyTitle}>Couldn't load places</react_native_1.Text>
          <react_native_1.Text style={styles.emptyDesc}>{error}</react_native_1.Text>
          <react_native_1.Pressable style={styles.retryBtn} onPress={function () { return load(1, filters, true); }}>
            <react_native_1.Text style={styles.retryText}>Try again</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>) : places.length === 0 ? (<react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.emptyTitle}>No places found</react_native_1.Text>
          <react_native_1.Text style={styles.emptyDesc}>
            Try increasing the search radius or adjust the filters.
          </react_native_1.Text>
        </react_native_1.View>) : (<react_native_1.FlatList data={places} keyExtractor={function (item) { return item.id; }} renderItem={function (_a) {
                var item = _a.item;
                return (<PlaceCard_1.default place={item} onPress={function () { return onSelectPlace(item); }} onAddToPlan={function () { return onAddToPlan(item); }}/>);
            }} contentContainerStyle={styles.list} showsVerticalScrollIndicator={false} refreshControl={<react_native_1.RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={tokens_1.color.signal}/>} onEndReached={handleLoadMore} onEndReachedThreshold={0.4} ListFooterComponent={places.length >= total && places.length > 0 ? (<react_native_1.Text style={styles.endText}>{places.length} places found</react_native_1.Text>) : null}/>)}
    </react_native_1.View>);
}
/** Crude heuristic: check if today's day abbreviation appears in opening hours */
function isLikelyOpen(hours) {
    var now = new Date();
    var dayAbbr = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][now.getDay()];
    var hh = now.getHours() * 100 + now.getMinutes();
    // Simple: if hours string mentions the day and seems to cover current hour
    if (!hours.includes(dayAbbr !== null && dayAbbr !== void 0 ? dayAbbr : ''))
        return false;
    var match = hours.match(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
    if (!match)
        return true; // can't parse, be optimistic
    var open = parseInt(match[1]) * 100 + parseInt(match[2]);
    var close = parseInt(match[3]) * 100 + parseInt(match[4]);
    return hh >= open && hh <= close;
}
var styles = react_native_1.StyleSheet.create({
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.xxl,
    },
    emptyTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, textAlign: 'center' }),
    emptyDesc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center', lineHeight: 19 }),
    retryBtn: {
        marginTop: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.xl,
        paddingVertical: tokens_1.space.md,
        backgroundColor: tokens_1.color.signal,
        borderRadius: tokens_1.radius.md,
    },
    retryText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
    list: {
        paddingTop: tokens_1.space.sm,
        paddingBottom: tokens_1.space.xxxl,
    },
    endText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint, fontSize: 11, textAlign: 'center', marginVertical: tokens_1.space.xl }),
});
exports.default = DiscoveryCategoryTab;
