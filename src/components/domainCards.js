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
exports.PostcardTile = exports.PassportHeroBackdrop = exports.PassportInkStamp = exports.PassportStampCard = exports.TrustChip = exports.AvailabilityStatusCard = void 0;
exports.CompassCard = CompassCard;
exports.ImageDiscoveryCard = ImageDiscoveryCard;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var primitives_1 = require("./primitives");
/**
 * Domain cards used across Discovery / Pulse / Trip. Thin, token-driven.
 *
 * - CompassCard        : AI suggestion card. Honesty-first — takes an explicit
 *                        `reason` and optional `provisional` flag; never implies
 *                        verified ranking.
 * - ImageDiscoveryCard : image-led place/experience card with Save + Add to Plan.
 */
function CompassCard(_a) {
    var title = _a.title, subtitle = _a.subtitle, reason = _a.reason, provisional = _a.provisional, onDetails = _a.onDetails, onAdd = _a.onAdd;
    return (<react_native_1.View style={cc.card}>
      <react_native_1.View style={cc.media}>
        <react_native_1.View style={cc.label}><lucide_react_native_1.Sparkles size={12} color={tokens_1.color.onInk}/><react_native_1.Text style={cc.labelText}>COMPASS PICK</react_native_1.Text></react_native_1.View>
      </react_native_1.View>
      <react_native_1.View style={cc.body}>
        <react_native_1.Text style={cc.title}>{title}</react_native_1.Text>
        {subtitle ? <react_native_1.Text style={cc.sub}>{subtitle}</react_native_1.Text> : null}
        {reason ? (<react_native_1.View style={cc.reasonRow}><lucide_react_native_1.Info size={13} color={tokens_1.color.deep}/><react_native_1.Text style={cc.reason}>{reason}</react_native_1.Text></react_native_1.View>) : null}
        {provisional ? <react_native_1.Text style={cc.prov}>Based on starter city notes — provisional</react_native_1.Text> : null}
        <react_native_1.View style={cc.btns}>
          {onDetails ? <primitives_1.TravelButton label="View Details" variant="ghost" onPress={onDetails} full/> : null}
          {onAdd ? <primitives_1.TravelButton label="Add to Plan" variant="primary" icon={<lucide_react_native_1.Plus size={15} color={tokens_1.color.onInk}/>} onPress={onAdd} full/> : null}
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.View>);
}
function ImageDiscoveryCard(_a) {
    var name = _a.name, blurb = _a.blurb, neighborhood = _a.neighborhood, _b = _a.width, width = _b === void 0 ? 160 : _b, onAdd = _a.onAdd, onSave = _a.onSave;
    return (<react_native_1.View style={[idc.card, { width: width }]}>
      <react_native_1.View style={idc.media}>
        <react_native_1.View style={idc.sparkle}><lucide_react_native_1.Sparkles size={14} color={tokens_1.color.onInk}/></react_native_1.View>
      </react_native_1.View>
      <react_native_1.View style={idc.body}>
        <react_native_1.Text style={idc.title} numberOfLines={1}>{name}</react_native_1.Text>
        {blurb ? <react_native_1.Text style={idc.sub} numberOfLines={1}>{blurb}</react_native_1.Text> : null}
        {neighborhood ? (<react_native_1.View style={idc.locRow}><lucide_react_native_1.MapPin size={11} color={tokens_1.color.mute}/><react_native_1.Text style={idc.loc} numberOfLines={1}>{neighborhood}</react_native_1.Text></react_native_1.View>) : null}
        <react_native_1.View style={idc.btnRow}>
          <react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [idc.addBtn, pressed && { opacity: tokens_1.layout.pressedOpacity }];
    }} onPress={onAdd}>
            <react_native_1.Text style={idc.addText}>Add to Plan</react_native_1.Text>
          </react_native_1.Pressable>
          <react_native_1.Pressable onPress={onSave} hitSlop={tokens_1.layout.hitSlop}><lucide_react_native_1.Bookmark size={16} color={tokens_1.color.mute}/></react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.View>);
}
var cc = react_native_1.StyleSheet.create({
    card: __assign({ borderRadius: tokens_1.radius.lg, overflow: 'hidden', backgroundColor: tokens_1.color.ink }, tokens_1.shadow.card),
    media: { height: 90, backgroundColor: tokens_1.color.deep, padding: tokens_1.space.md },
    label: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.sm },
    labelText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.onInk, fontFamily: 'Courier' }),
    body: { padding: tokens_1.space.md, gap: 5 },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.onInk, fontSize: 19 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.haze }),
    reasonRow: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.12)', alignSelf: 'flex-start', paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.sm },
    reason: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontSize: 11 }),
    prov: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInkMute, fontSize: 10, fontStyle: 'italic' }),
    btns: { flexDirection: 'row', gap: tokens_1.space.sm, marginTop: tokens_1.space.sm },
});
var idc = react_native_1.StyleSheet.create({
    card: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, overflow: 'hidden' }, tokens_1.shadow.card),
    media: { height: 110, backgroundColor: tokens_1.color.deep, padding: tokens_1.space.sm },
    sparkle: { width: 26, height: 26, borderRadius: 13, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
    body: { padding: tokens_1.space.md, gap: 3 },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    locRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
    loc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    btnRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginTop: tokens_1.space.sm },
    addBtn: { flex: 1, borderWidth: 1.5, borderColor: tokens_1.color.signal, borderRadius: tokens_1.radius.sm, paddingVertical: 6, alignItems: 'center' },
    addText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.signal, fontSize: 12 }),
});
/* Re-exports so all spec-named primitives resolve from one import site. */
var AvailabilityCard_1 = require("./AvailabilityCard");
Object.defineProperty(exports, "AvailabilityStatusCard", { enumerable: true, get: function () { return AvailabilityCard_1.AvailabilityCard; } });
var PassportSections_1 = require("./PassportSections");
Object.defineProperty(exports, "TrustChip", { enumerable: true, get: function () { return PassportSections_1.TrustChip; } });
var PassportStampCard_1 = require("./PassportStampCard");
Object.defineProperty(exports, "PassportStampCard", { enumerable: true, get: function () { return PassportStampCard_1.PassportStampCard; } });
var PassportMarks_1 = require("./PassportMarks");
Object.defineProperty(exports, "PassportInkStamp", { enumerable: true, get: function () { return PassportMarks_1.PassportInkStamp; } });
Object.defineProperty(exports, "PassportHeroBackdrop", { enumerable: true, get: function () { return PassportMarks_1.PassportHeroBackdrop; } });
var PostcardTile_1 = require("./PostcardTile");
Object.defineProperty(exports, "PostcardTile", { enumerable: true, get: function () { return PostcardTile_1.PostcardTile; } });
