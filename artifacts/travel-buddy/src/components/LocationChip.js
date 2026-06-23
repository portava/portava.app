"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocationChip = LocationChip;
/**
 * LocationChip — reusable location label component.
 *
 * Variants:
 *   current_city      — "Cebu City"
 *   neighborhood      — "Lahug, Cebu City"
 *   near_me           — "Near me"
 *   trip_city         — "Going to Tokyo"
 *   approx_distance   — "~3 km"
 *   location_hidden   — "Location hidden"
 *   exact_private     — "Exact location private"
 *   no_location       — (renders nothing)
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
function LocationChip(_a) {
    var variant = _a.variant, label = _a.label, sublabel = _a.sublabel, _b = _a.size, size = _b === void 0 ? 'sm' : _b, _c = _a.muted, muted = _c === void 0 ? false : _c;
    if (variant === 'no_location')
        return null;
    var isSm = size === 'sm';
    var iconSize = isSm ? 11 : 13;
    var fontSize = isSm ? 11 : 12;
    var _d = resolveAppearance(variant, label, sublabel, muted), Icon = _d.Icon, text = _d.text, iconColor = _d.iconColor, textColor = _d.textColor;
    return (<react_native_1.View style={[styles.chip, isSm ? styles.chipSm : styles.chipMd]}>
      <Icon size={iconSize} color={iconColor}/>
      <react_native_1.Text style={[styles.label, { fontSize: fontSize, color: textColor }]} numberOfLines={1}>
        {text}
      </react_native_1.Text>
    </react_native_1.View>);
}
// ── Appearance resolver ───────────────────────────────────────────────────────
function resolveAppearance(variant, label, sublabel, muted) {
    var _a;
    var muteColor = muted ? tokens_1.color.faint : tokens_1.color.mute;
    switch (variant) {
        case 'current_city':
            return {
                Icon: lucide_react_native_1.MapPin,
                text: label !== null && label !== void 0 ? label : 'Unknown city',
                iconColor: muted ? tokens_1.color.faint : tokens_1.color.signal,
                textColor: muted ? tokens_1.color.faint : tokens_1.color.mute,
            };
        case 'neighborhood':
            return {
                Icon: lucide_react_native_1.MapPin,
                text: sublabel && label ? "".concat(sublabel, ", ").concat(label) : ((_a = label !== null && label !== void 0 ? label : sublabel) !== null && _a !== void 0 ? _a : 'Neighborhood'),
                iconColor: muted ? tokens_1.color.faint : tokens_1.color.deep,
                textColor: muted ? tokens_1.color.faint : tokens_1.color.mute,
            };
        case 'near_me':
            return {
                Icon: lucide_react_native_1.Navigation,
                text: 'Near me',
                iconColor: muted ? tokens_1.color.faint : tokens_1.color.signal,
                textColor: muted ? tokens_1.color.faint : tokens_1.color.mute,
            };
        case 'trip_city':
            return {
                Icon: lucide_react_native_1.MapPin,
                text: label ? "Going to ".concat(label) : 'Trip destination',
                iconColor: muted ? tokens_1.color.faint : tokens_1.color.deep,
                textColor: muted ? tokens_1.color.faint : tokens_1.color.mute,
            };
        case 'approx_distance':
            return {
                Icon: lucide_react_native_1.Navigation,
                text: label !== null && label !== void 0 ? label : 'Nearby',
                iconColor: muteColor,
                textColor: muteColor,
            };
        case 'location_hidden':
            return {
                Icon: lucide_react_native_1.EyeOff,
                text: 'Location hidden',
                iconColor: tokens_1.color.faint,
                textColor: tokens_1.color.faint,
            };
        case 'exact_private':
            return {
                Icon: lucide_react_native_1.Lock,
                text: 'Exact location private',
                iconColor: tokens_1.color.faint,
                textColor: tokens_1.color.faint,
            };
        default:
            return {
                Icon: lucide_react_native_1.MapPin,
                text: label !== null && label !== void 0 ? label : '',
                iconColor: muteColor,
                textColor: muteColor,
            };
    }
}
// ── Styles ────────────────────────────────────────────────────────────────────
var styles = react_native_1.StyleSheet.create({
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
    },
    chipSm: {
        paddingVertical: 0,
    },
    chipMd: {
        paddingVertical: 2,
    },
    label: {
        fontFamily: 'Courier',
        letterSpacing: 0.2,
        flexShrink: 1,
    },
});
