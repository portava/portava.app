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
exports.LocationStatusPill = LocationStatusPill;
/**
 * LocationStatusPill — compact pill showing the active city.
 *
 * Tapping opens the ManualCityPicker (or requests GPS if no city yet).
 * Used in Pulse header and wherever the current city context is shown.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var LocationContext_1 = require("../context/LocationContext");
function LocationStatusPill(_a) {
    var _b = _a.fallbackLabel, fallbackLabel = _b === void 0 ? 'Choose city' : _b, _c = _a.compact, compact = _c === void 0 ? false : _c;
    var _d = (0, LocationContext_1.useLocationContext)(), locationState = _d.locationState, isLoading = _d.isLoading, openCityPicker = _d.openCityPicker, requireLocation = _d.requireLocation;
    var city = locationState.place.city;
    var label = city !== null && city !== void 0 ? city : fallbackLabel;
    var hasCity = !!city;
    function handlePress() {
        if (!hasCity) {
            requireLocation('pulse');
        }
        else {
            openCityPicker();
        }
    }
    return (<react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [s.pill, compact && s.compact, pressed && s.pressed];
    }} onPress={handlePress} hitSlop={8}>
      {isLoading ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>) : (<lucide_react_native_1.MapPin size={compact ? 11 : 13} color={hasCity ? tokens_1.color.signal : tokens_1.color.mute}/>)}
      <react_native_1.Text style={[s.label, compact && s.labelCompact, !hasCity && s.labelFaint]} numberOfLines={1}>
        {label}
      </react_native_1.Text>
      <lucide_react_native_1.ChevronDown size={compact ? 11 : 13} color={tokens_1.color.mute}/>
    </react_native_1.Pressable>);
}
var s = react_native_1.StyleSheet.create({
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.pill,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: 6,
        maxWidth: 160,
    },
    compact: {
        paddingHorizontal: tokens_1.space.sm,
        paddingVertical: 4,
    },
    pressed: {
        opacity: 0.75,
    },
    label: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '600', flex: 1 }),
    labelCompact: {
        fontSize: 12,
    },
    labelFaint: {
        color: tokens_1.color.mute,
        fontWeight: '400',
    },
});
