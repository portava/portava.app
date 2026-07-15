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
var expo_router_1 = require("expo-router");
var react_native_svg_1 = require("react-native-svg");
var lucide_react_native_1 = require("lucide-react-native");
var ui_1 = require("./ui");
var PassportMarks_1 = require("./PassportMarks");
var tokens_1 = require("../theme/tokens");
var INTEREST_LABEL = {
    nightlife: 'Nightlife', food: 'Food', beach: 'Beach', luxury: 'Luxury',
    culture: 'Culture', adventure: 'Adventure', wellness: 'Wellness',
    photography: 'Photography', backpacking: 'Backpacking', shopping: 'Shopping',
    business: 'Business', dating: 'Social', events: 'Events',
};
/** Guilloche + watermark seal behind the profile photo — passport security feel. */
function PhotoBackdrop() {
    return (<react_native_svg_1.default style={react_native_1.StyleSheet.absoluteFill} viewBox="0 0 160 200" pointerEvents="none">
      <react_native_svg_1.Defs>
        <react_native_svg_1.Pattern id="wave" width="20" height="20" patternUnits="userSpaceOnUse">
          <react_native_svg_1.Path d="M0,10 Q5,2 10,10 T20,10" stroke={tokens_1.color.deep} strokeWidth="0.4" fill="none" opacity="0.18"/>
        </react_native_svg_1.Pattern>
      </react_native_svg_1.Defs>
      <react_native_svg_1.Rect x="0" y="0" width="160" height="200" fill="url(#wave)"/>
      {/* concentric guilloche rings */}
      {[34, 28, 22, 16].map(function (r) { return (<react_native_svg_1.Circle key={r} cx="80" cy="70" r={r} stroke={tokens_1.color.deep} strokeWidth="0.5" fill="none" opacity="0.16"/>); })}
    </react_native_svg_1.default>);
}
/** ID-photo crop marks at the four corners of the photo frame. */
function CropMarks() {
    var mark = function (style) { return <react_native_1.View style={[styles.crop, style]}/>; };
    return (<>
      {mark(styles.cropTL)}{mark(styles.cropTR)}
      {mark(styles.cropBL)}{mark(styles.cropBR)}
    </>);
}
function PassportHero(_a) {
    var _b;
    var user = _a.user, trustScore = _a.trustScore, _c = _a.passId, passId = _c === void 0 ? 'TB-2026-0001' : _c;
    var interests = (_b = user.interests) !== null && _b !== void 0 ? _b : [];
    return (<react_native_1.View style={styles.card}>
      {/* document texture backdrop — behind everything in the hero */}
      <PassportMarks_1.PassportHeroBackdrop />
      {/* top-right entry ink stamp */}
      <react_native_1.View style={styles.inkStamp}><PassportMarks_1.PassportInkStamp rotate={-8}/></react_native_1.View>
      {/* top passport label row */}
      <react_native_1.View style={styles.topRow}>
        <react_native_1.View style={styles.brandRow}>
          <lucide_react_native_1.Plane size={18} color={tokens_1.color.ink}/>
          <react_native_1.View>
            <react_native_1.Text style={styles.brand}>TRAVEL BUDDY PASSPORT</react_native_1.Text>
            <react_native_1.Text style={styles.brandSub}>SOCIAL TRAVEL ID</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>
        <react_native_1.View style={styles.passIdWrap}>
          <react_native_1.Text style={styles.passId}>PASS ID: {passId}</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>
      <react_native_1.View style={styles.topDivider}/>

      {/* main identity area */}
      <react_native_1.View style={styles.identityRow}>
        {/* photo with document frame + backdrop + crop marks */}
        <react_native_1.View style={styles.photoBox}>
          {/* large subtle TB monogram behind the photo */}
          <PassportMarks_1.PassportMonogramWatermark size={150}/>
          <PhotoBackdrop />
          <react_native_1.View style={styles.photoFrame}>
            <react_native_1.Image source={{ uri: user.avatarUrl }} style={styles.photo}/>
            <CropMarks />
          </react_native_1.View>
          {/* ink stamp overlapping lower-left corner of the photo */}
          <react_native_1.View style={styles.overlapStamp} pointerEvents="none">
            <react_native_1.View style={styles.overlapRing}>
              <react_native_1.Text style={styles.overlapText}>VERIFIED</react_native_1.Text>
              <react_native_1.Text style={styles.overlapSub}>TRAVELER</react_native_1.Text>
            </react_native_1.View>
          </react_native_1.View>
        </react_native_1.View>

        {/* details */}
        <react_native_1.View style={styles.details}>
          <react_native_1.View style={styles.nameRow}>
            <react_native_1.Text style={styles.name}>{user.name}</react_native_1.Text>
            <react_native_1.View style={styles.trustChip}>
              <lucide_react_native_1.ShieldCheck size={13} color={tokens_1.color.signal}/>
              <react_native_1.Text style={styles.trustText}>Trust {trustScore}</react_native_1.Text>
            </react_native_1.View>
          </react_native_1.View>

          <react_native_1.View style={styles.metaRow}>
            <lucide_react_native_1.MapPin size={14} color={tokens_1.color.deep}/>
            <react_native_1.Text style={styles.location}>{user.homeCity}, {user.homeCountry}</react_native_1.Text>
          </react_native_1.View>

          <react_native_1.View style={styles.metaRow}>
            <lucide_react_native_1.User size={14} color={tokens_1.color.ink}/>
            <react_native_1.Text style={styles.status}>
              {user.travelStyle === 'solo' ? 'Solo Traveler' : user.travelStyle}
            </react_native_1.Text>
            {user.openToMeet && (<>
                <react_native_1.Text style={styles.dot}>·</react_native_1.Text>
                <react_native_1.View style={styles.liveDot}/>
                <react_native_1.Text style={styles.status}>Open to Meet</react_native_1.Text>
              </>)}
          </react_native_1.View>

          {/* PRESERVED buttons */}
          <react_native_1.View style={styles.buttons}>
            <react_native_1.Pressable style={styles.primaryBtn} onPress={function () { }}>
              <lucide_react_native_1.UsersRound size={16} color={tokens_1.color.onInk}/>
              <react_native_1.Text style={styles.primaryText}>Open to Meet</react_native_1.Text>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={styles.editBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/discovery'); }}>
              <lucide_react_native_1.Pencil size={15} color={tokens_1.color.ink}/>
              <react_native_1.Text style={styles.editText}>Edit</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>
        </react_native_1.View>
      </react_native_1.View>

      {/* bio */}
      {user.bio ? (<react_native_1.Text style={styles.bio}>“{user.bio}”</react_native_1.Text>) : (<react_native_1.Text style={styles.bioEmpty}>Add a short travel bio.</react_native_1.Text>)}

      {/* interests */}
      <react_native_1.View style={styles.interestsHead}>
        <react_native_1.Text style={styles.interestsLabel}>INTERESTS</react_native_1.Text>
        <lucide_react_native_1.Plane size={11} color={tokens_1.color.signal}/>
      </react_native_1.View>
      {interests.length ? (<react_native_1.View style={styles.interests}>
          {interests.slice(0, 8).map(function (i) { var _a; return <ui_1.Chip key={i} label={(_a = INTEREST_LABEL[i]) !== null && _a !== void 0 ? _a : i}/>; })}
        </react_native_1.View>) : (<react_native_1.Text style={styles.bioEmpty}>Add interests so travelers know your vibe.</react_native_1.Text>)}

      {/* MRZ microtext divider */}
      <react_native_1.View style={styles.mrzRow}>
        <react_native_1.Text style={styles.mrzChevron}>‹‹‹‹‹</react_native_1.Text>
        <react_native_1.Text style={styles.mrz}>TRAVEL BUDDY · VERIFIED TRAVEL ID · SOCIAL PASSPORT</react_native_1.Text>
        <react_native_1.Text style={styles.mrzChevron}>›››››</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    card: __assign({ margin: tokens_1.space.lg, borderRadius: tokens_1.radius.lg, backgroundColor: '#FBFAF6', borderWidth: 1.5, borderColor: tokens_1.color.haze, padding: tokens_1.space.lg, overflow: 'hidden' }, tokens_1.shadow.card),
    inkStamp: { position: 'absolute', top: 56, right: 14, zIndex: 1 },
    overlapStamp: { position: 'absolute', bottom: 2, left: -2, zIndex: 3 },
    overlapRing: {
        width: 52, height: 52, borderRadius: 26, borderWidth: 1.5, borderColor: tokens_1.color.signal,
        alignItems: 'center', justifyContent: 'center', opacity: 0.5,
        transform: [{ rotate: '-12deg' }], backgroundColor: 'rgba(250,249,246,0.4)',
    },
    overlapText: { fontFamily: 'Courier', fontSize: 8, fontWeight: '700', color: tokens_1.color.signal, letterSpacing: 0.5 },
    overlapSub: { fontFamily: 'Courier', fontSize: 6.5, fontWeight: '700', color: tokens_1.color.signal, letterSpacing: 1 },
    topRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
    brandRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    brand: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, letterSpacing: 0.5, fontSize: 14 }),
    brandSub: { fontFamily: 'Courier', fontSize: 9, color: tokens_1.color.deep, letterSpacing: 1.5, marginTop: 1 },
    passIdWrap: {},
    passId: { fontFamily: 'Courier', fontSize: 10, color: tokens_1.color.deep, fontWeight: '700', letterSpacing: 0.5 },
    topDivider: { height: 1, backgroundColor: tokens_1.color.haze, marginVertical: tokens_1.space.md },
    identityRow: { flexDirection: 'row', gap: tokens_1.space.lg },
    photoBox: { width: 120, height: 150, alignItems: 'center', justifyContent: 'center' },
    photoFrame: __assign({ width: 104, height: 132, borderRadius: 6, borderWidth: 2, borderColor: tokens_1.color.paper, backgroundColor: tokens_1.color.haze, overflow: 'hidden' }, tokens_1.shadow.card),
    photo: { width: '100%', height: '100%' },
    crop: { position: 'absolute', width: 14, height: 14, borderColor: tokens_1.color.deep },
    cropTL: { top: 4, left: 4, borderTopWidth: 2, borderLeftWidth: 2 },
    cropTR: { top: 4, right: 4, borderTopWidth: 2, borderRightWidth: 2 },
    cropBL: { bottom: 4, left: 4, borderBottomWidth: 2, borderLeftWidth: 2 },
    cropBR: { bottom: 4, right: 4, borderBottomWidth: 2, borderRightWidth: 2 },
    details: { flex: 1, gap: tokens_1.space.sm },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, flexWrap: 'wrap' },
    name: __assign(__assign({}, tokens_1.type.hero), { color: tokens_1.color.ink, fontSize: 30 }),
    trustChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1.5, borderColor: tokens_1.color.signal, borderRadius: tokens_1.radius.pill, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3 },
    trustText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.signal }),
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    location: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    status: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    dot: { color: tokens_1.color.faint, marginHorizontal: 2 },
    liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens_1.color.success },
    buttons: { flexDirection: 'row', gap: tokens_1.space.sm, marginTop: tokens_1.space.xs },
    primaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.md },
    primaryText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
    editBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.md, backgroundColor: tokens_1.color.paper },
    editText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    bio: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontStyle: 'italic', marginTop: tokens_1.space.lg }),
    bioEmpty: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.faint, marginTop: tokens_1.space.sm }),
    interestsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: tokens_1.space.lg },
    interestsLabel: { fontFamily: 'Courier', fontSize: 11, color: tokens_1.color.deep, letterSpacing: 2, fontWeight: '700' },
    interests: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm, marginTop: tokens_1.space.md, justifyContent: 'center' },
    mrzRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm, marginTop: tokens_1.space.lg, paddingTop: tokens_1.space.md, borderTopWidth: 1, borderTopColor: tokens_1.color.haze },
    mrz: { fontFamily: 'Courier', fontSize: 9, color: tokens_1.color.deep, letterSpacing: 1, fontWeight: '700' },
    mrzChevron: { fontFamily: 'Courier', fontSize: 9, color: tokens_1.color.faint },
});
