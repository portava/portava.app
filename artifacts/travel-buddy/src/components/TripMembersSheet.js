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
exports.TripMembersSheet = TripMembersSheet;
/**
 * TripMembersSheet — bottom sheet listing the members of a trip or circle chat.
 *
 * - Lists current members (owner gets an "Owner" badge).
 * - Trip owners get an "Invite a friend" action that opens an inline picker
 *   pre-filtered to friends not already in the trip (otherFollowers from
 *   getTripInvitableUsers). Tapping a friend sends a trip invite immediately.
 * - Freshly invited friends move into an "Invited" section with a "Pending"
 *   badge until they accept.
 * - Circle chats reuse the same member list but never show the invite action
 *   (circles have their own membership flow).
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var SessionContext_1 = require("../context/SessionContext");
var friends_1 = require("../services/friends");
var trips_1 = require("../services/trips");
var tokens_1 = require("../theme/tokens");
function PersonAvatar(_a) {
    var _b, _c, _d, _e;
    var user = _a.user, _f = _a.size, size = _f === void 0 ? 36 : _f;
    if (user.avatarUrl) {
        return <react_native_1.Image source={{ uri: user.avatarUrl }} style={{ width: size, height: size, borderRadius: size / 2 }}/>;
    }
    return (<react_native_1.View style={[{ width: size, height: size, borderRadius: size / 2 }, s.avatarFallback]}>
      <react_native_1.Text style={s.avatarInitial}>
        {((_e = (_c = (_b = user.name) === null || _b === void 0 ? void 0 : _b[0]) !== null && _c !== void 0 ? _c : (_d = user.handle) === null || _d === void 0 ? void 0 : _d[0]) !== null && _e !== void 0 ? _e : '?').toUpperCase()}
      </react_native_1.Text>
    </react_native_1.View>);
}
function MemberRow(_a) {
    var user = _a.user, badge = _a.badge, badgeKind = _a.badgeKind;
    return (<react_native_1.View style={s.row}>
      <PersonAvatar user={user}/>
      <react_native_1.View style={s.rowMeta}>
        <react_native_1.Text style={s.rowName} numberOfLines={1}>{user.name || user.handle}</react_native_1.Text>
        {user.handle ? <react_native_1.Text style={s.rowHandle} numberOfLines={1}>@{user.handle}</react_native_1.Text> : null}
      </react_native_1.View>
      {badge ? (<react_native_1.View style={[
                s.badge,
                badgeKind === 'owner' && s.badgeOwner,
                badgeKind === 'pending' && s.badgePending,
            ]}>
          {badgeKind === 'owner' && <lucide_react_native_1.Crown size={10} color={tokens_1.color.signal}/>}
          <react_native_1.Text style={[
                s.badgeText,
                badgeKind === 'owner' && s.badgeTextOwner,
                badgeKind === 'pending' && s.badgeTextPending,
            ]}>{badge}</react_native_1.Text>
        </react_native_1.View>) : null}
    </react_native_1.View>);
}
function TripMembersSheet(_a) {
    var _this = this;
    var type = _a.type, id = _a.id, title = _a.title, onDismiss = _a.onDismiss;
    var userId = (0, SessionContext_1.useSession)().userId;
    var _b = (0, react_1.useState)(true), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)([]), members = _c[0], setMembers = _c[1];
    var _d = (0, react_1.useState)(null), ownerId = _d[0], setOwnerId = _d[1];
    var _e = (0, react_1.useState)(false), canInvite = _e[0], setCanInvite = _e[1];
    // Invite picker state
    var _f = (0, react_1.useState)(false), pickerOpen = _f[0], setPickerOpen = _f[1];
    var _g = (0, react_1.useState)([]), candidates = _g[0], setCandidates = _g[1];
    var _h = (0, react_1.useState)(false), candidatesLoading = _h[0], setCandidatesLoading = _h[1];
    var _j = (0, react_1.useState)(false), candidatesLoaded = _j[0], setCandidatesLoaded = _j[1];
    var _k = (0, react_1.useState)(''), search = _k[0], setSearch = _k[1];
    var _l = (0, react_1.useState)(null), invitingId = _l[0], setInvitingId = _l[1];
    var _m = (0, react_1.useState)([]), invited = _m[0], setInvited = _m[1];
    var _o = (0, react_1.useState)(null), inviteError = _o[0], setInviteError = _o[1];
    // ── Load members (+ ownership for trips) ──
    (0, react_1.useEffect)(function () {
        var cancelled = false;
        (function () { return __awaiter(_this, void 0, void 0, function () {
            var res, trip, res;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        // Reset all context-sensitive state so a circle context can never
                        // inherit a stale trip's members, pending invites, or permissions.
                        setLoading(true);
                        setMembers([]);
                        setInvited([]);
                        setOwnerId(null);
                        setCanInvite(false);
                        setPickerOpen(false);
                        setCandidates([]);
                        setCandidatesLoaded(false);
                        setInviteError(null);
                        setSearch('');
                        setInvitingId(null);
                        setCandidatesLoading(false);
                        if (!(type === 'trip')) return [3 /*break*/, 3];
                        return [4 /*yield*/, (0, friends_1.getTripMembers)(id)];
                    case 1:
                        res = _b.sent();
                        if (cancelled)
                            return [2 /*return*/];
                        if (res.ok && res.data) {
                            setMembers(res.data.members);
                            setInvited((_a = res.data.invited) !== null && _a !== void 0 ? _a : []);
                        }
                        return [4 /*yield*/, (0, trips_1.getTrip)(id)];
                    case 2:
                        trip = _b.sent();
                        if (cancelled)
                            return [2 /*return*/];
                        if (trip) {
                            setOwnerId(trip.ownerId);
                            setCanInvite(!!userId && trip.ownerId === userId);
                        }
                        return [3 /*break*/, 5];
                    case 3: return [4 /*yield*/, (0, friends_1.getCircleMembers)(id)];
                    case 4:
                        res = _b.sent();
                        if (cancelled)
                            return [2 /*return*/];
                        if (res.ok && res.data)
                            setMembers(res.data.members);
                        _b.label = 5;
                    case 5:
                        if (!cancelled)
                            setLoading(false);
                        return [2 /*return*/];
                }
            });
        }); })();
        return function () { cancelled = true; };
    }, [type, id, userId]);
    // ── Load invite candidates (trip owners only) ──
    var loadCandidates = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (candidatesLoaded || candidatesLoading)
                        return [2 /*return*/];
                    setCandidatesLoading(true);
                    return [4 /*yield*/, (0, friends_1.getTripInvitableUsers)(id)];
                case 1:
                    res = _a.sent();
                    if (res.ok && res.data)
                        setCandidates(res.data.otherFollowers);
                    setCandidatesLoading(false);
                    setCandidatesLoaded(true);
                    return [2 /*return*/];
            }
        });
    }); }, [candidatesLoaded, candidatesLoading, id]);
    (0, react_1.useEffect)(function () {
        if (pickerOpen)
            loadCandidates();
    }, [pickerOpen, loadCandidates]);
    function handleInvite(user) {
        return __awaiter(this, void 0, void 0, function () {
            var res;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (invitingId)
                            return [2 /*return*/];
                        setInvitingId(user.id);
                        setInviteError(null);
                        return [4 /*yield*/, (0, friends_1.sendTripInvite)(id, user.id)];
                    case 1:
                        res = _b.sent();
                        setInvitingId(null);
                        if (!res.ok) {
                            setInviteError((_a = res.message) !== null && _a !== void 0 ? _a : 'Could not send invite. Try again.');
                            return [2 /*return*/];
                        }
                        // Move from picker into the Invited section
                        setCandidates(function (prev) { return prev.filter(function (c) { return c.id !== user.id; }); });
                        setInvited(function (prev) { return (prev.some(function (u) { return u.id === user.id; }) ? prev : __spreadArray(__spreadArray([], prev, true), [user], false)); });
                        return [2 /*return*/];
                }
            });
        });
    }
    var q = search.trim().toLowerCase();
    var filteredCandidates = q
        ? candidates.filter(function (c) { var _a, _b, _c; return (_c = (((_a = c.name) === null || _a === void 0 ? void 0 : _a.toLowerCase().includes(q)) || ((_b = c.handle) === null || _b === void 0 ? void 0 : _b.toLowerCase().includes(q)))) !== null && _c !== void 0 ? _c : false; })
        : candidates;
    var sheetTitle = title !== null && title !== void 0 ? title : (type === 'trip' ? 'Trip members' : 'Circle members');
    // Backend excludes the caller from `members`, so add 1 for the current user.
    var totalCount = members.length + 1;
    return (<react_native_1.Modal visible animationType="slide" transparent onRequestClose={onDismiss}>
      <react_native_1.Pressable style={s.overlay} onPress={onDismiss}/>
      <react_native_1.View style={s.sheet}>
        <react_native_1.View style={s.handle}/>

        <react_native_1.View style={s.head}>
          <react_native_1.Text style={s.title}>{sheetTitle}</react_native_1.Text>
          {!loading && (<react_native_1.Text style={s.count}>{totalCount} {totalCount === 1 ? 'member' : 'members'}</react_native_1.Text>)}
          <react_native_1.View style={{ flex: 1 }}/>
          <react_native_1.Pressable onPress={onDismiss} hitSlop={8}><lucide_react_native_1.X size={20} color={tokens_1.color.ink}/></react_native_1.Pressable>
        </react_native_1.View>

        {loading ? (<react_native_1.View style={s.center}><react_native_1.ActivityIndicator color={tokens_1.color.signal}/></react_native_1.View>) : (<react_native_1.ScrollView style={s.scroll} contentContainerStyle={s.scrollBody} keyboardShouldPersistTaps="handled">
            {members.map(function (m) { return (<MemberRow key={m.id} user={m} badge={ownerId && m.id === ownerId ? 'Owner' : undefined} badgeKind="owner"/>); })}

            {type === 'trip' && invited.length > 0 && (<>
                <react_native_1.Text style={s.sectionLabel}>Invited</react_native_1.Text>
                {invited.map(function (u) { return (<MemberRow key={u.id} user={u} badge="Pending" badgeKind="pending"/>); })}
              </>)}

            {members.length === 0 && invited.length === 0 && (<react_native_1.Text style={s.emptyNote}>No members yet.</react_native_1.Text>)}

            {/* ── Invite action (trip owners only) ── */}
            {canInvite && !pickerOpen && (<react_native_1.Pressable style={s.inviteBtn} onPress={function () { return setPickerOpen(true); }}>
                <lucide_react_native_1.UserPlus size={16} color={tokens_1.color.onInk}/>
                <react_native_1.Text style={s.inviteBtnText}>Invite a friend</react_native_1.Text>
              </react_native_1.Pressable>)}

            {canInvite && pickerOpen && (<react_native_1.View style={s.picker}>
                <react_native_1.View style={s.searchRow}>
                  <lucide_react_native_1.Search size={14} color={tokens_1.color.mute}/>
                  <react_native_1.TextInput style={s.searchInput} placeholder="Search friends" placeholderTextColor={tokens_1.color.faint} value={search} onChangeText={setSearch} autoCorrect={false}/>
                  <react_native_1.Pressable onPress={function () { setPickerOpen(false); setSearch(''); }} hitSlop={8}>
                    <lucide_react_native_1.X size={16} color={tokens_1.color.mute}/>
                  </react_native_1.Pressable>
                </react_native_1.View>

                {inviteError ? <react_native_1.Text style={s.errorText}>{inviteError}</react_native_1.Text> : null}

                {candidatesLoading ? (<react_native_1.View style={s.center}><react_native_1.ActivityIndicator color={tokens_1.color.signal}/></react_native_1.View>) : filteredCandidates.length === 0 ? (<react_native_1.Text style={s.emptyNote}>
                    {candidatesLoaded
                        ? (q ? 'No friends match your search.' : 'No friends left to invite.')
                        : ''}
                  </react_native_1.Text>) : (filteredCandidates.map(function (c) { return (<react_native_1.Pressable key={c.id} style={s.candidateRow} onPress={function () { return handleInvite(c); }} disabled={!!invitingId}>
                      <PersonAvatar user={c} size={32}/>
                      <react_native_1.View style={s.rowMeta}>
                        <react_native_1.Text style={s.rowName} numberOfLines={1}>{c.name || c.handle}</react_native_1.Text>
                        {c.handle ? <react_native_1.Text style={s.rowHandle} numberOfLines={1}>@{c.handle}</react_native_1.Text> : null}
                      </react_native_1.View>
                      {invitingId === c.id ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>) : (<react_native_1.View style={s.candidateAdd}>
                          <lucide_react_native_1.UserPlus size={14} color={tokens_1.color.signal}/>
                        </react_native_1.View>)}
                    </react_native_1.Pressable>); }))}
              </react_native_1.View>)}
          </react_native_1.ScrollView>)}
      </react_native_1.View>
    </react_native_1.Modal>);
}
var s = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: {
        backgroundColor: tokens_1.color.paperRaised,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: 34,
        paddingTop: tokens_1.space.sm,
        maxHeight: '80%',
    },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginBottom: tokens_1.space.md },
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginBottom: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700' }),
    count: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, fontSize: 11 }),
    center: { paddingVertical: tokens_1.space.xl, alignItems: 'center' },
    scroll: { flexGrow: 0 },
    scrollBody: { paddingBottom: tokens_1.space.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, paddingVertical: 10 },
    rowMeta: { flex: 1, minWidth: 0 },
    rowName: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    rowHandle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12 }),
    avatarFallback: { backgroundColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    avatarInitial: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink, fontSize: 14 }),
    badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.pill, borderWidth: 1 },
    badgeOwner: { borderColor: tokens_1.color.signal, backgroundColor: tokens_1.color.paper },
    badgePending: { borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper },
    badgeText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', fontSize: 10 }),
    badgeTextOwner: { color: tokens_1.color.signal },
    badgeTextPending: { color: tokens_1.color.mute },
    sectionLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, fontSize: 11, letterSpacing: 0.5, marginTop: tokens_1.space.md, marginBottom: 2, textTransform: 'uppercase' }),
    emptyNote: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontStyle: 'italic', paddingVertical: tokens_1.space.md }),
    inviteBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm,
        backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingVertical: 12, marginTop: tokens_1.space.md,
    },
    inviteBtnText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.onInk, fontWeight: '700' }),
    picker: { marginTop: tokens_1.space.md, borderTopWidth: react_native_1.StyleSheet.hairlineWidth, borderTopColor: tokens_1.color.haze, paddingTop: tokens_1.space.md },
    searchRow: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze,
        paddingHorizontal: tokens_1.space.md, paddingVertical: 8, marginBottom: tokens_1.space.sm,
    },
    searchInput: __assign(__assign({ flex: 1 }, tokens_1.type.body), { color: tokens_1.color.ink, padding: 0 }),
    errorText: __assign(__assign({}, tokens_1.type.small), { color: '#DC2626', marginBottom: tokens_1.space.sm }),
    candidateRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, paddingVertical: 8 },
    candidateAdd: {
        width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: tokens_1.color.signal,
        alignItems: 'center', justifyContent: 'center',
    },
});
