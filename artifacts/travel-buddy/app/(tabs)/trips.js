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
exports.default = Trips;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../../src/components/ScreenHeader");
var ui_1 = require("../../src/components/ui");
var cebu_1 = require("../../src/data/cebu");
var SessionContext_1 = require("../../src/context/SessionContext");
var useBackend_1 = require("../../src/hooks/useBackend");
var useMessaging_1 = require("../../src/hooks/useMessaging");
var tokens_1 = require("../../src/theme/tokens");
var trips_1 = require("../../src/services/trips");
function MeetupsShortcut(_a) {
    var count = _a.count;
    var label = count > 9 ? '9+' : count > 0 ? String(count) : null;
    return (<react_native_1.Pressable style={styles.meetupsCard} onPress={function () { return expo_router_1.router.push('/meetups'); }}>
      <react_native_1.View>
        <react_native_1.View style={styles.meetupsIcon}>
          <lucide_react_native_1.CalendarClock size={18} color={tokens_1.color.onInk}/>
        </react_native_1.View>
        {label ? (<react_native_1.View style={styles.meetupsBadge}>
            <react_native_1.Text style={styles.meetupsBadgeText}>{label}</react_native_1.Text>
          </react_native_1.View>) : null}
      </react_native_1.View>
      <react_native_1.View style={styles.meetupsText}>
        <react_native_1.Text style={styles.meetupsTitle}>Meetups</react_native_1.Text>
        <react_native_1.Text style={styles.meetupsSub}>View and plan get-togethers</react_native_1.Text>
      </react_native_1.View>
      <lucide_react_native_1.ChevronRight size={18} color={tokens_1.color.mute}/>
    </react_native_1.Pressable>);
}
function InviteCard(_a) {
    var _b, _c, _d;
    var invite = _a.invite, onDone = _a.onDone;
    var _e = react_1.default.useState(null), busy = _e[0], setBusy = _e[1];
    function handle(action) {
        return __awaiter(this, void 0, void 0, function () {
            var e_1;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        setBusy(action);
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 6, , 7]);
                        if (!(action === 'accept')) return [3 /*break*/, 3];
                        return [4 /*yield*/, (0, trips_1.acceptTripInvite)(invite.tripId)];
                    case 2:
                        _b.sent();
                        return [3 /*break*/, 5];
                    case 3: return [4 /*yield*/, (0, trips_1.declineTripInvite)(invite.tripId)];
                    case 4:
                        _b.sent();
                        _b.label = 5;
                    case 5:
                        onDone();
                        return [3 /*break*/, 7];
                    case 6:
                        e_1 = _b.sent();
                        react_native_1.Alert.alert('Error', (_a = e_1 === null || e_1 === void 0 ? void 0 : e_1.message) !== null && _a !== void 0 ? _a : 'Something went wrong. Please try again.');
                        setBusy(null);
                        return [3 /*break*/, 7];
                    case 7: return [2 /*return*/];
                }
            });
        });
    }
    var dateStr = invite.startDate
        ? invite.endDate
            ? "".concat(invite.startDate, " \u2013 ").concat(invite.endDate)
            : invite.startDate
        : 'Dates TBD';
    var destination = invite.destinationCountry
        ? "".concat(invite.destinationCity, ", ").concat(invite.destinationCountry)
        : invite.destinationCity;
    return (<react_native_1.View style={styles.inviteCard}>
      {invite.coverUrl ? (<react_native_1.Image source={{ uri: invite.coverUrl }} style={styles.inviteCover}/>) : (<react_native_1.View style={[styles.inviteCover, styles.inviteCoverPlaceholder]}>
          <lucide_react_native_1.MapPin size={22} color={tokens_1.color.onInk}/>
        </react_native_1.View>)}
      <react_native_1.View style={styles.inviteBody}>
        <react_native_1.View style={styles.inviteInviterRow}>
          {((_b = invite.inviter) === null || _b === void 0 ? void 0 : _b.avatarUrl) ? (<react_native_1.Image source={{ uri: invite.inviter.avatarUrl }} style={styles.inviterAvatar}/>) : (<react_native_1.View style={styles.inviterAvatarPlaceholder}>
              <lucide_react_native_1.UserCircle size={14} color={tokens_1.color.mute}/>
            </react_native_1.View>)}
          <react_native_1.Text style={styles.inviterLabel} numberOfLines={1}>
            <react_native_1.Text style={styles.inviterName}>{(_d = (_c = invite.inviter) === null || _c === void 0 ? void 0 : _c.name) !== null && _d !== void 0 ? _d : 'Someone'}</react_native_1.Text>
            {' invited you'}
          </react_native_1.Text>
        </react_native_1.View>
        <react_native_1.Text style={styles.inviteTitle} numberOfLines={1}>{invite.tripTitle}</react_native_1.Text>
        <react_native_1.View style={styles.inviteMeta}>
          <lucide_react_native_1.MapPin size={12} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.inviteMetaText} numberOfLines={1}>{destination}</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.View style={styles.inviteMeta}>
          <lucide_react_native_1.CalendarDays size={12} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.inviteMetaText}>{dateStr}</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.View style={styles.inviteActions}>
          <react_native_1.Pressable style={[styles.inviteBtn, styles.inviteBtnDecline]} onPress={function () { return handle('decline'); }} disabled={busy !== null}>
            {busy === 'decline'
            ? <react_native_1.ActivityIndicator size={14} color={tokens_1.color.mute}/>
            : <lucide_react_native_1.X size={14} color={tokens_1.color.mute}/>}
            <react_native_1.Text style={styles.inviteBtnDeclineText}>Decline</react_native_1.Text>
          </react_native_1.Pressable>
          <react_native_1.Pressable style={[styles.inviteBtn, styles.inviteBtnAccept]} onPress={function () { return handle('accept'); }} disabled={busy !== null}>
            {busy === 'accept'
            ? <react_native_1.ActivityIndicator size={14} color={tokens_1.color.onInk}/>
            : <lucide_react_native_1.Check size={14} color={tokens_1.color.onInk}/>}
            <react_native_1.Text style={styles.inviteBtnAcceptText}>Accept</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.View>);
}
function PendingInvitesSection(_a) {
    var onAccepted = _a.onAccepted;
    var _b = (0, useBackend_1.usePendingTripInvites)(), invites = _b.invites, reload = _b.reload;
    if (!invites.length)
        return null;
    function handleDone() {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, reload()];
                    case 1:
                        _a.sent();
                        onAccepted();
                        return [2 /*return*/];
                }
            });
        });
    }
    return (<react_native_1.View style={styles.inviteSection}>
      <react_native_1.Text style={styles.inviteSectionTitle}>Trip Invites</react_native_1.Text>
      {invites.map(function (inv) { return (<InviteCard key={inv.tripId} invite={inv} onDone={handleDone}/>); })}
    </react_native_1.View>);
}
function Trips() {
    var _a = (0, SessionContext_1.useSession)(), configured = _a.configured, isAuthed = _a.isAuthed;
    var live = configured && isAuthed;
    var _b = (0, useBackend_1.useMyTrips)(), realTrips = _b.data, loading = _b.loading, error = _b.error, reload = _b.reload;
    var meetupCount = (0, useMessaging_1.useUnreadCounts)().meetups;
    react_1.default.useEffect(function () { if (live)
        reload(); }, [live, reload]);
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Trips" right={<react_native_1.Pressable style={styles.newBtn} onPress={function () { return expo_router_1.router.push('/trip/new'); }}>
            <lucide_react_native_1.Plus size={16} color={tokens_1.color.onInk}/>
            <react_native_1.Text style={styles.newBtnText}>New trip</react_native_1.Text>
          </react_native_1.Pressable>}/>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.lg, paddingBottom: tokens_1.space.xxxl }}>
        <MeetupsShortcut count={meetupCount}/>
        {live && <PendingInvitesSection onAccepted={reload}/>}
        {live ? (<LiveTrips trips={realTrips} loading={loading} error={error}/>) : (cebu_1.trips.map(function (tr) { return (<react_native_1.Pressable key={tr.id} style={styles.card} onPress={function () { return expo_router_1.router.push("/trip/".concat(tr.id)); }}>
              <react_native_1.Image source={{ uri: tr.coverUrl }} style={styles.cover}/>
              <react_native_1.View style={styles.body}>
                <react_native_1.View style={styles.stampRow}>
                  <ui_1.Stamp label={tr.destination.city} tone="deep"/>
                  <ui_1.Stamp label={tr.isPublic ? 'public' : 'private'} rotate={2}/>
                </react_native_1.View>
                <react_native_1.Text style={styles.title}>{tr.title}</react_native_1.Text>
                <react_native_1.View style={styles.metaRow}><lucide_react_native_1.CalendarDays size={14} color={tokens_1.color.mute}/><react_native_1.Text style={styles.meta}>{tr.startDate} – {tr.endDate} · {tr.dayCount} days</react_native_1.Text></react_native_1.View>
                <react_native_1.View style={styles.metaRow}><lucide_react_native_1.Users size={14} color={tokens_1.color.mute}/><react_native_1.Text style={styles.meta}>{tr.collaborators.length + 1} travelers · {tr.savedPostIds.length} saved</react_native_1.Text></react_native_1.View>
              </react_native_1.View>
            </react_native_1.Pressable>); }))}
        <react_native_1.Pressable style={styles.empty} onPress={function () { return expo_router_1.router.push('/trip/new'); }}>
          <lucide_react_native_1.Plus size={20} color={tokens_1.color.deep}/>
          <react_native_1.Text style={styles.emptyText}>Start a new trip</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
