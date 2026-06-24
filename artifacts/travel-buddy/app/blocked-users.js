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
exports.default = BlockedUsersScreen;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var tokens_1 = require("../src/theme/tokens");
var blocks_1 = require("../src/services/blocks");
function BlockedUsersScreen() {
    var _this = this;
    var _a = (0, react_1.useState)([]), users = _a[0], setUsers = _a[1];
    var _b = (0, react_1.useState)(true), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)(null), unblocking = _c[0], setUnblocking = _c[1];
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setLoading(true);
                    return [4 /*yield*/, (0, blocks_1.getBlockList)()];
                case 1:
                    res = _a.sent();
                    if (res.ok && res.data)
                        setUsers(res.data);
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () { load(); }, [load]));
    function confirmUnblock(user) {
        var _this = this;
        var _a, _b;
        react_native_1.Alert.alert('Unblock user', "Unblock ".concat((_b = (_a = user.name) !== null && _a !== void 0 ? _a : user.handle) !== null && _b !== void 0 ? _b : 'this user', "? They will be able to follow you and send messages again."), [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Unblock',
                onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                    var res;
                    var _a;
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                setUnblocking(user.id);
                                return [4 /*yield*/, (0, blocks_1.unblockUser)(user.id)];
                            case 1:
                                res = _b.sent();
                                setUnblocking(null);
                                if (res.ok) {
                                    setUsers(function (prev) { return prev.filter(function (u) { return u.id !== user.id; }); });
                                }
                                else {
                                    react_native_1.Alert.alert('Error', (_a = res.error) !== null && _a !== void 0 ? _a : 'Could not unblock user');
                                }
                                return [2 /*return*/];
                        }
                    });
                }); },
            },
        ]);
    }
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Blocked accounts" back/>
      {loading ? (<react_native_1.View style={s.center}>
          <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
        </react_native_1.View>) : users.length === 0 ? (<react_native_1.View style={s.center}>
          <lucide_react_native_1.ShieldOff size={32} color={tokens_1.color.haze}/>
          <react_native_1.Text style={s.empty}>No blocked accounts</react_native_1.Text>
          <react_native_1.Text style={s.emptySub}>Users you block will appear here.</react_native_1.Text>
        </react_native_1.View>) : (<react_native_1.FlatList data={users} keyExtractor={function (u) { return u.id; }} contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.sm }} renderItem={function (_a) {
                var _b, _c, _d, _e, _f, _g;
                var item = _a.item;
                return (<react_native_1.View style={s.row}>
              {item.avatarUrl ? (<react_native_1.Image source={{ uri: item.avatarUrl }} style={s.avatar}/>) : (<react_native_1.View style={[s.avatar, s.avatarPlaceholder]}>
                  <react_native_1.Text style={s.avatarInitial}>
                    {((_e = (_c = (_b = item.name) === null || _b === void 0 ? void 0 : _b[0]) !== null && _c !== void 0 ? _c : (_d = item.handle) === null || _d === void 0 ? void 0 : _d[0]) !== null && _e !== void 0 ? _e : '?').toUpperCase()}
                  </react_native_1.Text>
                </react_native_1.View>)}
              <react_native_1.View style={{ flex: 1 }}>
                <react_native_1.Text style={s.name} numberOfLines={1}>
                  {(_g = (_f = item.name) !== null && _f !== void 0 ? _f : item.handle) !== null && _g !== void 0 ? _g : 'Unknown'}
                </react_native_1.Text>
                {item.handle ? (<react_native_1.Text style={s.handle} numberOfLines={1}>@{item.handle}</react_native_1.Text>) : null}
              </react_native_1.View>
              <react_native_1.Pressable style={[s.unblockBtn, unblocking === item.id && s.unblockBtnDisabled]} onPress={function () { return confirmUnblock(item); }} disabled={unblocking === item.id}>
                {unblocking === item.id ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>) : (<react_native_1.Text style={s.unblockText}>Unblock</react_native_1.Text>)}
              </react_native_1.Pressable>
            </react_native_1.View>);
            }}/>)}
    </react_native_1.View>);
}
var s = react_native_1.StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm },
    empty: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, fontWeight: '600' }),
    emptySub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint }),
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.md,
        padding: tokens_1.space.md,
    },
    avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: tokens_1.color.haze, flexShrink: 0 },
    avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised },
    avatarInitial: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, fontWeight: '700' }),
    name: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    handle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    unblockBtn: {
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: 6,
        borderRadius: tokens_1.radius.pill,
        borderWidth: 1,
        borderColor: tokens_1.color.signal,
        minWidth: 72,
        alignItems: 'center',
    },
    unblockBtnDisabled: { opacity: 0.5 },
    unblockText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 12 }),
});
