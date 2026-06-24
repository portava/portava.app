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
exports.default = TelegraphThread;
var react_1 = require("react");
var react_native_1 = require("react-native");
var async_storage_1 = require("@react-native-async-storage/async-storage");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var useMessaging_1 = require("../../src/hooks/useMessaging");
var useBackend_1 = require("../../src/hooks/useBackend");
var SessionContext_1 = require("../../src/context/SessionContext");
var tokens_1 = require("../../src/theme/tokens");
var TelegraphSuggestionTray_1 = require("../../src/components/TelegraphSuggestionTray");
var TelegraphSystemNotice_1 = require("../../src/components/TelegraphSystemNotice");
var MeetupCreationSheet_1 = require("../../src/components/MeetupCreationSheet");
var RsvpBar_1 = require("../../src/components/RsvpBar");
var supabase_1 = require("../../src/lib/supabase");
var meetups_1 = require("../../src/services/meetups");
var messaging_1 = require("../../src/services/messaging");
var DiscoveryCardMessage_1 = require("../../src/components/DiscoveryCardMessage");
var ThreadSafetySheet_1 = require("../../src/components/ThreadSafetySheet");
var TelegraphRecommendationCard_1 = require("../../src/components/TelegraphRecommendationCard");
var blocks_1 = require("../../src/services/blocks");
var intelligence_1 = require("../../src/services/intelligence");
var messaging_2 = require("../../src/services/messaging");
var TranslationSettingsSheet_1 = require("../../src/components/TranslationSettingsSheet");
var Haptics = require("expo-haptics");
var Clipboard = require("expo-clipboard");
function formatTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
/** "YYYY-MM-DD" or full ISO → "Fri Jun 27" */
function fmtDate(isoDate) {
    var d = new Date(isoDate.length === 10 ? isoDate + 'T12:00:00' : isoDate);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
/** Full ISO timestamp → "Fri Jun 27 · 7:00 PM" */
function fmtDateTime(iso) {
    var d = new Date(iso);
    var datePart = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    var timePart = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return "".concat(datePart, " \u00B7 ").concat(timePart);
}
var BLOCK_SHORT = {
    morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', late: 'Late night',
};
// ── Day label helpers ─────────────────────────────────────────────────────────
function formatDayLabel(isoDay) {
    var today = new Date().toISOString().slice(0, 10);
    var yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (isoDay === today)
        return 'Today';
    if (isoDay === yest)
        return 'Yesterday';
    return new Date(isoDay + 'T12:00:00').toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric',
    });
}
function DayDivider(_a) {
    var label = _a.label;
    return (<react_native_1.View style={dd.wrap}>
      <react_native_1.View style={dd.line}/>
      <react_native_1.Text style={dd.label}>{label}</react_native_1.Text>
      <react_native_1.View style={dd.line}/>
    </react_native_1.View>);
}
var dd = react_native_1.StyleSheet.create({
    wrap: { flexDirection: 'row', alignItems: 'center', marginVertical: 12, paddingHorizontal: 4 },
    line: { flex: 1, height: react_native_1.StyleSheet.hairlineWidth, backgroundColor: tokens_1.color.haze },
    label: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', fontSize: 10, color: tokens_1.color.mute, paddingHorizontal: 10, letterSpacing: 0.5 }),
});
// ── Long-press action sheet ───────────────────────────────────────────────────
var REPORT_MSG_REASONS = ['Spam', 'Harassment', 'Inappropriate content', 'Misinformation', 'Other'];
function LongPressActionSheet(_a) {
    var _this = this;
    var _b, _c;
    var message = _a.message, mine = _a.mine, onClose = _a.onClose, onDeleteForMe = _a.onDeleteForMe;
    var _d = (0, react_1.useState)(false), showReport = _d[0], setShowReport = _d[1];
    var _e = (0, react_1.useState)(null), reportReason = _e[0], setReportReason = _e[1];
    var _f = (0, react_1.useState)(false), reportSending = _f[0], setReportSending = _f[1];
    function submitReport() {
        return __awaiter(this, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!reportReason || !message)
                            return [2 /*return*/];
                        setReportSending(true);
                        return [4 /*yield*/, (0, messaging_2.reportMessage)(message.id, reportReason).catch(function () { return ({ ok: false }); })];
                    case 1:
                        result = _a.sent();
                        setReportSending(false);
                        setShowReport(false);
                        onClose();
                        if (result.ok) {
                            react_native_1.Alert.alert('Report submitted', 'Thank you. Our team will review this message.');
                        }
                        else {
                            react_native_1.Alert.alert('Report submitted', 'Thank you. Our team will review this message.');
                        }
                        return [2 /*return*/];
                }
            });
        });
    }
    if (!message)
        return null;
    var text = (_c = (_b = message.displayBody) !== null && _b !== void 0 ? _b : message.body) !== null && _c !== void 0 ? _c : '';
    return (<react_native_1.Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <react_native_1.Pressable style={las.overlay} onPress={onClose}/>
      <react_native_1.View style={las.sheet}>
        <react_native_1.View style={las.handle}/>
        {showReport ? (<>
            <react_native_1.Text style={las.reportTitle}>Report this message</react_native_1.Text>
            <react_native_1.Text style={las.reportSub}>What's wrong with this message?</react_native_1.Text>
            {REPORT_MSG_REASONS.map(function (reason) { return (<react_native_1.Pressable key={reason} style={[las.reasonOption, reportReason === reason && las.reasonSelected]} onPress={function () { return setReportReason(reason); }}>
                <react_native_1.Text style={[las.reasonText, reportReason === reason && las.reasonTextSelected]}>{reason}</react_native_1.Text>
                {reportReason === reason && <react_native_1.Text style={las.reasonCheck}>✓</react_native_1.Text>}
              </react_native_1.Pressable>); })}
            <react_native_1.Pressable style={[las.reportBtn, (!reportReason || reportSending) && las.reportBtnDisabled]} onPress={submitReport} disabled={!reportReason || reportSending}>
              {reportSending
                ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>
                : <react_native_1.Text style={las.reportBtnLabel}>Submit Report</react_native_1.Text>}
            </react_native_1.Pressable>
            <react_native_1.Pressable style={las.backBtn} onPress={function () { return setShowReport(false); }}>
              <react_native_1.Text style={las.backLabel}>Back</react_native_1.Text>
            </react_native_1.Pressable>
          </>) : (<>
            {text.length > 0 && (<react_native_1.Text style={las.preview} numberOfLines={2}>{text}</react_native_1.Text>)}
            {[
                ['reply', 'Reply', lucide_react_native_1.Reply],
                ['copy', 'Copy text', lucide_react_native_1.Copy],
                ['translate', 'Translate', lucide_react_native_1.Languages],
                ['save', 'Save message', lucide_react_native_1.BookmarkPlus],
                ['report', 'Report', lucide_react_native_1.Flag],
            ].map(function (_a) {
                var key = _a[0], label = _a[1], Icon = _a[2];
                return (<react_native_1.Pressable key={key} style={las.row} onPress={function () { return __awaiter(_this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0:
                                    if (!(key === 'copy')) return [3 /*break*/, 2];
                                    onClose();
                                    return [4 /*yield*/, Clipboard.setStringAsync(text)];
                                case 1:
                                    _a.sent();
                                    react_native_1.Alert.alert('Copied', 'Message copied to clipboard.');
                                    return [3 /*break*/, 3];
                                case 2:
                                    if (key === 'report') {
                                        setShowReport(true);
                                    }
                                    else {
                                        onClose();
                                        react_native_1.Alert.alert(label, 'This feature is coming soon.');
                                    }
                                    _a.label = 3;
                                case 3: return [2 /*return*/];
                            }
                        });
                    }); }}>
                <Icon size={18} color={tokens_1.color.ink}/>
                <react_native_1.Text style={las.rowLabel}>{label}</react_native_1.Text>
              </react_native_1.Pressable>);
            })}
            {mine && (<react_native_1.Pressable style={las.row} onPress={function () {
                    onClose();
                    react_native_1.Alert.alert('Delete message', 'Remove this message for you? Others will still see it.', [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Delete', style: 'destructive', onPress: function () { return onDeleteForMe(message.id); } },
                    ]);
                }}>
                <lucide_react_native_1.Trash2 size={18} color="#EF4444"/>
                <react_native_1.Text style={[las.rowLabel, { color: '#EF4444' }]}>Delete for me</react_native_1.Text>
              </react_native_1.Pressable>)}
          </>)}
      </react_native_1.View>
    </react_native_1.Modal>);
}
var las = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: { backgroundColor: tokens_1.color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: tokens_1.space.lg, paddingBottom: 34, paddingTop: tokens_1.space.sm },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginBottom: tokens_1.space.md },
    preview: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, marginBottom: tokens_1.space.sm, fontStyle: 'italic' }),
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, paddingVertical: 14, borderTopWidth: react_native_1.StyleSheet.hairlineWidth, borderTopColor: tokens_1.color.haze },
    rowLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    reportTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 15, marginBottom: 2 }),
    reportSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginBottom: tokens_1.space.md }),
    reasonOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11, paddingHorizontal: tokens_1.space.sm, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, marginBottom: 6 },
    reasonSelected: { borderColor: tokens_1.color.signal, backgroundColor: tokens_1.color.signal + '0A' },
    reasonText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    reasonTextSelected: { color: tokens_1.color.signal, fontWeight: '700' },
    reasonCheck: { fontSize: 14, color: tokens_1.color.signal, fontWeight: '700' },
    reportBtn: { marginTop: tokens_1.space.md, backgroundColor: '#EF4444', borderRadius: tokens_1.radius.md, paddingVertical: 13, alignItems: 'center' },
    reportBtnDisabled: { opacity: 0.45 },
    reportBtnLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontWeight: '700' }),
    backBtn: { paddingVertical: 10, alignItems: 'center' },
    backLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
});
/** Format a single time-poll slot as "Fri Jun 27 · 7:00 PM" (exact) or "Fri Jun 27 · Evening" (block) */
function fmtTimeOption(opt) {
    var _a;
    var datePart = fmtDate(opt.proposedDate);
    if (opt.proposedTime) {
        var _b = opt.proposedTime.split(':').map(Number), h = _b[0], m = _b[1];
        var d = new Date();
        d.setHours(h, m, 0, 0);
        var timePart = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return "".concat(datePart, " \u00B7 ").concat(timePart);
    }
    if (opt.timeBlock) {
        return "".concat(datePart, " \u00B7 ").concat((_a = BLOCK_SHORT[opt.timeBlock]) !== null && _a !== void 0 ? _a : opt.timeBlock);
    }
    return datePart;
}
function parseMeetupCard(body, msg) {
    if (!body.startsWith('{'))
        return null;
    try {
        var obj = JSON.parse(body);
        // Confirmation system message: subtype = 'meetup_confirmed'
        if ((msg === null || msg === void 0 ? void 0 : msg.msgType) === 'system' && (msg === null || msg === void 0 ? void 0 : msg.subtype) === 'meetup_confirmed') {
            if (obj.meetupId && obj.title) {
                return {
                    type: 'meetup_confirmed',
                    meetupId: obj.meetupId,
                    title: obj.title,
                    locationName: obj.locationName,
                    creatorName: obj.creatorName,
                    confirmedTime: obj.startsAt,
                    isConfirmed: true,
                };
            }
            return null;
        }
        // Primary: structured system message with meetup subtype (creation card)
        if ((msg === null || msg === void 0 ? void 0 : msg.msgType) === 'system' && (msg === null || msg === void 0 ? void 0 : msg.subtype) === 'meetup') {
            if (obj.meetupId && obj.title)
                return __assign({ type: 'meetup_card' }, obj);
            return null;
        }
        // Legacy fallback: JSON body with explicit type field
        if (obj.type === 'meetup_card' && obj.meetupId && obj.title)
            return obj;
    }
    catch ( /* ignore */_a) { /* ignore */ }
    return null;
}
var RSVP_BTNS = [
    { key: 'going', label: 'Going', emoji: '✅' },
    { key: 'maybe', label: 'Maybe', emoji: '🤔' },
    { key: 'declined', label: "Can't", emoji: '❌' },
];
function CreatorAvatar(_a) {
    var _b, _c, _d;
    var creator = _a.creator;
    var size = 20;
    if (creator === null || creator === void 0 ? void 0 : creator.avatarUrl) {
        return <react_native_1.Image source={{ uri: creator.avatarUrl }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tokens_1.color.haze }}/>;
    }
    var initial = (_d = (_c = (_b = creator === null || creator === void 0 ? void 0 : creator.displayName) === null || _b === void 0 ? void 0 : _b.charAt(0)) === null || _c === void 0 ? void 0 : _c.toUpperCase()) !== null && _d !== void 0 ? _d : '?';
    return (<react_native_1.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tokens_1.color.signal + '33', alignItems: 'center', justifyContent: 'center' }}>
      <react_native_1.Text style={{ fontSize: 10, fontWeight: '700', color: tokens_1.color.signal }}>{initial}</react_native_1.Text>
    </react_native_1.View>);
}
var AVATAR_SIZE = 26;
var AVATAR_OVERLAP = 8;
function AttendeeAvatar(_a) {
    var _b;
    var attendee = _a.attendee;
    var onPress = function () {
        if (attendee.handle)
            expo_router_1.router.push("/u/".concat(attendee.handle));
    };
    return (<react_native_1.Pressable onPress={onPress} style={as.avatarWrap}>
      {attendee.avatarUrl ? (<react_native_1.Image source={{ uri: attendee.avatarUrl }} style={as.avatar}/>) : (<react_native_1.View style={[as.avatar, as.avatarFallback]}>
          <react_native_1.Text style={as.avatarInitial}>
            {((_b = attendee.displayName) !== null && _b !== void 0 ? _b : '?').charAt(0).toUpperCase()}
          </react_native_1.Text>
        </react_native_1.View>)}
    </react_native_1.Pressable>);
}
function AvatarStack(_a) {
    var attendees = _a.attendees, totalGoing = _a.totalGoing;
    if (attendees.length === 0)
        return null;
    var overflow = totalGoing - attendees.length;
    return (<react_native_1.View style={as.row}>
      {attendees.map(function (a, i) { return (<react_native_1.View key={a.id} style={[as.avatarSlot, { marginLeft: i === 0 ? 0 : -AVATAR_OVERLAP }]}>
          <AttendeeAvatar attendee={a}/>
        </react_native_1.View>); })}
      {overflow > 0 && (<react_native_1.View style={[as.overflowBadge, { marginLeft: -AVATAR_OVERLAP }]}>
          <react_native_1.Text style={as.overflowText}>+{overflow}</react_native_1.Text>
        </react_native_1.View>)}
      <react_native_1.Text style={as.goingLabel}>going</react_native_1.Text>
    </react_native_1.View>);
}
var as = react_native_1.StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    avatarSlot: { zIndex: 1 },
    avatarWrap: {},
    avatar: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2, borderWidth: 2, borderColor: tokens_1.color.paperRaised, backgroundColor: tokens_1.color.haze },
    avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.signal + '22' },
    avatarInitial: { fontSize: 10, fontWeight: '700', color: tokens_1.color.signal },
    overflowBadge: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2, borderWidth: 2, borderColor: tokens_1.color.paperRaised, backgroundColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
    overflowText: { fontSize: 9, fontWeight: '700', color: tokens_1.color.mute },
    goingLabel: { fontSize: 10, color: tokens_1.color.mute, fontWeight: '500', marginLeft: 2 },
});
function MeetupCard(_a) {
    var _b, _c, _d, _e, _f;
    var payload = _a.payload, mine = _a.mine;
    var isAuthed = (0, SessionContext_1.useSession)().isAuthed;
    var _g = (0, react_1.useState)(null), counts = _g[0], setCounts = _g[1];
    var _h = (0, react_1.useState)(null), myRsvp = _h[0], setMyRsvp = _h[1];
    var _j = (0, react_1.useState)(null), rsvping = _j[0], setRsvping = _j[1];
    var _k = (0, react_1.useState)(false), isCancelled = _k[0], setIsCancelled = _k[1];
    // undefined = still loading; null = loaded but creator not found
    var _l = (0, react_1.useState)(undefined), creator = _l[0], setCreator = _l[1];
    // Live meetup fields used to enrich card display beyond what's in the stored payload
    var _m = (0, react_1.useState)(null), fetchedStartsAt = _m[0], setFetchedStartsAt = _m[1];
    var _o = (0, react_1.useState)(null), fetchedApproxDate = _o[0], setFetchedApproxDate = _o[1];
    var _p = (0, react_1.useState)([]), fetchedTimeOptions = _p[0], setFetchedTimeOptions = _p[1];
    var _q = (0, react_1.useState)([]), goingAttendees = _q[0], setGoingAttendees = _q[1];
    var _r = (0, react_1.useState)(0), totalGoing = _r[0], setTotalGoing = _r[1];
    var appStateRef = (0, react_1.useRef)(react_native_1.AppState.currentState);
    var refreshMeetup = (0, react_1.useCallback)(function () {
        if (appStateRef.current !== 'active')
            return;
        (0, meetups_1.getMeetup)(payload.meetupId).then(function (res) {
            var _a, _b, _c, _d, _e, _f, _g;
            if (res.ok && res.data) {
                setCounts(res.data.counts);
                setMyRsvp((_a = res.data.myRsvp) !== null && _a !== void 0 ? _a : null);
                setIsCancelled(res.data.status === 'cancelled');
                setCreator((_b = res.data.creator) !== null && _b !== void 0 ? _b : null);
                setFetchedStartsAt((_c = res.data.startsAt) !== null && _c !== void 0 ? _c : null);
                setFetchedApproxDate((_d = res.data.approximateDate) !== null && _d !== void 0 ? _d : null);
                setFetchedTimeOptions((_e = res.data.timeOptions) !== null && _e !== void 0 ? _e : []);
                setGoingAttendees((_f = res.data.goingAttendees) !== null && _f !== void 0 ? _f : []);
                setTotalGoing((_g = res.data.totalGoing) !== null && _g !== void 0 ? _g : 0);
            }
        });
    }, [payload.meetupId]);
    (0, react_1.useEffect)(function () {
        // Initial load — always fetch regardless of AppState
        (0, meetups_1.getMeetup)(payload.meetupId).then(function (res) {
            var _a, _b, _c, _d, _e, _f, _g;
            if (res.ok && res.data) {
                setCounts(res.data.counts);
                setMyRsvp((_a = res.data.myRsvp) !== null && _a !== void 0 ? _a : null);
                setIsCancelled(res.data.status === 'cancelled');
                setCreator((_b = res.data.creator) !== null && _b !== void 0 ? _b : null);
                setFetchedStartsAt((_c = res.data.startsAt) !== null && _c !== void 0 ? _c : null);
                setFetchedApproxDate((_d = res.data.approximateDate) !== null && _d !== void 0 ? _d : null);
                setFetchedTimeOptions((_e = res.data.timeOptions) !== null && _e !== void 0 ? _e : []);
                setGoingAttendees((_f = res.data.goingAttendees) !== null && _f !== void 0 ? _f : []);
                setTotalGoing((_g = res.data.totalGoing) !== null && _g !== void 0 ? _g : 0);
            }
        });
        var sub = react_native_1.AppState.addEventListener('change', function (next) {
            appStateRef.current = next;
        });
        var interval = setInterval(refreshMeetup, 30000);
        return function () {
            sub.remove();
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [payload.meetupId, refreshMeetup]);
    function handleRsvp(status) {
        return __awaiter(this, void 0, void 0, function () {
            var prev, prevCounts, next, res;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (rsvping)
                            return [2 /*return*/];
                        prev = myRsvp;
                        prevCounts = counts;
                        // Optimistic update
                        setMyRsvp(status);
                        if (counts) {
                            next = __assign({}, counts);
                            if (prev === 'going')
                                next.going = Math.max(0, next.going - 1);
                            else if (prev === 'maybe')
                                next.maybe = Math.max(0, next.maybe - 1);
                            else if (prev === 'declined')
                                next.declined = Math.max(0, next.declined - 1);
                            else
                                next.pending = Math.max(0, next.pending - 1);
                            if (status === 'going')
                                next.going++;
                            else if (status === 'maybe')
                                next.maybe++;
                            else if (status === 'declined')
                                next.declined++;
                            setCounts(next);
                        }
                        setRsvping(status);
                        return [4 /*yield*/, (0, meetups_1.rsvpMeetup)(payload.meetupId, status)];
                    case 1:
                        res = _b.sent();
                        setRsvping(null);
                        if (res.ok && res.data) {
                            setMyRsvp(res.data.status);
                            setCounts(res.data.counts);
                            // Re-fetch full meetup to update going attendees after RSVP change
                            refreshMeetup();
                        }
                        else {
                            setMyRsvp(prev);
                            setCounts(prevCounts);
                            react_native_1.Alert.alert('Error', (_a = res.message) !== null && _a !== void 0 ? _a : 'Could not RSVP');
                        }
                        return [2 /*return*/];
                }
            });
        });
    }
    var isConfirmed = (_b = payload.isConfirmed) !== null && _b !== void 0 ? _b : false;
    // Fallback chain for the date/time row:
    //   confirmed  → confirmedTime (payload) → fetchedStartsAt → date-only fallback
    //   unconfirmed → fetchedStartsAt → earliest time-poll slot (with exact time if proposedTime set)
    //               → approximateDate + block label → null
    var approxDateStr = (_c = payload.approximateDate) !== null && _c !== void 0 ? _c : fetchedApproxDate;
    var dateOnlyFallback = approxDateStr ? fmtDate(approxDateStr) : null;
    var pendingWhen = null;
    if (fetchedStartsAt) {
        pendingWhen = fmtDateTime(fetchedStartsAt);
    }
    else if (fetchedTimeOptions.length > 0) {
        var sorted = __spreadArray([], fetchedTimeOptions, true).sort(function (a, b) { var _a, _b; return (a.proposedDate + ((_a = a.proposedTime) !== null && _a !== void 0 ? _a : '')).localeCompare(b.proposedDate + ((_b = b.proposedTime) !== null && _b !== void 0 ? _b : '')); });
        var firstLabel = fmtTimeOption(sorted[0]);
        pendingWhen = sorted.length > 1 ? "".concat(firstLabel, " +").concat(sorted.length - 1, " more") : firstLabel;
    }
    else if (approxDateStr) {
        pendingWhen = "".concat(fmtDate(approxDateStr)).concat(payload.timeBlock ? " \u00B7 ".concat((_d = BLOCK_SHORT[payload.timeBlock]) !== null && _d !== void 0 ? _d : payload.timeBlock) : '');
    }
    var when = isConfirmed
        ? (payload.confirmedTime
            ? fmtDateTime(payload.confirmedTime)
            : fetchedStartsAt
                ? fmtDateTime(fetchedStartsAt)
                : dateOnlyFallback)
        : pendingWhen;
    var showRsvpButtons = isAuthed && !isCancelled;
    return (<react_native_1.Pressable style={[mc.card, mine && mc.cardMine, isConfirmed && mc.cardConfirmed]} onPress={function () { return expo_router_1.router.push("/meetup/".concat(payload.meetupId)); }}>
      <react_native_1.View style={mc.row}>
        <react_native_1.View style={[mc.icon, isConfirmed && mc.iconConfirmed]}>
          {isConfirmed
            ? <lucide_react_native_1.CheckCircle size={14} color={tokens_1.color.success}/>
            : <lucide_react_native_1.CalendarClock size={14} color={tokens_1.color.signal}/>}
        </react_native_1.View>
        <react_native_1.Text style={[mc.label, isConfirmed && mc.labelConfirmed]}>
          {isConfirmed ? 'Confirmed' : 'Meetup'}
        </react_native_1.Text>
        {!isConfirmed && (<react_native_1.View style={mc.pendingBadge}>
            <react_native_1.Text style={mc.pendingBadgeText}>Voting in progress</react_native_1.Text>
          </react_native_1.View>)}
      </react_native_1.View>

      {/* Creator row — shown once getMeetup() resolves */}
      {creator !== undefined ? (<react_native_1.Pressable style={mc.creatorRow} onPress={function () { if (creator === null || creator === void 0 ? void 0 : creator.handle)
            expo_router_1.router.push("/u/".concat(creator.handle)); }} disabled={!(creator === null || creator === void 0 ? void 0 : creator.handle)}>
          <CreatorAvatar creator={creator}/>
          <react_native_1.Text style={mc.creatorText} numberOfLines={1}>
            {(_e = creator === null || creator === void 0 ? void 0 : creator.displayName) !== null && _e !== void 0 ? _e : 'Someone'} planned a meetup
          </react_native_1.Text>
        </react_native_1.Pressable>) : null}

      <react_native_1.Text style={[mc.title, mine && mc.titleMine]} numberOfLines={2}>{payload.title}</react_native_1.Text>
      {goingAttendees.length > 0 && (<AvatarStack attendees={goingAttendees} totalGoing={(_f = counts === null || counts === void 0 ? void 0 : counts.going) !== null && _f !== void 0 ? _f : totalGoing}/>)}
      {payload.locationName ? (<react_native_1.View style={mc.metaRow}>
          <react_native_1.Text style={mc.meta} numberOfLines={1}>📍 {payload.locationName}</react_native_1.Text>
        </react_native_1.View>) : null}
      {when ? (<react_native_1.View style={mc.metaRow}>
          <react_native_1.Text style={[mc.meta, isConfirmed && mc.metaConfirmed]}>
            {isConfirmed ? '✅' : '🗓'} {when}
          </react_native_1.Text>
        </react_native_1.View>) : null}
      {counts ? (<RsvpBar_1.RsvpBar style={mc.rsvpBar} going={counts.going} maybe={counts.maybe} pending={counts.pending} total={counts.going + counts.maybe + counts.pending}/>) : null}

      {showRsvpButtons ? (<react_native_1.View style={mc.rsvpRow}>
          {RSVP_BTNS.map(function (opt) {
                var isActive = myRsvp === opt.key;
                var isBusy = rsvping === opt.key;
                return (<react_native_1.Pressable key={opt.key} style={[mc.rsvpBtn, isActive && mc.rsvpBtnActive]} onPress={function () { return handleRsvp(opt.key); }} disabled={rsvping !== null}>
                {isBusy
                        ? <react_native_1.ActivityIndicator size="small" color={isActive ? tokens_1.color.onInk : tokens_1.color.signal} style={{ width: 14, height: 14 }}/>
                        : <react_native_1.Text style={mc.rsvpEmoji}>{opt.emoji}</react_native_1.Text>}
                <react_native_1.Text style={[mc.rsvpLabel, isActive && mc.rsvpLabelActive]}>{opt.label}</react_native_1.Text>
              </react_native_1.Pressable>);
            })}
        </react_native_1.View>) : isConfirmed ? (<react_native_1.View style={mc.footer}>
          <react_native_1.Text style={[mc.see, mine && mc.seeMine]}>Tap to view details</react_native_1.Text>
          <lucide_react_native_1.ArrowRight size={12} color={mine ? tokens_1.color.onInk + 'AA' : tokens_1.color.success}/>
        </react_native_1.View>) : (<react_native_1.View style={mc.footer}>
          <react_native_1.Text style={[mc.see, mine && mc.seeMine]}>Tap to view meetup</react_native_1.Text>
          <lucide_react_native_1.ArrowRight size={12} color={mine ? tokens_1.color.onInk + 'AA' : tokens_1.color.signal}/>
        </react_native_1.View>)}
    </react_native_1.Pressable>);
}
var mc = react_native_1.StyleSheet.create({
    card: { borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised, padding: tokens_1.space.md, gap: tokens_1.space.sm, minWidth: 200, maxWidth: 280 },
    cardMine: { backgroundColor: tokens_1.color.signal + '22', borderColor: tokens_1.color.signal + '55' },
    cardConfirmed: { borderColor: tokens_1.color.success + '55', backgroundColor: tokens_1.color.success + '0A' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    icon: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#E0F2FE', alignItems: 'center', justifyContent: 'center' },
    iconConfirmed: { backgroundColor: tokens_1.color.success + '22' },
    label: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '700', fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase' }),
    labelConfirmed: { color: tokens_1.color.success },
    pendingBadge: { marginLeft: 'auto', backgroundColor: '#FFF3CD', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
    pendingBadgeText: { fontSize: 9, fontWeight: '600', color: '#856404', letterSpacing: 0.3 },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700' }),
    titleMine: { color: tokens_1.color.ink },
    metaRow: { flexDirection: 'row', alignItems: 'center' },
    rsvpBar: { marginTop: 2 },
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    metaConfirmed: { color: tokens_1.color.success, fontWeight: '600' },
    plannedBy: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 10, fontStyle: 'italic' }),
    creatorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    creatorText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, flex: 1 }),
    footer: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    see: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontSize: 11 }),
    seeMine: { color: tokens_1.color.signal },
    rsvpRow: { flexDirection: 'row', gap: 5, marginTop: 6 },
    rsvpBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 5, paddingHorizontal: 4, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper, minWidth: 0 },
    rsvpBtnActive: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    rsvpEmoji: { fontSize: 11 },
    rsvpLabel: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink, fontSize: 10 }),
    rsvpLabelActive: { color: tokens_1.color.onInk },
});
// ── Message bubble ────────────────────────────────────────────────────────────
function MessageBubble(_a) {
    var _b, _c, _d, _e, _f, _g;
    var item = _a.item, mine = _a.mine, autoTranslate = _a.autoTranslate, defaultShowOriginal = _a.defaultShowOriginal, isGroupThread = _a.isGroupThread, onLongPress = _a.onLongPress, receiptState = _a.receiptState, dismissedAiMsgIds = _a.dismissedAiMsgIds, onDismissAiCard = _a.onDismissAiCard, deliveryStatus = _a.deliveryStatus, onRetry = _a.onRetry;
    var _h = (0, react_1.useState)(defaultShowOriginal || !autoTranslate), showOriginal = _h[0], setShowOriginal = _h[1];
    // Brief highlight when a pending translation resolves to 'translated'
    var flashAnim = (0, react_1.useRef)(new react_native_1.Animated.Value(0)).current;
    var prevStatusRef = (0, react_1.useRef)(item.translationStatus);
    (0, react_1.useEffect)(function () {
        var prev = prevStatusRef.current;
        prevStatusRef.current = item.translationStatus;
        if (prev === 'pending' && item.translationStatus === 'translated') {
            flashAnim.setValue(1);
            react_native_1.Animated.timing(flashAnim, {
                toValue: 0,
                duration: 1400,
                useNativeDriver: true,
            }).start();
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
    }, [item.translationStatus, flashAnim]);
    if (item.deleted) {
        return (<react_native_1.Pressable style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]} onLongPress={onLongPress} delayLongPress={300}>
        <react_native_1.Text style={[styles.bubbleText, { fontStyle: 'italic', color: mine ? tokens_1.color.onInk + 'AA' : tokens_1.color.mute }]}>
          This message was deleted.
        </react_native_1.Text>
      </react_native_1.Pressable>);
    }
    // Meetup card — special rendering (long-press wrapper added)
    var meetupPayload = parseMeetupCard((_b = item.body) !== null && _b !== void 0 ? _b : '', item);
    if (meetupPayload) {
        return (<react_native_1.Pressable onLongPress={onLongPress} delayLongPress={300}>
        <MeetupCard payload={meetupPayload} mine={mine}/>
      </react_native_1.Pressable>);
    }
    // Discovery card
    if (item.msgType === 'system' && item.subtype === 'discovery_card') {
        return (<react_native_1.Pressable onLongPress={onLongPress} delayLongPress={300}>
        <DiscoveryCardMessage_1.DiscoveryCardMessage body={(_c = item.body) !== null && _c !== void 0 ? _c : ''} mine={mine}/>
      </react_native_1.Pressable>);
    }
    // AI recommendation card — body is JSON with TelegraphActivityRecommendation shape
    if (item.msgType === 'ai_recommendation') {
        if (dismissedAiMsgIds === null || dismissedAiMsgIds === void 0 ? void 0 : dismissedAiMsgIds.has(item.id))
            return null;
        var recPayload_1 = (function () { var _a; try {
            return JSON.parse((_a = item.body) !== null && _a !== void 0 ? _a : '');
        }
        catch (_b) {
            return null;
        } })();
        if (recPayload_1 === null || recPayload_1 === void 0 ? void 0 : recPayload_1.title) {
            return (<react_native_1.Pressable onLongPress={onLongPress} delayLongPress={300}>
          <TelegraphRecommendationCard_1.TelegraphRecommendationCard rec={recPayload_1} onAddToTrip={function () { return react_native_1.Alert.alert('Add to Trip', "Add \"".concat(recPayload_1.title, "\" to a trip plan.")); }} onSave={function () {
                    var _a, _b;
                    (0, intelligence_1.sendFeedback)((_a = recPayload_1.id) !== null && _a !== void 0 ? _a : '', (_b = recPayload_1.category) !== null && _b !== void 0 ? _b : '', 'save').catch(function () { });
                    react_native_1.Alert.alert('Saved', "\"".concat(recPayload_1.title, "\" saved to your ideas."));
                }} onShare={function () {
                    var _a, _b, _c;
                    (0, intelligence_1.sendFeedback)((_a = recPayload_1.id) !== null && _a !== void 0 ? _a : '', (_b = recPayload_1.category) !== null && _b !== void 0 ? _b : '', 'share').catch(function () { });
                    react_native_1.Share.share({ message: "".concat(recPayload_1.title, " \u2014 ").concat((_c = recPayload_1.reason) !== null && _c !== void 0 ? _c : '') }).catch(function () { });
                }} onNotInterested={function () {
                    var _a, _b;
                    (0, intelligence_1.sendFeedback)((_a = recPayload_1.id) !== null && _a !== void 0 ? _a : '', (_b = recPayload_1.category) !== null && _b !== void 0 ? _b : '', 'not_for_me').catch(function () { });
                    onDismissAiCard === null || onDismissAiCard === void 0 ? void 0 : onDismissAiCard(item.id);
                }}/>
        </react_native_1.Pressable>);
        }
    }
    var bodyToShow;
    if (mine || !autoTranslate || showOriginal) {
        bodyToShow = (_e = (_d = item.originalBody) !== null && _d !== void 0 ? _d : item.body) !== null && _e !== void 0 ? _e : '';
    }
    else {
        bodyToShow = (_g = (_f = item.displayBody) !== null && _f !== void 0 ? _f : item.body) !== null && _g !== void 0 ? _g : '';
    }
    var isTranslated = item.translated && autoTranslate && !showOriginal;
    var isPending = item.translationStatus === 'pending';
    var showLabel = !mine && (isPending ||
        (isTranslated && !!item.translationLabel) ||
        !!item.canShowOriginal);
    return (<react_native_1.View>
      {isGroupThread && !mine && item.senderName && (<react_native_1.Text style={styles.senderLabel}>
          {item.senderName}
          {item.senderHandle ? " @".concat(item.senderHandle) : ''}
        </react_native_1.Text>)}
      <react_native_1.Pressable onLongPress={onLongPress} delayLongPress={300} style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
        <react_native_1.Animated.View style={[styles.translationFlash, react_native_1.StyleSheet.absoluteFillObject, { opacity: flashAnim }]} pointerEvents="none"/>
        <react_native_1.Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>
          {bodyToShow}
        </react_native_1.Text>

        <react_native_1.Text style={[styles.bubbleTime, mine && styles.bubbleTimeMine]}>
          {formatTime(item.createdAt)}
          {item.editedAt ? '  ·  edited' : ''}
        </react_native_1.Text>

        {showLabel && (<react_native_1.View style={styles.translationRow}>
            {isPending ? (<react_native_1.Text style={[styles.transLabel, mine && styles.transLabelMine]}>
                Translating…
              </react_native_1.Text>) : isTranslated && item.translationLabel ? (<react_native_1.Text style={[styles.transLabel, mine && styles.transLabelMine]}>
                {item.translationLabel}
              </react_native_1.Text>) : null}

            {item.canShowOriginal && autoTranslate && (<react_native_1.Pressable onPress={function () { return setShowOriginal(function (v) { return !v; }); }} hitSlop={8}>
                <react_native_1.Text style={[styles.transToggle, mine && styles.transToggleMine]}>
                  {showOriginal ? 'Show translation' : 'Show original'}
                </react_native_1.Text>
              </react_native_1.Pressable>)}
          </react_native_1.View>)}

        {/* Translation unavailable — shown when translation was attempted but failed */}
        {!mine && item.translationStatus === 'failed' && autoTranslate && (<react_native_1.Text style={styles.transUnavailable}>Translation unavailable.</react_native_1.Text>)}
      </react_native_1.Pressable>

      {/* Delivery status — sending / sent / failed (tap-to-retry) */}
      {mine && deliveryStatus === 'sending' && (<react_native_1.View style={styles.deliveryRow}>
          <lucide_react_native_1.Clock size={11} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.deliverySending}>Sending…</react_native_1.Text>
        </react_native_1.View>)}
      {mine && deliveryStatus === 'sent' && !receiptState && (<react_native_1.View style={styles.deliveryRow}>
          <lucide_react_native_1.Check size={11} color={tokens_1.color.signal}/>
          <react_native_1.Text style={styles.deliverySent}>Sent</react_native_1.Text>
        </react_native_1.View>)}
      {mine && deliveryStatus === 'failed' && (<react_native_1.Pressable style={styles.deliveryRow} onPress={onRetry} hitSlop={8}>
          <lucide_react_native_1.AlertCircle size={11} color="#EF4444"/>
          <react_native_1.Text style={styles.deliveryFailed}>Tap to retry</react_native_1.Text>
        </react_native_1.Pressable>)}

      {/* Read receipt — shown on the last confirmed own message only */}
      {mine && receiptState && deliveryStatus !== 'sending' && deliveryStatus !== 'failed' && (<react_native_1.View style={styles.receiptRow}>
          {receiptState === 'read' ? (<>
              <lucide_react_native_1.CheckCheck size={11} color={tokens_1.color.signal}/>
              <react_native_1.Text style={styles.receiptSent}>Read</react_native_1.Text>
            </>) : receiptState === 'delivered' ? (<>
              <lucide_react_native_1.CheckCheck size={11} color={tokens_1.color.mute}/>
              <react_native_1.Text style={[styles.receiptSent, { color: tokens_1.color.mute }]}>Delivered</react_native_1.Text>
            </>) : (<>
              <lucide_react_native_1.Check size={11} color={tokens_1.color.signal}/>
              <react_native_1.Text style={styles.receiptSent}>Sent</react_native_1.Text>
            </>)}
        </react_native_1.View>)}
    </react_native_1.View>);
}
// ── Add-to-Plan sheet ─────────────────────────────────────────────────────────
function AddToPlanSheet(_a) {
    var visible = _a.visible, suggestion = _a.suggestion, onClose = _a.onClose, onConfirm = _a.onConfirm;
    var _b = (0, react_1.useState)(null), selectedTripId = _b[0], setSelectedTripId = _b[1];
    if (!suggestion)
        return null;
    function handleConfirm() {
        if (!selectedTripId) {
            react_native_1.Alert.alert('Select a trip', 'Please choose a trip to add this to.');
            return;
        }
        onConfirm(selectedTripId);
        setSelectedTripId(null);
    }
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <react_native_1.Pressable style={sheetStyles.overlay} onPress={onClose}/>
      <react_native_1.View style={sheetStyles.sheet}>
        <react_native_1.View style={sheetStyles.handle}/>
        <react_native_1.Text style={sheetStyles.title}>Add to Trip Plan</react_native_1.Text>
        <react_native_1.Text style={sheetStyles.subtitle} numberOfLines={2}>
          {suggestion.title}
        </react_native_1.Text>

        <react_native_1.Text style={sheetStyles.sectionLabel}>Choose your trip</react_native_1.Text>
        <react_native_1.View style={sheetStyles.tripOption}>
          <react_native_1.Text style={sheetStyles.tripName}>My Trip</react_native_1.Text>
          <react_native_1.Pressable style={[
            sheetStyles.radioBtn,
            selectedTripId === 'current' && sheetStyles.radioBtnSelected,
        ]} onPress={function () { return setSelectedTripId('current'); }}>
            {selectedTripId === 'current' && <lucide_react_native_1.Check size={12} color={tokens_1.color.onInk}/>}
          </react_native_1.Pressable>
        </react_native_1.View>

        <react_native_1.Text style={sheetStyles.hint}>
          To add to a specific trip, open the trip chat and use the suggestion there.
        </react_native_1.Text>

        <react_native_1.Pressable style={sheetStyles.confirmBtn} onPress={handleConfirm}>
          <react_native_1.Text style={sheetStyles.confirmLabel}>Add to Plan</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={sheetStyles.cancelBtn} onPress={onClose}>
          <react_native_1.Text style={sheetStyles.cancelLabel}>Cancel</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.Modal>);
}
function TelegraphThread() {
    var _this = this;
    var _a, _b, _c;
    var _d = (0, expo_router_1.useLocalSearchParams)(), id = _d.id, title = _d.title, threadType = _d.threadType, contextId = _d.contextId, otherUserId = _d.otherUserId;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var userId = (0, SessionContext_1.useSession)().userId;
    var _e = (0, useMessaging_1.useThreadMessages)(id !== null && id !== void 0 ? id : null), messages = _e.messages, loading = _e.loading, error = _e.error, sending = _e.sending, send = _e.send, reload = _e.reload, typingUserIds = _e.typingUserIds, notifyTyping = _e.notifyTyping, retrySend = _e.retrySend;
    var langSettings = (0, useMessaging_1.useLanguageSettings)().data;
    var _f = (0, react_1.useState)(''), input = _f[0], setInput = _f[1];
    var _g = (0, react_1.useState)(undefined), lastSentMessage = _g[0], setLastSentMessage = _g[1];
    var _h = (0, react_1.useState)(false), sendFailed = _h[0], setSendFailed = _h[1];
    var _j = (0, react_1.useState)(null), addToPlanSuggestion = _j[0], setAddToPlanSuggestion = _j[1];
    var _k = (0, react_1.useState)(null), meetupSheetCtx = _k[0], setMeetupSheetCtx = _k[1];
    var _l = (0, react_1.useState)(threadType === 'direct'), isAcceptedMember = _l[0], setIsAcceptedMember = _l[1];
    var _m = (0, react_1.useState)(undefined), plannedByName = _m[0], setPlannedByName = _m[1];
    var _o = (0, react_1.useState)(false), blockingUser = _o[0], setBlockingUser = _o[1];
    var _p = (0, react_1.useState)(false), showSafetySheet = _p[0], setShowSafetySheet = _p[1];
    var _q = (0, react_1.useState)(false), hideAiSuggestions = _q[0], setHideAiSuggestions = _q[1];
    var _r = (0, react_1.useState)(false), threadIsMuted = _r[0], setThreadIsMuted = _r[1];
    var _s = (0, react_1.useState)(new Set()), dismissedAiMsgIds = _s[0], setDismissedAiMsgIds = _s[1];
    // Long-press action sheet state
    var _u = (0, react_1.useState)(null), actionMsg = _u[0], setActionMsg = _u[1];
    var _v = (0, react_1.useState)(false), actionMsgMine = _v[0], setActionMsgMine = _v[1];
    // Per-thread translation overrides (null = fall back to global langSettings)
    var _w = (0, react_1.useState)(null), threadAutoTranslate = _w[0], setThreadAutoTranslate = _w[1];
    var _x = (0, react_1.useState)(null), threadShowOriginal = _x[0], setThreadShowOriginal = _x[1];
    // Fetch trip end date so TelegraphSuggestionTray can expire cached suggestions
    var tripData = (0, useBackend_1.useTrip)(threadType === 'trip' ? contextId : undefined).data;
    var _y = (0, react_1.useState)(false), showTranslationSheet = _y[0], setShowTranslationSheet = _y[1];
    // DM profile for richer header
    var _z = (0, react_1.useState)(null), dmProfile = _z[0], setDmProfile = _z[1];
    // Other party's last_read_at for DM read receipts
    var _0 = (0, react_1.useState)(null), dmOtherLastRead = _0[0], setDmOtherLastRead = _0[1];
    // Member count for trip/circle threads
    var _1 = (0, react_1.useState)(null), memberCount = _1[0], setMemberCount = _1[1];
    var listRef = (0, react_1.useRef)(null);
    function handleBlockPress() {
        var _this = this;
        if (!otherUserId || blockingUser)
            return;
        react_native_1.Alert.alert('Block user?', 'They won\'t be able to message you or see your profile. You can manage blocks in Settings → Blocked accounts.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Block',
                style: 'destructive',
                onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0:
                                setBlockingUser(true);
                                return [4 /*yield*/, (0, blocks_1.blockUser)(otherUserId)];
                            case 1:
                                _a.sent();
                                setBlockingUser(false);
                                expo_router_1.router.replace('/messages');
                                return [2 /*return*/];
                        }
                    });
                }); },
            },
        ]);
    }
    // Load per-thread translation prefs from AsyncStorage
    (0, react_1.useEffect)(function () {
        if (!id)
            return;
        async_storage_1.default.getItem("thread_translation:".concat(id))
            .then(function (raw) {
            if (!raw)
                return;
            try {
                var parsed = JSON.parse(raw);
                if (typeof parsed.autoTranslate === 'boolean')
                    setThreadAutoTranslate(parsed.autoTranslate);
                if (typeof parsed.showOriginal === 'boolean')
                    setThreadShowOriginal(parsed.showOriginal);
            }
            catch ( /* ignore corrupt entries */_a) { /* ignore corrupt entries */ }
        })
            .catch(function () { });
    }, [id]);
    function saveThreadTranslationPrefs(at, so) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!id)
                            return [2 /*return*/];
                        return [4 /*yield*/, async_storage_1.default.setItem("thread_translation:".concat(id), JSON.stringify({ autoTranslate: at, showOriginal: so }))];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    }
    // Load per-thread hide-AI-suggestions pref from AsyncStorage
    (0, react_1.useEffect)(function () {
        if (!id)
            return;
        async_storage_1.default.getItem("thread_ai_hidden:".concat(id))
            .then(function (v) { if (v === '1')
            setHideAiSuggestions(true); })
            .catch(function () { });
    }, [id]);
    function toggleHideAiSuggestions() {
        return __awaiter(this, void 0, void 0, function () {
            var next;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!id)
                            return [2 /*return*/];
                        next = !hideAiSuggestions;
                        setHideAiSuggestions(next);
                        return [4 /*yield*/, async_storage_1.default.setItem("thread_ai_hidden:".concat(id), next ? '1' : '0').catch(function () { })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    }
    // Resolve display name once (for the planned-by label in meetup cards)
    (0, react_1.useEffect)(function () {
        supabase_1.supabase.auth.getUser().then(function (_a) {
            var _b, _c, _d, _e;
            var data = _a.data;
            var meta = (_b = data === null || data === void 0 ? void 0 : data.user) === null || _b === void 0 ? void 0 : _b.user_metadata;
            var name = ((_d = (_c = meta === null || meta === void 0 ? void 0 : meta.full_name) !== null && _c !== void 0 ? _c : meta === null || meta === void 0 ? void 0 : meta.name) !== null && _d !== void 0 ? _d : (_e = data === null || data === void 0 ? void 0 : data.user) === null || _e === void 0 ? void 0 : _e.email);
            if (name)
                setPlannedByName(name);
        });
    }, []);
    // Fetch DM partner's profile for the rich Direct header
    (0, react_1.useEffect)(function () {
        if (threadType !== 'direct' || !otherUserId)
            return;
        supabase_1.supabase
            .from('profiles')
            .select('name, handle, avatar_url, city')
            .eq('id', otherUserId)
            .maybeSingle()
            .then(function (_a) {
            var _b, _c, _d, _e;
            var data = _a.data;
            if (data) {
                setDmProfile({
                    name: (_b = data.name) !== null && _b !== void 0 ? _b : null,
                    handle: (_c = data.handle) !== null && _c !== void 0 ? _c : null,
                    avatarUrl: (_d = data.avatar_url) !== null && _d !== void 0 ? _d : null,
                    city: (_e = data.city) !== null && _e !== void 0 ? _e : null,
                });
            }
        });
    }, [threadType, otherUserId]);
    // Fetch other party's last_read_at for DM read receipts
    (0, react_1.useEffect)(function () {
        if (threadType !== 'direct' || !id || !otherUserId)
            return;
        supabase_1.supabase
            .from('message_thread_members')
            .select('last_read_at')
            .eq('thread_id', id)
            .eq('user_id', otherUserId)
            .maybeSingle()
            .then(function (_a) {
            var _b;
            var data = _a.data;
            if (data)
                setDmOtherLastRead((_b = data.last_read_at) !== null && _b !== void 0 ? _b : null);
        });
    }, [threadType, id, otherUserId]);
    // Fetch member count for trip / circle threads
    (0, react_1.useEffect)(function () {
        if (threadType === 'direct' || !id)
            return;
        supabase_1.supabase
            .from('message_thread_members')
            .select('*', { count: 'exact', head: true })
            .eq('thread_id', id)
            .is('left_at', null)
            .then(function (_a) {
            var count = _a.count;
            if (count !== null)
                setMemberCount(count);
        });
    }, [id, threadType]);
    // Permission gate: accepted thread members only (DMs always pass; trip/circle
    // check message_thread_members — only accepted members are in the thread).
    (0, react_1.useEffect)(function () {
        if (threadType === 'direct') {
            setIsAcceptedMember(true);
            return;
        }
        if (!id || !userId)
            return;
        supabase_1.supabase.from('message_thread_members')
            .select('user_id')
            .eq('thread_id', id)
            .eq('user_id', userId)
            .is('left_at', null)
            .maybeSingle()
            .then(function (_a) {
            var data = _a.data;
            return setIsAcceptedMember(Boolean(data));
        });
    }, [id, threadType, userId]);
    // Mark thread as read when the user opens it. Fire-and-forget.
    (0, react_1.useEffect)(function () {
        if (!id)
            return;
        (0, useMessaging_1.markThreadRead)(id).catch(function () { });
    }, [id]);
    // Merge: per-thread override takes precedence over global langSettings
    var autoTranslate = (_a = threadAutoTranslate !== null && threadAutoTranslate !== void 0 ? threadAutoTranslate : langSettings === null || langSettings === void 0 ? void 0 : langSettings.auto_translate_messages) !== null && _a !== void 0 ? _a : true;
    var defaultShowOriginal = (_b = threadShowOriginal !== null && threadShowOriginal !== void 0 ? threadShowOriginal : langSettings === null || langSettings === void 0 ? void 0 : langSettings.show_original_messages) !== null && _b !== void 0 ? _b : false;
    var isGroupThread = threadType === 'trip' || threadType === 'circle';
    // Sender-side rate-limit: "Waiting for reply" = the current user has a
    // PENDING outgoing message request to this person. We check the server so
    // that normal friends/followers who simply haven't replied yet are never
    // blocked. The status clears automatically once the recipient accepts.
    var hasOutgoingRequest = (0, useMessaging_1.useOutgoingRequestStatus)(threadType === 'direct' ? (otherUserId !== null && otherUserId !== void 0 ? otherUserId : null) : null).pending;
    var isWaitingForReply = threadType === 'direct' && hasOutgoingRequest === true;
    var headerTitle = title && title.trim() ? title : 'Chat';
    (0, react_1.useEffect)(function () {
        var _a;
        if (messages.length > 0) {
            (_a = listRef.current) === null || _a === void 0 ? void 0 : _a.scrollToEnd({ animated: true });
        }
    }, [messages.length]);
    var listItems = (0, react_1.useMemo)(function () {
        var items = [];
        var lastDay = '';
        for (var _i = 0, messages_1 = messages; _i < messages_1.length; _i++) {
            var m = messages_1[_i];
            var day = m.createdAt.slice(0, 10);
            if (day !== lastDay) {
                lastDay = day;
                items.push({ _t: 'day', label: formatDayLabel(day), key: "day-".concat(day) });
            }
            items.push({ _t: 'msg', data: m });
        }
        return items;
    }, [messages]);
    // ID of the last message sent by the current user (for read receipts)
    var lastOwnMsgId = (0, react_1.useMemo)(function () {
        for (var i = messages.length - 1; i >= 0; i--) {
            if (messages[i].senderId === userId)
                return messages[i].id;
        }
        return null;
    }, [messages, userId]);
    // Compute receipt state for the last own message: 'sent' | 'delivered' | 'read'
    var receiptState = (0, react_1.useMemo)(function () {
        if (!lastOwnMsgId)
            return null;
        var lastMsg = messages.find(function (m) { return m.id === lastOwnMsgId; });
        if (!lastMsg)
            return null;
        // DM: check if the other party has read past this message
        if (threadType === 'direct' && dmOtherLastRead) {
            if (new Date(dmOtherLastRead) >= new Date(lastMsg.createdAt))
                return 'read';
        }
        // Delivered heuristic: message is older than 3 seconds (broadcast confirmed)
        var ageSecs = (Date.now() - new Date(lastMsg.createdAt).getTime()) / 1000;
        return ageSecs > 3 ? 'delivered' : 'sent';
    }, [lastOwnMsgId, messages, threadType, dmOtherLastRead]);
    // Handle delete for me from the action sheet
    var handleDeleteForMe = (0, react_1.useCallback)(function (msgId) { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, messaging_1.deleteMessage)(msgId)];
                case 1:
                    _a.sent();
                    reload();
                    return [2 /*return*/];
            }
        });
    }); }, [reload]);
    function handleSend() {
        return __awaiter(this, void 0, void 0, function () {
            var text, res;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        text = input.trim();
                        if (!text || sending)
                            return [2 /*return*/];
                        notifyTyping(false);
                        setInput('');
                        setLastSentMessage(text);
                        setSendFailed(false);
                        return [4 /*yield*/, send(text)];
                    case 1:
                        res = _b.sent();
                        if (!(res === null || res === void 0 ? void 0 : res.ok))
                            setSendFailed(true);
                        (_a = listRef.current) === null || _a === void 0 ? void 0 : _a.scrollToEnd({ animated: true });
                        return [2 /*return*/];
                }
            });
        });
    }
    var handleAddToPlan = (0, react_1.useCallback)(function (suggestion) { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, new Promise(function (resolve) {
                    setAddToPlanSuggestion(suggestion);
                    // The sheet calls resolve via onConfirm; we store the resolver to call later
                    // Simplified: we use inline Alert for trip selection in DM threads
                    if (threadType !== 'trip') {
                        react_native_1.Alert.alert('Add to Trip Plan', "Add \"".concat(suggestion.title, "\" to your trip plan?"), [
                            { text: 'Cancel', style: 'cancel', onPress: function () { return resolve(null); } },
                            {
                                text: 'Add',
                                onPress: function () {
                                    setAddToPlanSuggestion(null);
                                    resolve('current');
                                },
                            },
                        ]);
                    }
                    else {
                        resolve(id !== null && id !== void 0 ? id : null);
                        setAddToPlanSuggestion(null);
                    }
                })];
        });
    }); }, [threadType, id]);
    var handleCreateMeetup = (0, react_1.useCallback)(function (prefill) {
        var _a;
        setMeetupSheetCtx({
            tripId: (_a = prefill.tripId) !== null && _a !== void 0 ? _a : undefined,
            initialTitle: prefill.title,
            initialLocation: prefill.location,
        });
    }, []);
    var handlePlanMeetupButton = (0, react_1.useCallback)(function () {
        setMeetupSheetCtx({
            tripId: threadType === 'trip' ? contextId : undefined,
            circleOwnerId: threadType === 'circle' ? contextId : undefined,
        });
    }, [threadType, contextId]);
    var handleViewPlace = (0, react_1.useCallback)(function (suggestion) {
        react_native_1.Alert.alert(suggestion.title, suggestion.reason + (suggestion.location_context ? "\n\n\uD83D\uDCCD ".concat(suggestion.location_context) : ''), [{ text: 'OK' }]);
    }, []);
    // Shared back + title header element (used in loading/error states too)
    function ThreadHeader(_a) {
        var _b, _c;
        var compact = _a.compact;
        var displayName = threadType === 'direct'
            ? ((_b = dmProfile === null || dmProfile === void 0 ? void 0 : dmProfile.name) !== null && _b !== void 0 ? _b : headerTitle)
            : headerTitle;
        // Direct: show "City · Last active" subtitle
        var directSubtitle = (dmProfile === null || dmProfile === void 0 ? void 0 : dmProfile.city) ? "".concat(dmProfile.city, " \u00B7 Active recently") : 'Active recently';
        var subtitle = threadType === 'trip'
            ? (memberCount !== null ? "".concat(memberCount, " members") : 'Trip Chat')
            : threadType === 'circle'
                ? (memberCount !== null ? "".concat(memberCount, " members") : 'Trusted Circle')
                : directSubtitle;
        return (<react_native_1.View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <react_native_1.Pressable style={styles.backBtn} onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}>
          <lucide_react_native_1.ArrowLeft size={20} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>

        {/* Direct: small avatar */}
        {threadType === 'direct' && (<react_native_1.View style={styles.dmAvatarWrap}>
            {(dmProfile === null || dmProfile === void 0 ? void 0 : dmProfile.avatarUrl) ? (<react_native_1.Image source={{ uri: dmProfile.avatarUrl }} style={styles.dmAvatar}/>) : (<react_native_1.View style={styles.dmAvatarFallback}>
                <react_native_1.Text style={styles.dmAvatarInitial}>
                  {((_c = displayName[0]) !== null && _c !== void 0 ? _c : '?').toUpperCase()}
                </react_native_1.Text>
              </react_native_1.View>)}
          </react_native_1.View>)}

        {/* Trip / Circle: coloured badge */}
        {threadType === 'trip' && (<react_native_1.View style={styles.headerIconBadge}>
            <lucide_react_native_1.Globe size={14} color={tokens_1.color.onInk}/>
          </react_native_1.View>)}
        {threadType === 'circle' && (<react_native_1.View style={[styles.headerIconBadge, { backgroundColor: tokens_1.color.ink }]}>
            <lucide_react_native_1.Users size={14} color={tokens_1.color.onInk}/>
          </react_native_1.View>)}

        <react_native_1.View style={styles.headerMeta}>
          <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <react_native_1.Text style={styles.headerName} numberOfLines={1}>{displayName}</react_native_1.Text>
            {threadType === 'direct' && (dmProfile === null || dmProfile === void 0 ? void 0 : dmProfile.name) && (<lucide_react_native_1.CheckCircle size={13} color={tokens_1.color.signal}/>)}
          </react_native_1.View>
          <react_native_1.View style={styles.headerTagRow}>
            {compact ? (<>
                <lucide_react_native_1.Zap size={9} color={tokens_1.color.signal} fill={tokens_1.color.signal}/>
                <react_native_1.Text style={styles.headerTag}>Telegraph</react_native_1.Text>
              </>) : (<react_native_1.Text style={styles.headerTag} numberOfLines={1}>{subtitle}</react_native_1.Text>)}
          </react_native_1.View>
        </react_native_1.View>

        {/* Right-side action icons */}
        {!compact && (<react_native_1.View style={styles.headerActions}>
            <react_native_1.Pressable hitSlop={8} style={styles.headerIconBtn} onPress={function () { return react_native_1.Alert.alert('Thread info', 'Members, shared media, and settings — coming soon.'); }}>
              <lucide_react_native_1.Info size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
            <react_native_1.Pressable hitSlop={8} style={styles.headerIconBtn} onPress={function () { return react_native_1.Alert.alert('Search messages', 'Message search coming soon.'); }}>
              <lucide_react_native_1.Search size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
            <react_native_1.Pressable hitSlop={8} style={styles.headerIconBtn} onPress={function () { return setShowTranslationSheet(true); }}>
              <lucide_react_native_1.Languages size={18} color={autoTranslate ? tokens_1.color.signal : tokens_1.color.mute}/>
            </react_native_1.Pressable>
            <react_native_1.Pressable hitSlop={8} style={styles.headerIconBtn} onPress={function () { return react_native_1.Alert.alert('Mute thread', 'Mute controls coming soon.'); }}>
              <lucide_react_native_1.VolumeX size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={styles.headerIconBtn} onPress={function () { return setShowSafetySheet(true); }} hitSlop={8}>
              <lucide_react_native_1.MoreVertical size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
          </react_native_1.View>)}
      </react_native_1.View>);
    }
    // Quick-action bar shown below the header for trip / circle threads
    function QuickActionBar() {
        if (threadType === 'trip' && contextId) {
            return (<react_native_1.View style={styles.quickBar}>
          <react_native_1.Pressable style={styles.quickBtn} onPress={function () { return expo_router_1.router.push("/trip/".concat(contextId)); }}>
            <lucide_react_native_1.Globe size={12} color={tokens_1.color.signal}/>
            <react_native_1.Text style={styles.quickBtnText}>View Trip</react_native_1.Text>
          </react_native_1.Pressable>
          <react_native_1.Pressable style={styles.quickBtn} onPress={handlePlanMeetupButton}>
            <lucide_react_native_1.CalendarClock size={12} color={tokens_1.color.signal}/>
            <react_native_1.Text style={styles.quickBtnText}>Add Plan</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>);
        }
        if (threadType === 'circle' && contextId) {
            return (<react_native_1.View style={styles.quickBar}>
          <react_native_1.Pressable style={styles.quickBtn} onPress={function () { return expo_router_1.router.push("/circle/".concat(contextId)); }}>
            <lucide_react_native_1.Users size={12} color={tokens_1.color.signal}/>
            <react_native_1.Text style={styles.quickBtnText}>View Circle</react_native_1.Text>
          </react_native_1.Pressable>
          <react_native_1.Pressable style={styles.quickBtn} onPress={function () { return react_native_1.Alert.alert('Share Discovery', 'Share a place from Discovery — coming soon.'); }}>
            <lucide_react_native_1.Compass size={12} color={tokens_1.color.signal}/>
            <react_native_1.Text style={styles.quickBtnText}>Share Discovery</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>);
        }
        return null;
    }
    if (loading) {
        return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
        <ThreadHeader compact/>
        <react_native_1.View style={styles.center}><react_native_1.ActivityIndicator color={tokens_1.color.signal}/></react_native_1.View>
      </react_native_1.View>);
    }
    if (error) {
        return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
        <ThreadHeader compact/>
        <react_native_1.View style={styles.center}><react_native_1.Text style={styles.errText}>{error}</react_native_1.Text></react_native_1.View>
      </react_native_1.View>);
    }
    return (<react_native_1.KeyboardAvoidingView style={styles.screen} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ThreadHeader />
      <QuickActionBar />

      <react_native_1.FlatList ref={listRef} data={listItems} keyExtractor={function (item) { return item._t === 'day' ? item.key : item.data.id; }} contentContainerStyle={styles.list} ListEmptyComponent={<react_native_1.View style={styles.center}>
            <react_native_1.Text style={styles.emptyText}>No messages yet. Say hello!</react_native_1.Text>
          </react_native_1.View>} renderItem={function (_a) {
            var _b, _c, _d;
            var item = _a.item;
            if (item._t === 'day') {
                return <DayDivider label={item.label}/>;
            }
            var m = item.data;
            var mine = m.senderId === userId;
            // System event messages (non-meetup, non-rich-card) render as centred pill labels
            if (m.msgType === 'system' && m.subtype !== 'discovery_card' && !parseMeetupCard((_b = m.body) !== null && _b !== void 0 ? _b : '', m)) {
                return <TelegraphSystemNotice_1.TelegraphSystemNotice text={(_c = m.body) !== null && _c !== void 0 ? _c : ''}/>;
            }
            return (<react_native_1.View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
              <MessageBubble item={m} mine={mine} autoTranslate={autoTranslate} defaultShowOriginal={defaultShowOriginal} isGroupThread={isGroupThread} onLongPress={function () {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setActionMsg(m);
                    setActionMsgMine(mine);
                }} receiptState={m.id === lastOwnMsgId ? receiptState : null} dismissedAiMsgIds={dismissedAiMsgIds} onDismissAiCard={function (msgId) { return setDismissedAiMsgIds(function (prev) { return new Set(__spreadArray(__spreadArray([], prev, true), [msgId], false)); }); }} deliveryStatus={mine ? ((_d = m.deliveryStatus) !== null && _d !== void 0 ? _d : null) : null} onRetry={mine && m.clientId ? function () { return retrySend(m.clientId); } : undefined}/>
            </react_native_1.View>);
        }} onLayout={function () { var _a; return (_a = listRef.current) === null || _a === void 0 ? void 0 : _a.scrollToEnd({ animated: false }); }} ItemSeparatorComponent={function () { return <react_native_1.View style={{ height: tokens_1.space.sm }}/>; }}/>

      {/* Typing indicator */}
      {typingUserIds.length > 0 && (<react_native_1.View style={styles.typingRow}>
          <react_native_1.Text style={styles.typingText}>
            {typingUserIds.length === 1 && (dmProfile === null || dmProfile === void 0 ? void 0 : dmProfile.name)
                ? "".concat(dmProfile.name, " is typing\u2026")
                : 'Someone is typing…'}
          </react_native_1.Text>
        </react_native_1.View>)}

      {/* Waiting-for-reply banner — shown when the user's first message is pending acceptance */}
      {isWaitingForReply && (<react_native_1.View style={styles.waitingBanner}>
          <lucide_react_native_1.Clock size={14} color="#92400E"/>
          <react_native_1.Text style={styles.waitingBannerText}>
            Waiting for reply — your message is in their requests.
          </react_native_1.Text>
        </react_native_1.View>)}

      {/* Failed-send banner — sits above the composer, offers retry */}
      {sendFailed && lastSentMessage && (<react_native_1.View style={styles.failedBanner}>
          <lucide_react_native_1.AlertCircle size={14} color="#EF4444"/>
          <react_native_1.Text style={styles.failedBannerText} numberOfLines={1}>
            Failed to send: "{lastSentMessage}"
          </react_native_1.Text>
          <react_native_1.Pressable style={styles.failedRetryBtn} onPress={function () {
                var text = lastSentMessage;
                setSendFailed(false);
                setInput(text);
            }}>
            <lucide_react_native_1.RefreshCw size={12} color="#EF4444"/>
            <react_native_1.Text style={styles.failedRetryText}>Retry</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>)}

      {/* Telegraph suggestion tray — above the composer */}
      {id && !hideAiSuggestions && (<TelegraphSuggestionTray_1.TelegraphSuggestionTray threadId={id} lastSentMessage={lastSentMessage} tripEndDate={tripData === null || tripData === void 0 ? void 0 : tripData.endDate} onAddToPlan={handleAddToPlan} onCreateMeetup={handleCreateMeetup} onViewPlace={handleViewPlace}/>)}

      <react_native_1.View style={[styles.compose, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {/* Attachment stub */}
        <react_native_1.Pressable style={styles.composeIconBtn} onPress={function () { return react_native_1.Alert.alert('Attach', 'File attachments coming soon.'); }} hitSlop={6}>
          <lucide_react_native_1.Paperclip size={18} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>

        {/* Plan meetup button */}
        {isAcceptedMember && (<react_native_1.Pressable style={styles.composeIconBtn} onPress={handlePlanMeetupButton} hitSlop={6}>
            <lucide_react_native_1.CalendarClock size={18} color={tokens_1.color.signal}/>
          </react_native_1.Pressable>)}

        {/* Discovery card stub */}
        <react_native_1.Pressable style={styles.composeIconBtn} onPress={function () { return react_native_1.Alert.alert('Share Discovery', 'Share a place from Discovery — coming soon.'); }} hitSlop={6}>
          <lucide_react_native_1.Compass size={18} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>

        {/* AI suggestion stub */}
        <react_native_1.Pressable style={styles.composeIconBtn} onPress={function () { return react_native_1.Alert.alert('AI Suggestions', 'Compass AI suggestions — coming soon.'); }} hitSlop={6}>
          <lucide_react_native_1.Bot size={18} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>

        <react_native_1.TextInput style={[styles.inputField, isWaitingForReply && { opacity: 0.45 }]} placeholder={isWaitingForReply ? 'Waiting for reply…' : 'Write a Telegraph…'} placeholderTextColor={tokens_1.color.faint} value={input} onChangeText={function (text) { setInput(text); notifyTyping(text.trim().length > 0); }} onBlur={function () { return notifyTyping(false); }} onSubmitEditing={handleSend} returnKeyType="send" editable={!sending && !isWaitingForReply} multiline/>
        <react_native_1.Pressable style={[styles.sendBtn, (input.trim() && !sending && !isWaitingForReply) ? styles.sendBtnActive : styles.sendBtnDisabled]} onPress={handleSend} disabled={!input.trim() || sending || isWaitingForReply}>
          {sending ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>) : (<lucide_react_native_1.Send size={16} color={input.trim() ? tokens_1.color.onInk : tokens_1.color.faint}/>)}
        </react_native_1.Pressable>
      </react_native_1.View>

      {/* Meetup creation sheet — triggered by button or Telegraph suggestion */}
      {meetupSheetCtx && (<MeetupCreationSheet_1.MeetupCreationSheet tripId={meetupSheetCtx.tripId} circleOwnerId={meetupSheetCtx.circleOwnerId} initialTitle={meetupSheetCtx.initialTitle} initialLocation={meetupSheetCtx.initialLocation} onDismiss={function () { return setMeetupSheetCtx(null); }} onCreated={function (meetup) {
                var _a, _b, _c;
                if (!id)
                    return;
                var isScoped = Boolean((meetupSheetCtx === null || meetupSheetCtx === void 0 ? void 0 : meetupSheetCtx.tripId) || (meetupSheetCtx === null || meetupSheetCtx === void 0 ? void 0 : meetupSheetCtx.circleOwnerId));
                if (isScoped) {
                    reload();
                }
                else {
                    send(JSON.stringify({
                        type: 'meetup_card',
                        meetupId: meetup.id,
                        title: meetup.title,
                        locationName: (_a = meetup.locationName) !== null && _a !== void 0 ? _a : undefined,
                        approximateDate: (_b = meetup.approximateDate) !== null && _b !== void 0 ? _b : undefined,
                        timeBlock: (_c = meetup.timeBlock) !== null && _c !== void 0 ? _c : undefined,
                        plannedByName: plannedByName,
                    }), { msgType: 'system', subtype: 'meetup' });
                }
            }}/>)}

      {/* Thread safety / overflow controls */}
      <ThreadSafetySheet_1.ThreadSafetySheet visible={showSafetySheet} onClose={function () { return setShowSafetySheet(false); }} threadType={(_c = threadType) !== null && _c !== void 0 ? _c : 'direct'} otherUserId={otherUserId} isMuted={threadIsMuted} onToggleMute={function () { return __awaiter(_this, void 0, void 0, function () {
            var next;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        next = !threadIsMuted;
                        return [4 /*yield*/, (0, messaging_1.muteThread)(id !== null && id !== void 0 ? id : '', next)];
                    case 1:
                        _a.sent();
                        setThreadIsMuted(next);
                        return [2 /*return*/];
                }
            });
        }); }} hideAiSuggestions={hideAiSuggestions} onToggleHideAi={toggleHideAiSuggestions} onBlock={threadType === 'direct' && otherUserId ? function () { return __awaiter(_this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setShowSafetySheet(false);
                        setBlockingUser(true);
                        return [4 /*yield*/, (0, blocks_1.blockUser)(otherUserId)];
                    case 1:
                        _a.sent();
                        setBlockingUser(false);
                        expo_router_1.router.replace('/messages');
                        return [2 /*return*/];
                }
            });
        }); } : undefined} onLeave={threadType !== 'direct' ? function () { return __awaiter(_this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, (0, TelegraphSuggestionTray_1.clearTelegraphSuggestionsCache)(id !== null && id !== void 0 ? id : '')];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, (0, messaging_1.leaveThread)(id !== null && id !== void 0 ? id : '')];
                    case 2:
                        _a.sent();
                        expo_router_1.router.replace('/messages');
                        return [2 /*return*/];
                }
            });
        }); } : undefined} onDeleteForMe={function () { return __awaiter(_this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, (0, TelegraphSuggestionTray_1.clearTelegraphSuggestionsCache)(id !== null && id !== void 0 ? id : '')];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, (0, messaging_1.leaveThread)(id !== null && id !== void 0 ? id : '')];
                    case 2:
                        _a.sent();
                        expo_router_1.router.replace('/messages');
                        return [2 /*return*/];
                }
            });
        }); }} onReport={function (reason) { return __awaiter(_this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, (0, messaging_1.reportThread)(id !== null && id !== void 0 ? id : '', reason)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); }}/>

      {/* Long-press action sheet */}
      <LongPressActionSheet message={actionMsg} mine={actionMsgMine} onClose={function () { return setActionMsg(null); }} onDeleteForMe={handleDeleteForMe}/>

      {/* Per-thread translation settings */}
      <TranslationSettingsSheet_1.TranslationSettingsSheet visible={showTranslationSheet} autoTranslate={autoTranslate} showOriginalFirst={defaultShowOriginal} onChangeAutoTranslate={function (v) {
            var _a;
            setThreadAutoTranslate(v);
            saveThreadTranslationPrefs(v, (_a = threadShowOriginal !== null && threadShowOriginal !== void 0 ? threadShowOriginal : langSettings === null || langSettings === void 0 ? void 0 : langSettings.show_original_messages) !== null && _a !== void 0 ? _a : false);
        }} onChangeShowOriginalFirst={function (v) {
            var _a;
            setThreadShowOriginal(v);
            saveThreadTranslationPrefs((_a = threadAutoTranslate !== null && threadAutoTranslate !== void 0 ? threadAutoTranslate : langSettings === null || langSettings === void 0 ? void 0 : langSettings.auto_translate_messages) !== null && _a !== void 0 ? _a : true, v);
        }} onClose={function () { return setShowTranslationSheet(false); }}/>
    </react_native_1.KeyboardAvoidingView>);
}
var styles = react_native_1.StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens_1.color.paper },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    errText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    emptyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: tokens_1.space.md,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    backBtn: { padding: 4 },
    headerIconBadge: {
        width: 26,
        height: 26,
        borderRadius: 8,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    headerMeta: { flex: 1 },
    headerName: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700' }),
    headerTagRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 3 },
    headerTag: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, fontSize: 10, letterSpacing: 0.4 }),
    senderLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, fontFamily: 'Courier', marginBottom: 2, marginLeft: 2 }),
    list: { paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md },
    bubbleRow: { alignSelf: 'flex-start', maxWidth: '82%' },
    bubbleRowMine: { alignSelf: 'flex-end' },
    bubble: { borderRadius: tokens_1.radius.lg, paddingHorizontal: tokens_1.space.md, paddingTop: tokens_1.space.sm, paddingBottom: 6 },
    bubbleOther: {
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderBottomLeftRadius: 4,
    },
    bubbleMine: { backgroundColor: tokens_1.color.signal, borderBottomRightRadius: 4 },
    bubbleText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, lineHeight: 20, flexShrink: 1, flexWrap: 'wrap' }),
    bubbleTextMine: { color: tokens_1.color.onInk },
    bubbleTime: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.faint, fontSize: 10, marginTop: 2, textAlign: 'right' }),
    bubbleTimeMine: { color: tokens_1.color.onInk + '88' },
    translationRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 4,
    },
    translationFlash: {
        borderRadius: tokens_1.radius.lg,
        backgroundColor: tokens_1.color.signal + '28',
    },
    transLabel: {
        fontSize: 10,
        color: tokens_1.color.mute,
        fontFamily: 'Courier',
        letterSpacing: 0.2,
        flexShrink: 1,
    },
    transLabelMine: { color: tokens_1.color.onInk + '99' },
    transToggle: {
        fontSize: 10,
        color: tokens_1.color.signal,
        fontFamily: 'Courier',
        textDecorationLine: 'underline',
    },
    transToggleMine: { color: tokens_1.color.onInk + 'CC' },
    transUnavailable: {
        fontSize: 10,
        color: tokens_1.color.mute,
        fontFamily: 'Courier',
        fontStyle: 'italic',
        letterSpacing: 0.2,
        marginTop: 4,
    },
    compose: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.md,
        paddingTop: tokens_1.space.sm,
        borderTopWidth: 1,
        borderTopColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    inputField: __assign(__assign({ flex: 1, minHeight: 38, maxHeight: 110, backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.md, paddingVertical: 9 }, tokens_1.type.body), { color: tokens_1.color.ink }),
    // DM avatar in header
    dmAvatarWrap: { flexShrink: 0 },
    dmAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: tokens_1.color.haze },
    dmAvatarFallback: { width: 32, height: 32, borderRadius: 16, backgroundColor: tokens_1.color.signal + '22', alignItems: 'center', justifyContent: 'center' },
    dmAvatarInitial: { fontSize: 13, fontWeight: '700', color: tokens_1.color.signal },
    // Header right-side action row
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 },
    headerIconBtn: { padding: 5 },
    // Quick-action bar (trip/circle)
    quickBar: { flexDirection: 'row', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingVertical: 8, borderBottomWidth: react_native_1.StyleSheet.hairlineWidth, borderBottomColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    quickBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.signal + '55', backgroundColor: tokens_1.color.signal + '0A' },
    quickBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontSize: 11, fontWeight: '600' }),
    // Read receipt
    receiptRow: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
    receiptSent: { fontSize: 10, color: tokens_1.color.signal, fontFamily: 'Courier' },
    receiptFailRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    receiptFail: { fontSize: 10, color: '#EF4444', fontFamily: 'Courier' },
    deliveryRow: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
    deliverySending: { fontSize: 10, color: tokens_1.color.mute, fontFamily: 'Courier' },
    deliverySent: { fontSize: 10, color: tokens_1.color.signal, fontFamily: 'Courier' },
    deliveryFailed: { fontSize: 10, color: '#EF4444', fontFamily: 'Courier', fontWeight: '600' },
    typingRow: {
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: 5,
        backgroundColor: tokens_1.color.paper,
    },
    typingText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, fontStyle: 'italic' }),
    // Composer icon buttons (attach, meetup, discovery, ai)
    composeIconBtn: { width: 32, height: 38, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    // Waiting-for-reply banner above the composer
    waitingBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: 7,
        backgroundColor: '#FFFBEB',
        borderTopWidth: react_native_1.StyleSheet.hairlineWidth,
        borderTopColor: '#FDE68A',
    },
    waitingBannerText: __assign(__assign({}, tokens_1.type.small), { color: '#92400E', flex: 1, fontSize: 11 }),
    // Failed-send banner above the composer
    failedBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: 7,
        backgroundColor: '#FEF2F2',
        borderTopWidth: react_native_1.StyleSheet.hairlineWidth,
        borderTopColor: '#FECACA',
    },
    failedBannerText: __assign(__assign({}, tokens_1.type.small), { color: '#EF4444', flex: 1, fontSize: 11 }),
    failedRetryBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: '#FECACA' },
    failedRetryText: __assign(__assign({}, tokens_1.type.stamp), { color: '#EF4444', fontSize: 10, fontWeight: '600' }),
    sendBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
    sendBtnActive: { backgroundColor: tokens_1.color.signal },
    sendBtnDisabled: { backgroundColor: tokens_1.color.haze },
});
var sheetStyles = react_native_1.StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
    },
    sheet: {
        backgroundColor: tokens_1.color.paperRaised,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        padding: tokens_1.space.xl,
        paddingBottom: 40,
        gap: tokens_1.space.sm,
    },
    handle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: tokens_1.color.haze,
        alignSelf: 'center',
        marginBottom: tokens_1.space.md,
    },
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 18 }),
    subtitle: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, fontSize: 13 }),
    sectionLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', fontSize: 11, color: tokens_1.color.mute, marginTop: tokens_1.space.md, letterSpacing: 0.5 }),
    tripOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: tokens_1.space.sm },
    tripName: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    radioBtn: {
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 2,
        borderColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioBtnSelected: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    hint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12 }),
    input: __assign(__assign({ backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.md, paddingVertical: 10 }, tokens_1.type.body), { color: tokens_1.color.ink }),
    confirmBtn: {
        marginTop: tokens_1.space.md,
        backgroundColor: tokens_1.color.signal,
        borderRadius: tokens_1.radius.md,
        paddingVertical: 14,
        alignItems: 'center',
    },
    confirmLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontWeight: '700' }),
    cancelBtn: { paddingVertical: 10, alignItems: 'center' },
    cancelLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
});
