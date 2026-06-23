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
exports.PlaceCard = PlaceCard;
exports.categoryColor = categoryColor;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var discoveryBookmarks_1 = require("../../services/discoveryBookmarks");
var PlanPickerController_1 = require("../PlanPickerController");
var tokens_1 = require("../../theme/tokens");
function PlaceCard(_a) {
    var place = _a.place, onPress = _a.onPress, onAddToPlan = _a.onAddToPlan;
    var _b = (0, react_1.useState)(false), saved = _b[0], setSaved = _b[1];
    var accent = categoryColor(place.category);
    var isAdded = (0, PlanPickerController_1.usePlanPicker)().isAdded;
    var alreadyAdded = isAdded(place.id);
    (0, react_1.useEffect)(function () {
        (0, discoveryBookmarks_1.isSaved)(place.id).then(setSaved).catch(function () { });
    }, [place.id]);
    var openDirections = function () {
        if (place.lat != null && place.lng != null) {
            var url = "https://www.openstreetmap.org/?mlat=".concat(place.lat, "&mlon=").concat(place.lng, "&zoom=17");
            react_native_1.Linking.openURL(url).catch(function () { });
        }
        else if (place.name) {
            var query = encodeURIComponent(place.name);
            react_native_1.Linking.openURL("https://www.google.com/maps/search/?api=1&query=".concat(query)).catch(function () { });
        }
    };
    return (<react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [styles.card, pressed && { opacity: tokens_1.layout.pressedOpacity }];
    }} onPress={onPress}>
      {/* Left accent strip */}
      <react_native_1.View style={[styles.strip, { backgroundColor: accent }]}/>

      <react_native_1.View style={styles.body}>
        {/* Top row: name + chevron */}
        <react_native_1.View style={styles.titleRow}>
          <react_native_1.Text style={styles.name} numberOfLines={1}>{place.name}</react_native_1.Text>
          <lucide_react_native_1.ChevronRight size={16} color={tokens_1.color.faint}/>
        </react_native_1.View>

        {/* Type + distance */}
        <react_native_1.View style={styles.metaRow}>
          {place.type ? (<react_native_1.View style={[styles.typePill, { backgroundColor: accent + '22' }]}>
              <react_native_1.Text style={[styles.typeText, { color: accent }]} numberOfLines={1}>
                {capitalize(place.type)}
              </react_native_1.Text>
            </react_native_1.View>) : null}
          {place.distanceKm != null && (<react_native_1.View style={styles.distRow}>
              <lucide_react_native_1.MapPin size={11} color={tokens_1.color.faint}/>
              <react_native_1.Text style={styles.dist}>
                {place.distanceKm < 1
                ? "".concat(Math.round(place.distanceKm * 1000), "m")
                : "".concat(place.distanceKm, "km")}
              </react_native_1.Text>
            </react_native_1.View>)}
          {place.openingHours ? (<react_native_1.Text style={styles.hours} numberOfLines={1}>{formatHoursShort(place.openingHours)}</react_native_1.Text>) : null}
        </react_native_1.View>

        {/* Description */}
        {place.description ? (<react_native_1.Text style={styles.desc} numberOfLines={2}>{place.description}</react_native_1.Text>) : null}

        {/* Address */}
        {place.address && !place.description ? (<react_native_1.Text style={styles.address} numberOfLines={1}>{place.address}</react_native_1.Text>) : null}

        {/* Tags */}
        {place.tags.length > 0 && (<react_native_1.View style={styles.tagRow}>
            {place.tags.map(function (tag) { return (<react_native_1.View key={tag} style={styles.tag}>
                <react_native_1.Text style={styles.tagText}>{tag}</react_native_1.Text>
              </react_native_1.View>); })}
          </react_native_1.View>)}

        {/* Action row */}
        <react_native_1.View style={styles.actionRow}>
          <react_native_1.Pressable style={function (_a) {
            var pressed = _a.pressed;
            return [
                styles.actionBtn,
                alreadyAdded && styles.actionBtnAdded,
                !alreadyAdded && pressed && { opacity: 0.7 },
            ];
        }} onPress={alreadyAdded ? undefined : onAddToPlan} disabled={alreadyAdded} hitSlop={6}>
            {alreadyAdded
            ? <lucide_react_native_1.Check size={14} color={tokens_1.color.deep}/>
            : <lucide_react_native_1.Plus size={14} color={tokens_1.color.signal}/>}
            <react_native_1.Text style={[styles.actionText, { color: alreadyAdded ? tokens_1.color.deep : tokens_1.color.signal }]}>
              {alreadyAdded ? 'Added ✓' : 'Plan'}
            </react_native_1.Text>
          </react_native_1.Pressable>

          {(place.lat != null || place.name) && (<react_native_1.Pressable style={function (_a) {
            var pressed = _a.pressed;
            return [styles.actionBtn, pressed && { opacity: 0.7 }];
        }} onPress={openDirections} hitSlop={6}>
              <lucide_react_native_1.Navigation size={14} color={tokens_1.color.deep}/>
              <react_native_1.Text style={[styles.actionText, { color: tokens_1.color.deep }]}>Directions</react_native_1.Text>
            </react_native_1.Pressable>)}

          <react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [styles.saveBtn, saved && styles.saveBtnActive, pressed && { opacity: 0.7 }];
    }} onPress={function () {
            var bookmark = { id: place.id, name: place.name, category: place.category, type: place.type, address: place.address, savedAt: Date.now() };
            (0, discoveryBookmarks_1.toggleSave)(bookmark).then(setSaved).catch(function () { return setSaved(function (s) { return !s; }); });
        }} hitSlop={6}>
            <lucide_react_native_1.Bookmark size={14} color={saved ? tokens_1.color.signal : tokens_1.color.faint} fill={saved ? tokens_1.color.signal : 'none'}/>
          </react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.Pressable>);
}
function formatHoursShort(hours) {
    if (!hours)
        return '';
    // Show first token (e.g. "Mo-Fr 09:00-18:00" → "Mo-Fr 09:00-18:00")
    // Common abbreviation: just show first 24 chars
    return hours.length > 24 ? hours.slice(0, 24) + '…' : hours;
}
function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
function categoryColor(cat) {
    switch (cat) {
        case 'places': return '#0A6EBD';
        case 'food': return '#D4722A';
        case 'nightlife': return '#7C3AED';
        case 'activities': return '#2E7D5B';
        case 'events': return '#B45309';
        case 'beaches': return '#0891B2';
        case 'transport': return '#475569';
        case 'for_you':
        default: return tokens_1.color.signal;
    }
}
var styles = react_native_1.StyleSheet.create({
    card: __assign({ flexDirection: 'row', alignItems: 'stretch', backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, marginHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.md, overflow: 'hidden' }, tokens_1.shadow.card),
    strip: {
        width: 4,
        borderTopLeftRadius: tokens_1.radius.md,
        borderBottomLeftRadius: tokens_1.radius.md,
    },
    body: {
        flex: 1,
        paddingVertical: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.md,
        gap: tokens_1.space.xs,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.xs,
    },
    name: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, flex: 1, fontSize: 14 }),
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
        flexWrap: 'wrap',
    },
    typePill: {
        paddingHorizontal: tokens_1.space.sm,
        paddingVertical: 2,
        borderRadius: tokens_1.radius.pill,
    },
    typeText: __assign(__assign({}, tokens_1.type.stamp), { fontSize: 10, textTransform: 'capitalize' }),
    distRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
    },
    dist: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint, fontSize: 10 }),
    hours: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.mute, fontSize: 10 }),
    desc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, lineHeight: 17 }),
    address: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11 }),
    tagRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: tokens_1.space.xs,
        marginTop: 2,
    },
    tag: {
        backgroundColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.pill,
        paddingHorizontal: tokens_1.space.sm,
        paddingVertical: 2,
    },
    tagText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.mute, fontSize: 10, textTransform: 'capitalize' }),
    actionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        marginTop: tokens_1.space.xs,
    },
    actionBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: tokens_1.space.sm,
        paddingVertical: 4,
        borderRadius: tokens_1.radius.sm,
        backgroundColor: tokens_1.color.haze,
    },
    actionBtnAdded: {
        opacity: 0.65,
    },
    actionText: __assign(__assign({}, tokens_1.type.stamp), { fontSize: 11, fontWeight: '600' }),
    saveBtn: {
        marginLeft: 'auto',
        width: 28,
        height: 28,
        borderRadius: 14,
        backgroundColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
    },
    saveBtnActive: {
        backgroundColor: tokens_1.color.signal + '18',
    },
});
exports.default = PlaceCard;