function LiveTrips(_a) {
    var trips = _a.trips, loading = _a.loading, error = _a.error;
    if (loading)
        return <react_native_1.View style={styles.state}><react_native_1.ActivityIndicator color={tokens_1.color.signal}/></react_native_1.View>;
    if (error)
        return <react_native_1.View style={styles.state}><react_native_1.Text style={styles.stateText}>Couldn't load your trips. Pull to retry.</react_native_1.Text></react_native_1.View>;
    if (!trips.length) {
        return (<react_native_1.View style={styles.bigEmpty}>
        <lucide_react_native_1.MapPin size={28} color={tokens_1.color.deep}/>
        <react_native_1.Text style={styles.bigEmptyTitle}>No trips yet</react_native_1.Text>
        <react_native_1.Text style={styles.bigEmptySub}>Create your first trip to start planning, saving places, and meeting travelers.</react_native_1.Text>
      </react_native_1.View>);
    }
    return (<>
      {trips.map(function (tr) {
            var _a;
            return (<react_native_1.Pressable key={tr.id} style={styles.card} onPress={function () { return expo_router_1.router.push("/trip/".concat(tr.id)); }}>
          {tr.coverUrl ? <react_native_1.Image source={{ uri: tr.coverUrl }} style={styles.cover}/> : <react_native_1.View style={[styles.cover, { backgroundColor: tokens_1.color.deep }]}/>}
          <react_native_1.View style={styles.body}>
            <react_native_1.View style={styles.stampRow}>
              <ui_1.Stamp label={tr.destinationCity} tone="deep"/>
              <ui_1.Stamp label={tr.visibility} rotate={2}/>
            </react_native_1.View>
            <react_native_1.Text style={styles.title}>{tr.title}</react_native_1.Text>
            <react_native_1.View style={styles.metaRow}>
              <lucide_react_native_1.CalendarDays size={14} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.meta}>{(_a = tr.startDate) !== null && _a !== void 0 ? _a : 'Dates TBD'}{tr.endDate ? " \u2013 ".concat(tr.endDate) : ''} · {tr.status}</react_native_1.Text>
            </react_native_1.View>
          </react_native_1.View>
        </react_native_1.Pressable>);
        })}
    </>);
}
var styles = react_native_1.StyleSheet.create({
    newBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: tokens_1.color.ink, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill },
    newBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.onInk }),
    meetupsCard: __assign(__assign({ flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, padding: tokens_1.space.md }, tokens_1.shadow.card), { borderWidth: 1, borderColor: tokens_1.color.haze }),
    meetupsIcon: {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: tokens_1.color.deep,
        alignItems: 'center',
        justifyContent: 'center',
    },
    meetupsText: {
        flex: 1,
        gap: 2,
    },
    meetupsTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700' }),
    meetupsSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    meetupsBadge: {
        position: 'absolute',
        top: -4,
        right: -4,
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    meetupsBadgeText: {
        color: '#fff',
        fontSize: 9,
        fontWeight: '700',
        lineHeight: 11,
    },
    card: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, overflow: 'hidden' }, tokens_1.shadow.card),
    cover: { width: '100%', height: 150, backgroundColor: tokens_1.color.haze },
    body: { padding: tokens_1.space.lg, gap: tokens_1.space.sm },
    stampRow: { flexDirection: 'row', gap: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink }),
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    empty: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.xl, borderRadius: tokens_1.radius.lg, borderWidth: 1.5, borderColor: tokens_1.color.haze, borderStyle: 'dashed' },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.deep, fontWeight: '600' }),
    state: { padding: tokens_1.space.xxl, alignItems: 'center' },
    stateText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    bigEmpty: { alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.xxl, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze },
    bigEmptyTitle: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18 }),
    bigEmptySub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center' }),
    inviteSection: { gap: tokens_1.space.sm },
    inviteSectionTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700' }),
    inviteCard: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: tokens_1.color.haze }, tokens_1.shadow.card),
    inviteCover: { width: '100%', height: 90 },
    inviteCoverPlaceholder: {
        backgroundColor: tokens_1.color.deep,
        alignItems: 'center',
        justifyContent: 'center',
    },
    inviteBody: { padding: tokens_1.space.md, gap: tokens_1.space.sm },
    inviteInviterRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    inviterAvatar: { width: 20, height: 20, borderRadius: 10 },
    inviterAvatarPlaceholder: { width: 20, height: 20, borderRadius: 10, backgroundColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    inviterLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, flex: 1 }),
    inviterName: { fontWeight: '600', color: tokens_1.color.ink },
    inviteTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700' }),
    inviteMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    inviteMetaText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    inviteActions: { flexDirection: 'row', gap: tokens_1.space.sm, marginTop: tokens_1.space.xs },
    inviteBtn: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        paddingVertical: tokens_1.space.sm,
        borderRadius: tokens_1.radius.md,
    },
    inviteBtnDecline: {
        backgroundColor: tokens_1.color.haze,
    },
    inviteBtnDeclineText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    inviteBtnAccept: {
        backgroundColor: tokens_1.color.ink,
    },
    inviteBtnAcceptText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
});
