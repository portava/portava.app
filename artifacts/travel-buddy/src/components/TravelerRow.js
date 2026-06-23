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
exports.TravelerRow = TravelerRow;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var follows_1 = require("../services/follows");
var tokens_1 = require("../theme/tokens");
var HighlightRing_1 = require("./HighlightRing");
var HighlightViewer_1 = require("./HighlightViewer");
var useHighlightRingState_1 = require("../hooks/useHighlightRingState");
function TravelerRow(_a) {
    var _b, _c, _d, _e, _f;
    var user = _a.user, _g = _a.isOwnProfile, isOwnProfile = _g === void 0 ? false : _g;
    var _h = (0, react_1.useState)(user.isFollowing), isFollowing = _h[0], setIsFollowing = _h[1];
    var _j = (0, react_1.useState)(user.followerCount), followerCount = _j[0], setFollowerCount = _j[1];
    var _k = (0, react_1.useState)(false), toggling = _k[0], setToggling = _k[1];
    var _l = (0, react_1.useState)(false), viewerOpen = _l[0], setViewerOpen = _l[1];
    var ringState = (0, useHighlightRingState_1.useHighlightRingState)(user.id);
    function handleToggle() {
        return __awaiter(this, void 0, void 0, function () {
            var wasFollowing, res, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (toggling || user.isPrivate)
                            return [2 /*return*/];
                        wasFollowing = isFollowing;
                        setToggling(true);
                        setIsFollowing(!wasFollowing);
                        setFollowerCount(function (c) { return wasFollowing ? Math.max(0, c - 1) : c + 1; });
                        if (!wasFollowing) return [3 /*break*/, 2];
                        return [4 /*yield*/, (0, follows_1.unfollowUser)(user.id)];
                    case 1:
                        _a = _b.sent();
                        return [3 /*break*/, 4];
                    case 2: return [4 /*yield*/, (0, follows_1.followUser)(user.id)];
                    case 3:
                        _a = _b.sent();
                        _b.label = 4;
                    case 4:
                        res = _a;
                        if (!res.ok) {
                            setIsFollowing(wasFollowing);
                            setFollowerCount(function (c) { return wasFollowing ? c + 1 : Math.max(0, c - 1); });
                        }
                        setToggling(false);
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleRowPress() {
        if (user.username) {
            expo_router_1.router.push("/u/".concat(user.username));
        }
    }
    var displayName = (_c = (_b = user.displayName) !== null && _b !== void 0 ? _b : user.username) !== null && _c !== void 0 ? _c : 'Traveler';
    var handle = user.username ? "@".concat(user.username) : null;
    return (<>
    <react_native_1.Pressable style={styles.row} onPress={handleRowPress}>
      <HighlightRing_1.HighlightRing hasActive={(_d = ringState === null || ringState === void 0 ? void 0 : ringState.hasActive) !== null && _d !== void 0 ? _d : false} allViewed={(_e = ringState === null || ringState === void 0 ? void 0 : ringState.allViewed) !== null && _e !== void 0 ? _e : false} size={48} ringWidth={2} gap={2} onPress={(ringState === null || ringState === void 0 ? void 0 : ringState.hasActive) ? function () { return setViewerOpen(true); } : undefined}>
        {user.avatarUrl ? (<react_native_1.Image source={{ uri: user.avatarUrl }} style={styles.avatar}/>) : (<react_native_1.View style={[styles.avatar, styles.avatarEmpty]}>
            <react_native_1.Text style={{ fontSize: 22 }}>👤</react_native_1.Text>
          </react_native_1.View>)}
      </HighlightRing_1.HighlightRing>

      <react_native_1.View style={styles.info}>
        <react_native_1.Text style={styles.name} numberOfLines={1}>{displayName}</react_native_1.Text>
        {handle ? <react_native_1.Text style={styles.handle} numberOfLines={1}>{handle}</react_native_1.Text> : null}
        {user.isPrivate ? (<react_native_1.View style={styles.privateBadge}>
            <lucide_react_native_1.Lock size={10} color={tokens_1.color.mute}/>
            <react_native_1.Text style={styles.privateText}>Private</react_native_1.Text>
          </react_native_1.View>) : (<react_native_1.Text style={styles.followers}>
            {followerCount === 1 ? '1 follower' : "".concat(followerCount, " followers")}
          </react_native_1.Text>)}
      </react_native_1.View>

      {!isOwnProfile && !user.isPrivate && (<react_native_1.Pressable style={[styles.followBtn, isFollowing && styles.followingBtn]} onPress={handleToggle} disabled={toggling}>
          {toggling ? (<react_native_1.ActivityIndicator size="small" color={isFollowing ? tokens_1.color.mute : tokens_1.color.onInk}/>) : isFollowing ? (<>
              <lucide_react_native_1.UserCheck size={13} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.followingText}>Following</react_native_1.Text>
            </>) : (<>
              <lucide_react_native_1.UserPlus size={13} color={tokens_1.color.onInk}/>
              <react_native_1.Text style={styles.followText}>Follow</react_native_1.Text>
            </>)}
        </react_native_1.Pressable>)}
    </react_native_1.Pressable>
    <HighlightViewer_1.HighlightViewer visible={viewerOpen} highlights={(_f = ringState === null || ringState === void 0 ? void 0 : ringState.highlights) !== null && _f !== void 0 ? _f : []} onClose={function () { return setViewerOpen(false); }}/>
    </>);
}
var styles = react_native_1.StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        padding: tokens_1.space.md,
    },
    avatar: {
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: tokens_1.color.haze,
    },
    avatarEmpty: {
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#F0EDE8',
    },
    info: {
        flex: 1,
        gap: 2,
    },
    name: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    handle: {
        fontFamily: 'Courier',
        fontSize: 12,
        color: tokens_1.color.mute,
    },
    followers: {
        fontSize: 11,
        color: tokens_1.color.faint,
        marginTop: 1,
    },
    privateBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        marginTop: 2,
    },
    privateText: {
        fontSize: 11,
        color: tokens_1.color.mute,
        fontStyle: 'italic',
    },
    followBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: tokens_1.color.signal,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.sm - 1,
        borderRadius: tokens_1.radius.pill,
        minWidth: 84,
        justifyContent: 'center',
    },
    followingBtn: {
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
    },
    followText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontSize: 12 }),
    followingText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.mute, fontSize: 12 }),
});
