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
exports.useColors = useColors;
var react_native_1 = require("react-native");
var colors_1 = require("@/constants/colors");
/**
 * Returns the design tokens for the current color scheme.
 *
 * The returned object contains all color tokens for the active palette
 * plus scheme-independent values like `radius`.
 *
 * Falls back to the light palette when no dark key is defined in
 * constants/colors.ts (the scaffold ships light-only by default).
 * When a sibling web artifact's dark tokens are synced into a `dark`
 * key, this hook will automatically switch palettes based on the
 * device's appearance setting.
 */
function useColors() {
    var scheme = (0, react_native_1.useColorScheme)();
    var palette = scheme === "dark" && "dark" in colors_1.default
        ? colors_1.default.dark
        : colors_1.default.light;
    return __assign(__assign({}, palette), { radius: colors_1.default.radius });
}
