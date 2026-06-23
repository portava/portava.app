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
exports.default = Settings;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var SessionContext_1 = require("../src/context/SessionContext");
var tokens_1 = require("../src/theme/tokens");
var GROUPS = [
    { h: 'Privacy', items: ['Hide current location', 'Hide upcoming trips', 'Private account', 'Nearby visibility', 'Message permissions'] },
    { h: 'Safety', items: ['Blocked accounts', 'Report history', 'Muted words'] },
    { h: 'Account', items: ['Edit profile', 'Notifications', 'Log out'] },
];
function Settings() {
    var _a = (0, SessionContext_1.useSession)(), signOut = _a.signOut, isAuthed = _a.isAuthed, configured = _a.configured;
    function onItem(label) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!(label === 'Log out')) return [3 /*break*/, 2];
                        return [4 /*yield*/, signOut()];
                    case 1:
                        _a.sent();
                        expo_router_1.router.replace('/(auth)/sign-in');
                        return [2 /*return*/];
                    case 2: return [2 /*return*/];
                }
            });
        });
    }
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Settings" back/>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.xl, paddingBottom: tokens_1.space.xxxl }}>
        {GROUPS.map(function (g) { return (<react_native_1.View key={g.h} style={{ gap: tokens_1.space.sm }}>
            <react_native_1.Text style={styles.h}>{g.h}</react_native_1.Text>
            {g.items.map(function (i) {
                var isLogout = i === 'Log out';
                if (isLogout && !(configured && isAuthed))
                    return null;
                return (<react_native_1.Pressable key={i} style={function (_a) {
                    var pressed = _a.pressed;
                    return [styles.row, pressed && { opacity: tokens_1.layout.pressedOpacity }];
                }} onPress={function () { return onItem(i); }}>
                  <react_native_1.Text style={[styles.item, isLogout && styles.logout]}>{i}</react_native_1.Text>
                </react_native_1.Pressable>);
            })}
          </react_native_1.View>); })}
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    h: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute }),
    row: { backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: tokens_1.space.lg },
    item: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    logout: { color: tokens_1.color.signal, fontWeight: '700' },
});
