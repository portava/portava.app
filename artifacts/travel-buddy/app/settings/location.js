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
exports.default = LocationSettingsScreen;
/**
 * Location Settings screen
 *
 * Accessible from profile/settings. Shows:
 * - Current location mode with description
 * - Pause-sharing toggle
 * - Per-feature visibility selectors (Pulse, Discovery)
 * - Safe Return toggle
 * - Trusted-circle live share management stub
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../src/theme/tokens");
var MODE_INFO = {
    off: {
        label: 'Off',
        description: 'No location data shared. Discovery and Pulse show destination content only.',
        Icon: lucide_react_native_1.EyeOff,
    },
    city_only: {
        label: 'City only',
        description: 'Only your city is used. Great for discovery without sharing your neighborhood.',
        Icon: lucide_react_native_1.MapPin,
    },
    nearby: {
        label: 'Nearby',
        description: 'Your neighborhood is used for nearby discovery and pulse. No exact location.',
        Icon: lucide_react_native_1.Navigation,
    },
    live_during_activity: {
        label: 'Live during activity',
        description: 'Approximate location shared while plans or meetups are active.',
        Icon: lucide_react_native_1.Navigation,
    },
    trusted_circle_live: {
        label: 'Trusted circle',
        description: 'Approximate location shared with your trusted circle. You control who sees it.',
        Icon: lucide_react_native_1.Users,
    },
};
var VISIBILITY_LABELS = {
    city_only: 'City only',
    neighborhood: 'Neighborhood',
    venue_tagged: 'Venue tagged',
    exact_hidden: 'Exact hidden',
    no_location: 'No location',
};
var ORDERED_MODES = ['off', 'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live'];
var ORDERED_VISIBILITY = ['city_only', 'neighborhood', 'venue_tagged', 'exact_hidden', 'no_location'];
// ── Hook: load/save preferences ───────────────────────────────────────────────
function getToken() {
    return __awaiter(this, void 0, void 0, function () {
        var supabase, data, _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    _d.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require('../../src/lib/supabase'); })];
                case 1:
                    supabase = (_d.sent()).supabase;
                    return [4 /*yield*/, supabase.auth.getSession()];
                case 2:
                    data = (_d.sent()).data;
                    return [2 /*return*/, (_c = (_b = data === null || data === void 0 ? void 0 : data.session) === null || _b === void 0 ? void 0 : _b.access_token) !== null && _c !== void 0 ? _c : null];
                case 3:
                    _a = _d.sent();
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function useLocationPrefs() {
    var _this = this;
    var _a;
    var _b = (0, react_1.useState)(null), prefs = _b[0], setPrefs = _b[1];
    var _c = (0, react_1.useState)(true), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)(false), saving = _d[0], setSaving = _d[1];
    var apiBase = (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
    var defaultPrefs = {
        locationMode: 'city_only',
        sharingPaused: false,
        pulseVisibility: null,
        discoveryVisibility: null,
        safeReturnEnabled: true,
        trustedCircleShare: false,
        hotelBlurEnabled: true,
    };
    (0, react_1.useEffect)(function () {
        var alive = true;
        (function () { return __awaiter(_this, void 0, void 0, function () {
            var token, r, d, _a;
            var _b, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0: return [4 /*yield*/, getToken()];
                    case 1:
                        token = _e.sent();
                        if (!token) {
                            if (alive) {
                                setPrefs(defaultPrefs);
                                setLoading(false);
                            }
                            return [2 /*return*/];
                        }
                        _e.label = 2;
                    case 2:
                        _e.trys.push([2, 5, 6, 7]);
                        return [4 /*yield*/, fetch("".concat(apiBase, "/api/me/location-preferences"), {
                                headers: { Authorization: "Bearer ".concat(token) },
                            })];
                    case 3:
                        r = _e.sent();
                        return [4 /*yield*/, r.json()];
                    case 4:
                        d = _e.sent();
                        if (alive) {
                            setPrefs({
                                locationMode: (_b = d.locationMode) !== null && _b !== void 0 ? _b : 'city_only',
                                sharingPaused: Boolean(d.sharingPaused),
                                pulseVisibility: (_c = d.pulseVisibility) !== null && _c !== void 0 ? _c : null,
                                discoveryVisibility: (_d = d.discoveryVisibility) !== null && _d !== void 0 ? _d : null,
                                safeReturnEnabled: d.safeReturnEnabled !== false,
                                trustedCircleShare: Boolean(d.trustedCircleShare),
                                hotelBlurEnabled: d.hotelBlurEnabled !== false,
                            });
                        }
                        return [3 /*break*/, 7];
                    case 5:
                        _a = _e.sent();
                        if (alive)
                            setPrefs(defaultPrefs);
                        return [3 /*break*/, 7];
                    case 6:
                        if (alive)
                            setLoading(false);
                        return [7 /*endfinally*/];
                    case 7: return [2 /*return*/];
                }
            });
        }); })();
        return function () { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    var save = (0, react_1.useCallback)(function (patch) { return __awaiter(_this, void 0, void 0, function () {
        var previous, token, response, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!prefs)
                        return [2 /*return*/];
                    previous = prefs;
                    setPrefs(__assign(__assign({}, prefs), patch));
                    setSaving(true);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 4, 5, 6]);
                    return [4 /*yield*/, getToken()];
                case 2:
                    token = _b.sent();
                    if (!token)
                        throw new Error('not_authed');
                    return [4 /*yield*/, fetch("".concat(apiBase, "/api/me/location-preferences"), {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json', Authorization: "Bearer ".concat(token) },
                            body: JSON.stringify(patch),
                        })];
                case 3:
                    response = _b.sent();
                    if (!response.ok)
                        throw new Error("HTTP ".concat(response.status));
                    return [3 /*break*/, 6];
                case 4:
                    _a = _b.sent();
                    setPrefs(previous);
                    react_native_1.Alert.alert('Save failed', 'Could not save preferences. Please try again.');
                    return [3 /*break*/, 6];
                case 5:
                    setSaving(false);
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); }, [prefs, apiBase]);
    return { prefs: prefs, loading: loading, saving: saving, save: save };
}
// ── Screen ────────────────────────────────────────────────────────────────────
function LocationSettingsScreen() {
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _a = useLocationPrefs(), prefs = _a.prefs, loading = _a.loading, saving = _a.saving, save = _a.save;
    var _b = (0, react_1.useState)(false), showModeSheet = _b[0], setShowModeSheet = _b[1];
    var _c = (0, react_1.useState)(false), showPulseSheet = _c[0], setShowPulseSheet = _c[1];
    var _d = (0, react_1.useState)(false), showDiscoverySheet = _d[0], setShowDiscoverySheet = _d[1];
    if (loading) {
        return (<react_native_1.View style={[styles.root, { paddingTop: insets.top }]}>
        <react_native_1.View style={styles.header}>
          <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} style={styles.backBtn}>
            <lucide_react_native_1.ArrowLeft size={22} color={tokens_1.color.ink}/>
          </react_native_1.Pressable>
          <react_native_1.Text style={styles.headerTitle}>Location</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.View style={styles.loadingContainer}>
          <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
        </react_native_1.View>
      </react_native_1.View>);
    }
    if (!prefs)
        return null;
    var currentMode = MODE_INFO[prefs.locationMode];
    var ModeIcon = currentMode.Icon;
    return (<react_native_1.View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <react_native_1.View style={styles.header}>
        <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} style={styles.backBtn}>
          <lucide_react_native_1.ArrowLeft size={22} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>
        <react_native_1.Text style={styles.headerTitle}>Location</react_native_1.Text>
        {saving && <react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal} style={{ marginLeft: 'auto' }}/>}
      </react_native_1.View>

      <react_native_1.ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + tokens_1.space.xl }}>
        {/* Pause sharing */}
        <react_native_1.View style={styles.section}>
          <react_native_1.Text style={styles.sectionLabel}>SHARING</react_native_1.Text>
          <react_native_1.View style={styles.row}>
            <react_native_1.View style={styles.rowContent}>
              <react_native_1.Text style={styles.rowTitle}>Pause sharing</react_native_1.Text>
              <react_native_1.Text style={styles.rowDesc}>Temporarily stop all location sharing</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.Switch value={prefs.sharingPaused} onValueChange={function (v) { return save({ sharingPaused: v }); }} trackColor={{ true: tokens_1.color.signal }}/>
          </react_native_1.View>
        </react_native_1.View>

        {/* Location mode */}
        <react_native_1.View style={styles.section}>
          <react_native_1.Text style={styles.sectionLabel}>LOCATION MODE</react_native_1.Text>
          <react_native_1.Pressable style={styles.modeCard} onPress={function () { return setShowModeSheet(true); }}>
            <react_native_1.View style={[styles.modeIconWrap, prefs.locationMode === 'off' && styles.modeIconOff]}>
              <ModeIcon size={18} color={prefs.locationMode === 'off' ? tokens_1.color.faint : tokens_1.color.signal}/>
            </react_native_1.View>
            <react_native_1.View style={{ flex: 1 }}>
              <react_native_1.Text style={styles.modeLabel}>{currentMode.label}</react_native_1.Text>
              <react_native_1.Text style={styles.modeDesc}>{currentMode.description}</react_native_1.Text>
            </react_native_1.View>
            <lucide_react_native_1.ChevronRight size={16} color={tokens_1.color.faint}/>
          </react_native_1.Pressable>
        </react_native_1.View>

        {/* Per-feature overrides */}
        <react_native_1.View style={styles.section}>
          <react_native_1.Text style={styles.sectionLabel}>FEATURE VISIBILITY</react_native_1.Text>
          <react_native_1.Text style={styles.sectionNote}>Override default visibility for specific features</react_native_1.Text>

          <react_native_1.Pressable style={styles.row} onPress={function () { return setShowPulseSheet(true); }}>
            <react_native_1.View style={styles.rowContent}>
              <react_native_1.Text style={styles.rowTitle}>Pulse posts</react_native_1.Text>
              <react_native_1.Text style={styles.rowDesc}>
                {prefs.pulseVisibility ? VISIBILITY_LABELS[prefs.pulseVisibility] : "Default (".concat(VISIBILITY_LABELS['city_only'], ")")}
              </react_native_1.Text>
            </react_native_1.View>
            <lucide_react_native_1.ChevronRight size={16} color={tokens_1.color.faint}/>
          </react_native_1.Pressable>

          <react_native_1.View style={styles.divider}/>

          <react_native_1.Pressable style={styles.row} onPress={function () { return setShowDiscoverySheet(true); }}>
            <react_native_1.View style={styles.rowContent}>
              <react_native_1.Text style={styles.rowTitle}>Discovery</react_native_1.Text>
              <react_native_1.Text style={styles.rowDesc}>
                {prefs.discoveryVisibility ? VISIBILITY_LABELS[prefs.discoveryVisibility] : 'Default (City only)'}
              </react_native_1.Text>
            </react_native_1.View>
            <lucide_react_native_1.ChevronRight size={16} color={tokens_1.color.faint}/>
          </react_native_1.Pressable>
        </react_native_1.View>

        {/* Safety features */}
        <react_native_1.View style={styles.section}>
          <react_native_1.Text style={styles.sectionLabel}>SAFETY</react_native_1.Text>

          <react_native_1.View style={styles.row}>
            <react_native_1.View style={styles.rowContent}>
              <react_native_1.Text style={styles.rowTitle}>Safe Return</react_native_1.Text>
              <react_native_1.Text style={styles.rowDesc}>Enable location-based safety sessions for meetups</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.Switch value={prefs.safeReturnEnabled} onValueChange={function (v) { return save({ safeReturnEnabled: v }); }} trackColor={{ true: tokens_1.color.signal }}/>
          </react_native_1.View>

          <react_native_1.View style={styles.divider}/>

          <react_native_1.View style={styles.row}>
            <react_native_1.View style={styles.rowContent}>
              <react_native_1.Text style={styles.rowTitle}>Privacy blur near stays</react_native_1.Text>
              <react_native_1.Text style={styles.rowDesc}>Auto-cap posts near your accommodation to neighborhood only</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.Switch value={prefs.hotelBlurEnabled} onValueChange={function (v) { return save({ hotelBlurEnabled: v }); }} trackColor={{ true: tokens_1.color.signal }}/>
          </react_native_1.View>
        </react_native_1.View>

        {/* Trusted circle (stub) */}
        <react_native_1.View style={styles.section}>
          <react_native_1.Text style={styles.sectionLabel}>TRUSTED CIRCLE</react_native_1.Text>
          <react_native_1.View style={styles.row}>
            <react_native_1.View style={styles.rowContent}>
              <react_native_1.Text style={styles.rowTitle}>Live share with trusted circle</react_native_1.Text>
              <react_native_1.Text style={styles.rowDesc}>Share your approximate location with your trusted circle members</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.Switch value={prefs.trustedCircleShare} onValueChange={function (v) { return save({ trustedCircleShare: v }); }} trackColor={{ true: tokens_1.color.signal }}/>
          </react_native_1.View>
          {prefs.trustedCircleShare && (<react_native_1.Text style={styles.comingSoon}>Trusted circle management coming soon</react_native_1.Text>)}
        </react_native_1.View>

        <react_native_1.Text style={styles.privacyNote}>
          Your exact GPS coordinates are never shared publicly. All public surfaces show only city, neighborhood, or approximate distance.
        </react_native_1.Text>
      </react_native_1.ScrollView>

      {/* Mode sheet */}
      {showModeSheet && (<OptionSheet title="Location Mode" options={ORDERED_MODES.map(function (m) { return ({
                key: m,
                label: MODE_INFO[m].label,
                desc: MODE_INFO[m].description,
                selected: prefs.locationMode === m,
            }); })} onSelect={function (k) { save({ locationMode: k }); setShowModeSheet(false); }} onClose={function () { return setShowModeSheet(false); }}/>)}

      {/* Pulse visibility sheet */}
      {showPulseSheet && (<OptionSheet title="Pulse Visibility" options={__spreadArray([
                { key: '__inherit__', label: 'Default (follow mode)', desc: 'Use your location mode default', selected: !prefs.pulseVisibility }
            ], ORDERED_VISIBILITY.map(function (v) { return ({
                key: v,
                label: VISIBILITY_LABELS[v],
                desc: VISIBILITY_DESCRIPTIONS[v],
                selected: prefs.pulseVisibility === v,
            }); }), true)} onSelect={function (k) {
                save({ pulseVisibility: k === '__inherit__' ? null : k });
                setShowPulseSheet(false);
            }} onClose={function () { return setShowPulseSheet(false); }}/>)}

      {/* Discovery visibility sheet */}
      {showDiscoverySheet && (<OptionSheet title="Discovery Visibility" options={__spreadArray([
                { key: '__inherit__', label: 'Default', desc: 'City only for discovery', selected: !prefs.discoveryVisibility }
            ], ORDERED_VISIBILITY.slice(0, 3).map(function (v) { return ({
                key: v,
                label: VISIBILITY_LABELS[v],
                desc: VISIBILITY_DESCRIPTIONS[v],
                selected: prefs.discoveryVisibility === v,
            }); }), true)} onSelect={function (k) {
                save({ discoveryVisibility: k === '__inherit__' ? null : k });
                setShowDiscoverySheet(false);
            }} onClose={function () { return setShowDiscoverySheet(false); }}/>)}
    </react_native_1.View>);
}
function OptionSheet(_a) {
    var title = _a.title, options = _a.options, onSelect = _a.onSelect, onClose = _a.onClose;
    return (<react_native_1.Pressable style={styles.sheetOverlay} onPress={onClose}>
      <react_native_1.Pressable style={styles.sheet} onPress={function (e) { return e.stopPropagation(); }}>
        <react_native_1.Text style={styles.sheetTitle}>{title}</react_native_1.Text>
        {options.map(function (opt, i) { return (<react_1.default.Fragment key={opt.key}>
            {i > 0 && <react_native_1.View style={styles.divider}/>}
            <react_native_1.Pressable style={styles.sheetRow} onPress={function () { return onSelect(opt.key); }}>
              <react_native_1.View style={styles.rowContent}>
                <react_native_1.Text style={[styles.sheetOptionLabel, opt.selected && styles.sheetOptionSelected]}>
                  {opt.label}
                </react_native_1.Text>
                <react_native_1.Text style={styles.rowDesc}>{opt.desc}</react_native_1.Text>
              </react_native_1.View>
              {opt.selected && (<react_native_1.View style={styles.checkDot}/>)}
            </react_native_1.Pressable>
          </react_1.default.Fragment>); })}
      </react_native_1.Pressable>
    </react_native_1.Pressable>);
}
var VISIBILITY_DESCRIPTIONS = {
    city_only: 'Only city name is shown on posts.',
    neighborhood: 'Neighborhood label shown (no exact address).',
    venue_tagged: 'Venue name shown if tagged.',
    exact_hidden: 'Location type shown but no specific area.',
    no_location: 'No location info on posts.',
};
// ── Styles ────────────────────────────────────────────────────────────────────
var styles = react_native_1.StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: tokens_1.color.paper,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
        gap: tokens_1.space.md,
    },
    backBtn: {
        padding: tokens_1.space.xs,
        marginLeft: -tokens_1.space.xs,
    },
    headerTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 18 }),
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    section: {
        marginTop: tokens_1.space.xl,
        paddingHorizontal: tokens_1.space.lg,
    },
    sectionLabel: {
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1,
        color: tokens_1.color.faint,
        marginBottom: tokens_1.space.sm,
    },
    sectionNote: {
        fontSize: 12,
        color: tokens_1.color.mute,
        marginBottom: tokens_1.space.md,
        marginTop: -tokens_1.space.xs,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: tokens_1.space.md,
        gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.md,
        paddingHorizontal: tokens_1.space.lg,
    },
    rowContent: {
        flex: 1,
        gap: 2,
    },
    rowTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: tokens_1.color.ink,
    },
    rowDesc: {
        fontSize: 12,
        color: tokens_1.color.mute,
        lineHeight: 16,
    },
    divider: {
        height: 1,
        backgroundColor: tokens_1.color.haze,
        marginHorizontal: tokens_1.space.lg,
    },
    modeCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.md,
        padding: tokens_1.space.lg,
        gap: tokens_1.space.md,
    },
    modeIconWrap: {
        width: 36,
        height: 36,
        borderRadius: tokens_1.radius.sm,
        backgroundColor: tokens_1.color.signal + '14',
        alignItems: 'center',
        justifyContent: 'center',
    },
    modeIconOff: {
        backgroundColor: tokens_1.color.haze,
    },
    modeLabel: {
        fontSize: 15,
        fontWeight: '700',
        color: tokens_1.color.ink,
    },
    modeDesc: {
        fontSize: 12,
        color: tokens_1.color.mute,
        marginTop: 2,
        lineHeight: 16,
    },
    comingSoon: {
        fontSize: 11,
        color: tokens_1.color.faint,
        fontStyle: 'italic',
        marginTop: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.sm,
    },
    privacyNote: {
        fontSize: 11,
        color: tokens_1.color.faint,
        lineHeight: 15,
        marginHorizontal: tokens_1.space.xl,
        marginTop: tokens_1.space.xl,
        textAlign: 'center',
    },
    sheetOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: tokens_1.color.paperRaised,
        borderTopLeftRadius: tokens_1.radius.lg,
        borderTopRightRadius: tokens_1.radius.lg,
        paddingTop: tokens_1.space.lg,
        paddingBottom: tokens_1.space.xxxl,
        paddingHorizontal: tokens_1.space.lg,
    },
    sheetTitle: {
        fontSize: 15,
        fontWeight: '700',
        color: tokens_1.color.ink,
        marginBottom: tokens_1.space.md,
    },
    sheetRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: tokens_1.space.md,
        gap: tokens_1.space.md,
    },
    sheetOptionLabel: {
        fontSize: 14,
        fontWeight: '600',
        color: tokens_1.color.ink,
    },
    sheetOptionSelected: {
        color: tokens_1.color.signal,
    },
    checkDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: tokens_1.color.signal,
    },
});
