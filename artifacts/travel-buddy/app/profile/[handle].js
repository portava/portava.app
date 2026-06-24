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
exports.default = Profile;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../../src/components/ScreenHeader");
var ui_1 = require("../../src/components/ui");
var friends_1 = require("../../src/services/friends");
var SessionContext_1 = require("../../src/context/SessionContext");
var useFriends_1 = require("../../src/hooks/useFriends");
var useMessaging_1 = require("../../src/hooks/useMessaging");
var tokens_1 = require("../../src/theme/tokens");
var blocks_1 = require("../../src/services/blocks");
function FriendButton(_a) {
    var userId = _a.userId, isOwn = _a.isOwn;
    var _b = (0, useFriends_1.useFriendStatus)(isOwn ? null : userId), status = _b.status, loading = _b.loading, send = _b.send, accept = _b.accept, decline = _b.decline, cancel = _b.cancel;
    var _c = (0, react_1.useState)(false), busy = _c[0], setBusy = _c[1];
    if (isOwn || !userId)
        return null;
    function run(action) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setBusy(true);
                        return [4 /*yield*/, action()];
                    case 1:
                        _a.sent();
                        setBusy(false);
                        return [2 /*return*/];
                }
            });
        });
    }
    if (loading) {
        return <react_native_1.View style={s.actionBtn}><react_native_1.ActivityIndicator size="small" color={tokens_1.color.mute}/></react_native_1.View>;
    }
    if (status === 'friends') {
        return (<react_native_1.View style={[s.actionBtn, s.friendsBtnStyle]}>
        <lucide_react_native_1.UserCheck size={15} color={tokens_1.color.signal}/>
        <react_native_1.Text style={[s.btnText, { color: tokens_1.color.signal }]}>Friends</react_native_1.Text>
      </react_native_1.View>);
    }
    if (status === 'outgoing_pending') {
        return (<react_native_1.Pressable style={[s.actionBtn, s.pendingBtnStyle]} onPress={function () { return run(cancel); }} disabled={busy}>
        <lucide_react_native_1.Clock size={15} color={tokens_1.color.mute}/>
        <react_native_1.Text style={[s.btnText, { color: tokens_1.color.mute }]}>{busy ? 'Cancelling…' : 'Request Sent'}</react_native_1.Text>
      </react_native_1.Pressable>);
    }
    if (status === 'incoming_pending') {
        return (<react_native_1.View style={s.incomingRow}>
        <react_native_1.Pressable style={[s.actionBtn, s.acceptBtnStyle, { flex: 1 }]} onPress={function () { return run(accept); }} disabled={busy}>
          <react_native_1.Text style={[s.btnText, { color: '#fff' }]}>{busy ? '…' : 'Accept'}</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={[s.actionBtn, s.declineBtnStyle, { flex: 1 }]} onPress={function () { return run(decline); }} disabled={busy}>
          <react_native_1.Text style={[s.btnText, { color: tokens_1.color.ink }]}>{busy ? '…' : 'Decline'}</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>);
    }
    return (<react_native_1.Pressable style={[s.actionBtn, s.addFriendBtnStyle]} onPress={function () { return run(send); }} disabled={busy}>
      <lucide_react_native_1.UserPlus size={15} color="#fff"/>
      <react_native_1.Text style={[s.btnText, { color: '#fff' }]}>{busy ? 'Sending…' : 'Add Friend'}</react_native_1.Text>
    </react_native_1.Pressable>);
}
function MessageButton(_a) {
    var _this = this;
    var userId = _a.userId, isOwn = _a.isOwn;
    var _b = (0, useMessaging_1.useMessagePermission)(isOwn ? null : userId), verdict = _b.verdict, loading = _b.loading, send = _b.send;
    var _c = (0, react_1.useState)(false), showComposer = _c[0], setShowComposer = _c[1];
    var _d = (0, react_1.useState)(''), previewText = _d[0], setPreviewText = _d[1];
    var _e = (0, react_1.useState)(false), busy = _e[0], setBusy = _e[1];
    var _f = (0, react_1.useState)(false), sent = _f[0], setSent = _f[1];
    if (isOwn || !userId)
        return null;
    if (loading)
        return null;
    if (verdict === 'denied') {
        return (<react_native_1.View style={[s.actionBtn, s.disabledBtnStyle]}>
        <lucide_react_native_1.MessageCircle size={15} color={tokens_1.color.faint}/>
        <react_native_1.Text style={[s.btnText, { color: tokens_1.color.faint }]}>Not accepting messages</react_native_1.Text>
      </react_native_1.View>);
    }
    if (verdict === 'allowed') {
        return (<react_native_1.Pressable style={[s.actionBtn, s.msgBtnStyle]} onPress={function () { return expo_router_1.router.push('/messages'); }}>
        <lucide_react_native_1.MessageCircle size={15} color={tokens_1.color.ink}/>
        <react_native_1.Text style={[s.btnText, { color: tokens_1.color.ink }]}>Message</react_native_1.Text>
      </react_native_1.Pressable>);
    }
    if (verdict === 'requires_request') {
        if (sent) {
            return (<react_native_1.View style={[s.actionBtn, s.pendingBtnStyle]}>
          <lucide_react_native_1.MessageCircle size={15} color={tokens_1.color.mute}/>
          <react_native_1.Text style={[s.btnText, { color: tokens_1.color.mute }]}>Request sent</react_native_1.Text>
        </react_native_1.View>);
        }
        return (<>
        <react_native_1.Pressable style={[s.actionBtn, s.msgBtnStyle]} onPress={function () { return setShowComposer(true); }}>
          <lucide_react_native_1.MessageCircle size={15} color={tokens_1.color.ink}/>
          <react_native_1.Text style={[s.btnText, { color: tokens_1.color.ink }]}>Message</react_native_1.Text>
        </react_native_1.Pressable>

        <react_native_1.Modal visible={showComposer} transparent animationType="slide">
          <react_native_1.View style={s.modalOverlay}>
            <react_native_1.View style={s.modalCard}>
              <react_native_1.View style={s.modalHeader}>
                <react_native_1.Text style={s.modalTitle}>Send a message request</react_native_1.Text>
                <react_native_1.Pressable onPress={function () { return setShowComposer(false); }} hitSlop={8}>
                  <lucide_react_native_1.X size={20} color={tokens_1.color.ink}/>
                </react_native_1.Pressable>
              </react_native_1.View>
              <react_native_1.TextInput style={s.composerInput} placeholder="Introduce yourself… (optional)" placeholderTextColor={tokens_1.color.faint} value={previewText} onChangeText={setPreviewText} maxLength={280} multiline numberOfLines={3}/>
              <react_native_1.Pressable style={[s.actionBtn, s.addFriendBtnStyle, { marginTop: tokens_1.space.sm }]} disabled={busy} onPress={function () { return __awaiter(_this, void 0, void 0, function () {
                var res;
                var _a;
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0:
                            setBusy(true);
                            return [4 /*yield*/, send(previewText.trim() || undefined)];
                        case 1:
                            res = _b.sent();
                            setBusy(false);
                            if (res.ok) {
                                setSent(true);
                                setShowComposer(false);
                            }
                            else {
                                react_native_1.Alert.alert('Error', (_a = res.message) !== null && _a !== void 0 ? _a : 'Could not send request');
                            }
                            return [2 /*return*/];
                    }
                });
            }); }}>
                <react_native_1.Text style={[s.btnText, { color: '#fff' }]}>
                  {busy ? 'Sending…' : 'Send Request'}
                </react_native_1.Text>
              </react_native_1.Pressable>
            </react_native_1.View>
          </react_native_1.View>
        </react_native_1.Modal>
      </>);
    }
    return null;
}
function KebabMenu(_a) {
    var profile = _a.profile, onBlocked = _a.onBlocked;
    var _b = (0, react_1.useState)(false), open = _b[0], setOpen = _b[1];
    var _c = (0, react_1.useState)(false), blocking = _c[0], setBlocking = _c[1];
    function handleBlock() {
        var _this = this;
        var _a;
        setOpen(false);
        react_native_1.Alert.alert('Block user', "Block ".concat((_a = profile.name) !== null && _a !== void 0 ? _a : "@".concat(profile.handle), "? They won't be able to message you, follow you, or see your profile. You can unblock them any time in Settings."), [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Block',
                style: 'destructive',
                onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                    var res;
                    var _a;
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                setBlocking(true);
                                return [4 /*yield*/, (0, blocks_1.blockUser)(profile.id)];
                            case 1:
                                res = _b.sent();
                                setBlocking(false);
                                if (res.ok) {
                                    onBlocked();
                                }
                                else {
                                    react_native_1.Alert.alert('Error', (_a = res.error) !== null && _a !== void 0 ? _a : 'Could not block user');
                                }
                                return [2 /*return*/];
                        }
                    });
                }); },
            },
        ]);
    }
    return (<>
      <react_native_1.Pressable hitSlop={12} onPress={function () { return setOpen(true); }} style={{ padding: 4 }} disabled={blocking}>
        {blocking
            ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.mute}/>
            : <lucide_react_native_1.MoreVertical size={20} color={tokens_1.color.mute}/>}
      </react_native_1.Pressable>

      <react_native_1.Modal visible={open} transparent animationType="fade" onRequestClose={function () { return setOpen(false); }}>
        <react_native_1.Pressable style={s.menuOverlay} onPress={function () { return setOpen(false); }}>
          <react_native_1.View style={s.menuCard}>
            <react_native_1.Pressable style={s.menuItem} onPress={handleBlock}>
              <lucide_react_native_1.ShieldAlert size={16} color={tokens_1.color.signal}/>
              <react_native_1.Text style={[s.menuItemText, { color: tokens_1.color.signal }]}>Block user</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>
        </react_native_1.Pressable>
      </react_native_1.Modal>
    </>);
}
function Profile() {
    var _this = this;
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    var handle = (0, expo_router_1.useLocalSearchParams)().handle;
    var currentUserId = (0, SessionContext_1.useSession)().userId;
    var _r = (0, react_1.useState)(null), profile = _r[0], setProfile = _r[1];
    var _s = (0, react_1.useState)(true), loading = _s[0], setLoading = _s[1];
    var _t = (0, react_1.useState)(null), loadError = _t[0], setLoadError = _t[1];
    var loadProfile = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!handle)
                        return [2 /*return*/];
                    setLoading(true);
                    setLoadError(null);
                    return [4 /*yield*/, (0, friends_1.getProfileByHandle)(handle)];
                case 1:
                    res = _a.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, (0, friends_1.getProfileById)(handle)];
                case 2:
                    res = _a.sent();
                    _a.label = 3;
                case 3:
                    if (res.ok && res.data)
                        setProfile(res.data);
                    else
                        setLoadError('Could not load this profile.');
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, [handle]);
    (0, react_1.useEffect)(function () { loadProfile(); }, [loadProfile]);
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () { loadProfile(); }, [loadProfile]));
    function handleBlocked() {
        expo_router_1.router.back();
    }
    if (loading) {
        return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
        <ScreenHeader_1.ScreenHeader title={handle ? "@".concat(handle) : 'Profile'} back/>
        <react_native_1.View style={s.center}><react_native_1.ActivityIndicator color={tokens_1.color.signal}/></react_native_1.View>
      </react_native_1.View>);
    }
    if (loadError || !profile) {
        return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
        <ScreenHeader_1.ScreenHeader title="Profile" back/>
        <react_native_1.View style={s.center}><react_native_1.Text style={s.errText}>{loadError !== null && loadError !== void 0 ? loadError : 'Profile not found.'}</react_native_1.Text></react_native_1.View>
      </react_native_1.View>);
    }
    var isOwn = profile.id === currentUserId;
    var locationParts = [
        profile.currentCity ? "Now in ".concat(profile.currentCity) : null,
        profile.homeCity,
        profile.homeCountry,
    ].filter(Boolean);
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title={"@".concat(profile.handle)} back right={!isOwn ? <KebabMenu profile={profile} onBlocked={handleBlocked}/> : undefined}/>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.md }}>

        <react_native_1.View style={s.heroRow}>
          {profile.avatarUrl
            ? <react_native_1.Image source={{ uri: profile.avatarUrl }} style={s.avatar}/>
            : <react_native_1.View style={[s.avatar, s.avatarPlaceholder]}>
                <react_native_1.Text style={s.avatarInitial}>{((_b = (_a = profile.name) === null || _a === void 0 ? void 0 : _a[0]) !== null && _b !== void 0 ? _b : '?').toUpperCase()}</react_native_1.Text>
              </react_native_1.View>}
          <react_native_1.View style={{ flex: 1, gap: 4 }}>
            <react_native_1.View style={s.nameRow}>
              <react_native_1.Text style={s.name} numberOfLines={1}>{profile.name}</react_native_1.Text>
              {profile.verified && <lucide_react_native_1.CheckCircle size={16} color={tokens_1.color.signal}/>}
            </react_native_1.View>
            <react_native_1.Text style={s.handle}>@{profile.handle}</react_native_1.Text>
            {locationParts.length > 0 && <react_native_1.Text style={s.meta}>{locationParts.join(' · ')}</react_native_1.Text>}
          </react_native_1.View>
        </react_native_1.View>

        <react_native_1.View style={s.statsRow}>
          <react_native_1.View style={s.stat}>
            <react_native_1.Text style={s.statNum}>{profile.followersCount}</react_native_1.Text>
            <react_native_1.Text style={s.statLabel}>Followers</react_native_1.Text>
          </react_native_1.View>
          <react_native_1.View style={s.stat}>
            <react_native_1.Text style={s.statNum}>{profile.followingCount}</react_native_1.Text>
            <react_native_1.Text style={s.statLabel}>Following</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>

        {profile.bio ? <react_native_1.Text style={s.bio}>{profile.bio}</react_native_1.Text> : null}

        <react_native_1.View style={s.stampRow}>
          {profile.openToMeet && <ui_1.Stamp label="open to meet" tone="signal"/>}
          {profile.travelStyle ? <ui_1.Stamp label={profile.travelStyle} tone="deep" rotate={2}/> : null}
          {((_c = profile.interests) !== null && _c !== void 0 ? _c : []).slice(0, 3).map(function (i) { return <ui_1.Stamp key={i} label={i} rotate={-2}/>; })}
        </react_native_1.View>

        {(((_e = (_d = profile.travelStyles) === null || _d === void 0 ? void 0 : _d.length) !== null && _e !== void 0 ? _e : 0) > 0 || profile.travelPace || profile.budgetStyle) && (<AboutRow label="TRAVEL STYLE">
            {((_f = profile.travelStyles) !== null && _f !== void 0 ? _f : []).map(function (ts) { return <InfoChip key={ts} label={ts}/>; })}
            {profile.travelPace && <InfoChip label={"".concat(profile.travelPace, " pace")} accent/>}
            {profile.budgetStyle && <InfoChip label={profile.budgetStyle}/>}
          </AboutRow>)}

        {((_h = (_g = profile.spokenLanguages) === null || _g === void 0 ? void 0 : _g.length) !== null && _h !== void 0 ? _h : 0) > 0 && (<AboutRow label="SPEAKS">
            {((_j = profile.spokenLanguages) !== null && _j !== void 0 ? _j : []).map(function (lang) { return <InfoChip key={lang} label={lang}/>; })}
          </AboutRow>)}

        {((_l = (_k = profile.lookingFor) === null || _k === void 0 ? void 0 : _k.length) !== null && _l !== void 0 ? _l : 0) > 0 && (<AboutRow label="LOOKING FOR">
            {((_m = profile.lookingFor) !== null && _m !== void 0 ? _m : []).map(function (lf) { return <InfoChip key={lf} label={lf}/>; })}
          </AboutRow>)}

        {(((_p = (_o = profile.availabilityTags) === null || _o === void 0 ? void 0 : _o.length) !== null && _p !== void 0 ? _p : 0) > 0 || profile.planningStyle) && (<AboutRow label="AVAILABILITY">
            {((_q = profile.availabilityTags) !== null && _q !== void 0 ? _q : []).map(function (tag) { return <InfoChip key={tag} label={tag}/>; })}
            {profile.planningStyle && <InfoChip label={profile.planningStyle.replace(/_/g, ' ')} accent/>}
          </AboutRow>)}

        {!isOwn && (<react_native_1.View style={s.actions}>
            <FriendButton userId={profile.id} isOwn={isOwn}/>
            <MessageButton userId={profile.id} isOwn={isOwn}/>
          </react_native_1.View>)}

        {profile.isPrivate && !isOwn && (<react_native_1.View style={s.privateNote}>
            <lucide_react_native_1.Users size={14} color={tokens_1.color.mute}/>
            <react_native_1.Text style={s.privateText}>This profile is private. Add as a friend to see more.</react_native_1.Text>
          </react_native_1.View>)}
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
function AboutRow(_a) {
    var label = _a.label, children = _a.children;
    return (<react_native_1.View style={s.aboutRow}>
      <react_native_1.Text style={s.aboutLabel}>{label}</react_native_1.Text>
      <react_native_1.View style={s.aboutChips}>{children}</react_native_1.View>
    </react_native_1.View>);
}
function InfoChip(_a) {
    var label = _a.label, _b = _a.accent, accent = _b === void 0 ? false : _b;
    return (<react_native_1.View style={[s.infoChip, accent && s.infoChipAccent]}>
      <react_native_1.Text style={[s.infoChipText, accent && s.infoChipTextAccent]}>{label}</react_native_1.Text>
    </react_native_1.View>);
}
var s = react_native_1.StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    errText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    heroRow: { flexDirection: 'row', gap: tokens_1.space.md, alignItems: 'flex-start' },
    avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: tokens_1.color.haze, flexShrink: 0 },
    avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised },
    avatarInitial: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 28 }),
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
    name: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 20, flexShrink: 1 }),
    handle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep }),
    statsRow: { flexDirection: 'row', gap: tokens_1.space.xl },
    stat: { alignItems: 'center' },
    statNum: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18 }),
    statLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    bio: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    stampRow: { flexDirection: 'row', gap: tokens_1.space.sm, flexWrap: 'wrap' },
    actions: { gap: tokens_1.space.sm, marginTop: tokens_1.space.sm },
    incomingRow: { flexDirection: 'row', gap: tokens_1.space.sm },
    actionBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6, paddingVertical: 11, paddingHorizontal: tokens_1.space.lg,
        borderRadius: tokens_1.radius.pill,
    },
    btnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', fontSize: 14 }),
    addFriendBtnStyle: { backgroundColor: tokens_1.color.ink },
    pendingBtnStyle: { borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    friendsBtnStyle: { borderWidth: 1, borderColor: tokens_1.color.signal, backgroundColor: tokens_1.color.paperRaised },
    acceptBtnStyle: { backgroundColor: tokens_1.color.signal },
    declineBtnStyle: { borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    msgBtnStyle: { borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    disabledBtnStyle: { borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper },
    privateNote: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.md, borderRadius: 10, backgroundColor: tokens_1.color.paperRaised },
    privateText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, flex: 1 }),
    aboutRow: { gap: 6 },
    aboutLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: tokens_1.color.mute, letterSpacing: 0.8 },
    aboutChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    infoChip: { borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: tokens_1.color.paperRaised },
    infoChipAccent: { backgroundColor: tokens_1.color.deep, borderColor: tokens_1.color.deep },
    infoChipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600', fontSize: 12 }),
    infoChipTextAccent: { color: tokens_1.color.onInk },
    modalOverlay: { flex: 1, backgroundColor: 'rgba(17,17,15,0.5)', justifyContent: 'flex-end' },
    modalCard: { backgroundColor: tokens_1.color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: tokens_1.space.xl, gap: tokens_1.space.md },
    modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    modalTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    composerInput: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, backgroundColor: tokens_1.color.paper, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: tokens_1.space.md, minHeight: 80, textAlignVertical: 'top' }),
    menuOverlay: { flex: 1, backgroundColor: 'rgba(17,17,15,0.3)', alignItems: 'flex-end', paddingTop: 60, paddingRight: tokens_1.space.lg },
    menuCard: { backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, minWidth: 160, overflow: 'hidden' },
    menuItem: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.md },
    menuItemText: __assign(__assign({}, tokens_1.type.body), { fontSize: 14, fontWeight: '600' }),
});
