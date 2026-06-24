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
exports.default = TripDetail;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var TripPage_1 = require("../../src/components/TripPage");
var TripPage2_1 = require("../../src/components/TripPage2");
var TripPlanSection_1 = require("../../src/components/TripPlanSection");
var TripAvailabilitySection_1 = require("../../src/components/TripAvailabilitySection");
var DailyBriefCard_1 = require("../../src/components/DailyBriefCard");
var ConciergeCommandBar_1 = require("../../src/components/ConciergeCommandBar");
var MeetupCreationSheet_1 = require("../../src/components/MeetupCreationSheet");
var tripDetail_1 = require("../../src/data/tripDetail");
var SessionContext_1 = require("../../src/context/SessionContext");
var useBackend_1 = require("../../src/hooks/useBackend");
var messaging_1 = require("../../src/services/messaging");
var tokens_1 = require("../../src/theme/tokens");
function TripDetail() {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    var id = (0, expo_router_1.useLocalSearchParams)().id;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _j = (0, SessionContext_1.useSession)(), configured = _j.configured, isAuthed = _j.isAuthed, userId = _j.userId;
    var live = configured && isAuthed;
    var _k = (0, useBackend_1.useTrip)(live ? id : undefined), realTrip = _k.data, loading = _k.loading;
    var invites = (0, useBackend_1.usePendingTripInvites)().invites;
    var isPendingInvite = live ? invites.some(function (inv) { return inv.tripId === id; }) : false;
    var pageScrollRef = (0, react_1.useRef)(null);
    var commandBarRef = (0, react_1.useRef)(null);
    var commandBarY = (0, react_1.useRef)(0);
    var _l = (0, react_1.useState)(false), chatLoading = _l[0], setChatLoading = _l[1];
    var _m = (0, react_1.useState)(null), meetupDate = _m[0], setMeetupDate = _m[1];
    var _o = (0, react_1.useState)([]), gapDays = _o[0], setGapDays = _o[1];
    var _p = (0, react_1.useState)(''), gapDestination = _p[0], setGapDestination = _p[1];
    var handleGapDays = (0, react_1.useCallback)(function (days, dest) {
        setGapDays(days);
        setGapDestination(dest);
    }, []);
    var handleGapDayChipPress = (0, react_1.useCallback)(function () {
        var _a;
        (_a = pageScrollRef.current) === null || _a === void 0 ? void 0 : _a.scrollTo({ y: commandBarY.current, animated: true });
        // Small delay lets the scroll animation start before the keyboard appears
        setTimeout(function () { var _a; (_a = commandBarRef.current) === null || _a === void 0 ? void 0 : _a.focus(); }, 350);
    }, []);
    var trip = live && realTrip ? __assign(__assign({}, tripDetail_1.mockTripDetail), { id: realTrip.id, title: realTrip.title, destinationCity: realTrip.destinationCity, destinationCountry: (_a = realTrip.destinationCountry) !== null && _a !== void 0 ? _a : tripDetail_1.mockTripDetail.destinationCountry, startDate: (_b = realTrip.startDate) !== null && _b !== void 0 ? _b : tripDetail_1.mockTripDetail.startDate, endDate: (_c = realTrip.endDate) !== null && _c !== void 0 ? _c : tripDetail_1.mockTripDetail.endDate, status: realTrip.status, visibility: realTrip.visibility, coverUrl: (_d = realTrip.coverUrl) !== null && _d !== void 0 ? _d : tripDetail_1.mockTripDetail.coverUrl }) : tripDetail_1.mockTripDetail;
    function handleOpenChat() {
        return __awaiter(this, void 0, void 0, function () {
            var res, _a, threadId, title, params;
            var _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        if (!trip.id || chatLoading)
                            return [2 /*return*/];
                        setChatLoading(true);
                        return [4 /*yield*/, (0, messaging_1.openTripChat)(trip.id)];
                    case 1:
                        res = _d.sent();
                        setChatLoading(false);
                        if (res.ok && res.data) {
                            _a = res.data, threadId = _a.threadId, title = _a.title;
                            params = new URLSearchParams({ title: (_b = title !== null && title !== void 0 ? title : trip.title) !== null && _b !== void 0 ? _b : 'Trip Chat', threadType: 'trip', contextId: trip.id });
                            expo_router_1.router.push("/messages/".concat(threadId, "?").concat(params.toString()));
                        }
                        else {
                            react_native_1.Alert.alert('Chat unavailable', (_c = res.message) !== null && _c !== void 0 ? _c : 'Could not open the trip chat. Make sure you are an accepted trip member.');
                        }
                        return [2 /*return*/];
                }
            });
        });
    }
    if (live && loading) {
        return <react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper, alignItems: 'center', justifyContent: 'center' }}><react_native_1.ActivityIndicator color={tokens_1.color.signal}/></react_native_1.View>;
    }
    var todayDate = new Date().toISOString().slice(0, 10);
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <react_native_1.View style={[styles.topBar, { paddingTop: insets.top + tokens_1.space.sm }]}>
        <react_native_1.Pressable style={styles.backBtn} onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}>
          <lucide_react_native_1.ChevronLeft size={22} color={tokens_1.color.signal}/>
          <react_native_1.Text style={styles.backText}>My Trip</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.View style={{ flex: 1 }}/>
        {isAuthed && (<react_native_1.Pressable style={[styles.topBtn, chatLoading && { opacity: 0.5 }]} onPress={handleOpenChat} disabled={chatLoading} hitSlop={6}>
            {chatLoading
                ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>
                : (<react_native_1.View style={{ position: 'relative' }}>
                  <lucide_react_native_1.MessageCircle size={15} color={tokens_1.color.signal}/>
                  <react_native_1.View style={styles.unreadDot}/>
                </react_native_1.View>)}
            <react_native_1.Text style={[styles.topBtnText, { color: tokens_1.color.signal }]}>Chat</react_native_1.Text>
          </react_native_1.Pressable>)}
        <react_native_1.Pressable style={styles.topBtn} hitSlop={6} onPress={function () {
            react_native_1.Share.share({
                message: "Check out my trip".concat(trip.title ? " \u2014 ".concat(trip.title) : '', "!\nhttps://travelbuddy.app/trips/").concat(trip.id),
            }).catch(function () {
                react_native_1.Alert.alert('Could not share', 'Sharing is not available on this device right now.');
            });
        }}>
          <lucide_react_native_1.Share2 size={15} color={tokens_1.color.ink}/><react_native_1.Text style={styles.topBtnText}>Share Trip</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={styles.topBtn} hitSlop={6} onPress={function () {
            return react_native_1.Alert.alert('Edit Trip', 'Trip editing is coming soon. You\'ll be able to update destination, dates, and visibility here.', [{ text: 'OK' }]);
        }}>
          <lucide_react_native_1.Pencil size={15} color={tokens_1.color.ink}/><react_native_1.Text style={styles.topBtnText}>Edit Trip</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={styles.topIcon} hitSlop={6} onPress={function () {
            return react_native_1.Alert.alert('Trip Options', 'More trip options coming soon.', [{ text: 'OK' }]);
        }}>
          <lucide_react_native_1.MoreHorizontal size={18} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>
      </react_native_1.View>

      <react_native_1.ScrollView ref={pageScrollRef} contentContainerStyle={{ paddingBottom: tokens_1.space.xxxl }} showsVerticalScrollIndicator={false}>
        <TripPage_1.TripHero trip={trip}/>

        {/* ── Daily Brief (accepted members only; graceful fallback for others) ── */}
        {live && trip.id ? (<DailyBriefCard_1.DailyBriefCard tripId={trip.id} date={todayDate} onGapDays={handleGapDays}/>) : null}

        <TripPage_1.TodayNextUp nextUp={tripDetail_1.mockNextUp}/>

        {/* ── Gap-day nudge ── */}
        {live && gapDays.length > 0 && trip.status !== 'planning' && (<GapDayNudgeSection gapDays={gapDays} destination={gapDestination || trip.destinationCity || ''} tripId={trip.id} onChipPress={handleGapDayChipPress}/>)}

        {/* ── Concierge Command Bar ── */}
        {live && trip.id ? (<react_native_1.View onLayout={function (e) { commandBarY.current = e.nativeEvent.layout.y; }}>
            <ConciergeCommandBar_1.ConciergeCommandBar ref={commandBarRef} tripId={trip.id} destination={trip.destinationCity}/>
          </react_native_1.View>) : null}

        <TripPlanSection_1.TripPlanSection tripId={trip.id} currentUserId={userId !== null && userId !== void 0 ? userId : ''} isOwner={realTrip ? userId === realTrip.ownerId : false} isPendingInvite={isPendingInvite} tripStartDate={(_e = realTrip === null || realTrip === void 0 ? void 0 : realTrip.startDate) !== null && _e !== void 0 ? _e : undefined} tripEndDate={(_f = realTrip === null || realTrip === void 0 ? void 0 : realTrip.endDate) !== null && _f !== void 0 ? _f : undefined} pageScrollRef={pageScrollRef}/>
        {live && trip.id ? (<TripAvailabilitySection_1.TripAvailabilitySection tripId={trip.id} currentUserId={userId !== null && userId !== void 0 ? userId : ''} startDate={(_g = realTrip === null || realTrip === void 0 ? void 0 : realTrip.startDate) !== null && _g !== void 0 ? _g : undefined} endDate={(_h = realTrip === null || realTrip === void 0 ? void 0 : realTrip.endDate) !== null && _h !== void 0 ? _h : undefined} onPlanMeetup={function (date) { return setMeetupDate(date); }}/>) : null}
        <TripPage_1.SavedIdeas ideas={trip.savedIdeas}/>
        <TripPage2_1.TripPlans plans={tripDetail_1.tripPlans}/>
        <TripPage2_1.TripCircle cityCount={tripDetail_1.tripCircle.cityCount} inCity={tripDetail_1.tripCircle.inCity} suggested={tripDetail_1.tripCircle.suggested}/>
        <TripPage2_1.CompassTripBrief />
        <TripPage2_1.TripStamps stamps={tripDetail_1.tripStamps}/>
        <TripMapPlaceholder />
        <TripPage2_1.TripSafety />
        <TripPage2_1.TripPostsSection posts={tripDetail_1.tripPosts}/>
      </react_native_1.ScrollView>

      {/* Meetup creation — triggered from availability grid "Plan meetup this day" */}
      {meetupDate && (<MeetupCreationSheet_1.MeetupCreationSheet tripId={trip.id} initialTitle={"Meetup \u2014 ".concat(meetupDate)} onDismiss={function () { return setMeetupDate(null); }} onCreated={function () { return setMeetupDate(null); }}/>)}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    topBar: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.sm, backgroundColor: tokens_1.color.paper, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    backText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal }),
    topBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    topBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    topIcon: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised },
    unreadDot: { position: 'absolute', top: -3, right: -3, width: 7, height: 7, borderRadius: 4, backgroundColor: tokens_1.color.signal },
});
function formatGapLabel(dateStr) {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en', {
        weekday: 'short', month: 'short', day: 'numeric',
    });
}
function GapDayNudgeSection(_a) {
    var gapDays = _a.gapDays, _destination = _a.destination, _tripId = _a.tripId, onChipPress = _a.onChipPress;
    return (<react_native_1.View style={gn.wrap}>
      <react_native_1.Text style={gn.label}>UNPLANNED DAYS</react_native_1.Text>
      <react_native_1.Text style={gn.hint}>Tap a day to ask Telegraph for ideas</react_native_1.Text>
      <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={gn.row}>
        {gapDays.map(function (d) {
            var label = formatGapLabel(d);
            return (<react_native_1.Pressable key={d} style={gn.chip} onPress={onChipPress}>
              <lucide_react_native_1.Calendar size={11} color={tokens_1.color.signal}/>
              <react_native_1.Text style={gn.chipText}>{label}</react_native_1.Text>
            </react_native_1.Pressable>);
        })}
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var gn = react_native_1.StyleSheet.create({
    wrap: { paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.lg, gap: 4 },
    label: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, fontSize: 10, letterSpacing: 0.8 }),
    hint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, marginBottom: 4 }),
    row: { gap: tokens_1.space.sm, paddingVertical: 2 },
    chip: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        paddingHorizontal: tokens_1.space.md, paddingVertical: 7,
        borderRadius: tokens_1.radius.pill, borderWidth: 1,
        borderColor: tokens_1.color.signal, backgroundColor: '#FFF5F5',
    },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 12 }),
});
function TripMapPlaceholder() {
    return (<react_native_1.View style={mp.wrap}>
      <react_native_1.Text style={mp.h}>Trip Map</react_native_1.Text>
      <react_native_1.View style={mp.card}>
        <react_native_1.View style={mp.iconWrap}><lucide_react_native_1.Map size={26} color={tokens_1.color.deep}/></react_native_1.View>
        <react_native_1.Text style={mp.title}>Map coming soon</react_native_1.Text>
        <react_native_1.Text style={mp.sub}>Saved places and trip pins will appear here.</react_native_1.Text>
        <react_native_1.View style={mp.privacy}>
          <lucide_react_native_1.Lock size={12} color={tokens_1.color.mute}/>
          <react_native_1.Text style={mp.privacyText}>Location sharing is private by default.</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.View>);
}
var mp = react_native_1.StyleSheet.create({
    wrap: { paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xl, gap: tokens_1.space.md },
    h: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18 }),
    card: { backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, borderStyle: 'dashed', padding: tokens_1.space.xl, alignItems: 'center', gap: 6 },
    iconWrap: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 15 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center' }),
    privacy: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: tokens_1.space.sm, backgroundColor: tokens_1.color.paper, paddingHorizontal: tokens_1.space.md, paddingVertical: 5, borderRadius: tokens_1.radius.pill },
    privacyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
});
