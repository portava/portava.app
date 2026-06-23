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
exports.ActionBar = ActionBar;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
function compact(n) {
    if (n >= 1000)
        return "".concat((n / 1000).toFixed(n >= 10000 ? 0 : 1), "k");
    return "".concat(n);
}
function ActionBar(_a) {
    var liked = _a.liked, saved = _a.saved, likeCount = _a.likeCount, commentCount = _a.commentCount, saveCount = _a.saveCount, onLike = _a.onLike, onComment = _a.onComment, onSave = _a.onSave, onShare = _a.onShare, _b = _a.tint, tint = _b === void 0 ? tokens_1.color.ink : _b;
    return (<react_native_1.View style={styles.row}>
      <Action icon={<lucide_react_native_1.Heart size={20} color={liked ? tokens_1.color.signal : tint} fill={liked ? tokens_1.color.signal : 'transparent'}/>} label={compact(likeCount)} onPress={onLike} tint={tint}/>
      <Action icon={<lucide_react_native_1.MessageCircle size={20} color={tint}/>} label={compact(commentCount)} onPress={onComment} tint={tint}/>
      <Action icon={<lucide_react_native_1.Bookmark size={20} color={tint} fill={saved ? tint : 'transparent'}/>} label={compact(saveCount)} onPress={onSave} tint={tint}/>
      <react_native_1.View style={{ flex: 1 }}/>
      <react_native_1.Pressable onPress={onShare} hitSlop={8} accessibilityRole="button">
        <lucide_react_native_1.Share2 size={20} color={tint}/>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
function Action(_a) {
    var icon = _a.icon, label = _a.label, onPress = _a.onPress, tint = _a.tint;
    return (<react_native_1.Pressable onPress={onPress} style={styles.action} hitSlop={8} accessibilityRole="button">
      {icon}
      <react_native_1.Text style={[styles.count, { color: tint }]}>{label}</react_native_1.Text>
    </react_native_1.Pressable>);
}
var styles = react_native_1.StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.xl },
    action: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    count: __assign(__assign({}, tokens_1.type.small), { fontWeight: '600' }),
});
