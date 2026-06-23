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
exports.AboutTab = AboutTab;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var INTEREST_LABEL = {
    nightlife: 'Nightlife', food: 'Food', beach: 'Beach', luxury: 'Luxury',
    culture: 'Culture', adventure: 'Adventure', wellness: 'Wellness',
    photography: 'Photography', backpacking: 'Backpacking', shopping: 'Shopping',
    business: 'Business', dating: 'Social', events: 'Events',
};
var TRAVEL_STYLE_LABEL = {
    solo: 'Solo Traveler', couple: 'Couple', group: 'Group Traveler', business: 'Business Traveler',
};
function AboutTab(_a) {
    var _b, _c;
    var profile = _a.profile, isOwner = _a.isOwner, onOpenSettings = _a.onOpenSettings;
    var interests = (_b = profile.interests) !== null && _b !== void 0 ? _b : [];
    var style = profile.travelStyle;
    var joined = profile.createdAt
        ? new Date(profile.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
        : null;
    var bio = profile.bio;
    var homeCity = profile.homeCity;
    var homeCountry = profile.homeCountry;
    var hasContent = bio || homeCity || style || interests.length > 0 || joined;
    if (!hasContent) {
        return (<react_native_1.View style={ab.empty}>
        <react_native_1.Text style={ab.emptyTitle}>Nothing here yet</react_native_1.Text>
        {isOwner && (<react_native_1.Pressable style={ab.editBtn} onPress={onOpenSettings}>
            <react_native_1.Text style={ab.editBtnText}>Add profile details</react_native_1.Text>
          </react_native_1.Pressable>)}
      </react_native_1.View>);
    }
    return (<react_native_1.View style={ab.wrap}>
      {bio ? (<react_native_1.View style={ab.section}>
          <react_native_1.Text style={ab.sectionLabel}>BIO</react_native_1.Text>
          <react_native_1.Text style={ab.bio}>{bio}</react_native_1.Text>
        </react_native_1.View>) : null}

      {(homeCity || homeCountry) ? (<react_native_1.View style={ab.section}>
          <react_native_1.Text style={ab.sectionLabel}>HOME BASE</react_native_1.Text>
          <react_native_1.View style={ab.row}>
            <lucide_react_native_1.MapPin size={14} color={tokens_1.color.deep}/>
            <react_native_1.Text style={ab.value}>{[homeCity, homeCountry].filter(Boolean).join(', ')}</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>) : null}

      {style ? (<react_native_1.View style={ab.section}>
          <react_native_1.Text style={ab.sectionLabel}>TRAVEL STYLE</react_native_1.Text>
          <react_native_1.View style={ab.row}>
            <lucide_react_native_1.User size={14} color={tokens_1.color.ink}/>
            <react_native_1.Text style={ab.value}>{(_c = TRAVEL_STYLE_LABEL[style]) !== null && _c !== void 0 ? _c : style}</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>) : null}

      {interests.length > 0 ? (<react_native_1.View style={ab.section}>
          <react_native_1.Text style={ab.sectionLabel}>INTERESTS</react_native_1.Text>
          <react_native_1.View style={ab.chips}>
            {interests.map(function (i) {
                var _a;
                return (<react_native_1.View key={i} style={ab.chip}>
                <react_native_1.Text style={ab.chipText}>{(_a = INTEREST_LABEL[i]) !== null && _a !== void 0 ? _a : i}</react_native_1.Text>
              </react_native_1.View>);
            })}
          </react_native_1.View>
        </react_native_1.View>) : null}

      {joined ? (<react_native_1.View style={ab.section}>
          <react_native_1.Text style={ab.sectionLabel}>MEMBER SINCE</react_native_1.Text>
          <react_native_1.View style={ab.row}>
            <lucide_react_native_1.Calendar size={14} color={tokens_1.color.faint}/>
            <react_native_1.Text style={ab.value}>{joined}</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>) : null}

      {isOwner && (<react_native_1.Pressable style={ab.editBtn} onPress={onOpenSettings}>
          <react_native_1.Text style={ab.editBtnText}>Edit in Passport Settings</react_native_1.Text>
        </react_native_1.Pressable>)}
    </react_native_1.View>);
}
var ab = react_native_1.StyleSheet.create({
    wrap: { paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.md, gap: tokens_1.space.lg },
    section: { gap: tokens_1.space.sm },
    sectionLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, color: tokens_1.color.mute },
    bio: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, lineHeight: 22 }),
    row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    value: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.pill,
        paddingHorizontal: 12, paddingVertical: 5,
        borderWidth: 1, borderColor: tokens_1.color.haze,
    },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '600' }),
    empty: { paddingTop: tokens_1.space.xxxl, alignItems: 'center', gap: tokens_1.space.md },
    emptyTitle: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    editBtn: {
        marginTop: tokens_1.space.md, borderWidth: 1, borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.pill, paddingHorizontal: tokens_1.space.xl, paddingVertical: tokens_1.space.md,
        alignSelf: 'center',
    },
    editBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
});
