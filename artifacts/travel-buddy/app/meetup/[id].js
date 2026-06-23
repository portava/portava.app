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
exports.default = MeetupScreen;
/**
 * Meetup detail screen
 *
 * Shows: title, location, time options + poll, RSVP button,
 * attendee counts, and Add to Trip Plan for trip-scoped meetups.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var meetups_1 = require("../../src/services/meetups");
var DateTimePickerField_1 = require("../../src/components/DateTimePickerField");
var SessionContext_1 = require("../../src/context/SessionContext");
var PlanPickerController_1 = require("../../src/components/PlanPickerController");
var tokens_1 = require("../../src/theme/tokens");
var TODAY_START = (function () { var d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
function toISODate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return "".concat(y, "-").concat(m, "-").concat(day);
}
var BLOCK_OPTIONS = [
    { key: 'morning', label: 'Morning' },
    { key: 'afternoon', label: 'Afternoon' },
    { key: 'evening', label: 'Evening' },
    { key: 'late', label: 'Late' },
];
function relDate(iso) {
    if (!iso)
        return '';
    return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function relDateTime(iso) {
    if (!iso)
        return '';
    var d = new Date(iso);
    var datePart = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    var timePart = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return "".concat(datePart, " \u00B7 ").concat(timePart);
}
function combineDateTime(date, time) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var day = String(date.getDate()).padStart(2, '0');
    var h = String(time.getHours()).padStart(2, '0');
    var min = String(time.getMinutes()).padStart(2, '0');
    return "".concat(y, "-").concat(m, "-").concat(day, "T").concat(h, ":").concat(min, ":00");
}
var BLOCK_LABELS = {
    morning: 'Morning (8–12)', afternoon: 'Afternoon (12–17)',
    evening: 'Evening (17–22)', late: 'Late night (22+)',
};
function formatProposedTime(timeStr) {
    var _a, _b;
    var parts = timeStr.split(':');
    var h = parseInt((_a = parts[0]) !== null && _a !== void 0 ? _a : '0', 10);
    var m = parseInt((_b = parts[1]) !== null && _b !== void 0 ? _b : '0', 10);
    var d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function timeOptionPill(opt) {
    var _a;
    if (opt.proposedTime)
        return formatProposedTime(opt.proposedTime);
    if (opt.timeBlock)
        return (_a = BLOCK_LABELS[opt.timeBlock]) !== null && _a !== void 0 ? _a : opt.timeBlock;
    return 'Time TBD';
}
var STATUS_COLORS = {
    active: { bg: '#E0F2FE', fg: '#0369A1' },
    confirmed: { bg: '#DCFCE7', fg: '#16A34A' },
    draft: { bg: tokens_1.color.haze, fg: tokens_1.color.mute },
    cancelled: { bg: '#FEE2E2', fg: '#DC2626' },
};
var RSVP_OPTIONS = [
    { key: 'going', label: 'Going', emoji: '✅' },
    { key: 'maybe', label: 'Maybe', emoji: '🤔' },
    { key: 'declined', label: "Can't go", emoji: '❌' },
];
function ConfirmedTimeBanner(_a) {
    var _b;
    var meetup = _a.meetup;
    if (meetup.status !== 'confirmed')
        return null;
    var dateTime = meetup.startsAt
        ? relDateTime(meetup.startsAt)
        : meetup.approximateDate
            ? "".concat(relDate(meetup.approximateDate)).concat(meetup.timeBlock ? " \u00B7 ".concat((_b = BLOCK_LABELS[meetup.timeBlock]) !== null && _b !== void 0 ? _b : meetup.timeBlock) : '')
            : null;
    return (<react_native_1.View style={cb.banner}>
      <react_native_1.View style={cb.iconWrap}>
        <lucide_react_native_1.CheckCircle2 size={22} color="#16A34A"/>
      </react_native_1.View>
      <react_native_1.View style={cb.body}>
        <react_native_1.Text style={cb.heading}>Time Confirmed</react_native_1.Text>
        {dateTime ? (<react_native_1.Text style={cb.detail}>{dateTime}</react_native_1.Text>) : null}
        {meetup.locationName ? (<react_native_1.View style={cb.locRow}>
            <lucide_react_native_1.MapPin size={12} color="#15803D"/>
            <react_native_1.Text style={cb.locText}>{meetup.locationName}</react_native_1.Text>
          </react_native_1.View>) : null}
      </react_native_1.View>
    </react_native_1.View>);
}
var cb = react_native_1.StyleSheet.create({
    banner: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        backgroundColor: '#DCFCE7',
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
        borderColor: '#86EFAC',
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.md,
    },
    iconWrap: {
        marginTop: 1,
    },
    body: {
        flex: 1,
        gap: 3,
    },
    heading: {
        fontSize: 15,
        fontWeight: '800',
        color: '#14532D',
        letterSpacing: 0.1,
    },
    detail: {
        fontSize: 14,
        fontWeight: '700',
        color: '#15803D',
    },
    locRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginTop: 1,
    },
    locText: {
        fontSize: 13,
        fontWeight: '600',
        color: '#15803D',
        flex: 1,
    },
});
function VoteBar(_a) {
    var votes = _a.votes;
    var total = votes.yes + votes.maybe + votes.no;
    if (total === 0)
        return <react_native_1.Text style={vb.none}>No votes yet</react_native_1.Text>;
    return (<react_native_1.View style={vb.row}>
      <react_native_1.View style={vb.item}><lucide_react_native_1.ThumbsUp size={11} color="#16A34A"/><react_native_1.Text style={[vb.num, { color: '#16A34A' }]}>{votes.yes}</react_native_1.Text></react_native_1.View>
      <react_native_1.View style={vb.item}><lucide_react_native_1.Minus size={11} color={tokens_1.color.mute}/><react_native_1.Text style={[vb.num, { color: tokens_1.color.mute }]}>{votes.maybe}</react_native_1.Text></react_native_1.View>
      <react_native_1.View style={vb.item}><lucide_react_native_1.ThumbsDown size={11} color='#DC2626'/><react_native_1.Text style={[vb.num, { color: '#DC2626' }]}>{votes.no}</react_native_1.Text></react_native_1.View>
    </react_native_1.View>);
}
var vb = react_native_1.StyleSheet.create({
    row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    item: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    num: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', fontSize: 11 }),
    none: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11 }),
});
function MeetupScreen() {
    var _this = this;
    var _a, _b, _c, _d, _e, _f;
    var id = (0, expo_router_1.useLocalSearchParams)().id;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var isAuthed = (0, SessionContext_1.useSession)().isAuthed;
    var _g = (0, PlanPickerController_1.usePlanPicker)(), openPlanPicker = _g.open, isAdded = _g.isAdded;
    var _h = (0, react_1.useState)(null), meetup = _h[0], setMeetup = _h[1];
    var _j = (0, react_1.useState)(true), loading = _j[0], setLoading = _j[1];
    var _k = (0, react_1.useState)(null), error = _k[0], setError = _k[1];
    var _l = (0, react_1.useState)(null), actioning = _l[0], setActioning = _l[1];
    // Edit mode state
    var _m = (0, react_1.useState)(false), editing = _m[0], setEditing = _m[1];
    var _o = (0, react_1.useState)(''), editTitle = _o[0], setEditTitle = _o[1];
    var _p = (0, react_1.useState)(''), editLocation = _p[0], setEditLocation = _p[1];
    var _q = (0, react_1.useState)(''), editDesc = _q[0], setEditDesc = _q[1];
    var _r = (0, react_1.useState)(null), editDate = _r[0], setEditDate = _r[1];
    var _s = (0, react_1.useState)(null), editExactTime = _s[0], setEditExactTime = _s[1];
    var _t = (0, react_1.useState)(null), editTimeBlock = _t[0], setEditTimeBlock = _t[1];
    var _u = (0, react_1.useState)('title'), editFocusField = _u[0], setEditFocusField = _u[1];
    var locationInputRef = (0, react_1.useRef)(null);
    function startEdit(focusField) {
        var _a, _b, _c;
        if (focusField === void 0) { focusField = 'title'; }
        if (!meetup)
            return;
        setEditTitle(meetup.title);
        setEditLocation((_a = meetup.locationName) !== null && _a !== void 0 ? _a : '');
        setEditDesc((_b = meetup.description) !== null && _b !== void 0 ? _b : '');
        if (meetup.approximateDate) {
            setEditDate(new Date(meetup.approximateDate + 'T12:00:00'));
        }
        else if (meetup.startsAt) {
            setEditDate(new Date(meetup.startsAt));
        }
        else {
            setEditDate(null);
        }
        setEditExactTime(meetup.startsAt ? new Date(meetup.startsAt) : null);
        setEditTimeBlock(meetup.startsAt ? null : ((_c = meetup.timeBlock) !== null && _c !== void 0 ? _c : null));
        setEditFocusField(focusField);
        setEditing(true);
    }
    (0, react_1.useEffect)(function () {
        if (editing && editFocusField === 'location') {
            var t_1 = setTimeout(function () { var _a; return (_a = locationInputRef.current) === null || _a === void 0 ? void 0 : _a.focus(); }, 100);
            return function () { return clearTimeout(t_1); };
        }
    }, [editing, editFocusField]);
    function handleSaveEdit() {
        return __awaiter(this, void 0, void 0, function () {
            var newStartsAt, res;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!id || !meetup || actioning)
                            return [2 /*return*/];
                        setActioning('edit');
                        newStartsAt = (editDate && editExactTime)
                            ? combineDateTime(editDate, editExactTime)
                            : null;
                        return [4 /*yield*/, (0, meetups_1.updateMeetup)(id, {
                                title: editTitle.trim() || meetup.title,
                                locationName: editLocation.trim() || null,
                                description: editDesc.trim() || null,
                                approximateDate: editDate ? toISODate(editDate) : null,
                                timeBlock: editExactTime ? null : editTimeBlock,
                                startsAt: newStartsAt,
                            })];
                    case 1:
                        res = _b.sent();
                        setActioning(null);
                        if (res.ok) {
                            setMeetup(function (prev) { return prev ? __assign(__assign({}, prev), { title: editTitle.trim() || prev.title, locationName: editLocation.trim() || null, description: editDesc.trim() || null, approximateDate: editDate ? toISODate(editDate) : null, timeBlock: editExactTime ? null : editTimeBlock, startsAt: newStartsAt }) : prev; });
                            setEditing(false);
                        }
                        else {
                            react_native_1.Alert.alert('Error', (_a = res.message) !== null && _a !== void 0 ? _a : 'Could not save changes');
                        }
                        return [2 /*return*/];
                }
            });
        });
    }
    var appStateRef = (0, react_1.useRef)(react_native_1.AppState.currentState);
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!id)
                        return [2 /*return*/];
                    setLoading(true);
                    setError(null);
                    return [4 /*yield*/, (0, meetups_1.getMeetup)(id)];
                case 1:
                    res = _b.sent();
                    setLoading(false);
                    if (res.ok && res.data)
                        setMeetup(res.data);
                    else
                        setError((_a = res.message) !== null && _a !== void 0 ? _a : 'Failed to load meetup');
                    return [2 /*return*/];
            }
        });
    }); }, [id]);
    var silentPoll = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!id || appStateRef.current !== 'active')
                        return [2 /*return*/];
                    return [4 /*yield*/, (0, meetups_1.getMeetup)(id)];
                case 1:
                    res = _a.sent();
                    if (!res.ok || !res.data)
                        return [2 /*return*/];
                    setMeetup(function (prev) {
                        var _a, _b, _c, _d;
                        if (!prev)
                            return prev;
                        return __assign(__assign({}, prev), { counts: res.data.counts, myRsvp: (_a = res.data.myRsvp) !== null && _a !== void 0 ? _a : prev.myRsvp, timeOptions: (_b = res.data.timeOptions) !== null && _b !== void 0 ? _b : prev.timeOptions, goingAttendees: (_c = res.data.goingAttendees) !== null && _c !== void 0 ? _c : prev.goingAttendees, totalGoing: (_d = res.data.totalGoing) !== null && _d !== void 0 ? _d : prev.totalGoing });
                    });
                    return [2 /*return*/];
            }
        });
    }); }, [id]);
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () { load(); }, [load]));
    (0, react_1.useEffect)(function () {
        var sub = react_native_1.AppState.addEventListener('change', function (next) {
            appStateRef.current = next;
        });
        var timer = setInterval(silentPoll, 10000);
        return function () {
            sub.remove();
            clearInterval(timer);
        };
    }, [silentPoll]);
    function handleRsvp(status) {
        return __awaiter(this, void 0, void 0, function () {
            var res;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!id || actioning)
                            return [2 /*return*/];
                        setActioning("rsvp_".concat(status));
                        return [4 /*yield*/, (0, meetups_1.rsvpMeetup)(id, status)];
                    case 1:
                        res = _b.sent();
                        if (res.ok && res.data) {
                            setMeetup(function (prev) { return prev ? __assign(__assign({}, prev), { myRsvp: res.data.status, counts: res.data.counts }) : prev; });
                        }
                        else {
                            react_native_1.Alert.alert('Error', (_a = res.message) !== null && _a !== void 0 ? _a : 'Could not RSVP');
                        }
                        setActioning(null);
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleVote(optionId, vote) {
        return __awaiter(this, void 0, void 0, function () {
            var res;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!id || actioning)
                            return [2 /*return*/];
                        setActioning("vote_".concat(optionId, "_").concat(vote));
                        return [4 /*yield*/, (0, meetups_1.voteTimeOption)(id, optionId, vote)];
                    case 1:
                        res = _b.sent();
                        if (res.ok && res.data) {
                            setMeetup(function (prev) {
                                if (!prev)
                                    return prev;
                                return __assign(__assign({}, prev), { timeOptions: prev.timeOptions.map(function (o) {
                                        return o.id === optionId ? __assign(__assign({}, o), { votes: res.data.votes }) : o;
                                    }) });
                            });
                        }
                        else {
                            react_native_1.Alert.alert('Error', (_a = res.message) !== null && _a !== void 0 ? _a : 'Could not record vote');
                        }
                        setActioning(null);
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleConfirmTime(optionId) {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                if (!id || actioning)
                    return [2 /*return*/];
                react_native_1.Alert.alert('Confirm time?', 'This will mark the meetup as confirmed and notify all attendees.', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                        text: 'Confirm', style: 'default',
                        onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                            var res;
                            var _a;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0:
                                        setActioning("confirm_".concat(optionId));
                                        return [4 /*yield*/, (0, meetups_1.confirmTime)(id, optionId)];
                                    case 1:
                                        res = _b.sent();
                                        if (!res.ok) return [3 /*break*/, 3];
                                        return [4 /*yield*/, load()];
                                    case 2:
                                        _b.sent();
                                        react_native_1.Alert.alert('Confirmed!', 'The meetup time has been set.');
                                        return [3 /*break*/, 4];
                                    case 3:
                                        react_native_1.Alert.alert('Error', (_a = res.message) !== null && _a !== void 0 ? _a : 'Could not confirm time');
                                        _b.label = 4;
                                    case 4:
                                        setActioning(null);
                                        return [2 /*return*/];
                                }
                            });
                        }); },
                    },
                ]);
                return [2 /*return*/];
            });
        });
    }
    function handleAddToTrip() {
        var _a, _b;
        if (!meetup || !id)
            return;
        openPlanPicker({
            id: id,
            type: 'meetup',
            title: meetup.title,
            locationName: (_a = meetup.locationName) !== null && _a !== void 0 ? _a : undefined,
            confirmedTime: (_b = meetup.startsAt) !== null && _b !== void 0 ? _b : undefined,
        });
    }
    function handleCancel() {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                if (!id || actioning)
                    return [2 /*return*/];
                react_native_1.Alert.alert('Cancel meetup?', 'All invitees will see this meetup as cancelled.', [
                    { text: 'Keep', style: 'cancel' },
                    {
                        text: 'Cancel meetup', style: 'destructive',
                        onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                            var res;
                            var _a;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0:
                                        setActioning('cancel');
                                        return [4 /*yield*/, (0, meetups_1.cancelMeetup)(id)];
                                    case 1:
                                        res = _b.sent();
                                        setActioning(null);
                                        if (res.ok) {
                                            expo_router_1.router.back();
                                        }
                                        else
                                            react_native_1.Alert.alert('Error', (_a = res.message) !== null && _a !== void 0 ? _a : 'Could not cancel meetup');
                                        return [2 /*return*/];
                                }
                            });
                        }); },
                    },
                ]);
                return [2 /*return*/];
            });
        });
    }
    if (loading) {
        return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper, alignItems: 'center', justifyContent: 'center' }}>
        <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
      </react_native_1.View>);
    }
    if (error || !meetup) {
        return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
        <react_native_1.View style={[s.header, { paddingTop: insets.top + tokens_1.space.sm }]}>
          <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}><lucide_react_native_1.ArrowLeft size={20} color={tokens_1.color.ink}/></react_native_1.Pressable>
          <react_native_1.Text style={s.headerTitle}>Meetup</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.View style={s.center}>
          <react_native_1.Text style={s.errText}>{error !== null && error !== void 0 ? error : 'Meetup not found'}</react_native_1.Text>
          <react_native_1.Pressable style={s.retryBtn} onPress={load}><react_native_1.Text style={s.retryText}>Retry</react_native_1.Text></react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.View>);
    }
    var sc = (_a = STATUS_COLORS[meetup.status]) !== null && _a !== void 0 ? _a : STATUS_COLORS.active;
    var isCancelled = meetup.status === 'cancelled';
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <react_native_1.View style={[s.header, { paddingTop: insets.top + tokens_1.space.sm }]}>
        <react_native_1.Pressable onPress={function () { if (editing) {
        setEditing(false);
    }
    else {
        expo_router_1.router.back();
    } }} hitSlop={8}>
          {editing ? <lucide_react_native_1.X size={20} color={tokens_1.color.ink}/> : <lucide_react_native_1.ArrowLeft size={20} color={tokens_1.color.ink}/>}
        </react_native_1.Pressable>
        <react_native_1.Text style={s.headerTitle} numberOfLines={1}>{editing ? 'Edit Meetup' : meetup.title}</react_native_1.Text>
        {editing ? (<react_native_1.Pressable style={[s.editSaveBtn, actioning === 'edit' && { opacity: 0.6 }]} onPress={handleSaveEdit} disabled={actioning === 'edit'}>
            {actioning === 'edit'
                ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>
                : <react_native_1.Text style={s.editSaveBtnText}>Save</react_native_1.Text>}
          </react_native_1.Pressable>) : meetup.isCreator && !isCancelled ? (<react_native_1.View style={{ flexDirection: 'row', gap: tokens_1.space.sm }}>
            <react_native_1.Pressable style={s.editChip} onPress={function () { return startEdit(); }}>
              <lucide_react_native_1.Pencil size={13} color={tokens_1.color.ink}/>
              <react_native_1.Text style={s.editChipText}>Edit</react_native_1.Text>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={s.cancelChip} onPress={handleCancel} disabled={actioning === 'cancel'}>
              <react_native_1.Text style={s.cancelChipText}>Cancel</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>) : null}
      </react_native_1.View>

      <react_native_1.ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Confirmed time banner — visible without scrolling on any phone */}
        <ConfirmedTimeBanner meetup={meetup}/>

        {/* Status + title (edit mode or view mode) */}
        {editing ? (<react_native_1.KeyboardAvoidingView behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined}>
            <react_native_1.View style={s.card}>
              <react_native_1.Text style={s.editLabel}>Title</react_native_1.Text>
              <react_native_1.TextInput style={s.editInput} value={editTitle} onChangeText={setEditTitle} placeholder="Meetup title" placeholderTextColor={tokens_1.color.faint} maxLength={200} autoFocus={editFocusField === 'title'}/>
              <react_native_1.Text style={s.editLabel}>Location (optional)</react_native_1.Text>
              <react_native_1.TextInput ref={locationInputRef} style={s.editInput} value={editLocation} onChangeText={setEditLocation} placeholder="Where?" placeholderTextColor={tokens_1.color.faint} maxLength={300}/>
              <react_native_1.View style={s.editLabelRow}>
                <react_native_1.Text style={s.editLabel}>Date (optional)</react_native_1.Text>
                {editDate && (<react_native_1.Pressable onPress={function () { setEditDate(null); setEditExactTime(null); setEditTimeBlock(null); }}>
                    <react_native_1.Text style={s.clearTimeText}>Clear</react_native_1.Text>
                  </react_native_1.Pressable>)}
              </react_native_1.View>
              <DateTimePickerField_1.DatePickerField value={editDate} onChange={setEditDate} minimumDate={TODAY_START} placeholder="Pick a date"/>
              <react_native_1.Text style={s.editLabel}>Exact time (optional)</react_native_1.Text>
              <DateTimePickerField_1.DatePickerField mode="time" value={editExactTime} onChange={function (t) { setEditExactTime(t); setEditTimeBlock(null); }} onClear={function () { return setEditExactTime(null); }} placeholder="Pick a time"/>
              <react_native_1.Text style={s.editLabel}>
                {editExactTime ? 'Time of day (overridden by exact time above)' : 'Time of day (optional)'}
              </react_native_1.Text>
              <react_native_1.View style={[s.blockRow, editExactTime ? { opacity: 0.35 } : null]}>
                {BLOCK_OPTIONS.map(function (opt) {
                var active = !editExactTime && editTimeBlock === opt.key;
                return (<react_native_1.Pressable key={opt.key} style={[s.blockBtn, active && s.blockBtnActive]} onPress={function () { if (!editExactTime)
                    setEditTimeBlock(active ? null : opt.key); }}>
                      <react_native_1.Text style={[s.blockBtnText, active && s.blockBtnTextActive]}>
                        {opt.label}
                      </react_native_1.Text>
                    </react_native_1.Pressable>);
            })}
              </react_native_1.View>
              <react_native_1.Text style={s.editLabel}>Description (optional)</react_native_1.Text>
              <react_native_1.TextInput style={[s.editInput, s.editInputMulti]} value={editDesc} onChangeText={setEditDesc} placeholder="Add details…" placeholderTextColor={tokens_1.color.faint} maxLength={1000} multiline numberOfLines={3}/>
            </react_native_1.View>
          </react_native_1.KeyboardAvoidingView>) : (<react_native_1.View style={s.card}>
            <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginBottom: tokens_1.space.sm }}>
              <react_native_1.View style={[s.statusPill, { backgroundColor: sc.bg }]}>
                <react_native_1.Text style={[s.statusText, { color: sc.fg }]}>{meetup.status.toUpperCase()}</react_native_1.Text>
              </react_native_1.View>
              {meetup.tripId && <react_native_1.Text style={s.scopeTag}>🗺 Trip meetup</react_native_1.Text>}
              {meetup.circleOwnerId && <react_native_1.Text style={s.scopeTag}>⭕ Circle meetup</react_native_1.Text>}
            </react_native_1.View>
            <react_native_1.Text style={s.title}>{meetup.title}</react_native_1.Text>
            {meetup.description ? <react_native_1.Text style={s.desc}>{meetup.description}</react_native_1.Text> : null}

            {/* Creator row */}
            {meetup.creator ? (<react_native_1.Pressable style={s.creatorRow} onPress={function () { var _a; if ((_a = meetup.creator) === null || _a === void 0 ? void 0 : _a.handle)
                expo_router_1.router.push("/u/".concat(meetup.creator.handle)); }} disabled={!meetup.creator.handle}>
                {meetup.creator.avatarUrl ? (<react_native_1.Image source={{ uri: meetup.creator.avatarUrl }} style={s.creatorAvatar}/>) : (<react_native_1.View style={[s.creatorAvatar, s.creatorAvatarFallback]}>
                    <react_native_1.Text style={s.creatorInitial}>
                      {((_b = meetup.creator.displayName) !== null && _b !== void 0 ? _b : '?').charAt(0).toUpperCase()}
                    </react_native_1.Text>
                  </react_native_1.View>)}
                <react_native_1.Text style={s.creatorName} numberOfLines={1}>
                  Organised by {(_c = meetup.creator.displayName) !== null && _c !== void 0 ? _c : 'someone'}
                </react_native_1.Text>
              </react_native_1.Pressable>) : (<react_native_1.Text style={s.creatorFallback}>Organised by someone</react_native_1.Text>)}

            {meetup.locationName ? (<react_native_1.View style={s.metaRow}>
                <lucide_react_native_1.MapPin size={14} color={tokens_1.color.mute}/>
                <react_native_1.Text style={s.metaText}>{meetup.locationName}</react_native_1.Text>
              </react_native_1.View>) : meetup.isCreator && meetup.status === 'confirmed' && !isCancelled ? (<react_native_1.View style={s.noDateRow}>
                <lucide_react_native_1.MapPin size={14} color={tokens_1.color.faint}/>
                <react_native_1.Text style={s.noDateText}>No location set</react_native_1.Text>
                <react_native_1.Pressable style={s.noDateChip} onPress={function () { return startEdit('location'); }}>
                  <react_native_1.Text style={s.noDateChipText}>Add one?</react_native_1.Text>
                </react_native_1.Pressable>
              </react_native_1.View>) : !meetup.isCreator ? (<react_native_1.View style={s.metaRow}>
                <lucide_react_native_1.MapPin size={14} color={tokens_1.color.faint}/>
                <react_native_1.Text style={s.locTbdText}>Location TBD</react_native_1.Text>
              </react_native_1.View>) : null}

            {((_d = meetup.startsAt) !== null && _d !== void 0 ? _d : meetup.approximateDate) ? (<react_native_1.View style={s.metaRow}>
                <lucide_react_native_1.CalendarClock size={14} color={tokens_1.color.mute}/>
                <react_native_1.Text style={s.metaText}>
                  {meetup.startsAt
                    ? relDateTime(meetup.startsAt)
                    : "".concat(relDate((_e = meetup.approximateDate) !== null && _e !== void 0 ? _e : '')).concat(meetup.timeBlock ? " \u00B7 ".concat((_f = BLOCK_LABELS[meetup.timeBlock]) !== null && _f !== void 0 ? _f : meetup.timeBlock) : '')}
                </react_native_1.Text>
              </react_native_1.View>) : meetup.isCreator && !isCancelled ? (<react_native_1.View style={s.noDateRow}>
                <lucide_react_native_1.CalendarClock size={14} color={tokens_1.color.faint}/>
                <react_native_1.Text style={s.noDateText}>No date set</react_native_1.Text>
                <react_native_1.Pressable style={s.noDateChip} onPress={function () { return startEdit(); }}>
                  <react_native_1.Text style={s.noDateChipText}>Add</react_native_1.Text>
                </react_native_1.Pressable>
              </react_native_1.View>) : null}
          </react_native_1.View>)}

        {/* Attendee counts */}
        <react_native_1.View style={s.card}>
          <react_native_1.Text style={s.sectionTitle}>Responses</react_native_1.Text>
          <react_native_1.View style={s.countsRow}>
            {[
            { label: 'Going', count: meetup.counts.going, color: '#16A34A' },
            { label: 'Maybe', count: meetup.counts.maybe, color: tokens_1.color.mute },
            { label: "Can't go", count: meetup.counts.declined, color: '#DC2626' },
            { label: 'Pending', count: meetup.counts.pending, color: tokens_1.color.faint },
        ].map(function (c) { return (<react_native_1.View key={c.label} style={s.countItem}>
                <react_native_1.Text style={[s.countNum, { color: c.color }]}>{c.count}</react_native_1.Text>
                <react_native_1.Text style={s.countLabel}>{c.label}</react_native_1.Text>
              </react_native_1.View>); })}
          </react_native_1.View>
        </react_native_1.View>

        {/* RSVP — single unconfirmed slot: 2 options only (Going / Can't go) */}
        {!isCancelled && isAuthed ? (<react_native_1.View style={s.card}>
            <react_native_1.Text style={s.sectionTitle}>Your RSVP</react_native_1.Text>
            <react_native_1.View style={s.rsvpRow}>
              {(meetup.timeOptions.length === 1 && !meetup.timeOptions[0].confirmed
                ? RSVP_OPTIONS.filter(function (o) { return o.key !== 'maybe'; })
                : RSVP_OPTIONS).map(function (opt) {
                var isSelected = meetup.myRsvp === opt.key;
                var isLoading = actioning === "rsvp_".concat(opt.key);
                return (<react_native_1.Pressable key={opt.key} style={[s.rsvpBtn, isSelected && s.rsvpBtnActive]} onPress={function () { return handleRsvp(opt.key); }} disabled={!!actioning}>
                    {isLoading
                        ? <react_native_1.ActivityIndicator size="small" color={isSelected ? tokens_1.color.onInk : tokens_1.color.signal}/>
                        : <react_native_1.Text style={s.rsvpEmoji}>{opt.emoji}</react_native_1.Text>}
                    <react_native_1.Text style={[s.rsvpLabel, isSelected && s.rsvpLabelActive]}>{opt.label}</react_native_1.Text>
                    {isSelected && <lucide_react_native_1.Check size={12} color={tokens_1.color.onInk}/>}
                  </react_native_1.Pressable>);
            })}
            </react_native_1.View>
          </react_native_1.View>) : null}

        {/* Time: single proposed → skip voting, show direct RSVP prompt */}
        {meetup.timeOptions.length === 1 && !meetup.timeOptions[0].confirmed && !isCancelled ? (<react_native_1.View style={s.card}>
            <react_native_1.Text style={s.sectionTitle}>Proposed Time</react_native_1.Text>
            <react_native_1.View style={s.optionCard}>
              <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <lucide_react_native_1.CalendarClock size={14} color={tokens_1.color.signal}/>
                <react_native_1.Text style={s.optionDate}>{relDate(meetup.timeOptions[0].proposedDate)}</react_native_1.Text>
                <react_native_1.Text style={s.optionBlock}>{timeOptionPill(meetup.timeOptions[0])}</react_native_1.Text>
              </react_native_1.View>
              {meetup.timeOptions[0].label ? <react_native_1.Text style={s.optionLabel}>{meetup.timeOptions[0].label}</react_native_1.Text> : null}
              <react_native_1.Text style={s.voteHint}>Use the RSVP section above to confirm attendance</react_native_1.Text>
            </react_native_1.View>
            {meetup.isCreator && (<react_native_1.Pressable style={[s.confirmBtn, { alignSelf: 'flex-end', marginTop: 4 }]} onPress={function () { return handleConfirmTime(meetup.timeOptions[0].id); }} disabled={!!actioning}>
                {actioning === "confirm_".concat(meetup.timeOptions[0].id)
                    ? <react_native_1.ActivityIndicator size="small" color="#16A34A"/>
                    : <lucide_react_native_1.Check size={12} color="#16A34A"/>}
                <react_native_1.Text style={s.confirmBtnText}>Confirm time</react_native_1.Text>
              </react_native_1.Pressable>)}
          </react_native_1.View>) : meetup.timeOptions.length > 0 ? (
        /* Multiple options (or already confirmed): show full voting poll */
        <react_native_1.View style={s.card}>
            <react_native_1.Text style={s.sectionTitle}>Time Poll</react_native_1.Text>
            {meetup.timeOptions.map(function (opt) { return (<react_native_1.View key={opt.id} style={[s.optionCard, opt.confirmed && s.optionCardWinner]}>
                <react_native_1.View style={{ flex: 1 }}>
                  <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    {opt.confirmed && <lucide_react_native_1.Trophy size={13} color="#16A34A"/>}
                    <react_native_1.Text style={s.optionDate}>{relDate(opt.proposedDate)}</react_native_1.Text>
                    <react_native_1.Text style={s.optionBlock}>{timeOptionPill(opt)}</react_native_1.Text>
                  </react_native_1.View>
                  {opt.label ? <react_native_1.Text style={s.optionLabel}>{opt.label}</react_native_1.Text> : null}
                  <VoteBar votes={opt.votes}/>
                </react_native_1.View>
                {!isCancelled && !opt.confirmed && (<react_native_1.View style={s.voteRow}>
                    {['yes', 'maybe', 'no'].map(function (v) {
                        var icons = {
                            yes: <lucide_react_native_1.ThumbsUp size={13} color={opt.votes.myVote === 'yes' ? tokens_1.color.onInk : '#16A34A'}/>,
                            maybe: <lucide_react_native_1.Minus size={13} color={opt.votes.myVote === 'maybe' ? tokens_1.color.onInk : tokens_1.color.mute}/>,
                            no: <lucide_react_native_1.ThumbsDown size={13} color={opt.votes.myVote === 'no' ? tokens_1.color.onInk : '#DC2626'}/>,
                        };
                        var isActive = opt.votes.myVote === v;
                        var bgMap = { yes: '#DCFCE7', maybe: tokens_1.color.haze, no: '#FEE2E2' };
                        return (<react_native_1.Pressable key={v} style={[s.voteBtn, { backgroundColor: isActive ? tokens_1.color.signal : bgMap[v] }]} onPress={function () { return handleVote(opt.id, v); }} disabled={!!actioning}>
                          {actioning === "vote_".concat(opt.id, "_").concat(v)
                                ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>
                                : icons[v]}
                        </react_native_1.Pressable>);
                    })}
                    {meetup.isCreator && (<react_native_1.Pressable style={s.confirmBtn} onPress={function () { return handleConfirmTime(opt.id); }} disabled={!!actioning}>
                        <lucide_react_native_1.Check size={12} color="#16A34A"/>
                        <react_native_1.Text style={s.confirmBtnText}>Confirm</react_native_1.Text>
                      </react_native_1.Pressable>)}
                  </react_native_1.View>)}
              </react_native_1.View>); })}
          </react_native_1.View>) : null}

        {/* Add to trip plan — only for confirmed meetups */}
        {meetup.status === 'confirmed' && isAuthed && (<react_native_1.Pressable style={[s.addPlanBtn, isAdded(meetup.id) && s.addPlanBtnAdded]} onPress={isAdded(meetup.id) ? undefined : handleAddToTrip} disabled={isAdded(meetup.id)}>
            {isAdded(meetup.id)
                ? <lucide_react_native_1.Check size={16} color={tokens_1.color.onInk}/>
                : <lucide_react_native_1.Plus size={16} color={tokens_1.color.onInk}/>}
            <react_native_1.Text style={s.addPlanBtnText}>
              {isAdded(meetup.id) ? 'In Plan ✓' : 'Add to Trip Plan'}
            </react_native_1.Text>
          </react_native_1.Pressable>)}

        {/* View trip */}
        {meetup.tripId && (<react_native_1.Pressable style={s.linkBtn} onPress={function () { return expo_router_1.router.push("/trip/".concat(meetup.tripId)); }}>
            <react_native_1.Text style={s.linkBtnText}>View trip ›</react_native_1.Text>
          </react_native_1.Pressable>)}

      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var s = react_native_1.StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.md, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    headerTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, flex: 1, fontWeight: '700' }),
    cancelChip: { paddingHorizontal: tokens_1.space.sm, paddingVertical: 5, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: '#DC2626' },
    cancelChipText: __assign(__assign({}, tokens_1.type.small), { color: '#DC2626', fontWeight: '700' }),
    editChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: tokens_1.space.sm, paddingVertical: 5, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper },
    editChipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '700' }),
    editSaveBtn: { paddingHorizontal: tokens_1.space.md, paddingVertical: 6, borderRadius: tokens_1.radius.pill, backgroundColor: tokens_1.color.signal, minWidth: 52, alignItems: 'center', justifyContent: 'center' },
    editSaveBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
    editLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600', marginBottom: 4, marginTop: tokens_1.space.sm }),
    editInput: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, minHeight: 42 }),
    editInputMulti: { minHeight: 80, textAlignVertical: 'top', paddingTop: tokens_1.space.sm },
    blockRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    blockBtn: { paddingHorizontal: tokens_1.space.md, paddingVertical: 7, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper },
    blockBtnActive: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    blockBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    blockBtnTextActive: { color: tokens_1.color.onInk },
    clearTimeText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', textAlign: 'right', marginTop: 2 }),
    editLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    scroll: { padding: tokens_1.space.lg, gap: tokens_1.space.md, paddingBottom: tokens_1.space.xxxl },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.md },
    errText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    retryBtn: { paddingHorizontal: tokens_1.space.xl, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.signal },
    retryText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal }),
    card: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md, gap: tokens_1.space.sm }, tokens_1.shadow.card),
    statusPill: { paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.pill },
    statusText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
    scopeTag: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 22 }),
    desc: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, lineHeight: 20 }),
    creatorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
    creatorAvatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: tokens_1.color.haze },
    creatorAvatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.signal + '22' },
    creatorInitial: { fontSize: 10, fontWeight: '700', color: tokens_1.color.signal },
    creatorName: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, flex: 1 }),
    creatorFallback: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 12, marginTop: 6 }),
    sectionTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700', marginBottom: 4 }),
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    metaText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    noDateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    noDateText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.faint, flex: 1 }),
    noDateChip: { paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper },
    noDateChipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
    locTbdText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.faint, fontStyle: 'italic' }),
    countsRow: { flexDirection: 'row', gap: tokens_1.space.lg },
    countItem: { alignItems: 'center', gap: 2 },
    countNum: __assign(__assign({}, tokens_1.type.title), { fontSize: 22, fontWeight: '700' }),
    countLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    rsvpRow: { flexDirection: 'row', gap: tokens_1.space.sm, flexWrap: 'wrap' },
    rsvpBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm + 2, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper, minHeight: 38 },
    rsvpBtnActive: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    rsvpEmoji: { fontSize: 14 },
    rsvpLabel: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    rsvpLabelActive: { color: tokens_1.color.onInk },
    optionCard: { backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md, marginBottom: tokens_1.space.sm, gap: tokens_1.space.sm },
    optionCardWinner: { borderColor: '#16A34A', backgroundColor: '#F0FDF4' },
    optionDate: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700' }),
    optionBlock: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, backgroundColor: tokens_1.color.haze, paddingHorizontal: 6, paddingVertical: 2, borderRadius: tokens_1.radius.sm, fontSize: 11 }),
    optionLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    voteRow: { flexDirection: 'row', gap: tokens_1.space.sm, alignItems: 'center' },
    voteBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
    confirmBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: tokens_1.space.md, paddingVertical: 6, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: '#16A34A', marginLeft: 'auto' },
    confirmBtnText: __assign(__assign({}, tokens_1.type.small), { color: '#16A34A', fontWeight: '700', fontSize: 11 }),
    voteHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11, marginTop: 4 }),
    addPlanBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md },
    addPlanBtnAdded: { backgroundColor: tokens_1.color.deep, opacity: 0.75 },
    addPlanBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
    linkBtn: { alignItems: 'center', paddingVertical: tokens_1.space.sm },
    linkBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal }),
});
