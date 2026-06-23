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
exports.PassportHero = PassportHero;
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_svg_1 = require("react-native-svg");
var lucide_react_native_1 = require("lucide-react-native");
var PassportMarks_1 = require("./PassportMarks");
var verification_1 = require("../lib/verification");
var tokens_1 = require("../theme/tokens");
var HighlightRing_1 = require("./HighlightRing");
var INTEREST_LABEL = {
    nightlife: 'Nightlife', food: 'Food', beach: 'Beach', luxury: 'Luxury',
    culture: 'Culture', adventure: 'Adventure', wellness: 'Wellness',
    photography: 'Photography', backpacking: 'Backpacking', shopping: 'Shopping',
    business: 'Business', dating: 'Social', events: 'Events',
};
function PhotoBackdrop() {
    return (<react_native_svg_1.default style={react_native_1.StyleSheet.absoluteFill} viewBox="0 0 120 120" pointerEvents="none">
      <react_native_svg_1.Defs>
        <react_native_svg_1.Pattern id="wave2" width="20" height="20" patternUnits="userSpaceOnUse">
          <react_native_svg_1.Path d="M0,10 Q5,2 10,10 T20,10" stroke={tokens_1.color.deep} strokeWidth="0.4" fill="none" opacity="0.18"/>
        </react_native_svg_1.Pattern>
      </react_native_svg_1.Defs>
      <react_native_svg_1.Rect x="0" y="0" width="120" height="120" fill="url(#wave2)"/>
      {[28, 22, 16].map(function (r) { return (<react_native_svg_1.Circle key={r} cx="60" cy="60" r={r} stroke={tokens_1.color.deep} strokeWidth="0.5" fill="none" opacity="0.16"/>); })}
    </react_native_svg_1.default>);
}
/** Clean passport hero card — avatar, display name, username, bio (2 lines), home, up to 3 interests. */
function PassportHero(_a) {
    var _b, _c, _d;
    var profile = _a.profile, isOwner = _a.isOwner, onMenuPress = _a.onMenuPress, onAvatarPress = _a.onAvatarPress, isFollowing = _a.isFollowing, followLoading = _a.followLoading, onFollowPress = _a.onFollowPress, hasHighlights = _a.hasHighlights, allHighlightsViewed = _a.allHighlightsViewed, onHighlightRingPress = _a.onHighlightRingPress, onNewHighlightPress = _a.onNewHighlightPress;
    var displayName = (_c = (_b = ('displayName' in profile ? profile.displayName : null)) !== null && _b !== void 0 ? _b : profile.avatarUrl) !== null && _c !== void 0 ? _c : 'Traveler';
    var name = ('name' in profile && profile.name) ? profile.name : null;
    var resolvedName = displayName || name || 'Traveler';
    var username = 'username' in profile ? profile.username : null;
    var bio = profile.bio;
    var homeCity = profile.homeCity;
    var homeCountry = profile.homeCountry;
    var interests = (_d = profile.interests) !== null && _d !== void 0 ? _d : [];
    var shown = interests.slice(0, 3);
    var extra = interests.length - 3;
    var avatarUrl = profile.avatarUrl;
    var isVerified = (0, verification_1.isTravelBuddyVerified)(profile);
    var verificationStatus = 'verificationStatus' in profile ? profile.verificationStatus : undefined;
    var ownerPrompt = isOwner ? (0, verification_1.getVerificationOwnerPrompt)(verificationStatus) : null;
    return (<react_native_1.View style={styles.card}>
      <PassportMarks_1.PassportHeroBackdrop />
      {isVerified && <react_native_1.View style={styles.inkStamp}><PassportMarks_1.PassportInkStamp rotate={-8}/></react_native_1.View>}

      {/* Top label */}
      <react_native_1.View style={styles.topRow}>
        <react_native_1.View style={styles.brandRow}>
          <lucide_react_native_1.Plane size={16} color={tokens_1.color.ink}/>
          <react_native_1.Text style={styles.brand}>TRAVEL BUDDY PASSPORT</react_native_1.Text>
        </react_native_1.View>
        {isOwner && onMenuPress ? (<react_native_1.Pressable onPress={onMenuPress} hitSlop={8} style={styles.menuBtn}>
            <lucide_react_native_1.MoreHorizontal size={20} color={tokens_1.color.ink}/>
          </react_native_1.Pressable>) : !isOwner && onFollowPress !== undefined ? (<react_native_1.Pressable onPress={onFollowPress} hitSlop={8} disabled={followLoading} style={[styles.followBtn, isFollowing && styles.followBtnActive]}>
            <react_native_1.Text style={[styles.followText, isFollowing && styles.followTextActive]}>
              {followLoading ? '…' : isFollowing ? 'Following' : '+ Follow'}
            </react_native_1.Text>
          </react_native_1.Pressable>) : null}
      </react_native_1.View>
      <react_native_1.View style={styles.topDivider}/>

      {/* Identity row */}
      <react_native_1.View style={styles.identityRow}>
        {/* Avatar wrapped with HighlightRing */}
        <react_native_1.View style={styles.photoBox}>
          <PassportMarks_1.PassportMonogramWatermark size={130}/>
          <PhotoBackdrop />
          <HighlightRing_1.HighlightRing hasActive={hasHighlights !== null && hasHighlights !== void 0 ? hasHighlights : false} allViewed={allHighlightsViewed !== null && allHighlightsViewed !== void 0 ? allHighlightsViewed : false} size={72} ringWidth={3} gap={3} onPress={onHighlightRingPress !== null && onHighlightRingPress !== void 0 ? onHighlightRingPress : (isOwner && onAvatarPress ? onAvatarPress : undefined)}>
            <react_native_1.View style={styles.photoFrame}>
              {avatarUrl ? (<react_native_1.Image source={{ uri: avatarUrl }} style={styles.photo}/>) : (<react_native_1.View style={[styles.photo, styles.photoEmpty]}>
                  <react_native_1.Text style={{ fontSize: 36 }}>👤</react_native_1.Text>
                </react_native_1.View>)}
            </react_native_1.View>
          </HighlightRing_1.HighlightRing>
          {isOwner && onNewHighlightPress && (<react_native_1.Pressable style={styles.cameraOverlay} onPress={onNewHighlightPress} accessibilityLabel="Add new Highlight">
              <lucide_react_native_1.Camera size={14} color={tokens_1.color.onInk}/>
            </react_native_1.Pressable>)}
        </react_native_1.View>

        {/* Details */}
        <react_native_1.View style={styles.details}>
          <react_native_1.Text style={styles.name} numberOfLines={2}>{resolvedName}</react_native_1.Text>
          {username ? <react_native_1.Text style={styles.handle}>@{username}</react_native_1.Text> : null}
          {bio ? <react_native_1.Text style={styles.bio} numberOfLines={2}>{bio}</react_native_1.Text> : null}
          {(homeCity || homeCountry) ? (<react_native_1.View style={styles.locRow}>
              <lucide_react_native_1.MapPin size={12} color={tokens_1.color.deep}/>
              <react_native_1.Text style={styles.loc} numberOfLines={1}>
                {[homeCity, homeCountry].filter(Boolean).join(', ')}
              </react_native_1.Text>
            </react_native_1.View>) : null}
          {shown.length > 0 && (<react_native_1.View style={styles.interests}>
              {shown.map(function (i) {
                var _a;
                return (<react_native_1.View key={i} style={styles.chip}>
                  <react_native_1.Text style={styles.chipText}>{(_a = INTEREST_LABEL[i]) !== null && _a !== void 0 ? _a : i}</react_native_1.Text>
                </react_native_1.View>);
            })}
              {extra > 0 && (<react_native_1.View style={styles.chip}>
                  <react_native_1.Text style={styles.chipText}>+{extra}</react_native_1.Text>
                </react_native_1.View>)}
            </react_native_1.View>)}
        </react_native_1.View>
      </react_native_1.View>

      {/* Owner-only verification prompt (unverified / pending / rejected / expired) */}
      {!isVerified && ownerPrompt && (<react_native_1.View style={styles.verifyPrompt}>
          <react_native_1.Text style={styles.verifyPromptText}>{ownerPrompt}</react_native_1.Text>
        </react_native_1.View>)}

      {/* MRZ strip */}
      <react_native_1.View style={styles.mrzRow}>
        <react_native_1.Text style={styles.mrzChevron}>‹‹‹‹‹</react_native_1.Text>
        <react_native_1.Text style={styles.mrz} numberOfLines={1}>
          {isVerified
            ? 'TRAVEL BUDDY · VERIFIED TRAVEL ID · SOCIAL PASSPORT'
            : 'TRAVEL BUDDY · SOCIAL PASSPORT'}
        </react_native_1.Text>
        <react_native_1.Text style={styles.mrzChevron}>›››››</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    card: __assign({ margin: tokens_1.space.lg, borderRadius: tokens_1.radius.lg, backgroundColor: '#FBFAF6', borderWidth: 1.5, borderColor: tokens_1.color.haze, padding: tokens_1.space.lg, overflow: 'hidden' }, tokens_1.shadow.card),
    inkStamp: { position: 'absolute', top: 50, right: 12, zIndex: 1 },
    topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    brandRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    brand: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, letterSpacing: 0.5, fontSize: 13 }),
    topDivider: { height: 1, backgroundColor: tokens_1.color.haze, marginVertical: tokens_1.space.md },
    menuBtn: { padding: 4 },
    followBtn: {
        borderWidth: 1, borderColor: tokens_1.color.ink, borderRadius: tokens_1.radius.pill,
        paddingHorizontal: tokens_1.space.md, paddingVertical: 5,
    },
    followBtnActive: { backgroundColor: tokens_1.color.ink },
    followText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '700' }),
    followTextActive: { color: tokens_1.color.onInk },
    identityRow: { flexDirection: 'row', gap: tokens_1.space.md },
    photoBox: { width: 110, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 4 },
    photoFrame: __assign({ width: 96, height: 110, borderRadius: 8, borderWidth: 2, borderColor: tokens_1.color.paper, backgroundColor: tokens_1.color.haze, overflow: 'hidden' }, tokens_1.shadow.card),
    photo: { width: '100%', height: '100%' },
    photoEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0EDE8' },
    cameraOverlay: {
        position: 'absolute', bottom: 4, right: 4,
        backgroundColor: tokens_1.color.ink, borderRadius: 12, padding: 5,
        borderWidth: 1.5, borderColor: tokens_1.color.paper,
    },
    details: { flex: 1, gap: 6 },
    name: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 22, lineHeight: 28 }),
    handle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontFamily: 'Courier', fontSize: 12 }),
    bio: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontSize: 13, lineHeight: 18 }),
    locRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    loc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontWeight: '600', flex: 1, fontSize: 12 }),
    interests: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 2 },
    chip: {
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.pill,
        paddingHorizontal: 8, paddingVertical: 3,
        borderWidth: 1, borderColor: tokens_1.color.haze,
    },
    chipText: { fontSize: 11, color: tokens_1.color.ink, fontWeight: '600' },
    mrzRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: tokens_1.space.sm, marginTop: tokens_1.space.md, paddingTop: tokens_1.space.md,
        borderTopWidth: 1, borderTopColor: tokens_1.color.haze,
    },
    mrz: { fontFamily: 'Courier', fontSize: 9, color: tokens_1.color.deep, letterSpacing: 1, fontWeight: '700', flex: 1, textAlign: 'center' },
    mrzChevron: { fontFamily: 'Courier', fontSize: 9, color: tokens_1.color.faint },
    verifyPrompt: {
        marginTop: tokens_1.space.sm, alignSelf: 'flex-start',
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.pill,
        paddingHorizontal: tokens_1.space.md, paddingVertical: 4,
        borderWidth: 1, borderColor: tokens_1.color.haze,
    },
    verifyPromptText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600', fontSize: 11 }),
});
