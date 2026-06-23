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
exports.TelegraphRecommendationCard = TelegraphRecommendationCard;
/**
 * TelegraphRecommendationCard — AI activity recommendation rendered inside
 * a Telegraph thread as an ai_activity_recommendation message.
 *
 * Shows: title, category badge, reason, location context, estimated time,
 * price level, and two action buttons (Add to Trip / Dismiss).
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var CATEGORY_COLOR = {
    food: '#C8851A',
    nightlife: '#7A4DBF',
    beach: '#0A7DBF',
    activity: '#2E7D5B',
    hotel: '#C0392B',
    transport: '#888',
    tip: '#555',
    default: '#333',
};
var PRICE_LABEL = {
    free: 'Free',
    '$': '$',
    '$$': '$$',
    '$$$': '$$$',
    '$$$$': '$$$$',
};
function TelegraphRecommendationCard(_a) {
    var _b, _c;
    var rec = _a.rec, onAddToTrip = _a.onAddToTrip, onDismiss = _a.onDismiss, onSave = _a.onSave, onShare = _a.onShare, onNotInterested = _a.onNotInterested;
    var accent = (_b = CATEGORY_COLOR[rec.category]) !== null && _b !== void 0 ? _b : CATEGORY_COLOR.default;
    return (<react_native_1.View style={[styles.card, { borderLeftColor: accent }]}>
      {/* Header row */}
      <react_native_1.View style={styles.header}>
        <react_native_1.View style={styles.headerLeft}>
          <react_native_1.View style={[styles.zapRow]}>
            <lucide_react_native_1.Zap size={11} color={tokens_1.color.signal}/>
            <react_native_1.Text style={styles.telegraphLabel}>TELEGRAPH</react_native_1.Text>
          </react_native_1.View>
          <react_native_1.Text style={styles.title} numberOfLines={2}>{rec.title}</react_native_1.Text>
        </react_native_1.View>
        {onDismiss && (<react_native_1.Pressable style={styles.dismissBtn} onPress={function () { return onDismiss(rec.id); }} hitSlop={8}>
            <lucide_react_native_1.X size={14} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>)}
      </react_native_1.View>

      {/* Category badge */}
      <react_native_1.View style={[styles.badge, { backgroundColor: accent + '22' }]}>
        <react_native_1.Text style={[styles.badgeText, { color: accent }]}>{rec.category.toUpperCase()}</react_native_1.Text>
      </react_native_1.View>

      {/* Reason */}
      <react_native_1.Text style={styles.reason}>{rec.reason}</react_native_1.Text>

      {/* Meta row */}
      <react_native_1.View style={styles.meta}>
        {rec.locationContext ? (<react_native_1.View style={styles.metaItem}>
            <lucide_react_native_1.MapPin size={11} color={tokens_1.color.mute}/>
            <react_native_1.Text style={styles.metaText} numberOfLines={1}>{rec.locationContext}</react_native_1.Text>
          </react_native_1.View>) : null}
        {rec.estimatedTime ? (<react_native_1.View style={styles.metaItem}>
            <lucide_react_native_1.Clock size={11} color={tokens_1.color.mute}/>
            <react_native_1.Text style={styles.metaText}>{rec.estimatedTime}</react_native_1.Text>
          </react_native_1.View>) : null}
        {rec.priceLevel ? (<react_native_1.View style={styles.metaItem}>
            <lucide_react_native_1.DollarSign size={11} color={tokens_1.color.mute}/>
            <react_native_1.Text style={styles.metaText}>{(_c = PRICE_LABEL[rec.priceLevel]) !== null && _c !== void 0 ? _c : rec.priceLevel}</react_native_1.Text>
          </react_native_1.View>) : null}
      </react_native_1.View>

      {/* Actions */}
      {(onAddToTrip || onSave || onShare || onNotInterested) && (<react_native_1.View style={styles.actions}>
          {onAddToTrip && (<react_native_1.Pressable style={styles.addBtn} onPress={function () { return onAddToTrip(rec); }}>
              <lucide_react_native_1.CalendarPlus size={13} color={tokens_1.color.onInk}/>
              <react_native_1.Text style={styles.addBtnText}>Add to Trip</react_native_1.Text>
            </react_native_1.Pressable>)}
          {onSave && (<react_native_1.Pressable style={styles.iconBtn} onPress={function () { return onSave(rec); }} hitSlop={8}>
              <lucide_react_native_1.Bookmark size={15} color={tokens_1.color.signal}/>
            </react_native_1.Pressable>)}
          {onShare && (<react_native_1.Pressable style={styles.iconBtn} onPress={function () { return onShare(rec); }} hitSlop={8}>
              <lucide_react_native_1.Share2 size={15} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>)}
          {onNotInterested && (<react_native_1.Pressable style={styles.iconBtn} onPress={function () { return onNotInterested(rec); }} hitSlop={8}>
              <lucide_react_native_1.ThumbsDown size={15} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>)}
        </react_native_1.View>)}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    card: {
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.lg,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderLeftWidth: 3,
        padding: tokens_1.space.lg,
        gap: tokens_1.space.sm,
        maxWidth: '90%',
        alignSelf: 'flex-start',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: tokens_1.space.sm,
    },
    headerLeft: { flex: 1, gap: 3 },
    zapRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
    },
    telegraphLabel: {
        fontSize: 9,
        fontFamily: 'Courier',
        fontWeight: '700',
        color: tokens_1.color.signal,
        letterSpacing: 1,
    },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, lineHeight: 20 }),
    dismissBtn: {
        padding: 2,
        marginTop: 2,
    },
    badge: {
        alignSelf: 'flex-start',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: tokens_1.radius.pill,
    },
    badgeText: {
        fontSize: 10,
        fontFamily: 'Courier',
        fontWeight: '700',
        letterSpacing: 0.5,
    },
    reason: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, lineHeight: 18 }),
    meta: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: tokens_1.space.md,
        marginTop: 2,
    },
    metaItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    metaText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    actions: {
        marginTop: tokens_1.space.sm,
        flexDirection: 'row',
        gap: tokens_1.space.sm,
    },
    addBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.xs,
        backgroundColor: tokens_1.color.signal,
        borderRadius: tokens_1.radius.pill,
        paddingVertical: 7,
        paddingHorizontal: tokens_1.space.md,
    },
    addBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700', fontSize: 12 }),
    iconBtn: {
        width: 30,
        height: 30,
        borderRadius: tokens_1.radius.pill,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
