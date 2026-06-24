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
exports.HostAttendanceDashboard = HostAttendanceDashboard;
/**
 * HostAttendanceDashboard — trip owner view of check-in attendance.
 * Shows totals, per-attendee status text, and manual override control.
 * Never shows map pins or GPS coordinates.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
var geofence_1 = require("../../services/geofence");
// ── Status config ─────────────────────────────────────────────────────────────
var STATUS_CONFIG = {
    not_checked_in: { label: 'Not checked in', color: tokens_1.color.mute, bg: tokens_1.color.haze },
    on_the_way: { label: 'On the way', color: '#B07000', bg: '#FFF8E7' },
    nearby: { label: 'Nearby', color: tokens_1.color.deep, bg: '#E2EDF0' },
    arrived: { label: 'Arrived ✓', color: tokens_1.color.success, bg: '#E3F1EA' },
    late: { label: 'Late arrival', color: '#B07000', bg: '#FFF8E7' },
    no_show: { label: 'No-show', color: tokens_1.color.signal, bg: '#FDEAEA' },
    left: { label: 'Left', color: tokens_1.color.mute, bg: tokens_1.color.haze },
};
var OVERRIDE_OPTIONS = ['arrived', 'late', 'no_show', 'on_the_way', 'left', 'not_checked_in'];
// ── Attendee row ──────────────────────────────────────────────────────────────
function AttendeeRow(_a) {
    var _this = this;
    var _b;
    var tripId = _a.tripId, attendee = _a.attendee, onOverridden = _a.onOverridden;
    var _c = (0, react_1.useState)(false), overrideOpen = _c[0], setOverrideOpen = _c[1];
    var _d = (0, react_1.useState)(false), submitting = _d[0], setSubmitting = _d[1];
    var cfg = (_b = STATUS_CONFIG[attendee.status]) !== null && _b !== void 0 ? _b : STATUS_CONFIG.not_checked_in;
    var handleOverride = function (newStatus) {
        react_native_1.Alert.alert('Override attendance', "Set ".concat(attendee.name || attendee.handle, " to \"").concat(STATUS_CONFIG[newStatus].label, "\"?"), [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Override',
                onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                    var e_1;
                    var _a;
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                setSubmitting(true);
                                _b.label = 1;
                            case 1:
                                _b.trys.push([1, 3, 4, 5]);
                                return [4 /*yield*/, (0, geofence_1.overrideAttendance)(tripId, attendee.userId, newStatus)];
                            case 2:
                                _b.sent();
                                onOverridden(attendee.userId, newStatus);
                                setOverrideOpen(false);
                                return [3 /*break*/, 5];
                            case 3:
                                e_1 = _b.sent();
                                react_native_1.Alert.alert('Error', (_a = e_1.message) !== null && _a !== void 0 ? _a : 'Override failed');
                                return [3 /*break*/, 5];
                            case 4:
                                setSubmitting(false);
                                return [7 /*endfinally*/];
                            case 5: return [2 /*return*/];
                        }
                    });
                }); },
            },
        ]);
    };
    return (<react_native_1.View style={ar.wrap}>
      <react_native_1.View style={ar.left}>
        <react_native_1.Text style={ar.name}>{attendee.name || attendee.handle}</react_native_1.Text>
        <react_native_1.Text style={ar.handle}>@{attendee.handle}</react_native_1.Text>
        {attendee.checkedInAt && (<react_native_1.Text style={ar.time}>
            {new Date(attendee.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </react_native_1.Text>)}
      </react_native_1.View>

      <react_native_1.View style={ar.right}>
        <react_native_1.View style={[ar.statusChip, { backgroundColor: cfg.bg }]}>
          <react_native_1.Text style={[ar.statusText, { color: cfg.color }]}>{cfg.label}</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.Pressable style={ar.overrideBtn} onPress={function () { return setOverrideOpen(!overrideOpen); }}>
          <lucide_react_native_1.ChevronDown size={13} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>
      </react_native_1.View>

      {overrideOpen && (<react_native_1.View style={ar.overrideList}>
          <react_native_1.Text style={ar.overrideHeading}>Override to:</react_native_1.Text>
          {OVERRIDE_OPTIONS.filter(function (s) { return s !== attendee.status; }).map(function (s) {
                var c = STATUS_CONFIG[s];
                return (<react_native_1.Pressable key={s} style={[ar.overrideOption, { backgroundColor: c.bg }]} onPress={function () { return handleOverride(s); }} disabled={submitting}>
                <react_native_1.Text style={[ar.overrideOptionText, { color: c.color }]}>{c.label}</react_native_1.Text>
              </react_native_1.Pressable>);
            })}
        </react_native_1.View>)}
    </react_native_1.View>);
}
// ── Main dashboard ────────────────────────────────────────────────────────────
function HostAttendanceDashboard(_a) {
    var _this = this;
    var tripId = _a.tripId, visible = _a.visible, onClose = _a.onClose;
    var _b = (0, react_1.useState)(null), data = _b[0], setData = _b[1];
    var _c = (0, react_1.useState)(false), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)([]), attendees = _d[0], setAttendees = _d[1];
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var result, e_2;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setLoading(true);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, 4, 5]);
                    return [4 /*yield*/, (0, geofence_1.getAttendance)(tripId)];
                case 2:
                    result = _b.sent();
                    if (result) {
                        setData(result);
                        setAttendees(result.attendees);
                    }
                    return [3 /*break*/, 5];
                case 3:
                    e_2 = _b.sent();
                    react_native_1.Alert.alert('Error', (_a = e_2.message) !== null && _a !== void 0 ? _a : 'Could not load attendance');
                    return [3 /*break*/, 5];
                case 4:
                    setLoading(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); }, [tripId]);
    (0, react_1.useEffect)(function () {
        if (visible)
            load();
    }, [visible, load]);
    var handleOverridden = function (userId, newStatus) {
        setAttendees(function (prev) {
            return prev.map(function (a) {
                var _a, _b;
                return a.userId === userId
                    ? __assign(__assign({}, a), { status: newStatus, statusLabel: (_b = (_a = STATUS_CONFIG[newStatus]) === null || _a === void 0 ? void 0 : _a.label) !== null && _b !== void 0 ? _b : newStatus }) : a;
            });
        });
    };
    if (!visible)
        return null;
    return (<react_native_1.Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <react_native_1.View style={d.overlay}/>
      <react_native_1.View style={d.sheet}>
        <react_native_1.View style={d.handle}/>

        <react_native_1.View style={d.header}>
          <lucide_react_native_1.Users size={18} color={tokens_1.color.deep}/>
          <react_native_1.Text style={d.headerTitle}>Attendance</react_native_1.Text>
          <react_native_1.Pressable onPress={onClose} hitSlop={8} style={{ marginLeft: 'auto' }}>
            <lucide_react_native_1.X size={20} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>
        </react_native_1.View>

        {loading && !data ? (<react_native_1.View style={d.center}>
            <react_native_1.ActivityIndicator color={tokens_1.color.deep}/>
            <react_native_1.Text style={d.loadingText}>Loading attendance…</react_native_1.Text>
          </react_native_1.View>) : !data ? (<react_native_1.View style={d.center}>
            <react_native_1.Text style={d.emptyText}>No geofence configured for this trip.</react_native_1.Text>
          </react_native_1.View>) : (<react_native_1.ScrollView contentContainerStyle={d.body} showsVerticalScrollIndicator={false}>

            {/* Totals */}
            <react_native_1.View style={d.totalsRow}>
              <TotalCard label="Accepted" value={data.totals.accepted} icon={<lucide_react_native_1.Users size={14} color={tokens_1.color.deep}/>}/>
              <TotalCard label="Arrived" value={data.totals.checkedIn} icon={<lucide_react_native_1.CheckCircle2 size={14} color={tokens_1.color.success}/>} color={tokens_1.color.success}/>
              <TotalCard label="No-show" value={data.totals.noShow} icon={<lucide_react_native_1.XCircle size={14} color={tokens_1.color.signal}/>} color={tokens_1.color.signal}/>
            </react_native_1.View>
            <react_native_1.View style={[d.totalsRow, { marginTop: 6 }]}>
              <TotalCard label="On the way" value={data.totals.onTheWay} icon={<lucide_react_native_1.Clock size={14} color="#B07000"/>} color="#B07000"/>
              <TotalCard label="Nearby" value={data.totals.nearby} icon={<lucide_react_native_1.Clock size={14} color={tokens_1.color.deep}/>} color={tokens_1.color.deep}/>
              <TotalCard label="Not checked in" value={data.totals.notCheckedIn} icon={<lucide_react_native_1.Clock size={14} color={tokens_1.color.mute}/>}/>
            </react_native_1.View>

            {/* Check-in window */}
            {(data.checkInWindowStart || data.checkInWindowEnd) && (<react_native_1.View style={d.windowCard}>
                <lucide_react_native_1.Clock size={13} color={tokens_1.color.mute}/>
                <react_native_1.Text style={d.windowText}>
                  Window:{' '}
                  {data.checkInWindowStart ? new Date(data.checkInWindowStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'open'}
                  {' → '}
                  {data.checkInWindowEnd ? new Date(data.checkInWindowEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'open'}
                </react_native_1.Text>
              </react_native_1.View>)}

            {/* Privacy note */}
            <react_native_1.View style={d.privacyNote}>
              <react_native_1.Text style={d.privacyText}>Attendance statuses only — no GPS coordinates or map pins.</react_native_1.Text>
            </react_native_1.View>

            {/* Attendee list */}
            <react_native_1.Text style={d.sectionLabel}>Attendees ({attendees.length})</react_native_1.Text>
            {attendees.length === 0 ? (<react_native_1.Text style={d.emptyText}>No accepted members yet.</react_native_1.Text>) : (attendees.map(function (a) { return (<AttendeeRow key={a.userId} tripId={tripId} attendee={a} onOverridden={handleOverridden}/>); }))}

            <react_native_1.Pressable style={d.refreshBtn} onPress={load} disabled={loading}>
              <react_native_1.Text style={d.refreshText}>{loading ? 'Refreshing…' : 'Refresh'}</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.ScrollView>)}
      </react_native_1.View>
    </react_native_1.Modal>);
}
// ── TotalCard ─────────────────────────────────────────────────────────────────
function TotalCard(_a) {
    var label = _a.label, value = _a.value, icon = _a.icon, textColor = _a.color;
    return (<react_native_1.View style={tc.card}>
      {icon}
      <react_native_1.Text style={[tc.value, textColor ? { color: textColor } : {}]}>{value}</react_native_1.Text>
      <react_native_1.Text style={tc.label}>{label}</react_native_1.Text>
    </react_native_1.View>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var d = react_native_1.StyleSheet.create({
    overlay: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(0,0,0,0.35)' }),
    sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '90%' },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    headerTitle: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 16 }),
    body: { paddingHorizontal: tokens_1.space.lg, paddingBottom: 48, gap: 10 },
    center: { padding: 40, alignItems: 'center', gap: 10 },
    loadingText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
    totalsRow: { flexDirection: 'row', gap: 8 },
    windowCard: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: tokens_1.color.haze, borderRadius: tokens_1.radius.sm, padding: 10 },
    windowText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    privacyNote: { backgroundColor: '#E2EDF0', borderRadius: tokens_1.radius.sm, padding: 10 },
    privacyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep }),
    sectionLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '700', marginTop: 4 }),
    refreshBtn: { alignItems: 'center', padding: 12, borderRadius: tokens_1.radius.md, backgroundColor: tokens_1.color.haze, marginTop: 8 },
    refreshText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
});
var tc = react_native_1.StyleSheet.create({
    card: { flex: 1, backgroundColor: '#F8F7F4', borderRadius: tokens_1.radius.md, padding: 12, alignItems: 'center', gap: 4 },
    value: __assign(__assign({}, tokens_1.type.title), { fontSize: 22, color: tokens_1.color.ink, fontWeight: '800' }),
    label: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center' }),
});
var ar = react_native_1.StyleSheet.create({
    wrap: { backgroundColor: '#F8F7F4', borderRadius: tokens_1.radius.md, padding: 12, gap: 8 },
    left: { flex: 1 },
    right: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    name: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    handle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    time: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint }),
    statusChip: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
    statusText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', fontSize: 11 }),
    overrideBtn: { padding: 4, backgroundColor: tokens_1.color.haze, borderRadius: 6 },
    overrideList: { gap: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: tokens_1.color.haze },
    overrideHeading: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    overrideOption: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
    overrideOptionText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '600' }),
});
