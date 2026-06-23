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
exports.default = Circle;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var follows_1 = require("../src/services/follows");
var messaging_1 = require("../src/services/messaging");
var availability_1 = require("../src/services/availability");
var AvailabilityGrid_1 = require("../src/components/AvailabilityGrid");
var BestDaysBanner_1 = require("../src/components/BestDaysBanner");
var MeetupCreationSheet_1 = require("../src/components/MeetupCreationSheet");
var SessionContext_1 = require("../src/context/SessionContext");
var tokens_1 = require("../src/theme/tokens");
var HighlightRing_1 = require("../src/components/HighlightRing");
var HighlightViewer_1 = require("../src/components/HighlightViewer");
var useHighlightRingState_1 = require("../src/hooks/useHighlightRingState");
function CircleUserRow(_a) {
    var _b, _c, _d, _e, _f;
    var u = _a.u;
    var ringState = (0, useHighlightRingState_1.useHighlightRingState)(u.id);
    var _g = (0, react_1.useState)(false), viewerOpen = _g[0], setViewerOpen = _g[1];
    return (<>
      <react_native_1.Pressable style={styles.row} onPress={function () { return u.handle ? expo_router_1.router.push("/u/".concat(u.handle)) : undefined; }}>
        <HighlightRing_1.HighlightRing hasActive={(_b = ringState === null || ringState === void 0 ? void 0 : ringState.hasActive) !== null && _b !== void 0 ? _b : false} allViewed={(_c = ringState === null || ringState === void 0 ? void 0 : ringState.allViewed) !== null && _c !== void 0 ? _c : false} size={52} ringWidth={2} gap={2} onPress={(ringState === null || ringState === void 0 ? void 0 : ringState.hasActive) ? function () { return setViewerOpen(true); } : undefined}>
          {u.avatarUrl ? (<react_native_1.Image source={{ uri: u.avatarUrl }} style={styles.avatar}/>) : (<react_native_1.View style={[styles.avatar, styles.avatarEmpty]}>
              <react_native_1.Text style={{ fontSize: 22 }}>👤</react_native_1.Text>
            </react_native_1.View>)}
        </HighlightRing_1.HighlightRing>
        <react_native_1.View style={{ flex: 1 }}>
          <react_native_1.Text style={styles.name}>{(_e = (_d = u.name) !== null && _d !== void 0 ? _d : u.handle) !== null && _e !== void 0 ? _e : 'Traveler'}</react_native_1.Text>
          {u.handle ? <react_native_1.Text style={styles.handle}>@{u.handle}</react_native_1.Text> : null}
        </react_native_1.View>
      </react_native_1.Pressable>
      <HighlightViewer_1.HighlightViewer visible={viewerOpen} highlights={(_f = ringState === null || ringState === void 0 ? void 0 : ringState.highlights) !== null && _f !== void 0 ? _f : []} onClose={function () { return setViewerOpen(false); }}/>
    </>);
}
function next14Days() {
    var days = [];
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    for (var i = 0; i < 14; i++) {
        var d = new Date(today);
        d.setDate(d.getDate() + i);
        days.push(d.toISOString().slice(0, 10));
    }
    return days;
}
function Circle() {
    var _this = this;
    var _a = (0, SessionContext_1.useSession)(), userId = _a.userId, isAuthed = _a.isAuthed, configured = _a.configured;
    var _b = (0, react_1.useState)('circle'), tab = _b[0], setTab = _b[1];
    var _c = (0, react_1.useState)([]), following = _c[0], setFollowing = _c[1];
    var _d = (0, react_1.useState)([]), followers = _d[0], setFollowers = _d[1];
    var _e = (0, react_1.useState)(true), loading = _e[0], setLoading = _e[1];
    var _f = (0, react_1.useState)(false), refreshing = _f[0], setRefreshing = _f[1];
    var _g = (0, react_1.useState)(false), chatLoading = _g[0], setChatLoading = _g[1];
    var _h = (0, react_1.useState)([]), avMembers = _h[0], setAvMembers = _h[1];
    var _j = (0, react_1.useState)(false), avExpanded = _j[0], setAvExpanded = _j[1];
    var _k = (0, react_1.useState)(null), meetupDate = _k[0], setMeetupDate = _k[1];
    var _l = (0, react_1.useState)(null), selectedDay = _l[0], setSelectedDay = _l[1];
    var live = configured && isAuthed;
    var circleDays = (0, react_1.useMemo)(function () { return next14Days(); }, []);
    var load = (0, react_1.useCallback)(function () {
        var args_1 = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args_1[_i] = arguments[_i];
        }
        return __awaiter(_this, __spreadArray([], args_1, true), void 0, function (isRefresh) {
            var _a, fwRes, frRes;
            var _b, _c;
            if (isRefresh === void 0) { isRefresh = false; }
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        if (isRefresh)
                            setRefreshing(true);
                        else
                            setLoading(true);
                        return [4 /*yield*/, Promise.all([(0, follows_1.getMyFollowing)(), (0, follows_1.getMyFollowers)()])];
                    case 1:
                        _a = _d.sent(), fwRes = _a[0], frRes = _a[1];
                        setFollowing((_b = fwRes.data) !== null && _b !== void 0 ? _b : []);
                        setFollowers((_c = frRes.data) !== null && _c !== void 0 ? _c : []);
                        if (isRefresh)
                            setRefreshing(false);
                        else
                            setLoading(false);
                        return [2 /*return*/];
                }
            });
        });
    }, []);
    (0, react_1.useEffect)(function () {
        if (live && userId) {
            (0, availability_1.getCircleAvailability)(userId).then(function (res) {
                if (res.ok && res.data)
                    setAvMembers(res.data.members);
            });
        }
    }, [live, userId]);
    (0, react_1.useEffect)(function () { load(); }, [load]);
    var list = tab === 'circle' ? following : followers;
    function handleOpenCircleChat() {
        return __awaiter(this, void 0, void 0, function () {
            var res, _a, threadId, title, params;
            var _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!userId || chatLoading)
                            return [2 /*return*/];
                        setChatLoading(true);
                        return [4 /*yield*/, (0, messaging_1.openCircleChat)(userId)];
                    case 1:
                        res = _c.sent();
                        setChatLoading(false);
                        if (res.ok && res.data) {
                            _a = res.data, threadId = _a.threadId, title = _a.title;
                            params = new URLSearchParams({ title: title !== null && title !== void 0 ? title : 'My Circle', threadType: 'circle', contextId: userId !== null && userId !== void 0 ? userId : '' });
                            expo_router_1.router.push("/messages/".concat(threadId, "?").concat(params.toString()));
                        }
                        else {
                            react_native_1.Alert.alert('Chat unavailable', (_b = res.message) !== null && _b !== void 0 ? _b : 'Could not open your circle chat.');
                        }
                        return [2 /*return*/];
                }
            });
        });
    }
    var freeCount = avMembers.filter(function (m) { var _a; return ((_a = m.quickStatus) === null || _a === void 0 ? void 0 : _a.status) === 'free_now'; }).length;
    // Compute best days client-side from weekly availability + upcoming 14 days
    var WDAY_IDX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    var bestDays = (0, react_1.useMemo)(function () {
        return circleDays
            .map(function (date) {
            var wd = WDAY_IDX[new Date(date + 'T12:00:00').getDay()];
            var count = avMembers.filter(function (m) {
                var _a, _b;
                if (Object.keys(m.weeklyDays).length === 0)
                    return false;
                return ((_b = (_a = m.weeklyDays[wd]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) > 0;
            }).length;
            return { date: date, count: count };
        })
            .filter(function (d) { return d.count >= 2; })
            .sort(function (a, b) { return b.count - a.count; })
            .slice(0, 3);
    }, [avMembers, circleDays]);
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Circle" back right={<react_native_1.Pressable onPress={function () { return expo_router_1.router.push('/discover'); }} hitSlop={8} style={styles.discoverBtn}>
            <lucide_react_native_1.Compass size={22} color={tokens_1.color.signal}/>
          </react_native_1.Pressable>}/>

      {userId ? (<react_native_1.Pressable style={styles.chatBtn} onPress={function () { return expo_router_1.router.push("/circle-chat?ownerId=".concat(userId)); }}>
          <react_native_1.View style={{ position: 'relative' }}>
            <lucide_react_native_1.MessageCircle size={15} color={tokens_1.color.onInk}/>
            <react_native_1.View style={styles.unreadDot}/>
          </react_native_1.View>
          <react_native_1.Text style={styles.chatBtnText}>Circle Chat</react_native_1.Text>
        </react_native_1.Pressable>) : null}

      <react_native_1.View style={styles.tabBar}>
        <react_native_1.Pressable style={[styles.tab, tab === 'circle' && styles.tabActive]} onPress={function () { return setTab('circle'); }}>
          <react_native_1.Text style={[styles.tabText, tab === 'circle' && styles.tabTextActive]}>
            Following{following.length > 0 ? " ".concat(following.length) : ''}
          </react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={[styles.tab, tab === 'followers' && styles.tabActive]} onPress={function () { return setTab('followers'); }}>
          <react_native_1.Text style={[styles.tabText, tab === 'followers' && styles.tabTextActive]}>
            Followers{followers.length > 0 ? " ".concat(followers.length) : ''}
          </react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>

      {tab === 'circle' && userId && (<react_native_1.Pressable style={[styles.chatBanner, chatLoading && { opacity: 0.6 }]} onPress={handleOpenCircleChat} disabled={chatLoading}>
          {chatLoading
                ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>
                : <lucide_react_native_1.MessageCircle size={16} color={tokens_1.color.onInk}/>}
          <react_native_1.Text style={styles.chatBannerText}>Circle Group Chat</react_native_1.Text>
          <react_native_1.Text style={styles.chatBannerSub}>Message everyone in your circle</react_native_1.Text>
        </react_native_1.Pressable>)}

      {loading ? (<react_native_1.View style={styles.center}>
          <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
        </react_native_1.View>) : (<react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.md }} refreshControl={<react_native_1.RefreshControl refreshing={refreshing} onRefresh={function () { return load(true); }} tintColor={tokens_1.color.signal}/>}>
          {/* ── Availability grid — shown when circle data is loaded ── */}
          {live && avMembers.length > 0 && (<react_native_1.View style={styles.avSection}>
              <react_native_1.Pressable style={styles.avHead} onPress={function () { return setAvExpanded(function (v) { return !v; }); }}>
                <lucide_react_native_1.CalendarClock size={14} color={tokens_1.color.deep}/>
                <react_native_1.Text style={styles.avTitle}>Circle Availability</react_native_1.Text>
                {freeCount > 0 && (<react_native_1.View style={styles.avBadge}>
                    <react_native_1.Text style={styles.avBadgeText}>{freeCount} free now</react_native_1.Text>
                  </react_native_1.View>)}
                <react_native_1.View style={{ flex: 1 }}/>
                {avExpanded
                    ? <lucide_react_native_1.ChevronUp size={16} color={tokens_1.color.mute}/>
                    : <lucide_react_native_1.ChevronDown size={16} color={tokens_1.color.mute}/>}
              </react_native_1.Pressable>

              {avExpanded && (<react_native_1.View style={styles.avCard}>
                  {bestDays.length > 0 && (<BestDaysBanner_1.BestDaysBanner bestDays={bestDays} totalMembers={avMembers.length} onDayPress={function (date) { return setSelectedDay(date); }}/>)}
                  <AvailabilityGrid_1.AvailabilityGrid members={avMembers} days={circleDays} currentUserId={userId !== null && userId !== void 0 ? userId : ''} mode="circle" onEditOwn={function () { return expo_router_1.router.push('/availability'); }} onPlanMeetup={function (date) { return setMeetupDate(date); }} selectedDay={selectedDay} onSelectedDayChange={setSelectedDay}/>
                  <react_native_1.Pressable style={styles.avEditBtn} onPress={function () { return expo_router_1.router.push('/availability'); }}>
                    <react_native_1.Text style={styles.avEditBtnText}>Update my availability →</react_native_1.Text>
                  </react_native_1.Pressable>
                </react_native_1.View>)}
            </react_native_1.View>)}

          {/* ── Following / Followers list ── */}
          {list.map(function (u) { return (<CircleUserRow key={u.id} u={u}/>); })}
          {list.length === 0 && (<react_native_1.View style={styles.emptyBox}>
              <react_native_1.Text style={styles.emptyIcon}>{tab === 'circle' ? '🌍' : '👥'}</react_native_1.Text>
              <react_native_1.Text style={styles.emptyTitle}>
                {tab === 'circle' ? 'No one in your circle yet' : 'No followers yet'}
              </react_native_1.Text>
              <react_native_1.Text style={styles.emptyNote}>
                {tab === 'circle'
                    ? 'Find travelers and follow them to build your circle.'
                    : 'Share your passport and connect with other travelers.'}
              </react_native_1.Text>
            </react_native_1.View>)}
        </react_native_1.ScrollView>)}

      {/* Meetup creation — triggered from availability grid "Plan meetup this day" */}
      {meetupDate && userId && (<MeetupCreationSheet_1.MeetupCreationSheet circleOwnerId={userId} initialTitle={"Meetup \u2014 ".concat(meetupDate)} onDismiss={function () { return setMeetupDate(null); }} onCreated={function () { return setMeetupDate(null); }}/>)}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    chatBtn: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.md, paddingVertical: tokens_1.space.sm + 2, paddingHorizontal: tokens_1.space.lg, borderRadius: tokens_1.radius.pill, backgroundColor: tokens_1.color.signal },
    chatBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontSize: 14 }),
    unreadDot: { position: 'absolute', top: -3, right: -3, width: 7, height: 7, borderRadius: 4, backgroundColor: tokens_1.color.onInk },
    tabBar: { flexDirection: 'row', gap: tokens_1.space.sm, margin: tokens_1.space.lg, marginBottom: 0, padding: 4, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.pill },
    tab: { flex: 1, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, alignItems: 'center' },
    tabActive: { backgroundColor: tokens_1.color.ink },
    tabText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.mute, fontSize: 13 }),
    tabTextActive: { color: tokens_1.color.onInk },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    chatBanner: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.md, marginBottom: 0,
        backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md,
        paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.md,
    },
    chatBannerText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, flex: 1 }),
    chatBannerSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk + 'BB', fontSize: 11 }),
    avSection: { borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised, overflow: 'hidden' },
    avHead: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.md },
    avTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    avBadge: { backgroundColor: '#FEF9C3', paddingHorizontal: 7, paddingVertical: 2, borderRadius: tokens_1.radius.pill },
    avBadgeText: { fontSize: 11, fontWeight: '700', color: '#A16207' },
    avCard: { borderTopWidth: 1, borderTopColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.md, paddingBottom: tokens_1.space.md, gap: tokens_1.space.sm },
    avEditBtn: { alignSelf: 'flex-start' },
    avEditBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md },
    avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: tokens_1.color.haze },
    avatarEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0EDE8' },
    name: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    handle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2, fontFamily: 'Courier' }),
    emptyBox: { alignItems: 'center', gap: tokens_1.space.sm, paddingVertical: tokens_1.space.xxl },
    emptyIcon: { fontSize: 48 },
    emptyTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, textAlign: 'center' }),
    emptyNote: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center', lineHeight: 18 }),
    discoverBtn: { padding: 4 },
});
