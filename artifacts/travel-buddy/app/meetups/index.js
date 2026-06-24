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
exports.default = MeetupsScreen;
/**
 * Meetups list screen — /meetups
 *
 * Shows all meetups the user created or was invited to,
 * grouped into Upcoming and Past sections.
 * Header has a "Create Meetup" button using MeetupCreationSheet.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var meetups_1 = require("../../src/services/meetups");
var MeetupCreationSheet_1 = require("../../src/components/MeetupCreationSheet");
var RsvpBar_1 = require("../../src/components/RsvpBar");
var SessionContext_1 = require("../../src/context/SessionContext");
var tokens_1 = require("../../src/theme/tokens");
// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(m) {
    if (m.startsAt) {
        var d = new Date(m.startsAt);
        var datePart = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        var timePart = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return "".concat(datePart, " \u00B7 ").concat(timePart);
    }
    if (m.approximateDate) {
        return new Date(m.approximateDate + 'T12:00:00').toLocaleDateString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric',
        });
    }
    return 'Date TBD';
}
function isUpcoming(m) {
    if (m.status === 'cancelled')
        return false;
    if (m.startsAt)
        return new Date(m.startsAt) >= new Date();
    if (m.approximateDate)
        return m.approximateDate >= new Date().toISOString().split('T')[0];
    return true; // no date = assume upcoming
}
var STATUS_BADGE = {
    active: { label: 'Active', bg: '#E0F2FE', fg: '#0369A1' },
    confirmed: { label: 'Confirmed', bg: '#DCFCE7', fg: '#16A34A' },
    draft: { label: 'Draft', bg: tokens_1.color.haze, fg: tokens_1.color.mute },
    cancelled: { label: 'Cancelled', bg: '#FEE2E2', fg: '#DC2626' },
};
var RSVP_BADGE = {
    going: { label: 'Going ✅', bg: '#DCFCE7', fg: '#15803D' },
    maybe: { label: 'Maybe 🤔', bg: '#FEF3C7', fg: '#92400E' },
    declined: { label: "Can't go ❌", bg: '#FEE2E2', fg: '#DC2626' },
    pending: { label: 'Invited', bg: tokens_1.color.haze, fg: tokens_1.color.mute },
};
// ── MeetupRow ─────────────────────────────────────────────────────────────────
function MeetupRow(_a) {
    var _b, _c;
    var meetup = _a.meetup;
    var statusBadge = (_b = STATUS_BADGE[meetup.status]) !== null && _b !== void 0 ? _b : STATUS_BADGE.active;
    var totalAttendees = meetup.counts.going + meetup.counts.maybe + meetup.counts.pending;
    var myBadgeKey = meetup.isCreator ? null : ((_c = meetup.myRsvp) !== null && _c !== void 0 ? _c : 'pending');
    var myBadge = myBadgeKey ? RSVP_BADGE[myBadgeKey] : null;
    return (<react_native_1.Pressable style={styles.row} onPress={function () { return expo_router_1.router.push("/meetup/".concat(meetup.id)); }}>
      {/* Status stripe */}
      <react_native_1.View style={[styles.stripe, { backgroundColor: statusBadge.fg }]}/>

      <react_native_1.View style={styles.rowBody}>
        {/* Title row */}
        <react_native_1.View style={styles.titleRow}>
          <react_native_1.Text style={styles.rowTitle} numberOfLines={1}>{meetup.title}</react_native_1.Text>
          <react_native_1.View style={[styles.badge, { backgroundColor: statusBadge.bg }]}>
            <react_native_1.Text style={[styles.badgeText, { color: statusBadge.fg }]}>{statusBadge.label}</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>

        {/* Date + location */}
        <react_native_1.View style={styles.metaRow}>
          <lucide_react_native_1.CalendarClock size={13} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.meta}>{formatDate(meetup)}</react_native_1.Text>
          {meetup.locationName ? (<>
              <react_native_1.Text style={styles.metaDot}>·</react_native_1.Text>
              <lucide_react_native_1.MapPin size={13} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.meta} numberOfLines={1}>{meetup.locationName}</react_native_1.Text>
            </>) : null}
        </react_native_1.View>

        {/* RSVP progress + my RSVP */}
        <react_native_1.View style={styles.footRow}>
          <RsvpBar_1.RsvpBar style={styles.rsvpBar} going={meetup.counts.going} maybe={meetup.counts.maybe} pending={meetup.counts.pending} total={totalAttendees}/>
          {meetup.isCreator ? (<react_native_1.View style={[styles.badge, { backgroundColor: '#E0F2FE' }]}>
              <react_native_1.Text style={[styles.badgeText, { color: '#0369A1' }]}>Host</react_native_1.Text>
            </react_native_1.View>) : myBadge ? (<react_native_1.View style={[styles.badge, { backgroundColor: myBadge.bg }]}>
              <react_native_1.Text style={[styles.badgeText, { color: myBadge.fg }]}>{myBadge.label}</react_native_1.Text>
            </react_native_1.View>) : null}
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.Pressable>);
}
// ── Section header ────────────────────────────────────────────────────────────
function SectionHeader(_a) {
    var title = _a.title, count = _a.count;
    return (<react_native_1.View style={styles.sectionHeader}>
      <react_native_1.Text style={styles.sectionTitle}>{title}</react_native_1.Text>
      <react_native_1.View style={styles.sectionCount}>
        <react_native_1.Text style={styles.sectionCountText}>{count}</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.View>);
}
// ── Main screen ───────────────────────────────────────────────────────────────
function MeetupsScreen() {
    var _this = this;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _a = (0, SessionContext_1.useSession)(), isAuthed = _a.isAuthed, configured = _a.configured;
    var _b = (0, react_1.useState)([]), meetups = _b[0], setMeetups = _b[1];
    var _c = (0, react_1.useState)(true), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)(null), error = _d[0], setError = _d[1];
    var _e = (0, react_1.useState)(false), showCreate = _e[0], setShowCreate = _e[1];
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var _a, upRes, pastRes, upcoming_1, past_1, seen, all, _i, _b, m;
        var _c, _d, _e, _f, _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    if (!configured || !isAuthed) {
                        setLoading(false);
                        return [2 /*return*/];
                    }
                    setLoading(true);
                    setError(null);
                    return [4 /*yield*/, Promise.all([
                            (0, meetups_1.getMyMeetups)('upcoming'),
                            (0, meetups_1.getMyMeetups)('past'),
                        ])];
                case 1:
                    _a = _h.sent(), upRes = _a[0], pastRes = _a[1];
                    if (!upRes.ok && !pastRes.ok) {
                        setError((_c = upRes.message) !== null && _c !== void 0 ? _c : 'Failed to load meetups');
                    }
                    else {
                        upcoming_1 = (_e = (_d = upRes.data) === null || _d === void 0 ? void 0 : _d.meetups) !== null && _e !== void 0 ? _e : [];
                        past_1 = (_g = (_f = pastRes.data) === null || _f === void 0 ? void 0 : _f.meetups) !== null && _g !== void 0 ? _g : [];
                        seen = new Set();
                        all = [];
                        for (_i = 0, _b = __spreadArray(__spreadArray([], upcoming_1, true), past_1, true); _i < _b.length; _i++) {
                            m = _b[_i];
                            if (!seen.has(m.id)) {
                                seen.add(m.id);
                                all.push(m);
                            }
                        }
                        setMeetups(all);
                    }
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, [configured, isAuthed]);
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () { load(); }, [load]));
    var upcoming = meetups.filter(isUpcoming);
    var past = meetups.filter(function (m) { return !isUpcoming(m); });
    return (<react_native_1.View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <react_native_1.View style={styles.header}>
        <react_native_1.Pressable style={styles.backBtn} onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}>
          <lucide_react_native_1.ArrowLeft size={22} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>
        <react_native_1.Text style={styles.headerTitle}>Meetups</react_native_1.Text>
        <react_native_1.Pressable style={styles.createBtn} onPress={function () { return setShowCreate(true); }}>
          <lucide_react_native_1.Plus size={16} color={tokens_1.color.onInk}/>
          <react_native_1.Text style={styles.createBtnText}>Create</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>

      {/* Content */}
      {loading ? (<react_native_1.View style={styles.center}>
          <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
        </react_native_1.View>) : error ? (<react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.errorText}>{error}</react_native_1.Text>
          <react_native_1.Pressable onPress={load} style={styles.retryBtn}>
            <react_native_1.Text style={styles.retryText}>Retry</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>) : meetups.length === 0 ? (<react_native_1.View style={styles.emptyState}>
          <lucide_react_native_1.CalendarX size={40} color={tokens_1.color.faint}/>
          <react_native_1.Text style={styles.emptyTitle}>No meetups yet</react_native_1.Text>
          <react_native_1.Text style={styles.emptySub}>
            Create a meetup to plan a get-together with friends or trip members.
          </react_native_1.Text>
          <react_native_1.Pressable style={styles.emptyBtn} onPress={function () { return setShowCreate(true); }}>
            <lucide_react_native_1.Plus size={16} color={tokens_1.color.onInk}/>
            <react_native_1.Text style={styles.emptyBtnText}>Create your first meetup</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>) : (<react_native_1.ScrollView contentContainerStyle={styles.list} refreshControl={<react_native_1.RefreshControl refreshing={loading} onRefresh={load} tintColor={tokens_1.color.signal}/>}>
          {upcoming.length > 0 && (<>
              <SectionHeader title="Upcoming" count={upcoming.length}/>
              {upcoming.map(function (m) { return <MeetupRow key={m.id} meetup={m}/>; })}
            </>)}

          {past.length > 0 && (<>
              <SectionHeader title="Past" count={past.length}/>
              {past.map(function (m) { return <MeetupRow key={m.id} meetup={m}/>; })}
            </>)}
        </react_native_1.ScrollView>)}

      {/* Create meetup sheet */}
      {showCreate && (<MeetupCreationSheet_1.MeetupCreationSheet onDismiss={function () { return setShowCreate(false); }} onCreated={function () { setShowCreate(false); load(); }}/>)}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    container: {
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
        backgroundColor: tokens_1.color.paperRaised,
        gap: tokens_1.space.md,
    },
    backBtn: {
        padding: 4,
    },
    headerTitle: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontWeight: '800', flex: 1 }),
    createBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        backgroundColor: tokens_1.color.ink,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.sm,
        borderRadius: tokens_1.radius.pill,
    },
    createBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens_1.space.xxl,
        gap: tokens_1.space.md,
    },
    errorText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
    retryBtn: {
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.sm,
        backgroundColor: tokens_1.color.signal,
        borderRadius: tokens_1.radius.pill,
    },
    retryText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens_1.space.xxl,
        gap: tokens_1.space.md,
    },
    emptyTitle: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 20, fontWeight: '800' }),
    emptySub: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center', maxWidth: 280 }),
    emptyBtn: __assign({ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.pill, marginTop: tokens_1.space.sm }, tokens_1.shadow.card),
    emptyBtnText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.onInk, fontWeight: '700' }),
    list: {
        padding: tokens_1.space.lg,
        gap: tokens_1.space.md,
        paddingBottom: tokens_1.space.xxxl,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
        paddingVertical: tokens_1.space.sm,
    },
    sectionTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 }),
    sectionCount: {
        minWidth: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 6,
    },
    sectionCountText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.mute, fontSize: 11, fontWeight: '700' }),
    row: __assign({ flexDirection: 'row', backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, overflow: 'hidden' }, tokens_1.shadow.card),
    stripe: {
        width: 4,
    },
    rowBody: {
        flex: 1,
        padding: tokens_1.space.md,
        gap: 6,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
    },
    rowTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700', flex: 1 }),
    badge: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: tokens_1.radius.pill,
    },
    badgeText: {
        fontSize: 11,
        fontWeight: '700',
        lineHeight: 16,
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        flexWrap: 'nowrap',
    },
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    metaDot: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint }),
    rsvpBar: {
        flex: 1,
    },
    footRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens_1.space.sm,
    },
});
