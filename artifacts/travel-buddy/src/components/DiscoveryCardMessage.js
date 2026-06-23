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
exports.DiscoveryCardMessage = DiscoveryCardMessage;
/**
 * DiscoveryCardMessage — renders a discovery_card system message as a rich inline card.
 *
 * Parses the JSON body (set by DiscoveryShareSheet when sending) and shows:
 * - Category badge + city
 * - Title
 * - Blurb snippet
 * - Action row: View / Add to Plan / Save
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
function parsePayload(body) {
    try {
        var parsed = JSON.parse(body);
        if (typeof parsed.title !== 'string' || typeof parsed.category !== 'string')
            return null;
        return parsed;
    }
    catch (_a) {
        return null;
    }
}
var CATEGORY_COLORS = {
    hidden_gem: '#10B981',
    food: '#F97316',
    nightlife: '#8B5CF6',
    beach: '#0EA5E9',
    attraction: '#10B981',
    activity: '#6366F1',
    'for_you': tokens_1.color.signal,
    place: '#6B7280',
};
function DiscoveryCardMessage(_a) {
    var _b;
    var body = _a.body, mine = _a.mine;
    var payload = parsePayload(body);
    if (!payload) {
        return (<react_native_1.View style={[card.wrap, mine && card.wrapMine]}>
        <react_native_1.Text style={[card.fallback, mine && { color: tokens_1.color.onInk + 'AA' }]}>Discovery card</react_native_1.Text>
      </react_native_1.View>);
    }
    var accentColor = (_b = CATEGORY_COLORS[payload.category.toLowerCase()]) !== null && _b !== void 0 ? _b : CATEGORY_COLORS.place;
    return (<react_native_1.View style={[card.wrap, mine && card.wrapMine]}>
      {/* Header */}
      <react_native_1.View style={card.header}>
        <react_native_1.View style={card.compassBadge}>
          <lucide_react_native_1.Compass size={11} color={tokens_1.color.onInk}/>
        </react_native_1.View>
        <react_native_1.Text style={[card.brandLabel, mine && { color: tokens_1.color.onInk + 'BB' }]}>DISCOVERY</react_native_1.Text>
        <react_native_1.View style={[card.chip, { backgroundColor: accentColor + '22' }]}>
          <react_native_1.Text style={[card.chipText, { color: accentColor }]}>
            {payload.category}
          </react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>

      {/* Thumbnail */}
      {payload.imageUrl ? (<react_native_1.Image source={{ uri: payload.imageUrl }} style={card.thumbnail} resizeMode="cover"/>) : null}

      {/* Title */}
      <react_native_1.Text style={[card.title, mine && card.titleMine]} numberOfLines={2}>
        {payload.title}
      </react_native_1.Text>

      {/* Location */}
      <react_native_1.View style={card.locRow}>
        <lucide_react_native_1.MapPin size={11} color={mine ? tokens_1.color.onInk + 'AA' : tokens_1.color.mute}/>
        <react_native_1.Text style={[card.loc, mine && card.locMine]} numberOfLines={1}>{payload.city}</react_native_1.Text>
        {payload.priceLevel ? (<react_native_1.Text style={[card.price, mine && card.priceMine]}> · {payload.priceLevel}</react_native_1.Text>) : null}
      </react_native_1.View>

      {/* Blurb */}
      {payload.blurb ? (<react_native_1.Text style={[card.blurb, mine && card.blurbMine]} numberOfLines={2}>
          {payload.blurb}
        </react_native_1.Text>) : null}

      {/* Caption from sender */}
      {payload.caption ? (<react_native_1.Text style={[card.caption, mine && card.captionMine]} numberOfLines={2}>
          "{payload.caption}"
        </react_native_1.Text>) : null}

      {/* Action row */}
      <react_native_1.View style={card.actions}>
        <react_native_1.Pressable style={[card.actionBtn, mine && card.actionBtnMine]} onPress={function () { return react_native_1.Alert.alert('Discovery', "Open Discovery tab to find \"".concat(payload.title, "\" in ").concat(payload.city, ".")); }}>
          <lucide_react_native_1.ExternalLink size={11} color={mine ? tokens_1.color.onInk : tokens_1.color.signal}/>
          <react_native_1.Text style={[card.actionLabel, mine && card.actionLabelMine]}>View</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.View style={[card.divider, mine && card.dividerMine]}/>
        <react_native_1.Pressable style={[card.actionBtn, mine && card.actionBtnMine]} onPress={function () { return react_native_1.Alert.alert('Add to Plan', "Add \"".concat(payload.title, "\" to a trip plan?")); }}>
          <lucide_react_native_1.CalendarPlus size={11} color={mine ? tokens_1.color.onInk : tokens_1.color.signal}/>
          <react_native_1.Text style={[card.actionLabel, mine && card.actionLabelMine]}>Add to Plan</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.View style={[card.divider, mine && card.dividerMine]}/>
        <react_native_1.Pressable style={[card.actionBtn, mine && card.actionBtnMine]} onPress={function () { return react_native_1.Alert.alert('Saved', "\"".concat(payload.title, "\" saved to your Discovery.")); }}>
          <lucide_react_native_1.Bookmark size={11} color={mine ? tokens_1.color.onInk : tokens_1.color.signal}/>
          <react_native_1.Text style={[card.actionLabel, mine && card.actionLabelMine]}>Save</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
var card = react_native_1.StyleSheet.create({
    wrap: {
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.lg,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderBottomLeftRadius: 4,
        padding: tokens_1.space.md,
        gap: 6,
        maxWidth: 280,
    },
    wrapMine: {
        backgroundColor: tokens_1.color.signal,
        borderColor: tokens_1.color.signal,
        borderBottomLeftRadius: tokens_1.radius.lg,
        borderBottomRightRadius: 4,
    },
    fallback: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontStyle: 'italic' }),
    thumbnail: {
        width: '100%',
        height: 110,
        borderRadius: tokens_1.radius.sm,
        backgroundColor: tokens_1.color.haze,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    compassBadge: { width: 18, height: 18, borderRadius: 5, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
    brandLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', fontSize: 9, color: tokens_1.color.signal, letterSpacing: 1, flex: 1 }),
    chip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
    chipText: { fontSize: 9, fontFamily: 'Courier', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 14, lineHeight: 18 }),
    titleMine: { color: tokens_1.color.onInk },
    locRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    loc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, flex: 1 }),
    locMine: { color: tokens_1.color.onInk + 'BB' },
    price: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    priceMine: { color: tokens_1.color.onInk + 'AA' },
    blurb: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, lineHeight: 16 }),
    blurbMine: { color: tokens_1.color.onInk + 'BB' },
    caption: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11, fontStyle: 'italic', lineHeight: 15 }),
    captionMine: { color: tokens_1.color.onInk + '99' },
    actions: { flexDirection: 'row', alignItems: 'center', borderTopWidth: react_native_1.StyleSheet.hairlineWidth, borderTopColor: tokens_1.color.haze, marginTop: 2, paddingTop: 6 },
    actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 4 },
    actionBtnMine: {},
    actionLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 10 }),
    actionLabelMine: { color: tokens_1.color.onInk },
    divider: { width: react_native_1.StyleSheet.hairlineWidth, height: 14, backgroundColor: tokens_1.color.haze },
    dividerMine: { backgroundColor: tokens_1.color.onInk + '33' },
});
