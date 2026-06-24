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
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = PassportScreen;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var usePassport_1 = require("../../src/hooks/usePassport");
var usePostcardActions_1 = require("../../src/hooks/usePostcardActions");
var useRequests_1 = require("../../src/hooks/useRequests");
var useMessaging_1 = require("../../src/hooks/useMessaging");
var usePassportShare_1 = require("../../src/hooks/usePassportShare");
var useHighlightRingState_1 = require("../../src/hooks/useHighlightRingState");
var HighlightViewer_1 = require("../../src/components/HighlightViewer");
var HighlightComposer_1 = require("../../src/components/HighlightComposer");
var SessionContext_1 = require("../../src/context/SessionContext");
var trips_1 = require("../../src/services/trips");
var PassportHero_1 = require("../../src/components/PassportHero");
var CompactStatsRow_1 = require("../../src/components/CompactStatsRow");
var PostcardsTab_1 = require("../../src/components/PostcardsTab");
var StampsTab_1 = require("../../src/components/StampsTab");
var TripsTab_1 = require("../../src/components/TripsTab");
var MapTab_1 = require("../../src/components/MapTab");
var AboutTab_1 = require("../../src/components/AboutTab");
var PassportSettingsSheet_1 = require("../../src/components/PassportSettingsSheet");
var OwnerActionMenu_1 = require("../../src/components/OwnerActionMenu");
var ProfileCompletionCard_1 = require("../../src/components/ProfileCompletionCard");
var PassportShareCard_1 = require("../../src/components/PassportShareCard");
var passport_1 = require("../../src/data/passport");
var tokens_1 = require("../../src/theme/tokens");
var TABS = [
    { key: 'postcards', label: 'Postcards' },
    { key: 'stamps', label: 'Stamps' },
    { key: 'trips', label: 'Trips' },
    { key: 'map', label: 'Map' },
    { key: 'about', label: 'About' },
];
function PassportScreen() {
    var _a, _b, _c, _d, _e, _f;
    var _g = (0, usePassport_1.usePassport)(), profile = _g.profile, postcards = _g.postcards, stamps = _g.stamps, loading = _g.loading, error = _g.error, reload = _g.reload;
    var ownUserId = (0, SessionContext_1.useSession)().userId;
    var _h = (0, react_1.useState)('postcards'), tab = _h[0], setTab = _h[1];
    var _j = (0, react_1.useState)(false), menuOpen = _j[0], setMenuOpen = _j[1];
    var _k = (0, react_1.useState)(false), settingsOpen = _k[0], setSettingsOpen = _k[1];
    var _l = (0, react_1.useState)('profile'), settingsSection = _l[0], setSettingsSection = _l[1];
    var _m = (0, react_1.useState)([]), trips = _m[0], setTrips = _m[1];
    var _o = (0, react_1.useState)(false), tripsLoaded = _o[0], setTripsLoaded = _o[1];
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    // Own highlight ring state — refreshKey forces an immediate cache-bust + re-fetch
    // after a new highlight is created so the ring activates without waiting for TTL.
    var _p = (0, react_1.useState)(0), highlightRefreshKey = _p[0], setHighlightRefreshKey = _p[1];
    var ownRingState = (0, useHighlightRingState_1.useHighlightRingState)(ownUserId, highlightRefreshKey);
    var hasOwnHighlights = (_a = ownRingState === null || ownRingState === void 0 ? void 0 : ownRingState.hasActive) !== null && _a !== void 0 ? _a : false;
    var allOwnHighlightsViewed = (_b = ownRingState === null || ownRingState === void 0 ? void 0 : ownRingState.allViewed) !== null && _b !== void 0 ? _b : false;
    var _q = (0, react_1.useState)(false), highlightViewerOpen = _q[0], setHighlightViewerOpen = _q[1];
    var _r = (0, react_1.useState)(false), highlightComposerOpen = _r[0], setHighlightComposerOpen = _r[1];
    // Tracks whether the composer was triggered from inside the viewer (vs. ring/camera)
    var composerFromViewer = (0, react_1.useRef)(false);
    // Ring press: view existing highlights or open composer to create a new one
    var handleOwnRingPress = (0, react_1.useCallback)(function () {
        if (hasOwnHighlights)
            setHighlightViewerOpen(true);
        else
            setHighlightComposerOpen(true);
    }, [hasOwnHighlights]);
    // Camera button: always opens the composer directly (for adding a new highlight)
    var handleNewHighlightPress = (0, react_1.useCallback)(function () {
        composerFromViewer.current = false;
        setHighlightComposerOpen(true);
    }, []);
    // "+" button inside the viewer: close viewer, open composer, then return to viewer
    var handleAddHighlightFromViewer = (0, react_1.useCallback)(function () {
        composerFromViewer.current = true;
        setHighlightViewerOpen(false);
        setHighlightComposerOpen(true);
    }, []);
    // On successful highlight creation: bust the cache and trigger immediate ring refresh
    var handleHighlightSuccess = (0, react_1.useCallback)(function () {
        if (ownUserId)
            (0, useHighlightRingState_1.invalidateHighlightCache)(ownUserId);
        setHighlightRefreshKey(function (k) { return k + 1; });
        setHighlightComposerOpen(false);
        if (composerFromViewer.current) {
            composerFromViewer.current = false;
            setHighlightViewerOpen(true);
        }
    }, [ownUserId]);
    // On highlight deleted: re-fetch ring state so the ring de-activates immediately
    // if no highlights remain, without waiting for the 60-second cache TTL.
    var handleHighlightDeleted = (0, react_1.useCallback)(function () {
        setHighlightRefreshKey(function (k) { return k + 1; });
    }, []);
    var _s = (0, react_1.useState)([]), localPostcards = _s[0], setLocalPostcards = _s[1];
    react_1.default.useEffect(function () {
        setLocalPostcards(postcards);
    }, [postcards]);
    react_1.default.useEffect(function () {
        if (tab === 'trips' && !tripsLoaded) {
            setTripsLoaded(true);
            (0, trips_1.listMyTrips)().then(setTrips).catch(function () { });
        }
    }, [tab, tripsLoaded]);
    var actions = (0, usePostcardActions_1.usePostcardActions)(setLocalPostcards);
    var openSettings = (0, react_1.useCallback)(function (section) {
        if (section === void 0) { section = 'profile'; }
        setSettingsSection(section);
        setSettingsOpen(true);
    }, []);
    var handleSaved = (0, react_1.useCallback)(function (_updated) {
        reload();
    }, [reload]);
    var handleEditProfile = (0, react_1.useCallback)(function () {
        expo_router_1.router.push('/profile/edit');
    }, []);
    var handleViewAsPublic = (0, react_1.useCallback)(function () {
        var username = profile === null || profile === void 0 ? void 0 : profile.username;
        if (username)
            expo_router_1.router.push("/u/".concat(username));
    }, [profile]);
    if (loading) {
        return (<react_native_1.View style={styles.center}>
        <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
      </react_native_1.View>);
    }
    if (error || !profile) {
        var mock = passport_1.mockPassport;
        var fallbackProfile = {
            id: mock.user.id, handle: mock.user.handle, name: mock.user.name,
            displayName: mock.user.name, username: mock.user.handle,
            bio: (_c = mock.user.bio) !== null && _c !== void 0 ? _c : null, avatarUrl: mock.user.avatarUrl,
            homeCity: mock.user.homeCity, homeCountry: mock.user.homeCountry,
            currentCity: (_d = mock.user.currentCity) !== null && _d !== void 0 ? _d : null, travelStyle: mock.user.travelStyle,
            interests: mock.user.interests, verified: mock.user.verified,
            verificationStatus: mock.user.verified ? 'verified' : 'unverified',
            verifiedAt: null,
            openToMeet: mock.user.openToMeet, isPrivate: mock.user.isPrivate,
            passportVisibility: 'public', coverPhotoUrl: null,
            usernameUpdatedAt: null, createdAt: '2026-01-01T00:00:00Z',
            spokenLanguages: [], defaultLanguage: null, travelStyles: [],
            travelPace: null, budgetStyle: null, travelGroupStyle: [],
            lookingFor: [], comfortLevel: null, availabilityTags: [],
            planningStyle: null, publicSocialLinks: {}, preferredLanguage: null,
        };
        return (<react_native_1.View style={{ flex: 1 }}>
        <PassportContent profile={fallbackProfile} postcards={[]} stamps={mock.stamps} trips={[]} tab={tab} setTab={setTab} menuOpen={menuOpen} setMenuOpen={setMenuOpen} settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen} settingsSection={settingsSection} openSettings={openSettings} actions={actions} handleSaved={handleSaved} handleEditProfile={handleEditProfile} handleViewAsPublic={handleViewAsPublic} reload={reload} insets={insets} hasHighlights={hasOwnHighlights} allHighlightsViewed={allOwnHighlightsViewed} onHighlightRingPress={handleOwnRingPress} onNewHighlightPress={handleNewHighlightPress}/>
        <HighlightViewer_1.HighlightViewer visible={highlightViewerOpen} highlights={(_e = ownRingState === null || ownRingState === void 0 ? void 0 : ownRingState.highlights) !== null && _e !== void 0 ? _e : []} currentUserId={ownUserId !== null && ownUserId !== void 0 ? ownUserId : undefined} onClose={function () { return setHighlightViewerOpen(false); }} onAddHighlight={handleAddHighlightFromViewer} onDeleted={handleHighlightDeleted}/>
        <HighlightComposer_1.HighlightComposer visible={highlightComposerOpen} onClose={function () { return setHighlightComposerOpen(false); }} onSuccess={handleHighlightSuccess}/>
      </react_native_1.View>);
    }
    return (<react_native_1.View style={{ flex: 1 }}>
      <PassportContent profile={profile} postcards={localPostcards} stamps={stamps} trips={trips} tab={tab} setTab={setTab} menuOpen={menuOpen} setMenuOpen={setMenuOpen} settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen} settingsSection={settingsSection} openSettings={openSettings} actions={actions} handleSaved={handleSaved} handleEditProfile={handleEditProfile} handleViewAsPublic={handleViewAsPublic} reload={reload} insets={insets} hasHighlights={hasOwnHighlights} allHighlightsViewed={allOwnHighlightsViewed} onHighlightRingPress={handleOwnRingPress} onNewHighlightPress={handleNewHighlightPress}/>
      <HighlightViewer_1.HighlightViewer visible={highlightViewerOpen} highlights={(_f = ownRingState === null || ownRingState === void 0 ? void 0 : ownRingState.highlights) !== null && _f !== void 0 ? _f : []} currentUserId={ownUserId !== null && ownUserId !== void 0 ? ownUserId : undefined} onClose={function () { return setHighlightViewerOpen(false); }} onAddHighlight={handleAddHighlightFromViewer} onDeleted={handleHighlightDeleted}/>
      <HighlightComposer_1.HighlightComposer visible={highlightComposerOpen} onClose={function () { return setHighlightComposerOpen(false); }} onSuccess={handleHighlightSuccess}/>
    </react_native_1.View>);
}
function PassportContent(_a) {
    var _b, _c, _d, _e, _f, _g;
    var profile = _a.profile, postcards = _a.postcards, stamps = _a.stamps, trips = _a.trips, tab = _a.tab, setTab = _a.setTab, menuOpen = _a.menuOpen, setMenuOpen = _a.setMenuOpen, settingsOpen = _a.settingsOpen, setSettingsOpen = _a.setSettingsOpen, settingsSection = _a.settingsSection, openSettings = _a.openSettings, actions = _a.actions, handleSaved = _a.handleSaved, handleEditProfile = _a.handleEditProfile, handleViewAsPublic = _a.handleViewAsPublic, reload = _a.reload, insets = _a.insets, hasHighlights = _a.hasHighlights, allHighlightsViewed = _a.allHighlightsViewed, onHighlightRingPress = _a.onHighlightRingPress, onNewHighlightPress = _a.onNewHighlightPress;
    var verifiedStamps = stamps.filter(function (s) { return !s.locked; }).length;
    var _h = (0, useRequests_1.useRequestCount)(), requestCount = _h.count, reloadCount = _h.reload;
    var _j = (0, usePassportShare_1.usePassportShare)((_b = profile.username) !== null && _b !== void 0 ? _b : null), cardRef = _j.cardRef, share = _j.share, sharing = _j.sharing;
    var unreadMessages = (0, useMessaging_1.useUnreadCounts)().messages;
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () {
        reloadCount();
        reload();
    }, [reloadCount, reload]));
    return (<react_native_1.View style={{ flex: 1 }}>
      <react_native_1.ScrollView style={{ flex: 1, backgroundColor: tokens_1.color.paper }} contentContainerStyle={{ paddingTop: insets.top, paddingBottom: tokens_1.space.xxxl }} showsVerticalScrollIndicator={false}>
        {/* Profile header */}
        <PassportHero_1.PassportHero profile={profile} isOwner hasHighlights={hasHighlights} allHighlightsViewed={allHighlightsViewed} onMenuPress={function () { return setMenuOpen(true); }} onAvatarPress={function () { return openSettings('profile'); }} onHighlightRingPress={onHighlightRingPress} onNewHighlightPress={onNewHighlightPress}/>

        {/* Compact stats row */}
        <CompactStatsRow_1.CompactStatsRow postcards={postcards} stamps={verifiedStamps} trips={trips}/>

        {/* Telegraph quick action */}
        <react_native_1.Pressable style={styles.telegraphRow} onPress={function () { return expo_router_1.router.push('/(tabs)/messages'); }}>
          <react_native_1.View style={styles.telegraphIcon}>
            <lucide_react_native_1.MessageCircle size={18} color={tokens_1.color.signal}/>
          </react_native_1.View>
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={styles.telegraphTitle}>Telegraph</react_native_1.Text>
            <react_native_1.Text style={styles.telegraphSub}>Messages, trip chats & travel conversations</react_native_1.Text>
          </react_native_1.View>
          {unreadMessages > 0 && (<react_native_1.View style={styles.telegraphBadge}>
              <react_native_1.Text style={styles.telegraphBadgeText}>{unreadMessages > 99 ? '99+' : String(unreadMessages)}</react_native_1.Text>
            </react_native_1.View>)}
        </react_native_1.Pressable>

        {/* Profile completion prompt (owner only) */}
        <ProfileCompletionCard_1.ProfileCompletionCard profile={profile} onOpenSettings={function () { return openSettings('profile'); }}/>

        {/* Tab bar */}
        <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBarWrap} contentContainerStyle={styles.tabBarContent}>
          {TABS.map(function (tb) { return (<react_native_1.Pressable key={tb.key} style={[styles.tab, tab === tb.key && styles.tabActive]} onPress={function () { return setTab(tb.key); }}>
              <react_native_1.Text style={[styles.tabText, tab === tb.key && styles.tabTextActive]}>
                {tb.label}
              </react_native_1.Text>
            </react_native_1.Pressable>); })}
        </react_native_1.ScrollView>

        {/* Tab content */}
        <react_native_1.View style={styles.tabContent}>
          {tab === 'postcards' && (<PostcardsTab_1.PostcardsTab postcards={postcards} isOwner actions={actions}/>)}
          {tab === 'stamps' && <StampsTab_1.StampsTab stamps={stamps}/>}
          {tab === 'trips' && <TripsTab_1.TripsTab trips={trips} isOwner/>}
          {tab === 'map' && <MapTab_1.MapTab postcards={postcards} currentCity={profile.currentCity} currentUserId={profile.id}/>}
          {tab === 'about' && (<AboutTab_1.AboutTab profile={profile} isOwner onOpenSettings={function () { return openSettings('preferences'); }}/>)}
        </react_native_1.View>
      </react_native_1.ScrollView>

      {/* Off-screen share card (captured by usePassportShare) */}
      <react_native_1.View style={styles.offScreen} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <PassportShareCard_1.PassportShareCard ref={cardRef} displayName={(_d = (_c = profile.displayName) !== null && _c !== void 0 ? _c : profile.name) !== null && _d !== void 0 ? _d : null} username={(_e = profile.username) !== null && _e !== void 0 ? _e : null} avatarUrl={(_f = profile.avatarUrl) !== null && _f !== void 0 ? _f : null} tripCount={trips.length} stampCount={verifiedStamps} tagline={(_g = profile.bio) !== null && _g !== void 0 ? _g : null}/>
      </react_native_1.View>

      {/* Owner action menu */}
      <OwnerActionMenu_1.OwnerActionMenu visible={menuOpen} onClose={function () { return setMenuOpen(false); }} username={profile.username} onEditProfile={function () { setMenuOpen(false); handleEditProfile(); }} onSettings={function () { return openSettings('passport'); }} onViewAsPublic={handleViewAsPublic}/>

      {/* Settings sheet */}
      {settingsOpen && (<PassportSettingsSheet_1.PassportSettingsSheet visible={settingsOpen} profile={profile} onClose={function () { return setSettingsOpen(false); }} onSaved={handleSaved}/>)}

      {/* Share button — top-right, next to bell */}
      <react_native_1.Pressable style={[styles.shareBtn, { top: insets.top + tokens_1.space.sm }]} onPress={share} disabled={sharing} hitSlop={8} accessibilityLabel="Share Passport">
        {sharing ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.ink}/>) : (<lucide_react_native_1.Share2 size={18} color={tokens_1.color.ink}/>)}
      </react_native_1.Pressable>

      {/* Notifications bell — absolutely positioned top-right */}
      <react_native_1.Pressable style={[styles.bellBtn, { top: insets.top + tokens_1.space.sm }]} onPress={function () { return expo_router_1.router.push('/notifications'); }} hitSlop={8} accessibilityLabel="Open notifications inbox">
        <lucide_react_native_1.Bell size={20} color={tokens_1.color.ink}/>
        {requestCount > 0 && (<react_native_1.View style={styles.bellBadge}>
            <react_native_1.Text style={styles.bellBadgeText}>{requestCount > 9 ? '9+' : String(requestCount)}</react_native_1.Text>
          </react_native_1.View>)}
      </react_native_1.Pressable>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paper },
    offScreen: {
        position: 'absolute',
        left: -9999,
        top: -9999,
        opacity: 0,
    },
    shareBtn: {
        position: 'absolute',
        right: tokens_1.space.lg + 38 + tokens_1.space.sm,
        zIndex: 20,
        width: 38,
        height: 38,
        borderRadius: 19,
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
    },
    bellBtn: {
        position: 'absolute',
        right: tokens_1.space.lg,
        zIndex: 20,
        width: 38,
        height: 38,
        borderRadius: 19,
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
    },
    bellBadge: {
        position: 'absolute',
        top: -3,
        right: -3,
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    bellBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700', lineHeight: 11 },
    telegraphRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        marginHorizontal: tokens_1.space.lg,
        marginTop: tokens_1.space.sm,
        marginBottom: tokens_1.space.xs,
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderRadius: 14,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: 12,
    },
    telegraphIcon: {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: tokens_1.color.signal + '15',
        alignItems: 'center',
        justifyContent: 'center',
    },
    telegraphTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14, fontWeight: '700' }),
    telegraphSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, marginTop: 1 }),
    telegraphBadge: {
        minWidth: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 5,
    },
    telegraphBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
    tabBarWrap: { marginTop: tokens_1.space.md },
    tabBarContent: { paddingHorizontal: tokens_1.space.lg, gap: tokens_1.space.xs },
    tab: {
        paddingHorizontal: tokens_1.space.md, paddingVertical: 8,
        borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    tabActive: { backgroundColor: tokens_1.color.ink, borderColor: tokens_1.color.ink },
    tabText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '700', fontSize: 13 }),
    tabTextActive: { color: tokens_1.color.onInk },
    tabContent: { marginTop: tokens_1.space.md },
});
