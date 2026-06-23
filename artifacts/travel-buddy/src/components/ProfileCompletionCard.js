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
exports.ProfileCompletionCard = ProfileCompletionCard;
var react_1 = require("react");
var react_native_1 = require("react-native");
var async_storage_1 = require("@react-native-async-storage/async-storage");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var DISMISSED_KEY = '@passport_completion_dismissed';
function checks(profile) {
    var _a;
    return [
        { label: 'Add profile photo', done: Boolean(profile.avatarUrl) },
        { label: 'Choose username', done: Boolean(profile.username) },
        { label: 'Add bio', done: Boolean((_a = profile.bio) === null || _a === void 0 ? void 0 : _a.trim()) },
        { label: 'Add home base', done: Boolean(profile.homeCity) },
    ];
}
function ProfileCompletionCard(_a) {
    var _this = this;
    var profile = _a.profile, onOpenSettings = _a.onOpenSettings;
    var _b = (0, react_1.useState)(true), dismissed = _b[0], setDismissed = _b[1]; // hidden until async check
    (0, react_1.useEffect)(function () {
        async_storage_1.default.getItem(DISMISSED_KEY).then(function (val) {
            if (!val)
                setDismissed(false);
        });
    }, []);
    var items = checks(profile);
    var done = items.filter(function (i) { return i.done; }).length;
    var total = items.length;
    var dismiss = function () { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setDismissed(true);
                    return [4 /*yield*/, async_storage_1.default.setItem(DISMISSED_KEY, '1')];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); };
    if (dismissed || done === total)
        return null;
    return (<react_native_1.View style={cc.card}>
      <react_native_1.View style={cc.top}>
        <react_native_1.View style={{ flex: 1 }}>
          <react_native_1.Text style={cc.title}>Complete your Passport</react_native_1.Text>
          <react_native_1.Text style={cc.sub}>{done}/{total} done</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.Pressable onPress={dismiss} hitSlop={8}><lucide_react_native_1.X size={16} color={tokens_1.color.mute}/></react_native_1.Pressable>
      </react_native_1.View>
      <react_native_1.View style={cc.track}>
        <react_native_1.View style={[cc.fill, { width: "".concat((done / total) * 100, "%") }]}/>
      </react_native_1.View>
      <react_native_1.View style={cc.items}>
        {items.filter(function (i) { return !i.done; }).slice(0, 2).map(function (item) { return (<react_native_1.Text key={item.label} style={cc.item}>· {item.label}</react_native_1.Text>); })}
      </react_native_1.View>
      <react_native_1.Pressable style={cc.btn} onPress={onOpenSettings}>
        <react_native_1.Text style={cc.btnText}>Finish setup</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
var cc = react_native_1.StyleSheet.create({
    card: {
        marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg,
        borderWidth: 1, borderColor: tokens_1.color.haze,
        padding: tokens_1.space.md, gap: tokens_1.space.sm,
    },
    top: { flexDirection: 'row', alignItems: 'flex-start' },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    track: { height: 4, backgroundColor: tokens_1.color.haze, borderRadius: 2, overflow: 'hidden' },
    fill: { height: 4, backgroundColor: tokens_1.color.signal, borderRadius: 2 },
    items: { gap: 2 },
    item: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    btn: {
        alignSelf: 'flex-start', backgroundColor: tokens_1.color.ink,
        borderRadius: tokens_1.radius.pill, paddingHorizontal: tokens_1.space.md, paddingVertical: 6,
    },
    btnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
});
