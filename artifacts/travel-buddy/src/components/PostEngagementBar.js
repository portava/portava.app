"use strict";
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
exports.PostEngagementBar = PostEngagementBar;
/**
 * PostEngagementBar — Like / Comment / Share actions for a post card.
 *
 * Manages its own like optimistic state. Opens CommentsSheet and ShareSheet
 * as local Modals (invisible when closed, no perf impact in the feed).
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var postEngagement_1 = require("../services/postEngagement");
var CommentsSheet_1 = require("./CommentsSheet");
var ShareSheet_1 = require("./ShareSheet");
function PostEngagementBar(_a) {
    var _this = this;
    var postId = _a.postId, likeCount = _a.likeCount, commentCount = _a.commentCount, likedByMe = _a.likedByMe, _b = _a.canLike, canLike = _b === void 0 ? true : _b, _c = _a.canComment, canComment = _c === void 0 ? true : _c, _d = _a.canShare, canShare = _d === void 0 ? true : _d, onCommentCountChange = _a.onCommentCountChange;
    var _e = (0, react_1.useState)(likedByMe), localLiked = _e[0], setLocalLiked = _e[1];
    var _f = (0, react_1.useState)(likeCount), localLikeCount = _f[0], setLocalLikeCount = _f[1];
    var _g = (0, react_1.useState)(commentCount), localCommentCount = _g[0], setLocalCommentCount = _g[1];
    var _h = (0, react_1.useState)(false), commentsOpen = _h[0], setCommentsOpen = _h[1];
    var _j = (0, react_1.useState)(false), shareOpen = _j[0], setShareOpen = _j[1];
    var _k = (0, react_1.useState)(false), liking = _k[0], setLiking = _k[1];
    var handleLike = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var wasLiked, prevCount, result, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (liking)
                        return [2 /*return*/];
                    setLiking(true);
                    wasLiked = localLiked;
                    prevCount = localLikeCount;
                    setLocalLiked(!wasLiked);
                    setLocalLikeCount(wasLiked ? Math.max(0, prevCount - 1) : prevCount + 1);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, , 6, 7]);
                    if (!wasLiked) return [3 /*break*/, 3];
                    return [4 /*yield*/, (0, postEngagement_1.unlikePost)(postId)];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 5];
                case 3: return [4 /*yield*/, (0, postEngagement_1.likePost)(postId)];
                case 4:
                    _a = _b.sent();
                    _b.label = 5;
                case 5:
                    result = _a;
                    if (result) {
                        // Sync with server truth
                        setLocalLiked(result.likedByMe);
                        setLocalLikeCount(result.likeCount);
                    }
                    else {
                        // Roll back on failure
                        setLocalLiked(wasLiked);
                        setLocalLikeCount(prevCount);
                        react_native_1.Alert.alert('Could not update like', 'Please try again.');
                    }
                    return [3 /*break*/, 7];
                case 6:
                    setLiking(false);
                    return [7 /*endfinally*/];
                case 7: return [2 /*return*/];
            }
        });
    }); }, [liking, localLiked, localLikeCount, postId]);
    var handleCommentCountChange = (0, react_1.useCallback)(function (n) {
        setLocalCommentCount(n);
        onCommentCountChange === null || onCommentCountChange === void 0 ? void 0 : onCommentCountChange(n);
    }, [onCommentCountChange]);
    if (!canLike && !canComment && !canShare)
        return null;
    return (<>
      <react_native_1.View style={s.bar}>
        <react_native_1.Pressable style={s.action} onPress={handleLike} hitSlop={tokens_1.layout.hitSlop} disabled={liking}>
          <lucide_react_native_1.Heart size={17} color={localLiked ? tokens_1.color.signal : tokens_1.color.mute} fill={localLiked ? tokens_1.color.signal : 'transparent'}/>
          <react_native_1.Text style={[s.count, localLiked && s.countLiked]}>
            {localLikeCount > 0 ? localLikeCount : ''}
          </react_native_1.Text>
        </react_native_1.Pressable>

        <react_native_1.Pressable style={s.action} onPress={function () { return setCommentsOpen(true); }} hitSlop={tokens_1.layout.hitSlop}>
          <lucide_react_native_1.MessageCircle size={17} color={tokens_1.color.mute}/>
          <react_native_1.Text style={s.count}>
            {localCommentCount > 0 ? localCommentCount : ''}
          </react_native_1.Text>
        </react_native_1.Pressable>

        <react_native_1.Pressable style={s.action} onPress={function () { return setShareOpen(true); }} hitSlop={tokens_1.layout.hitSlop}>
          <lucide_react_native_1.Share2 size={17} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>
      </react_native_1.View>

      <CommentsSheet_1.CommentsSheet visible={commentsOpen} postId={postId} onClose={function () { return setCommentsOpen(false); }} onCountChange={handleCommentCountChange}/>
      <ShareSheet_1.ShareSheet visible={shareOpen} postId={postId} onClose={function () { return setShareOpen(false); }}/>
    </>);
}
var s = react_native_1.StyleSheet.create({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.lg,
        paddingTop: 2,
    },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minHeight: 44,
        minWidth: 36,
        justifyContent: 'center',
    },
    count: {
        fontSize: 13,
        fontWeight: '600',
        color: tokens_1.color.mute,
        minWidth: 16,
    },
    countLiked: {
        color: tokens_1.color.signal,
    },
});
