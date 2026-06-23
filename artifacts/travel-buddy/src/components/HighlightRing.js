"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HighlightRing = HighlightRing;
/**
 * HighlightRing — wraps any avatar/child with an animated gradient ring.
 *
 * Ring states:
 *   hasActive=true, allViewed=false → bright gradient ring (unviewed)
 *   hasActive=true, allViewed=true  → muted grey ring (all viewed)
 *   hasActive=false                 → no ring, transparent pass-through
 *
 * Props:
 *   hasActive   — the user has active (unexpired) highlights
 *   allViewed   — the viewer has seen all of them
 *   isOwner     — this is the viewer's own avatar (tap opens composer)
 *   size        — avatar diameter (ring is drawn outside it)
 *   onPress     — tap handler (viewer opens HighlightViewer; owner opens composer)
 *   ringWidth   — stroke width of the ring (default 2.5)
 *   gap         — gap between avatar and ring (default 2)
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_svg_1 = require("react-native-svg");
var GRADIENT_COLORS = ['#F5A623', '#E91E8C', '#9C27B0'];
var GRADIENT_VIEWED = ['#C0C0C0', '#A0A0A0'];
function HighlightRing(_a) {
    var hasActive = _a.hasActive, allViewed = _a.allViewed, size = _a.size, onPress = _a.onPress, _b = _a.ringWidth, ringWidth = _b === void 0 ? 2.5 : _b, _c = _a.gap, gap = _c === void 0 ? 2 : _c, children = _a.children;
    var pulseAnim = (0, react_1.useRef)(new react_native_1.Animated.Value(1)).current;
    (0, react_1.useEffect)(function () {
        if (!hasActive || allViewed) {
            pulseAnim.stopAnimation();
            pulseAnim.setValue(1);
            return;
        }
        var loop = react_native_1.Animated.loop(react_native_1.Animated.sequence([
            react_native_1.Animated.timing(pulseAnim, { toValue: 1.06, duration: 900, useNativeDriver: true }),
            react_native_1.Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
        ]));
        loop.start();
        return function () { return loop.stop(); };
    }, [hasActive, allViewed, pulseAnim]);
    if (!hasActive) {
        if (!onPress)
            return <>{children}</>;
        return (<react_native_1.Pressable onPress={onPress} style={{ width: size, height: size }}>
        {children}
      </react_native_1.Pressable>);
    }
    var totalSize = size + (ringWidth + gap) * 2;
    var r = totalSize / 2 - ringWidth / 2;
    var cx = totalSize / 2;
    var cy = totalSize / 2;
    var colors = allViewed ? GRADIENT_VIEWED : GRADIENT_COLORS;
    var gradId = "hlRingGrad_".concat(size, "_").concat(allViewed ? 'v' : 'u');
    return (<react_native_1.Pressable onPress={onPress} hitSlop={4}>
      <react_native_1.Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
        <react_native_1.View style={{ width: totalSize, height: totalSize, alignItems: 'center', justifyContent: 'center' }}>
          <react_native_svg_1.default width={totalSize} height={totalSize} style={react_native_1.StyleSheet.absoluteFill}>
            <react_native_svg_1.Defs>
              <react_native_svg_1.LinearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
                {colors.map(function (c, i) { return (<react_native_svg_1.Stop key={i} offset={"".concat((i / (colors.length - 1)) * 100, "%")} stopColor={c} stopOpacity="1"/>); })}
              </react_native_svg_1.LinearGradient>
            </react_native_svg_1.Defs>
            <react_native_svg_1.Circle cx={cx} cy={cy} r={r} stroke={"url(#".concat(gradId, ")")} strokeWidth={ringWidth} fill="none"/>
          </react_native_svg_1.default>
          <react_native_1.View style={{
            width: size + gap * 2,
            height: size + gap * 2,
            borderRadius: (size + gap * 2) / 2,
            overflow: 'hidden',
            backgroundColor: 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
        }}>
            {children}
          </react_native_1.View>
        </react_native_1.View>
      </react_native_1.Animated.View>
    </react_native_1.Pressable>);
}
