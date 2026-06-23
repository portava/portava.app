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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Create;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ui_1 = require("../src/components/ui");
var tokens_1 = require("../src/theme/tokens");
var usePosts_1 = require("../src/hooks/usePosts");
var CATS = ['hotel', 'food', 'nightlife', 'beach', 'activity', 'transport', 'airport', 'visa', 'safety', 'tip', 'question'];
// UI visibility labels -> backend visibility. There is no "friends" visibility
// in the posts model yet (public/trip_only/private); a standalone post can't be
// trip_only, so "Friends" maps to private for now. (Future: circle/followers.)
var VIS_OPTIONS = [
    { label: 'Public', value: 'public' },
    { label: 'Private', value: 'private' },
];
function Create() {
    var _a = (0, react_1.useState)('beach'), cat = _a[0], setCat = _a[1];
    var _b = (0, react_1.useState)('public'), vis = _b[0], setVis = _b[1];
    var _c = (0, react_1.useState)(''), caption = _c[0], setCaption = _c[1];
    var _d = (0, react_1.useState)(null), error = _d[0], setError = _d[1];
    var _e = (0, usePosts_1.usePostActions)(), create = _e.create, submitting = _e.submitting;
    var canShare = caption.trim().length > 0 && !submitting;
    function onShare() {
        return __awaiter(this, void 0, void 0, function () {
            var content, res, messages;
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        if (!canShare)
                            return [2 /*return*/];
                        setError(null);
                        content = "[".concat(cat, "] ").concat(caption.trim());
                        return [4 /*yield*/, create({ content: content, visibility: vis })];
                    case 1:
                        res = _d.sent();
                        if (res.ok) {
                            expo_router_1.router.back();
                            return [2 /*return*/];
                        }
                        messages = {
                            unauthenticated: 'Please sign in to post.',
                            network_unreachable: 'Network unavailable. Check your connection and try again.',
                            invalid_payload: 'Please add some text before sharing.',
                            config_error: 'Posting is not available right now.',
                            forbidden: "You can't post here.",
                            not_member: 'You need to be a member to post here.',
                        };
                        setError((_c = (_b = messages[(_a = res.errorKind) !== null && _a !== void 0 ? _a : '']) !== null && _b !== void 0 ? _b : res.message) !== null && _c !== void 0 ? _c : 'Could not share your post.');
                        return [2 /*return*/];
                }
            });
        });
    }
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <react_native_1.View style={styles.head}>
        <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}><lucide_react_native_1.X size={24} color={tokens_1.color.ink}/></react_native_1.Pressable>
        <react_native_1.Text style={styles.title}>New post</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable style={[styles.post, !canShare && styles.postDisabled]} onPress={onShare} disabled={!canShare}>
          {submitting
            ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>
            : <react_native_1.Text style={styles.postText}>Share</react_native_1.Text>}
        </react_native_1.Pressable>
      </react_native_1.View>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.lg }}>
        {error ? (<react_native_1.View style={styles.errorBox}><react_native_1.Text style={styles.errorText}>{error}</react_native_1.Text></react_native_1.View>) : null}
        <react_native_1.Pressable style={styles.media}><lucide_react_native_1.Image size={28} color={tokens_1.color.mute}/><react_native_1.Text style={styles.mediaText}>Add photo or video</react_native_1.Text></react_native_1.Pressable>
        <react_native_1.TextInput style={styles.caption} placeholder="Share a tip, review, question, or moment…" placeholderTextColor={tokens_1.color.faint} multiline value={caption} onChangeText={setCaption} editable={!submitting}/>
        <react_native_1.View>
          <react_native_1.Text style={styles.label}>Category</react_native_1.Text>
          <react_native_1.View style={styles.wrap}>{CATS.map(function (c) { return <ui_1.Chip key={c} label={c} active={c === cat} onPress={function () { return setCat(c); }}/>; })}</react_native_1.View>
        </react_native_1.View>
        <react_native_1.View>
          <react_native_1.Text style={styles.label}>Destination</react_native_1.Text>
          <react_native_1.View style={styles.wrap}><ui_1.Stamp label="Cebu, Philippines" tone="deep"/></react_native_1.View>
        </react_native_1.View>
        <react_native_1.View>
          <react_native_1.Text style={styles.label}>Visibility</react_native_1.Text>
          <react_native_1.View style={styles.wrap}>{VIS_OPTIONS.map(function (v) { return <ui_1.Chip key={v.value} label={v.label} active={v.value === vis} onPress={function () { return setVis(v.value); }}/>; })}</react_native_1.View>
        </react_native_1.View>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, padding: tokens_1.space.lg, paddingTop: tokens_1.space.xxl, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    post: { backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, minWidth: 64, alignItems: 'center' },
    postDisabled: { opacity: 0.5 },
    postText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.onInk }),
    media: { height: 180, borderRadius: tokens_1.radius.lg, borderWidth: 1.5, borderStyle: 'dashed', borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm, backgroundColor: tokens_1.color.paperRaised },
    mediaText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    caption: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, minHeight: 90, textAlignVertical: 'top' }),
    label: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, marginBottom: tokens_1.space.sm }),
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
    errorBox: { backgroundColor: '#FDECEC', borderRadius: tokens_1.radius.md, padding: tokens_1.space.md, borderWidth: 1, borderColor: '#F5B5B5' },
    errorText: __assign(__assign({}, tokens_1.type.small), { color: '#B23B3B', fontWeight: '600' }),
});
