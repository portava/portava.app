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
exports.default = NotificationSettingsScreen;
/**
 * Notification Settings screen
 *
 * Sections:
 *   1. Global toggles: push, email, safety explanation
 *   2. Per-category toggles: in-app / push / digest per category
 *   3. Behavior: quiet hours, message previews, location-sensitive previews
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../src/theme/tokens");
var useNotifications_1 = require("../../src/hooks/useNotifications");
var CATEGORY_LABELS = {
    plans: { label: 'Plans', icon: '📋', description: 'Plan items, approvals, check-ins' },
    trips: { label: 'Trips', icon: '✈️', description: 'Invites, membership changes, reminders' },
    telegraph: { label: 'Telegraph', icon: '💬', description: 'Messages and message requests' },
    safe_return: { label: 'Safe Return', icon: '🛡️', description: 'Safety check-ins and alerts' },
    location: { label: 'Location', icon: '📍', description: 'Arrivals, nearby travelers, live share' },
    trip_crew: { label: 'Trip Crew', icon: '👥', description: 'Friend requests, circle invites, nudges' },
    compass: { label: 'Compass AI', icon: '🧭', description: 'Recommendations, warnings, daily briefs' },
    pulse: { label: 'City Pulse', icon: '🌍', description: 'Posts, likes, comments, highlights' },
    passport: { label: 'Passport', icon: '📘', description: 'Stamps, milestones, profile views' },
    hidden_gems: { label: 'Hidden Gems', icon: '💎', description: 'Place saves, approvals, nearby gems' },
    trust: { label: 'Trust', icon: '⭐', description: 'Reliability score changes, reports' },
    airport: { label: 'Airport Mode', icon: '🏔️', description: 'Layover tips, nearby travelers' },
    admin: { label: 'Admin', icon: '⚠️', description: 'Account notices and moderation actions' },
};
var CATEGORIES = [
    'plans', 'trips', 'telegraph', 'safe_return', 'location', 'trip_crew',
    'compass', 'pulse', 'passport', 'hidden_gems', 'trust', 'airport', 'admin',
];
function SectionHeader(_a) {
    var title = _a.title;
    return <react_native_1.Text style={styles.sectionHeader}>{title}</react_native_1.Text>;
}
function Row(_a) {
    var children = _a.children;
    return <react_native_1.View style={styles.row}>{children}</react_native_1.View>;
}
function ToggleRow(_a) {
    var label = _a.label, subtitle = _a.subtitle, value = _a.value, onValueChange = _a.onValueChange, disabled = _a.disabled;
    return (<Row>
      <react_native_1.View style={{ flex: 1, gap: 2 }}>
        <react_native_1.Text style={[styles.rowLabel, disabled && { color: tokens_1.color.faint }]}>{label}</react_native_1.Text>
        {subtitle && <react_native_1.Text style={styles.rowSubtitle}>{subtitle}</react_native_1.Text>}
      </react_native_1.View>
      <react_native_1.Switch value={value} onValueChange={onValueChange} disabled={disabled} trackColor={{ false: tokens_1.color.haze, true: tokens_1.color.deep }} thumbColor={tokens_1.color.paperRaised}/>
    </Row>);
}
function NotificationSettingsScreen() {
    var _this = this;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _a = (0, useNotifications_1.useNotificationPreferences)(), preferences = _a.preferences, categoryPreferences = _a.categoryPreferences, loading = _a.loading, saving = _a.saving, reload = _a.reload, save = _a.save;
    var _b = (0, react_1.useState)(null), expandedCategory = _b[0], setExpandedCategory = _b[1];
    var getCatPref = (0, react_1.useCallback)(function (cat) {
        return categoryPreferences.find(function (c) { return c.category === cat; });
    }, [categoryPreferences]);
    var handleGlobalToggle = (0, react_1.useCallback)(function (key, value) { return __awaiter(_this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, save((_a = {}, _a[key] = value, _a))];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); }, [save]);
    var handleCategoryToggle = (0, react_1.useCallback)(function (cat, key, value) { return __awaiter(_this, void 0, void 0, function () {
        var current;
        var _a;
        var _b, _c, _d, _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    current = getCatPref(cat);
                    return [4 /*yield*/, save({
                            categoryPreferences: [(_a = {
                                        category: cat,
                                        inAppEnabled: (_b = current === null || current === void 0 ? void 0 : current.inAppEnabled) !== null && _b !== void 0 ? _b : true,
                                        pushEnabled: (_c = current === null || current === void 0 ? void 0 : current.pushEnabled) !== null && _c !== void 0 ? _c : true,
                                        emailEnabled: (_d = current === null || current === void 0 ? void 0 : current.emailEnabled) !== null && _d !== void 0 ? _d : false,
                                        digestEnabled: (_e = current === null || current === void 0 ? void 0 : current.digestEnabled) !== null && _e !== void 0 ? _e : false
                                    },
                                    _a[key] = value,
                                    _a)],
                        })];
                case 1:
                    _f.sent();
                    return [2 /*return*/];
            }
        });
    }); }, [getCatPref, save]);
    if (loading) {
        return (<react_native_1.View style={[styles.container, { paddingTop: insets.top }]}>
        <react_native_1.View style={styles.center}>
          <react_native_1.ActivityIndicator size="large" color={tokens_1.color.signal}/>
        </react_native_1.View>
      </react_native_1.View>);
    }
    var prefs = preferences;
    if (!prefs)
        return null;
    return (<react_native_1.View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <react_native_1.View style={styles.header}>
        <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} hitSlop={8} style={styles.backBtn}>
          <lucide_react_native_1.ChevronLeft size={24} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>
        <react_native_1.Text style={styles.headerTitle}>Notifications</react_native_1.Text>
        {saving && <react_native_1.ActivityIndicator size="small" color={tokens_1.color.mute} style={{ marginLeft: tokens_1.space.md }}/>}
      </react_native_1.View>

      <react_native_1.ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + tokens_1.space.xxl }]} showsVerticalScrollIndicator={false}>
        {/* ── Global toggles ── */}
        <SectionHeader title="Delivery"/>
        <react_native_1.View style={styles.card}>
          <ToggleRow label="Push notifications" subtitle="Receive alerts on your device" value={prefs.pushEnabled} onValueChange={function (v) { return handleGlobalToggle('pushEnabled', v); }}/>
          <react_native_1.View style={styles.divider}/>
          <ToggleRow label="In-app notifications" subtitle="Show in the Activity Center" value={prefs.inAppEnabled} onValueChange={function (v) { return handleGlobalToggle('inAppEnabled', v); }}/>
          <react_native_1.View style={styles.divider}/>
          <ToggleRow label="Daily digests" subtitle="A once-daily summary instead of individual alerts" value={prefs.digestsEnabled} onValueChange={function (v) { return handleGlobalToggle('digestsEnabled', v); }}/>
        </react_native_1.View>

        {/* ── Safety override explanation ── */}
        <react_native_1.View style={styles.safetyCard}>
          <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm }}>
            <lucide_react_native_1.Shield size={16} color={tokens_1.color.deep}/>
            <react_native_1.Text style={styles.safetyTitle}>Safety override</react_native_1.Text>
          </react_native_1.View>
          <react_native_1.Text style={styles.safetyBody}>
            Urgent notifications — like Safe Return alerts and account notices — are always delivered,
            even when push is off. This keeps you reachable in situations that matter.
          </react_native_1.Text>
          <react_native_1.View style={[styles.divider, { marginVertical: tokens_1.space.md }]}/>
          <ToggleRow label="Safety override enabled" value={prefs.safetyOverride} onValueChange={function (v) { return handleGlobalToggle('safetyOverride', v); }}/>
        </react_native_1.View>

        {/* ── Quiet hours ── */}
        <SectionHeader title="Quiet Hours"/>
        <react_native_1.View style={styles.card}>
          <ToggleRow label="Enable quiet hours" subtitle="Suppress push during your quiet window" value={prefs.quietHoursEnabled} onValueChange={function (v) { return handleGlobalToggle('quietHoursEnabled', v); }}/>
          {prefs.quietHoursEnabled && (<>
              <react_native_1.View style={styles.divider}/>
              <Row>
                <react_native_1.Text style={styles.rowLabel}>Start</react_native_1.Text>
                <react_native_1.Text style={styles.quietTimeDisplay}>{prefs.quietStart}</react_native_1.Text>
              </Row>
              <react_native_1.View style={styles.divider}/>
              <Row>
                <react_native_1.Text style={styles.rowLabel}>End</react_native_1.Text>
                <react_native_1.Text style={styles.quietTimeDisplay}>{prefs.quietEnd}</react_native_1.Text>
              </Row>
            </>)}
        </react_native_1.View>

        {/* ── Previews ── */}
        <SectionHeader title="Previews"/>
        <react_native_1.View style={styles.card}>
          <ToggleRow label="Message previews" subtitle="Show sender name and preview text in push" value={prefs.messagePreviews} onValueChange={function (v) { return handleGlobalToggle('messagePreviews', v); }}/>
          <react_native_1.View style={styles.divider}/>
          <ToggleRow label="Location-sensitive previews" subtitle="Include location context in notifications" value={prefs.locationPreviews} onValueChange={function (v) { return handleGlobalToggle('locationPreviews', v); }}/>
        </react_native_1.View>

        {/* ── Per-category ── */}
        <SectionHeader title="Categories"/>
        <react_native_1.View style={styles.card}>
          {CATEGORIES.map(function (cat, idx) {
            var _a, _b, _c;
            var info = CATEGORY_LABELS[cat];
            var catPref = getCatPref(cat);
            var isExpanded = expandedCategory === cat;
            return (<react_1.default.Fragment key={cat}>
                {idx > 0 && <react_native_1.View style={styles.divider}/>}
                <react_native_1.Pressable style={styles.categoryRow} onPress={function () { return setExpandedCategory(isExpanded ? null : cat); }}>
                  <react_native_1.Text style={styles.categoryIcon}>{info.icon}</react_native_1.Text>
                  <react_native_1.View style={{ flex: 1, gap: 2 }}>
                    <react_native_1.Text style={styles.categoryLabel}>{info.label}</react_native_1.Text>
                    <react_native_1.Text style={styles.categoryDesc}>{info.description}</react_native_1.Text>
                  </react_native_1.View>
                  <react_native_1.Text style={styles.expandChevron}>{isExpanded ? '▲' : '▼'}</react_native_1.Text>
                </react_native_1.Pressable>

                {isExpanded && (<react_native_1.View style={styles.categoryToggles}>
                    <react_native_1.View style={styles.miniToggleRow}>
                      <react_native_1.Text style={styles.miniToggleLabel}>In-app</react_native_1.Text>
                      <react_native_1.Switch value={(_a = catPref === null || catPref === void 0 ? void 0 : catPref.inAppEnabled) !== null && _a !== void 0 ? _a : true} onValueChange={function (v) { return handleCategoryToggle(cat, 'inAppEnabled', v); }} trackColor={{ false: tokens_1.color.haze, true: tokens_1.color.deep }} thumbColor={tokens_1.color.paperRaised}/>
                    </react_native_1.View>
                    <react_native_1.View style={styles.miniToggleRow}>
                      <react_native_1.Text style={styles.miniToggleLabel}>Push</react_native_1.Text>
                      <react_native_1.Switch value={(_b = catPref === null || catPref === void 0 ? void 0 : catPref.pushEnabled) !== null && _b !== void 0 ? _b : true} onValueChange={function (v) { return handleCategoryToggle(cat, 'pushEnabled', v); }} trackColor={{ false: tokens_1.color.haze, true: tokens_1.color.deep }} thumbColor={tokens_1.color.paperRaised} disabled={!prefs.pushEnabled}/>
                    </react_native_1.View>
                    <react_native_1.View style={styles.miniToggleRow}>
                      <react_native_1.Text style={styles.miniToggleLabel}>Digest</react_native_1.Text>
                      <react_native_1.Switch value={(_c = catPref === null || catPref === void 0 ? void 0 : catPref.digestEnabled) !== null && _c !== void 0 ? _c : false} onValueChange={function (v) { return handleCategoryToggle(cat, 'digestEnabled', v); }} trackColor={{ false: tokens_1.color.haze, true: tokens_1.color.deep }} thumbColor={tokens_1.color.paperRaised} disabled={!prefs.digestsEnabled}/>
                    </react_native_1.View>
                  </react_native_1.View>)}
              </react_1.default.Fragment>);
        })}
        </react_native_1.View>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: tokens_1.color.paper,
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    backBtn: {
        marginRight: tokens_1.space.md,
        padding: tokens_1.space.xs,
    },
    headerTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, flex: 1 }),
    scroll: {
        padding: tokens_1.space.lg,
        gap: tokens_1.space.md,
    },
    sectionHeader: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.mute, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: tokens_1.space.xs, marginTop: tokens_1.space.md }),
    card: {
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        overflow: 'hidden',
    },
    safetyCard: {
        backgroundColor: '#F0F9FF',
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
        borderColor: '#BAE6FD',
        padding: tokens_1.space.lg,
        marginBottom: tokens_1.space.md,
    },
    safetyTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.deep }),
    safetyBody: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, lineHeight: 18, marginTop: tokens_1.space.sm }),
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
        gap: tokens_1.space.md,
    },
    rowLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '500' }),
    rowSubtitle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    divider: {
        height: 1,
        backgroundColor: tokens_1.color.haze,
        marginLeft: tokens_1.space.lg,
    },
    quietTimeDisplay: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.deep, fontFamily: 'Courier' }),
    categoryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
    },
    categoryIcon: {
        fontSize: 20,
        lineHeight: 24,
    },
    categoryLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    categoryDesc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    expandChevron: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint }),
    categoryToggles: {
        backgroundColor: tokens_1.color.paper,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.sm,
        gap: tokens_1.space.xs,
        borderTopWidth: 1,
        borderTopColor: tokens_1.color.haze,
    },
    miniToggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: tokens_1.space.xs,
    },
    miniToggleLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '500' }),
});
