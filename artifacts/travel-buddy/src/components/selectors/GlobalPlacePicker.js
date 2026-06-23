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
exports.GlobalPlacePicker = GlobalPlacePicker;
/**
 * GlobalPlacePicker — app-wide location / place selector.
 *
 * Bottom-sheet modal with:
 *  - Use current GPS location
 *  - Recent places (from /api/me/recent-places)
 *  - Search (via /api/places/search → Nominatim)
 *  - Popular city fallback list
 *  - Manual city entry (custom text)
 *
 * Props:
 *   visible       — sheet visibility
 *   onSelect      — called with Place on selection
 *   onClose       — dismiss sheet
 *   title         — sheet title
 *   allowGPS      — show "Use my location" row (default true)
 *   countryCode   — bias search results to this country
 *   placeholder   — search placeholder
 *   usedFor       — label for recent-places storage (e.g. "trip_destination")
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var ExpoLocation = require("expo-location");
var tokens_1 = require("../../theme/tokens");
var usePlaceSearch_1 = require("../../hooks/usePlaceSearch");
var useRecentPlaces_1 = require("../../hooks/useRecentPlaces");
function apiBase() {
    var _a;
    return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
}
var POPULAR = [
    { id: 'pop-bangkok', type: 'city', name: 'Bangkok', displayName: 'Bangkok, Thailand', country: 'Thailand', countryCode: 'TH', region: null, city: 'Bangkok', district: null, lat: 13.756, lng: 100.502, timezone: 'Asia/Bangkok', source: 'manual' },
    { id: 'pop-bali', type: 'city', name: 'Bali', displayName: 'Bali, Indonesia', country: 'Indonesia', countryCode: 'ID', region: null, city: 'Bali', district: null, lat: -8.409, lng: 115.188, timezone: 'Asia/Makassar', source: 'manual' },
    { id: 'pop-tokyo', type: 'city', name: 'Tokyo', displayName: 'Tokyo, Japan', country: 'Japan', countryCode: 'JP', region: null, city: 'Tokyo', district: null, lat: 35.689, lng: 139.691, timezone: 'Asia/Tokyo', source: 'manual' },
    { id: 'pop-paris', type: 'city', name: 'Paris', displayName: 'Paris, France', country: 'France', countryCode: 'FR', region: null, city: 'Paris', district: null, lat: 48.856, lng: 2.351, timezone: 'Europe/Paris', source: 'manual' },
    { id: 'pop-barcelona', type: 'city', name: 'Barcelona', displayName: 'Barcelona, Spain', country: 'Spain', countryCode: 'ES', region: null, city: 'Barcelona', district: null, lat: 41.385, lng: 2.173, timezone: 'Europe/Madrid', source: 'manual' },
    { id: 'pop-newyork', type: 'city', name: 'New York', displayName: 'New York, USA', country: 'USA', countryCode: 'US', region: null, city: 'New York', district: null, lat: 40.712, lng: -74.006, timezone: 'America/New_York', source: 'manual' },
    { id: 'pop-london', type: 'city', name: 'London', displayName: 'London, UK', country: 'UK', countryCode: 'GB', region: null, city: 'London', district: null, lat: 51.507, lng: -0.127, timezone: 'Europe/London', source: 'manual' },
    { id: 'pop-singapore', type: 'city', name: 'Singapore', displayName: 'Singapore', country: 'Singapore', countryCode: 'SG', region: null, city: 'Singapore', district: null, lat: 1.352, lng: 103.819, timezone: 'Asia/Singapore', source: 'manual' },
    { id: 'pop-istanbul', type: 'city', name: 'Istanbul', displayName: 'Istanbul, Turkey', country: 'Turkey', countryCode: 'TR', region: null, city: 'Istanbul', district: null, lat: 41.013, lng: 28.979, timezone: 'Europe/Istanbul', source: 'manual' },
    { id: 'pop-dubai', type: 'city', name: 'Dubai', displayName: 'Dubai, UAE', country: 'UAE', countryCode: 'AE', region: null, city: 'Dubai', district: null, lat: 25.204, lng: 55.270, timezone: 'Asia/Dubai', source: 'manual' },
    { id: 'pop-cebu', type: 'city', name: 'Cebu City', displayName: 'Cebu City, Philippines', country: 'Philippines', countryCode: 'PH', region: null, city: 'Cebu City', district: null, lat: 10.316, lng: 123.891, timezone: 'Asia/Manila', source: 'manual' },
    { id: 'pop-hcm', type: 'city', name: 'Ho Chi Minh City', displayName: 'Ho Chi Minh City, Vietnam', country: 'Vietnam', countryCode: 'VN', region: null, city: 'Ho Chi Minh City', district: null, lat: 10.776, lng: 106.701, timezone: 'Asia/Ho_Chi_Minh', source: 'manual' },
    { id: 'pop-lisbon', type: 'city', name: 'Lisbon', displayName: 'Lisbon, Portugal', country: 'Portugal', countryCode: 'PT', region: null, city: 'Lisbon', district: null, lat: 38.716, lng: -9.139, timezone: 'Europe/Lisbon', source: 'manual' },
    { id: 'pop-cdmx', type: 'city', name: 'Mexico City', displayName: 'Mexico City, Mexico', country: 'Mexico', countryCode: 'MX', region: null, city: 'Mexico City', district: null, lat: 19.432, lng: -99.133, timezone: 'America/Mexico_City', source: 'manual' },
    { id: 'pop-capetown', type: 'city', name: 'Cape Town', displayName: 'Cape Town, South Africa', country: 'South Africa', countryCode: 'ZA', region: null, city: 'Cape Town', district: null, lat: -33.924, lng: 18.424, timezone: 'Africa/Johannesburg', source: 'manual' },
];
function GlobalPlacePicker(_a) {
    var visible = _a.visible, onSelect = _a.onSelect, onClose = _a.onClose, title = _a.title, _b = _a.allowGPS, allowGPS = _b === void 0 ? true : _b, countryCode = _a.countryCode, placeholder = _a.placeholder, usedFor = _a.usedFor;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _c = (0, react_1.useState)(''), query = _c[0], setQuery = _c[1];
    var _d = (0, react_1.useState)('idle'), gpsState = _d[0], setGpsState = _d[1];
    var _e = (0, usePlaceSearch_1.usePlaceSearch)(query, { countryCode: countryCode }), searchResults = _e.results, searching = _e.loading;
    var _f = (0, useRecentPlaces_1.useRecentPlaces)(), recents = _f.recents, saveRecent = _f.saveRecent;
    (0, react_1.useEffect)(function () {
        if (visible) {
            setQuery('');
            setGpsState('idle');
        }
    }, [visible]);
    var select = (0, react_1.useCallback)(function (place) {
        saveRecent(place, usedFor);
        onSelect(place);
        onClose();
    }, [onSelect, onClose, saveRecent, usedFor]);
    function useGPS() {
        return __awaiter(this, void 0, void 0, function () {
            var status_1, pos, _a, lat, lng, res, body, _b, gpsPlace, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        setGpsState('loading');
                        _d.label = 1;
                    case 1:
                        _d.trys.push([1, 10, , 11]);
                        return [4 /*yield*/, ExpoLocation.requestForegroundPermissionsAsync()];
                    case 2:
                        status_1 = (_d.sent()).status;
                        if (status_1 !== 'granted') {
                            setGpsState('denied');
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced })];
                    case 3:
                        pos = _d.sent();
                        _a = pos.coords, lat = _a.latitude, lng = _a.longitude;
                        _d.label = 4;
                    case 4:
                        _d.trys.push([4, 8, , 9]);
                        return [4 /*yield*/, fetch("".concat(apiBase(), "/api/places/reverse?lat=").concat(lat, "&lng=").concat(lng))];
                    case 5:
                        res = _d.sent();
                        if (!res.ok) return [3 /*break*/, 7];
                        return [4 /*yield*/, res.json()];
                    case 6:
                        body = _d.sent();
                        if (body.place) {
                            select(body.place);
                            return [2 /*return*/];
                        }
                        _d.label = 7;
                    case 7: return [3 /*break*/, 9];
                    case 8:
                        _b = _d.sent();
                        return [3 /*break*/, 9];
                    case 9:
                        gpsPlace = {
                            id: "gps-".concat(lat.toFixed(4), "-").concat(lng.toFixed(4)),
                            type: 'place', name: 'Current Location',
                            displayName: "".concat(lat.toFixed(4), ", ").concat(lng.toFixed(4)),
                            country: null, countryCode: null, region: null, city: null, district: null,
                            lat: lat,
                            lng: lng,
                            timezone: null, source: 'gps',
                        };
                        select(gpsPlace);
                        return [3 /*break*/, 11];
                    case 10:
                        _c = _d.sent();
                        setGpsState('error');
                        return [3 /*break*/, 11];
                    case 11: return [2 /*return*/];
                }
            });
        });
    }
    // Custom entry: user typed something and tapped "Use…"
    function useCustom() {
        var q = query.trim();
        if (!q)
            return;
        var place = {
            id: "manual-".concat(q.toLowerCase().replace(/\s+/g, '-')),
            type: 'city', name: q, displayName: q,
            country: null, countryCode: null, region: null, city: q, district: null,
            lat: null, lng: null, timezone: null, source: 'manual',
        };
        select(place);
    }
    var showSearch = query.trim().length > 0;
    var showCustom = showSearch && !searchResults.find(function (r) { return r.name.toLowerCase() === query.toLowerCase(); });
    var showPopular = !showSearch && recents.length === 0;
    var showRecents = !showSearch && recents.length > 0;
    var items = [];
    if (allowGPS)
        items.push({ kind: 'gps' });
    if (showRecents) {
        items.push({ kind: 'section', label: 'Recent' });
        recents.slice(0, 5).forEach(function (p) { return items.push({ kind: 'place', place: p }); });
    }
    if (showPopular) {
        items.push({ kind: 'section', label: 'Popular Destinations' });
        POPULAR.forEach(function (p) { return items.push({ kind: 'place', place: p }); });
    }
    if (showSearch) {
        searchResults.forEach(function (p) { return items.push({ kind: 'place', place: p }); });
        if (showCustom)
            items.push({ kind: 'custom' });
    }
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <react_native_1.KeyboardAvoidingView style={s.overlay} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined}>
        <react_native_1.Pressable style={s.backdrop} onPress={onClose}/>
        <react_native_1.View style={[s.sheet, { paddingBottom: insets.bottom + 8 }]}>
          {/* Header */}
          <react_native_1.View style={s.header}>
            <react_native_1.Text style={s.title}>{title !== null && title !== void 0 ? title : 'Choose Location'}</react_native_1.Text>
            <react_native_1.Pressable style={s.closeBtn} onPress={onClose} hitSlop={12}>
              <lucide_react_native_1.X size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
          </react_native_1.View>

          {/* Search bar */}
          <react_native_1.View style={s.searchRow}>
            <lucide_react_native_1.Search size={16} color={tokens_1.color.mute}/>
            <react_native_1.TextInput style={s.input} value={query} onChangeText={setQuery} placeholder={placeholder !== null && placeholder !== void 0 ? placeholder : 'Search cities, places…'} placeholderTextColor={tokens_1.color.faint} autoCapitalize="words" returnKeyType="search" onSubmitEditing={useCustom}/>
            {searching && <react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>}
            {query.length > 0 && !searching && (<react_native_1.Pressable onPress={function () { return setQuery(''); }} hitSlop={8}>
                <lucide_react_native_1.X size={14} color={tokens_1.color.mute}/>
              </react_native_1.Pressable>)}
          </react_native_1.View>

          {/* GPS status messages */}
          {gpsState === 'denied' && (<react_native_1.Text style={s.gpsMsg}>Location is off. Choose a city manually.</react_native_1.Text>)}
          {gpsState === 'error' && (<react_native_1.Text style={s.gpsMsg}>Couldn't get location. Choose a city below.</react_native_1.Text>)}

          {/* List */}
          <react_native_1.FlatList data={items} keyExtractor={function (item, i) {
            if (item.kind === 'gps')
                return 'gps';
            if (item.kind === 'custom')
                return 'custom';
            if (item.kind === 'section')
                return "section-".concat(item.label);
            return item.place.id;
        }} style={s.list} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} renderItem={function (_a) {
            var item = _a.item;
            if (item.kind === 'section') {
                return <react_native_1.Text style={s.sectionLabel}>{item.label}</react_native_1.Text>;
            }
            if (item.kind === 'gps') {
                return (<react_native_1.Pressable style={s.row} onPress={useGPS} disabled={gpsState === 'loading'}>
                    <react_native_1.View style={[s.iconCircle, { backgroundColor: "".concat(tokens_1.color.signal, "20") }]}>
                      {gpsState === 'loading'
                        ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>
                        : <lucide_react_native_1.Navigation size={16} color={tokens_1.color.signal}/>}
                    </react_native_1.View>
                    <react_native_1.View style={s.rowText}>
                      <react_native_1.Text style={[s.rowName, { color: tokens_1.color.signal }]}>Use my current location</react_native_1.Text>
                      <react_native_1.Text style={s.rowSub}>GPS · updates automatically</react_native_1.Text>
                    </react_native_1.View>
                  </react_native_1.Pressable>);
            }
            if (item.kind === 'custom') {
                return (<react_native_1.Pressable style={s.row} onPress={useCustom}>
                    <react_native_1.View style={[s.iconCircle, { backgroundColor: "".concat(tokens_1.color.signal, "15") }]}>
                      <lucide_react_native_1.MapPin size={16} color={tokens_1.color.signal}/>
                    </react_native_1.View>
                    <react_native_1.View style={s.rowText}>
                      <react_native_1.Text style={s.rowName}>Use "<react_native_1.Text style={{ fontWeight: '700' }}>{query.trim()}</react_native_1.Text>"</react_native_1.Text>
                      <react_native_1.Text style={s.rowSub}>Enter as custom city</react_native_1.Text>
                    </react_native_1.View>
                  </react_native_1.Pressable>);
            }
            // Place row
            var place = item.place;
            var isRecent = recents.some(function (r) { return r.id === place.id; });
            return (<react_native_1.Pressable style={s.row} onPress={function () { return select(place); }}>
                  <react_native_1.View style={s.iconCircle}>
                    {isRecent
                    ? <lucide_react_native_1.Clock size={15} color={tokens_1.color.mute}/>
                    : <lucide_react_native_1.MapPin size={15} color={tokens_1.color.mute}/>}
                  </react_native_1.View>
                  <react_native_1.View style={s.rowText}>
                    <react_native_1.Text style={s.rowName} numberOfLines={1}>{place.name}</react_native_1.Text>
                    {place.displayName !== place.name && (<react_native_1.Text style={s.rowSub} numberOfLines={1}>{place.displayName}</react_native_1.Text>)}
                  </react_native_1.View>
                </react_native_1.Pressable>);
        }} ListEmptyComponent={showSearch && !searching ? (<react_native_1.View style={s.empty}>
                  <react_native_1.Text style={s.emptyText}>No places found. Type to enter a custom city.</react_native_1.Text>
                </react_native_1.View>) : null}/>
        </react_native_1.View>
      </react_native_1.KeyboardAvoidingView>
    </react_native_1.Modal>);
}
var s = react_native_1.StyleSheet.create({
    overlay: { flex: 1, justifyContent: 'flex-end' },
    backdrop: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(17,17,15,0.45)' }),
    sheet: {
        backgroundColor: tokens_1.color.paper,
        borderTopLeftRadius: tokens_1.radius.lg,
        borderTopRightRadius: tokens_1.radius.lg,
        maxHeight: '85%',
    },
    header: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: tokens_1.space.xl, paddingTop: tokens_1.space.lg, paddingBottom: tokens_1.space.md,
    },
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, flex: 1 }),
    closeBtn: { padding: 4 },
    searchRow: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        marginHorizontal: tokens_1.space.xl, marginBottom: tokens_1.space.sm,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze,
        paddingHorizontal: tokens_1.space.md, height: 44,
    },
    input: __assign(__assign({ flex: 1 }, tokens_1.type.body), { color: tokens_1.color.ink }),
    gpsMsg: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, paddingHorizontal: tokens_1.space.xl, paddingBottom: tokens_1.space.sm }),
    list: { flex: 1 },
    sectionLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, fontSize: 10, fontWeight: '700', paddingHorizontal: tokens_1.space.xl, paddingTop: tokens_1.space.md, paddingBottom: tokens_1.space.xs, textTransform: 'uppercase', letterSpacing: 0.8 }),
    row: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.xl, paddingVertical: 13,
        borderBottomWidth: react_native_1.StyleSheet.hairlineWidth, borderBottomColor: tokens_1.color.haze,
    },
    iconCircle: {
        width: 34, height: 34, borderRadius: 17,
        backgroundColor: tokens_1.color.paperRaised,
        alignItems: 'center', justifyContent: 'center',
    },
    rowText: { flex: 1 },
    rowName: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    rowSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 1 }),
    empty: { padding: tokens_1.space.xl, alignItems: 'center' },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
});
