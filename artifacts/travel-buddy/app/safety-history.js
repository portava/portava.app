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
exports.default = SafetyHistoryScreen;
/**
 * Safety History screen — private, shows the user's own Safe Return sessions.
 * Accessible from Settings → Safety → Safe Return history.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var tokens_1 = require("../src/theme/tokens");
var safeReturn_1 = require("../src/services/safeReturn");
var SessionContext_1 = require("../src/context/SessionContext");
// ── Status display map ────────────────────────────────────────────────────────
var STATUS_ICON = {
    safe: lucide_react_native_1.CheckCircle,
    active: lucide_react_native_1.Clock,
    missed: lucide_react_native_1.AlertCircle,
    cancelled: lucide_react_native_1.X,
    pending: lucide_react_native_1.Clock,
};
var STATUS_COLOR = {
    safe: tokens_1.color.success,
    active: tokens_1.color.deep,
    missed: '#F5A623',
    cancelled: tokens_1.color.mute,
    pending: tokens_1.color.mute,
};
var STATUS_LABEL = {
    safe: 'Returned safe',
    active: 'Active',
    missed: 'Missed check-in',
    cancelled: 'Cancelled',
    pending: 'Pending',
};
var ESCALATION_LABEL = {
    0: 'Notify me only',
    1: 'Trusted Circle alert',
    2: 'TC alert + location share',
    3: 'Full escalation',
};
// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(iso) {
    return new Date(iso).toLocaleDateString([], {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    });
}
function formatTime(iso) {
    if (!iso)
        return null;
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDuration(session) {
    if (!session.timerStartAt || !session.closedAt)
        return null;
    var ms = new Date(session.closedAt).getTime() - new Date(session.timerStartAt).getTime();
    var m = Math.floor(ms / 60000);
    if (m < 60)
        return "".concat(m, "m");
    return "".concat(Math.floor(m / 60), "h ").concat(m % 60, "m");
}
// ── Session row ───────────────────────────────────────────────────────────────
function EventBadges(_a) {
    var events = _a.events;
    var items = [
        { label: 'Alerts sent', value: events.alertsSent, color: '#F5A623' },
        { label: 'Missed', value: events.missedCount, color: tokens_1.color.signal },
        { label: 'Live share', value: events.liveShareStarted, color: tokens_1.color.deep },
    ].filter(function (i) { return i.value > 0; });
    if (items.length === 0)
        return null;
    return (<react_native_1.View style={styles.eventBadgeRow}>
      {items.map(function (item) { return (<react_native_1.View key={item.label} style={[styles.eventBadge, { borderColor: item.color + '40' }]}>
          <react_native_1.Text style={[styles.eventBadgeCount, { color: item.color }]}>{item.value}</react_native_1.Text>
          <react_native_1.Text style={styles.eventBadgeLabel}>{item.label}</react_native_1.Text>
        </react_native_1.View>); })}
    </react_native_1.View>);
}
function SessionRow(_a) {
    var _b, _c, _d, _e;
    var session = _a.session;
    var _f = (0, react_1.useState)(false), expanded = _f[0], setExpanded = _f[1];
    var Icon = (_b = STATUS_ICON[session.status]) !== null && _b !== void 0 ? _b : lucide_react_native_1.Clock;
    var iconColor = (_c = STATUS_COLOR[session.status]) !== null && _c !== void 0 ? _c : tokens_1.color.mute;
    var statusLabel = (_d = STATUS_LABEL[session.status]) !== null && _d !== void 0 ? _d : session.status;
    var duration = formatDuration(session);
    return (<react_native_1.Pressable style={styles.row} onPress={function () { return setExpanded(function (v) { return !v; }); }}>
      <react_native_1.View style={styles.rowHeader}>
        <react_native_1.View style={[styles.iconWrap, { backgroundColor: iconColor + '18' }]}>
          <Icon size={16} color={iconColor}/>
        </react_native_1.View>
        <react_native_1.View style={{ flex: 1 }}>
          <react_native_1.Text style={[styles.statusLabel, { color: iconColor }]}>{statusLabel}</react_native_1.Text>
          <react_native_1.Text style={styles.dateLabel}>{formatDate(session.createdAt)}</react_native_1.Text>
        </react_native_1.View>
        {duration ? <react_native_1.Text style={styles.duration}>{duration}</react_native_1.Text> : null}
      </react_native_1.View>

      {session.events && (<EventBadges events={session.events}/>)}

      {expanded && (<react_native_1.View style={styles.detail}>
          {session.timerStartAt && (<react_native_1.Text style={styles.detailLine}>
              Started: {formatTime(session.timerStartAt)}
              {session.closedAt ? "  \u2192  Ended: ".concat(formatTime(session.closedAt)) : ''}
            </react_native_1.Text>)}
          <react_native_1.Text style={styles.detailLine}>
            Escalation: {(_e = ESCALATION_LABEL[session.escalationLevel]) !== null && _e !== void 0 ? _e : "Level ".concat(session.escalationLevel)}
          </react_native_1.Text>
          {session.trustedCircleEnabled && (<react_native_1.Text style={styles.detailLine}>✓ Trusted Circle alerts enabled</react_native_1.Text>)}
          {session.liveShareEnabled && (<react_native_1.Text style={styles.detailLine}>✓ Approximate location sharing enabled</react_native_1.Text>)}
          {session.notifyHostEnabled && (<react_native_1.Text style={styles.detailLine}>✓ Trip host notifications enabled</react_native_1.Text>)}
          {session.triggerReason && (<react_native_1.Text style={styles.detailLine}>Reason: {session.triggerReason}</react_native_1.Text>)}
          {session.emergencyNote && (<react_native_1.Text style={styles.detailLine}>Note: {session.emergencyNote}</react_native_1.Text>)}
          {session.events && session.events.alertsSent === 0 && session.events.missedCount === 0 && session.events.liveShareStarted === 0 && (<react_native_1.Text style={styles.detailLine}>No alerts or escalations recorded</react_native_1.Text>)}
        </react_native_1.View>)}
    </react_native_1.Pressable>);
}
// ── Screen ────────────────────────────────────────────────────────────────────
function SafetyHistoryScreen() {
    var _this = this;
    var _a = (0, SessionContext_1.useSession)(), isAuthed = _a.isAuthed, configured = _a.configured;
    var _b = (0, react_1.useState)([]), sessions = _b[0], setSessions = _b[1];
    var _c = (0, react_1.useState)(true), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)(false), refreshing = _d[0], setRefreshing = _d[1];
    var _e = (0, react_1.useState)(true), featureEnabled = _e[0], setFeatureEnabled = _e[1];
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, safeReturn_1.getHistory)(50)];
                case 1:
                    result = _a.sent();
                    setSessions(result.sessions);
                    if (result.featureEnabled === false)
                        setFeatureEnabled(false);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () {
        if (!(configured && isAuthed)) {
            setLoading(false);
            return;
        }
        load().then(function () { return setLoading(false); });
    }, [configured, isAuthed, load]);
    var onRefresh = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setRefreshing(true);
                    return [4 /*yield*/, load()];
                case 1:
                    _a.sent();
                    setRefreshing(false);
                    return [2 /*return*/];
            }
        });
    }); }, [load]);
    return (<react_native_1.View style={styles.root}>
      <ScreenHeader_1.ScreenHeader title="Safe Return History" back/>

      {loading ? (<react_native_1.View style={styles.center}>
          <react_native_1.ActivityIndicator color={tokens_1.color.deep}/>
        </react_native_1.View>) : !featureEnabled ? (<react_native_1.View style={styles.center}>
          <lucide_react_native_1.Shield size={36} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.emptyTitle}>Safe Return isn't enabled yet</react_native_1.Text>
          <react_native_1.Text style={styles.emptyBody}>
            Safe Return will be available in a future update. Keep an eye on your notifications.
          </react_native_1.Text>
        </react_native_1.View>) : sessions.length === 0 ? (<react_native_1.View style={styles.center}>
          <lucide_react_native_1.Shield size={36} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.emptyTitle}>No Safe Return history</react_native_1.Text>
          <react_native_1.Text style={styles.emptyBody}>
            When you use Safe Return on a trip activity, your sessions will appear here — privately, only visible to you.
          </react_native_1.Text>
        </react_native_1.View>) : (<react_native_1.ScrollView contentContainerStyle={styles.list} refreshControl={<react_native_1.RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={tokens_1.color.deep}/>} showsVerticalScrollIndicator={false}>
          <react_native_1.Text style={styles.privacy}>
            🔒 Only you can see this history. Sessions older than 90 days are automatically removed.
          </react_native_1.Text>

          {/* Summary chips */}
          <react_native_1.View style={styles.summaryRow}>
            {['safe', 'missed', 'cancelled'].map(function (status) {
                var count = sessions.filter(function (s) { return s.status === status; }).length;
                if (count === 0)
                    return null;
                return (<react_native_1.View key={status} style={[styles.summaryChip, { borderColor: STATUS_COLOR[status] + '40' }]}>
                  <react_native_1.Text style={[styles.summaryCount, { color: STATUS_COLOR[status] }]}>{count}</react_native_1.Text>
                  <react_native_1.Text style={styles.summaryLabel}>{STATUS_LABEL[status]}</react_native_1.Text>
                </react_native_1.View>);
            })}
          </react_native_1.View>

          {sessions.map(function (s) { return <SessionRow key={s.id} session={s}/>; })}
        </react_native_1.ScrollView>)}
    </react_native_1.View>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var styles = react_native_1.StyleSheet.create({
    root: { flex: 1, backgroundColor: tokens_1.color.paper },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: tokens_1.space.xl },
    emptyTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 16, marginTop: tokens_1.space.md, textAlign: 'center' }),
    emptyBody: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: tokens_1.space.sm }),
    list: { paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, gap: tokens_1.space.sm, paddingBottom: 40 },
    privacy: __assign(__assign({}, tokens_1.type.small), { color: '#2D6A4F', fontSize: 11, lineHeight: 17, backgroundColor: '#F0F7F4', borderRadius: tokens_1.radius.md, padding: tokens_1.space.md, marginBottom: tokens_1.space.sm }),
    summaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm, marginBottom: tokens_1.space.sm },
    summaryChip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        borderWidth: 1, borderRadius: tokens_1.radius.pill,
        paddingHorizontal: tokens_1.space.md, paddingVertical: 5,
        backgroundColor: tokens_1.color.paperRaised,
    },
    summaryCount: __assign(__assign({}, tokens_1.type.bodyStrong), { fontSize: 14 }),
    summaryLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    row: {
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md,
    },
    rowHeader: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    iconWrap: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
    statusLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { fontSize: 13 }),
    dateLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    duration: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    detail: { marginTop: tokens_1.space.md, paddingTop: tokens_1.space.md, borderTopWidth: 1, borderTopColor: tokens_1.color.haze, gap: 4 },
    detailLine: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, lineHeight: 18 }),
    eventBadgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
    eventBadge: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        borderWidth: 1, borderRadius: tokens_1.radius.pill,
        paddingHorizontal: 8, paddingVertical: 3,
        backgroundColor: tokens_1.color.paper,
    },
    eventBadgeCount: __assign(__assign({}, tokens_1.type.bodyStrong), { fontSize: 12 }),
    eventBadgeLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
});
