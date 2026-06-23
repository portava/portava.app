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
exports.ShareSheet = ShareSheet;
/**
 * ShareSheet — share options for a post.
 *
 * Options:
 *   Share Post  → native OS share sheet (includes copy, messaging, etc.)
 *   Copy Link   → native OS share with URL pre-filled
 *
 * Uses React Native's built-in Share API — no extra packages needed.
 * Telegraph / Trip Chat share are planned TODOs.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
function postPermalink(postId) {
    return "https://travelbuddy.app/posts/".concat(postId);
}
function ShareSheet(_a) {
    var _this = this;
    var visible = _a.visible, postId = _a.postId, onClose = _a.onClose, onShareSuccess = _a.onShareSuccess;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var handleNativeShare = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var result, _1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    onClose();
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, react_native_1.Share.share(__assign({ message: "Check out this post on Travel Buddy!\n".concat(postPermalink(postId)) }, (react_native_1.Platform.OS === 'ios' ? { url: postPermalink(postId) } : {})))];
                case 2:
                    result = _a.sent();
                    if (result.action === react_native_1.Share.sharedAction) {
                        onShareSuccess === null || onShareSuccess === void 0 ? void 0 : onShareSuccess();
                    }
                    return [3 /*break*/, 4];
                case 3:
                    _1 = _a.sent();
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    }); }, [postId, onClose, onShareSuccess]);
    var handleCopyLink = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var _2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    onClose();
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, react_native_1.Share.share(__assign({ message: postPermalink(postId) }, (react_native_1.Platform.OS === 'ios' ? { url: postPermalink(postId) } : {})))];
                case 2:
                    _a.sent();
                    onShareSuccess === null || onShareSuccess === void 0 ? void 0 : onShareSuccess();
                    return [3 /*break*/, 4];
                case 3:
                    _2 = _a.sent();
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    }); }, [postId, onClose, onShareSuccess]);
    return (<react_native_1.Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
      <react_native_1.Pressable style={s.backdrop} onPress={onClose}/>
      <react_native_1.View style={[s.sheet, { paddingBottom: insets.bottom + tokens_1.space.md }]}>
        <react_native_1.View style={s.header}>
          <react_native_1.Text style={s.title}>Share Post</react_native_1.Text>
          <react_native_1.Pressable onPress={onClose} hitSlop={10}>
            <lucide_react_native_1.X size={20} color={tokens_1.color.ink}/>
          </react_native_1.Pressable>
        </react_native_1.View>

        <react_native_1.Pressable style={s.option} onPress={handleNativeShare}>
          <react_native_1.View style={[s.iconWrap, { backgroundColor: '#EEF1FF' }]}>
            <lucide_react_native_1.Share2 size={20} color="#4A6CF7"/>
          </react_native_1.View>
          <react_native_1.View style={s.optionText}>
            <react_native_1.Text style={s.optionLabel}>Share Post</react_native_1.Text>
            <react_native_1.Text style={s.optionSub}>Open share menu</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.Pressable>

        <react_native_1.Pressable style={s.option} onPress={handleCopyLink}>
          <react_native_1.View style={[s.iconWrap, { backgroundColor: '#EDF7EE' }]}>
            <lucide_react_native_1.Link size={20} color={tokens_1.color.success}/>
          </react_native_1.View>
          <react_native_1.View style={s.optionText}>
            <react_native_1.Text style={s.optionLabel}>Copy Link</react_native_1.Text>
            <react_native_1.Text style={s.optionSub}>Share the post URL</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.Pressable>

        <react_native_1.Pressable style={s.cancel} onPress={onClose}>
          <react_native_1.Text style={s.cancelText}>Cancel</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.Modal>);
}
var s = react_native_1.StyleSheet.create({
    backdrop: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(17,17,15,0.45)' }),
    sheet: __assign({ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: tokens_1.color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: tokens_1.space.md, gap: tokens_1.space.xs }, tokens_1.shadow.card),
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: tokens_1.space.md,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    title: {
        fontSize: 16,
        fontWeight: '700',
        color: tokens_1.color.ink,
    },
    option: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
    },
    iconWrap: {
        width: 44,
        height: 44,
        borderRadius: tokens_1.radius.md,
        alignItems: 'center',
        justifyContent: 'center',
    },
    optionText: {
        flex: 1,
        gap: 2,
    },
    optionLabel: {
        fontSize: 15,
        fontWeight: '600',
        color: tokens_1.color.ink,
    },
    optionSub: {
        fontSize: 12,
        color: tokens_1.color.faint,
    },
    cancel: {
        marginHorizontal: tokens_1.space.lg,
        marginTop: tokens_1.space.sm,
        paddingVertical: tokens_1.space.md,
        borderRadius: tokens_1.radius.md,
        backgroundColor: tokens_1.color.haze,
        alignItems: 'center',
    },
    cancelText: {
        fontSize: 15,
        fontWeight: '600',
        color: tokens_1.color.ink,
    },
});
