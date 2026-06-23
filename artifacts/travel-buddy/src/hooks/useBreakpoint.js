"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useBreakpoint = useBreakpoint;
exports.useIsDesktop = useIsDesktop;
var react_native_1 = require("react-native");
function useBreakpoint() {
    var width = (0, react_native_1.useWindowDimensions)().width;
    if (width >= 1024)
        return 'desktop';
    if (width >= 768)
        return 'tablet';
    return 'mobile';
}
function useIsDesktop() {
    var bp = useBreakpoint();
    return bp === 'desktop' || bp === 'tablet';
}
