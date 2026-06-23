"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlaceCardSkeleton = PlaceCardSkeleton;
exports.PlaceSkeletonList = PlaceSkeletonList;
var react_1 = require("react");
var react_native_1 = require("react-native");
var tokens_1 = require("../../theme/tokens");
function SkeletonBox(_a) {
    var width = _a.width, height = _a.height, style = _a.style;
    var opacity = (0, react_1.useRef)(new react_native_1.Animated.Value(0.4)).current;
    (0, react_1.useEffect)(function () {
        var anim = react_native_1.Animated.loop(react_native_1.Animated.sequence([
            react_native_1.Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
            react_native_1.Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: true }),
        ]));
        anim.start();
        return function () { return anim.stop(); };
    }, [opacity]);
    return (<react_native_1.Animated.View style={[
            { width: width, height: height, borderRadius: 6, backgroundColor: tokens_1.color.haze, opacity: opacity },
            style,
        ]}/>);
}
function PlaceCardSkeleton() {
    return (<react_native_1.View style={styles.card}>
      <react_native_1.View style={styles.strip}/>
      <react_native_1.View style={styles.body}>
        <SkeletonBox width="70%" height={14}/>
        <react_native_1.View style={styles.metaRow}>
          <SkeletonBox width={60} height={18} style={{ borderRadius: tokens_1.radius.pill }}/>
          <SkeletonBox width={50} height={10}/>
        </react_native_1.View>
        <SkeletonBox width="90%" height={11}/>
        <SkeletonBox width="60%" height={11}/>
        <react_native_1.View style={styles.tagRow}>
          <SkeletonBox width={44} height={16} style={{ borderRadius: tokens_1.radius.pill }}/>
          <SkeletonBox width={56} height={16} style={{ borderRadius: tokens_1.radius.pill }}/>
        </react_native_1.View>
      </react_native_1.View>
      <react_native_1.View style={styles.addArea}>
        <SkeletonBox width={20} height={20} style={{ borderRadius: 10 }}/>
      </react_native_1.View>
    </react_native_1.View>);
}
function PlaceSkeletonList(_a) {
    var _b = _a.count, count = _b === void 0 ? 6 : _b;
    return (<react_native_1.View style={{ paddingTop: tokens_1.space.sm }}>
      {Array.from({ length: count }).map(function (_, i) { return (<PlaceCardSkeleton key={i}/>); })}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    card: {
        flexDirection: 'row',
        alignItems: 'stretch',
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        marginHorizontal: tokens_1.space.lg,
        marginBottom: tokens_1.space.md,
        overflow: 'hidden',
    },
    strip: {
        width: 4,
        backgroundColor: tokens_1.color.haze,
    },
    body: {
        flex: 1,
        paddingVertical: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.md,
        gap: tokens_1.space.sm,
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
    },
    tagRow: {
        flexDirection: 'row',
        gap: tokens_1.space.xs,
        marginTop: 2,
    },
    addArea: {
        width: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderLeftWidth: 1,
        borderLeftColor: tokens_1.color.haze,
    },
});
