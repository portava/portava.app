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
exports.PlaceDetailSheet = PlaceDetailSheet;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var discoveryBookmarks_1 = require("../../services/discoveryBookmarks");
var tokens_1 = require("../../theme/tokens");
var PlaceCard_1 = require("./PlaceCard");
function PlaceDetailSheet(_a) {
    var place = _a.place, visible = _a.visible, onClose = _a.onClose, onAddToPlan = _a.onAddToPlan;
    var _b = (0, react_1.useState)(false), saved = _b[0], setSaved = _b[1];
    (0, react_1.useEffect)(function () {
        if (place)
            (0, discoveryBookmarks_1.isSaved)(place.id).then(setSaved).catch(function () { });
    }, [place === null || place === void 0 ? void 0 : place.id]);
    if (!place)
        return null;
    var accent = (0, PlaceCard_1.categoryColor)(place.category);
    var openWeb = function () {
        if (place.website)
            react_native_1.Linking.openURL(place.website).catch(function () { });
    };
    var openPhone = function () {
        if (place.phone)
            react_native_1.Linking.openURL("tel:".concat(place.phone)).catch(function () { });
    };
    var openMap = function () {
        if (place.lat != null && place.lng != null) {
            var url = "https://www.openstreetmap.org/?mlat=".concat(place.lat, "&mlon=").concat(place.lng, "&zoom=17");
            react_native_1.Linking.openURL(url).catch(function () { });
        }
        else {
            var q = encodeURIComponent(place.name + (place.address ? " ".concat(place.address) : ''));
            react_native_1.Linking.openURL("https://www.google.com/maps/search/?api=1&query=".concat(q)).catch(function () { });
        }
    };
    var openDirections = function () {
        if (place.lat != null && place.lng != null) {
            react_native_1.Linking.openURL("https://www.google.com/maps/dir/?api=1&destination=".concat(place.lat, ",").concat(place.lng)).catch(function () { });
        }
        else {
            var q = encodeURIComponent(place.name);
            react_native_1.Linking.openURL("https://www.google.com/maps/dir/?api=1&destination=".concat(q)).catch(function () { });
        }
    };
    return (<react_native_1.Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      <react_native_1.Pressable style={styles.backdrop} onPress={onClose}/>

      <react_native_1.View style={styles.sheet}>
        {/* Handle */}
        <react_native_1.View style={styles.handle}/>

        {/* Header */}
        <react_native_1.View style={styles.header}>
          <react_native_1.View style={[styles.accentDot, { backgroundColor: accent }]}/>
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={styles.name} numberOfLines={2}>{place.name}</react_native_1.Text>
            {place.type ? (<react_native_1.Text style={[styles.type, { color: accent }]}>{capitalize(place.type)}</react_native_1.Text>) : null}
          </react_native_1.View>
          <react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [styles.saveHeaderBtn, saved && styles.saveHeaderBtnActive, pressed && { opacity: 0.7 }];
    }} onPress={function () {
            if (!place)
                return;
            var bookmark = { id: place.id, name: place.name, category: place.category, type: place.type, address: place.address, savedAt: Date.now() };
            (0, discoveryBookmarks_1.toggleSave)(bookmark).then(setSaved).catch(function () { return setSaved(function (s) { return !s; }); });
        }} hitSlop={8}>
            <lucide_react_native_1.Bookmark size={18} color={saved ? tokens_1.color.signal : tokens_1.color.mute} fill={saved ? tokens_1.color.signal : 'none'}/>
          </react_native_1.Pressable>
          <react_native_1.Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
            <lucide_react_native_1.X size={20} color={tokens_1.color.ink}/>
          </react_native_1.Pressable>
        </react_native_1.View>

        <react_native_1.ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {/* Distance */}
          {place.distanceKm != null && (<react_native_1.View style={styles.infoRow}>
              <lucide_react_native_1.MapPin size={15} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.infoText}>
                {place.distanceKm < 1
                ? "".concat(Math.round(place.distanceKm * 1000), "m from city centre")
                : "".concat(place.distanceKm, "km from city centre")}
              </react_native_1.Text>
            </react_native_1.View>)}

          {/* Address */}
          {place.address && (<react_native_1.View style={styles.infoRow}>
              <lucide_react_native_1.MapPin size={15} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.infoText}>{place.address}</react_native_1.Text>
            </react_native_1.View>)}

          {/* Rating */}
          {place.rating != null && (<react_native_1.View style={styles.infoRow}>
              <lucide_react_native_1.Star size={15} color="#F59E0B" fill="#F59E0B"/>
              <react_native_1.Text style={[styles.infoText, { color: tokens_1.color.ink, fontWeight: '600' }]}>
                {place.rating.toFixed(1)}
                <react_native_1.Text style={[styles.infoText, { fontWeight: '400' }]}> · OSM community rating</react_native_1.Text>
              </react_native_1.Text>
            </react_native_1.View>)}

          {/* Opening hours */}
          {place.openingHours && (<react_native_1.View style={styles.infoRow}>
              <lucide_react_native_1.Clock size={15} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.infoText}>{place.openingHours}</react_native_1.Text>
            </react_native_1.View>)}

          {/* Map thumbnail area — tap to open */}
          {place.lat != null && place.lng != null && (<react_native_1.Pressable style={styles.mapThumb} onPress={openMap}>
              <lucide_react_native_1.Navigation size={18} color={tokens_1.color.deep}/>
              <react_native_1.View>
                <react_native_1.Text style={styles.mapThumbTitle}>View on map</react_native_1.Text>
                <react_native_1.Text style={styles.mapThumbSub}>
                  {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
                </react_native_1.Text>
              </react_native_1.View>
            </react_native_1.Pressable>)}

          {/* Description */}
          {place.description && (<react_native_1.View style={styles.section}>
              <react_native_1.Text style={styles.sectionLabel}>About</react_native_1.Text>
              <react_native_1.Text style={styles.desc}>{place.description}</react_native_1.Text>
            </react_native_1.View>)}

          {/* Tags */}
          {place.tags.length > 0 && (<react_native_1.View style={styles.section}>
              <react_native_1.View style={styles.infoRow}>
                <lucide_react_native_1.Tag size={14} color={tokens_1.color.mute}/>
                <react_native_1.Text style={styles.sectionLabel}>Tags</react_native_1.Text>
              </react_native_1.View>
              <react_native_1.View style={styles.tagRow}>
                {place.tags.map(function (tag) { return (<react_native_1.View key={tag} style={[styles.tag, { backgroundColor: accent + '18' }]}>
                    <react_native_1.Text style={[styles.tagText, { color: accent }]}>{capitalize(tag)}</react_native_1.Text>
                  </react_native_1.View>); })}
              </react_native_1.View>
            </react_native_1.View>)}

          {/* Links */}
          {(place.website || place.phone) && (<react_native_1.View style={styles.section}>
              <react_native_1.Text style={styles.sectionLabel}>Contact</react_native_1.Text>
              <react_native_1.View style={styles.linkRow}>
                {place.website && (<react_native_1.Pressable style={styles.linkBtn} onPress={openWeb}>
                    <lucide_react_native_1.Globe size={15} color={tokens_1.color.deep}/>
                    <react_native_1.Text style={styles.linkText} numberOfLines={1}>Website</react_native_1.Text>
                  </react_native_1.Pressable>)}
                {place.phone && (<react_native_1.Pressable style={styles.linkBtn} onPress={openPhone}>
                    <lucide_react_native_1.Phone size={15} color={tokens_1.color.deep}/>
                    <react_native_1.Text style={styles.linkText}>{place.phone}</react_native_1.Text>
                  </react_native_1.Pressable>)}
              </react_native_1.View>
            </react_native_1.View>)}

          {/* Attribution */}
          <react_native_1.Text style={styles.attribution}>
            Place data © OpenStreetMap contributors (ODbL)
          </react_native_1.Text>
        </react_native_1.ScrollView>

        {/* Footer actions */}
        <react_native_1.View style={styles.footer}>
          <react_native_1.Pressable style={styles.dirBtn} onPress={openDirections}>
            <lucide_react_native_1.Navigation size={18} color={tokens_1.color.deep}/>
            <react_native_1.Text style={styles.dirText}>Directions</react_native_1.Text>
          </react_native_1.Pressable>
          <react_native_1.Pressable style={styles.addBtn} onPress={function () { return onAddToPlan(place); }}>
            <lucide_react_native_1.Plus size={18} color={tokens_1.color.onInk}/>
            <react_native_1.Text style={styles.addText}>Add to Plan</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.Modal>);
}
function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
var styles = react_native_1.StyleSheet.create({
    backdrop: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(0,0,0,0.45)' }),
    sheet: __assign({ position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '82%', backgroundColor: tokens_1.color.paperRaised, borderTopLeftRadius: 24, borderTopRightRadius: 24 }, tokens_1.shadow.float),
    handle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: tokens_1.color.haze,
        alignSelf: 'center',
        marginTop: tokens_1.space.md,
        marginBottom: tokens_1.space.sm,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: tokens_1.space.md,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    accentDot: {
        width: 12,
        height: 12,
        borderRadius: 6,
        marginTop: 5,
    },
    name: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 17 }),
    type: __assign(__assign({}, tokens_1.type.stamp), { fontSize: 11, marginTop: 2, textTransform: 'capitalize' }),
    saveHeaderBtn: {
        width: 34,
        height: 34,
        borderRadius: 17,
        backgroundColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
    },
    saveHeaderBtnActive: {
        backgroundColor: tokens_1.color.signal + '18',
    },
    closeBtn: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        paddingHorizontal: tokens_1.space.lg,
        paddingTop: tokens_1.space.md,
        paddingBottom: tokens_1.space.xxl,
        gap: tokens_1.space.md,
    },
    infoRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
    },
    infoText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, flex: 1 }),
    mapThumb: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        backgroundColor: '#E2EDF0',
        borderRadius: tokens_1.radius.md,
        padding: tokens_1.space.md,
    },
    mapThumbTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.deep, fontSize: 13 }),
    mapThumbSub: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.mute, fontSize: 10, marginTop: 2 }),
    section: {
        gap: tokens_1.space.sm,
    },
    sectionLabel: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.8 }),
    desc: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontSize: 14, lineHeight: 21 }),
    tagRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: tokens_1.space.sm,
    },
    tag: {
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.xs,
        borderRadius: tokens_1.radius.pill,
    },
    tagText: __assign(__assign({}, tokens_1.type.stamp), { fontSize: 11, textTransform: 'capitalize' }),
    linkRow: {
        gap: tokens_1.space.sm,
    },
    linkBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
        paddingVertical: tokens_1.space.sm,
    },
    linkText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.deep, fontSize: 14, flex: 1 }),
    attribution: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 10, textAlign: 'center', marginTop: tokens_1.space.md }),
    footer: {
        flexDirection: 'row',
        gap: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
        borderTopWidth: 1,
        borderTopColor: tokens_1.color.haze,
    },
    dirBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens_1.space.sm,
        flex: 1,
        borderRadius: tokens_1.radius.md,
        paddingVertical: tokens_1.space.md + 2,
        borderWidth: 1.5,
        borderColor: tokens_1.color.deep,
    },
    dirText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.deep, fontWeight: '700' }),
    addBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens_1.space.sm,
        flex: 2,
        backgroundColor: tokens_1.color.signal,
        borderRadius: tokens_1.radius.md,
        paddingVertical: tokens_1.space.md + 2,
    },
    addText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontWeight: '700' }),
});
exports.default = PlaceDetailSheet;
