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
exports.default = Notifications;
/**
 * Request Inbox — unified view of all social requests + meetup invites.
 *
 * Incoming tab:
 *   - friend requests, circle invites, trip invites, message requests (social)
 *   - meetup invites (RSVP Going / Maybe / Can't go)
 * Outgoing tab: requests you sent with status history and Cancel
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var useRequests_1 = require("../src/hooks/useRequests");
var useMessaging_1 = require("../src/hooks/useMessaging");
var requests_1 = require("../src/services/requests");
var messaging_1 = require("../src/services/messaging");
var meetups_1 = require("../src/services/meetups");
var availability_1 = require("../src/services/availability");
var tokens_1 = require("../src/theme/tokens");
function relativeTime(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1)
        return 'just now';
    var hours = Math.floor(diff / 3600000);
    if (hours < 1)
        return "".concat(mins, "m ago");
    var days = Math.floor(diff / 86400000);
    if (days < 1)
        return "".concat(hours, "h ago");
    if (days < 30)
        return "".concat(days, "d ago");
    return new Date(iso).toLocaleDateString();
}
var STATUS_COLORS = {
    pending: { bg: tokens_1.color.haze, text: tokens_1.color.mute },
    invited: { bg: tokens_1.color.haze, text: tokens_1.color.mute },
    accepted: { bg: '#DCFCE7', text: '#16A34A' },
    friends: { bg: '#DCFCE7', text: '#16A34A' },
    member: { bg: '#DCFCE7', text: '#16A34A' },
    going: { bg: '#DCFCE7', text: '#16A34A' },
    maybe: { bg: '#FEF9C3', text: '#A16207' },
    declined: { bg: tokens_1.color.paperRaised, text: tokens_1.color.mute },
    cancelled: { bg: tokens_1.color.paperRaised, text: tokens_1.color.mute },
};
function StatusChip(_a) {
    var _b;
    var status = _a.status;
    var c = (_b = STATUS_COLORS[status]) !== null && _b !== void 0 ? _b : STATUS_COLORS.pending;
    return (<react_native_1.View style={[styles.statusChip, { backgroundColor: c.bg }]}>
      <react_native_1.Text style={[styles.statusChipText, { color: c.text }]}>{status}</react_native_1.Text>
    </react_native_1.View>);
}
function SkeletonRow() {
    return (<react_native_1.View style={[styles.row, { opacity: 0.4 }]}>
      <react_native_1.View style={[styles.iconBadge, { backgroundColor: tokens_1.color.haze }]}/>
      <react_native_1.View style={[styles.avatar, { backgroundColor: tokens_1.color.haze }]}/>
      <react_native_1.View style={{ flex: 1, gap: 7 }}>
        <react_native_1.View style={{ height: 13, backgroundColor: tokens_1.color.haze, borderRadius: 4, width: '70%' }}/>
        <react_native_1.View style={{ height: 11, backgroundColor: tokens_1.color.haze, borderRadius: 4, width: '45%' }}/>
        <react_native_1.View style={{ height: 30, backgroundColor: tokens_1.color.haze, borderRadius: 999, width: '50%', marginTop: 2 }}/>
      </react_native_1.View>
    </react_native_1.View>);
}
function Avatar(_a) {
    var url = _a.url, name = _a.name;
    if (url)
        return <react_native_1.Image source={{ uri: url }} style={styles.avatar}/>;
    return (<react_native_1.View style={[styles.avatar, styles.avatarFallback]}>
      <react_native_1.Text style={styles.avatarInitial}>{((name !== null && name !== void 0 ? name : '?')[0]).toUpperCase()}</react_native_1.Text>
    </react_native_1.View>);
}
function TypeIcon(_a) {
    var type = _a.type;
    if (type === 'friend_request')
        return <lucide_react_native_1.UserPlus size={18} color={tokens_1.color.deep}/>;
    if (type === 'circle_invite')
        return <lucide_react_native_1.Users size={18} color={tokens_1.color.signal}/>;
    if (type === 'trip_invite')
        return <lucide_react_native_1.Plane size={18} color={tokens_1.color.signal}/>;
    if (type === 'meetup_invite')
        return <lucide_react_native_1.CalendarClock size={18} color={tokens_1.color.signal}/>;
    return <lucide_react_native_1.MessageCircle size={18} color={tokens_1.color.signal}/>;
}
function fmtNudgeDate(dateStr) {
    // dateStr is YYYY-MM-DD (date only, interpret as UTC noon to avoid off-by-one)
    var d = new Date(dateStr + 'T12:00:00Z');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function NudgeRow(_a) {
    var _b, _c, _d;
    var nudge = _a.nudge;
    var name = (_c = (_b = nudge.senderName) !== null && _b !== void 0 ? _b : nudge.senderHandle) !== null && _c !== void 0 ? _c : 'Someone';
    var dateLabel = fmtNudgeDate(nudge.nudgeDate);
    var subtitle = nudge.tripTitle
        ? "".concat(nudge.tripTitle).concat(nudge.destinationCity ? " \u00B7 ".concat(nudge.destinationCity) : '')
        : ((_d = nudge.destinationCity) !== null && _d !== void 0 ? _d : 'a shared trip');
    return (<react_native_1.Pressable style={styles.row} onPress={function () { return expo_router_1.router.push({ pathname: '/trip/[id]', params: { id: nudge.tripId } }); }}>
      <react_native_1.View style={[styles.iconBadge, { backgroundColor: '#EEF6FF' }]}>
        <lucide_react_native_1.CalendarClock size={18} color="#2563EB"/>
      </react_native_1.View>
      {nudge.senderAvatarUrl ? (<react_native_1.Image source={{ uri: nudge.senderAvatarUrl }} style={styles.avatar}/>) : (<react_native_1.View style={[styles.avatar, styles.avatarFallback]}>
          <react_native_1.Text style={styles.avatarInitial}>{name[0].toUpperCase()}</react_native_1.Text>
        </react_native_1.View>)}
      <react_native_1.View style={{ flex: 1, gap: 3 }}>
        <react_native_1.Text style={styles.rowText}>
          <react_native_1.Text style={{ fontWeight: '700' }}>{name}</react_native_1.Text>
          {" is free ".concat(dateLabel, " \u2014 are you?")}
        </react_native_1.Text>
        <react_native_1.Text style={styles.meta}>{subtitle}</react_native_1.Text>
        <react_native_1.Text style={[styles.meta, { color: '#2563EB' }]}>Tap to view availability ›</react_native_1.Text>
        <react_native_1.Text style={styles.meta}>{relativeTime(nudge.createdAt)}</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.Pressable>);
}
function describeItem(item, direction) {
    var _a, _b, _c, _d;
    var who = (_d = (_b = (_a = item.actor) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : (_c = item.actor) === null || _c === void 0 ? void 0 : _c.handle) !== null && _d !== void 0 ? _d : 'Someone';
    if (direction === 'incoming') {
        if (item.type === 'friend_request')
            return "".concat(who, " sent you a friend request");
        if (item.type === 'circle_invite')
            return "".concat(who, " invited you to their Travel Circle");
        if (item.type === 'trip_invite')
            return "".concat(who, " invited you to join").concat(item.targetName ? " \"".concat(item.targetName, "\"") : ' a trip');
    }
    else {
        if (item.type === 'friend_request')
            return "Friend request sent to ".concat(who);
        if (item.type === 'circle_invite')
            return "Circle invite sent to ".concat(who);
        if (item.type === 'trip_invite')
            return "Trip invite sent to ".concat(who).concat(item.targetName ? " for \"".concat(item.targetName, "\"") : '');
    }
    return '';
}
function ActorMeta(_a) {
    var handle = _a.handle, createdAt = _a.createdAt;
    return (<react_native_1.Text style={styles.meta}>
      {handle ? "@".concat(handle, " \u00B7 ") : ''}{relativeTime(createdAt)}
    </react_native_1.Text>);
}
function ActionRow(_a) {
    var children = _a.children;
    return <react_native_1.View style={styles.actionsRow}>{children}</react_native_1.View>;
}
function AcceptBtn(_a) {
    var onPress = _a.onPress, busy = _a.busy;
    return (<react_native_1.Pressable style={[styles.acceptBtn, busy && styles.btnDim]} disabled={busy} onPress={onPress}>
      <react_native_1.Text style={styles.acceptBtnText}>Accept</react_native_1.Text>
    </react_native_1.Pressable>);
}
function DeclineBtn(_a) {
    var _b = _a.label, label = _b === void 0 ? 'Decline' : _b, onPress = _a.onPress, busy = _a.busy;
    return (<react_native_1.Pressable style={[styles.declineBtn, busy && styles.btnDim]} disabled={busy} onPress={onPress}>
      <react_native_1.Text style={styles.declineBtnText}>{label}</react_native_1.Text>
    </react_native_1.Pressable>);
}
// ── Meetup RSVP row ───────────────────────────────────────────────────────────
function MeetupInviteRow(_a) {
    var _b, _c, _d;
    var invite = _a.invite, busy = _a.busy, onRsvp = _a.onRsvp;
    var m = invite.meetup;
    var creator = invite.creator;
    var isConfirmation = invite.kind === 'confirmation';
    var isPending = invite.status === 'pending';
    if (isConfirmation) {
        return (<react_native_1.View style={styles.row}>
        <react_native_1.View style={[styles.iconBadge, { backgroundColor: '#DCFCE7' }]}>
          <lucide_react_native_1.CalendarClock size={18} color="#16A34A"/>
        </react_native_1.View>
        <react_native_1.View style={{ flex: 1, gap: 3 }}>
          <react_native_1.Text style={styles.rowText}>
            {'✅ Time confirmed'}
          </react_native_1.Text>
          {m ? (<react_native_1.Pressable onPress={function () { return expo_router_1.router.push("/meetup/".concat(m.id)); }}>
              <react_native_1.Text style={styles.meetupTitle} numberOfLines={1}>{m.title}</react_native_1.Text>
              {m.startsAt && (<react_native_1.Text style={styles.meetupMeta}>
                  🗓 {new Date(m.startsAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  {m.timeBlock ? " \u00B7 ".concat(m.timeBlock) : ''}
                </react_native_1.Text>)}
              {m.locationName && <react_native_1.Text style={styles.meetupMeta}>📍 {m.locationName}</react_native_1.Text>}
              <react_native_1.Text style={[styles.meta, { color: '#16A34A', marginTop: 2 }]}>Tap to view details ›</react_native_1.Text>
            </react_native_1.Pressable>) : null}
          <react_native_1.Text style={styles.meta}>{relativeTime(invite.invitedAt)}</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>);
    }
    return (<react_native_1.View style={styles.row}>
      <react_native_1.View style={styles.iconBadge}><TypeIcon type="meetup_invite"/></react_native_1.View>
      <react_native_1.View style={[styles.avatar, styles.avatarFallback]}>
        <react_native_1.Text style={styles.avatarInitial}>{(((_c = (_b = creator === null || creator === void 0 ? void 0 : creator.name) !== null && _b !== void 0 ? _b : creator === null || creator === void 0 ? void 0 : creator.handle) !== null && _c !== void 0 ? _c : '?')[0]).toUpperCase()}</react_native_1.Text>
      </react_native_1.View>
      <react_native_1.View style={{ flex: 1, gap: 3 }}>
        <react_native_1.Text style={styles.rowText}>
          <react_native_1.Text style={{ fontWeight: '700' }}>{(_d = creator === null || creator === void 0 ? void 0 : creator.name) !== null && _d !== void 0 ? _d : 'Someone'}</react_native_1.Text>
          {' invited you to a meetup'}
        </react_native_1.Text>
        {m ? (<react_native_1.Pressable onPress={function () { return expo_router_1.router.push("/meetup/".concat(m.id)); }}>
            <react_native_1.Text style={styles.meetupTitle} numberOfLines={1}>{m.title}</react_native_1.Text>
            {m.locationName && <react_native_1.Text style={styles.meetupMeta}>📍 {m.locationName}</react_native_1.Text>}
            {m.approximateDate && <react_native_1.Text style={styles.meetupMeta}>🗓 {m.approximateDate}{m.timeBlock ? " \u00B7 ".concat(m.timeBlock) : ''}</react_native_1.Text>}
          </react_native_1.Pressable>) : null}
        <react_native_1.Text style={styles.meta}>{relativeTime(invite.invitedAt)}</react_native_1.Text>
        {isPending ? (<ActionRow>
            <react_native_1.Pressable style={[styles.acceptBtn, busy && styles.btnDim]} disabled={busy} onPress={function () { return onRsvp('going'); }}>
              {busy ? <react_native_1.ActivityIndicator size="small" color="#fff"/> : null}
              <react_native_1.Text style={styles.acceptBtnText}>✅ Going</react_native_1.Text>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={[styles.maybeBtn, busy && styles.btnDim]} disabled={busy} onPress={function () { return onRsvp('maybe'); }}>
              <react_native_1.Text style={styles.maybeBtnText}>🤔 Maybe</react_native_1.Text>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={[styles.declineBtn, busy && styles.btnDim]} disabled={busy} onPress={function () { return onRsvp('declined'); }}>
              <react_native_1.Text style={styles.declineBtnText}>Can't go</react_native_1.Text>
            </react_native_1.Pressable>
          </ActionRow>) : (<react_native_1.View style={{ marginTop: 2 }}>
            <StatusChip status={invite.status}/>
          </react_native_1.View>)}
      </react_native_1.View>
    </react_native_1.View>);
}
// ── Main screen ───────────────────────────────────────────────────────────────
function Notifications() {
    var _this = this;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var requests = (0, useRequests_1.useRequests)();
    var msgReqs = (0, useMessaging_1.useIncomingMessageRequests)();
    var refreshUnreadCounts = (0, useMessaging_1.useUnreadCounts)().refresh;
    var _a = (0, react_1.useState)('incoming'), activeTab = _a[0], setActiveTab = _a[1];
    var _b = (0, react_1.useState)(null), actioning = _b[0], setActioning = _b[1];
    var everLoaded = (0, react_1.useRef)(false);
    var _c = (0, react_1.useState)([]), meetupInvites = _c[0], setMeetupInvites = _c[1];
    var _d = (0, react_1.useState)([]), availabilityNudges = _d[0], setAvailabilityNudges = _d[1];
    var loadMeetupInvites = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, meetups_1.getMyMeetupInvites)()];
                case 1:
                    res = _a.sent();
                    if (res.ok && res.data)
                        setMeetupInvites(res.data.invites);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var loadAvailabilityNudges = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, availability_1.getAvailabilityNudges)()];
                case 1:
                    res = _a.sent();
                    if (res.ok && res.data)
                        setAvailabilityNudges(res.data.nudges);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () {
        requests.reload();
        msgReqs.reload();
        loadMeetupInvites();
        loadAvailabilityNudges();
        (0, messaging_1.markNotificationsRead)().then(function () { return refreshUnreadCounts(); });
    }, [requests.reload, msgReqs.reload, loadMeetupInvites, loadAvailabilityNudges, refreshUnreadCounts]));
    var loading = requests.loading || msgReqs.loading;
    var error = requests.error || msgReqs.error;
    if (!loading)
        everLoaded.current = true;
    var showSkeleton = loading && !everLoaded.current;
    function doAction(id_1, fn_1) {
        return __awaiter(this, arguments, void 0, function (id, fn, reloadMsgs) {
            if (reloadMsgs === void 0) { reloadMsgs = false; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setActioning(id);
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, , 3, 4]);
                        return [4 /*yield*/, fn()];
                    case 2:
                        _a.sent();
                        requests.reload();
                        if (reloadMsgs)
                            msgReqs.reload();
                        return [3 /*break*/, 4];
                    case 3:
                        setActioning(null);
                        return [7 /*endfinally*/];
                    case 4: return [2 /*return*/];
                }
            });
        });
    }
    function handleMeetupRsvp(invite, status) {
        return __awaiter(this, void 0, void 0, function () {
            var key, res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        key = "meetup_".concat(invite.meetupId, "_").concat(status);
                        setActioning(key);
                        return [4 /*yield*/, (0, meetups_1.rsvpMeetup)(invite.meetupId, status)];
                    case 1:
                        res = _a.sent();
                        if (res.ok) {
                            setMeetupInvites(function (prev) {
                                return prev.map(function (i) { return i.meetupId === invite.meetupId ? __assign(__assign({}, i), { status: status }) : i; });
                            });
                        }
                        setActioning(null);
                        return [2 /*return*/];
                }
            });
        });
    }
    function renderIncoming() {
        var msgItems = msgReqs.data
            .map(function (m) { return ({ id: m.requestId, type: 'message_request', item: m }); });
        var socialItems = requests.incoming
            .map(function (r) { return ({ id: r.id, type: r.type, item: r }); });
        var all = __spreadArray(__spreadArray([], msgItems, true), socialItems, true);
        var nudgeSection = availabilityNudges.length > 0 ? (<react_native_1.View key="nudge_section">
        <react_native_1.View style={styles.sectionLabel}>
          <lucide_react_native_1.CalendarClock size={12} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.sectionLabelText}>Availability Nudges</react_native_1.Text>
        </react_native_1.View>
        {availabilityNudges.map(function (n) { return (<NudgeRow key={n.id} nudge={n}/>); })}
      </react_native_1.View>) : null;
        var meetupSection = meetupInvites.length > 0 ? (<react_native_1.View key="meetup_section">
        <react_native_1.View style={styles.sectionLabel}>
          <lucide_react_native_1.CalendarClock size={12} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.sectionLabelText}>Meetup Invites</react_native_1.Text>
        </react_native_1.View>
        {meetupInvites.map(function (inv) {
                var _a;
                return (<MeetupInviteRow key={inv.inviteId} invite={inv} busy={(_a = actioning === null || actioning === void 0 ? void 0 : actioning.startsWith("meetup_".concat(inv.meetupId))) !== null && _a !== void 0 ? _a : false} onRsvp={function (status) { return handleMeetupRsvp(inv, status); }}/>);
            })}
      </react_native_1.View>) : null;
        if (all.length === 0 && !meetupSection && !nudgeSection) {
            return (<react_native_1.View style={styles.emptyWrap}>
          <react_native_1.Text style={styles.emptyText}>All caught up! No pending requests.</react_native_1.Text>
        </react_native_1.View>);
        }
        return (<>
        {nudgeSection}
        {meetupSection}
        {all.length > 0 && (nudgeSection || meetupSection) && (<react_native_1.View style={styles.sectionLabel}>
            <react_native_1.Text style={styles.sectionLabelText}>Social Requests</react_native_1.Text>
          </react_native_1.View>)}
        {all.map(function (_a) {
                var _b, _c;
                var id = _a.id, type = _a.type, item = _a.item;
                var actor = type === 'message_request' ? item.sender : item.actor;
                var status = type === 'message_request' ? item.status : item.status;
                var isPending = status === 'pending' || status === 'invited';
                var busy = actioning === id;
                var createdAt = (_b = item.createdAt) !== null && _b !== void 0 ? _b : '';
                return (<react_native_1.View key={id} style={styles.row}>
              <react_native_1.View style={styles.iconBadge}><TypeIcon type={type}/></react_native_1.View>
              <Avatar url={actor === null || actor === void 0 ? void 0 : actor.avatarUrl} name={actor === null || actor === void 0 ? void 0 : actor.name}/>
              <react_native_1.View style={{ flex: 1, gap: 3 }}>
                <react_native_1.Text style={styles.rowText}>
                  {type === 'message_request'
                        ? <><react_native_1.Text style={{ fontWeight: '700' }}>{(_c = actor === null || actor === void 0 ? void 0 : actor.name) !== null && _c !== void 0 ? _c : 'Someone'}</react_native_1.Text>{' wants to message you'}</>
                        : describeItem(item, 'incoming')}
                </react_native_1.Text>
                <ActorMeta handle={actor === null || actor === void 0 ? void 0 : actor.handle} createdAt={createdAt}/>
                {type === 'message_request' && item.previewText ? (<react_native_1.Text style={styles.preview} numberOfLines={2}>"{item.previewText}"</react_native_1.Text>) : null}
                {isPending ? (<ActionRow>
                    <AcceptBtn busy={busy} onPress={function () {
                            if (type === 'message_request')
                                doAction(id, function () { return msgReqs.accept(id); }, true);
                            else
                                doAction(id, function () { return (0, requests_1.acceptRequest)(item.type, id); });
                        }}/>
                    <DeclineBtn busy={busy} onPress={function () {
                            if (type === 'message_request')
                                doAction(id, function () { return msgReqs.decline(id); }, true);
                            else
                                doAction(id, function () { return (0, requests_1.declineRequest)(item.type, id); });
                        }}/>
                  </ActionRow>) : (<react_native_1.View style={{ marginTop: 2 }}>
                    <StatusChip status={status}/>
                  </react_native_1.View>)}
              </react_native_1.View>
            </react_native_1.View>);
            })}
      </>);
    }
    function renderOutgoing() {
        if (requests.outgoing.length === 0) {
            return (<react_native_1.View style={styles.emptyWrap}>
          <react_native_1.Text style={styles.emptyText}>No outgoing requests.</react_native_1.Text>
        </react_native_1.View>);
        }
        return requests.outgoing.map(function (item) {
            var _a, _b, _c;
            var busy = actioning === item.id;
            var isPending = item.status === 'pending' || item.status === 'invited';
            return (<react_native_1.View key={item.id} style={styles.row}>
          <react_native_1.View style={styles.iconBadge}><TypeIcon type={item.type}/></react_native_1.View>
          <Avatar url={(_a = item.actor) === null || _a === void 0 ? void 0 : _a.avatarUrl} name={(_b = item.actor) === null || _b === void 0 ? void 0 : _b.name}/>
          <react_native_1.View style={{ flex: 1, gap: 3 }}>
            <react_native_1.Text style={styles.rowText}>{describeItem(item, 'outgoing')}</react_native_1.Text>
            <ActorMeta handle={(_c = item.actor) === null || _c === void 0 ? void 0 : _c.handle} createdAt={item.createdAt}/>
            <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginTop: 2 }}>
              <StatusChip status={item.status}/>
              {isPending && item.type === 'friend_request' && (<DeclineBtn label="Cancel" busy={busy} onPress={function () {
                        return doAction(item.id, function () { return (0, requests_1.cancelRequest)('friend_request', item.id); });
                    }}/>)}
              {isPending && item.type === 'circle_invite' && (<DeclineBtn label="Cancel" busy={busy} onPress={function () {
                        return doAction(item.id, function () { return (0, requests_1.cancelRequest)('circle_invite', item.id); });
                    }}/>)}
              {isPending && item.type === 'trip_invite' && item.id.includes('|') && (<DeclineBtn label="Cancel invite" busy={busy} onPress={function () {
                        var _a = item.id.split('|'), tripId = _a[0], inviteeId = _a[1];
                        doAction(item.id, function () { return (0, requests_1.cancelRequest)('trip_invite', tripId, { inviteeId: inviteeId }); });
                    }}/>)}
            </react_native_1.View>
          </react_native_1.View>
        </react_native_1.View>);
        });
    }
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <react_native_1.View style={[styles.head, { paddingTop: insets.top + tokens_1.space.md }]}>
        <react_native_1.Text style={styles.title}>Inbox</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}>
          <lucide_react_native_1.X size={24} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>
      </react_native_1.View>

      <react_native_1.View style={styles.tabs}>
        {['incoming', 'outgoing'].map(function (tab) { return (<react_native_1.Pressable key={tab} style={[styles.tab, activeTab === tab && styles.tabActive]} onPress={function () { return setActiveTab(tab); }}>
            <react_native_1.Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab === 'incoming' ? 'Incoming' : 'Outgoing'}
            </react_native_1.Text>
          </react_native_1.Pressable>); })}
      </react_native_1.View>

      {showSkeleton ? (<react_native_1.ScrollView contentContainerStyle={styles.list}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </react_native_1.ScrollView>) : error && !everLoaded.current ? (<react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.errorText}>Couldn't load requests.</react_native_1.Text>
          <react_native_1.Pressable style={styles.retryBtn} onPress={function () { requests.reload(); msgReqs.reload(); loadMeetupInvites(); }}>
            <react_native_1.Text style={styles.retryBtnText}>Retry</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>) : (<react_native_1.ScrollView contentContainerStyle={styles.list}>
          {activeTab === 'incoming' ? renderIncoming() : renderOutgoing()}
        </react_native_1.ScrollView>)}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    head: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: tokens_1.space.lg,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink }),
    tabs: {
        flexDirection: 'row',
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
        gap: tokens_1.space.sm,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    tab: {
        paddingVertical: 7,
        paddingHorizontal: tokens_1.space.lg,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    tabActive: { backgroundColor: tokens_1.color.ink, borderColor: tokens_1.color.ink },
    tabText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.mute }),
    tabTextActive: { color: tokens_1.color.onInk },
    list: { padding: tokens_1.space.lg, gap: tokens_1.space.md },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: tokens_1.space.xl },
    emptyWrap: { paddingVertical: tokens_1.space.xxl, alignItems: 'center' },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
    errorText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center', marginBottom: tokens_1.space.md }),
    retryBtn: {
        paddingVertical: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.xl,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tokens_1.color.signal,
    },
    retryBtnText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.signal }),
    sectionLabel: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: tokens_1.space.sm },
    sectionLabelText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '700', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' }),
    meetupTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 13, marginTop: 2 }),
    meetupMeta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: tokens_1.space.sm,
        paddingVertical: tokens_1.space.sm,
    },
    iconBadge: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    avatar: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: tokens_1.color.haze,
        flexShrink: 0,
    },
    avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised },
    avatarInitial: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    rowText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flex: 1 }),
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    preview: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontStyle: 'italic' }),
    actionsRow: { flexDirection: 'row', gap: tokens_1.space.sm, marginTop: 4, flexWrap: 'wrap' },
    acceptBtn: {
        paddingVertical: 7,
        paddingHorizontal: tokens_1.space.lg,
        backgroundColor: tokens_1.color.signal,
        borderRadius: 999,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    acceptBtnText: __assign(__assign({}, tokens_1.type.stamp), { color: '#fff' }),
    maybeBtn: {
        paddingVertical: 7,
        paddingHorizontal: tokens_1.space.lg,
        borderWidth: 1,
        borderColor: '#A16207',
        borderRadius: 999,
        backgroundColor: '#FEF9C3',
    },
    maybeBtnText: __assign(__assign({}, tokens_1.type.stamp), { color: '#A16207' }),
    declineBtn: {
        paddingVertical: 7,
        paddingHorizontal: tokens_1.space.lg,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderRadius: 999,
    },
    declineBtnText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.mute }),
    btnDim: { opacity: 0.45 },
    statusChip: {
        paddingVertical: 3,
        paddingHorizontal: tokens_1.space.sm,
        borderRadius: 999,
        alignSelf: 'flex-start',
    },
    statusChipText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', fontSize: 11 }),
});
